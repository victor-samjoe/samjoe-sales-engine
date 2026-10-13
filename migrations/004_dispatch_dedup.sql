-- Adiciona status 'dispatching' para evitar disparos duplicados.
-- Quando getDispatchJobs é chamado, os recipients são atomicamente marcados como
-- 'dispatching' (excluídos do próximo poll). O n8n confirma com 'sent'.
-- Se travar por > 15min, o serviço os devolve a 'queued' automaticamente.

ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_delivery_status_check;
ALTER TABLE campaign_recipients ADD CONSTRAINT campaign_recipients_delivery_status_check
  CHECK (delivery_status IN ('pending','queued','dispatching','sent','delivered','read','failed','cancelled'));

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

CREATE INDEX IF NOT EXISTS campaign_recipients_dispatching_idx
  ON campaign_recipients (tenant_id, dispatched_at)
  WHERE delivery_status = 'dispatching';
