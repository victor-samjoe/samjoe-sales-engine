ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS immediate_dispatch boolean NOT NULL DEFAULT true;
