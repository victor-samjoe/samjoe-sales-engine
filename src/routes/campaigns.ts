import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import {
  createCampaign, generateCampaignPreflight, getCampaign, getCampaignPreflight,
  listCampaigns, updateCampaign, type CampaignInput,
} from '../services/campaign-service.js';

const CampaignBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 180 }),
  objective: Type.Optional(Type.String({ maxLength: 500 })),
  messageText: Type.String({ minLength: 1, maxLength: 4000 }),
  linkUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 1000 })),
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
    url: Type.String({ format: 'uri', maxLength: 1000 }),
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
    await writeAudit(db, { tenantId: request.user.tenantId, actorUserId: request.user.sub, entityType: 'campaign', entityId: request.params.id, action: 'campaign.preflight_generated', metadata: { snapshot_hash: result.report.snapshot_hash, eligible: result.report.totals.eligible } });
    return result.report;
  });

  app.get<{ Params: { id: string } }>('/api/v1/campaigns/:id/preflight', {
    onRequest: [app.authenticate], schema: { params: CampaignParams },
  }, async (request, reply) => {
    const report = await getCampaignPreflight(db, request.user.tenantId, request.params.id);
    if (!report) return reply.code(404).send({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada', request_id: request.id } });
    return report;
  });
}
