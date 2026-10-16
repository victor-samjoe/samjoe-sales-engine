-- Track open order state per contact for WhatsApp context routing
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS open_order_ref     varchar(100),
  ADD COLUMN IF NOT EXISTS open_order_status  varchar(30);
