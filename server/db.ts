import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

// Check which database URLs are available (empty strings treated as not set)
// XPOSSHARED_DATABASE_URL is the shared Xenial POS database (only for pos_orders)
// DATABASE_URL is the main app database (restaurants, sales, labor, etc.)
const xposSharedDbUrl = process.env.XPOSSHARED_DATABASE_URL?.trim() || '';
const sharedDbUrl = process.env.SHARED_DATABASE_URL?.trim() || '';
const defaultDbUrl = process.env.DATABASE_URL?.trim() || '';

const isProduction = process.env.NODE_ENV === 'production';

// Log availability (without exposing values)
console.log(`[db] Environment: ${isProduction ? 'production' : 'development'}`);
console.log(`[db] XPOSSHARED_DATABASE_URL: ${xposSharedDbUrl ? 'set (' + xposSharedDbUrl.length + ' chars)' : 'not set'}`);
console.log(`[db] SHARED_DATABASE_URL: ${sharedDbUrl ? 'set (' + sharedDbUrl.length + ' chars)' : 'not set'}`);
console.log(`[db] DATABASE_URL: ${defaultDbUrl ? 'set (' + defaultDbUrl.length + ' chars)' : 'not set'}`);

// Main database: DATABASE_URL for all app tables (restaurants, sales, labor, etc.)
// Falls back to XPOSSHARED if DATABASE_URL not available
const mainDatabaseUrl = defaultDbUrl || xposSharedDbUrl || sharedDbUrl;

// POS database: XPOSSHARED_DATABASE_URL for pos_orders table (shared between apps)
// Falls back to DATABASE_URL if XPOSSHARED not available  
const posDatabaseUrl = xposSharedDbUrl || defaultDbUrl || sharedDbUrl;

console.log(`[db] Main DB: ${defaultDbUrl ? 'DATABASE_URL' : (xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : 'SHARED_DATABASE_URL')}`);
console.log(`[db] POS DB: ${xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : (defaultDbUrl ? 'DATABASE_URL' : 'SHARED_DATABASE_URL')}`);

if (!mainDatabaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Main pool/db - for restaurants, sales, labor, and all app tables
export const pool = new Pool({ connectionString: mainDatabaseUrl });
export const db = drizzle(pool, { schema });

// POS pool/db - for pos_orders table (shared between apps)
// Only create separate pool if XPOSSHARED is different from main DB
const posDbIsSeparate = xposSharedDbUrl && xposSharedDbUrl !== mainDatabaseUrl;
export const posPool = posDbIsSeparate ? new Pool({ connectionString: posDatabaseUrl }) : pool;
export const posDb = posDbIsSeparate ? drizzle(posPool, { schema }) : db;

console.log(`[db] POS DB separate: ${posDbIsSeparate ? 'yes' : 'no (same as main)'}`);

// Auto-create new feature tables if they don't exist (ticker, polls, milestones)
export async function ensureFeatureTables() {
  try {
    await pool.query(`
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
    `);
    console.log("[db] Feature tables (ticker, polls, milestones, grading_config, daily_google_reviews) ready");
  } catch (error) {
    console.error("[db] Failed to ensure feature tables:", error);
  }
}
