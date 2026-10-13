import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';

function toAbsoluteUrl(url: string): string {
  if (url.startsWith('/')) {
    const base = (process.env.SERVER_PUBLIC_URL ?? 'http://localhost:4010').replace(/\/$/, '');
    return `${base}${url}`;
  }
  return url;
}

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
};

function inferMime(url: string, mimeType: string | null): string | null {
  if (mimeType) return mimeType;
  const ext = url.toLowerCase().replace(/[?#].*$/, '').match(/\.\w+$/)?.[0];
  return ext ? (EXT_MIME[ext] ?? null) : null;
}

function injectRef(text: string, ref: string): string {
  return text.replace(/(https?:\/\/[^\s"'<>]+)/g, (url) => {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}ref=${ref}`;
  });
}

function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

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

async function getTenantVars(db: Database, tenantId: string): Promise<Record<string, string>> {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return {};
  const settings = typeof row.settings_json === 'string'
    ? JSON.parse(row.settings_json) as Record<string, unknown>
    : row.settings_json;
  return { app_url: typeof settings.app_url === 'string' ? settings.app_url : '' };
}

export async function getDispatchJobs(
  db: Database,
  tenantId: string,
  options: { limit?: number; campaignId?: string },
) {
  const limit = Math.min(options.limit ?? 50, 200);
  const tenantVars = await getTenantVars(db, tenantId);

  // Campanha única: recipients travados em 'dispatching' > 15min viram 'failed' — nunca reenviar.
  await db.query(
    `UPDATE campaign_recipients r
        SET delivery_status = 'failed', dispatched_at = NULL
       FROM campaigns camp
      WHERE r.campaign_id = camp.id
        AND r.tenant_id = $1
        AND camp.dispatch_mode = 'single'
        AND r.delivery_status = 'dispatching'
        AND r.dispatched_at < now() - interval '15 minutes'`,
    [tenantId],
  );
  // Campanha padrão: devolve a 'queued' para nova tentativa.
  await db.query(
    `UPDATE campaign_recipients r
        SET delivery_status = 'queued', dispatched_at = NULL
       FROM campaigns camp
      WHERE r.campaign_id = camp.id
        AND r.tenant_id = $1
        AND camp.dispatch_mode != 'single'
        AND r.delivery_status = 'dispatching'
        AND r.dispatched_at < now() - interval '15 minutes'`,
    [tenantId],
  );

  // Claim atômico: marca como 'dispatching' antes de retornar,
  // impedindo que o próximo poll pegue os mesmos recipients.
  const claimParams: unknown[] = [tenantId, limit];
  const campaignFilter = options.campaignId ? ` AND campaign_id = $${claimParams.push(options.campaignId)}` : '';
  const claimed = await db.query<{ id: string }>(
    `UPDATE campaign_recipients
        SET delivery_status = 'dispatching', dispatched_at = now()
      WHERE id IN (
        SELECT id FROM campaign_recipients
         WHERE tenant_id = $1 AND delivery_status = 'queued'${campaignFilter}
         ORDER BY queued_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
     RETURNING id`,
    claimParams,
  );
  if (claimed.rows.length === 0) return [];

  const claimedIds = claimed.rows.map((r) => r.id);
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
      WHERE r.id = ANY($1) AND r.tenant_id = $2`,
    [claimedIds, tenantId],
  );

  const campaignIds = [...new Set(result.rows.map((r) => r.campaign_id))];
  const allAssets = campaignIds.length > 0
    ? await db.query<{ campaign_id: string; id: string; asset_type: string; url: string; mime_type: string | null }>(
        `SELECT campaign_id, id, asset_type, url, mime_type FROM campaign_assets
         WHERE campaign_id = ANY($1) AND tenant_id = $2 ORDER BY created_at`,
        [campaignIds, tenantId],
      )
    : { rows: [] };
  const assetsByCampaign = new Map<string, typeof allAssets.rows>();
  for (const a of allAssets.rows) {
    const list = assetsByCampaign.get(a.campaign_id) ?? [];
    list.push(a);
    assetsByCampaign.set(a.campaign_id, list);
  }

  return result.rows.map((row) => {
    const ref = row.campaign_id.slice(0, 8);
    const msgText = injectRef(replaceVars(row.message_text, tenantVars), ref);
    const linkUrl = row.link_url ? injectRef(replaceVars(row.link_url, tenantVars), ref) : null;
    const assets = (assetsByCampaign.get(row.campaign_id) ?? []).map((a) => ({
      ...a,
      url: toAbsoluteUrl(a.url),
      mime_type: inferMime(a.url, a.mime_type),
    }));
    return {
      recipient_id: row.recipient_id,
      campaign_id: row.campaign_id,
      contact_id: row.contact_id,
      phone_e164: row.phone_e164,
      full_name: row.full_name,
      message_text: msgText,
      link_url: linkUrl,
      assets,
      queued_at: row.queued_at,
    };
  });
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
  queued: ['sent', 'delivered', 'read', 'failed', 'cancelled'],
  dispatching: ['sent', 'delivered', 'read', 'failed', 'cancelled'],
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
          SET delivery_status = 'sent', dispatched_at = NULL,
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
