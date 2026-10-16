CREATE TABLE IF NOT EXISTS public.se_consent_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  channel varchar(30) NOT NULL,
  purpose varchar(30) NOT NULL CHECK (purpose IN ('marketing', 'order_updates')),
  action varchar(20) NOT NULL CHECK (action IN ('granted', 'revoked')),
  source varchar(60) NOT NULL,
  evidence_ref varchar(255),
  policy_version varchar(40) NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS se_consent_events_lookup_idx
  ON public.se_consent_events (tenant_id, contact_id, channel, purpose, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.se_consent_events TO sales_engine_app;
