import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
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
  serviceKey: undefined,
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
    const { app, db, seeded } = await setup();
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
        channel: 'whatsapp', purposes: ['marketing'], action: 'revoked',
        source: 'manual', policyVersion: '1.0', occurredAt: new Date().toISOString(),
      },
    });
    expect(consent.statusCode).toBe(201);

    const contactsAfterConsent = await app.inject({
      method: 'GET', url: '/api/v1/contacts', headers: { authorization: `Bearer ${token}` },
    });
    const updatedContact = contactsAfterConsent.json<{ data: Array<{ id: string; marketing_consent_status: string | null }> }>()
      .data.find((item) => item.id === contactId);
    expect(updatedContact?.marketing_consent_status).toBe('revoked');
    const projection = await db.query<{ do_not_contact: boolean }>(
      'SELECT do_not_contact FROM contacts WHERE id = $1 AND tenant_id = $2',
      [contactId, seeded.tenantId],
    );
    expect(projection.rows[0]?.do_not_contact).toBe(true);
  });

  it('grants defaults to new contacts and fills only missing legacy consents', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers,
      payload: { fullName: 'Contato com padrão', phone: '(11) 93333-1000', origin: 'manual' },
    });
    const createdId = created.json<{ id: string }>().id;
    const defaults = await db.query<{ purpose: string; action: string }>(
      `SELECT purpose, action FROM se_consent_events
        WHERE tenant_id = $1 AND contact_id = $2 ORDER BY purpose`,
      [seeded.tenantId, createdId],
    );
    expect(defaults.rows).toEqual([
      { purpose: 'marketing', action: 'granted' },
      { purpose: 'order_updates', action: 'granted' },
    ]);

    const legacyId = randomUUID();
    const revokedId = randomUUID();
    await db.query(
      `INSERT INTO contacts (id, tenant_id, full_name, phone_e164, origin)
       VALUES ($1,$2,'Legado pendente','+5511933331001','manual'),
              ($3,$2,'Legado revogado','+5511933331002','manual')`,
      [legacyId, seeded.tenantId, revokedId],
    );
    await db.query(
      `INSERT INTO se_consent_events
        (id, tenant_id, contact_id, channel, purpose, action, source, policy_version, occurred_at)
       VALUES ($1,$2,$3,'whatsapp','marketing','revoked','manual','1.0',$4)`,
      [randomUUID(), seeded.tenantId, revokedId, new Date().toISOString()],
    );

    const bulk = await app.inject({ method: 'POST', url: '/api/v1/contacts/consents/bulk-defaults', headers });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json<{ data: { contacts_updated: number; events_created: number } }>().data)
      .toEqual({ contacts_updated: 2, events_created: 3 });
    const revoked = await db.query<{ action: string }>(
      `SELECT action FROM se_consent_events
        WHERE tenant_id = $1 AND contact_id = $2 AND purpose = 'marketing'
        ORDER BY occurred_at DESC, created_at DESC`,
      [seeded.tenantId, revokedId],
    );
    expect(revoked.rows[0]?.action).toBe('revoked');
  });

  it('edits, archives, deletes and imports contacts in bulk', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers,
      payload: { fullName: 'Contato Gerenciável', phone: '(11) 98888-1111', origin: 'manual' },
    });
    const contactId = created.json<{ id: string }>().id;

    const edited = await app.inject({
      method: 'PATCH', url: `/api/v1/contacts/${contactId}`, headers,
      payload: { fullName: 'Contato Editado', email: 'editado@example.test', tags: ['vip'] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<{ full_name: string }>().full_name).toBe('Contato Editado');

    const bulk = await app.inject({
      method: 'POST', url: '/api/v1/contacts/bulk', headers,
      payload: { contacts: [
        { fullName: 'Lote Um', phone: '(11) 97777-1001', origin: 'manual' },
        { fullName: 'Lote Dois', phone: '(11) 97777-1002', origin: 'instagram' },
      ] },
    });
    expect(bulk.statusCode).toBe(201);
    expect(bulk.json<{ data: { created: unknown[] } }>().data.created).toHaveLength(2);

    const archived = await app.inject({ method: 'POST', url: `/api/v1/contacts/${contactId}/archive`, headers });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ archived_at: string }>().archived_at).toBeTruthy();

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/contacts/${contactId}`, headers });
    expect(deleted.statusCode).toBe(204);
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
        channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp',
        policyVersion: '1.0', occurredAt: new Date().toISOString(),
      },
    });
    const noConsentContact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: authorization,
      payload: { fullName: 'Cliente Sem Consentimento', phone: '(11) 98888-2222', origin: 'manual' },
    });
    const noConsentId = noConsentContact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${noConsentId}/consents`, headers: authorization,
      payload: {
        channel: 'whatsapp', purposes: ['marketing'], action: 'revoked', source: 'manual',
        policyVersion: '1.0', occurredAt: new Date(Date.now() + 1000).toISOString(),
      },
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
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: h,
      payload: { fullName: 'Aprovado Fictício', phone: '(11) 97777-1111', origin: 'whatsapp' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers: h,
      payload: { channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
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
    await db.query('UPDATE campaigns SET next_dispatch_at = now() WHERE id = $1 AND tenant_id = $2', [campaignId, seeded.tenantId]);

    const jobs = await app.inject({ method: 'GET', url: '/api/v1/dispatch/jobs', headers: h });
    expect(jobs.statusCode).toBe(200);
    const jobList = jobs.json<{ data: Array<{ recipient_id: string; phone_e164: string }> }>();
    expect(jobList.data).toHaveLength(1);
    expect(jobList.data[0]!.phone_e164).toBe('+5511977771111');

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
      payload: { channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Dispatch Campanha', messageText: 'Teste dispatch', minIntervalHours: 24 },
    });
    const campaignId = camp.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });
    await db.query('UPDATE campaigns SET next_dispatch_at = now() WHERE id = $1 AND tenant_id = $2', [campaignId, seeded.tenantId]);

    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers: h });
    const recipientId = jobs.json<{ data: Array<{ recipient_id: string }> }>().data[0]!.recipient_id;

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
    expect(contactRow.rows[0]!.last_outbound_at).toBeTruthy();
    expect(contactRow.rows[0]!.next_eligible_at).toBeTruthy();
    const nextEligible = new Date(contactRow.rows[0]!.next_eligible_at!);
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
      payload: { channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
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

  it('deletes unsent campaigns and archives campaigns with dispatch history', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const headers = { authorization: `Bearer ${token}` };

    const draft = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers,
      payload: { name: 'Rascunho descartÃ¡vel', messageText: 'Ainda nÃ£o enviada' },
    });
    const draftId = draft.json<{ id: string }>().id;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/campaigns/${draftId}`, headers });
    expect(deleted.statusCode).toBe(204);

    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers,
      payload: { fullName: 'Cliente com histÃ³rico', phone: '(11) 94444-1234', origin: 'whatsapp' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers,
      payload: { channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });
    const campaign = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers,
      payload: { name: 'Campanha com histÃ³rico', messageText: 'Mensagem enviada' },
    });
    const campaignId = campaign.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers });
    await db.query('UPDATE campaigns SET next_dispatch_at = now() WHERE id = $1 AND tenant_id = $2', [campaignId, seeded.tenantId]);
    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers });
    expect(jobs.json<{ count: number }>().count).toBe(1);

    const blockedDelete = await app.inject({ method: 'DELETE', url: `/api/v1/campaigns/${campaignId}`, headers });
    expect(blockedDelete.statusCode).toBe(409);
    expect(blockedDelete.json<{ error: { code: string } }>().error.code).toBe('CAMPAIGN_HAS_HISTORY');

    const archived = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/archive`, headers });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ data: { archived: boolean } }>().data.archived).toBe(true);
  });
});

const HMAC_SECRET = 'super-secret-samjoefood-key-32c!';

function samjoeFoodHeaders(payload: unknown, secret = HMAC_SECRET): Record<string, string> {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-samjoe-food-signature': sig,
    'x-samjoe-food-timestamp': new Date().toISOString(),
  };
}

describe('SamJoE Food integration (Fase 4)', () => {
  it('configures SamJoE Food integration and retrieves config', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    const put = await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ data: { status: string } }>().data.status).toBe('active');

    const get = await app.inject({ method: 'GET', url: '/api/v1/integrations/samjoe-food', headers: h });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ data: { status: string } }>().data.status).toBe('active');
    expect(JSON.stringify(get.json())).not.toContain(HMAC_SECRET);
  });

  it('rejects webhook with invalid HMAC signature', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: { authorization: `Bearer ${token}` },
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = { event_id: 'e-001', event_type: 'customer.created', occurred_at: new Date().toISOString(), customer: { external_id: 'c-001' } };
    const badHeaders = {
      'content-type': 'application/json',
      'x-samjoe-food-signature': 'sha256=badhash',
      'x-samjoe-food-timestamp': new Date().toISOString(),
      'x-tenant-id': seeded.tenantId,
    };
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/samjoe-food/events', headers: badHeaders, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects webhook with expired timestamp', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: { authorization: `Bearer ${token}` },
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = { event_id: 'e-002', event_type: 'customer.created', occurred_at: new Date().toISOString(), customer: { external_id: 'c-002' } };
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/samjoe-food/events',
      headers: { 'content-type': 'application/json', 'x-samjoe-food-signature': sig, 'x-samjoe-food-timestamp': oldTs, 'x-tenant-id': seeded.tenantId },
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
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = {
      event_id: 'cust-create-001',
      event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'fa-cust-001', phone: '(11) 97777-1234', name: 'João SamJoE Food' },
    };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/samjoe-food/events',
      headers: { ...samjoeFoodHeaders(payload), 'x-tenant-id': seeded.tenantId },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: boolean }>().accepted).toBe(true);

    const link = await db.query(
      `SELECT contact_id FROM external_customer_links WHERE tenant_id = $1 AND source = 'samjoe_food' AND external_customer_id = 'fa-cust-001'`,
      [seeded.tenantId],
    );
    expect(link.rows).toHaveLength(1);

    const contact = await db.query(
      `SELECT full_name, phone_e164 FROM contacts WHERE id = $1`,
      [link.rows[0]!.contact_id],
    );
    expect(contact.rows[0]!.full_name).toBe('João SamJoE Food');
    expect(contact.rows[0]!.phone_e164).toBe('+5511977771234');
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
      payload: { channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    // Campaign → preflight → approve → dispatch delivered
    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Campanha Conversão', messageText: 'Compre agora', minIntervalHours: 24, conversionWindowDays: 7 },
    });
    const campaignId = camp.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });
    await db.query('UPDATE campaigns SET next_dispatch_at = now() WHERE id = $1 AND tenant_id = $2', [campaignId, seeded.tenantId]);

    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers: h });
    const recipientId = jobs.json<{ data: Array<{ recipient_id: string }> }>().data[0]!.recipient_id;

    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await app.inject({
      method: 'POST', url: '/api/v1/dispatch/events', headers: h,
      payload: { recipientId, eventType: 'delivered', provider: 'evolution', externalEventId: 'disp-evt-001', occurredAt: deliveredAt },
    });

    // Configure SamJoE Food
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    // Send order.paid via SamJoE Food webhook — customer matched by phone
    const orderedAt = new Date().toISOString();
    const payload = {
      event_id: 'order-paid-001',
      event_type: 'order.paid',
      occurred_at: orderedAt,
      customer: { external_id: 'fa-maria-001', phone: '(11) 97777-5555' },
      order: { external_id: 'ord-001', total_cents: 4990, cost_cents: 1500 },
    };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/samjoe-food/events',
      headers: { ...samjoeFoodHeaders(payload), 'x-tenant-id': seeded.tenantId },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: boolean }>().accepted).toBe(true);

    const conversion = await db.query<{ campaign_id: string; revenue_cents: number; margin_cents: number; status: string }>(
      `SELECT campaign_id, revenue_cents, margin_cents, status FROM campaign_conversions WHERE tenant_id = $1 AND source = 'samjoe_food'`,
      [seeded.tenantId],
    );
    expect(conversion.rows).toHaveLength(1);
    expect(conversion.rows[0]!.campaign_id).toBe(campaignId);
    expect(conversion.rows[0]!.revenue_cents).toBe(4990);
    expect(conversion.rows[0]!.margin_cents).toBe(3490);
    expect(conversion.rows[0]!.status).toBe('paid');

    const contactRow = await db.query<{ last_purchase_at: Date | null }>(
      `SELECT last_purchase_at FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [contactId, seeded.tenantId],
    );
    expect(contactRow.rows[0]!.last_purchase_at).toBeTruthy();
  });

  it('order.paid is idempotent — duplicate event returns accepted:false', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });

    const payload = {
      event_id: 'order-dup-001',
      event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'fa-dup-001' },
      order: { external_id: 'ord-dup-001', total_cents: 2000 },
    };
    const tenantHeaders = { ...samjoeFoodHeaders(payload), 'x-tenant-id': seeded.tenantId };
    const first = await app.inject({ method: 'POST', url: '/api/v1/integrations/samjoe-food/events', headers: tenantHeaders, payload });
    expect(first.json<{ accepted: boolean }>().accepted).toBe(true);

    const second = await app.inject({ method: 'POST', url: '/api/v1/integrations/samjoe-food/events', headers: { ...samjoeFoodHeaders(payload), 'x-tenant-id': seeded.tenantId }, payload });
    expect(second.json<{ accepted: boolean; reason?: string }>().accepted).toBe(false);
    expect(second.json<{ reason: string }>().reason).toBe('duplicate');
  });

  it('order.refunded reverses an existing paid conversion', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: h,
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
      method: 'POST', url: '/api/v1/integrations/samjoe-food/events',
      headers: { ...samjoeFoodHeaders(paidPayload), 'x-tenant-id': seeded.tenantId },
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
      method: 'POST', url: '/api/v1/integrations/samjoe-food/events',
      headers: { ...samjoeFoodHeaders(refundPayload), 'x-tenant-id': seeded.tenantId },
      payload: refundPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accepted: boolean }>().accepted).toBe(true);

    const conv = await db.query<{ status: string; revenue_cents: number }>(
      `SELECT status, revenue_cents FROM campaign_conversions WHERE tenant_id = $1 AND source = 'samjoe_food' AND external_order_id = 'ord-refund-001'`,
      [seeded.tenantId],
    );
    expect(conv.rows[0]!.status).toBe('refunded');
    expect(conv.rows[0]!.revenue_cents).toBe(0);
  });
});

describe('Analytics (dashboard de conversões)', () => {
  it('returns empty summary when no campaigns exist', async () => {
    const { app, seeded } = await setup();
    const token = await login(app, seeded);
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/campaigns', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ campaigns: unknown[]; summary: { total_campaigns: number; total_recipients: number; total_conversions: number } }>();
    expect(body.campaigns).toHaveLength(0);
    expect(body.summary.total_campaigns).toBe(0);
    expect(body.summary.total_recipients).toBe(0);
    expect(body.summary.total_conversions).toBe(0);
  });

  it('aggregates delivery stats and attributed revenue per campaign', async () => {
    const { app, db, seeded } = await setup();
    const token = await login(app, seeded);
    const h = { authorization: `Bearer ${token}` };

    // Create contact with consent
    const contact = await app.inject({
      method: 'POST', url: '/api/v1/contacts', headers: h,
      payload: { fullName: 'Analytics Test', phone: '(11) 96666-7777', origin: 'manual' },
    });
    const contactId = contact.json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/api/v1/contacts/${contactId}/consents`, headers: h,
      payload: { channel: 'whatsapp', purposes: ['marketing'], action: 'granted', source: 'whatsapp', policyVersion: '1.0', occurredAt: new Date().toISOString() },
    });

    // Campaign → preflight → approve → dispatch delivered
    const camp = await app.inject({
      method: 'POST', url: '/api/v1/campaigns', headers: h,
      payload: { name: 'Campanha Analytics', messageText: 'Teste analytics', minIntervalHours: 24 },
    });
    const campaignId = camp.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/preflight`, headers: h });
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${campaignId}/approve`, headers: h });
    await db.query('UPDATE campaigns SET next_dispatch_at = now() WHERE id = $1 AND tenant_id = $2', [campaignId, seeded.tenantId]);

    const jobs = await app.inject({ method: 'GET', url: `/api/v1/dispatch/jobs?campaign_id=${campaignId}`, headers: h });
    const recipientId = jobs.json<{ data: Array<{ recipient_id: string }> }>().data[0]!.recipient_id;

    await app.inject({
      method: 'POST', url: '/api/v1/dispatch/events', headers: h,
      payload: { recipientId, eventType: 'read', provider: 'evolution', externalEventId: 'analytics-evt-001', occurredAt: new Date(Date.now() - 60_000).toISOString() },
    });

    // SamJoE Food order.paid → attribution
    await app.inject({
      method: 'PUT', url: '/api/v1/integrations/samjoe-food', headers: h,
      payload: { hmacSecret: HMAC_SECRET, status: 'active' },
    });
    const orderPayload = {
      event_id: 'analytics-order-001',
      event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'fa-analytics-001', phone: '(11) 96666-7777' },
      order: { external_id: 'analytics-ord-001', total_cents: 8000, cost_cents: 3000 },
    };
    await app.inject({
      method: 'POST', url: '/api/v1/integrations/samjoe-food/events',
      headers: { ...samjoeFoodHeaders(orderPayload), 'x-tenant-id': seeded.tenantId },
      payload: orderPayload,
    });

    // Fetch analytics
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/campaigns', headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      campaigns: Array<{ id: string; name: string; read: number; engaged: number; conversions: number; revenue_cents: number; margin_cents: number }>;
      summary: { total_campaigns: number; total_conversions: number; total_revenue_cents: number };
    }>();

    const stat = body.campaigns.find(c => c.id === campaignId);
    expect(stat).toBeTruthy();
    expect(stat!.read).toBe(1);
    expect(stat!.engaged).toBe(1);
    expect(stat!.conversions).toBe(1);
    expect(stat!.revenue_cents).toBe(8000);
    expect(stat!.margin_cents).toBe(5000);

    expect(body.summary.total_conversions).toBe(1);
    expect(body.summary.total_revenue_cents).toBe(8000);
    expect(body.summary.total_campaigns).toBeGreaterThanOrEqual(1);
  });
});

