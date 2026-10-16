-- Keep every active order for WhatsApp context routing.
CREATE TABLE IF NOT EXISTS se_contact_open_orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  external_order_id varchar(255) NOT NULL,
  order_ref varchar(100) NOT NULL,
  status varchar(50) NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, external_order_id)
);

CREATE INDEX IF NOT EXISTS se_contact_open_orders_contact_idx
  ON se_contact_open_orders (tenant_id, contact_id, status_updated_at DESC);

-- Preserve any singular context recorded before this migration.
INSERT INTO se_contact_open_orders
  (tenant_id, contact_id, external_order_id, order_ref, status)
SELECT tenant_id, id, open_order_ref, open_order_ref, open_order_status
  FROM contacts
 WHERE open_order_ref IS NOT NULL
   AND open_order_status IS NOT NULL
ON CONFLICT (tenant_id, external_order_id) DO NOTHING;
