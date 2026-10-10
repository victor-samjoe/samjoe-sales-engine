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
    `INSERT INTO consent_events
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

  return result.rows[0];
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

