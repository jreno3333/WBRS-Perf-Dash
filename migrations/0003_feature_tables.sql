CREATE TABLE IF NOT EXISTS ticker_messages (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'immediate',
  priority TEXT NOT NULL DEFAULT 'normal',
  scheduled_at TIMESTAMP,
  expires_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  restaurant_id VARCHAR,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS milestone_config (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  milestone_types JSONB NOT NULL DEFAULT '{"hourlyRecord":true,"dailySalesRecord":true,"fastestDriveThru":true,"topCheckAverage":true,"paceLeader":true}',
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS polls (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  allow_multiple_votes BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMP,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_options (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id VARCHAR NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id VARCHAR NOT NULL,
  option_id VARCHAR NOT NULL,
  voter_id TEXT NOT NULL,
  voted_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grading_config (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  config JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS daily_google_reviews (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id VARCHAR NOT NULL,
  date TEXT NOT NULL,
  rating DECIMAL(2, 1),
  review_count INTEGER,
  last_synced_at TIMESTAMP DEFAULT now(),
  is_final_snapshot BOOLEAN DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_google_reviews_restaurant_date_idx
  ON daily_google_reviews (restaurant_id, date);

CREATE TABLE IF NOT EXISTS helper_rewards (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id VARCHAR NOT NULL,
  date TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS helper_rewards_restaurant_date_idx
  ON helper_rewards (restaurant_id, date);
