import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';

export type CampaignAssetInput = {
  type: 'image' | 'video';
  url: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
};

export type AudienceRules = {
  stages?: string[];
  origins?: string[];
  tagsAny?: string[];
};

export type CampaignInput = {
  name: string;
  objective?: string;
  messageText: string;
  linkUrl?: string;
  dispatchMode?: 'standard' | 'single';
  minIntervalHours?: number;
  maxNotificationsPer30d?: number;
  includeConverted?: boolean;
  conversionWindowDays?: number;
  audienceRules?: AudienceRules;
  assets?: CampaignAssetInput[];
};

type ContactCandidate = {
  id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  origin: string;
  stage: string;
  tags_json: unknown;
  do_not_contact: boolean;
  last_outbound_at: Date | string | null;
  next_eligible_at: Date | string | null;
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  audience_rules_json: AudienceRules | string;
  dispatch_mode: 'standard' | 'single';
  min_interval_hours: number;
  max_notifications_per_30d: number;
  include_converted: boolean;
};

type ConsentRow = { contact_id: string; action: 'granted' | 'revoked'; occurred_at: Date | string };
type DeliveryRow = { contact_id: string; delivered_at: Date | string | null; read_at: Date | string | null };
type ConversionRow = { contact_id: string; revenue_cents: string | number; margin_cents: string | number | null };

const parseJson = <T>(value: T | string, fallback: T): T => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export async function createCampaign(db: Database, tenantId: string, userId: string, input: CampaignInput) {
  const isSingle = input.dispatchMode === 'single';
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO campaigns
      (id, tenant_id, name, objective, message_text, link_url, dispatch_mode,
       audience_rules_json, min_interval_hours, max_notifications_per_30d,
       include_converted, conversion_window_days, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
     RETURNING id, name, objective, message_text, link_url, status, dispatch_mode,
               audience_rules_json, min_interval_hours, max_notifications_per_30d,
               include_converted, conversion_window_days, created_at, updated_at`,
    [
      id, tenantId, input.name.trim(), input.objective?.trim() ?? null,
      input.messageText.trim(), input.linkUrl?.trim() ?? null,
      isSingle ? 'single' : 'standard',
      JSON.stringify(input.audienceRules ?? {}),
      isSingle ? 0 : (input.minIntervalHours ?? 168),
      isSingle ? 1 : (input.maxNotificationsPer30d ?? 4),
      input.includeConverted ?? true,
      input.conversionWindowDays ?? 7, userId,
    ],
  );

  for (const asset of input.assets ?? []) {
    await db.query(
      `INSERT INTO campaign_assets
        (id, tenant_id, campaign_id, asset_type, url, mime_type, file_name, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), tenantId, id, asset.type, asset.url, asset.mimeType ?? null, asset.fileName ?? null, asset.sizeBytes ?? null],
    );
  }
  return result.rows[0];
}

export async function listCampaigns(db: Database, tenantId: string) {
  const result = await db.query(
    `SELECT c.id, c.name, c.objective, c.message_text, c.link_url, c.status,
            c.audience_rules_json, c.min_interval_hours, c.max_notifications_per_30d,
            c.include_converted, c.conversion_window_days, c.snapshot_hash,
            c.snapshot_created_at, c.created_at, c.updated_at,
            (SELECT count(*) FROM campaign_assets a WHERE a.campaign_id = c.id AND a.tenant_id = c.tenant_id)::int AS asset_count,
            (SELECT count(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.tenant_id = c.tenant_id AND r.eligible = true)::int AS eligible_count
       FROM campaigns c
      WHERE c.tenant_id = $1
      ORDER BY c.created_at DESC`,
    [tenantId],
  );
  return { rows: result.rows, rowCount: result.rowCount };
}

export async function getCampaign(db: Database, tenantId: string, campaignId: string) {
  const campaign = await db.query<CampaignRow & Record<string, unknown>>(
    'SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2',
    [campaignId, tenantId],
  );
  if (!campaign.rows[0]) return null;
  const assets = await db.query(
    `SELECT id, asset_type, url, mime_type, file_name, size_bytes, created_at
       FROM campaign_assets WHERE campaign_id = $1 AND tenant_id = $2 ORDER BY created_at`,
    [campaignId, tenantId],
  );
  return { ...campaign.rows[0], assets: assets.rows };
}

function evaluateCandidate(
  contact: ContactCandidate,
  campaign: CampaignRow,
  consent: ConsentRow | undefined,
  deliveries: DeliveryRow[],
  conversions: ConversionRow[],
  now: Date,
) {
  const reasons: string[] = [];
  const rules = parseJson<AudienceRules>(campaign.audience_rules_json, {});
  const tags = parseJson<string[]>(contact.tags_json as string[] | string, []);
  const validPhone = /^\+55\d{10,11}$/.test(contact.phone_e164 ?? '');
  if (!validPhone) reasons.push('invalid_phone');
  if (contact.do_not_contact) reasons.push('do_not_contact');
  if (contact.stage === 'blocked') reasons.push('blocked');
  if (!consent || consent.action !== 'granted') reasons.push('marketing_consent_missing');

  if (campaign.dispatch_mode !== 'single') {
    const nextEligible = contact.next_eligible_at ? new Date(contact.next_eligible_at) : null;
    if (nextEligible && nextEligible > now) reasons.push('cooldown');
    if (contact.last_outbound_at) {
      const campaignEligibleAt = new Date(new Date(contact.last_outbound_at).getTime() + campaign.min_interval_hours * 3600000);
      if (campaignEligibleAt > now && !reasons.includes('cooldown')) reasons.push('cooldown');
    }
    const cutoff = new Date(now.getTime() - 30 * 86400000);
    const deliveriesIn30Days = deliveries.filter((delivery) => {
      const occurredAt = delivery.read_at ?? delivery.delivered_at;
      return occurredAt && new Date(occurredAt) >= cutoff;
    }).length;
    if (deliveriesIn30Days >= campaign.max_notifications_per_30d) reasons.push('frequency_cap');
  }
  if (rules.stages?.length && !rules.stages.includes(contact.stage)) reasons.push('stage_not_selected');
  if (rules.origins?.length && !rules.origins.includes(contact.origin)) reasons.push('origin_not_selected');
  if (rules.tagsAny?.length && !rules.tagsAny.some((tag) => tags.includes(tag))) reasons.push('tag_not_selected');
  if (!campaign.include_converted && conversions.length > 0) reasons.push('already_converted');

  return {
    eligible: reasons.length === 0,
    reasons,
    priorDeliveryCount: deliveries.length,
    priorConversionCount: conversions.length,
    priorRevenueCents: conversions.reduce((sum, item) => sum + Number(item.revenue_cents), 0),
    priorMarginCents: conversions.some((item) => item.margin_cents == null)
      ? null
      : conversions.reduce((sum, item) => sum + Number(item.margin_cents), 0),
  };
}

export async function generateCampaignPreflight(db: Database, tenantId: string, campaignId: string) {
  const campaignResult = await db.query<CampaignRow>(
    `SELECT id, name, status, audience_rules_json, dispatch_mode,
            min_interval_hours, max_notifications_per_30d, include_converted
       FROM campaigns WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) return { kind: 'not_found' as const };
  if (!['draft', 'preflight_ready'].includes(campaign.status)) return { kind: 'invalid_status' as const, status: campaign.status };

  // Campanha de disparo único: bloqueia novo preflight se já existe qualquer envio real.
  if (campaign.dispatch_mode === 'single') {
    const sent = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM campaign_recipients
        WHERE campaign_id = $1 AND tenant_id = $2
          AND delivery_status IN ('sent', 'delivered', 'read')`,
      [campaignId, tenantId],
    );
    if (Number(sent.rows[0]?.count ?? 0) > 0) {
      return { kind: 'already_dispatched' as const };
    }
  }

  const [contactsResult, consentResult, deliveryResult, conversionResult, integrationResult] = await Promise.all([
    db.query<ContactCandidate>(
      `SELECT id, full_name, phone_e164, email, origin, stage, tags_json,
              do_not_contact, last_outbound_at, next_eligible_at
         FROM contacts WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    ),

    db.query<ConsentRow>(
      `SELECT contact_id, action, occurred_at FROM consent_events
        WHERE tenant_id = $1 AND channel = 'whatsapp' AND purpose = 'marketing'
        ORDER BY occurred_at DESC, created_at DESC`,
      [tenantId],
    ),
    db.query<DeliveryRow>(
      `SELECT contact_id, delivered_at, read_at FROM campaign_recipients
        WHERE tenant_id = $1 AND campaign_id <> $2
          AND (delivered_at IS NOT NULL OR read_at IS NOT NULL)`,
      [tenantId, campaignId],
    ),
    db.query<ConversionRow>(
      `SELECT contact_id, revenue_cents, margin_cents FROM campaign_conversions
        WHERE tenant_id = $1 AND status = 'paid' AND contact_id IS NOT NULL`,
      [tenantId],
    ),
    db.query<{ active: boolean }>(
      `SELECT true AS active FROM integration_connections
        WHERE tenant_id = $1 AND integration_type = 'samjoe_food' AND status = 'active' LIMIT 1`,
      [tenantId],
    ),
  ]);

  const latestConsent = new Map<string, ConsentRow>();
  for (const row of consentResult.rows) if (!latestConsent.has(row.contact_id)) latestConsent.set(row.contact_id, row);
  const deliveriesByContact = new Map<string, DeliveryRow[]>();
  for (const row of deliveryResult.rows) deliveriesByContact.set(row.contact_id, [...(deliveriesByContact.get(row.contact_id) ?? []), row]);
  const conversionsByContact = new Map<string, ConversionRow[]>();
  for (const row of conversionResult.rows) conversionsByContact.set(row.contact_id, [...(conversionsByContact.get(row.contact_id) ?? []), row]);

  const now = new Date();
  const evaluated = contactsResult.rows.map((contact) => ({
    contact,
    result: evaluateCandidate(
      contact, campaign, latestConsent.get(contact.id),
      deliveriesByContact.get(contact.id) ?? [], conversionsByContact.get(contact.id) ?? [], now,
    ),
  }));

  await db.query('DELETE FROM campaign_recipients WHERE campaign_id = $1 AND tenant_id = $2', [campaignId, tenantId]);
  if (evaluated.length > 0) {
    await db.query(
      `INSERT INTO campaign_recipients
        (id, tenant_id, campaign_id, contact_id, eligible, exclusion_reasons_json,
         prior_delivery_count, prior_conversion_count, prior_revenue_cents,
         prior_margin_cents, snapshot_created_at)
       SELECT unnest($1::uuid[]), $2, $3, unnest($4::uuid[]), unnest($5::boolean[]),
              unnest($6::jsonb[]), unnest($7::int[]), unnest($8::int[]),
              unnest($9::numeric[]), unnest($10::numeric[]), $11`,
      [
        evaluated.map(() => randomUUID()),
        tenantId, campaignId,
        evaluated.map((i) => i.contact.id),
        evaluated.map((i) => i.result.eligible),
        evaluated.map((i) => JSON.stringify(i.result.reasons)),
        evaluated.map((i) => i.result.priorDeliveryCount),
        evaluated.map((i) => i.result.priorConversionCount),
        evaluated.map((i) => i.result.priorRevenueCents),
        evaluated.map((i) => i.result.priorMarginCents),
        now.toISOString(),
      ],
    );
  }

  const snapshotHash = createHash('sha256').update(JSON.stringify({
    campaignId,
    recipients: evaluated.map(({ contact, result }) => ({ id: contact.id, ...result })),
  })).digest('hex');
  await db.query(
    `UPDATE campaigns SET status = 'preflight_ready', snapshot_hash = $1,
            snapshot_created_at = $2, updated_at = now()
      WHERE id = $3 AND tenant_id = $4`,
    [snapshotHash, now.toISOString(), campaignId, tenantId],
  );

  return {
    kind: 'ok' as const,
    report: buildPreflightReport(campaignId, snapshotHash, now, evaluated, Boolean(integrationResult.rows[0]?.active)),
  };
}

function buildPreflightReport(
  campaignId: string,
  snapshotHash: string,
  createdAt: Date,
  evaluated: Array<{ contact: ContactCandidate; result: ReturnType<typeof evaluateCandidate> }>,
  conversionIntegrationActive: boolean,
) {
  const eligible = evaluated.filter((item) => item.result.eligible);
  const excludedByReason: Record<string, number> = {};
  for (const item of evaluated) for (const reason of item.result.reasons) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  const exposure = (predicate: (count: number) => boolean) => eligible.filter((item) => predicate(item.result.priorDeliveryCount));
  const band = (items: typeof eligible) => ({
    contacts: items.length,
    converted: items.filter((item) => item.result.priorConversionCount > 0).length,
    revenue_cents: items.reduce((sum, item) => sum + item.result.priorRevenueCents, 0),
    margin_cents: items.some((item) => item.result.priorMarginCents == null)
      ? null
      : items.reduce((sum, item) => sum + Number(item.result.priorMarginCents), 0),
  });
  return {
    campaign_id: campaignId,
    snapshot_hash: snapshotHash,
    snapshot_created_at: createdAt.toISOString(),
    conversion_data: conversionIntegrationActive ? 'available' : 'not_configured',
    totals: { evaluated: evaluated.length, eligible: eligible.length, excluded: evaluated.length - eligible.length },
    excluded_by_reason: excludedByReason,
    exposure_bands: {
      never_received: band(exposure((count) => count === 0)),
      received_once: band(exposure((count) => count === 1)),
      received_twice: band(exposure((count) => count === 2)),
      received_more_than_twice: band(exposure((count) => count >= 3)),
      received_more_than_twice_without_conversion: band(eligible.filter((item) => item.result.priorDeliveryCount >= 3 && item.result.priorConversionCount === 0)),
    },
    recipients: evaluated.map(({ contact, result }) => ({
      contact_id: contact.id,
      full_name: contact.full_name,
      phone_e164: contact.phone_e164,
      stage: contact.stage,
      origin: contact.origin,
      eligible: result.eligible,
      exclusion_reasons: result.reasons,
      prior_delivery_count: result.priorDeliveryCount,
      prior_conversion_count: result.priorConversionCount,
      prior_revenue_cents: result.priorRevenueCents,
      prior_margin_cents: result.priorMarginCents,
    })),
  };
}

export async function approveCampaign(db: Database, tenantId: string, campaignId: string, userId: string) {
  const check = await db.query<{ status: string; snapshot_hash: string | null }>(
    'SELECT status, snapshot_hash FROM campaigns WHERE id = $1 AND tenant_id = $2',
    [campaignId, tenantId],
  );
  const campaign = check.rows[0];
  if (!campaign) return { kind: 'not_found' as const };
  if (campaign.status !== 'preflight_ready') return { kind: 'invalid_status' as const, status: campaign.status };
  if (!campaign.snapshot_hash) return { kind: 'no_snapshot' as const };

  const now = new Date();
  await db.query(
    `UPDATE campaigns SET status = 'approved', approved_by = $1, approved_at = $2, updated_at = now()
     WHERE id = $3 AND tenant_id = $4`,
    [userId, now.toISOString(), campaignId, tenantId],
  );

  const eligible = await db.query<{ id: string; contact_id: string }>(
    `UPDATE campaign_recipients SET delivery_status = 'queued', queued_at = $1
     WHERE campaign_id = $2 AND tenant_id = $3 AND eligible = true AND delivery_status = 'pending'
     RETURNING id, contact_id`,
    [now.toISOString(), campaignId, tenantId],
  );
  if (eligible.rows.length > 0) {
    await db.query(
      `INSERT INTO notification_events
        (id, tenant_id, campaign_id, campaign_recipient_id, contact_id, event_type, occurred_at)
       SELECT unnest($1::uuid[]), $2, $3, unnest($4::uuid[]), unnest($5::uuid[]), 'queued', $6`,
      [
        eligible.rows.map(() => randomUUID()),
        tenantId, campaignId,
        eligible.rows.map((r) => r.id),
        eligible.rows.map((r) => r.contact_id),
        now.toISOString(),
      ],
    );
  }
  return { kind: 'ok' as const, queued: eligible.rows.length, snapshot_hash: campaign.snapshot_hash };
}

export async function cancelCampaign(db: Database, tenantId: string, campaignId: string) {
  const check = await db.query<{ status: string }>(
    'SELECT status FROM campaigns WHERE id = $1 AND tenant_id = $2',
    [campaignId, tenantId],
  );
  const campaign = check.rows[0];
  if (!campaign) return { kind: 'not_found' as const };
  if (['completed', 'cancelled'].includes(campaign.status)) {
    return { kind: 'invalid_status' as const, status: campaign.status };
  }

  const now = new Date();
  await db.query(
    `UPDATE campaigns SET status = 'cancelled', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  );

  const cancelled = await db.query<{ id: string; contact_id: string }>(
    `UPDATE campaign_recipients SET delivery_status = 'cancelled'
     WHERE campaign_id = $1 AND tenant_id = $2 AND delivery_status IN ('pending', 'queued')
     RETURNING id, contact_id`,
    [campaignId, tenantId],
  );
  if (cancelled.rows.length > 0) {
    await db.query(
      `INSERT INTO notification_events
        (id, tenant_id, campaign_id, campaign_recipient_id, contact_id, event_type, occurred_at)
       SELECT unnest($1::uuid[]), $2, $3, unnest($4::uuid[]), unnest($5::uuid[]), 'cancelled', $6`,
      [
        cancelled.rows.map(() => randomUUID()),
        tenantId, campaignId,
        cancelled.rows.map((r) => r.id),
        cancelled.rows.map((r) => r.contact_id),
        now.toISOString(),
      ],
    );
  }
  return { kind: 'ok' as const, cancelled: cancelled.rows.length };
}

export async function updateCampaign(db: Database, tenantId: string, campaignId: string, input: Partial<CampaignInput>) {
  const check = await db.query<{ status: string }>(
    'SELECT status FROM campaigns WHERE id = $1 AND tenant_id = $2',
    [campaignId, tenantId],
  );
  const existing = check.rows[0];
  if (!existing) return null;
  if (!['draft', 'preflight_ready'].includes(existing.status)) {
    return { locked: true as const, status: existing.status };
  }

  const params: unknown[] = [];
  const setParts: string[] = [];
  const p = (val: unknown) => { params.push(val); return `$${params.length}`; };

  if (input.name !== undefined) setParts.push(`name = ${p(input.name.trim())}`);
  if (input.objective !== undefined) setParts.push(`objective = ${p(input.objective?.trim() ?? null)}`);
  if (input.messageText !== undefined) setParts.push(`message_text = ${p(input.messageText.trim())}`);
  if (input.linkUrl !== undefined) setParts.push(`link_url = ${p(input.linkUrl?.trim() ?? null)}`);
  if (input.dispatchMode !== undefined) setParts.push(`dispatch_mode = ${p(input.dispatchMode)}`);
  if (input.minIntervalHours !== undefined) setParts.push(`min_interval_hours = ${p(input.minIntervalHours)}`);
  if (input.maxNotificationsPer30d !== undefined) setParts.push(`max_notifications_per_30d = ${p(input.maxNotificationsPer30d)}`);
  if (input.includeConverted !== undefined) setParts.push(`include_converted = ${p(input.includeConverted)}`);
  if (input.conversionWindowDays !== undefined) setParts.push(`conversion_window_days = ${p(input.conversionWindowDays)}`);
  if (input.audienceRules !== undefined) setParts.push(`audience_rules_json = ${p(JSON.stringify(input.audienceRules))}::jsonb`);

  if (setParts.length === 0) {
    const row = await getCampaign(db, tenantId, campaignId);
    return row ? { locked: false as const, campaign: row } : null;
  }

  setParts.push("status = 'draft'", 'snapshot_hash = NULL', 'snapshot_created_at = NULL', 'updated_at = now()');
  const result = await db.query(
    `UPDATE campaigns SET ${setParts.join(', ')} WHERE id = ${p(campaignId)} AND tenant_id = ${p(tenantId)}
     RETURNING id, name, objective, message_text, link_url, status, audience_rules_json,
               min_interval_hours, max_notifications_per_30d, include_converted,
               conversion_window_days, snapshot_hash, snapshot_created_at, created_at, updated_at`,
    params,
  );
  return result.rows[0] ? { locked: false as const, campaign: result.rows[0] } : null;
}

export async function getCampaignPreflight(db: Database, tenantId: string, campaignId: string) {
  const campaignResult = await db.query<{ snapshot_hash: string | null; snapshot_created_at: Date | string | null }>(
    'SELECT snapshot_hash, snapshot_created_at FROM campaigns WHERE id = $1 AND tenant_id = $2',
    [campaignId, tenantId],
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) return null;
  if (!campaign.snapshot_hash || !campaign.snapshot_created_at) return { ready: false };
  const [recipients, integration] = await Promise.all([
    db.query<{
      contact_id: string; full_name: string; phone_e164: string | null; stage: string; origin: string;
      eligible: boolean; exclusion_reasons_json: string[] | string; prior_delivery_count: number;
      prior_conversion_count: number; prior_revenue_cents: string | number; prior_margin_cents: string | number | null;
    }>(
      `SELECT r.contact_id, c.full_name, c.phone_e164, c.stage, c.origin,
              r.eligible, r.exclusion_reasons_json, r.prior_delivery_count,
              r.prior_conversion_count, r.prior_revenue_cents, r.prior_margin_cents
         FROM campaign_recipients r
         JOIN contacts c ON c.id = r.contact_id AND c.tenant_id = r.tenant_id
        WHERE r.campaign_id = $1 AND r.tenant_id = $2
        ORDER BY c.full_name`,
      [campaignId, tenantId],
    ),
    db.query<{ active: boolean }>(
      `SELECT true AS active FROM integration_connections
        WHERE tenant_id = $1 AND integration_type = 'samjoe_food' AND status = 'active' LIMIT 1`,
      [tenantId],
    ),
  ]);
  const evaluated = recipients.rows.map((row) => ({
    contact: { id: row.contact_id, full_name: row.full_name, phone_e164: row.phone_e164, email: null, origin: row.origin, stage: row.stage, tags_json: [], do_not_contact: false, last_outbound_at: null, next_eligible_at: null },
    result: {
      eligible: row.eligible,
      reasons: parseJson<string[]>(row.exclusion_reasons_json, []),
      priorDeliveryCount: row.prior_delivery_count,
      priorConversionCount: row.prior_conversion_count,
      priorRevenueCents: Number(row.prior_revenue_cents),
      priorMarginCents: row.prior_margin_cents == null ? null : Number(row.prior_margin_cents),
    },
  }));
  return {
    ready: true,
    ...buildPreflightReport(campaignId, campaign.snapshot_hash, new Date(campaign.snapshot_created_at), evaluated, Boolean(integration.rows[0]?.active)),
  };
}
