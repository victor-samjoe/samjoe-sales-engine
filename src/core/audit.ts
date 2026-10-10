import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';

export async function writeAudit(
  db: Database,
  input: {
    tenantId: string;
    actorUserId: string;
    entityType: string;
    entityId?: string;
    action: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs
      (id, tenant_id, actor_user_id, entity_type, entity_id, action, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      input.tenantId,
      input.actorUserId,
      input.entityType,
      input.entityId ?? null,
      input.action,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

