import type { FastifyInstance } from 'fastify';
import type { Database } from '../core/db.js';
import {
  listAudiences,
  getAudience,
  createAudience,
  updateAudience,
  deleteAudience,
  evaluateAudience,
  type AudienceRules,
} from '../services/audience-service.js';

export async function audienceRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/audiences', { onRequest: [app.authenticate] }, async (request) => {
    return { data: await listAudiences(db, request.user.tenantId) };
  });

  app.post('/api/v1/audiences', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = request.body as { name?: unknown; description?: unknown; rules?: unknown };
    if (!body.name || typeof body.name !== 'string') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'name é obrigatório' } });
    }
    const input = {
      name: body.name,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      rules: (body.rules as AudienceRules) ?? {},
    };
    const audience = await createAudience(db, request.user.tenantId, request.user.sub, input);
    return reply.code(201).send(audience);
  });

  app.get('/api/v1/audiences/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const audience = await getAudience(db, request.user.tenantId, id);
    if (!audience) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } });
    return audience;
  });

  app.patch('/api/v1/audiences/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown; description?: unknown; rules?: unknown };
    const input: Parameters<typeof updateAudience>[3] = {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(body.rules !== undefined ? { rules: body.rules as AudienceRules } : {}),
    };
    const updated = await updateAudience(db, request.user.tenantId, id, input);
    if (!updated) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } });
    return updated;
  });

  app.delete('/api/v1/audiences/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteAudience(db, request.user.tenantId, id);
    if (!deleted) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } });
    return reply.code(204).send();
  });

  app.post('/api/v1/audiences/:id/evaluate', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await evaluateAudience(db, request.user.tenantId, id);
    if (result.kind === 'not_found') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } });
    }
    return result;
  });
}
