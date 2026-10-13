-- Rename integration type 'foodapp' -> 'samjoe_food'

ALTER TABLE integration_connections
  DROP CONSTRAINT IF EXISTS integration_connections_integration_type_check;

UPDATE integration_connections
  SET integration_type = 'samjoe_food'
  WHERE integration_type = 'foodapp';

ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_integration_type_check
    CHECK (integration_type IN ('samjoe_food', 'n8n', 'evolution'));

-- Rename source references in related tables (only if tables exist)
UPDATE contacts
  SET origin = 'samjoe_food'
  WHERE origin = 'foodapp';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'external_customer_links') THEN
    UPDATE external_customer_links SET source = 'samjoe_food' WHERE source = 'foodapp';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'campaign_conversions') THEN
    UPDATE campaign_conversions SET source = 'samjoe_food' WHERE source = 'foodapp';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_records') THEN
    UPDATE consent_records SET channel = 'samjoe_food' WHERE channel = 'foodapp';
    UPDATE consent_records SET source = 'samjoe_food_signup' WHERE source = 'foodapp_signup';
  END IF;
END $$;
