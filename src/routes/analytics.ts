import type { FastifyInstance } from 'fastify';
import type { Database } from '../core/db.js';
import { getCampaignAnalytics } from '../services/analytics-service.js';

export async function analyticsRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/analytics/campaigns', { onRequest: [app.authenticate] }, async (request) => {
    const result = await getCampaignAnalytics(db, request.user.tenantId);
    return result;
  });
}
