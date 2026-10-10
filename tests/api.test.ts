import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestDatabase, seedTestTenant } from './helpers/test-db.js';
import type { AppConfig } from '../src/core/config.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4010,
  logLevel: 'silent',
  databaseUrl: 'memory',
  jwtSecret: 'test-secret-with-at-least-32-characters',
  jwtExpiresIn: '1h',
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup() {
  const db = await createTestDatabase();
  const seeded = await seedTestTenant(db);
  const app = await buildApp({ db, config, logger: false });
  apps.push(app);
  return { app, db, seeded };
}

async function login(app: FastifyInstance, seeded: Awaited<ReturnType<typeof seedTestTenant>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { tenant_slug: seeded.slug, email: seeded.email, password: seeded.password },
  });
  return response.json<{ access_token: string }>().access_token;
}

describe('API foundation', () => {
  it('reports health and database connectivity', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('rejects protected routes without a token', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
    expect(response.statusCode).toBe(401);
  });

  it('logs in and creates tenant-scoped contacts', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    expect(token).toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        fullName: 'Cliente Fictícia',
        phone: '(11) 99999-9999',
        origin: 'manual',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ phone_e164: string }>().phone_e164).toBe('+5511999999999');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('does not expose contacts from another tenant', async () => {
    const { app, db, seeded } = await setup();
    const other = await seedTestTenant(db, {
      slug: 'other-company',
      email: 'owner@other.test',
      password: 'another-correct-password',
    });
    const otherToken = await login(app, other);
    await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { fullName: 'Outro Cliente', phone: '(21) 98888-7777', origin: 'manual' },
    });

    const firstToken = await login(app, seeded);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('records consent and applies marketing opt-out', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Contato Opt-out', phone: '(31) 98888-7777', origin: 'manual' },
    });
    const contactId = created.json<{ id: string }>().id;

    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/contacts/${contactId}/consents`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: 'whatsapp', purpose: 'marketing', action: 'revoked',
        source: 'manual', policyVersion: '1.0', occurredAt: new Date().toISOString(),
      },
    });
    expect(consent.statusCode).toBe(201);
    const projection = await db.query<{ do_not_contact: boolean }>(
      'SELECT do_not_contact FROM contacts WHERE id = $1 AND tenant_id = $2',
      [contactId, seeded.tenantId],
    );
    expect(projection.rows[0]?.do_not_contact).toBe(true);
  });
});

