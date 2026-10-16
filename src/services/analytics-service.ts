import type { Database } from '../core/db.js';

export type ProductStat = {
  product_id: string | null;
  external_product_id: string | null;
  product_name: string;
  category: string | null;
  orders: number;
  unique_buyers: number;
  units_sold: number;
  revenue_cents: number;
};

export type FrequencyBucket = {
  label: string;
  min_purchases: number;
  max_purchases: number | null;
  contact_count: number;
};

export type EngagementSegment = {
  label: string;
  contact_count: number;
  description: string;
};

export async function getProductAnalytics(
  db: Database, tenantId: string, days = 90,
): Promise<{ products: ProductStat[]; period_days: number }> {
  const result = await db.query<{
    product_id: string | null; external_product_id: string | null;
    product_name: string; category: string | null;
    orders: string; unique_buyers: string; units_sold: string; revenue_cents: string;
  }>(
    `SELECT
       oi.product_id,
       oi.external_product_id,
       COALESCE(p.name, oi.product_name, oi.external_product_id, 'Desconhecido') AS product_name,
       COALESCE(p.category, oi.category)                                          AS category,
       COUNT(DISTINCT oi.conversion_id)  AS orders,
       COUNT(DISTINCT oi.contact_id)     AS unique_buyers,
       SUM(oi.quantity)                  AS units_sold,
       SUM(oi.unit_price_cents * oi.quantity) AS revenue_cents
     FROM se_order_items oi
     LEFT JOIN se_products p ON p.id = oi.product_id AND p.tenant_id = oi.tenant_id
     JOIN campaign_conversions cc ON cc.id = oi.conversion_id AND cc.status = 'paid'
     WHERE oi.tenant_id = $1
       AND cc.occurred_at > now() - ($2 || ' days')::interval
     GROUP BY oi.product_id, oi.external_product_id, product_name, category
     ORDER BY revenue_cents DESC
     LIMIT 50`,
    [tenantId, String(days)],
  );

  return {
    products: result.rows.map(r => ({
      product_id: r.product_id,
      external_product_id: r.external_product_id,
      product_name: r.product_name,
      category: r.category,
      orders: Number(r.orders),
      unique_buyers: Number(r.unique_buyers),
      units_sold: Number(r.units_sold),
      revenue_cents: Number(r.revenue_cents),
    })),
    period_days: days,
  };
}

export async function getPurchaseFrequencyAnalytics(
  db: Database, tenantId: string,
): Promise<{ buckets: FrequencyBucket[]; total_buyers: number; never_purchased: number }> {
  const bucketResult = await db.query<{ bucket: string; contact_count: string }>(
    `WITH purchase_counts AS (
       SELECT contact_id, COUNT(*) AS purchases
       FROM campaign_conversions
       WHERE tenant_id = $1 AND status = 'paid' AND contact_id IS NOT NULL
       GROUP BY contact_id
     )
     SELECT
       CASE
         WHEN purchases = 1          THEN '1'
         WHEN purchases BETWEEN 2 AND 3 THEN '2-3'
         WHEN purchases BETWEEN 4 AND 6 THEN '4-6'
         ELSE '7+'
       END AS bucket,
       COUNT(*) AS contact_count
     FROM purchase_counts
     GROUP BY bucket
     ORDER BY MIN(purchases)`,
    [tenantId],
  );

  const neverResult = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM contacts
     WHERE tenant_id = $1 AND last_purchase_at IS NULL AND do_not_contact = false`,
    [tenantId],
  );

  const totalBuyers = bucketResult.rows.reduce((s, r) => s + Number(r.contact_count), 0);

  const labelMap: Record<string, { label: string; min: number; max: number | null }> = {
    '1':   { label: '1 compra',    min: 1, max: 1 },
    '2-3': { label: '2–3 compras', min: 2, max: 3 },
    '4-6': { label: '4–6 compras', min: 4, max: 6 },
    '7+':  { label: '7+ compras',  min: 7, max: null },
  };

  const buckets: FrequencyBucket[] = bucketResult.rows.map(r => ({
    label: labelMap[r.bucket]?.label ?? r.bucket,
    min_purchases: labelMap[r.bucket]?.min ?? 0,
    max_purchases: labelMap[r.bucket]?.max ?? null,
    contact_count: Number(r.contact_count),
  }));

  return { buckets, total_buyers: totalBuyers, never_purchased: Number(neverResult.rows[0]?.cnt ?? 0) };
}

export async function getEngagementAnalytics(
  db: Database, tenantId: string,
): Promise<{ segments: EngagementSegment[] }> {
  const [engaged, neverEngaged, highValue, lapsed] = await Promise.all([
    db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT contact_id) AS cnt
       FROM campaign_recipients
       WHERE tenant_id = $1 AND delivery_status IN ('delivered','read')
         AND delivered_at > now() - interval '90 days'`,
      [tenantId],
    ),
    db.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contacts
       WHERE tenant_id = $1 AND do_not_contact = false
         AND id NOT IN (
           SELECT DISTINCT contact_id FROM campaign_recipients
           WHERE tenant_id = $1 AND delivery_status IN ('delivered','read')
         )`,
      [tenantId],
    ),
    db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT cc.contact_id) AS cnt
       FROM campaign_conversions cc
       JOIN campaign_recipients cr ON cr.contact_id = cc.contact_id AND cr.tenant_id = cc.tenant_id
       WHERE cc.tenant_id = $1 AND cc.status = 'paid'
         AND cr.delivery_status IN ('delivered','read')`,
      [tenantId],
    ),
    db.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contacts
       WHERE tenant_id = $1
         AND last_purchase_at IS NOT NULL
         AND last_purchase_at < now() - interval '60 days'`,
      [tenantId],
    ),
  ]);

  return {
    segments: [
      {
        label: 'Engajados (90 dias)',
        contact_count: Number(engaged.rows[0]?.cnt ?? 0),
        description: 'Receberam ou leram mensagem nos últimos 90 dias',
      },
      {
        label: 'Nunca engajaram',
        contact_count: Number(neverEngaged.rows[0]?.cnt ?? 0),
        description: 'Jamais receberam uma mensagem entregue',
      },
      {
        label: 'Alto valor + engajados',
        contact_count: Number(highValue.rows[0]?.cnt ?? 0),
        description: 'Compraram após receberem uma campanha',
      },
      {
        label: 'Inativos (60+ dias)',
        contact_count: Number(lapsed.rows[0]?.cnt ?? 0),
        description: 'Compraram mas não aparecem nos últimos 60 dias',
      },
    ],
  };
}

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
    const recipients = (d.queued ?? 0) + (d.dispatching ?? 0) + (d.sent ?? 0) + delivered + read + (d.failed ?? 0);
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
