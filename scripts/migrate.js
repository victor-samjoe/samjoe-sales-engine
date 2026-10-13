import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
const connectionString = process.env.DATABASE_URL;
if (!connectionString)
    throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
    await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name varchar(255) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    const directory = resolve('migrations');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
        const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (exists.rowCount)
            continue;
        const sql = await readFile(resolve(directory, file), 'utf8');
        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
            await client.query('COMMIT');
            process.stdout.write(`Applied ${file}\n`);
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    }
}
finally {
    client.release();
    await pool.end();
}
