import { Router, Request, Response } from "express";
import crypto from "crypto";
import { db } from "../db";
import { apiKeys } from "@shared/schema";
import { eq } from "drizzle-orm";
import { apiKeyAuth, purgeApiKeyCache } from "../middleware/api-key-auth";
import { storage } from "../storage";
import { users } from "@shared/schema";
import { buildLeaderboardResponse } from "./leaderboard";
import { buildExecutiveSummary } from "./executive-summary";
import { getPerfHistoryCached } from "./performance-history";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope<T>(data: T, extras?: Record<string, unknown>) {
  return {
    data,
    meta: {
      timestamp: new Date().toISOString(),
      generatedAt: Date.now(),
      ...extras,
    },
  };
}

function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  db.select({ role: users.role }).from(users)
    .where(eq(users.id, req.session.userId)).limit(1)
    .then(([user]) => {
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: "Server error" }));
}

// ---------------------------------------------------------------------------
// Admin key management — session-auth, protected by requireAuth in routes/index.ts
// ---------------------------------------------------------------------------

export const adminApiKeysRouter = Router();

adminApiKeysRouter.post("/api/admin/api-keys", requireAdmin as any, async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const rawKey = crypto.randomBytes(32).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 8);

    const [row] = await db.insert(apiKeys).values({
      name: name.trim(),
      keyHash,
      keyPrefix,
      createdBy: req.session?.userId,
    }).returning();

    return res.status(201).json({
      id: row.id,
      name: row.name,
      prefix: keyPrefix,
      plaintext: rawKey,
      createdAt: row.createdAt,
    });
  } catch (error) {
    console.error("[admin/api-keys] POST error:", error);
    return res.status(500).json({ error: "Failed to create API key" });
  }
});

adminApiKeysRouter.get("/api/admin/api-keys", requireAdmin as any, async (_req: Request, res: Response) => {
  try {
    const rows = await db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdBy: apiKeys.createdBy,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    }).from(apiKeys).orderBy(apiKeys.createdAt);

    return res.json(rows.map(r => ({
      ...r,
      status: r.revokedAt ? "revoked" : "active",
    })));
  } catch (error) {
    console.error("[admin/api-keys] GET error:", error);
    return res.status(500).json({ error: "Failed to list API keys" });
  }
});

adminApiKeysRouter.delete("/api/admin/api-keys/:id", requireAdmin as any, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [row] = await db.select({ keyHash: apiKeys.keyHash, revokedAt: apiKeys.revokedAt })
      .from(apiKeys).where(eq(apiKeys.id, id)).limit(1);

    if (!row) {
      return res.status(404).json({ error: "API key not found" });
    }
    if (row.revokedAt) {
      return res.status(409).json({ error: "API key already revoked" });
    }

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    purgeApiKeyCache(row.keyHash);

    return res.json({ ok: true, id });
  } catch (error) {
    console.error("[admin/api-keys] DELETE error:", error);
    return res.status(500).json({ error: "Failed to revoke API key" });
  }
});

// ---------------------------------------------------------------------------
// External read-only API — Bearer token auth via apiKeyAuth middleware
// ---------------------------------------------------------------------------

const externalApiRouter = Router();

externalApiRouter.use("/api/v1", apiKeyAuth as any);

// GET /api/v1/restaurants
// All active restaurants with metadata (name, timezone, location, etc.)
externalApiRouter.get("/api/v1/restaurants", async (_req: Request, res: Response) => {
  try {
    const restaurants = await storage.getRestaurants();
    return res.json(envelope(restaurants));
  } catch (error) {
    console.error("[v1/restaurants] error:", error);
    return res.status(500).json({ error: "Failed to fetch restaurants" });
  }
});

// GET /api/v1/leaderboard[?date=YYYY-MM-DD]
// Real-time sales leaderboard with weather, drive-thru, OSAT, and crew data
externalApiRouter.get("/api/v1/leaderboard", async (req: Request, res: Response) => {
  try {
    const date = req.query.date as string | undefined;
    const data = await buildLeaderboardResponse(date);
    return res.json(envelope(data));
  } catch (error) {
    console.error("[v1/leaderboard] error:", error);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// GET /api/v1/executive-summary[?days=7&date=YYYY-MM-DD]
// Aggregated KPI summary with current vs previous period comparisons, alerts, and market rollups
externalApiRouter.get("/api/v1/executive-summary", async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const date = req.query.date as string | undefined;
    const data = await buildExecutiveSummary({ days, date });
    return res.json(envelope(data));
  } catch (error) {
    console.error("[v1/executive-summary] error:", error);
    return res.status(500).json({ error: "Failed to fetch executive summary" });
  }
});

// GET /api/v1/performance-history[?days=7]
// Daily execution grades per restaurant over the last N completed days.
// Served from a 5-minute server-side cache — returns 503 if the cache is not yet warm
// (load the dashboard once to prime it, or wait up to 5 minutes after server start).
externalApiRouter.get("/api/v1/performance-history", async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const cached = getPerfHistoryCached(days);
    if (!cached) {
      return res.status(503).json({
        error: "Performance history cache is not yet warm. Retry in up to 5 minutes.",
      });
    }
    return res.json(envelope(cached.data, { stale: cached.stale }));
  } catch (error) {
    console.error("[v1/performance-history] error:", error);
    return res.status(500).json({ error: "Failed to fetch performance history" });
  }
});

// GET /api/v1/snapshot
// Single call returning all key metrics. Uses Promise.allSettled so a partial
// failure (e.g., HME unavailable) returns degraded data rather than a 500.
externalApiRouter.get("/api/v1/snapshot", async (req: Request, res: Response) => {
  try {
    const [leaderboardResult, execSummaryResult, restaurantsResult] = await Promise.allSettled([
      buildLeaderboardResponse(),
      buildExecutiveSummary({ days: 7 }),
      storage.getRestaurants(),
    ]);

    const perfDays = parseInt(req.query.days as string) || 7;
    const perfCached = getPerfHistoryCached(perfDays);

    const snapshot: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    if (leaderboardResult.status === "fulfilled") {
      snapshot.leaderboard = leaderboardResult.value;
    } else {
      errors.leaderboard = leaderboardResult.reason?.message || "failed";
    }

    if (execSummaryResult.status === "fulfilled") {
      snapshot.executiveSummary = execSummaryResult.value;
    } else {
      errors.executiveSummary = execSummaryResult.reason?.message || "failed";
    }

    if (restaurantsResult.status === "fulfilled") {
      snapshot.restaurants = restaurantsResult.value;
    } else {
      errors.restaurants = restaurantsResult.reason?.message || "failed";
    }

    if (perfCached) {
      snapshot.performanceHistory = perfCached.data;
    }

    const hasErrors = Object.keys(errors).length > 0;
    const statusCode = Object.keys(snapshot).length === 0 ? 500 : 200;

    return res.status(statusCode).json(envelope(snapshot, {
      errors: hasErrors ? errors : undefined,
      partial: hasErrors,
    }));
  } catch (error) {
    console.error("[v1/snapshot] error:", error);
    return res.status(500).json({ error: "Failed to fetch snapshot" });
  }
});

export default externalApiRouter;
