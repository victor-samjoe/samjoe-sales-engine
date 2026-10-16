import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';

export type ConsentPurpose = 'marketing' | 'order_updates';

export type ConsentInput = {
  channel: string;
  purposes: ConsentPurpose[];
  action: 'granted' | 'revoked';
  source: string;
  evidenceRef?: string;
  policyVersion: string;
  occurredAt: string;
};

async function insertConsentEvent(
  db: Database,
  tenantId: string,
  contactId: string,
  userId: string | null,
  input: Omit<ConsentInput, 'purposes'> & { purpose: ConsentPurpose },
) {
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO se_consent_events
      (id, tenant_id, contact_id, channel, purpose, action, source,
       evidence_ref, policy_version, occurred_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, contact_id, channel, purpose, action, source,
               evidence_ref, policy_version, occurred_at, created_at`,
    [
      id, tenantId, contactId, input.channel, input.purpose, input.action,
      input.source, input.evidenceRef ?? null, input.policyVersion,
      input.occurredAt, userId,
    ],
  );

  if (input.purpose === 'marketing') {
    await db.query(
      'UPDATE contacts SET do_not_contact = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3',
      [input.action === 'revoked', contactId, tenantId],
    );
  }

  return result.rows[0]!;
}

export async function recordConsents(
  db: Database,
  tenantId: string,
  contactId: string,
  userId: string | null,
  input: ConsentInput,
): Promise<null | object[]> {
  const contact = await db.query('SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2', [contactId, tenantId]);
  if (!contact.rows[0]) return null;

  const results = [];
  for (const purpose of input.purposes) {
    const row = await insertConsentEvent(db, tenantId, contactId, userId, { ...input, purpose });
    results.push(row);
  }
  return results;
}

export async function grantMissingDefaultConsents(
  db: Database,
  tenantId: string,
  userId: string | null,
) {
  const [contacts, existing] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id FROM contacts
        WHERE tenant_id = $1
          AND stage != 'blocked'
          AND do_not_contact = false
          AND preferences_json->>'archived_at' IS NULL`,
      [tenantId],
    ),
    db.query<{ contact_id: string; purpose: ConsentPurpose }>(
      `SELECT DISTINCT contact_id, purpose FROM se_consent_events
        WHERE tenant_id = $1 AND channel = 'whatsapp'
          AND purpose IN ('marketing', 'order_updates')`,
      [tenantId],
    ),
  ]);
  const registered = new Set(existing.rows.map((row) => `${row.contact_id}:${row.purpose}`));
  const rows: Array<{ id: string; purpose: ConsentPurpose }> = [];
  for (const contact of contacts.rows) {
    for (const purpose of ['marketing', 'order_updates'] as const) {
      if (!registered.has(`${contact.id}:${purpose}`)) rows.push({ id: contact.id, purpose });
    }
  }

  const occurredAt = new Date().toISOString();
  for (let start = 0; start < rows.length; start += 500) {
    const batch = rows.slice(start, start + 500);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const offset = values.length;
      values.push(randomUUID(), tenantId, row.id, 'whatsapp', row.purpose, 'granted', 'bulk_default', 'default-v1', occurredAt, userId);
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10})`;
    });
    await db.query(
      `INSERT INTO se_consent_events
        (id, tenant_id, contact_id, channel, purpose, action, source, policy_version, occurred_at, recorded_by)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  const marketingIds = [...new Set(rows.filter((row) => row.purpose === 'marketing').map((row) => row.id))];
  for (let start = 0; start < marketingIds.length; start += 500) {
    const batch = marketingIds.slice(start, start + 500);
    const placeholders = batch.map((_, index) => `$${index + 2}`).join(', ');
    await db.query(
      `UPDATE contacts SET do_not_contact = false, updated_at = now()
        WHERE tenant_id = $1 AND id IN (${placeholders})`,
      [tenantId, ...batch],
    );
  }

  return {
    contacts_updated: new Set(rows.map((row) => row.id)).size,
    events_created: rows.length,
  };
}

