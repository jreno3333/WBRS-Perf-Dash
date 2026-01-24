import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

// Check which database URLs are available (empty strings treated as not set)
// XPOSSHARED_DATABASE_URL is the shared Xenial POS database (primary for production)
const xposSharedDbUrl = process.env.XPOSSHARED_DATABASE_URL?.trim() || '';
const sharedDbUrl = process.env.SHARED_DATABASE_URL?.trim() || '';
const defaultDbUrl = process.env.DATABASE_URL?.trim() || '';

// Log availability (without exposing values)
console.log(`[db] Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`[db] XPOSSHARED_DATABASE_URL: ${xposSharedDbUrl ? 'set (' + xposSharedDbUrl.length + ' chars)' : 'not set'}`);
console.log(`[db] SHARED_DATABASE_URL: ${sharedDbUrl ? 'set (' + sharedDbUrl.length + ' chars)' : 'not set'}`);
console.log(`[db] DATABASE_URL: ${defaultDbUrl ? 'set (' + defaultDbUrl.length + ' chars)' : 'not set'}`);

// Priority: XPOSSHARED_DATABASE_URL > SHARED_DATABASE_URL > DATABASE_URL
// In production, prefer XPOSSHARED for the shared Xenial POS database
// In development, prefer DATABASE_URL (local dev database)
const isProduction = process.env.NODE_ENV === 'production';
const databaseUrl = isProduction 
  ? (xposSharedDbUrl || sharedDbUrl || defaultDbUrl)
  : (defaultDbUrl || xposSharedDbUrl || sharedDbUrl);

// Log which database is being used
let dbSource = 'DATABASE_URL';
if (isProduction) {
  dbSource = xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : (sharedDbUrl ? 'SHARED_DATABASE_URL' : 'DATABASE_URL');
} else {
  dbSource = defaultDbUrl ? 'DATABASE_URL' : (xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : 'SHARED_DATABASE_URL');
}
console.log(`[db] Selected: ${dbSource}`);

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
