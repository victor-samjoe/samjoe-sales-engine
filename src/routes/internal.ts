import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import type { AppConfig } from '../core/config.js';

function checkServiceKey(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

const ProvisionBody = Type.Object({
  slug: Type.String({ minLength: 2, maxLength: 80, pattern: '^[a-z0-9-]+$' }),
  name: Type.String({ minLength: 1, maxLength: 160 }),
  owner_email: Type.String({ format: 'email', maxLength: 254 }),
  plan_code: Type.Optional(Type.String({ maxLength: 60 })),
  configuration: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const PatchBody = Type.Object({
  status: Type.Union([Type.Literal('active'), Type.Literal('suspended')]),
  reason: Type.Optional(Type.String({ maxLength: 200 })),
});

type ProvisionBodyType = {
  slug: string;
  name: string;
  owner_email: string;
  plan_code?: string;
  configuration?: Record<string, unknown>;
};

type PatchBodyType = {
  status: 'active' | 'suspended';
  reason?: string;
};

export async function internalRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const { serviceKey } = config;

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/internal/')) return;
    if (!serviceKey) {
      return reply.code(503).send({ error: { code: 'INTERNAL_DISABLED', message: 'Internal API not configured' } });
    }
    if (!checkServiceKey(serviceKey, request.headers['x-service-key'])) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid service key' } });
    }
  });

  // Provision a new tenant with a disabled owner user and an activation invite token
  app.post<{ Body: ProvisionBodyType }>('/api/internal/tenants', {
    schema: { body: ProvisionBody },
  }, async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'];

    if (typeof idempotencyKey === 'string') {
      const cached = await db.query<{ response_json: unknown }>(
        `SELECT response_json FROM idempotency_keys
         WHERE key = $1 AND endpoint = '/api/internal/tenants'
           AND created_at > now() - interval '24 hours'`,
        [idempotencyKey],
      );
      const cachedRow = cached.rows[0];
      if (cachedRow) {
        return reply.code(200).send(cachedRow.response_json);
      }
    }

    const { slug, name, owner_email, plan_code, configuration } = request.body;
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 h

    const pool = db as unknown as pg.Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tenants (id, slug, name, status, settings_json) VALUES ($1, $2, $3, 'active', $4::jsonb)`,
        [tenantId, slug, name, JSON.stringify({ plan_code: plan_code ?? null, configuration: configuration ?? {} })],
      );
      await client.query(
        `INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, '$INVITE_PENDING$', 'disabled')`,
        [userId, owner_email],
      );
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
        [userId, tenantId],
      );
      await client.query(
        `INSERT INTO invite_tokens (id, tenant_id, user_id, token_hash, purpose, expires_at)
         VALUES ($1, $2, $3, $4, 'owner_activation', $5)`,
        [tokenId, tenantId, userId, tokenHash, expiresAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const publicUrl = (process.env.SERVER_PUBLIC_URL ?? 'https://sales.samjoe.com.br').replace(/\/$/, '');
    const activationUrl = `${publicUrl}/ativar?token=${rawToken}`;

    const response = { tenant_id: tenantId, user_id: userId, activation_url: activationUrl, expires_at: expiresAt.toISOString() };

    if (typeof idempotencyKey === 'string') {
      await db.query(
        `INSERT INTO idempotency_keys (key, endpoint, response_json)
         VALUES ($1, '/api/internal/tenants', $2::jsonb) ON CONFLICT DO NOTHING`,
        [idempotencyKey, JSON.stringify(response)],
      );
    }

    return reply.code(201).send(response);
  });

  // Read tenant status and entitlements
  app.get<{ Params: { id: string } }>('/api/internal/tenants/:id', async (request, reply) => {
    const { id } = request.params;
    const res = await db.query<{
      id: string; slug: string; name: string; status: string;
      settings_json: { plan_code?: string; configuration?: Record<string, unknown> };
      created_at: Date; user_count: string;
    }>(
      `SELECT t.id, t.slug, t.name, t.status, t.settings_json, t.created_at,
              (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id) AS user_count
       FROM tenants t WHERE t.id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tenant not found', request_id: request.id } });
    }
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      plan_code: r.settings_json?.plan_code ?? null,
      configuration: r.settings_json?.configuration ?? {},
      user_count: Number(r.user_count),
      created_at: r.created_at,
    };
  });

  // Suspend or reactivate a tenant
  app.patch<{ Params: { id: string }; Body: PatchBodyType }>('/api/internal/tenants/:id', {
    schema: { body: PatchBody },
  }, async (request, reply) => {
    const { id } = request.params;
    const { status } = request.body;
    const res = await db.query<{ id: string; slug: string; status: string }>(
      `UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, slug, status`,
      [status, id],
    );
    const updated = res.rows[0];
    if (!updated) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tenant not found', request_id: request.id } });
    }
    return updated;
  });
}
