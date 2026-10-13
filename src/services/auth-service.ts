import bcrypt from 'bcryptjs';
import type { Database } from '../core/db.js';

type LoginRow = {
  user_id: string;
  email: string;
  password_hash: string;
  tenant_id: string;
  role: 'owner' | 'manager' | 'operator' | 'viewer';
};

export async function authenticateUser(
  db: Database,
  tenantSlug: string,
  email: string,
  password: string,
): Promise<Omit<LoginRow, 'password_hash'> | null> {
  const result = await db.query<LoginRow>(
    `SELECT u.id AS user_id, u.email, u.password_hash, m.tenant_id, m.role
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN tenants t ON t.id = m.tenant_id
      WHERE lower(u.email) = lower($1)
        AND t.slug = $2
        AND lower(u.status) = 'active'
        AND lower(t.status) = 'active'
      LIMIT 1`,
    [email.trim(), tenantSlug.trim().toLowerCase()],
  );

  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return null;

  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.user_id]);
  const { password_hash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

