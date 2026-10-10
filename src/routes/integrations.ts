import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { getFoodAppConfig, getFoodAppSecret, upsertFoodAppConfig, processFoodAppEvent } from '../services/foodapp-service.js';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function verifyHmac(secret: string, rawBody: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

const PutFoodAppBody = Type.Object({
  hmacSecret: Type.Optional(Type.String({ minLength: 8, maxLength: 512 })),
  status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
});

const FoodAppEventBody = Type.Object({
  event_id: Type.String({ minLength: 1, maxLength: 255 }),
  event_type: Type.Union([
    Type.Literal('customer.created'), Type.Literal('customer.updated'),
    Type.Literal('order.created'), Type.Literal('order.paid'),
    Type.Literal('order.cancelled'), Type.Literal('order.refunded'),
  ]),
  occurred_at: Type.String({ format: 'date-time' }),
  customer: Type.Object({
    external_id: Type.String({ minLength: 1, maxLength: 255 }),
    phone: Type.Optional(Type.String({ maxLength: 40 })),
    email: Type.Optional(Type.String({ maxLength: 254 })),
    name: Type.Optional(Type.String({ maxLength: 180 })),
  }),
  order: Type.Optional(Type.Object({
    external_id: Type.String({ minLength: 1, maxLength: 255 }),
    total_cents: Type.Integer({ minimum: 0 }),
    cost_cents: Type.Optional(Type.Integer({ minimum: 0 })),
  })),
});

export async function integrationRoutes(app: FastifyInstance, db: Database) {
  // Capture raw body for HMAC verification without replacing Fastify's default JSON parser.
  // preParsing runs before the body is parsed; we buffer the stream, store the raw string,
  // then return a new Readable with the same bytes so normal parsing continues unchanged.
  app.addHook('preParsing', async (request, _reply, payload) => {
    const ct = request.headers['content-type'] ?? '';
    if (!ct.includes('application/json')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
    }
    const rawBuffer = Buffer.concat(chunks);
    (request as FastifyRequest & { rawBody: string }).rawBody = rawBuffer.toString('utf8');
    // Return the original bytes so Fastify's Content-Length check is not affected.
    return Readable.from([rawBuffer]);
  });

  app.get('/api/v1/integrations/foodapp', { onRequest: [app.authenticate] }, async (request, reply) => {
    const config = await getFoodAppConfig(db, request.user.tenantId);
    if (!config) return reply.code(404).send({ data: null });
    return { data: config };
  });

  app.put('/api/v1/integrations/foodapp', {
    onRequest: [app.authenticate],
    schema: { body: PutFoodAppBody },
  }, async (request, reply) => {
    const body = request.body as { hmacSecret?: string; status: 'active' | 'disabled' };
    const existing = await getFoodAppConfig(db, request.user.tenantId);
    if (!body.hmacSecret && !existing) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'hmacSecret obrigatório na primeira configuração', request_id: request.id },
      });
    }
    const config = await upsertFoodAppConfig(db, request.user.tenantId, body);
    return { data: config };
  });

  app.post('/api/v1/integrations/foodapp/events', {
      schema: { body: FoodAppEventBody },
    }, async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string | undefined)?.trim();
      if (!tenantId) {
        return reply.code(400).send({ error: { code: 'MISSING_TENANT', message: 'Header x-tenant-id obrigatório' } });
      }

      const signature = (request.headers['x-foodapp-signature'] as string | undefined)?.trim() ?? '';
      const timestampHeader = (request.headers['x-foodapp-timestamp'] as string | undefined)?.trim() ?? '';

      const tsMs = timestampHeader ? new Date(timestampHeader).getTime() : NaN;
      if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) {
        return reply.code(401).send({ error: { code: 'REPLAY_DETECTED', message: 'Timestamp inválido ou expirado' } });
      }

      const secret = await getFoodAppSecret(db, tenantId);
      if (!secret) {
        return reply.code(401).send({ error: { code: 'INTEGRATION_NOT_CONFIGURED', message: 'Integração não configurada ou inativa' } });
      }

      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      if (!verifyHmac(secret, rawBody, signature)) {
        return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Assinatura HMAC inválida' } });
      }

      const event = request.body as {
        event_id: string; event_type: string; occurred_at: string;
        customer: { external_id: string; phone?: string; email?: string; name?: string };
        order?: { external_id: string; total_cents: number; cost_cents?: number };
      };

      const result = await processFoodAppEvent(db, tenantId, event as Parameters<typeof processFoodAppEvent>[2]);

      if (result.kind === 'ambiguous') {
        return reply.code(200).send({ accepted: true, note: 'ambiguous_contact', event_type: result.event_type });
      }
      if (result.kind === 'duplicate') {
        return reply.code(200).send({ accepted: false, reason: 'duplicate', event_type: result.event_type });
      }
      return reply.code(200).send({ accepted: true, event_type: result.event_type });
    });
}
