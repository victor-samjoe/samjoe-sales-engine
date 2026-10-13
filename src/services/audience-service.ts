import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';

export type AudienceRules = {
  stages?: string[];
  origins?: string[];
  tags?: string[];
  purchasedProductIds?: string[];
  purchasedCategories?: string[];
  purchaseFrequency?: { min: number; days: number };
  lastPurchaseDays?: number;
  lapsedDays?: number;
  campaignEngagedDays?: number;
  notEngagedDays?: number;
  gender?: string[];
  ageMin?: number;
  ageMax?: number;
};

export type AudienceInput = {
  name: string;
  description?: string;
  rules: AudienceRules;
};

type AudienceRow = {
  id: string;
  name: string;
  description: string | null;
  rules_json: AudienceRules | string;
  contact_count: number | null;
  last_evaluated_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const parseRules = (raw: AudienceRules | string): AudienceRules => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) as AudienceRules; } catch { return {}; }
};

export async function listAudiences(db: Database, tenantId: string) {
  const result = await db.query<AudienceRow>(
    `SELECT id, name, description, rules_json, contact_count, last_evaluated_at, created_at, updated_at
       FROM audiences WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return result.rows.map(r => ({ ...r, rules: parseRules(r.rules_json) }));
}

export async function getAudience(db: Database, tenantId: string, audienceId: string) {
  const result = await db.query<AudienceRow>(
    `SELECT id, name, description, rules_json, contact_count, last_evaluated_at, created_at, updated_at
       FROM audiences WHERE id = $1 AND tenant_id = $2`,
    [audienceId, tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, rules: parseRules(row.rules_json) };
}

export async function createAudience(
  db: Database, tenantId: string, userId: string, input: AudienceInput,
) {
  const id = randomUUID();
  const result = await db.query<AudienceRow>(
    `INSERT INTO audiences (id, tenant_id, name, description, rules_json, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, name, description, rules_json, contact_count, last_evaluated_at, created_at, updated_at`,
    [id, tenantId, input.name.trim(), input.description?.trim() ?? null, JSON.stringify(input.rules), userId],
  );
  const row = result.rows[0]!;
  return { ...row, rules: parseRules(row.rules_json) };
}

export async function updateAudience(
  db: Database, tenantId: string, audienceId: string, input: Partial<AudienceInput>,
) {
  const setParts: string[] = [];
  const params: unknown[] = [];
  const p = (val: unknown) => { params.push(val); return `$${params.length}`; };

  if (input.name !== undefined) setParts.push(`name = ${p(input.name.trim())}`);
  if (input.description !== undefined) setParts.push(`description = ${p(input.description?.trim() ?? null)}`);
  if (input.rules !== undefined) {
    setParts.push(`rules_json = ${p(JSON.stringify(input.rules))}::jsonb`);
    setParts.push('contact_count = NULL', 'last_evaluated_at = NULL');
  }

  if (setParts.length === 0) return getAudience(db, tenantId, audienceId);

  setParts.push('updated_at = now()');
  const result = await db.query<AudienceRow>(
    `UPDATE audiences SET ${setParts.join(', ')}
     WHERE id = ${p(audienceId)} AND tenant_id = ${p(tenantId)}
     RETURNING id, name, description, rules_json, contact_count, last_evaluated_at, created_at, updated_at`,
    params,
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, rules: parseRules(row.rules_json) };
}

export async function deleteAudience(db: Database, tenantId: string, audienceId: string) {
  const result = await db.query(
    `DELETE FROM audiences WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [audienceId, tenantId],
  );
  return result.rowCount === 1;
}

export async function evaluateAudience(
  db: Database, tenantId: string, audienceId: string,
): Promise<{ kind: 'not_found' } | { kind: 'ok'; contact_count: number; contacts: unknown[] }> {
  const audience = await getAudience(db, tenantId, audienceId);
  if (!audience) return { kind: 'not_found' };

  const contacts = await queryAudienceContacts(db, tenantId, audience.rules);

  await db.query(
    `UPDATE audiences SET contact_count = $1, last_evaluated_at = now(), updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [contacts.length, audienceId, tenantId],
  );

  return { kind: 'ok', contact_count: contacts.length, contacts };
}

export async function queryAudienceContacts(
  db: Database, tenantId: string, rules: AudienceRules,
): Promise<Array<{ id: string; full_name: string; phone_e164: string | null; stage: string; origin: string }>> {
  const where: string[] = ['c.tenant_id = $1', 'c.do_not_contact = false'];
  const params: unknown[] = [tenantId];
  const p = (val: unknown) => { params.push(val); return `$${params.length}`; };

  if (rules.stages?.length) {
    where.push(`c.stage = ANY(${p(rules.stages)})`);
  }
  if (rules.origins?.length) {
    where.push(`c.origin = ANY(${p(rules.origins)})`);
  }
  if (rules.tags?.length) {
    where.push(`c.tags_json ?| ${p(rules.tags)}`);
  }
  if (rules.gender?.length) {
    where.push(`c.gender = ANY(${p(rules.gender)})`);
  }
  if (rules.ageMin !== undefined) {
    where.push(`date_part('year', age(c.birth_date)) >= ${p(rules.ageMin)}`);
  }
  if (rules.ageMax !== undefined) {
    where.push(`date_part('year', age(c.birth_date)) <= ${p(rules.ageMax)}`);
  }
  if (rules.lastPurchaseDays !== undefined) {
    where.push(`c.last_purchase_at > now() - ${p(`${rules.lastPurchaseDays} days`)}::interval`);
  }
  if (rules.lapsedDays !== undefined) {
    where.push(`(c.last_purchase_at IS NULL OR c.last_purchase_at < now() - ${p(`${rules.lapsedDays} days`)}::interval)`);
  }
  if (rules.purchasedProductIds?.length) {
    where.push(`EXISTS (
      SELECT 1 FROM order_items oi
      JOIN campaign_conversions cc ON cc.id = oi.conversion_id AND cc.status = 'paid'
      WHERE oi.tenant_id = c.tenant_id AND oi.contact_id = c.id
        AND oi.product_id = ANY(${p(rules.purchasedProductIds)})
    )`);
  }
  if (rules.purchasedCategories?.length) {
    where.push(`EXISTS (
      SELECT 1 FROM order_items oi
      JOIN campaign_conversions cc ON cc.id = oi.conversion_id AND cc.status = 'paid'
      WHERE oi.tenant_id = c.tenant_id AND oi.contact_id = c.id
        AND oi.category = ANY(${p(rules.purchasedCategories)})
    )`);
  }
  if (rules.purchaseFrequency) {
    const { min, days } = rules.purchaseFrequency;
    where.push(`(
      SELECT COUNT(*) FROM campaign_conversions cc2
      WHERE cc2.contact_id = c.id AND cc2.tenant_id = c.tenant_id AND cc2.status = 'paid'
        AND cc2.occurred_at > now() - ${p(`${days} days`)}::interval
    ) >= ${p(min)}`);
  }
  if (rules.campaignEngagedDays !== undefined) {
    where.push(`EXISTS (
      SELECT 1 FROM campaign_recipients cr
      WHERE cr.contact_id = c.id AND cr.tenant_id = c.tenant_id
        AND cr.delivery_status IN ('delivered','read')
        AND COALESCE(cr.read_at, cr.delivered_at) > now() - ${p(`${rules.campaignEngagedDays} days`)}::interval
    )`);
  }
  if (rules.notEngagedDays !== undefined) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM campaign_recipients cr
      WHERE cr.contact_id = c.id AND cr.tenant_id = c.tenant_id
        AND cr.delivery_status IN ('delivered','read')
        AND COALESCE(cr.read_at, cr.delivered_at) > now() - ${p(`${rules.notEngagedDays} days`)}::interval
    )`);
  }

  const result = await db.query<{ id: string; full_name: string; phone_e164: string | null; stage: string; origin: string }>(
    `SELECT c.id, c.full_name, c.phone_e164, c.stage, c.origin
     FROM contacts c
     WHERE ${where.join(' AND ')}
     ORDER BY c.full_name
     LIMIT 500`,
    params,
  );
  return result.rows;
}
