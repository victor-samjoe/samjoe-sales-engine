import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import {
  approveCampaign, cancelCampaign, createCampaign,
  generateCampaignPreflight, getCampaign, getCampaignPreflight,
  listCampaigns, updateCampaign, type CampaignInput,
} from '../services/campaign-service.js';

const DispatchMode = Type.Union([Type.Literal('standard'), Type.Literal('single')]);

const CampaignBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 180 }),
  objective: Type.Optional(Type.String({ maxLength: 500 })),
  messageText: Type.String({ minLength: 1, maxLength: 4000 }),
  linkUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 1000 })),
  dispatchMode: Type.Optional(DispatchMode),
  minIntervalHours: Type.Optional(Type.Integer({ minimum: 0, maximum: 8760 })),
  maxNotificationsPer30d: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  includeConverted: Type.Optional(Type.Boolean()),
  conversionWindowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
  audienceRules: Type.Optional(Type.Object({
    stages: Type.Optional(Type.Array(Type.String({ maxLength: 30 }), { maxItems: 20 })),
    origins: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 })),
    tagsAny: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 })),
  })),
  assets: Type.Optional(Type.Array(Type.Object({
    type: Type.Union([Type.Literal('image'), Type.Literal('video')]),
    url: Type.String({ maxLength: 1000 }),
    mimeType: Type.Optional(Type.String({ maxLength: 120 })),
    fileName: Type.Optional(Type.String({ maxLength: 255 })),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  }), { maxItems: 10 })),
});

const CampaignPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 2, maxLength: 180 })),
  objective: Type.Optional(Type.String({ maxLength: 500 })),
  messageText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  linkUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 1000 })),
  dispatchMode: Type.Optional(DispatchMode),
  minIntervalHours: Type.Optional(Type.Integer({ minimum: 0, maximum: 8760 })),
  maxNotificationsPer30d: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  includeConverted: Type.Optional(Type.Boolean()),
  conversionWindowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
  audienceRules: Type.Optional(Type.Object({
    stages: Type.Optional(Type.Array(Type.String({ maxLength: 30 }), { maxItems: 20 })),
    origins: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 })),
    tagsAny: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 })),
  })),
});

const CampaignParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export async function campaignRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/campaigns', { onRequest: [app.authenticate] }, async (request) => {
    const result = await listCampaigns(db, request.user.tenantId);
    return { data: result.rows };
  });

  app.get<{ Params: { id: string } }>('/api/v1/campaigns/:id', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    const campaign = await getCampaign(db, request.user.tenantId, request.params.id);
    if (!campaign) return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    return campaign;
  });

  app.patch<{ Params: { id: string }; Body: Partial<CampaignInput> }>('/api/v1/campaigns/:id', {
    onRequest: [app.authenticate], schema: { params: CampaignParams, body: CampaignPatchBody },
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente', request_id: request.id } });
    const result = await updateCampaign(db, request.user.tenantId, request.params.id, request.body);
    if (!result) return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    if (result.locked) return reply.code(409).send({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha não pode ser editada no status ${result.status}`, request_id: request.id } });
    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: request.params.id, action: 'campaign.updated' });
    return result.campaign;
  });

  app.post<{ Body: CampaignInput }>('/api/v1/campaigns', {
    onRequest: [app.authenticate], schema: { body: CampaignBody },
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente', request_id: request.id } });
    const campaign = await createCampaign(db, request.user.tenantId, request.user.sub, request.body);
    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: String((campaign as { id: string }).id), action: 'campaign.created' });
    return reply.code(201).send(campaign);
  });

  app.post<{ Params: { id: string } }>('/api/v1/campaigns/:id/preflight', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente', request_id: request.id } });
    const result = await generateCampaignPreflight(db, request.user.tenantId, request.params.id);
    if (result.kind === 'not_found') return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    if (result.kind === 'invalid_status') return reply.code(409).send({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha não pode ser analisada no status ${result.status}`, request_id: request.id } });
    if (result.kind === 'already_dispatched') return reply.code(409).send({ error: { code: 'SINGLE_ALREADY_DISPATCHED', message: 'Campanha de disparo único já foi enviada e não pode ser re-disparada', request_id: request.id } });
    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: request.params.id, action: 'campaign.preflight_generated', metadata: { snapshot_hash: result.report.snapshot_hash, eligible: result.report.totals.eligible } });
    return result.report;
  });

  app.post<{ Params: { id: string } }>('/api/v1/campaigns/:id/approve', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    if (!['owner', 'manager'].includes(request.user.role)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Apenas owner ou manager podem aprovar campanhas', request_id: request.id } });
    }
    const result = await approveCampaign(db, request.user.tenantId, request.params.id, request.user.sub);
    if (result.kind === 'not_found') return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    if (result.kind === 'no_snapshot') return reply.code(409).send({ error: { code: 'NO_SNAPSHOT', message: 'Execute o preflight antes de aprovar', request_id: request.id } });
    if (result.kind === 'invalid_status') return reply.code(409).send({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha não pode ser aprovada no status ${result.status}`, request_id: request.id } });
    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: request.params.id, action: 'campaign.approved', metadata: { snapshot_hash: result.snapshot_hash, queued: result.queued } });
    return { queued: result.queued, snapshot_hash: result.snapshot_hash };
  });

  app.post<{ Params: { id: string } }>('/api/v1/campaigns/:id/cancel', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    if (!['owner', 'manager'].includes(request.user.role)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Apenas owner ou manager podem cancelar campanhas', request_id: request.id } });
    }
    const result = await cancelCampaign(db, request.user.tenantId, request.params.id);
    if (result.kind === 'not_found') return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    if (result.kind === 'invalid_status') return reply.code(409).send({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha já está ${result.status}`, request_id: request.id } });
    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: request.params.id, action: 'campaign.cancelled', metadata: { cancelled_recipients: result.cancelled } });
    return { cancelled: result.cancelled };
  });

  app.get<{ Params: { id: string } }>('/api/v1/campaigns/:id/preflight', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    const report = await getCampaignPreflight(db, request.user.tenantId, request.params.id);
    if (!report) return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    return report;
  });

  app.post<{ Params: { id: string } }>('/api/v1/campaigns/:id/clone', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente', request_id: request.id } });
    const src = await db.query<{
      name: string; objective: string | null; message_text: string; link_url: string | null;
      min_interval_hours: number; max_notifications_per_30d: number; include_converted: boolean;
      conversion_window_days: number; audience_rules_json: Record<string, unknown>;
    }>(
      `SELECT name, objective, message_text, link_url, min_interval_hours,
              max_notifications_per_30d, include_converted, conversion_window_days, audience_rules_json
         FROM campaigns WHERE id = $1 AND tenant_id = $2`,
      [request.params.id, request.user.tenantId],
    );
    const orig = src.rows[0];
    if (!orig) return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });

    const { randomUUID } = await import('node:crypto');
    const newId = randomUUID();
    await db.query(
      `INSERT INTO campaigns (id, tenant_id, name, objective, message_text, link_url,
         min_interval_hours, max_notifications_per_30d, include_converted,
         conversion_window_days, audience_rules_json, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'draft',$12)`,
      [newId, request.user.tenantId, `${orig.name} (cópia)`, orig.objective, orig.message_text,
       orig.link_url, orig.min_interval_hours, orig.max_notifications_per_30d, orig.include_converted,
       orig.conversion_window_days, JSON.stringify(orig.audience_rules_json), request.user.sub],
    );

    // clone assets
    await db.query(
      `INSERT INTO campaign_assets (id, tenant_id, campaign_id, asset_type, url, mime_type)
       SELECT gen_random_uuid(), tenant_id, $1, asset_type, url, mime_type
         FROM campaign_assets WHERE campaign_id = $2 AND tenant_id = $3`,
      [newId, request.params.id, request.user.tenantId],
    );

    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: newId, action: 'campaign.cloned', metadata: { source_id: request.params.id } });
    const cloned = await getCampaign(db, request.user.tenantId, newId);
    return reply.code(201).send(cloned);
  });
}
