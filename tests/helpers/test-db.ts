import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { newDb, DataType } from 'pg-mem';
import type { Database } from '../../src/core/db.js';

export async function createTestDatabase(): Promise<Database> {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'now', returns: DataType.timestamptz, implementation: () => new Date() });
  const migration = await readFile(resolve('migrations/001_initial.sql'), 'utf8');
  memory.public.none(migration);
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

