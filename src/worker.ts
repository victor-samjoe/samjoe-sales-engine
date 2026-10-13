import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import type { MiddlewareHandler } from 'hono';
import pg from 'pg';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

import { authenticateUser } from './services/auth-service.js';
import { writeAudit } from './core/audit.js';
import { createContact, listContacts } from './services/contact-service.js';
import { recordConsents } from './services/consent-service.js';
import { createProduct, listProducts } from './services/product-service.js';
import {
  approveCampaign, cancelCampaign, createCampaign,
  generateCampaignPreflight, getCampaign, getCampaignPreflight,
  listCampaigns, updateCampaign,
} from './services/campaign-service.js';
import { getDispatchJobs, processDispatchEvent } from './services/dispatch-service.js';
import {
  getSamJoeFoodConfig, getSamJoeFoodSecret,
  upsertSamJoeFoodConfig, processSamJoeFoodEvent,
} from './services/samjoe-food-service.js';
import {
  getCampaignAnalytics, getProductAnalytics,
  getPurchaseFrequencyAnalytics, getEngagementAnalytics,
} from './services/analytics-service.js';
import {
  listAudiences, getAudience, createAudience,
  updateAudience, deleteAudience, evaluateAudience,
  type AudienceInput, type AudienceRules,
} from './services/audience-service.js';
import type { Database } from './core/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  HYPERDRIVE: { connectionString: string };
  JWT_SECRET: string;
  JWT_EXPIRES_IN?: string;
  SAMJOE_TECH_SERVICE_KEY?: string;
  SERVER_PUBLIC_URL?: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
}

type JwtUser = {
  sub: string;
  tenantId: string;
  role: string;
  email: string;
  exp?: number;
};

type AppEnv = {
  Bindings: Env;
  Variables: { db: Database; user: JwtUser };
};

// ---------------------------------------------------------------------------
// Pool — lazily created, cached for the lifetime of the Worker instance
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;
function getPool(env: Env): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString });
  return _pool;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseExpiresSeconds(val: string): number {
  const m = val.match(/^(\d+)([smhd])$/);
  if (!m) return 8 * 3600;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(m[1]!) * (mult[m[2]!] ?? 3600);
}

function checkServiceKey(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyHmac(secret: string, rawBody: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<AppEnv>();

// Inject db
app.use('*', async (c, next) => {
  c.set('db', getPool(c.env) as unknown as Database);
  await next();
});

// Global error handler
app.onError((err, c) => {
  const e = err as Error & { code?: string };
  if (e.code === '23505') return c.json({ error: { code: 'CONFLICT', message: 'Registro duplicado' } }, 409);
  console.error('Worker error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno' } }, 500);
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Autenticação necessária' } }, 401);
  }
  try {
    const payload = await verify(auth.slice(7), c.env.JWT_SECRET, 'HS256') as JwtUser;
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token inválido ou expirado' } }, 401);
  }
};

const requireServiceKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sk = c.env.SAMJOE_TECH_SERVICE_KEY;
  if (!sk) return c.json({ error: { code: 'INTERNAL_DISABLED', message: 'Internal API not configured' } }, 503);
  if (!checkServiceKey(sk, c.req.header('x-service-key'))) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid service key' } }, 401);
  }
  await next();
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', async (c) => {
  try {
    await c.get('db').query('SELECT 1');
    return c.json({ status: 'ok', database: 'ok' });
  } catch {
    return c.json({ status: 'degraded', database: 'unavailable' }, 503);
  }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post('/api/v1/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null) as { tenant_slug?: string; email?: string; password?: string } | null;
  if (!body?.tenant_slug || !body.email || !body.password) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'tenant_slug, email e password são obrigatórios' } }, 400);
  }
  const user = await authenticateUser(c.get('db'), body.tenant_slug, body.email, body.password);
  if (!user) return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas' } }, 401);
  const expiresIn = c.env.JWT_EXPIRES_IN ?? '8h';
  const exp = Math.floor(Date.now() / 1000) + parseExpiresSeconds(expiresIn);
  const token = await sign({ sub: user.user_id, tenantId: user.tenant_id, role: user.role, email: user.email, exp }, c.env.JWT_SECRET);
  return c.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn, user: { id: user.user_id, email: user.email, tenant_id: user.tenant_id, role: user.role } });
});

app.get('/api/v1/me', requireAuth, async (c) => {
  const u = c.get('user');
  return c.json({ id: u.sub, email: u.email, tenant_id: u.tenantId, role: u.role });
});

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

app.get('/api/v1/auth/activate', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: { code: 'MISSING_TOKEN', message: 'Token obrigatório' } }, 400);
  const db = c.get('db');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const res = await db.query<{ email: string; tenant_name: string; tenant_slug: string; expires_at: Date; used_at: Date | null }>(
    `SELECT u.email, t.name AS tenant_name, t.slug AS tenant_slug, it.expires_at, it.used_at
     FROM invite_tokens it
     JOIN users u ON u.id = it.user_id
     JOIN tenants t ON t.id = it.tenant_id
     WHERE it.token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (!row) return c.json({ error: { code: 'INVALID_TOKEN', message: 'Token inválido' } }, 404);
  if (row.used_at) return c.json({ error: { code: 'TOKEN_USED', message: 'Token já utilizado' } }, 410);
  if (new Date(row.expires_at) < new Date()) return c.json({ error: { code: 'TOKEN_EXPIRED', message: 'Token expirado' } }, 410);
  return c.json({ email: row.email, tenant_name: row.tenant_name, tenant_slug: row.tenant_slug });
});

app.post('/api/v1/auth/activate', async (c) => {
  const body = await c.req.json().catch(() => null) as { token?: string; password?: string } | null;
  if (!body?.token || !body.password) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'token e password são obrigatórios' } }, 400);
  if (body.token.length !== 64) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Token inválido' } }, 400);
  if (body.password.length < 8) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Senha mínimo 8 caracteres' } }, 400);
  const db = c.get('db');
  const tokenHash = createHash('sha256').update(body.token).digest('hex');
  const res = await db.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    `SELECT id, user_id, expires_at, used_at FROM invite_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (!row) return c.json({ error: { code: 'INVALID_TOKEN', message: 'Token inválido' } }, 404);
  if (row.used_at) return c.json({ error: { code: 'TOKEN_USED', message: 'Token já utilizado' } }, 410);
  if (new Date(row.expires_at) < new Date()) return c.json({ error: { code: 'TOKEN_EXPIRED', message: 'Token expirado' } }, 410);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const pool = db as unknown as pg.Pool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const markUsed = await client.query(`UPDATE invite_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [row.id]);
    if (!markUsed.rowCount) {
      await client.query('ROLLBACK');
      return c.json({ error: { code: 'TOKEN_USED', message: 'Token já utilizado' } }, 410);
    }
    await client.query(`UPDATE users SET password_hash = $1, status = 'ACTIVE', updated_at = now() WHERE id = $2`, [passwordHash, row.user_id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return c.json({ ok: true, message: 'Conta ativada com sucesso' });
});

// ---------------------------------------------------------------------------
// Internal provisioning
// ---------------------------------------------------------------------------

app.post('/api/internal/tenants', requireServiceKey, async (c) => {
  const db = c.get('db');
  const idempotencyKey = c.req.header('idempotency-key');
  if (idempotencyKey) {
    const cached = await db.query<{ response_json: unknown }>(
      `SELECT response_json FROM se_idempotency_keys WHERE key = $1 AND endpoint = '/api/internal/tenants' AND created_at > now() - interval '24 hours'`,
      [idempotencyKey],
    );
    if (cached.rows[0]) return c.json(cached.rows[0].response_json);
  }
  const body = await c.req.json().catch(() => null) as { slug?: string; name?: string; owner_email?: string; owner_name?: string; plan_code?: string; configuration?: Record<string, unknown> } | null;
  if (!body?.slug || !body.name || !body.owner_email) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'slug, name e owner_email são obrigatórios' } }, 400);
  }
  const displayName = body.owner_name?.trim() || body.owner_email.split('@')[0];
  const tenantId = randomUUID();
  const tokenId = randomUUID();
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const pool = db as unknown as pg.Pool;
  const client = await pool.connect();
  let resolvedUserId: string;
  let needsActivation: boolean;
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO tenants (id, slug, name, status, settings_json) VALUES ($1, $2, $3, 'ACTIVE', $4::jsonb)`, [tenantId, body.slug, body.name, JSON.stringify({ plan_code: body.plan_code ?? null, configuration: body.configuration ?? {} })]);
    // Upsert user: create if not exists, reuse existing if already registered (e.g. shared FoodApp DB)
    const newUserId = randomUUID();
    const upsert = await client.query<{ id: string; status: string }>(
      `INSERT INTO users (id, email, display_name, password_hash, status)
       VALUES ($1, $2, $3, '$INVITE_PENDING$', 'DISABLED')
       ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
       RETURNING id, status`,
      [newUserId, body.owner_email, displayName],
    );
    resolvedUserId = upsert.rows[0]!.id;
    const existingStatus = upsert.rows[0]!.status;
    needsActivation = existingStatus === 'DISABLED' || existingStatus === 'disabled';
    await client.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [resolvedUserId, tenantId]);
    if (needsActivation) {
      await client.query(`INSERT INTO invite_tokens (id, tenant_id, user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, $4, 'owner_activation', $5)`, [tokenId, tenantId, resolvedUserId, tokenHash, expiresAt]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const publicUrl = (c.env.SERVER_PUBLIC_URL ?? 'https://sales.samjoe.com.br').replace(/\/$/, '');
  const activationUrl = needsActivation ? `${publicUrl}/ativar?token=${rawToken}` : null;
  const response = { tenant_id: tenantId, user_id: resolvedUserId, activation_url: activationUrl, expires_at: needsActivation ? expiresAt.toISOString() : null };
  if (idempotencyKey) {
    await db.query(`INSERT INTO se_idempotency_keys (key, endpoint, response_json) VALUES ($1, '/api/internal/tenants', $2::jsonb) ON CONFLICT DO NOTHING`, [idempotencyKey, JSON.stringify(response)]);
  }
  return c.json(response, 201);
});

app.get('/api/internal/tenants/:id', requireServiceKey, async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const res = await db.query<{ id: string; slug: string; name: string; status: string; settings_json: { plan_code?: string; configuration?: Record<string, unknown> }; created_at: Date; user_count: string }>(
    `SELECT t.id, t.slug, t.name, t.status, t.settings_json, t.created_at,
            (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id) AS user_count
     FROM tenants t WHERE t.id = $1`,
    [id],
  );
  const r = res.rows[0];
  if (!r) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);
  return c.json({ id: r.id, slug: r.slug, name: r.name, status: r.status, plan_code: r.settings_json?.plan_code ?? null, configuration: r.settings_json?.configuration ?? {}, user_count: Number(r.user_count), created_at: r.created_at });
});

app.patch('/api/internal/tenants/:id', requireServiceKey, async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { status?: string } | null;
  if (!body?.status || !['active', 'suspended', 'ACTIVE', 'SUSPENDED'].includes(body.status)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'status deve ser "active" ou "suspended"' } }, 400);
  }
  const normalizedStatus = body.status.toUpperCase() as 'ACTIVE' | 'SUSPENDED';
  const res = await db.query<{ id: string; slug: string; status: string }>(
    `UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, slug, status`,
    [normalizedStatus, id],
  );
  const updated = res.rows[0];
  if (!updated) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404);
  return c.json(updated);
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

app.get('/api/v1/contacts', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const result = await listContacts(db, u.tenantId, limit, offset);
  return c.json({ data: result.rows, pagination: { limit, offset } });
});

app.post('/api/v1/contacts', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const body = await c.req.json();
  const contact = await createContact(db, u.tenantId, body);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'contact', entityId: String((contact as { id: string }).id), action: 'contact.created' });
  return c.json(contact, 201);
});

app.post('/api/v1/contacts/:id/consents', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const consents = await recordConsents(db, u.tenantId, id, u.sub, body);
  if (!consents) return c.json({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contato não encontrado' } }, 404);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'consent_event', entityId: id, action: `consent.${body.action}`, metadata: { contact_id: id, purposes: body.purposes, channel: body.channel } });
  return c.json({ data: consents }, 201);
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

app.get('/api/v1/products', requireAuth, async (c) => {
  const result = await listProducts(c.get('db'), c.get('user').tenantId);
  return c.json({ data: result.rows });
});

app.post('/api/v1/products', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (u.role === 'viewer') return c.json({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } }, 403);
  const body = await c.req.json();
  const product = await createProduct(db, u.tenantId, body);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'product', entityId: String((product as { id: string }).id), action: 'product.created' });
  return c.json(product, 201);
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

app.get('/api/v1/campaigns', requireAuth, async (c) => {
  const result = await listCampaigns(c.get('db'), c.get('user').tenantId);
  return c.json({ data: result.rows });
});

app.get('/api/v1/campaigns/:id', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const campaign = await getCampaign(db, u.tenantId, c.req.param('id'));
  if (!campaign) return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  return c.json(campaign);
});

app.post('/api/v1/campaigns', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (u.role === 'viewer') return c.json({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } }, 403);
  const body = await c.req.json();
  const campaign = await createCampaign(db, u.tenantId, u.sub, body);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign', entityId: String((campaign as { id: string }).id), action: 'campaign.created' });
  return c.json(campaign, 201);
});

app.patch('/api/v1/campaigns/:id', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (u.role === 'viewer') return c.json({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } }, 403);
  const body = await c.req.json();
  const result = await updateCampaign(db, u.tenantId, c.req.param('id'), body);
  if (!result) return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  if (result.locked) return c.json({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha não pode ser editada no status ${result.status}` } }, 409);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign', entityId: c.req.param('id'), action: 'campaign.updated' });
  return c.json(result.campaign);
});

app.post('/api/v1/campaigns/:id/preflight', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (u.role === 'viewer') return c.json({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } }, 403);
  const result = await generateCampaignPreflight(db, u.tenantId, c.req.param('id'));
  if (result.kind === 'not_found') return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  if (result.kind === 'invalid_status') return c.json({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha não pode ser analisada no status ${result.status}` } }, 409);
  if (result.kind === 'already_dispatched') return c.json({ error: { code: 'SINGLE_ALREADY_DISPATCHED', message: 'Campanha de disparo único já foi enviada' } }, 409);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign', entityId: c.req.param('id'), action: 'campaign.preflight_generated', metadata: { snapshot_hash: result.report.snapshot_hash, eligible: result.report.totals.eligible } });
  return c.json(result.report);
});

app.get('/api/v1/campaigns/:id/preflight', requireAuth, async (c) => {
  const report = await getCampaignPreflight(c.get('db'), c.get('user').tenantId, c.req.param('id'));
  if (!report) return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  return c.json(report);
});

app.post('/api/v1/campaigns/:id/approve', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (!['owner', 'manager'].includes(u.role)) return c.json({ error: { code: 'FORBIDDEN', message: 'Apenas owner ou manager podem aprovar campanhas' } }, 403);
  const result = await approveCampaign(db, u.tenantId, c.req.param('id'), u.sub);
  if (result.kind === 'not_found') return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  if (result.kind === 'no_snapshot') return c.json({ error: { code: 'NO_SNAPSHOT', message: 'Execute o preflight antes de aprovar' } }, 409);
  if (result.kind === 'invalid_status') return c.json({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha não pode ser aprovada no status ${result.status}` } }, 409);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign', entityId: c.req.param('id'), action: 'campaign.approved', metadata: { snapshot_hash: result.snapshot_hash, queued: result.queued } });
  return c.json({ queued: result.queued, snapshot_hash: result.snapshot_hash });
});

app.post('/api/v1/campaigns/:id/cancel', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (!['owner', 'manager'].includes(u.role)) return c.json({ error: { code: 'FORBIDDEN', message: 'Apenas owner ou manager podem cancelar campanhas' } }, 403);
  const result = await cancelCampaign(db, u.tenantId, c.req.param('id'));
  if (result.kind === 'not_found') return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  if (result.kind === 'invalid_status') return c.json({ error: { code: 'CAMPAIGN_LOCKED', message: `Campanha já está ${result.status}` } }, 409);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign', entityId: c.req.param('id'), action: 'campaign.cancelled', metadata: { cancelled_recipients: result.cancelled } });
  return c.json({ cancelled: result.cancelled });
});

app.post('/api/v1/campaigns/:id/clone', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (u.role === 'viewer') return c.json({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } }, 403);
  const id = c.req.param('id');
  const src = await db.query<{
    name: string; objective: string | null; message_text: string; link_url: string | null;
    min_interval_hours: number; max_notifications_per_30d: number; include_converted: boolean;
    conversion_window_days: number; audience_rules_json: Record<string, unknown>;
  }>(
    `SELECT name, objective, message_text, link_url, min_interval_hours,
            max_notifications_per_30d, include_converted, conversion_window_days, audience_rules_json
       FROM campaigns WHERE id = $1 AND tenant_id = $2`,
    [id, u.tenantId],
  );
  const orig = src.rows[0];
  if (!orig) return c.json({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' } }, 404);
  const newId = randomUUID();
  await db.query(
    `INSERT INTO campaigns (id, tenant_id, name, objective, message_text, link_url,
       min_interval_hours, max_notifications_per_30d, include_converted,
       conversion_window_days, audience_rules_json, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'draft',$12)`,
    [newId, u.tenantId, `${orig.name} (cópia)`, orig.objective, orig.message_text, orig.link_url,
     orig.min_interval_hours, orig.max_notifications_per_30d, orig.include_converted,
     orig.conversion_window_days, JSON.stringify(orig.audience_rules_json), u.sub],
  );
  await db.query(
    `INSERT INTO campaign_assets (id, tenant_id, campaign_id, asset_type, url, mime_type)
     SELECT gen_random_uuid(), tenant_id, $1, asset_type, url, mime_type
       FROM campaign_assets WHERE campaign_id = $2 AND tenant_id = $3`,
    [newId, id, u.tenantId],
  );
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign', entityId: newId, action: 'campaign.cloned', metadata: { source_id: id } });
  const cloned = await getCampaign(db, u.tenantId, newId);
  return c.json(cloned, 201);
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

app.get('/api/v1/analytics/campaigns', requireAuth, async (c) => {
  return c.json(await getCampaignAnalytics(c.get('db'), c.get('user').tenantId));
});

app.get('/api/v1/analytics/products', requireAuth, async (c) => {
  const periodDays = Math.min(Math.max(Number(c.req.query('days') ?? 90), 7), 365);
  return c.json(await getProductAnalytics(c.get('db'), c.get('user').tenantId, periodDays));
});

app.get('/api/v1/analytics/frequency', requireAuth, async (c) => {
  return c.json(await getPurchaseFrequencyAnalytics(c.get('db'), c.get('user').tenantId));
});

app.get('/api/v1/analytics/engagement', requireAuth, async (c) => {
  return c.json(await getEngagementAnalytics(c.get('db'), c.get('user').tenantId));
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get('/api/v1/settings', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const result = await db.query<{ name: string; slug: string; timezone: string; settings_json: Record<string, unknown> | string }>(
    `SELECT name, slug, timezone, settings_json FROM tenants WHERE id = $1`,
    [u.tenantId],
  );
  const row = result.rows[0];
  if (!row) return c.json({ data: null });
  const settings = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : row.settings_json;
  return c.json({ data: { tenantName: row.name, slug: row.slug, timezone: row.timezone, appUrl: typeof settings.app_url === 'string' ? settings.app_url : null } });
});

app.patch('/api/v1/settings', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  if (u.role !== 'owner' && u.role !== 'manager') return c.json({ error: { code: 'FORBIDDEN', message: 'Sem permissão' } }, 403);
  const body = await c.req.json() as { appUrl?: string; tenantName?: string; timezone?: string };
  const current = await db.query<{ settings_json: Record<string, unknown> | string; name: string; timezone: string }>(
    `SELECT settings_json, name, timezone FROM tenants WHERE id = $1`,
    [u.tenantId],
  );
  const row = current.rows[0];
  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant não encontrado' } }, 404);
  const settings = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : { ...row.settings_json };
  if (body.appUrl !== undefined) settings.app_url = body.appUrl || null;
  const newName = body.tenantName ?? row.name;
  const newTimezone = body.timezone ?? row.timezone;
  await db.query(`UPDATE tenants SET name = $1, timezone = $2, settings_json = $3::jsonb, updated_at = now() WHERE id = $4`, [newName, newTimezone, JSON.stringify(settings), u.tenantId]);
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'tenant', entityId: u.tenantId, action: 'settings.updated', metadata: { fields: Object.keys(body) } });
  return c.json({ data: { tenantName: newName, timezone: newTimezone, appUrl: settings.app_url ?? null } });
});

// ---------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------

app.get('/api/v1/audiences', requireAuth, async (c) => {
  return c.json({ data: await listAudiences(c.get('db'), c.get('user').tenantId) });
});

app.post('/api/v1/audiences', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const body = await c.req.json() as { name?: unknown; description?: unknown; rules?: unknown };
  if (!body.name || typeof body.name !== 'string') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name é obrigatório' } }, 400);
  const input = { name: body.name, ...(typeof body.description === 'string' ? { description: body.description } : {}), rules: (body.rules as Parameters<typeof createAudience>[3]['rules']) ?? {} };
  const audience = await createAudience(db, u.tenantId, u.sub, input);
  return c.json(audience, 201);
});

app.get('/api/v1/audiences/:id', requireAuth, async (c) => {
  const audience = await getAudience(c.get('db'), c.get('user').tenantId, c.req.param('id'));
  if (!audience) return c.json({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } }, 404);
  return c.json(audience);
});

app.patch('/api/v1/audiences/:id', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const body = await c.req.json() as { name?: unknown; description?: unknown; rules?: unknown };
  const input: Partial<AudienceInput> = {};
  if (typeof body.name === 'string') input.name = body.name;
  if (typeof body.description === 'string') input.description = body.description;
  if (body.rules !== undefined) input.rules = body.rules as AudienceRules;
  const updated = await updateAudience(db, u.tenantId, c.req.param('id'), input);
  if (!updated) return c.json({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } }, 404);
  return c.json(updated);
});

app.delete('/api/v1/audiences/:id', requireAuth, async (c) => {
  const deleted = await deleteAudience(c.get('db'), c.get('user').tenantId, c.req.param('id'));
  if (!deleted) return c.json({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } }, 404);
  return new Response(null, { status: 204 });
});

app.post('/api/v1/audiences/:id/evaluate', requireAuth, async (c) => {
  const result = await evaluateAudience(c.get('db'), c.get('user').tenantId, c.req.param('id'));
  if (result.kind === 'not_found') return c.json({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } }, 404);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

const WA_DEFAULT_URL = 'http://localhost:8081';
const WA_DEFAULT_INSTANCE = 'samjoe';

async function getTenantWaConfig(db: Database, tenantId: string) {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(`SELECT settings_json FROM tenants WHERE id = $1`, [tenantId]);
  const row = result.rows[0];
  const settings = row ? (typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : row.settings_json) : {};
  return {
    evolutionUrl: (settings.wa_evolution_url as string | undefined) ?? WA_DEFAULT_URL,
    instanceName: (settings.wa_instance_name as string | undefined) ?? WA_DEFAULT_INSTANCE,
    apiKey: (settings.wa_api_key as string | undefined) ?? '',
    automationEnabled: (settings.wa_automation_enabled as boolean | undefined) ?? false,
  };
}

async function saveTenantWaConfig(db: Database, tenantId: string, patch: { evolutionUrl?: string; instanceName?: string; apiKey?: string; automationEnabled?: boolean }) {
  const current = await db.query<{ settings_json: Record<string, unknown> | string }>(`SELECT settings_json FROM tenants WHERE id = $1`, [tenantId]);
  const row = current.rows[0];
  if (!row) throw new Error('Tenant not found');
  const settings = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : { ...row.settings_json };
  if (patch.evolutionUrl !== undefined) settings.wa_evolution_url = patch.evolutionUrl;
  if (patch.instanceName !== undefined) settings.wa_instance_name = patch.instanceName;
  if (patch.apiKey !== undefined) settings.wa_api_key = patch.apiKey;
  if (patch.automationEnabled !== undefined) settings.wa_automation_enabled = patch.automationEnabled;
  await db.query(`UPDATE tenants SET settings_json = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(settings), tenantId]);
}

function evoHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h.apikey = apiKey;
  return h;
}

app.get('/api/v1/integrations/whatsapp/config', requireAuth, async (c) => {
  const cfg = await getTenantWaConfig(c.get('db'), c.get('user').tenantId);
  return c.json({ data: { evolutionUrl: cfg.evolutionUrl, instanceName: cfg.instanceName, hasApiKey: !!cfg.apiKey, automationEnabled: cfg.automationEnabled } });
});

app.put('/api/v1/integrations/whatsapp/config', requireAuth, async (c) => {
  const body = await c.req.json() as { evolutionUrl?: string; instanceName?: string; apiKey?: string; automationEnabled?: boolean };
  await saveTenantWaConfig(c.get('db'), c.get('user').tenantId, body);
  return c.json({ data: { ok: true } });
});

app.get('/api/v1/integrations/whatsapp/qr', requireAuth, async (c) => {
  const db = c.get('db');
  const cfg = await getTenantWaConfig(db, c.get('user').tenantId);
  const headers = evoHeaders(cfg.apiKey);
  try {
    const createRes = await fetch(`${cfg.evolutionUrl}/instance/create`, {
      method: 'POST', headers,
      body: JSON.stringify({ instanceName: cfg.instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!createRes.ok && createRes.status !== 409) {
      const errBody = await createRes.json().catch(() => ({})) as { message?: string };
      return c.json({ error: { code: 'EVOLUTION_ERROR', message: errBody.message ?? 'Erro ao criar instância WhatsApp' } }, 502);
    }
    const qrRes = await fetch(`${cfg.evolutionUrl}/instance/connect/${cfg.instanceName}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!qrRes.ok) return c.json({ error: { code: 'EVOLUTION_ERROR', message: 'QR code não disponível. Verifique se a instância está pronta.' } }, 502);
    const qrData = await qrRes.json() as { base64?: string; code?: string };
    return c.json({ data: { base64: qrData.base64 ?? null, code: qrData.code ?? null } });
  } catch (err) {
    const e = err as Error;
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    return c.json({ error: { code: isTimeout ? 'EVOLUTION_TIMEOUT' : 'EVOLUTION_UNAVAILABLE', message: isTimeout ? 'Evolution API demorou para responder.' : 'Evolution API indisponível.' } }, 502);
  }
});

app.get('/api/v1/integrations/whatsapp/status', requireAuth, async (c) => {
  const cfg = await getTenantWaConfig(c.get('db'), c.get('user').tenantId);
  try {
    const res = await fetch(`${cfg.evolutionUrl}/instance/connectionState/${cfg.instanceName}`, { headers: evoHeaders(cfg.apiKey), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return c.json({ data: { state: 'offline', instanceName: cfg.instanceName } });
    const data = await res.json() as { instance?: { state?: string } };
    return c.json({ data: { state: data.instance?.state ?? 'unknown', instanceName: cfg.instanceName } });
  } catch {
    return c.json({ data: { state: 'offline', instanceName: cfg.instanceName } });
  }
});

app.delete('/api/v1/integrations/whatsapp/disconnect', requireAuth, async (c) => {
  const cfg = await getTenantWaConfig(c.get('db'), c.get('user').tenantId);
  try {
    await fetch(`${cfg.evolutionUrl}/instance/logout/${cfg.instanceName}`, { method: 'DELETE', headers: evoHeaders(cfg.apiKey), signal: AbortSignal.timeout(8000) });
    return c.json({ data: { ok: true } });
  } catch {
    return c.json({ error: { code: 'EVOLUTION_UNAVAILABLE', message: 'Evolution API indisponível' } }, 502);
  }
});

// ---------------------------------------------------------------------------
// Integrations (SamJoE Food)
// ---------------------------------------------------------------------------

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

app.get('/api/v1/integrations/samjoe-food', requireAuth, async (c) => {
  const config = await getSamJoeFoodConfig(c.get('db'), c.get('user').tenantId);
  if (!config) return c.json({ data: null }, 404);
  return c.json({ data: config });
});

app.put('/api/v1/integrations/samjoe-food', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const body = await c.req.json() as { hmacSecret?: string; status: 'active' | 'disabled' };
  const existing = await getSamJoeFoodConfig(db, u.tenantId);
  if (!body.hmacSecret && !existing) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hmacSecret obrigatório na primeira configuração' } }, 400);
  const config = await upsertSamJoeFoodConfig(db, u.tenantId, body);
  return c.json({ data: config });
});

app.post('/api/v1/integrations/samjoe-food/events', async (c) => {
  const tenantId = c.req.header('x-tenant-id')?.trim();
  if (!tenantId) return c.json({ error: { code: 'MISSING_TENANT', message: 'Header x-tenant-id obrigatório' } }, 400);
  const signature = c.req.header('x-samjoe-food-signature')?.trim() ?? '';
  const timestampHeader = c.req.header('x-samjoe-food-timestamp')?.trim() ?? '';
  const tsMs = timestampHeader ? new Date(timestampHeader).getTime() : NaN;
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) return c.json({ error: { code: 'REPLAY_DETECTED', message: 'Timestamp inválido ou expirado' } }, 401);
  const db = c.get('db');
  const secret = await getSamJoeFoodSecret(db, tenantId);
  if (!secret) return c.json({ error: { code: 'INTEGRATION_NOT_CONFIGURED', message: 'Integração não configurada ou inativa' } }, 401);
  const rawBody = await c.req.text();
  if (!verifyHmac(secret, rawBody, signature)) return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Assinatura HMAC inválida' } }, 401);
  const event = JSON.parse(rawBody) as Parameters<typeof processSamJoeFoodEvent>[2];
  const result = await processSamJoeFoodEvent(db, tenantId, event);
  if (result.kind === 'ambiguous') return c.json({ accepted: true, note: 'ambiguous_contact', event_type: result.event_type });
  if (result.kind === 'duplicate') return c.json({ accepted: false, reason: 'duplicate', event_type: result.event_type });
  return c.json({ accepted: true, event_type: result.event_type });
});

app.post('/api/v1/integrations/samjoe-food/detect', requireAuth, async (c) => {
  const body = await c.req.json() as { foodAppUrl: string };
  const base = body.foodAppUrl?.replace(/\/$/, '');
  if (!base) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'foodAppUrl é obrigatório' } }, 400);
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) return c.json({ data: { reachable: true, url: base } });
    const res2 = await fetch(`${base}/`, { signal: AbortSignal.timeout(4000) });
    return c.json({ data: { reachable: res2.status < 500, url: base } });
  } catch {
    return c.json({ data: { reachable: false, url: base } });
  }
});

app.post('/api/v1/integrations/samjoe-food/auto-connect', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const body = await c.req.json() as { foodAppUrl: string; foodAppAdminKey?: string };
  const base = body.foodAppUrl?.replace(/\/$/, '');
  if (!base) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'foodAppUrl é obrigatório' } }, 400);
  const hmacSecret = randomBytes(32).toString('hex');
  const settingsRow = await db.query<{ settings_json: Record<string, unknown> | string }>(`SELECT settings_json FROM tenants WHERE id = $1`, [u.tenantId]);
  const settings = settingsRow.rows[0] ? (typeof settingsRow.rows[0].settings_json === 'string' ? JSON.parse(settingsRow.rows[0].settings_json) as Record<string, unknown> : settingsRow.rows[0].settings_json) : {};
  const engineUrl = ((settings.app_url as string | undefined) ?? '').replace(/\/$/, '') || 'http://localhost:4010';
  const webhookUrl = `${engineUrl}/api/v1/integrations/samjoe-food/events`;
  await upsertSamJoeFoodConfig(db, u.tenantId, { hmacSecret, status: 'active' });
  settings.food_app_url = base;
  await db.query(`UPDATE tenants SET settings_json = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(settings), u.tenantId]);
  let autoConfigured = false;
  let autoConfigError: string | null = null;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (body.foodAppAdminKey) headers['x-admin-key'] = body.foodAppAdminKey;
    const res = await fetch(`${base}/api/admin/webhook-config`, { method: 'PUT', headers, body: JSON.stringify({ webhookUrl, hmacSecret }), signal: AbortSignal.timeout(6000) });
    autoConfigured = res.ok;
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as { message?: string };
      autoConfigError = errBody.message ?? `HTTP ${res.status}`;
    }
  } catch (err) {
    autoConfigError = (err as Error).message ?? 'Não foi possível contactar a loja';
  }
  return c.json({ data: { configured: true, autoConfigured, autoConfigError, webhookUrl, hmacSecret: autoConfigured ? '[salvo automaticamente]' : hmacSecret, foodAppUrl: base } });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

app.get('/api/v1/dispatch/jobs', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const campaignId = c.req.query('campaign_id') ?? undefined;
  const jobs = await getDispatchJobs(db, u.tenantId, { ...(limit !== undefined ? { limit } : {}), ...(campaignId !== undefined ? { campaignId } : {}) });
  return c.json({ data: jobs, count: jobs.length });
});

app.get('/api/v1/dispatch/recipients', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const status = c.req.query('status');
  const campaignId = c.req.query('campaign_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 200);
  const offset = Number(c.req.query('offset') ?? 0);
  const params: unknown[] = [u.tenantId];
  let where = 'r.tenant_id = $1';
  if (status) where += ` AND r.delivery_status = $${params.push(status)}`;
  if (campaignId) where += ` AND r.campaign_id = $${params.push(campaignId)}`;
  const totalResult = await db.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM campaign_recipients r WHERE ${where}`, params);
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
  return c.json({ data: result.rows, count: result.rows.length, total: parseInt(totalResult.rows[0]?.total ?? '0') });
});

app.post('/api/v1/dispatch/events', requireAuth, async (c) => {
  const db = c.get('db');
  const u = c.get('user');
  const body = await c.req.json() as {
    recipientId: string; eventType: 'sent' | 'delivered' | 'read' | 'failed';
    provider: string; externalEventId: string; providerMessageId?: string;
    occurredAt: string; errorCode?: string; metadata?: Record<string, unknown>;
  };
  const result = await processDispatchEvent(db, u.tenantId, body);
  if (result.kind === 'not_found') return c.json({ error: { code: 'RECIPIENT_NOT_FOUND', message: 'Destinatário não encontrado' } }, 404);
  if (result.kind === 'duplicate') return c.json({ accepted: false, reason: 'duplicate' });
  if (result.kind === 'ignored') return c.json({ accepted: false, reason: (result as { kind: string; reason?: string }).reason });
  await writeAudit(db, { tenantId: u.tenantId, actorUserId: u.sub, entityType: 'campaign_recipient', entityId: body.recipientId, action: `dispatch.${body.eventType}`, metadata: { provider: body.provider, external_event_id: body.externalEventId } });
  return c.json({ accepted: true });
});

// ---------------------------------------------------------------------------
// Webhooks (Evolution API)
// ---------------------------------------------------------------------------

const EVOLUTION_STATUS_MAP: Record<string, 'delivered' | 'read' | 'failed'> = {
  DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read', ERROR: 'failed',
};

app.post('/api/v1/webhooks/evolution', async (c) => {
  const db = c.get('db');
  const body = await c.req.json().catch(() => null) as { event?: string; instance?: string; data?: unknown } | null;
  if (!body || body.event !== 'messages.update') return c.json({ accepted: false, reason: 'not_messages_update' });
  const updates = Array.isArray(body.data) ? body.data : [body.data];
  const results = [];
  for (const update of updates) {
    const u = update as { key?: { remoteJid?: string; id?: string; fromMe?: boolean }; update?: { status?: string } };
    const providerMessageId = u?.key?.id;
    const rawStatus = u?.update?.status;
    if (!providerMessageId || !rawStatus) continue;
    const eventType = EVOLUTION_STATUS_MAP[rawStatus];
    if (!eventType) continue;
    const recipientResult = await db.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM campaign_recipients WHERE provider_message_id = $1 LIMIT 1`,
      [providerMessageId],
    );
    const recipient = recipientResult.rows[0];
    if (!recipient) { results.push({ provider_message_id: providerMessageId, status: 'not_found' }); continue; }
    const result = await processDispatchEvent(db, recipient.tenant_id, {
      recipientId: recipient.id, eventType, provider: 'evolution_whatsapp',
      externalEventId: `evolution_${rawStatus}_${providerMessageId}`,
      providerMessageId, occurredAt: new Date().toISOString(),
    });
    results.push({ provider_message_id: providerMessageId, status: result.kind });
  }
  return c.json({ accepted: true, results });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

app.all('*', async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada' } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
