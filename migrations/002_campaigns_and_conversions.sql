CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(180) NOT NULL,
  objective varchar(500),
  message_text text NOT NULL,
  link_url varchar(1000),
  status varchar(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'preflight_ready', 'approved', 'scheduled', 'sending', 'completed', 'cancelled')),
  audience_rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  min_interval_hours integer NOT NULL DEFAULT 168 CHECK (min_interval_hours >= 0),
  max_notifications_per_30d integer NOT NULL DEFAULT 4 CHECK (max_notifications_per_30d > 0),
  include_converted boolean NOT NULL DEFAULT true,
  conversion_window_days integer NOT NULL DEFAULT 7 CHECK (conversion_window_days BETWEEN 1 AND 90),
  snapshot_hash varchar(64),
  snapshot_created_at timestamptz,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_tenant_status_idx
  ON campaigns (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  asset_type varchar(20) NOT NULL CHECK (asset_type IN ('image', 'video')),
  url varchar(1000) NOT NULL,
  mime_type varchar(120),
  file_name varchar(255),
  size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_assets_campaign_idx
  ON campaign_assets (tenant_id, campaign_id);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  eligible boolean NOT NULL,
  exclusion_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  prior_delivery_count integer NOT NULL DEFAULT 0,
  prior_conversion_count integer NOT NULL DEFAULT 0,
  prior_revenue_cents bigint NOT NULL DEFAULT 0,
  prior_margin_cents bigint,
  delivery_status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  queued_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  provider_message_id varchar(255),
  snapshot_created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS campaign_recipients_report_idx
  ON campaign_recipients (tenant_id, campaign_id, eligible);

CREATE TABLE IF NOT EXISTS notification_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_recipient_id uuid NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_type varchar(20) NOT NULL
    CHECK (event_type IN ('queued', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  provider varchar(60),
  external_event_id varchar(255),
  provider_message_id varchar(255),
  error_code varchar(100),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS notification_events_contact_time_idx
  ON notification_events (tenant_id, contact_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_type varchar(40) NOT NULL CHECK (integration_type IN ('foodapp', 'n8n', 'evolution')),
  status varchar(20) NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'active', 'error')),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, integration_type)
);

CREATE TABLE IF NOT EXISTS external_customer_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source varchar(40) NOT NULL,
  external_customer_id varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_customer_id)
);

CREATE TABLE IF NOT EXISTS campaign_conversions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  source varchar(40) NOT NULL,
  external_event_id varchar(255) NOT NULL,
  external_order_id varchar(255) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('paid', 'cancelled', 'refunded')),
  revenue_cents bigint NOT NULL DEFAULT 0,
  cost_cents bigint,
  margin_cents bigint,
  occurred_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_event_id)
);

CREATE INDEX IF NOT EXISTS campaign_conversions_contact_time_idx
  ON campaign_conversions (tenant_id, contact_id, occurred_at DESC);
