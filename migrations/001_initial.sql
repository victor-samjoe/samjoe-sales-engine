CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  timezone varchar(80) NOT NULL DEFAULT 'America/Sao_Paulo',
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email varchar(254) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL CHECK (role IN ('owner', 'manager', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  full_name varchar(180) NOT NULL,
  phone_e164 varchar(20),
  email varchar(254),
  origin varchar(40) NOT NULL,
  stage varchar(30) NOT NULL DEFAULT 'prospect',
  tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  preferences_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  do_not_contact boolean NOT NULL DEFAULT false,
  last_purchase_at timestamptz,
  last_outbound_at timestamptz,
  next_eligible_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS contacts_tenant_stage_idx ON contacts (tenant_id, stage);

CREATE TABLE IF NOT EXISTS consent_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel varchar(30) NOT NULL,
  purpose varchar(30) NOT NULL CHECK (purpose IN ('marketing', 'order_updates')),
  action varchar(20) NOT NULL CHECK (action IN ('granted', 'revoked')),
  source varchar(60) NOT NULL,
  evidence_ref varchar(255),
  policy_version varchar(40) NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_events_lookup_idx
  ON consent_events (tenant_id, contact_id, channel, purpose, occurred_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku varchar(80) NOT NULL,
  name varchar(180) NOT NULL,
  category varchar(60) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  cost_source varchar(60),
  current_price_cents integer NOT NULL CHECK (current_price_cents >= 0),
  current_estimated_unit_cost_cents integer CHECK (current_estimated_unit_cost_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  entity_type varchar(80) NOT NULL,
  entity_id uuid,
  action varchar(80) NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_time_idx
  ON audit_logs (tenant_id, occurred_at DESC);

