import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';
import { normalizeBrazilianPhone } from '../domain/phone.js';

export type FoodAppCustomer = {
  external_id: string;
  phone?: string;
  email?: string;
  name?: string;
};

export type FoodAppOrder = {
  external_id: string;
  total_cents: number;
  cost_cents?: number;
};

export type FoodAppEventPayload = {
  event_id: string;
  event_type:
    | 'customer.created' | 'customer.updated' | 'order.created'
    | 'order.paid' | 'order.cancelled' | 'order.refunded';
  occurred_at: string;
  customer: FoodAppCustomer;
  order?: FoodAppOrder;
};

type IntegrationRow = {
  id: string;
  status: string;
  settings_json: { hmac_secret?: string } | string;
  last_event_at: Date | string | null;
  updated_at: Date | string;
};

export async function getFoodAppConfig(db: Database, tenantId: string) {
  const result = await db.query<IntegrationRow>(
    `SELECT id, status, last_event_at, updated_at
       FROM integration_connections WHERE tenant_id = $1 AND integration_type = 'foodapp'`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

export async function getFoodAppSecret(db: Database, tenantId: string): Promise<string | null> {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM integration_connections
      WHERE tenant_id = $1 AND integration_type = 'foodapp' AND status = 'active'`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const settings = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : row.settings_json;
  return typeof settings.hmac_secret === 'string' ? settings.hmac_secret : null;
}

export async function upsertFoodAppConfig(
  db: Database, tenantId: string,
  input: { hmacSecret?: string; status: 'active' | 'disabled' },
) {
  const existing = await db.query<{ id: string; settings_json: Record<string, unknown> | string }>(
    `SELECT id, settings_json FROM integration_connections WHERE tenant_id = $1 AND integration_type = 'foodapp'`,
    [tenantId],
  );

  if (existing.rows[0]) {
    const current = typeof existing.rows[0].settings_json === 'string'
      ? JSON.parse(existing.rows[0].settings_json) as Record<string, unknown>
      : existing.rows[0].settings_json;
    const merged = { ...current, ...(input.hmacSecret ? { hmac_secret: input.hmacSecret } : {}) };
    await db.query(
      `UPDATE integration_connections SET status = $1, settings_json = $2::jsonb, updated_at = now()
       WHERE id = $3`,
      [input.status, JSON.stringify(merged), existing.rows[0].id],
    );
  } else {
    await db.query(
      `INSERT INTO integration_connections
        (id, tenant_id, integration_type, status, settings_json)
       VALUES ($1, $2, 'foodapp', $3, $4::jsonb)`,
      [randomUUID(), tenantId, input.status, JSON.stringify(input.hmacSecret ? { hmac_secret: input.hmacSecret } : {})],
    );
  }

  return getFoodAppConfig(db, tenantId);
}

async function resolveContact(db: Database, tenantId: string, customer: FoodAppCustomer) {
  if (customer.external_id) {
    const link = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM external_customer_links
       WHERE tenant_id = $1 AND source = 'foodapp' AND external_customer_id = $2`,
      [tenantId, customer.external_id],
    );
    if (link.rows[0]) return { contactId: link.rows[0].contact_id, ambiguous: false };
  }

  if (customer.phone) {
    let phone: string | null = null;
    try { phone = normalizeBrazilianPhone(customer.phone); } catch { /* ignore */ }
    if (phone) {
      const contacts = await db.query<{ id: string }>(
        'SELECT id FROM contacts WHERE tenant_id = $1 AND phone_e164 = $2',
        [tenantId, phone],
      );
      if (contacts.rows.length === 1) return { contactId: contacts.rows[0].id, ambiguous: false };
      if (contacts.rows.length > 1) return { contactId: null, ambiguous: true };
    }
  }

  if (customer.email) {
    const contacts = await db.query<{ id: string }>(
      'SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2',
      [tenantId, customer.email.toLowerCase()],
    );
    if (contacts.rows.length === 1) return { contactId: contacts.rows[0].id, ambiguous: false };
    if (contacts.rows.length > 1) return { contactId: null, ambiguous: true };
  }

  return { contactId: null, ambiguous: false };
}

async function ensureExternalLink(db: Database, tenantId: string, contactId: string, externalId: string) {
  try {
    await db.query(
      `INSERT INTO external_customer_links (id, tenant_id, contact_id, source, external_customer_id)
       VALUES ($1, $2, $3, 'foodapp', $4)`,
      [randomUUID(), tenantId, contactId, externalId],
    );
  } catch (err) {
    const pgErr = err as Error & { code?: string };
    if (pgErr.code !== '23505') throw err;
  }
}

async function createContactFromFoodApp(db: Database, tenantId: string, customer: FoodAppCustomer) {
  let phone: string | null = null;
  try { if (customer.phone) phone = normalizeBrazilianPhone(customer.phone); } catch { /* ignore */ }
  const id = randomUUID();
  const result = await db.query<{ id: string }>(
    `INSERT INTO contacts (id, tenant_id, full_name, phone_e164, email, origin, stage)
     VALUES ($1, $2, $3, $4, $5, 'foodapp', 'prospect') RETURNING id`,
    [id, tenantId, customer.name?.trim() || 'Cliente FoodApp', phone, customer.email?.toLowerCase() ?? null],
  );
  return result.rows[0];
}

async function findLastTouchCampaign(
  db: Database, tenantId: string, contactId: string, occurredAt: string,
): Promise<string | null> {
  const result = await db.query<{
    campaign_id: string; delivered_at: Date | string | null; read_at: Date | string | null; conversion_window_days: number;
  }>(
    `SELECT r.campaign_id, r.delivered_at, r.read_at, camp.conversion_window_days
       FROM campaign_recipients r
       JOIN campaigns camp ON camp.id = r.campaign_id AND camp.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.contact_id = $2 AND r.delivery_status IN ('delivered', 'read')`,
    [tenantId, contactId],
  );

  const now = new Date(occurredAt).getTime();
  const sorted = result.rows
    .map((r) => ({ ...r, touchMs: new Date(r.read_at ?? r.delivered_at ?? 0).getTime() }))
    .sort((a, b) => b.touchMs - a.touchMs);

  for (const r of sorted) {
    if (now - r.touchMs <= r.conversion_window_days * 86_400_000) return r.campaign_id;
  }
  return null;
}

export async function processFoodAppEvent(db: Database, tenantId: string, event: FoodAppEventPayload) {
  const { event_type, event_id, occurred_at, customer, order } = event;

  const { contactId, ambiguous } = await resolveContact(db, tenantId, customer);
  if (ambiguous) return { kind: 'ambiguous' as const, event_type };

  if (event_type === 'customer.created') {
    let id = contactId;
    if (!id) {
      const created = await createContactFromFoodApp(db, tenantId, customer);
      id = created?.id ?? null;
    }
    if (id) await ensureExternalLink(db, tenantId, id, customer.external_id);
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: id };
  }

  if (event_type === 'customer.updated') {
    if (contactId) await ensureExternalLink(db, tenantId, contactId, customer.external_id);
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: contactId };
  }

  if (event_type === 'order.created') {
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: contactId };
  }

  if (event_type === 'order.paid' && order) {
    if (contactId) await ensureExternalLink(db, tenantId, contactId, customer.external_id);
    const campaignId = contactId ? await findLastTouchCampaign(db, tenantId, contactId, occurred_at) : null;
    try {
      await db.query(
        `INSERT INTO campaign_conversions
          (id, tenant_id, contact_id, campaign_id, source, external_event_id, external_order_id,
           status, revenue_cents, cost_cents, margin_cents, occurred_at, metadata_json)
         VALUES ($1, $2, $3, $4, 'foodapp', $5, $6, 'paid', $7, $8, $9, $10, $11::jsonb)`,
        [
          randomUUID(), tenantId, contactId, campaignId, event_id, order.external_id,
          order.total_cents, order.cost_cents ?? null,
          order.cost_cents != null ? order.total_cents - order.cost_cents : null,
          occurred_at, JSON.stringify({ customer_external_id: customer.external_id }),
        ],
      );
    } catch (err) {
      const pgErr = err as Error & { code?: string };
      if (pgErr.code === '23505') return { kind: 'duplicate' as const, event_type };
      throw err;
    }
    if (contactId) {
      await db.query(
        `UPDATE contacts SET last_purchase_at = $1, updated_at = now()
         WHERE id = $2 AND tenant_id = $3 AND (last_purchase_at IS NULL OR last_purchase_at < $1)`,
        [occurred_at, contactId, tenantId],
      );
    }
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: contactId, campaign_id: campaignId };
  }

  if ((event_type === 'order.cancelled' || event_type === 'order.refunded') && order) {
    const newStatus = event_type === 'order.cancelled' ? 'cancelled' : 'refunded';
    await db.query(
      `UPDATE campaign_conversions
          SET status = $1, revenue_cents = 0, margin_cents = 0
        WHERE tenant_id = $2 AND source = 'foodapp' AND external_order_id = $3 AND status = 'paid'`,
      [newStatus, tenantId, order.external_id],
    );
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type };
  }

  await touchIntegration(db, tenantId, occurred_at);
  return { kind: 'ok' as const, event_type, contact_id: contactId };
}

async function touchIntegration(db: Database, tenantId: string, occurredAt: string) {
  await db.query(
    `UPDATE integration_connections SET last_event_at = $1, updated_at = now()
     WHERE tenant_id = $2 AND integration_type = 'foodapp'`,
    [occurredAt, tenantId],
  );
}
