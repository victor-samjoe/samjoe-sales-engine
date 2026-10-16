import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';
import { normalizeBrazilianPhone } from '../domain/phone.js';
import { recordConsents } from './consent-service.js';
import { sendOrderAlertToOwners, sendOrderStatusWhatsApp } from './wa-notify.js';

export type SamJoeFoodCustomer = {
  external_id: string;
  phone?: string;
  email?: string;
  name?: string;
};

export type SamJoeFoodOrderItem = {
  external_product_id?: string;
  name?: string;
  category?: string;
  quantity?: number;
  unit_price_cents?: number;
};

export type SamJoeFoodOrder = {
  external_id: string;
  total_cents: number;
  cost_cents?: number;
  ref?: string;
  fulfillment?: string;
  delivery_address?: string;
  items?: SamJoeFoodOrderItem[];
};

export type SamJoeFoodEventPayload = {
  event_id: string;
  event_type:
    | 'customer.created' | 'customer.updated' | 'order.created'
    | 'order.paid' | 'order.cancelled' | 'order.refunded'
    | 'order.status_changed';
  occurred_at: string;
  customer: SamJoeFoodCustomer;
  order?: SamJoeFoodOrder & { from_status?: string; to_status?: string };
};

type IntegrationRow = {
  id: string;
  status: string;
  settings_json: { hmac_secret?: string } | string;
  last_event_at: Date | string | null;
  updated_at: Date | string;
};

export async function getSamJoeFoodConfig(db: Database, tenantId: string) {
  const result = await db.query<IntegrationRow>(
    `SELECT id, status, last_event_at, updated_at
       FROM integration_connections WHERE tenant_id = $1 AND integration_type = 'samjoe_food'`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

export async function getSamJoeFoodSecret(db: Database, tenantId: string): Promise<string | null> {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM integration_connections
      WHERE tenant_id = $1 AND integration_type = 'samjoe_food' AND status = 'active'`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const settings = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : row.settings_json;
  return typeof settings.hmac_secret === 'string' ? settings.hmac_secret : null;
}

export async function upsertSamJoeFoodConfig(
  db: Database, tenantId: string,
  input: { hmacSecret?: string; status: 'active' | 'disabled' },
) {
  const existing = await db.query<{ id: string; settings_json: Record<string, unknown> | string }>(
    `SELECT id, settings_json FROM integration_connections WHERE tenant_id = $1 AND integration_type = 'samjoe_food'`,
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
       VALUES ($1, $2, 'samjoe_food', $3, $4::jsonb)`,
      [randomUUID(), tenantId, input.status, JSON.stringify(input.hmacSecret ? { hmac_secret: input.hmacSecret } : {})],
    );
  }

  return getSamJoeFoodConfig(db, tenantId);
}

async function resolveContact(db: Database, tenantId: string, customer: SamJoeFoodCustomer) {
  if (customer.external_id) {
    const link = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM external_customer_links
       WHERE tenant_id = $1 AND source = 'samjoe_food' AND external_customer_id = $2`,
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
      if (contacts.rows.length === 1) return { contactId: contacts.rows[0]!.id, ambiguous: false };
      if (contacts.rows.length > 1) return { contactId: null, ambiguous: true };
    }
  }

  if (customer.email) {
    const contacts = await db.query<{ id: string }>(
      'SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2',
      [tenantId, customer.email.toLowerCase()],
    );
    if (contacts.rows.length === 1) return { contactId: contacts.rows[0]!.id, ambiguous: false };
    if (contacts.rows.length > 1) return { contactId: null, ambiguous: true };
  }

  return { contactId: null, ambiguous: false };
}

async function ensureExternalLink(db: Database, tenantId: string, contactId: string, externalId: string) {
  try {
    await db.query(
      `INSERT INTO external_customer_links (id, tenant_id, contact_id, source, external_customer_id)
       VALUES ($1, $2, $3, 'samjoe_food', $4)`,
      [randomUUID(), tenantId, contactId, externalId],
    );
  } catch (err) {
    const pgErr = err as Error & { code?: string };
    if (pgErr.code !== '23505') throw err;
  }
}

async function resolveNotificationPhone(
  db: Database,
  tenantId: string,
  contactId: string | null,
  eventPhone?: string,
): Promise<string | null> {
  if (eventPhone?.trim()) return eventPhone;
  if (!contactId) return null;
  const result = await db.query<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM contacts WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [contactId, tenantId],
  );
  return result.rows[0]?.phone_e164 ?? null;
}

async function setOpenOrderContext(
  db: Database,
  tenantId: string,
  contactId: string | null,
  externalOrderId: string,
  orderRef: string,
  status: string,
) {
  if (!contactId) return;
  await db.query(
    `INSERT INTO se_contact_open_orders
       (tenant_id, contact_id, external_order_id, order_ref, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, external_order_id) DO UPDATE
       SET contact_id = EXCLUDED.contact_id,
           order_ref = EXCLUDED.order_ref,
           status = EXCLUDED.status,
           status_updated_at = now()`,
    [tenantId, contactId, externalOrderId, orderRef, status],
  );
  await db.query(
    `UPDATE contacts
        SET open_order_ref = $1, open_order_status = $2, updated_at = now()
      WHERE id = $3 AND tenant_id = $4`,
    [orderRef, status, contactId, tenantId],
  );
}

async function clearOpenOrderContext(
  db: Database,
  tenantId: string,
  contactId: string | null,
  externalOrderId: string,
  orderRef: string,
) {
  if (!contactId) return;
  await db.query(
    `DELETE FROM se_contact_open_orders
      WHERE tenant_id = $1 AND contact_id = $2
        AND (external_order_id = $3 OR order_ref = $4)`,
    [tenantId, contactId, externalOrderId, orderRef],
  );
  const latest = await db.query<{ order_ref: string; status: string }>(
    `SELECT order_ref, status
       FROM se_contact_open_orders
      WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY status_updated_at DESC, order_ref
      LIMIT 1`,
    [tenantId, contactId],
  );
  const remaining = latest.rows[0];
  await db.query(
    `UPDATE contacts
        SET open_order_ref = $1, open_order_status = $2, updated_at = now()
      WHERE id = $3 AND tenant_id = $4`,
    [remaining?.order_ref ?? null, remaining?.status ?? null, contactId, tenantId],
  );
}

async function createContactFromSamJoeFood(db: Database, tenantId: string, customer: SamJoeFoodCustomer) {
  let phone: string | null = null;
  try { if (customer.phone) phone = normalizeBrazilianPhone(customer.phone); } catch { /* ignore */ }
  const id = randomUUID();
  const result = await db.query<{ id: string }>(
    `INSERT INTO contacts (id, tenant_id, full_name, phone_e164, email, origin, stage)
     VALUES ($1, $2, $3, $4, $5, 'samjoe_food', 'prospect') RETURNING id`,
    [id, tenantId, customer.name?.trim() || 'Cliente SamJoE Food', phone, customer.email?.toLowerCase() ?? null],
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

export async function processSamJoeFoodEvent(db: Database, tenantId: string, event: SamJoeFoodEventPayload, envEvolutionUrl?: string, envApiKey?: string) {
  const { event_type, event_id, occurred_at, customer, order } = event;

  const resolvedContact = await resolveContact(db, tenantId, customer);
  let contactId = resolvedContact.contactId;
  const { ambiguous } = resolvedContact;
  if (ambiguous) return { kind: 'ambiguous' as const, event_type };

  if (event_type === 'customer.created') {
    let id = contactId;
    let createdNew = false;
    if (!id) {
      const created = await createContactFromSamJoeFood(db, tenantId, customer);
      id = created?.id ?? null;
      createdNew = Boolean(id);
    }
    if (id) {
      await ensureExternalLink(db, tenantId, id, customer.external_id);
      // New contacts follow the CRM default; existing contacts only gain order updates.
      await recordConsents(db, tenantId, id, null, {
        channel: createdNew ? 'whatsapp' : 'samjoe_food', purposes: createdNew ? ['marketing', 'order_updates'] : ['order_updates'], action: 'granted',
        source: 'samjoe_food_signup', policyVersion: '1.0', occurredAt: occurred_at,
      });
    }
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: id };
  }

  if (event_type === 'customer.updated') {
    if (contactId) await ensureExternalLink(db, tenantId, contactId, customer.external_id);
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: contactId };
  }

  if (event_type === 'order.created') {
    if (!contactId && (customer.phone || customer.email)) {
      const created = await createContactFromSamJoeFood(db, tenantId, customer);
      contactId = created?.id ?? null;
      if (contactId) {
        await ensureExternalLink(db, tenantId, contactId, customer.external_id);
        await recordConsents(db, tenantId, contactId, null, {
          channel: 'whatsapp', purposes: ['marketing', 'order_updates'], action: 'granted',
          source: 'samjoe_food_order', policyVersion: '1.0', occurredAt: occurred_at,
        });
      }
    }
    const orderRef = order?.ref ?? order?.external_id;
    let notification = undefined;
    if (order && orderRef) {
      await setOpenOrderContext(db, tenantId, contactId, order.external_id, orderRef, 'ORDER_RECEIVED');
    }
    if (order && customer.phone && orderRef) {
      notification = await sendOrderStatusWhatsApp(db, tenantId, orderRef, 'ORDER_RECEIVED', customer.phone, envEvolutionUrl, envApiKey);
    }
    if (order && orderRef) {
      await sendOrderAlertToOwners(db, tenantId, orderRef, customer.name, order.total_cents, order.fulfillment, order.items, order.delivery_address, envEvolutionUrl, envApiKey).catch(() => {});
    }
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: contactId, notification };
  }

  if (event_type === 'order.paid' && order) {
    if (contactId) await ensureExternalLink(db, tenantId, contactId, customer.external_id);
    let campaignId: string | null = null;
    if (order.ref && /^[0-9a-f]{8}$/i.test(order.ref)) {
      const refMatch = await db.query<{ id: string }>(
        `SELECT id FROM campaigns WHERE tenant_id = $1 AND id::text LIKE $2 LIMIT 1`,
        [tenantId, `${order.ref.toLowerCase()}%`],
      );
      campaignId = refMatch.rows[0]?.id ?? null;
    }
    if (!campaignId && contactId) {
      campaignId = await findLastTouchCampaign(db, tenantId, contactId, occurred_at);
    }
    const conversionId = randomUUID();
    try {
      await db.query(
        `INSERT INTO campaign_conversions
          (id, tenant_id, contact_id, campaign_id, source, external_event_id, external_order_id,
           status, revenue_cents, cost_cents, margin_cents, occurred_at, metadata_json)
         VALUES ($1, $2, $3, $4, 'samjoe_food', $5, $6, 'paid', $7, $8, $9, $10, $11::jsonb)`,
        [
          conversionId, tenantId, contactId, campaignId, event_id, order.external_id,
          order.total_cents, order.cost_cents ?? null,
          order.cost_cents != null ? order.total_cents - order.cost_cents : null,
          occurred_at, JSON.stringify({ customer_external_id: customer.external_id, ...(order.ref ? { utm_ref: order.ref } : {}) }),
        ],
      );
    } catch (err) {
      const pgErr = err as Error & { code?: string };
      if (pgErr.code === '23505') return { kind: 'duplicate' as const, event_type };
      throw err;
    }

    if (order.items?.length) {
      for (const item of order.items) {
        let productId: string | null = null;
        if (item.external_product_id) {
          // Upsert product so the catalog mirrors the Food store automatically
          const upsert = await db.query<{ id: string }>(
            `INSERT INTO se_products
               (id, tenant_id, sku, name, category, current_price_cents)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, sku) DO UPDATE
               SET name                = EXCLUDED.name,
                   category            = COALESCE(NULLIF(EXCLUDED.category,''), se_products.category),
                   current_price_cents = EXCLUDED.current_price_cents,
                   updated_at          = now()
             RETURNING id`,
            [
              randomUUID(), tenantId,
              item.external_product_id,
              item.name ?? item.external_product_id,
              item.category ?? 'Sem categoria',
              item.unit_price_cents ?? 0,
            ],
          );
          productId = upsert.rows[0]?.id ?? null;
        }
        await db.query(
          `INSERT INTO se_order_items
             (id, tenant_id, conversion_id, contact_id, product_id, external_product_id,
              product_name, category, quantity, unit_price_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            randomUUID(), tenantId, conversionId, contactId, productId,
            item.external_product_id ?? null, item.name ?? null, item.category ?? null,
            item.quantity ?? 1, item.unit_price_cents ?? 0,
          ],
        );
      }
    }
    if (contactId) {
      await db.query(
        `UPDATE contacts SET last_purchase_at = $1, updated_at = now()
         WHERE id = $2 AND tenant_id = $3 AND (last_purchase_at IS NULL OR last_purchase_at < $1)`,
        [occurred_at, contactId, tenantId],
      );
      await setOpenOrderContext(db, tenantId, contactId, order.external_id, order.ref ?? order.external_id, 'CONFIRMED');
    }
    let notification = undefined;
    const notificationPhone = await resolveNotificationPhone(db, tenantId, contactId, customer.phone);
    if (notificationPhone) {
      const orderRef = order.ref ?? order.external_id;
      notification = await sendOrderStatusWhatsApp(
        db, tenantId, orderRef, 'CONFIRMED', notificationPhone, envEvolutionUrl, envApiKey,
      );
    }
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, contact_id: contactId, campaign_id: campaignId, notification };
  }

  if (event_type === 'order.status_changed' && order) {
    const toStatus = (order.to_status ?? '').trim().toUpperCase();
    const phone = await resolveNotificationPhone(db, tenantId, contactId, customer.phone);
    const orderRef = order.ref ?? order.external_id;
    const closedStatuses = ['COMPLETED', 'CANCELLED', 'REFUNDED'];
    if (contactId) {
      if (closedStatuses.includes(toStatus.toUpperCase())) {
        await clearOpenOrderContext(db, tenantId, contactId, order.external_id, orderRef);
      } else if (toStatus) {
        await setOpenOrderContext(db, tenantId, contactId, order.external_id, orderRef, toStatus.toUpperCase());
      }
    }
    let notification = undefined;
    if (phone && toStatus) {
      notification = await sendOrderStatusWhatsApp(db, tenantId, orderRef, toStatus, phone, envEvolutionUrl, envApiKey);
    }
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type, notification };
  }

  if ((event_type === 'order.cancelled' || event_type === 'order.refunded') && order) {
    const newStatus = event_type === 'order.cancelled' ? 'cancelled' : 'refunded';
    await db.query(
      `UPDATE campaign_conversions
          SET status = $1, revenue_cents = 0, margin_cents = 0
        WHERE tenant_id = $2 AND source = 'samjoe_food' AND external_order_id = $3 AND status = 'paid'`,
      [newStatus, tenantId, order.external_id],
    );
    await clearOpenOrderContext(db, tenantId, contactId, order.external_id, order.ref ?? order.external_id);
    await touchIntegration(db, tenantId, occurred_at);
    return { kind: 'ok' as const, event_type };
  }

  await touchIntegration(db, tenantId, occurred_at);
  return { kind: 'ok' as const, event_type, contact_id: contactId };
}

async function touchIntegration(db: Database, tenantId: string, occurredAt: string) {
  await db.query(
    `UPDATE integration_connections SET last_event_at = $1, updated_at = now()
     WHERE tenant_id = $2 AND integration_type = 'samjoe_food'`,
    [occurredAt, tenantId],
  );
}
