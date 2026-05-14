import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { readFileSync } from "fs";
import { join } from "path";

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

// Pool sizing: the leaderboard endpoint fans out to ~6 parallel queries and
// the dashboard fires ~16 endpoints in parallel on first paint, so the pg
// default of 10 connections gets contended. Bump to 20 with a connection
// timeout so a stuck pool surfaces fast instead of hanging the request.
const POOL_OPTIONS = {
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
} as const;

// Main pool/db - for restaurants, sales, labor, and all app tables
export const pool = new Pool({ connectionString: mainDatabaseUrl, ...POOL_OPTIONS });
export const db = drizzle(pool, { schema });

// POS pool/db - for pos_orders table (shared between apps)
// Only create separate pool if XPOSSHARED is different from main DB
const posDbIsSeparate = xposSharedDbUrl && xposSharedDbUrl !== mainDatabaseUrl;
export const posPool = posDbIsSeparate
  ? new Pool({ connectionString: posDatabaseUrl, ...POOL_OPTIONS })
  : pool;
export const posDb = posDbIsSeparate ? drizzle(posPool, { schema }) : db;

console.log(`[db] POS DB separate: ${posDbIsSeparate ? 'yes' : 'no (same as main)'}`);

export async function ensureFeatureTables() {
  try {
    const migrationsDir = join(process.cwd(), 'migrations');
    const featureTablesSql = readFileSync(join(migrationsDir, '0003_feature_tables.sql'), 'utf-8');
    const indexesSql = readFileSync(join(migrationsDir, '0004_hourly_sales_indexes.sql'), 'utf-8');
    const dailyOsatSpeedSql = readFileSync(join(migrationsDir, '0005_daily_osat_speed_columns.sql'), 'utf-8');
    const apiKeysSql = readFileSync(join(migrationsDir, '0006_api_keys.sql'), 'utf-8');
    const trainingSql = readFileSync(join(migrationsDir, '0007_training_platform_tables.sql'), 'utf-8');
    await pool.query(featureTablesSql);
    await pool.query(indexesSql);
    await pool.query(dailyOsatSpeedSql);
    await pool.query(apiKeysSql);
    await pool.query(trainingSql);
    console.log("[db] Feature tables (ticker, polls, milestones, grading_config, daily_google_reviews, helper_rewards, daily_osat speed columns, api_keys, training_platform) ready");
  } catch (error) {
    console.error("[db] Failed to ensure feature tables:", error);
  }
}
