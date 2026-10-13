import type { FastifyInstance } from 'fastify';
import type { Database } from '../core/db.js';
import {
  getCampaignAnalytics,
  getProductAnalytics,
  getPurchaseFrequencyAnalytics,
  getEngagementAnalytics,
} from '../services/analytics-service.js';

export async function analyticsRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/analytics/campaigns', { onRequest: [app.authenticate] }, async (request) => {
    return getCampaignAnalytics(db, request.user.tenantId);
  });

  app.get('/api/v1/analytics/products', { onRequest: [app.authenticate] }, async (request) => {
    const { days } = request.query as { days?: string };
    const periodDays = Math.min(Math.max(Number(days ?? 90), 7), 365);
    return getProductAnalytics(db, request.user.tenantId, periodDays);
  });

  app.get('/api/v1/analytics/frequency', { onRequest: [app.authenticate] }, async (request) => {
    return getPurchaseFrequencyAnalytics(db, request.user.tenantId);
  });

  app.get('/api/v1/analytics/engagement', { onRequest: [app.authenticate] }, async (request) => {
    return getEngagementAnalytics(db, request.user.tenantId);
  });
}
