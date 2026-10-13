import { randomUUID } from 'node:crypto';
import type { Database } from '../core/db.js';

export type ProductInput = {
  sku: string;
  name: string;
  category: string;
  currentPriceCents: number;
  currentEstimatedUnitCostCents?: number;
  costSource?: string;
};

export function listProducts(db: Database, tenantId: string) {
  return db.query(
    `SELECT id, sku, name, category, active, cost_source,
            current_price_cents, current_estimated_unit_cost_cents,
            created_at, updated_at
       FROM se_products WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
}

export async function createProduct(db: Database, tenantId: string, input: ProductInput) {
  const result = await db.query(
    `INSERT INTO se_products
      (id, tenant_id, sku, name, category, current_price_cents,
       current_estimated_unit_cost_cents, cost_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, sku, name, category, active, cost_source,
               current_price_cents, current_estimated_unit_cost_cents,
               created_at, updated_at`,
    [
      randomUUID(), tenantId, input.sku.trim().toUpperCase(), input.name.trim(),
      input.category, input.currentPriceCents,
      input.currentEstimatedUnitCostCents ?? null, input.costSource ?? null,
    ],
  );
  return result.rows[0];
}

