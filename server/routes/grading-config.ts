import { Router } from "express";
import { db } from "../db";
import { gradingConfig, DEFAULT_GRADING_CONFIG, mergeGradingConfig, type GradingConfigData } from "@shared/schema";
import { desc } from "drizzle-orm";

const router = Router();

/** GET /api/grading-config — return the active grading configuration */
router.get("/api/grading-config", async (_req, res) => {
  try {
    const rows = await db.select().from(gradingConfig).orderBy(desc(gradingConfig.updatedAt)).limit(1);
    if (rows.length === 0) {
      return res.json(DEFAULT_GRADING_CONFIG);
    }
    return res.json(mergeGradingConfig(rows[0].config as Partial<GradingConfigData>));
  } catch (error) {
    console.error("[grading-config] GET error:", error);
    return res.json(DEFAULT_GRADING_CONFIG);
  }
});

export default router;

// ── Cached config loader (5-minute TTL) ──
let _cachedConfig: GradingConfigData | null = null;
let _cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function invalidateGradingCache() {
  _cachedConfig = null;
  _cacheExpiry = 0;
}

/** Helper to load active grading config for server-side scoring (cached) */
export async function getActiveGradingConfig(): Promise<GradingConfigData> {
  if (_cachedConfig && Date.now() < _cacheExpiry) return _cachedConfig;
  try {
    const rows = await db.select().from(gradingConfig).orderBy(desc(gradingConfig.updatedAt)).limit(1);
    _cachedConfig = rows.length > 0
      ? mergeGradingConfig(rows[0].config as Partial<GradingConfigData>)
      : DEFAULT_GRADING_CONFIG;
    _cacheExpiry = Date.now() + CACHE_TTL;
    return _cachedConfig;
  } catch {
    return DEFAULT_GRADING_CONFIG;
  }
}
