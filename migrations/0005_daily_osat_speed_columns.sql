-- Add Qualtrics customer-feedback speed-of-service aggregates to daily_osat.
-- These power the "DT Speed" badge on each store's leaderboard card.
-- Uses IF NOT EXISTS for safe re-runs.

ALTER TABLE "daily_osat"
  ADD COLUMN IF NOT EXISTS "dt_speed_sum" numeric(10,2) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "dt_speed_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "generic_speed_sum" numeric(10,2) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "generic_speed_count" integer DEFAULT 0 NOT NULL;
