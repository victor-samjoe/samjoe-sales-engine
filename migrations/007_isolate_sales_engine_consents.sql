-- public.consent_events belongs to SamJoE Food and requires customer_id.
-- Keep Sales Engine consent history in an explicitly namespaced table.
CREATE TABLE IF NOT EXISTS se_consent_events (
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

CREATE INDEX IF NOT EXISTS se_consent_events_lookup_idx
  ON se_consent_events (tenant_id, contact_id, channel, purpose, occurred_at DESC);
