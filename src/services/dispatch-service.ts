import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';

export type DispatchEventInput = {
  recipientId: string;
  eventType: 'sent' | 'delivered' | 'read' | 'failed';
  provider: string;
  externalEventId: string;
  providerMessageId?: string;
  occurredAt: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};

type RecipientRow = {
  id: string;
  contact_id: string;
  campaign_id: string;
  delivery_status: string;
  min_interval_hours: number;
};

export async function getDispatchJobs(
  db: Database,
  tenantId: string,
  options: { limit?: number; campaignId?: string },
) {
  const limit = Math.min(options.limit ?? 50, 200);
  const params: unknown[] = [tenantId];
  const campaignFilter = options.campaignId
    ? ` AND r.campaign_id = $${params.push(options.campaignId)}`
    : '';

  const result = await db.query<{
    recipient_id: string; campaign_id: string; contact_id: string;
    phone_e164: string | null; full_name: string;
    message_text: string; link_url: string | null;
    min_interval_hours: number; queued_at: string | Date | null;
  }>(
    `SELECT r.id AS recipient_id, r.campaign_id, r.contact_id, r.queued_at,
            c.phone_e164, c.full_name,
            camp.message_text, camp.link_url, camp.min_interval_hours
       FROM campaign_recipients r
       JOIN contacts c ON c.id = r.contact_id AND c.tenant_id = r.tenant_id
       JOIN campaigns camp ON camp.id = r.campaign_id AND camp.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.delivery_status = 'queued'${campaignFilter}
      ORDER BY r.queued_at, r.id
      LIMIT $${params.push(limit)}`,
    params,
  );

  const jobs = [];
  for (const row of result.rows) {
    const assets = await db.query<{ id: string; asset_type: string; url: string; mime_type: string | null }>(
      `SELECT id, asset_type, url, mime_type FROM campaign_assets
       WHERE campaign_id = $1 AND tenant_id = $2 ORDER BY created_at`,
      [row.campaign_id, tenantId],
    );
    jobs.push({
      recipient_id: row.recipient_id,
      campaign_id: row.campaign_id,
      contact_id: row.contact_id,
      phone_e164: row.phone_e164,
      full_name: row.full_name,
      message_text: row.message_text,
      link_url: row.link_url,
      assets: assets.rows,
      queued_at: row.queued_at,
    });
  }
  return jobs;
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
  queued: ['sent', 'delivered', 'read', 'failed', 'cancelled'],
  sent: ['delivered', 'read', 'failed', 'cancelled'],
  delivered: ['read'],
  read: [],
  failed: [],
  cancelled: [],
  pending: [],
};

export async function processDispatchEvent(db: Database, tenantId: string, input: DispatchEventInput) {
  const recipientResult = await db.query<RecipientRow>(
    `SELECT r.id, r.contact_id, r.campaign_id, r.delivery_status,
            camp.min_interval_hours
       FROM campaign_recipients r
       JOIN campaigns camp ON camp.id = r.campaign_id AND camp.tenant_id = r.tenant_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [input.recipientId, tenantId],
  );
  const recipient = recipientResult.rows[0];
  if (!recipient) return { kind: 'not_found' as const };

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM notification_events
     WHERE tenant_id = $1 AND provider = $2 AND external_event_id = $3 LIMIT 1`,
    [tenantId, input.provider, input.externalEventId],
  );
  if (existing.rows.length > 0) return { kind: 'duplicate' as const };

  const allowed = STATUS_TRANSITIONS[recipient.delivery_status] ?? [];
  if (!allowed.includes(input.eventType)) {
    return { kind: 'ignored' as const, reason: `transition ${recipient.delivery_status} → ${input.eventType} not allowed` };
  }

  await db.query(
    `INSERT INTO notification_events
      (id, tenant_id, campaign_id, campaign_recipient_id, contact_id,
       event_type, provider, external_event_id, provider_message_id,
       error_code, metadata_json, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      randomUUID(), tenantId, recipient.campaign_id, recipient.id, recipient.contact_id,
      input.eventType, input.provider, input.externalEventId,
      input.providerMessageId ?? null, input.errorCode ?? null,
      JSON.stringify(input.metadata ?? {}), input.occurredAt,
    ],
  );

  const ts = input.occurredAt;
  if (input.eventType === 'sent') {
    await db.query(
      `UPDATE campaign_recipients
          SET delivery_status = 'sent',
              sent_at = CASE WHEN sent_at IS NULL THEN $1 ELSE sent_at END,
              provider_message_id = CASE WHEN provider_message_id IS NULL THEN $2 ELSE provider_message_id END
        WHERE id = $3 AND tenant_id = $4
          AND delivery_status NOT IN ('delivered', 'read', 'failed', 'cancelled')`,
      [ts, input.providerMessageId ?? null, recipient.id, tenantId],
    );
  } else if (input.eventType === 'delivered') {
    await db.query(
      `UPDATE campaign_recipients
          SET delivery_status = 'delivered',
              delivered_at = CASE WHEN delivered_at IS NULL THEN $1 ELSE delivered_at END
        WHERE id = $2 AND tenant_id = $3
          AND delivery_status NOT IN ('read', 'cancelled')`,
      [ts, recipient.id, tenantId],
    );
    await updateContactOutbound(db, tenantId, recipient.contact_id, ts, recipient.min_interval_hours);
  } else if (input.eventType === 'read') {
    await db.query(
      `UPDATE campaign_recipients
          SET delivery_status = 'read',
              read_at = CASE WHEN read_at IS NULL THEN $1 ELSE read_at END
        WHERE id = $2 AND tenant_id = $3
          AND delivery_status != 'cancelled'`,
      [ts, recipient.id, tenantId],
    );
    await updateContactOutbound(db, tenantId, recipient.contact_id, ts, recipient.min_interval_hours);
  } else if (input.eventType === 'failed') {
    await db.query(
      `UPDATE campaign_recipients
          SET delivery_status = 'failed',
              failed_at = CASE WHEN failed_at IS NULL THEN $1 ELSE failed_at END
        WHERE id = $2 AND tenant_id = $3
          AND delivery_status IN ('queued', 'sent')`,
      [ts, recipient.id, tenantId],
    );
  }

  return { kind: 'ok' as const };
}

async function updateContactOutbound(
  db: Database, tenantId: string, contactId: string, occurredAt: string, minIntervalHours: number,
) {
  const nextEligible = new Date(new Date(occurredAt).getTime() + minIntervalHours * 3_600_000).toISOString();
  await db.query(
    `UPDATE contacts
        SET last_outbound_at = CASE
              WHEN last_outbound_at IS NULL OR last_outbound_at < $1 THEN $1
              ELSE last_outbound_at
            END,
            next_eligible_at = CASE
              WHEN last_outbound_at IS NULL OR last_outbound_at < $1 THEN $2
              ELSE next_eligible_at
            END,
            updated_at = now()
      WHERE id = $3 AND tenant_id = $4`,
    [occurredAt, nextEligible, contactId, tenantId],
  );
}
