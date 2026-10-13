import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import { getDispatchJobs, processDispatchEvent } from '../services/dispatch-service.js';

const DispatchEventBody = Type.Object({
  recipientId: Type.String({ format: 'uuid' }),
  eventType: Type.Union([
    Type.Literal('sent'), Type.Literal('delivered'),
    Type.Literal('read'), Type.Literal('failed'),
  ]),
  provider: Type.String({ minLength: 1, maxLength: 60 }),
  externalEventId: Type.String({ minLength: 1, maxLength: 255 }),
  providerMessageId: Type.Optional(Type.String({ maxLength: 255 })),
  occurredAt: Type.String({ format: 'date-time' }),
  errorCode: Type.Optional(Type.String({ maxLength: 100 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const JobsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  campaign_id: Type.Optional(Type.String({ format: 'uuid' })),
});

const RecipientsQuery = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 20 })),
  campaign_id: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export async function dispatchRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Querystring: { limit?: number; campaign_id?: string } }>('/api/v1/dispatch/jobs', {
    onRequest: [app.authenticate], schema: { querystring: JobsQuery },
  }, async (request) => {
    const jobs = await getDispatchJobs(db, request.user.tenantId, {
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      ...(request.query.campaign_id !== undefined ? { campaignId: request.query.campaign_id } : {}),
    });
    return { data: jobs, count: jobs.length };
  });

  app.get<{ Querystring: { status?: string; campaign_id?: string; limit?: number; offset?: number } }>(
    '/api/v1/dispatch/recipients',
    { onRequest: [app.authenticate], schema: { querystring: RecipientsQuery } },
    async (request) => {
      const { status, campaign_id } = request.query;
      const limit = Math.min(Number(request.query.limit ?? 100), 200);
      const offset = Number(request.query.offset ?? 0);

      const params: unknown[] = [request.user.tenantId];
      let where = 'r.tenant_id = $1';
      if (status) where += ` AND r.delivery_status = $${params.push(status)}`;
      if (campaign_id) where += ` AND r.campaign_id = $${params.push(campaign_id)}`;

      const totalResult = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM campaign_recipients r WHERE ${where}`,
        params,
      );

      const result = await db.query<{
        recipient_id: string; campaign_id: string; campaign_name: string;
        contact_id: string; full_name: string; phone_e164: string | null;
        delivery_status: string; queued_at: string | null; sent_at: string | null;
        delivered_at: string | null; read_at: string | null; failed_at: string | null;
      }>(
        `SELECT r.id AS recipient_id, r.campaign_id, camp.name AS campaign_name,
                r.contact_id, c.full_name, c.phone_e164,
                r.delivery_status, r.queued_at, r.sent_at, r.delivered_at, r.read_at, r.failed_at
           FROM campaign_recipients r
           JOIN contacts c ON c.id = r.contact_id AND c.tenant_id = r.tenant_id
           JOIN campaigns camp ON camp.id = r.campaign_id AND camp.tenant_id = r.tenant_id
          WHERE ${where}
          ORDER BY COALESCE(r.sent_at, r.queued_at) DESC NULLS LAST, r.id
          LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
        params,
      );

      return { data: result.rows, count: result.rows.length, total: parseInt(totalResult.rows[0]?.total ?? '0') };
    },
  );

  app.post('/api/v1/dispatch/events', {
    onRequest: [app.authenticate], schema: { body: DispatchEventBody },
  }, async (request, reply) => {
    const body = request.body as {
      recipientId: string; eventType: 'sent' | 'delivered' | 'read' | 'failed';
      provider: string; externalEventId: string; providerMessageId?: string;
      occurredAt: string; errorCode?: string; metadata?: Record<string, unknown>;
    };
    const result = await processDispatchEvent(db, request.user.tenantId, body);
    if (result.kind === 'not_found') {
      return reply.code(404).send({ error: { code: 'RECIPIENT_NOT_FOUND', message: 'Destinatário não encontrado', request_id: request.id } });
    }
    if (result.kind === 'duplicate') {
      return { accepted: false, reason: 'duplicate' };
    }
    if (result.kind === 'ignored') {
      return { accepted: false, reason: result.reason };
    }
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'campaign_recipient',
      entityId: body.recipientId,
      action: `dispatch.${body.eventType}`,
      metadata: { provider: body.provider, external_event_id: body.externalEventId },
    });
    return { accepted: true };
  });
}
