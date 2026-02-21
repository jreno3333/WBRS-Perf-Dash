-- Add destination column to pos_orders for tracking order destinations (dt1, dt2, dt3, in, app)
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS destination TEXT;
