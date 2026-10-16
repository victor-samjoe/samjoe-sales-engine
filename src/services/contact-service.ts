import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';
import { normalizeBrazilianPhone } from '../domain/phone.js';
import { recordConsents } from './consent-service.js';

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

export type ContactUpdateInput = {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  origin?: string;
  stage?: (typeof CONTACT_STAGES)[number];
  tags?: string[];
  notes?: string | null;
};

export async function listContacts(db: Database, tenantId: string, limit: number, offset: number) {
  const contacts = await db.query<Record<string, unknown>>(
    `SELECT id, full_name, phone_e164, email, origin, stage, tags_json, notes,
            do_not_contact, preferences_json->>'archived_at' AS archived_at,
            created_at, updated_at
       FROM contacts
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  const consent = await db.query<{ contact_id: string; action: string }>(
    `SELECT contact_id, action FROM se_consent_events
      WHERE tenant_id = $1 AND channel = 'whatsapp' AND purpose = 'marketing'
      ORDER BY occurred_at DESC, created_at DESC`,
    [tenantId],
  );
  const latestByContact = new Map<string, string>();
  for (const row of consent.rows) if (!latestByContact.has(row.contact_id)) latestByContact.set(row.contact_id, row.action);
  return {
    rows: contacts.rows.map((contact) => ({
      ...contact,
      marketing_consent_status: latestByContact.get(String(contact.id)) ?? null,
    })),
    rowCount: contacts.rowCount,
  };
}

export async function createContact(db: Database, tenantId: string, input: ContactInput, userId: string | null = null) {
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
  const contact = result.rows[0] as { id: string } | undefined;
  if (contact) {
    await recordConsents(db, tenantId, contact.id, userId, {
      channel: 'whatsapp',
      purposes: ['marketing', 'order_updates'],
      action: 'granted',
      source: 'default_on_create',
      policyVersion: 'default-v1',
      occurredAt: new Date().toISOString(),
    });
  }
  return contact;
}

export async function updateContact(db: Database, tenantId: string, contactId: string, input: ContactUpdateInput) {
  const params: unknown[] = [];
  const updates: string[] = [];
  const p = (value: unknown) => { params.push(value); return `$${params.length}`; };

  if (input.fullName !== undefined) updates.push(`full_name = ${p(input.fullName.trim())}`);
  if (input.phone !== undefined) updates.push(`phone_e164 = ${p(input.phone ? normalizeBrazilianPhone(input.phone) : null)}`);
  if (input.email !== undefined) updates.push(`email = ${p(input.email?.trim().toLowerCase() || null)}`);
  if (input.origin !== undefined) updates.push(`origin = ${p(input.origin)}`);
  if (input.stage !== undefined) updates.push(`stage = ${p(input.stage)}`);
  if (input.tags !== undefined) updates.push(`tags_json = ${p(JSON.stringify(input.tags))}::jsonb`);
  if (input.notes !== undefined) updates.push(`notes = ${p(input.notes?.trim() || null)}`);
  if (!updates.length) return null;

  updates.push('updated_at = now()');
  const result = await db.query(
    `UPDATE contacts SET ${updates.join(', ')}
      WHERE id = ${p(contactId)} AND tenant_id = ${p(tenantId)}
      RETURNING id, full_name, phone_e164, email, origin, stage, tags_json, notes,
                do_not_contact, preferences_json->>'archived_at' AS archived_at,
                created_at, updated_at`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function archiveContact(db: Database, tenantId: string, contactId: string) {
  const current = await db.query<{ stage: string; do_not_contact: boolean; preferences_json: Record<string, unknown> | string }>(
    'SELECT stage, do_not_contact, preferences_json FROM contacts WHERE id = $1 AND tenant_id = $2',
    [contactId, tenantId],
  );
  const contact = current.rows[0];
  if (!contact) return null;
  let preferences: Record<string, unknown> = {};
  if (typeof contact.preferences_json === 'string') {
    try { preferences = JSON.parse(contact.preferences_json) as Record<string, unknown>; } catch { preferences = {}; }
  } else {
    preferences = { ...contact.preferences_json };
  }
  preferences.archived_at = new Date().toISOString();
  preferences.archived_previous_stage = contact.stage;
  preferences.archived_previous_do_not_contact = contact.do_not_contact;
  const result = await db.query(
    `UPDATE contacts
        SET preferences_json = $1::jsonb,
            stage = 'inactive', do_not_contact = true, updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, preferences_json->>'archived_at' AS archived_at`,
    [JSON.stringify(preferences), contactId, tenantId],
  );
  return result.rows[0] ?? null;
}

export async function deleteContact(db: Database, tenantId: string, contactId: string) {
  const result = await db.query<{ id: string }>(
    'DELETE FROM contacts WHERE id = $1 AND tenant_id = $2 RETURNING id',
    [contactId, tenantId],
  );
  return result.rows[0] ?? null;
}

export async function createContactsBulk(db: Database, tenantId: string, contacts: ContactInput[], userId: string | null = null) {
  const created: object[] = [];
  const errors: Array<{ row: number; name: string; message: string }> = [];
  for (const [index, input] of contacts.entries()) {
    try {
      const contact = await createContact(db, tenantId, input, userId);
      if (contact) created.push(contact);
    } catch (error) {
      const err = error as Error & { code?: string };
      errors.push({
        row: index + 1,
        name: input.fullName,
        message: err.code === '23505' ? 'Telefone já cadastrado' : 'Não foi possível importar',
      });
    }
  }
  return { created, errors };
}

