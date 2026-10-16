/**
 * Testes de serviÃ§o â€” banco in-memory (pg-mem)
 *
 * Cobre diretamente as funÃ§Ãµes de serviÃ§o (sem HTTP), com dados fictÃ­cios
 * inseridos diretamente no banco para exercitar todos os caminhos de cÃ³digo.
 */
import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, seedTestTenant } from './helpers/test-db.js';
import type { Database } from '../src/core/db.js';
import {
  createCampaign,
  generateCampaignPreflight,
  approveCampaign,
  cancelCampaign,
  updateCampaign,
  getCampaignPreflight,
} from '../src/services/campaign-service.js';
import { processDispatchEvent, getDispatchJobs } from '../src/services/dispatch-service.js';
import {
  processSamJoeFoodEvent,
  upsertSamJoeFoodConfig,
  getSamJoeFoodConfig,
} from '../src/services/samjoe-food-service.js';
import { getCampaignAnalytics } from '../src/services/analytics-service.js';

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type ContactOpts = {
  full_name?: string;
  phone_e164?: string | null;
  email?: string | null;
  origin?: string;
  stage?: string;
  tags?: string[];
  do_not_contact?: boolean;
  last_outbound_at?: string | null;
  next_eligible_at?: string | null;
};

async function insertContact(db: Database, tenantId: string, opts: ContactOpts = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO contacts
      (id, tenant_id, full_name, phone_e164, email, origin, stage,
       tags_json, do_not_contact, last_outbound_at, next_eligible_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [
      id, tenantId,
      opts.full_name ?? 'Contato Teste',
      opts.phone_e164 !== undefined ? opts.phone_e164 : '+5511999990001',
      opts.email ?? null,
      opts.origin ?? 'manual',
      opts.stage ?? 'prospect',
      JSON.stringify(opts.tags ?? []),
      opts.do_not_contact ?? false,
      opts.last_outbound_at ?? null,
      opts.next_eligible_at ?? null,
    ],
  );
  return id;
}

async function grantConsent(db: Database, tenantId: string, contactId: string, action: 'granted' | 'revoked' = 'granted') {
  await db.query(
    `INSERT INTO se_consent_events
      (id, tenant_id, contact_id, channel, purpose, action, source, policy_version, occurred_at)
     VALUES ($1, $2, $3, 'whatsapp', 'marketing', $4, 'manual_crm', '1.0', $5)`,
    [randomUUID(), tenantId, contactId, action, new Date().toISOString()],
  );
}

async function insertCampaignRecipient(
  db: Database, tenantId: string, campaignId: string, contactId: string,
  opts: { deliveredAt?: string; readAt?: string; delivery_status?: string } = {},
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO campaign_recipients
      (id, tenant_id, campaign_id, contact_id, eligible, delivery_status, delivered_at, read_at, snapshot_created_at)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, now())`,
    [
      id, tenantId, campaignId, contactId,
      opts.delivery_status ?? (opts.deliveredAt ? 'delivered' : opts.readAt ? 'read' : 'pending'),
      opts.deliveredAt ?? null,
      opts.readAt ?? null,
    ],
  );
  return id;
}

async function insertConversion(db: Database, tenantId: string, contactId: string) {
  await db.query(
    `INSERT INTO campaign_conversions
      (id, tenant_id, contact_id, source, external_event_id, external_order_id,
       status, revenue_cents, occurred_at, metadata_json)
     VALUES ($1, $2, $3, 'manual', $4, $5, 'paid', 5000, now(), '{}'::jsonb)`,
    [randomUUID(), tenantId, contactId, randomUUID(), randomUUID()],
  );
}

async function fullCampaignSetup(
  db: Database, tenantId: string, userId: string,
  campOpts: Partial<Parameters<typeof createCampaign>[3]> = {},
) {
  const camp = await createCampaign(db, tenantId, userId, {
    name: 'Campanha Teste', messageText: 'OlÃ¡!', ...campOpts,
  });
  return camp as { id: string };
}

// â”€â”€â”€ shared fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let db: Database;
let tenantId: string;
let userId: string;

beforeEach(async () => {
  db = await createTestDatabase();
  const seeded = await seedTestTenant(db);
  tenantId = seeded.tenantId;
  userId = seeded.userId;
});

afterEach(() => {
  // pg-mem is garbage-collected â€” nothing to close
});

// â”€â”€â”€ eligibility engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Eligibility engine â€” preflight', () => {
  it('eligible: telefone vÃ¡lido + consentimento granted', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(true);
    expect(rec?.exclusion_reasons).toHaveLength(0);
  });

  it('exclusÃ£o: telefone ausente â†’ invalid_phone', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId, { phone_e164: null });
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('invalid_phone');
  });

  it('exclusÃ£o: telefone com formato invÃ¡lido â†’ invalid_phone', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId, { phone_e164: '11999990001' }); // sem +55
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('invalid_phone');
  });

  it('exclusÃ£o: do_not_contact = true', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId, { do_not_contact: true });
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('do_not_contact');
  });

  it('exclusÃ£o: stage = blocked', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId, { stage: 'blocked' });
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('blocked');
  });

  it('exclusÃ£o: sem consentimento â†’ marketing_consent_missing', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    await insertContact(db, tenantId);
    // sem grantConsent

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients[0];
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('marketing_consent_missing');
  });

  it('exclusÃ£o: consentimento revogado â†’ marketing_consent_missing', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid, 'granted');
    await grantConsent(db, tenantId, cid, 'revoked'); // mais recente

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('marketing_consent_missing');
  });

  it('exclusÃ£o: next_eligible_at no futuro â†’ cooldown', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const future = new Date(Date.now() + 48 * 3600000).toISOString();
    const cid = await insertContact(db, tenantId, { next_eligible_at: future });
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('cooldown');
  });

  it('exclusÃ£o: last_outbound_at + min_interval_hours no futuro â†’ cooldown', async () => {
    // minIntervalHours=24, last_outbound hÃ¡ 1h â†’ ainda em cooldown por 23h
    const camp = await fullCampaignSetup(db, tenantId, userId, { minIntervalHours: 24 });
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const cid = await insertContact(db, tenantId, { last_outbound_at: oneHourAgo });
    await grantConsent(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('cooldown');
  });

  it('exclusÃ£o: cap de frequÃªncia atingido (2 entregas em 30d, max=2)', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, { maxNotificationsPer30d: 2 });
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);

    // 2 campanhas passadas com entrega confirmada para o mesmo contato
    const past1 = await fullCampaignSetup(db, tenantId, userId);
    const past2 = await fullCampaignSetup(db, tenantId, userId);
    const recentTs = new Date(Date.now() - 3600000).toISOString();
    await insertCampaignRecipient(db, tenantId, past1.id, cid, { deliveredAt: recentTs });
    await insertCampaignRecipient(db, tenantId, past2.id, cid, { deliveredAt: recentTs });

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('frequency_cap');
  });

  it('nÃ£o exclui por frequÃªncia quando entregas tÃªm > 30 dias', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, { maxNotificationsPer30d: 1 });
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);

    // Entrega hÃ¡ 31 dias (fora da janela)
    const old = await fullCampaignSetup(db, tenantId, userId);
    const olderThan30d = new Date(Date.now() - 31 * 86400000).toISOString();
    await insertCampaignRecipient(db, tenantId, old.id, cid, { deliveredAt: olderThan30d });

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(true);
  });

  it('exclusÃ£o: stage_not_selected quando regra de audiÃªncia filtra por etapa', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, {
      audienceRules: { stages: ['first_buyer', 'repeat_buyer'] },
    });
    const cidProspect = await insertContact(db, tenantId, { stage: 'prospect', phone_e164: '+5511999990010' });
    const cidBuyer = await insertContact(db, tenantId, { stage: 'first_buyer', phone_e164: '+5511999990011' });
    await grantConsent(db, tenantId, cidProspect);
    await grantConsent(db, tenantId, cidBuyer);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const recProspect = result.report.recipients.find((r) => r.contact_id === cidProspect);
    const recBuyer = result.report.recipients.find((r) => r.contact_id === cidBuyer);
    expect(recProspect?.eligible).toBe(false);
    expect(recProspect?.exclusion_reasons).toContain('stage_not_selected');
    expect(recBuyer?.eligible).toBe(true);
  });

  it('exclusÃ£o: origin_not_selected quando regra de audiÃªncia filtra por origem', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, {
      audienceRules: { origins: ['instagram'] },
    });
    const cidManual = await insertContact(db, tenantId, { origin: 'manual', phone_e164: '+5511999990020' });
    const cidInsta = await insertContact(db, tenantId, { origin: 'instagram', phone_e164: '+5511999990021' });
    await grantConsent(db, tenantId, cidManual);
    await grantConsent(db, tenantId, cidInsta);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.recipients.find((r) => r.contact_id === cidManual)?.eligible).toBe(false);
    expect(result.report.recipients.find((r) => r.contact_id === cidInsta)?.eligible).toBe(true);
  });

  it('exclusÃ£o: tag_not_selected quando contato nÃ£o tem nenhuma tag da lista', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, {
      audienceRules: { tagsAny: ['vip', 'premium'] },
    });
    const cidNoTag = await insertContact(db, tenantId, { tags: [], phone_e164: '+5511999990030' });
    const cidVip = await insertContact(db, tenantId, { tags: ['vip'], phone_e164: '+5511999990031' });
    await grantConsent(db, tenantId, cidNoTag);
    await grantConsent(db, tenantId, cidVip);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.recipients.find((r) => r.contact_id === cidNoTag)?.eligible).toBe(false);
    expect(result.report.recipients.find((r) => r.contact_id === cidNoTag)?.exclusion_reasons).toContain('tag_not_selected');
    expect(result.report.recipients.find((r) => r.contact_id === cidVip)?.eligible).toBe(true);
  });

  it('exclusÃ£o: already_converted quando includeConverted=false', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, { includeConverted: false });
    const cidConverted = await insertContact(db, tenantId, { phone_e164: '+5511999990040' });
    const cidFresh = await insertContact(db, tenantId, { phone_e164: '+5511999990041' });
    await grantConsent(db, tenantId, cidConverted);
    await grantConsent(db, tenantId, cidFresh);
    await insertConversion(db, tenantId, cidConverted);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.recipients.find((r) => r.contact_id === cidConverted)?.eligible).toBe(false);
    expect(result.report.recipients.find((r) => r.contact_id === cidConverted)?.exclusion_reasons).toContain('already_converted');
    expect(result.report.recipients.find((r) => r.contact_id === cidFresh)?.eligible).toBe(true);
  });

  it('jÃ¡ convertido Ã© elegÃ­vel quando includeConverted=true (padrÃ£o)', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId, { includeConverted: true });
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await insertConversion(db, tenantId, cid);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(true);
    expect(rec?.prior_conversion_count).toBe(1);
  });

  it('mÃºltiplas razÃµes simultÃ¢neas: sem telefone + sem consentimento', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId, { phone_e164: null }); // sem telefone, sem consentimento

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rec = result.report.recipients.find((r) => r.contact_id === cid);
    expect(rec?.eligible).toBe(false);
    expect(rec?.exclusion_reasons).toContain('invalid_phone');
    expect(rec?.exclusion_reasons).toContain('marketing_consent_missing');
  });

  it('totais de preflight estÃ£o corretos', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    // 2 elegÃ­veis, 1 excluÃ­do
    const cid1 = await insertContact(db, tenantId, { phone_e164: '+5511999990050' });
    const cid2 = await insertContact(db, tenantId, { phone_e164: '+5511999990051' });
    const cidBad = await insertContact(db, tenantId, { phone_e164: null }); // invÃ¡lido
    await grantConsent(db, tenantId, cid1);
    await grantConsent(db, tenantId, cid2);
    await grantConsent(db, tenantId, cidBad);

    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.totals.evaluated).toBe(3);
    expect(result.report.totals.eligible).toBe(2);
    expect(result.report.totals.excluded).toBe(1);
    expect(result.report.excluded_by_reason.invalid_phone).toBe(1);
  });

  it('preflight em campanha cancelada retorna invalid_status', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    await cancelCampaign(db, tenantId, camp.id);
    const result = await generateCampaignPreflight(db, tenantId, camp.id);
    expect(result.kind).toBe('invalid_status');
  });
});

// â”€â”€â”€ campaign state machine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Campaign state machine', () => {
  it('approveCampaign em campanha draft (sem snapshot) â†’ invalid_status', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const result = await approveCampaign(db, tenantId, camp.id, userId);
    expect(result.kind).toBe('invalid_status');
  });

  it('approveCampaign em campanha cancelada â†’ invalid_status', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    await generateCampaignPreflight(db, tenantId, camp.id);
    await cancelCampaign(db, tenantId, camp.id);
    const result = await approveCampaign(db, tenantId, camp.id, userId);
    expect(result.kind).toBe('invalid_status');
  });

  it('approveCampaign apÃ³s preflight â†’ queues recipients e retorna snapshot_hash', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);

    const result = await approveCampaign(db, tenantId, camp.id, userId);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.queued).toBe(1);
    expect(result.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cancelCampaign em campanha completed â†’ invalid_status', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    await db.query(`UPDATE campaigns SET status = 'completed' WHERE id = $1`, [camp.id]);
    const result = await cancelCampaign(db, tenantId, camp.id);
    expect(result.kind).toBe('invalid_status');
  });

  it('cancelCampaign em campanha cancelled â†’ invalid_status', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    await cancelCampaign(db, tenantId, camp.id);
    const result = await cancelCampaign(db, tenantId, camp.id);
    expect(result.kind).toBe('invalid_status');
  });

  it('cancelCampaign em campanha draft sem destinatÃ¡rios â†’ ok, cancelled=0', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const result = await cancelCampaign(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.cancelled).toBe(0);
  });

  it('cancelCampaign em campanha aprovada cancela recipients queued', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);
    const result = await cancelCampaign(db, tenantId, camp.id);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.cancelled).toBe(1);
  });

  it('updateCampaign em campanha aprovada â†’ locked', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);

    const result = await updateCampaign(db, tenantId, camp.id, { name: 'Novo nome' });
    expect(result).toMatchObject({ locked: true });
  });

  it('updateCampaign reseta status para draft e limpa snapshot', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);

    // EstÃ¡ preflight_ready, agora atualiza
    const result = await updateCampaign(db, tenantId, camp.id, { name: 'Nome Alterado' });
    expect(result).not.toBeNull();
    if (!result || 'locked' in result && result.locked) return;
    expect((result as unknown as { campaign: { status: string; snapshot_hash: unknown } }).campaign.status).toBe('draft');
    expect((result as unknown as { campaign: { snapshot_hash: unknown } }).campaign.snapshot_hash).toBeNull();
  });

  it('updateCampaign sem campos retorna campanha atual sem resetar', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const result = await updateCampaign(db, tenantId, camp.id, {});
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('campaign');
  });

  it('updateCampaign substitui e remove assets da campanha', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const imageUrl = 'https://example.test/campaign-image.webp';

    const withAsset = await updateCampaign(db, tenantId, camp.id, {
      assets: [{ type: 'image', url: imageUrl, mimeType: 'image/webp', fileName: 'campaign-image.webp' }],
    });
    expect(withAsset).toMatchObject({
      locked: false,
      campaign: { assets: [{ asset_type: 'image', url: imageUrl, mime_type: 'image/webp' }] },
    });

    const withoutAsset = await updateCampaign(db, tenantId, camp.id, { assets: [] });
    expect(withoutAsset).toMatchObject({ locked: false, campaign: { assets: [] } });
  });

  it('getCampaignPreflight retorna { ready: false } quando snapshot ainda nÃ£o existe', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const result = await getCampaignPreflight(db, tenantId, camp.id);
    expect(result).toMatchObject({ ready: false });
  });

  it('getCampaignPreflight retorna relatÃ³rio completo apÃ³s preflight', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);

    const result = await getCampaignPreflight(db, tenantId, camp.id);
    expect(result).toMatchObject({ ready: true });
    expect((result as { recipients: unknown[] }).recipients).toHaveLength(1);
  });
});

// â”€â”€â”€ dispatch service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Dispatch service â€” status machine', () => {
  async function setupApprovedCampaign() {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId);
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);
    const jobs = await getDispatchJobs(db, tenantId, { campaignId: camp.id, force: true });
    const job = jobs[0];
    if (!job) throw new Error('Expected an approved campaign dispatch job');
    return { campaignId: camp.id, contactId: cid, recipientId: job.recipient_id, job };
  }

  it('getDispatchJobs retorna job com campos esperados', async () => {
    const { job, contactId } = await setupApprovedCampaign();
    expect(job.recipient_id).toBeTruthy();
    expect(job.contact_id).toBe(contactId);
    expect(job.phone_e164).toBe('+5511999990001');
  });

  it('getDispatchJobs respeita limit', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    for (let i = 0; i < 3; i++) {
      const cid = await insertContact(db, tenantId, { phone_e164: `+551199999${String(i).padStart(4, '0')}` });
      await grantConsent(db, tenantId, cid);
    }
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);

    const jobs = await getDispatchJobs(db, tenantId, { limit: 2, force: true });
    expect(jobs.length).toBeLessThanOrEqual(2);
  });

  it('evento sent: queued â†’ sent', async () => {
    const { recipientId } = await setupApprovedCampaign();
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'sent', provider: 'evolution',
      externalEventId: 'evt-sent-01', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('ok');

    const row = await db.query<{ delivery_status: string; sent_at: unknown }>(
      'SELECT delivery_status, sent_at FROM campaign_recipients WHERE id = $1', [recipientId],
    );
    expect(row.rows[0]!.delivery_status).toBe('sent');
    expect(row.rows[0]!.sent_at).toBeTruthy();
  });

  it('evento delivered: queued â†’ delivered e atualiza last_outbound_at no contato', async () => {
    const { recipientId, contactId } = await setupApprovedCampaign();
    const deliveredAt = new Date().toISOString();
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'delivered', provider: 'evolution',
      externalEventId: 'evt-del-01', occurredAt: deliveredAt,
    });
    expect(result.kind).toBe('ok');

    const rRow = await db.query<{ delivery_status: string }>(
      'SELECT delivery_status FROM campaign_recipients WHERE id = $1', [recipientId],
    );
    expect(rRow.rows[0]!.delivery_status).toBe('delivered');

    const cRow = await db.query<{ last_outbound_at: unknown; next_eligible_at: unknown }>(
      'SELECT last_outbound_at, next_eligible_at FROM contacts WHERE id = $1', [contactId],
    );
    expect(cRow.rows[0]!.last_outbound_at).toBeTruthy();
    expect(cRow.rows[0]!.next_eligible_at).toBeTruthy();
  });

  it('evento read: queued â†’ read e atualiza last_outbound_at', async () => {
    const { recipientId, contactId } = await setupApprovedCampaign();
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'read', provider: 'evolution',
      externalEventId: 'evt-read-01', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('ok');

    const rRow = await db.query<{ delivery_status: string; read_at: unknown }>(
      'SELECT delivery_status, read_at FROM campaign_recipients WHERE id = $1', [recipientId],
    );
    expect(rRow.rows[0]!.delivery_status).toBe('read');
    expect(rRow.rows[0]!.read_at).toBeTruthy();

    const cRow = await db.query<{ last_outbound_at: unknown }>(
      'SELECT last_outbound_at FROM contacts WHERE id = $1', [contactId],
    );
    expect(cRow.rows[0]!.last_outbound_at).toBeTruthy();
  });

  it('evento failed: queued â†’ failed', async () => {
    const { recipientId } = await setupApprovedCampaign();
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'failed', provider: 'evolution',
      externalEventId: 'evt-fail-01', occurredAt: new Date().toISOString(), errorCode: 'NO_PHONE',
    });
    expect(result.kind).toBe('ok');

    const row = await db.query<{ delivery_status: string }>(
      'SELECT delivery_status FROM campaign_recipients WHERE id = $1', [recipientId],
    );
    expect(row.rows[0]!.delivery_status).toBe('failed');
  });

  it('failed em sent tambÃ©m Ã© permitido: sent â†’ failed', async () => {
    const { recipientId } = await setupApprovedCampaign();
    await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'sent', provider: 'evolution',
      externalEventId: 'evt-s-01', occurredAt: new Date().toISOString(),
    });
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'failed', provider: 'evolution',
      externalEventId: 'evt-f-02', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('ok');
  });

  it('transiÃ§Ã£o ignorada: sent em destinatÃ¡rio jÃ¡ delivered', async () => {
    const { recipientId } = await setupApprovedCampaign();
    await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'delivered', provider: 'ev',
      externalEventId: 'evt-d-01', occurredAt: new Date().toISOString(),
    });
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'sent', provider: 'ev',
      externalEventId: 'evt-s-late', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('ignored');
  });

  it('transiÃ§Ã£o ignorada: delivered em destinatÃ¡rio failed', async () => {
    const { recipientId } = await setupApprovedCampaign();
    await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'failed', provider: 'ev',
      externalEventId: 'evt-f-01', occurredAt: new Date().toISOString(),
    });
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'delivered', provider: 'ev',
      externalEventId: 'evt-d-late', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('ignored');
  });

  it('evento duplicado (mesmo externalEventId) â†’ duplicate', async () => {
    const { recipientId } = await setupApprovedCampaign();
    await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'delivered', provider: 'ev',
      externalEventId: 'unique-dup-evt', occurredAt: new Date().toISOString(),
    });
    const result = await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'delivered', provider: 'ev',
      externalEventId: 'unique-dup-evt', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('duplicate');
  });

  it('recipientId inexistente â†’ not_found', async () => {
    const result = await processDispatchEvent(db, tenantId, {
      recipientId: randomUUID(), eventType: 'delivered', provider: 'ev',
      externalEventId: 'nf-evt', occurredAt: new Date().toISOString(),
    });
    expect(result.kind).toBe('not_found');
  });

  it('last_outbound_at sÃ³ avanÃ§a, nunca retrocede', async () => {
    // delivered(newer) â†’ read(older): last_outbound_at deve permanecer newer
    const { recipientId, contactId } = await setupApprovedCampaign();

    const older = new Date(Date.now() - 7200000).toISOString(); // 2h atrÃ¡s
    const newer = new Date(Date.now() - 1000).toISOString();    // quase agora

    await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'delivered', provider: 'ev',
      externalEventId: 'del-newer', occurredAt: newer,
    });
    // read com timestamp mais antigo que o delivered â€” CASE WHEN nÃ£o deve regredir
    await processDispatchEvent(db, tenantId, {
      recipientId, eventType: 'read', provider: 'ev',
      externalEventId: 'read-older', occurredAt: older,
    });

    const row = await db.query<{ last_outbound_at: Date | string }>(
      'SELECT last_outbound_at FROM contacts WHERE id = $1', [contactId],
    );
    const actual = new Date(row.rows[0]!.last_outbound_at).getTime();
    expect(actual).toBeGreaterThanOrEqual(new Date(newer).getTime());
  });
});

// â”€â”€â”€ SamJoE Food service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('SamJoE Food service â€” todos os tipos de evento', () => {
  beforeEach(async () => {
    await upsertSamJoeFoodConfig(db, tenantId, { hmacSecret: 'test-secret-32chars-ok', status: 'active' });
  });

  it('customer.created: cria contato e external_link quando nÃ£o existe', async () => {
    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-cust-1',
      event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-001', phone: '(11) 96000-0001', name: 'Maria Nova' },
    });
    expect(result.kind).toBe('ok');

    const link = await db.query(
      `SELECT contact_id FROM external_customer_links WHERE tenant_id = $1 AND external_customer_id = 'ext-001'`,
      [tenantId],
    );
    expect(link.rows).toHaveLength(1);

    const contact = await db.query<{ full_name: string; phone_e164: string; origin: string }>(
      'SELECT full_name, phone_e164, origin FROM contacts WHERE id = $1', [link.rows[0]!.contact_id],
    );
    expect(contact.rows[0]!.full_name).toBe('Maria Nova');
    expect(contact.rows[0]!.phone_e164).toBe('+5511960000001');
    expect(contact.rows[0]!.origin).toBe('samjoe_food');
  });

  it('customer.created: vincula a contato existente pelo telefone', async () => {
    const cid = await insertContact(db, tenantId, { phone_e164: '+5511960000002' });

    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-cust-2',
      event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-002', phone: '(11) 96000-0002' },
    });

    const link = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM external_customer_links WHERE external_customer_id = 'ext-002' AND tenant_id = $1`,
      [tenantId],
    );
    expect(link.rows[0]!.contact_id).toBe(cid);
  });

  it('customer.created: idempotente â€” segunda chamada nÃ£o cria duplicata', async () => {
    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-cust-3', event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-003', phone: '(11) 96000-0003' },
    });
    // Segunda chamada com mesmo external_id
    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-cust-3b', event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-003', phone: '(11) 96000-0003' },
    });
    expect(result.kind).toBe('ok');

    const links = await db.query(
      `SELECT id FROM external_customer_links WHERE external_customer_id = 'ext-003' AND tenant_id = $1`,
      [tenantId],
    );
    expect(links.rows).toHaveLength(1); // nÃ£o duplicou
  });

  it('customer.updated: vincula externo a contato existente via email', async () => {
    const cid = await insertContact(db, tenantId, { email: 'joao@teste.com', phone_e164: null });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-upd-1', event_type: 'customer.updated',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-upd-001', email: 'joao@teste.com' },
    });
    expect(result.kind).toBe('ok');

    const link = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM external_customer_links WHERE external_customer_id = 'ext-upd-001' AND tenant_id = $1`,
      [tenantId],
    );
    expect(link.rows[0]!.contact_id).toBe(cid);
  });

  it('order.created: aceito sem criar conversÃ£o', async () => {
    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-ord-create-1', event_type: 'order.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-c1' },
      order: { external_id: 'ord-c1', total_cents: 5000 },
    });
    expect(result.kind).toBe('ok');

    const convs = await db.query(
      `SELECT id FROM campaign_conversions WHERE tenant_id = $1`, [tenantId],
    );
    expect(convs.rows).toHaveLength(0);
  });

  it('order.paid: cria conversÃ£o com contact_id e last-touch attribution', async () => {
    // Setup: contato + campanha + entrega
    const cid = await insertContact(db, tenantId, { phone_e164: '+5511960000010' });
    await grantConsent(db, tenantId, cid);
    const camp = await fullCampaignSetup(db, tenantId, userId, { conversionWindowDays: 7 });
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);
    const jobs = await getDispatchJobs(db, tenantId, { campaignId: camp.id, force: true });
    await processDispatchEvent(db, tenantId, {
      recipientId: jobs[0]!.recipient_id, eventType: 'delivered', provider: 'ev',
      externalEventId: 'del-attr-01', occurredAt: new Date(Date.now() - 3600000).toISOString(),
    });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-paid-attr', event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-attr', phone: '(11) 96000-0010' },
      order: { external_id: 'ord-attr', total_cents: 12000, cost_cents: 4000 },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result as { campaign_id: string | null }).campaign_id).toBe(camp.id);

    const conv = await db.query<{ campaign_id: string; revenue_cents: number; margin_cents: number; contact_id: string }>(
      `SELECT campaign_id, revenue_cents, margin_cents, contact_id FROM campaign_conversions WHERE tenant_id = $1 AND source = 'samjoe_food'`,
      [tenantId],
    );
    expect(conv.rows[0]!.campaign_id).toBe(camp.id);
    expect(conv.rows[0]!.revenue_cents).toBe(12000);
    expect(conv.rows[0]!.margin_cents).toBe(8000);
    expect(conv.rows[0]!.contact_id).toBe(cid);
  });

  it('order.paid: sem contato conhecido cria conversÃ£o sem contact_id e sem attribution', async () => {
    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-paid-nocontact', event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-unknown-999' },
      order: { external_id: 'ord-unknown', total_cents: 3000 },
    });
    expect(result.kind).toBe('ok');

    const conv = await db.query<{ contact_id: string | null; campaign_id: string | null }>(
      `SELECT contact_id, campaign_id FROM campaign_conversions WHERE tenant_id = $1 AND source = 'samjoe_food'`,
      [tenantId],
    );
    expect(conv.rows[0]!.contact_id).toBeNull();
    expect(conv.rows[0]!.campaign_id).toBeNull();
  });

  it('order.paid: sem entrega dentro da janela â†’ campaign_id null (sem attribution)', async () => {
    const cid = await insertContact(db, tenantId, { phone_e164: '+5511960000020' });
    await grantConsent(db, tenantId, cid);
    const camp = await fullCampaignSetup(db, tenantId, userId, { conversionWindowDays: 1 }); // janela de 1 dia
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);
    const jobs = await getDispatchJobs(db, tenantId, { campaignId: camp.id, force: true });
    // Entrega hÃ¡ 2 dias â€” fora da janela de 1 dia
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    await processDispatchEvent(db, tenantId, {
      recipientId: jobs[0]!.recipient_id, eventType: 'delivered', provider: 'ev',
      externalEventId: 'del-outside-window', occurredAt: twoDaysAgo,
    });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-paid-nowindow', event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-nowindow', phone: '(11) 96000-0020' },
      order: { external_id: 'ord-nowindow', total_cents: 5000 },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result as { campaign_id: string | null }).campaign_id).toBeNull();
  });

  it('order.paid: duplicado â†’ duplicate', async () => {
    const payload = {
      event_id: 'e-dup-paid',
      event_type: 'order.paid' as const,
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-dup' },
      order: { external_id: 'ord-dup', total_cents: 1000 },
    };
    await processSamJoeFoodEvent(db, tenantId, payload);
    const second = await processSamJoeFoodEvent(db, tenantId, payload);
    expect(second.kind).toBe('duplicate');
  });

  it('order.cancelled: reverte conversÃ£o paid â†’ cancelled', async () => {
    const payPayload = {
      event_id: 'e-cancel-pay', event_type: 'order.paid' as const,
      occurred_at: new Date(Date.now() - 5000).toISOString(),
      customer: { external_id: 'ext-cancel' },
      order: { external_id: 'ord-cancel', total_cents: 7000 },
    };
    await processSamJoeFoodEvent(db, tenantId, payPayload);

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-cancel-act', event_type: 'order.cancelled',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-cancel' },
      order: { external_id: 'ord-cancel', total_cents: 0 },
    });
    expect(result.kind).toBe('ok');

    const conv = await db.query<{ status: string; revenue_cents: number }>(
      `SELECT status, revenue_cents FROM campaign_conversions WHERE external_order_id = 'ord-cancel' AND tenant_id = $1`,
      [tenantId],
    );
    expect(conv.rows[0]!.status).toBe('cancelled');
    expect(conv.rows[0]!.revenue_cents).toBe(0);
  });

  it('order.refunded: reverte conversÃ£o paid â†’ refunded', async () => {
    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-ref-pay', event_type: 'order.paid',
      occurred_at: new Date(Date.now() - 5000).toISOString(),
      customer: { external_id: 'ext-ref' },
      order: { external_id: 'ord-ref', total_cents: 9900 },
    });
    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-ref-act', event_type: 'order.refunded',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-ref' },
      order: { external_id: 'ord-ref', total_cents: 0 },
    });

    const conv = await db.query<{ status: string }>(
      `SELECT status FROM campaign_conversions WHERE external_order_id = 'ord-ref' AND tenant_id = $1`,
      [tenantId],
    );
    expect(conv.rows[0]!.status).toBe('refunded');
  });

  it('ambiguous: dois contatos com o mesmo email â†’ kind=ambiguous', async () => {
    // Dois contatos distintos com mesmo email mas phones diferentes (schema permite duplicar email)
    await insertContact(db, tenantId, { email: 'ambig@test.com', phone_e164: '+5511960000030' });
    await insertContact(db, tenantId, { email: 'ambig@test.com', phone_e164: '+5511960000031' });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-ambig', event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-ambig', email: 'ambig@test.com' },
    });
    expect(result.kind).toBe('ambiguous');
  });

  it('getSamJoeFoodConfig retorna null quando integraÃ§Ã£o nÃ£o configurada', async () => {
    const db2 = await createTestDatabase();
    const seeded2 = await seedTestTenant(db2);
    const config = await getSamJoeFoodConfig(db2, seeded2.tenantId);
    expect(config).toBeNull();
  });

  it('upsertSamJoeFoodConfig atualiza status de disabled para active', async () => {
    await upsertSamJoeFoodConfig(db, tenantId, { hmacSecret: 'secret-x', status: 'disabled' });
    let config = await getSamJoeFoodConfig(db, tenantId);
    expect(config?.status).toBe('disabled');

    await upsertSamJoeFoodConfig(db, tenantId, { status: 'active' });
    config = await getSamJoeFoodConfig(db, tenantId);
    expect(config?.status).toBe('active');
  });

  it('touchIntegration via event atualiza last_event_at', async () => {
    const eventTs = new Date().toISOString();
    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'e-touch', event_type: 'order.created',
      occurred_at: eventTs,
      customer: { external_id: 'ext-touch' },
    });
    const config = await getSamJoeFoodConfig(db, tenantId);
    expect(config?.last_event_at).toBeTruthy();
  });
});

// â”€â”€â”€ analytics service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Analytics service â€” agregaÃ§Ã£o', () => {
  it('retorna summary vazio quando nÃ£o hÃ¡ campanhas', async () => {
    const { campaigns, summary } = await getCampaignAnalytics(db, tenantId);
    expect(campaigns).toHaveLength(0);
    expect(summary.total_campaigns).toBe(0);
    expect(summary.total_recipients).toBe(0);
    expect(summary.total_revenue_cents).toBe(0);
  });

  it('conta corretamente: 2 elegÃ­veis, 1 excluÃ­do, 1 entregue', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid1 = await insertContact(db, tenantId, { phone_e164: '+5511977770001' });
    const cid2 = await insertContact(db, tenantId, { phone_e164: '+5511977770002' });
    const cidExcl = await insertContact(db, tenantId, { phone_e164: null });
    await grantConsent(db, tenantId, cid1);
    await grantConsent(db, tenantId, cid2);
    await grantConsent(db, tenantId, cidExcl);

    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);

    const jobs = await getDispatchJobs(db, tenantId, { campaignId: camp.id, force: true });
    await processDispatchEvent(db, tenantId, {
      recipientId: jobs[0]!.recipient_id, eventType: 'delivered',
      provider: 'ev', externalEventId: 'an-del-01', occurredAt: new Date().toISOString(),
    });

    const { campaigns, summary } = await getCampaignAnalytics(db, tenantId);
    const stat = campaigns.find((c) => c.id === camp.id);
    expect(stat).toBeTruthy();
    expect(stat!.recipients).toBe(2); // excluÃ­do nÃ£o entra no alcance (pending/queued/sent/delivered/read/failed)
    expect(stat!.delivered).toBe(1);
    expect(stat!.engaged).toBe(1);
    expect(stat!.conversions).toBe(0);

    expect(summary.total_campaigns).toBeGreaterThanOrEqual(1);
    expect(summary.total_engaged).toBe(1);
  });

  it('agrega conversÃµes e receita corretamente por campanha', async () => {
    const camp = await fullCampaignSetup(db, tenantId, userId);
    const cid = await insertContact(db, tenantId, { phone_e164: '+5511977770010' });
    await grantConsent(db, tenantId, cid);
    await generateCampaignPreflight(db, tenantId, camp.id);
    await approveCampaign(db, tenantId, camp.id, userId);
    const jobs = await getDispatchJobs(db, tenantId, { campaignId: camp.id, force: true });
    await processDispatchEvent(db, tenantId, {
      recipientId: jobs[0]!.recipient_id, eventType: 'read',
      provider: 'ev', externalEventId: 'an-read-01', occurredAt: new Date(Date.now() - 3600000).toISOString(),
    });

    await upsertSamJoeFoodConfig(db, tenantId, { hmacSecret: 'sec', status: 'active' });
    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'an-order-01', event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'ext-an-01', phone: '(11) 97777-0010' },
      order: { external_id: 'ord-an-01', total_cents: 15000, cost_cents: 5000 },
    });

    const { campaigns, summary } = await getCampaignAnalytics(db, tenantId);
    const stat = campaigns.find((c) => c.id === camp.id);
    expect(stat!.conversions).toBe(1);
    expect(stat!.revenue_cents).toBe(15000);
    expect(stat!.margin_cents).toBe(10000);

    expect(summary.total_conversions).toBe(1);
    expect(summary.total_revenue_cents).toBe(15000);
  });

  it('campanhas rascunho nÃ£o contam em total_campaigns', async () => {
    await fullCampaignSetup(db, tenantId, userId); // status=draft
    const { summary } = await getCampaignAnalytics(db, tenantId);
    expect(summary.total_campaigns).toBe(0);
  });

  it('isolamento de tenant: analytics nÃ£o vaza para outro tenant', async () => {
    const db2 = await createTestDatabase();
    const seeded2 = await seedTestTenant(db2);
    const camp2 = await fullCampaignSetup(db2, seeded2.tenantId, seeded2.userId);
    const cid2 = await insertContact(db2, seeded2.tenantId);
    await grantConsent(db2, seeded2.tenantId, cid2);
    await generateCampaignPreflight(db2, seeded2.tenantId, camp2.id);
    await approveCampaign(db2, seeded2.tenantId, camp2.id, seeded2.userId);

    // No banco original do tenant 1 nÃ£o deve aparecer nada do tenant 2
    const { campaigns } = await getCampaignAnalytics(db, tenantId);
    expect(campaigns.every((c) => c.id !== camp2.id)).toBe(true);
  });
});

