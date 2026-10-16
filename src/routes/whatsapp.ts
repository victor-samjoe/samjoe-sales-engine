import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { WA_DEFAULT_TEMPLATES, type WaResponseTemplates } from '../services/wa-notify.js';

const WA_DEFAULT_URL = 'http://localhost:8081';
const WA_DEFAULT_INSTANCE = 'samjoe';

interface WaConfig {
  evolutionUrl: string;
  instanceName: string;
  apiKey: string;
  automationEnabled: boolean;
  alertNumbers: string[];
}

async function getTenantWaConfig(db: Database, tenantId: string): Promise<WaConfig> {
  const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  const settings = row
    ? (typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : row.settings_json)
    : {};
  return {
    evolutionUrl: (settings.wa_evolution_url as string | undefined) ?? WA_DEFAULT_URL,
    instanceName: (settings.wa_instance_name as string | undefined) ?? WA_DEFAULT_INSTANCE,
    apiKey: (settings.wa_api_key as string | undefined) ?? '',
    automationEnabled: (settings.wa_automation_enabled as boolean | undefined) ?? false,
    alertNumbers: (settings.wa_alert_numbers as string[] | undefined) ?? [],
  };
}

async function saveTenantWaConfig(db: Database, tenantId: string, patch: Partial<WaConfig>) {
  const current = await db.query<{ settings_json: Record<string, unknown> | string }>(
    `SELECT settings_json FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = current.rows[0];
  if (!row) throw new Error('Tenant not found');
  const settings = typeof row.settings_json === 'string'
    ? JSON.parse(row.settings_json) as Record<string, unknown>
    : { ...row.settings_json };

  if (patch.evolutionUrl !== undefined) settings.wa_evolution_url = patch.evolutionUrl;
  if (patch.instanceName !== undefined) settings.wa_instance_name = patch.instanceName;
  if (patch.apiKey !== undefined) settings.wa_api_key = patch.apiKey;
  if (patch.automationEnabled !== undefined) settings.wa_automation_enabled = patch.automationEnabled;
  if (patch.alertNumbers !== undefined) settings.wa_alert_numbers = patch.alertNumbers.filter(Boolean);

  await db.query(
    `UPDATE tenants SET settings_json = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(settings), tenantId],
  );
}

function evoHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h.apikey = apiKey;
  return h;
}

const WaConfigBody = Type.Object({
  evolutionUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  instanceName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  apiKey: Type.Optional(Type.String({ maxLength: 512 })),
  automationEnabled: Type.Optional(Type.Boolean()),
  alertNumbers: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 20 })),
});

const WaResponseTemplateBody = Type.Object({
  enabled: Type.Boolean(),
  message: Type.String({ maxLength: 1000 }),
});

const WaResponsesBody = Type.Object({
  templates: Type.Record(Type.String({ maxLength: 50 }), WaResponseTemplateBody),
});

export async function whatsappRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/integrations/whatsapp/config', { onRequest: [app.authenticate] }, async (request) => {
    const cfg = await getTenantWaConfig(db, request.user.tenantId);
    return {
      data: {
        evolutionUrl: cfg.evolutionUrl,
        instanceName: cfg.instanceName,
        hasApiKey: !!cfg.apiKey,
        automationEnabled: cfg.automationEnabled,
        alertNumbers: cfg.alertNumbers,
      },
    };
  });

  app.put('/api/v1/integrations/whatsapp/config', {
    onRequest: [app.authenticate],
    schema: { body: WaConfigBody },
  }, async (request) => {
    const body = request.body as Partial<WaConfig>;
    await saveTenantWaConfig(db, request.user.tenantId, body);
    return { data: { ok: true } };
  });

  app.get('/api/v1/integrations/whatsapp/responses', { onRequest: [app.authenticate] }, async (request) => {
    const result = await db.query<{ settings_json: Record<string, unknown> | string }>(
      `SELECT settings_json FROM tenants WHERE id = $1`,
      [request.user.tenantId],
    );
    const row = result.rows[0];
    const settings = row
      ? (typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) as Record<string, unknown> : row.settings_json)
      : {};
    const saved = settings.wa_response_templates as WaResponseTemplates | undefined;
    const templates: WaResponseTemplates = {};
    for (const [key, defaultTemplate] of Object.entries(WA_DEFAULT_TEMPLATES)) {
      templates[key] = saved?.[key] ?? defaultTemplate;
    }
    return { data: { templates } };
  });

  app.put('/api/v1/integrations/whatsapp/responses', {
    onRequest: [app.authenticate],
    schema: { body: WaResponsesBody },
  }, async (request, reply) => {
    const body = request.body as { templates: WaResponseTemplates };
    const invalidKey = Object.keys(body.templates).find((key) => !(key in WA_DEFAULT_TEMPLATES));
    if (invalidKey) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Status de resposta inválido: ${invalidKey}` } });
    }
    const current = await db.query<{ settings_json: Record<string, unknown> | string }>(
      `SELECT settings_json FROM tenants WHERE id = $1`,
      [request.user.tenantId],
    );
    const row = current.rows[0];
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tenant não encontrado' } });
    const settings = typeof row.settings_json === 'string'
      ? JSON.parse(row.settings_json) as Record<string, unknown>
      : { ...row.settings_json };
    settings.wa_response_templates = { ...(settings.wa_response_templates as WaResponseTemplates | undefined), ...body.templates };
    await db.query(
      `UPDATE tenants SET settings_json = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(settings), request.user.tenantId],
    );
    return { data: { ok: true } };
  });

  // Proxy: get QR code from Evolution API (creates instance if not exists)
  app.get('/api/v1/integrations/whatsapp/qr', { onRequest: [app.authenticate] }, async (request, reply) => {
    const cfg = await getTenantWaConfig(db, request.user.tenantId);
    const headers = evoHeaders(cfg.apiKey);

    try {
      // Ensure instance exists — 409 = already created, that's fine
      const createRes = await fetch(`${cfg.evolutionUrl}/instance/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ instanceName: cfg.instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (!createRes.ok && createRes.status !== 409 && createRes.status !== 403) {
        const errBody = await createRes.json().catch(() => ({})) as { message?: string };
        return reply.code(502).send({ error: { code: 'EVOLUTION_ERROR', message: errBody.message ?? 'Erro ao criar instância WhatsApp' } });
      }

      const qrRes = await fetch(`${cfg.evolutionUrl}/instance/connect/${cfg.instanceName}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!qrRes.ok) {
        return reply.code(502).send({ error: { code: 'EVOLUTION_ERROR', message: 'QR code não disponível. Verifique se a instância está pronta.' } });
      }
      const qrData = await qrRes.json() as { base64?: string; code?: string };
      return { data: { base64: qrData.base64 ?? null, code: qrData.code ?? null } };
    } catch (err) {
      const error = err as Error;
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      return reply.code(502).send({
        error: {
          code: isTimeout ? 'EVOLUTION_TIMEOUT' : 'EVOLUTION_UNAVAILABLE',
          message: isTimeout
            ? 'Evolution API demorou para responder. Verifique se está rodando.'
            : 'Evolution API indisponível. Verifique o endereço e tente novamente.',
        },
      });
    }
  });

  // Proxy: connection state
  app.get('/api/v1/integrations/whatsapp/status', { onRequest: [app.authenticate] }, async (request) => {
    const cfg = await getTenantWaConfig(db, request.user.tenantId);
    const headers = evoHeaders(cfg.apiKey);
    try {
      const res = await fetch(`${cfg.evolutionUrl}/instance/connectionState/${cfg.instanceName}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { data: { state: 'offline', instanceName: cfg.instanceName } };
      const data = await res.json() as { instance?: { state?: string } };
      return { data: { state: data.instance?.state ?? 'unknown', instanceName: cfg.instanceName } };
    } catch {
      return { data: { state: 'offline', instanceName: cfg.instanceName } };
    }
  });

  // Disconnect / logout instance
  app.delete('/api/v1/integrations/whatsapp/disconnect', { onRequest: [app.authenticate] }, async (request, reply) => {
    const cfg = await getTenantWaConfig(db, request.user.tenantId);
    const headers = evoHeaders(cfg.apiKey);
    try {
      await fetch(`${cfg.evolutionUrl}/instance/logout/${cfg.instanceName}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(8000),
      });
      return { data: { ok: true } };
    } catch {
      return reply.code(502).send({ error: { code: 'EVOLUTION_UNAVAILABLE', message: 'Evolution API indisponível' } });
    }
  });
}
