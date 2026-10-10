import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
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

const HMAC_SECRET = 'super-secret-foodapp-key-32chars!';

function foodappHeaders(payload: unknown, secret = HMAC_SECRET): Record<string, string> {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-foodapp-signature': sig,
    'x-foodapp-timestamp': new Date().toISOString(),
  };
}

describe('FoodApp integration (Fase 4)', () => {
  it('configures FoodApp integration and retrieves config', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    const put = await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ data: { status: string } }>().data.status).toBe('active');

    const get = await app.inject({ method: 'GET', url: '/api/v1/integrations/foodapp', headers: h });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ data: { status: string } }>().data.status).toBe('active');
    expect(JSON.stringify(get.json())).not.toContain(HMAC_SECRET);
  });

  it('rejects webhook with invalid HMAC signature', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: { authorization: `Bearer ${token}` },
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = { event_id: 'e-001', event_type: 'customer.created', occurred_at: new Date().toISOString(), customer: { external_id: 'c-001' } };
    const badHeaders = {
      'content-type': 'application/json',
      'x-foodapp-signature': 'sha256=badhash',
      'x-foodapp-timestamp': new Date().toISOString(),
      'x-tenant-id': seeded.tenantId,
    };
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/foodapp/events', headers: badHeaders, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects webhook with expired timestamp', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: { authorization: `Bearer ${token}` },
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = { event_id: 'e-002', event_type: 'customer.created', occurred_at: new Date().toISOString(), customer: { external_id: 'c-002' } };
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/foodapp/events',
      headers: { 'content-type': 'application/json', 'x-foodapp-signature': sig, 'x-foodapp-timestamp': oldTs, 'x-tenant-id': seeded.tenantId },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('REPLAY_DETECTED');
  });

  it('customer.created creates contact and external link via phone lookup', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = {
      event_id: 'cust-create-001',
      event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'fa-cust-001', phone: '(11) 97777-1234', name: 'João FoodApp' },
    };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/foodapp/events',
      headers: { ...foodappHeaders(payload), 'x-tenant-id': seeded.tenantId },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: boolean }>().accepted).toBe(true);

    const link = await db.query(
      `SELECT contact_id FROM external_customer_links WHERE tenant_id = $1 AND source = 'foodapp' AND external_customer_id = 'fa-cust-001'`,
      [seeded.tenantId],
    );
    expect(link.rows).toHaveLength(1);

    const contact = await db.query(
      `SELECT full_name, phone_e164 FROM contacts WHERE id = $1`,
      [link.rows[0].contact_id],
    );
    expect(contact.rows[0].full_name).toBe('João FoodApp');
    expect(contact.rows[0].phone_e164).toBe('+5511977771234');
  });

  it('order.paid records conversion with last-touch attribution and updates last_purchase_at', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    // Create contact with consent
    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: h,
      payload: { fullName: 'Maria Conversão', phone: '(11) 97777-5555', origin: 'manual' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers: h,
      payload: { channel: 'whatsapp', purpose: 'marketing', action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    // Campaign → preflight → approve → dispatch delivered
    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Campanha Conversão', messageText: 'Compre agora', minIntervalHours: 24, conversionWindowDays: 7 },
    });
    const campaignId = camp.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });

    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers: h });
    const recipientId = jobs.json<{ data: Array<{ recipient_id: string }> }>().data[0].recipient_id;

    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await app.inject({
      method: 'POST', url: '/api/v1/dispatch/events', headers: h,
      payload: { recipientId, eventType: 'delivered', provider: 'evolution', externalEventId: 'disp-evt-001', occurredAt: deliveredAt },
    });

    // Configure FoodApp
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    // Send order.paid via FoodApp webhook — customer matched by phone
    const orderedAt = new Date().toISOString();
    const payload = {
      event_id: 'order-paid-001',
      event_type: 'order.paid',
      occurred_at: orderedAt,
      customer: { external_id: 'fa-maria-001', phone: '(11) 97777-5555' },
      order: { external_id: 'ord-001', total_cents: 4990, cost_cents: 1500 },
    };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/foodapp/events',
      headers: { ...foodappHeaders(payload), 'x-tenant-id': seeded.tenantId },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: boolean }>().accepted).toBe(true);

    const conversion = await db.query<{ campaign_id: string; revenue_cents: number; margin_cents: number; status: string }>(
      `SELECT campaign_id, revenue_cents, margin_cents, status FROM campaign_conversions WHERE tenant_id = $1 AND source = 'foodapp'`,
      [seeded.tenantId],
    );
    expect(conversion.rows).toHaveLength(1);
    expect(conversion.rows[0].campaign_id).toBe(campaignId);
    expect(conversion.rows[0].revenue_cents).toBe(4990);
    expect(conversion.rows[0].margin_cents).toBe(3490);
    expect(conversion.rows[0].status).toBe('paid');

    const contactRow = await db.query<{ last_purchase_at: Date | null }>(
      `SELECT last_purchase_at FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [contactId, seeded.tenantId],
    );
    expect(contactRow.rows[0].last_purchase_at).toBeTruthy();
  });

  it('order.paid is idempotent — duplicate event returns accepted:false', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = {
      event_id: 'order-dup-001',
      event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'fa-dup-001' },
      order: { external_id: 'ord-dup-001', total_cents: 2000 },
    };
    const tenantHeaders = { ...foodappHeaders(payload), 'x-tenant-id': seeded.tenantId };
    const first = await app.inject({ method: 'POST', url: '/api/v1/integrations/foodapp/events', headers: tenantHeaders, payload });
    expect(first.json<{ accepted: boolean }>().accepted).toBe(true);

    const second = await app.inject({ method: 'POST', url: '/api/v1/integrations/foodapp/events', headers: { ...foodappHeaders(payload), 'x-tenant-id': seeded.tenantId }, payload });
    expect(second.json<{ accepted: boolean; reason?: string }>().accepted).toBe(false);
    expect(second.json<{ reason: string }>().reason).toBe('duplicate');
  });

  it('order.refunded reverses an existing paid conversion', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/foodapp', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    // First pay
    const paidPayload = {
      event_id: 'order-refund-evt-pay',
      event_type: 'order.paid',
      occurred_at: new Date(Date.now() - 5000).toISOString(),
      customer: { external_id: 'fa-refund-001' },
      order: { external_id: 'ord-refund-001', total_cents: 9900 },
    };
    await app.inject({
      method: 'POST', url: '/api/v1/integrations/foodapp/events',
      headers: { ...foodappHeaders(paidPayload), 'x-tenant-id': seeded.tenantId },
      payload: paidPayload,
    });

    // Then refund
    const refundPayload = {
      event_id: 'order-refund-evt-ref',
      event_type: 'order.refunded',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'fa-refund-001' },
      order: { external_id: 'ord-refund-001', total_cents: 0 },
    };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/foodapp/events',
      headers: { ...foodappHeaders(refundPayload), 'x-tenant-id': seeded.tenantId },
      payload: refundPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: boolean }>().accepted).toBe(true);

    const conv = await db.query<{ status: string; revenue_cents: number }>(
      `SELECT status, revenue_cents FROM campaign_conversions WHERE tenant_id = $1 AND source = 'foodapp' AND external_order_id = 'ord-refund-001'`,
      [seeded.tenantId],
    );
    expect(conv.rows[0].status).toBe('refunded');
    expect(conv.rows[0].revenue_cents).toBe(0);
  });
});

