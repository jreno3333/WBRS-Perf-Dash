import { Router } from "express";
import { db } from "../db";
import { gradingConfig, DEFAULT_GRADING_CONFIG, type GradingConfigData } from "@shared/schema";
import { desc } from "drizzle-orm";

const router = Router();

/** GET /api/grading-config — return the active grading configuration */
router.get("/api/grading-config", async (_req, res) => {
  try {
    const rows = await db.select().from(gradingConfig).orderBy(desc(gradingConfig.updatedAt)).limit(1);
    if (rows.length === 0) {
      return res.json(DEFAULT_GRADING_CONFIG);
    }
    return res.json(rows[0].config);
  } catch (error) {
    console.error("[grading-config] GET error:", error);
    return res.json(DEFAULT_GRADING_CONFIG);
  }
});

/** POST /api/grading-config — update the grading configuration */
router.post("/api/grading-config", async (req, res) => {
  console.log("[grading-config] POST handler reached");
  try {
    const config = req.body as GradingConfigData;

    // Basic validation
    const { weights } = config;
    if (!weights || !config.salesTiers || !config.osatTiers || !config.speedTiers || !config.transactionTiers) {
      console.log("[grading-config] Validation failed: missing fields");
      return res.status(400).json({ message: "Missing required configuration fields" });
    }

    const totalWeight = weights.sales + weights.transactions + weights.osat + weights.speed + weights.staffing;
    if (totalWeight !== 100) {
      return res.status(400).json({ message: `Weights must sum to 100 (currently ${totalWeight})` });
    }

    if (config.staffingTolerance === undefined || config.staffingTolerance < 0) {
      return res.status(400).json({ message: "Staffing tolerance must be >= 0" });
    }

    // Upsert: delete all old rows, insert new one
    await db.delete(gradingConfig);
    const [row] = await db.insert(gradingConfig).values({
      config,
      updatedBy: (req.session as any)?.userId || "unknown",
    }).returning();

    console.log("[grading-config] Saved successfully, id:", row.id);
    invalidateCache();
    return res.json(row.config);
  } catch (error) {
    console.error("[grading-config] POST error:", error);
    return res.status(500).json({ message: "Failed to save grading configuration" });
  }
});

export default router;

// ── Cached config loader (5-minute TTL) ──
let _cachedConfig: GradingConfigData | null = null;
let _cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function invalidateCache() {
  _cachedConfig = null;
  _cacheExpiry = 0;
}

/** Helper to load active grading config for server-side scoring (cached) */
export async function getActiveGradingConfig(): Promise<GradingConfigData> {
  if (_cachedConfig && Date.now() < _cacheExpiry) return _cachedConfig;
  try {
    const rows = await db.select().from(gradingConfig).orderBy(desc(gradingConfig.updatedAt)).limit(1);
    _cachedConfig = rows.length > 0 ? (rows[0].config as GradingConfigData) : DEFAULT_GRADING_CONFIG;
    _cacheExpiry = Date.now() + CACHE_TTL;
    return _cachedConfig;
  } catch {
    return DEFAULT_GRADING_CONFIG;
  }
}
