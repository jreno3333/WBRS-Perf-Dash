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

// Main pool/db - for restaurants, sales, labor, and all app tables
export const pool = new Pool({ connectionString: mainDatabaseUrl });
export const db = drizzle(pool, { schema });

// POS pool/db - for pos_orders table (shared between apps)
// Only create separate pool if XPOSSHARED is different from main DB
const posDbIsSeparate = xposSharedDbUrl && xposSharedDbUrl !== mainDatabaseUrl;
export const posPool = posDbIsSeparate ? new Pool({ connectionString: posDatabaseUrl }) : pool;
export const posDb = posDbIsSeparate ? drizzle(posPool, { schema }) : db;

console.log(`[db] POS DB separate: ${posDbIsSeparate ? 'yes' : 'no (same as main)'}`);

export async function ensureFeatureTables() {
  try {
    const migrationsDir = join(process.cwd(), 'migrations');
    const featureTablesSql = readFileSync(join(migrationsDir, '0003_feature_tables.sql'), 'utf-8');
    const indexesSql = readFileSync(join(migrationsDir, '0004_hourly_sales_indexes.sql'), 'utf-8');
    await pool.query(featureTablesSql);
    await pool.query(indexesSql);
    console.log("[db] Feature tables (ticker, polls, milestones, grading_config, daily_google_reviews, helper_rewards) ready");
  } catch (error) {
    console.error("[db] Failed to ensure feature tables:", error);
  }
}
