import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
const required = (name) => {
    const value = process.env[name];
    if (!value)
        throw new Error(`${name} is required`);
    return value;
};
const databaseUrl = required('DATABASE_URL');
const tenantSlug = required('BOOTSTRAP_TENANT_SLUG').toLowerCase();
const tenantName = required('BOOTSTRAP_TENANT_NAME');
const adminEmail = required('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
const adminPassword = required('BOOTSTRAP_ADMIN_PASSWORD');
if (adminPassword.length < 12 || adminPassword === 'replace-before-running-seed') {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be replaced with at least 12 characters');
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
    await client.query('BEGIN');
    const tenantResult = await client.query(`INSERT INTO tenants (id, slug, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`, [randomUUID(), tenantSlug, tenantName]);
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId)
        throw new Error('Failed to create tenant');
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const userResult = await client.query(`INSERT INTO users (id, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
     RETURNING id`, [randomUUID(), adminEmail, passwordHash]);
    const userId = userResult.rows[0]?.id;
    if (!userId)
        throw new Error('Failed to create user');
    await client.query(`INSERT INTO memberships (user_id, tenant_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'owner'`, [userId, tenantId]);
    await client.query('COMMIT');
    process.stdout.write(`Bootstrap created for ${tenantSlug} (${adminEmail})\n`);
}
catch (error) {
    await client.query('ROLLBACK');
    throw error;
}
finally {
    client.release();
    await pool.end();
}
