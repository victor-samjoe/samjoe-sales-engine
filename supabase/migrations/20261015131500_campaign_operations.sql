ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS schedule_kind varchar(20) NOT NULL DEFAULT 'once'
  CHECK (schedule_kind IN ('once', 'recurring'));
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS next_dispatch_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS recurrence_days integer
  CHECK (recurrence_days IS NULL OR recurrence_days BETWEEN 1 AND 365);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_dispatched_at timestamptz;

CREATE INDEX IF NOT EXISTS campaigns_queue_operations_idx
  ON campaigns (tenant_id, archived_at, paused_at, next_dispatch_at);
