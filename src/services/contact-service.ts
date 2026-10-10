import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';
import { normalizeBrazilianPhone } from '../domain/phone.js';

export const CONTACT_STAGES = [
  'prospect', 'invited', 'opted_in', 'interested', 'first_buyer',
  'repeat_buyer', 'inactive', 'blocked',
] as const;

export type ContactInput = {
  fullName: string;
  phone?: string;
  email?: string;
  origin: string;
  stage?: (typeof CONTACT_STAGES)[number];
  tags?: string[];
  notes?: string;
};

export async function listContacts(db: Database, tenantId: string, limit: number, offset: number) {
  return db.query(
    `SELECT id, full_name, phone_e164, email, origin, stage, tags_json,
            do_not_contact, created_at, updated_at
       FROM contacts
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
}

export async function createContact(db: Database, tenantId: string, input: ContactInput) {
  const id = randomUUID();
  const phone = input.phone ? normalizeBrazilianPhone(input.phone) : null;
  const result = await db.query(
    `INSERT INTO contacts
      (id, tenant_id, full_name, phone_e164, email, origin, stage, tags_json, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id, full_name, phone_e164, email, origin, stage, tags_json,
               do_not_contact, created_at, updated_at`,
    [
      id,
      tenantId,
      input.fullName.trim(),
      phone,
      input.email?.trim().toLowerCase() ?? null,
      input.origin,
      input.stage ?? 'prospect',
      JSON.stringify(input.tags ?? []),
      input.notes ?? null,
    ],
  );
  return result.rows[0];
}

