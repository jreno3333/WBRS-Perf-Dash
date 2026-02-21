-- Add destination column to pos_orders for tracking order destinations (dt1, dt2, dt3, in, app)
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS destination TEXT;

-- Backfill destination from raw_json for all existing records
-- The webhook stores the full payload as JSON: { data: { destination: { short_name: "dt3" } } }
UPDATE pos_orders
SET destination = raw_json::jsonb -> 'data' -> 'destination' ->> 'short_name'
WHERE destination IS NULL
  AND raw_json IS NOT NULL
  AND raw_json::jsonb -> 'data' -> 'destination' ->> 'short_name' IS NOT NULL;
