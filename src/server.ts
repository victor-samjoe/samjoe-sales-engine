import { buildApp } from './app.js';
import { loadConfig } from './core/config.js';
import { createDatabase } from './core/db.js';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const app = await buildApp({ db, config });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });

