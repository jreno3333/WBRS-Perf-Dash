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

// GET /api/training/employee/:employeeId — per-employee training detail
router.get("/api/training/employee/:employeeId", async (req: Request, res: Response) => {
  try {
    const employeeId = String(req.params.employeeId);
    const [summaries, employeeRow] = await Promise.all([
      storage.getTrainingSummariesForEmployees([employeeId]),
      storage.getEmployeeById(employeeId),
    ]);
    const summary = summaries.get(employeeId);
    const position = (employeeRow?.position || "").toLowerCase();
    const isShiftPlus = position.includes("manager") || position.includes("supervisor");
    const certifications = summary?.certifications || [];
    const hasFiveStarFloor = certifications.some((c) => c.key === "5_star_floor_management");
    const fiveStarEligible = isShiftPlus;
    if (!summary) {
      return res.json({
        employeeId,
        position: employeeRow?.position ?? null,
        isShiftPlus,
        fiveStarEligible,
        hasFiveStarFloor,
        percentComplete: 0,
        totalCourses: 0,
        completedCourses: 0,
        inProgressCourses: 0,
        overdueCourses: 0,
        outstandingCourses: [],
        completedByCategory: {},
        certifications: [],
      });
    }
    return res.json({
      employeeId,
      position: employeeRow?.position ?? null,
      isShiftPlus,
      fiveStarEligible,
      hasFiveStarFloor,
      ...summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "Failed to load training detail", message: msg });
  }
});

// POST /api/training/employees-bulk — body: { employeeIds: string[] }
router.post("/api/training/employees-bulk", async (req: Request, res: Response) => {
  try {
    const ids: string[] = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds : [];
    if (ids.length === 0) return res.json({ summaries: {} });
    const summaries = await storage.getTrainingSummariesForEmployees(ids);
    type SummaryValue = ReturnType<typeof summaries.get>;
    const out: Record<string, SummaryValue> = {};
    summaries.forEach((s, id) => { out[id] = s; });
    return res.json({ summaries: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "Failed to load bulk training", message: msg });
  }
});

// GET /api/training/units — per-restaurant rollup map for all units
router.get("/api/training/units", async (_req: Request, res: Response) => {
  try {
    const rollups = await storage.getTrainingRollupsAll();
    type RollupValue = ReturnType<typeof rollups.get>;
    const out: Record<string, RollupValue> = {};
    rollups.forEach((r, rid) => { out[rid] = r; });
    return res.json({ rollups: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "Failed to load unit rollups", message: msg });
  }
});

// GET /api/training/unit/:restaurantId — unit detail with per-employee training table
router.get("/api/training/unit/:restaurantId", async (req: Request, res: Response) => {
  try {
    const restaurantId = String(req.params.restaurantId);
    const employees = await storage.getEmployeesByRestaurant(restaurantId);
    const ids = employees.map((e) => e.id);
    const summaries = await storage.getTrainingSummariesForEmployees(ids);
    const rollup = (await storage.getTrainingRollupsAll()).get(restaurantId) || null;
    const employeeRows = employees.map((e) => {
      const s = summaries.get(e.id);
      const certs = s?.certifications || [];
      return {
        employeeId: e.id,
        name: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
        position: e.position,
        type: e.type,
        percentComplete: s?.percentComplete ?? 0,
        totalCourses: s?.totalCourses ?? 0,
        completedCourses: s?.completedCourses ?? 0,
        overdueCourses: s?.overdueCourses ?? 0,
        inProgressCourses: s?.inProgressCourses ?? 0,
        certifications: certs,
        hasFiveStarFloor: certs.some((c) => c.key === "5_star_floor_management"),
      };
    });
    return res.json({ restaurantId, rollup, employees: employeeRows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "Failed to load unit training", message: msg });
  }
});

export default router;
