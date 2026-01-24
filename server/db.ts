import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

// Check which database URLs are available (empty strings treated as not set)
const sharedDbUrl = process.env.SHARED_DATABASE_URL?.trim() || '';
const defaultDbUrl = process.env.DATABASE_URL?.trim() || '';

// Log availability (without exposing values)
console.log(`[db] Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`[db] SHARED_DATABASE_URL: ${sharedDbUrl ? 'set (' + sharedDbUrl.length + ' chars)' : 'not set'}`);
console.log(`[db] DATABASE_URL: ${defaultDbUrl ? 'set (' + defaultDbUrl.length + ' chars)' : 'not set'}`);

// In production, prefer SHARED_DATABASE_URL for cross-deployment database sharing
// In development, prefer DATABASE_URL (local dev database)
const isProduction = process.env.NODE_ENV === 'production';
const databaseUrl = isProduction 
  ? (sharedDbUrl || defaultDbUrl)
  : (defaultDbUrl || sharedDbUrl);

// Log which database is being used
const dbSource = isProduction 
  ? (sharedDbUrl ? 'SHARED_DATABASE_URL' : 'DATABASE_URL')
  : (defaultDbUrl ? 'DATABASE_URL' : 'SHARED_DATABASE_URL');
console.log(`[db] Selected: ${dbSource}`);

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
