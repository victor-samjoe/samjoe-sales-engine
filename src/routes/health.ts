import type { FastifyInstance } from 'fastify';
import type { Database } from '../core/db.js';

export async function healthRoutes(app: FastifyInstance, db: Database) {
  app.get('/health', async (_request, reply) => {
    try {
      await db.query('SELECT 1 AS ok');
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unavailable' });
    }
  });
}

