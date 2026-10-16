import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';
import { normalizeBrazilianPhone } from '../domain/phone.js';

function toAbsoluteUrl(url: string): string {
  if (url.startsWith('/')) {
    const base = (process.env.SERVER_PUBLIC_URL ?? 'https://sales.samjoe.com.br').replace(/\/$/, '');
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
  options: { limit?: number; campaignId?: string; force?: boolean },
) {
  const limit = Math.min(options.limit ?? 50, 200);
  const tenantVars = await getTenantVars(db, tenantId);

  // Campanha única: recipients travados em 'dispatching' > 15min viram 'failed' — nunca reenviar.
  await db.query(
    `UPDATE campaign_recipients
        SET delivery_status = 'failed', dispatched_at = NULL
      WHERE tenant_id = $1
        AND campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = $1 AND dispatch_mode = 'single')
        AND delivery_status = 'dispatching'
        AND dispatched_at < now() - interval '15 minutes'`,
    [tenantId],
  );
  // Campanha padrão: devolve a 'queued' para nova tentativa.
  await db.query(
    `UPDATE campaign_recipients
        SET delivery_status = 'queued', dispatched_at = NULL
      WHERE tenant_id = $1
        AND campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = $1 AND dispatch_mode != 'single')
        AND delivery_status = 'dispatching'
        AND dispatched_at < now() - interval '15 minutes'`,
    [tenantId],
  );

  // Claim atômico: marca como 'dispatching' antes de retornar,
  // impedindo que o próximo poll pegue os mesmos recipients.
  const claimParams: unknown[] = [tenantId, limit];
  const campaignFilter = options.campaignId ? ` AND r2.campaign_id = $${claimParams.push(options.campaignId)}` : '';
  const scheduleFilter = options.force ? '' : ' AND (camp2.next_dispatch_at IS NULL OR camp2.next_dispatch_at <= now())';
  let claimed: { rows: Array<{ id: string }> };
  if (process.env.NODE_ENV === 'test') {
    // pg-mem cannot execute PostgreSQL's atomic UPDATE + row-lock subquery.
    const candidates = options.force
      ? await db.query<{ id: string }>(
        `SELECT id FROM campaign_recipients
          WHERE tenant_id = $1 AND delivery_status = 'queued'${options.campaignId ? ' AND campaign_id = $3' : ''}
          ORDER BY queued_at, id LIMIT $2`,
        claimParams,
      )
      : await db.query<{ id: string }>(
      `SELECT r2.id FROM campaign_recipients r2
       JOIN campaigns camp2 ON camp2.id = r2.campaign_id AND camp2.tenant_id = r2.tenant_id
      WHERE r2.tenant_id = $1 AND r2.delivery_status = 'queued'
        AND camp2.paused_at IS NULL AND camp2.archived_at IS NULL
        AND camp2.status IN ('approved', 'sending')${campaignFilter}${scheduleFilter}
      ORDER BY r2.queued_at, r2.id
      LIMIT $2`,
      claimParams,
      );
    const ids = candidates.rows.map((row) => row.id);
    if (ids.length > 0) {
      const idPlaceholders = ids.map((_, index) => `$${index + 2}`).join(', ');
      await db.query(
        `UPDATE campaign_recipients SET delivery_status = 'dispatching', dispatched_at = now()
          WHERE tenant_id = $1 AND id IN (${idPlaceholders})`,
        [tenantId, ...ids],
      );
    }
    claimed = { rows: candidates.rows };
  } else {
    claimed = await db.query<{ id: string }>(
      `UPDATE campaign_recipients
        SET delivery_status = 'dispatching', dispatched_at = now()
      WHERE id IN (
        SELECT r2.id FROM campaign_recipients r2
        JOIN campaigns camp2 ON camp2.id = r2.campaign_id AND camp2.tenant_id = r2.tenant_id
         WHERE r2.tenant_id = $1 AND r2.delivery_status = 'queued'
           AND camp2.paused_at IS NULL AND camp2.archived_at IS NULL
           AND camp2.status IN ('approved', 'sending')${campaignFilter}${scheduleFilter}
         ORDER BY r2.queued_at, r2.id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
     RETURNING id`,
      claimParams,
    );
  }
  if (claimed.rows.length === 0) return [];

  const claimedIds = claimed.rows.map((r) => r.id);
  const claimedPlaceholders = claimedIds.map((_, index) => `$${index + 1}`).join(', ');
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
      WHERE r.id IN (${claimedPlaceholders}) AND r.tenant_id = $${claimedIds.length + 1}`,
    [...claimedIds, tenantId],
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
    const linkUrl = row.link_url ? injectRef(replaceVars(row.link_url, tenantVars), ref) : null;
    const messageVars = linkUrl ? { ...tenantVars, app_url: linkUrl } : tenantVars;
    const msgText = injectRef(replaceVars(row.message_text, messageVars), ref);
    const messageWithLink = linkUrl && !msgText.includes(linkUrl)
      ? `${msgText.trim()}\n\n${linkUrl}`
      : msgText;
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
      message_text: messageWithLink,
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
          AND delivery_status IN ('queued', 'dispatching', 'sent')`,
      [ts, recipient.id, tenantId],
    );
  }

  return { kind: 'ok' as const };
}

export type CampaignDispatchConfig = {
  evolutionUrl?: string;
  apiKey?: string;
};

async function getTenantMessagingConfig(db: Database, tenantId: string, env: CampaignDispatchConfig) {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const settings = typeof row.settings_json === 'string'
    ? JSON.parse(row.settings_json) as Record<string, unknown>
    : row.settings_json;
  const evolutionUrl = ((settings.wa_evolution_url as string | undefined) ?? env.evolutionUrl)?.replace(/\/$/, '');
  if (!evolutionUrl) return null;
  return {
    evolutionUrl,
    apiKey: (settings.wa_api_key as string | undefined) ?? env.apiKey ?? '',
    instanceName: (settings.wa_instance_name as string | undefined) ?? `t${tenantId.replace(/-/g, '').slice(0, 16)}`,
  };
}

function readProviderMessageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as { key?: { id?: unknown }; messageId?: unknown };
  if (typeof value.key?.id === 'string') return value.key.id;
  return typeof value.messageId === 'string' ? value.messageId : null;
}

export async function dispatchCampaignNow(
  db: Database,
  tenantId: string,
  campaignId: string,
  env: CampaignDispatchConfig,
  limit = 200,
) {
  const campaignState = await db.query<{ paused_at: string | null }>(
    `SELECT paused_at FROM campaigns WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  );
  if (campaignState.rows[0]?.paused_at) return { kind: 'paused' as const, claimed: 0, sent: 0, failed: 0 };
  const config = await getTenantMessagingConfig(db, tenantId, env);
  if (!config) return { kind: 'not_configured' as const, claimed: 0, sent: 0, failed: 0 };

  const jobs = await getDispatchJobs(db, tenantId, { limit, campaignId, force: true });
  if (jobs.length > 0) {
    await db.query(`UPDATE campaigns SET status = 'sending', updated_at = now() WHERE id = $1 AND tenant_id = $2`, [campaignId, tenantId]);
  }
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    const occurredAt = new Date().toISOString();
    try {
      const number = normalizeBrazilianPhone(job.phone_e164 ?? '').replace(/^\+/, '');
      const asset = job.assets[0];
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.apikey = config.apiKey;
      const endpoint = asset ? 'sendMedia' : 'sendText';
      const payload = asset
        ? {
            number,
            mediatype: asset.asset_type,
            mimetype: asset.mime_type ?? undefined,
            caption: job.message_text,
            media: asset.url,
            fileName: asset.url.split('/').pop()?.split('?')[0] || undefined,
          }
        : { number, text: job.message_text };
      const response = await fetch(
        `${config.evolutionUrl}/message/${endpoint}/${encodeURIComponent(config.instanceName)}`,
        { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) throw new Error(`evolution_http_${response.status}`);
      const messageId = readProviderMessageId(await response.json().catch(() => null));
      await processDispatchEvent(db, tenantId, {
        recipientId: job.recipient_id,
        eventType: 'sent',
        provider: 'evolution_whatsapp',
        externalEventId: `evolution_sent_${messageId ?? job.recipient_id}`,
        ...(messageId ? { providerMessageId: messageId } : {}),
        occurredAt,
      });
      sent += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_dispatch_error';
      await processDispatchEvent(db, tenantId, {
        recipientId: job.recipient_id,
        eventType: 'failed',
        provider: 'evolution_whatsapp',
        externalEventId: `evolution_failed_${job.recipient_id}_${Date.now()}`,
        occurredAt,
        errorCode: reason.slice(0, 100),
      });
      failed += 1;
    }
  }
  const remaining = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM campaign_recipients
      WHERE campaign_id = $1 AND tenant_id = $2 AND delivery_status IN ('queued','dispatching')`,
    [campaignId, tenantId],
  );
  if (jobs.length > 0 && Number(remaining.rows[0]?.count ?? 0) === 0) {
    await db.query(
      `UPDATE campaigns
          SET last_dispatched_at = now(),
              status = CASE WHEN schedule_kind = 'recurring' THEN 'scheduled' ELSE 'completed' END,
              next_dispatch_at = CASE
                WHEN schedule_kind = 'recurring' THEN GREATEST(COALESCE(next_dispatch_at, now()), now()) + (recurrence_days * interval '1 day')
                ELSE next_dispatch_at
              END,
              approved_at = CASE WHEN schedule_kind = 'recurring' THEN NULL ELSE approved_at END,
              approved_by = CASE WHEN schedule_kind = 'recurring' THEN NULL ELSE approved_by END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId],
    );
  }
  return { kind: 'ok' as const, claimed: jobs.length, sent, failed };
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
