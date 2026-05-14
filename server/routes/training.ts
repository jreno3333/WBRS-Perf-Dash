import { Router, Request, Response } from "express";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { syncTrainingPlatform, isTrainingApiConfigured } from "../scraper/training-api";
import { storage } from "../storage";

const router = Router();

// Admin-only middleware (mirrors pattern in routes/external-api.ts)
function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  db.select({ role: users.role })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .limit(1)
    .then(([user]) => {
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: "Server error" }));
}

// POST /api/training/sync — manually trigger a training platform sync
router.post("/api/training/sync", requireAdmin as any, async (_req: Request, res: Response) => {
  try {
    if (!isTrainingApiConfigured()) {
      return res.status(503).json({
        error: "Training API not configured",
        message: "Set TRAINING_API_BASE_URL and TRAINING_API_KEY environment variables.",
      });
    }
    const result = await syncTrainingPlatform();
    // Return non-2xx when the underlying sync reports failure so ops tooling
    // gets a clear signal (502 = upstream/data error, body still includes details).
    if (!result.success) {
      return res.status(502).json(result);
    }
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[training/sync] error:", msg);
    return res.status(500).json({ error: "Sync failed", message: msg });
  }
});

// GET /api/training/sync-status — last run, counts, unmapped IDs, configured?
router.get("/api/training/sync-status", requireAdmin as any, async (_req: Request, res: Response) => {
  try {
    const status = await storage.getTrainingSyncStatus();
    return res.json({
      configured: isTrainingApiConfigured(),
      lastSync: status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "Failed to load sync status", message: msg });
  }
});

export default router;
