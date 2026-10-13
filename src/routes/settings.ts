import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';

const SettingsBody = Type.Object({
  appUrl: Type.Optional(Type.String({ maxLength: 500 })),
  tenantName: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
  timezone: Type.Optional(Type.String({ maxLength: 80 })),
});

export async function settingsRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/settings', { onRequest: [app.authenticate] }, async (request) => {
    const result = await db.query<{
      name: string; slug: string; timezone: string; settings_json: Record<string, unknown> | string;
    }>(
      `SELECT name, slug, timezone, settings_json FROM tenants WHERE id = $1`,
      [request.user.tenantId],
    );
    const row = result.rows[0];
    if (!row) return { data: null };
    const settings = typeof row.settings_json === 'string'
      ? JSON.parse(row.settings_json) as Record<string, unknown>
      : row.settings_json;
    return {
      data: {
        tenantName: row.name,
        slug: row.slug,
        timezone: row.timezone,
        appUrl: typeof settings.app_url === 'string' ? settings.app_url : null,
      },
    };
  });

  app.patch('/api/v1/settings', {
    onRequest: [app.authenticate], schema: { body: SettingsBody },
  }, async (request, reply) => {
    if (request.user.role !== 'owner' && request.user.role !== 'manager') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Sem permissão', request_id: request.id } });
    }
    const body = request.body as { appUrl?: string; tenantName?: string; timezone?: string };

    const current = await db.query<{ settings_json: Record<string, unknown> | string; name: string; timezone: string }>(
      `SELECT settings_json, name, timezone FROM tenants WHERE id = $1`,
      [request.user.tenantId],
    );
    const row = current.rows[0];
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tenant não encontrado', request_id: request.id } });

    const settings = typeof row.settings_json === 'string'
      ? JSON.parse(row.settings_json) as Record<string, unknown>
      : { ...row.settings_json };

    if (body.appUrl !== undefined) settings.app_url = body.appUrl || null;

    const newName = body.tenantName ?? row.name;
    const newTimezone = body.timezone ?? row.timezone;

    await db.query(
      `UPDATE tenants SET name = $1, timezone = $2, settings_json = $3::jsonb, updated_at = now() WHERE id = $4`,
      [newName, newTimezone, JSON.stringify(settings), request.user.tenantId],
    );

    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'tenant',
      entityId: request.user.tenantId,
      action: 'settings.updated',
      metadata: { fields: Object.keys(body) },
    });

    return { data: { tenantName: newName, timezone: newTimezone, appUrl: settings.app_url ?? null } };
  });
}
