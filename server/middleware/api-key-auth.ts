import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "../db";
import { apiKeys } from "@shared/schema";
import { eq } from "drizzle-orm";

const keyCache = new Map<string, { valid: boolean; keyId: string; expiresAt: number }>();
const KEY_CACHE_TTL_MS = 30_000;

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header. Use: Authorization: Bearer <api-key>" });
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) {
    return res.status(401).json({ error: "Empty API key" });
  }

  const hash = hashKey(rawKey);
  const now = Date.now();

  const cached = keyCache.get(hash);
  if (cached && cached.expiresAt > now) {
    if (!cached.valid) return res.status(401).json({ error: "Invalid or revoked API key" });
    db.update(apiKeys).set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, cached.keyId))
      .catch(() => {});
    return next();
  }

  try {
    const [row] = await db.select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!row || row.revokedAt !== null) {
      keyCache.set(hash, { valid: false, keyId: "", expiresAt: now + KEY_CACHE_TTL_MS });
      return res.status(401).json({ error: "Invalid or revoked API key" });
    }

    keyCache.set(hash, { valid: true, keyId: row.id, expiresAt: now + KEY_CACHE_TTL_MS });
    db.update(apiKeys).set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => {});

    return next();
  } catch (err) {
    console.error("[api-key-auth] DB error:", err);
    return res.status(500).json({ error: "Internal server error during authentication" });
  }
}

export function purgeApiKeyCache(hash?: string) {
  if (hash) keyCache.delete(hash);
  else keyCache.clear();
}
