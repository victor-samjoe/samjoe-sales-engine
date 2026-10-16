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

export type ProductUpdateInput = {
  name?: string;
  category?: string;
  currentPriceCents?: number;
  currentEstimatedUnitCostCents?: number;
  costSource?: string;
  active?: boolean;
};

const RETURNING = `RETURNING id, sku, name, category, active, cost_source,
               current_price_cents, current_estimated_unit_cost_cents,
               created_at, updated_at`;

export function listProducts(db: Database, tenantId: string) {
  return db.query(
    `SELECT p.id, p.sku, p.name, p.category, p.active, p.cost_source,
            p.current_price_cents, p.current_estimated_unit_cost_cents,
            p.created_at, p.updated_at,
            EXISTS(
              SELECT 1 FROM se_order_items oi
              WHERE oi.product_id = p.id AND oi.tenant_id = p.tenant_id
            ) AS has_sales
       FROM se_products p WHERE p.tenant_id = $1 ORDER BY p.name`,
    [tenantId],
  );
}

export function listCategories(db: Database, tenantId: string) {
  return db.query<{ category: string }>(
    `SELECT DISTINCT category FROM se_products WHERE tenant_id = $1 ORDER BY category`,
    [tenantId],
  );
}

export async function createProduct(db: Database, tenantId: string, input: ProductInput) {
  const result = await db.query(
    `INSERT INTO se_products
      (id, tenant_id, sku, name, category, current_price_cents,
       current_estimated_unit_cost_cents, cost_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ${RETURNING}`,
    [
      randomUUID(), tenantId, input.sku.trim().toUpperCase(), input.name.trim(),
      input.category, input.currentPriceCents,
      input.currentEstimatedUnitCostCents ?? null, input.costSource ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateProduct(db: Database, tenantId: string, productId: string, input: ProductUpdateInput) {
  const salesCheck = await db.query<{ has_sales: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM se_order_items WHERE tenant_id = $1 AND product_id = $2
     ) AS has_sales`,
    [tenantId, productId],
  );
  const hasSales = salesCheck.rows[0]?.has_sales ?? false;

  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [tenantId, productId];
  let idx = 3;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); values.push(input.name.trim()); }
  if (input.category !== undefined) { sets.push(`category = $${idx++}`); values.push(input.category.trim()); }
  if (input.active !== undefined) { sets.push(`active = $${idx++}`); values.push(input.active); }

  if (!hasSales) {
    if (input.currentPriceCents !== undefined) { sets.push(`current_price_cents = $${idx++}`); values.push(input.currentPriceCents); }
    if (input.currentEstimatedUnitCostCents !== undefined) { sets.push(`current_estimated_unit_cost_cents = $${idx++}`); values.push(input.currentEstimatedUnitCostCents ?? null); }
    if (input.costSource !== undefined) { sets.push(`cost_source = $${idx++}`); values.push(input.costSource || null); }
  } else if (input.currentPriceCents !== undefined) {
    const err = Object.assign(new Error('Produto com vendas: preço não pode ser alterado.'), { statusCode: 409 });
    throw err;
  }

  const result = await db.query(
    `UPDATE se_products SET ${sets.join(', ')}
     WHERE tenant_id = $1 AND id = $2
     ${RETURNING}`,
    values,
  );
  if (!result.rows[0]) throw Object.assign(new Error('Produto não encontrado.'), { statusCode: 404 });
  return { product: result.rows[0], hasSales };
}

export async function deleteProduct(db: Database, tenantId: string, productId: string) {
  const salesCheck = await db.query<{ has_sales: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM se_order_items WHERE tenant_id = $1 AND product_id = $2
     ) AS has_sales`,
    [tenantId, productId],
  );
  const hasSales = salesCheck.rows[0]?.has_sales ?? false;

  if (hasSales) {
    await db.query(
      `UPDATE se_products SET active = false, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, productId],
    );
    return { deleted: false, deactivated: true };
  }

  const del = await db.query<{ id: string }>(
    `DELETE FROM se_products WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, productId],
  );
  if (!del.rows[0]) throw Object.assign(new Error('Produto não encontrado.'), { statusCode: 404 });
  return { deleted: true, deactivated: false };
}
