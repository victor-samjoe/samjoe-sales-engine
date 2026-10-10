import type { Database } from '../core/db.js';

export type CampaignStat = {
  id: string;
  name: string;
  status: string;
  created_at: Date | string;
  recipients: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  engaged: number;
  failed: number;
  conversions: number;
  revenue_cents: number;
  margin_cents: number;
};

export type AnalyticsSummary = {
  total_campaigns: number;
  total_recipients: number;
  total_engaged: number;
  engagement_rate: number;
  total_conversions: number;
  total_revenue_cents: number;
  total_margin_cents: number;
};

export async function getCampaignAnalytics(db: Database, tenantId: string): Promise<{
  campaigns: CampaignStat[];
  summary: AnalyticsSummary;
}> {
  const campResult = await db.query<{
    id: string; name: string; status: string; created_at: Date | string;
  }>(
    `SELECT id, name, status, created_at FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );

  const deliveryResult = await db.query<{
    campaign_id: string; delivery_status: string; cnt: string;
  }>(
    `SELECT campaign_id, delivery_status, COUNT(*) as cnt
       FROM campaign_recipients WHERE tenant_id = $1
      GROUP BY campaign_id, delivery_status`,
    [tenantId],
  );

  const convResult = await db.query<{
    campaign_id: string; conversions: string; revenue_cents: string; margin_cents: string;
  }>(
    `SELECT campaign_id,
       COUNT(*) as conversions,
       SUM(revenue_cents) as revenue_cents,
       SUM(CASE WHEN margin_cents IS NULL THEN 0 ELSE margin_cents END) as margin_cents
     FROM campaign_conversions
     WHERE tenant_id = $1 AND status = 'paid' AND campaign_id IS NOT NULL
     GROUP BY campaign_id`,
    [tenantId],
  );

  // Build lookup maps
  type DeliveryBucket = Record<string, number>;
  const deliveryMap = new Map<string, DeliveryBucket>();
  for (const row of deliveryResult.rows) {
    const bucket = deliveryMap.get(row.campaign_id) ?? {};
    bucket[row.delivery_status] = Number(row.cnt);
    deliveryMap.set(row.campaign_id, bucket);
  }
  const convMap = new Map(convResult.rows.map(r => [r.campaign_id, r]));

  const campaigns: CampaignStat[] = campResult.rows.map(c => {
    const d = deliveryMap.get(c.id) ?? {};
    const cv = convMap.get(c.id);
    const delivered = d.delivered ?? 0;
    const read = d.read ?? 0;
    const engaged = delivered + read;
    const recipients = (d.queued ?? 0) + (d.sent ?? 0) + delivered + read + (d.failed ?? 0);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      created_at: c.created_at,
      recipients,
      queued: d.queued ?? 0,
      sent: d.sent ?? 0,
      delivered,
      read,
      engaged,
      failed: d.failed ?? 0,
      conversions: Number(cv?.conversions ?? 0),
      revenue_cents: Number(cv?.revenue_cents ?? 0),
      margin_cents: Number(cv?.margin_cents ?? 0),
    };
  });

  const summary: AnalyticsSummary = campaigns.reduce(
    (acc, c) => ({
      total_campaigns: acc.total_campaigns + (c.status !== 'draft' ? 1 : 0),
      total_recipients: acc.total_recipients + c.recipients,
      total_engaged: acc.total_engaged + c.engaged,
      engagement_rate: 0,
      total_conversions: acc.total_conversions + c.conversions,
      total_revenue_cents: acc.total_revenue_cents + c.revenue_cents,
      total_margin_cents: acc.total_margin_cents + c.margin_cents,
    }),
    { total_campaigns: 0, total_recipients: 0, total_engaged: 0, engagement_rate: 0, total_conversions: 0, total_revenue_cents: 0, total_margin_cents: 0 },
  );
  summary.engagement_rate = summary.total_recipients > 0
    ? Math.round((summary.total_engaged / summary.total_recipients) * 100)
    : 0;

  return { campaigns, summary };
}
