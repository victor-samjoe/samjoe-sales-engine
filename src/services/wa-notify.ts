import type { Database } from '../core/db.js';
import { normalizeBrazilianPhone } from '../domain/phone.js';

export type WaResponseTemplate = { enabled: boolean; message: string };
export type WaResponseTemplates = Record<string, WaResponseTemplate>;

export type WaNotificationResult =
  | { kind: 'sent'; providerMessageId: string | null }
  | { kind: 'skipped'; reason: 'automation_disabled' | 'provider_not_configured' | 'template_disabled' | 'unknown_status' }
  | { kind: 'failed'; reason: string };

export const WA_DEFAULT_TEMPLATES: WaResponseTemplates = {
  ORDER_RECEIVED:   { enabled: true,  message: 'Pedido #{ref} recebido! 🎂 Em breve você receberá atualizações por aqui.' },
  CONFIRMED:        { enabled: true,  message: 'Seu pedido #{ref} foi confirmado e está sendo preparado. 🍽️' },
  IN_PREPARATION:   { enabled: true,  message: 'Seu pedido #{ref} está sendo preparado! 👨‍🍳' },
  READY:            { enabled: true,  message: 'Seu pedido #{ref} está pronto! Estamos preparando a liberação. ✅' },
  READY_FOR_PICKUP: { enabled: true,  message: 'Seu pedido #{ref} está pronto para retirada. 🏪' },
  OUT_FOR_DELIVERY: { enabled: true,  message: 'Seu pedido #{ref} saiu para entrega! 🚚' },
  COMPLETED:        { enabled: true,  message: 'Seu pedido #{ref} foi concluído. Obrigado pela preferência! 😊' },
  CANCELLED:        { enabled: true,  message: 'Seu pedido #{ref} foi cancelado. Se houve pagamento, o estorno será devolvido pelo Mercado Pago. Se precisar, fale com a gente por aqui.' },
};

export type AlertOrderItem = { name?: string; quantity?: number; unit_price_cents?: number };

const DELIVERY_MODE_LABELS: Record<string, string> = {
  delivery:  '🚚 Entrega',
  pickup:    '🏪 Retirada',
  dine_in:   '🍽️ Consumo no local',
  app:       '📱 Retirada pelo app',
  takeaway:  '🥡 Para viagem',
};

export async function sendOrderAlertToOwners(
  db: Database,
  tenantId: string,
  orderRef: string,
  customerName: string | undefined,
  totalCents: number | undefined,
  deliveryMode: string | undefined,
  items: AlertOrderItem[] | undefined,
  deliveryAddress: string | undefined,
  envEvolutionUrl?: string,
  envApiKey?: string,
): Promise<void> {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return;
  const settings = typeof row.settings_json === 'string'
    ? JSON.parse(row.settings_json) as Record<string, unknown>
    : row.settings_json;

  if (settings.wa_automation_enabled !== true) return;

  const evolutionUrl = ((settings.wa_evolution_url as string | undefined) ?? envEvolutionUrl)?.replace(/\/$/, '');
  if (!evolutionUrl) return;

  const alertNumbers = settings.wa_alert_numbers as string[] | undefined;
  if (!alertNumbers?.length) return;

  const defaultInstance = `t${tenantId.replace(/-/g, '').slice(0, 16)}`;
  const instanceName = (settings.wa_instance_name as string | undefined) ?? defaultInstance;
  const apiKey = (settings.wa_api_key as string | undefined) ?? envApiKey ?? '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.apikey = apiKey;

  const lines: string[] = [];
  const nameStr = customerName?.trim() ? ` de *${customerName.trim()}*` : '';
  lines.push(`🛒 Novo pedido *#${orderRef}*${nameStr}`);

  if (deliveryMode?.trim()) {
    const modeKey = deliveryMode.trim().toLowerCase();
    const modeLabel = DELIVERY_MODE_LABELS[modeKey] ?? `📦 ${deliveryMode.trim()}`;
    lines.push(`*Modalidade:* ${modeLabel}`);
  }

  if (items?.length) {
    lines.push('');
    lines.push('📦 *Itens:*');
    for (const item of items) {
      const qty = item.quantity ?? 1;
      const label = item.name?.trim() ?? 'Item';
      const price = item.unit_price_cents != null
        ? ` — R$ ${((item.unit_price_cents * qty) / 100).toFixed(2).replace('.', ',')}`
        : '';
      lines.push(`• ${label} x${qty}${price}`);
    }
  }

  if (deliveryAddress?.trim()) {
    lines.push('');
    lines.push(`📍 *Entrega:* ${deliveryAddress.trim()}`);
  }

  if (totalCents != null) {
    lines.push('');
    lines.push(`💰 *Total: R$ ${(totalCents / 100).toFixed(2).replace('.', ',')}*`);
  }

  const adminUrl = (settings.food_app_url as string | undefined)?.replace(/\/$/, '');
  if (adminUrl) {
    lines.push('');
    lines.push(`👉 ${adminUrl}/admin/orders`);
  }

  const text = lines.join('\n');

  const sends = alertNumbers.map(async (rawPhone) => {
    let number: string;
    try {
      number = normalizeBrazilianPhone(rawPhone).replace(/^\+/, '');
    } catch {
      return;
    }
    try {
      await fetch(`${evolutionUrl}/message/sendText/${encodeURIComponent(instanceName)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ number, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // best-effort, ignore failures for alert numbers
    }
  });
  await Promise.allSettled(sends);
}

export async function sendOrderStatusWhatsApp(
  db: Database,
  tenantId: string,
  orderRef: string,
  toStatus: string,
  phone: string,
  envEvolutionUrl?: string,
  envApiKey?: string,
): Promise<WaNotificationResult> {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'failed', reason: 'tenant_not_found' };
  const settings = typeof row.settings_json === 'string'
    ? JSON.parse(row.settings_json) as Record<string, unknown>
    : row.settings_json;

  if (settings.wa_automation_enabled !== true) {
    return { kind: 'skipped', reason: 'automation_disabled' };
  }

  const evolutionUrl = ((settings.wa_evolution_url as string | undefined) ?? envEvolutionUrl)?.replace(/\/$/, '');
  const defaultInstance = `t${tenantId.replace(/-/g, '').slice(0, 16)}`;
  const instanceName = (settings.wa_instance_name as string | undefined) ?? defaultInstance;
  const apiKey = (settings.wa_api_key as string | undefined) ?? envApiKey ?? '';

  if (!evolutionUrl) return { kind: 'skipped', reason: 'provider_not_configured' };

  const normalizedStatus = toStatus.trim().toUpperCase();
  const savedTemplates = settings.wa_response_templates as WaResponseTemplates | undefined;
  const tpl = savedTemplates?.[normalizedStatus] ?? WA_DEFAULT_TEMPLATES[normalizedStatus];
  if (!tpl) return { kind: 'skipped', reason: 'unknown_status' };
  if (!tpl.enabled) return { kind: 'skipped', reason: 'template_disabled' };

  const displayRef = orderRef.startsWith('#') ? orderRef : `#${orderRef}`;
  const message = tpl.message
    .replace(/#\{ref\}/g, displayRef)
    .replace(/\{ref\}/g, orderRef);
  let number: string;
  try {
    number = normalizeBrazilianPhone(phone).replace(/^\+/, '');
  } catch {
    return { kind: 'failed', reason: 'invalid_phone' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.apikey = apiKey;

  try {
    const response = await fetch(`${evolutionUrl}/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ number, text: message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { kind: 'failed', reason: `evolution_http_${response.status}` };
    const body = await response.json().catch(() => null) as {
      key?: { id?: string };
      messageId?: string;
    } | null;
    return { kind: 'sent', providerMessageId: body?.key?.id ?? body?.messageId ?? null };
  } catch (error) {
    const name = (error as Error).name;
    return { kind: 'failed', reason: name === 'TimeoutError' || name === 'AbortError' ? 'evolution_timeout' : 'evolution_unavailable' };
  }
}
