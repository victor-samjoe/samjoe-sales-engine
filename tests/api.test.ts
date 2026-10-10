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
  it('serves the CRM interface', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('SamJoE CRM');
  });

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

  it('creates a campaign and generates an eligibility preflight without sending', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const authorization = { authorization: `Bearer ${token}` };

    const eligibleContact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: authorization,
      payload: { fullName: 'Cliente Elegível', phone: '(11) 98888-1111', origin: 'whatsapp' },
    });
    const eligibleId = eligibleContact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${eligibleId}/consents`, headers: authorization,
      payload: {
        channel: 'whatsapp', purpose: 'marketing', action: 'granted', source: 'whatsapp',
        policyVersion: '1.0', occurredAt: new Date().toISOString(),
      },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: authorization,
      payload: { fullName: 'Cliente Sem Consentimento', phone: '(11) 98888-2222', origin: 'manual' },
    });

    const created = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: authorization,
      payload: {
        name: 'Teste controlado', messageText: 'Mensagem de teste',
        minIntervalHours: 168, maxNotificationsPer30d: 3,
        audienceRules: { origins: ['whatsapp', 'manual'] },
        assets: [{ type: 'image', url: 'https://cdn.example.test/campaign.jpg' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json<{ id: string }>().id;

    const preflight = await app.inject({
      method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: authorization,
    });
    expect(preflight.statusCode).toBe(200);
    const report = preflight.json<{
      totals: { evaluated: number; eligible: number; excluded: number };
      excluded_by_reason: Record<string, number>;
      exposure_bands: { never_received: { contacts: number } };
      recipients: Array<{ contact_id: string; eligible: boolean }>;
    }>();
    expect(report.totals).toEqual({ evaluated: 2, eligible: 1, excluded: 1 });
    expect(report.excluded_by_reason.marketing_consent_missing).toBe(1);
    expect(report.exposure_bands.never_received.contacts).toBe(1);
    expect(report.recipients.find((item) => item.contact_id === eligibleId)?.eligible).toBe(true);

    const savedReport = await app.inject({
      method: 'GET', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: authorization,
    });
    expect(savedReport.statusCode).toBe(200);
    expect(savedReport.json<{ ready: boolean }>().ready).toBe(true);
  });

  it('patches a draft campaign and resets its snapshot', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers,
      payload: { name: 'Campanha original', messageText: 'Texto original' },
    });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json<{ id: string }>().id;

    const preflight = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers });
    expect(preflight.statusCode).toBe(200);

    const status = await app.inject({ method: 'GET', url: `/api/v1/campaigns/${campaignId}`, headers });
    expect(status.json<{ status: string; snapshot_hash: string }>().status).toBe('preflight_ready');
    expect(status.json<{ snapshot_hash: string }>().snapshot_hash).toBeTruthy();

    const patched = await app.inject({
      method: 'PATCH', url: `/api/v1/campaigns/${campaignId}`, headers,
      payload: { name: 'Campanha editada', messageText: 'Texto atualizado' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ status: string; name: string; snapshot_hash: null }>().status).toBe('draft');
    expect(patched.json<{ name: string }>().name).toBe('Campanha editada');
    expect(patched.json<{ snapshot_hash: null }>().snapshot_hash).toBeNull();
  });

  it('keeps campaigns isolated by tenant', async () => {
    const { app, db, seeded } = await setup();
    const firstToken = await login(app, seeded);
    await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: { authorization: `Bearer ${firstToken}` },
      payload: { name: 'Campanha privada', messageText: 'Somente tenant principal' },
    });
    const other = await seedTestTenant(db, { slug: 'other-campaign-tenant', email: 'campaign@other.test' });
    const otherToken = await login(app, other);
    const response = await app.inject({
      method: 'GET', url: '/api/v1/campaigns', headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('approves campaign and queues eligible recipients', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: h,
      payload: { fullName: 'Aprovado Fictício', phone: '(11) 97777-1111', origin: 'whatsapp' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers: h,
      payload: { channel: 'whatsapp', purpose: 'marketing', action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Campanha aprovação', messageText: 'Olá!' },
    });
    const campaignId = camp.json<{ id: string }>().id;

    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });

    const approve = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ queued: number }>().queued).toBe(1);

    const jobs = await app.inject({ method: 'GET', url: '/api/v1/dispatch/jobs', headers: h });
    expect(jobs.statusCode).toBe(200);
    const jobList = jobs.json<{ data: Array<{ recipient_id: string; phone_e164: string }> }>();
    expect(jobList.data).toHaveLength(1);
    expect(jobList.data[0].phone_e164).toBe('+5511977771111');

    const reApprove = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });
    expect(reApprove.statusCode).toBe(409);
  });

  it('processes dispatch events idempotently and updates contact outbound', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: h,
      payload: { fullName: 'Dispatch Test', phone: '(11) 96666-2222', origin: 'whatsapp' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers: h,
      payload: { channel: 'whatsapp', purpose: 'marketing', action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Dispatch Campanha', messageText: 'Teste dispatch', minIntervalHours: 24 },
    });
    const campaignId = camp.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });

    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers: h });
    const recipientId = jobs.json<{ data: Array<{ recipient_id: string }> }>().data[0].recipient_id;

    const deliveredAt = new Date().toISOString();
    const event1 = await app.inject({
      method: 'POST', url: '/api/v1/dispatch/events', headers: h,
      payload: { recipientId, eventType: 'delivered', provider: 'evolution', externalEventId: 'evt-001', occurredAt: deliveredAt },
    });
    expect(event1.statusCode).toBe(200);
    expect(event1.json<{ accepted: boolean }>().accepted).toBe(true);

    const event1Again = await app.inject({
      method: 'POST', url: '/api/v1/dispatch/events', headers: h,
      payload: { recipientId, eventType: 'delivered', provider: 'evolution', externalEventId: 'evt-001', occurredAt: deliveredAt },
    });
    expect(event1Again.json<{ accepted: boolean; reason: string }>().accepted).toBe(false);
    expect(event1Again.json<{ reason: string }>().reason).toBe('duplicate');

    const contactRow = await db.query<{ last_outbound_at: Date | null; next_eligible_at: Date | null }>(
      'SELECT last_outbound_at, next_eligible_at FROM contacts WHERE id = $1 AND tenant_id = $2',
      [contactId, seeded.tenantId],
    );
    expect(contactRow.rows[0].last_outbound_at).toBeTruthy();
    expect(contactRow.rows[0].next_eligible_at).toBeTruthy();
    const nextEligible = new Date(contactRow.rows[0].next_eligible_at!);
    const delivered = new Date(deliveredAt);
    expect(nextEligible.getTime()).toBeGreaterThan(delivered.getTime());
  });

  it('cancels an approved campaign and marks queued recipients as cancelled', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: h,
      payload: { fullName: 'Cancel Test', phone: '(11) 95555-3333', origin: 'manual' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers: h,
      payload: { channel: 'whatsapp', purpose: 'marketing', action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Campanha cancelar', messageText: 'Será cancelada' },
    });
    const campaignId = camp.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });

    const cancel = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/cancel`, headers: h });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json<{ cancelled: number }>().cancelled).toBe(1);

    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers: h });
    expect(jobs.json<{ data: unknown[] }>().data).toHaveLength(0);

    const cancelAgain = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/cancel`, headers: h });
    expect(cancelAgain.statusCode).toBe(409);
  });
});

