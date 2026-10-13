-- Demographics on contacts (future targeting by gender/age)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gender varchar(10) CHECK (gender IN ('M', 'F', 'other'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS birth_date date;

-- Order line items for product-level audience analysis
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversion_id uuid NOT NULL REFERENCES campaign_conversions(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  external_product_id varchar(255),
  product_name varchar(180),
  category varchar(60),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents integer NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_contact_product_idx
  ON order_items (tenant_id, contact_id, product_id);
CREATE INDEX IF NOT EXISTS order_items_conversion_idx
  ON order_items (tenant_id, conversion_id);
CREATE INDEX IF NOT EXISTS order_items_ext_product_idx
  ON order_items (tenant_id, external_product_id);

-- Saved audience segments
CREATE TABLE IF NOT EXISTS audiences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(180) NOT NULL,
  description text,
  rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_count integer,
  last_evaluated_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audiences_tenant_idx ON audiences (tenant_id, created_at DESC);

-- Single-dispatch mode for campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS dispatch_mode varchar(20) NOT NULL DEFAULT 'standard'
  CHECK (dispatch_mode IN ('standard', 'single'));
