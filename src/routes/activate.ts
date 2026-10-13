import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';

const ActivateBody = Type.Object({
  token: Type.String({ minLength: 64, maxLength: 64 }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});

export async function activateRoutes(app: FastifyInstance, db: Database) {
  // Validate a token and return user/tenant info for the activation form
  app.get('/api/v1/auth/activate', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.code(400).send({ error: { code: 'MISSING_TOKEN', message: 'Token obrigatório', request_id: request.id } });
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const res = await db.query<{
      email: string; tenant_name: string; tenant_slug: string; expires_at: Date; used_at: Date | null;
    }>(
      `SELECT u.email, t.name AS tenant_name, t.slug AS tenant_slug, it.expires_at, it.used_at
       FROM invite_tokens it
       JOIN users u ON u.id = it.user_id
       JOIN tenants t ON t.id = it.tenant_id
       WHERE it.token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'INVALID_TOKEN', message: 'Token inválido', request_id: request.id } });
    }
    if (row.used_at) {
      return reply.code(410).send({ error: { code: 'TOKEN_USED', message: 'Token já utilizado', request_id: request.id } });
    }
    if (new Date(row.expires_at) < new Date()) {
      return reply.code(410).send({ error: { code: 'TOKEN_EXPIRED', message: 'Token expirado', request_id: request.id } });
    }
    return { email: row.email, tenant_name: row.tenant_name, tenant_slug: row.tenant_slug };
  });

  // Set password and activate the user account
  app.post<{ Body: { token: string; password: string } }>('/api/v1/auth/activate', {
    schema: { body: ActivateBody },
  }, async (request, reply) => {
    const { token, password } = request.body;
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const res = await db.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
      `SELECT id, user_id, expires_at, used_at FROM invite_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'INVALID_TOKEN', message: 'Token inválido', request_id: request.id } });
    }
    if (row.used_at) {
      return reply.code(410).send({ error: { code: 'TOKEN_USED', message: 'Token já utilizado', request_id: request.id } });
    }
    if (new Date(row.expires_at) < new Date()) {
      return reply.code(410).send({ error: { code: 'TOKEN_EXPIRED', message: 'Token expirado', request_id: request.id } });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Mark token used atomically (WHERE used_at IS NULL), then activate user
    const pool = db as unknown as pg.Pool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const markUsed = await client.query(
        `UPDATE invite_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [row.id],
      );
      if (!markUsed.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(410).send({ error: { code: 'TOKEN_USED', message: 'Token já utilizado', request_id: request.id } });
      }
      await client.query(
        `UPDATE users SET password_hash = $1, status = 'active', updated_at = now() WHERE id = $2`,
        [passwordHash, row.user_id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, message: 'Conta ativada com sucesso' };
  });
}
