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

export async function dispatchRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Querystring: { limit?: number; campaign_id?: string } }>('/api/v1/dispatch/jobs', {
    onRequest: [app.authenticate], schema: { querystring: JobsQuery },
  }, async (request) => {
    const jobs = await getDispatchJobs(db, request.user.tenantId, {
      limit: request.query.limit,
      campaignId: request.query.campaign_id,
    });
    return { data: jobs, count: jobs.length };
  });

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
