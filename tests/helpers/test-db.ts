import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { newDb, DataType } from 'pg-mem';
import type { Database } from '../../src/core/db.js';

export async function createTestDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({ name: 'now', returns: DataType.timestamptz, implementation: () => new Date() });
  const migrationFiles = (await readdir(resolve('migrations'))).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    if (file === '005_rename_samjoe_food.sql') continue; // fresh test schema starts with the final integration name
    if (file === '007_isolate_sales_engine_consents.sql') continue; // already present in fresh schema (001)
    const migration = await readFile(resolve('migrations', file), 'utf8');
    // pg-mem 3.x corrupts aliases when an ADD COLUMN contains an inline IN check.
    // PostgreSQL keeps the real constraint; tests only need the compatible column.
    const compatibleMigration = migration.replace(
      "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gender varchar(10) CHECK (gender IN ('M', 'F', 'other'));",
      'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gender varchar(10);',
    ).replace(
      "integration_type IN ('foodapp', 'n8n', 'evolution')",
      "integration_type IN ('samjoe_food', 'n8n', 'evolution')",
    ).replace(
      "delivery_status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'cancelled')",
      "delivery_status IN ('pending', 'queued', 'dispatching', 'sent', 'delivered', 'read', 'failed', 'cancelled')",
    ).replace(/DO \$\$[\s\S]*?END \$\$;/g, `
      UPDATE external_customer_links SET source = 'samjoe_food' WHERE source = 'foodapp';
      UPDATE campaign_conversions SET source = 'samjoe_food' WHERE source = 'foodapp';
    `);
    memory.public.none(compatibleMigration);
  }
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  return pool as unknown as Database;
}

export async function seedTestTenant(db: Database, input?: { slug?: string; email?: string; password?: string }) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const slug = input?.slug ?? 'samjoe-confeitaria';
  const email = input?.email ?? 'owner@samjoe.test';
  const password = input?.password ?? 'correct-horse-battery';
  const hash = await bcrypt.hash(password, 4);

  await db.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [tenantId, slug, 'SamJoE']);
  await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, email, hash]);
  await db.query("INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')", [userId, tenantId]);
  return { tenantId, userId, slug, email, password };
}

