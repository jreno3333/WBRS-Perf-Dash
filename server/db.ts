import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

// In production, use SHARED_DATABASE_URL for sharing database across deployments
// In development, use DATABASE_URL (local development database has the tables)
const isProduction = process.env.NODE_ENV === 'production';
const databaseUrl = isProduction 
  ? (process.env.SHARED_DATABASE_URL || process.env.DATABASE_URL)
  : (process.env.DATABASE_URL || process.env.SHARED_DATABASE_URL);

// Log which database is being used (without exposing credentials)
const dbSource = isProduction 
  ? (process.env.SHARED_DATABASE_URL ? 'SHARED_DATABASE_URL' : 'DATABASE_URL')
  : (process.env.DATABASE_URL ? 'DATABASE_URL' : 'SHARED_DATABASE_URL');
console.log(`[db] Using ${dbSource} for database connection (env: ${process.env.NODE_ENV || 'development'})`);

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
