CREATE TABLE IF NOT EXISTS "report_share_tokens" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "token" text NOT NULL UNIQUE,
  "restaurant_id" varchar NOT NULL,
  "date" text NOT NULL,
  "created_by" text,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
