import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";

// Import all route modules
import authRouter from "./auth";
import leaderboardRouter from "./leaderboard";
import restaurantsRouter from "./restaurants";
import posRouter from "./pos";
import hmeRouter from "./hme";
import osatRouter from "./osat";
import crewRouter from "./crew";
import scraperRouter from "./scraper";
import googleReviewsRouter from "./google-reviews";
import emailRouter from "./email";
import leaderDetailRouter from "./leader-detail";
import marketsRouter from "./markets";
import performanceHistoryRouter from "./performance-history";
import leadersRouter from "./leaders";
import historicalSalesRouter from "./historical-sales";
import salesPlanRouter from "./sales-plan";
import analyticsRouter from "./analytics";
import notesRouter from "./notes";
import tickerRouter from "./ticker";
import pollsRouter from "./polls";
import pushReportRouter, { registerPublicShareRoute } from "./push-report";
import aiAnalysisRouter from "./ai-analysis";
import executiveSummaryRouter from "./executive-summary";
import surveyCaptureRouter from "./survey-capture";
import gradingConfigRouter from "./grading-config";
import helperRewardsRouter from "./helper-rewards";
import externalApiRouter, { adminApiKeysRouter } from "./external-api";

import { db } from "../db";
import { users, gradingConfig as gradingConfigTable, DEFAULT_GRADING_CONFIG, type GradingConfigData } from "@shared/schema";
import { eq } from "drizzle-orm";
import { invalidateGradingCache } from "./grading-config";

// Tiny per-user TTL cache so the dashboard's ~16 parallel API calls don't
// each do a SELECT on the users table. Deactivation propagates within 30s.
const userActiveCache = new Map<string, { active: boolean; expiresAt: number }>();
const USER_ACTIVE_TTL_MS = 30_000;

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  const userId = req.session.userId;
  const now = Date.now();
  let cached = userActiveCache.get(userId);
  if (!cached || cached.expiresAt <= now) {
    const [user] = await db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    cached = { active: !!user && !!user.isActive, expiresAt: now + USER_ACTIVE_TTL_MS };
    userActiveCache.set(userId, cached);
  }
  if (!cached.active) {
    userActiveCache.delete(userId);
    req.session.destroy((err) => {
      if (err) console.error("[auth] Session destroy error:", err);
    });
    return res.status(401).json({ message: "Account deactivated" });
  }
  return next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Auth routes (no auth required) — must be registered before middleware
  app.use(authRouter);

  // Public shared report route (no auth required)
  registerPublicShareRoute(app);

  // Auth middleware — protect all /api/* routes except auth, diagnostics, and webhooks
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const openPaths = [
      "/api/auth/",
      "/api/diagnostics",
      "/api/db-status",
      "/api/xenial/",
      "/api/push-report/shared/",
      "/api/v1/",  // external API — uses its own apiKeyAuth middleware
    ];
    const fullPath = req.originalUrl.split('?')[0];
    if (openPaths.some(p => fullPath.startsWith(p))) {
      return next();
    }
    return requireAuth(req, res, next);
  });

  // Register all route modules
  app.use(leaderboardRouter);
  app.use(restaurantsRouter);
  app.use(posRouter);
  app.use(hmeRouter);
  app.use(osatRouter);
  app.use(crewRouter);
  app.use(scraperRouter);
  app.use(googleReviewsRouter);
  app.use(emailRouter);
  app.use(leaderDetailRouter);
  app.use(marketsRouter);
  app.use(performanceHistoryRouter);
  app.use(leadersRouter);
  app.use(historicalSalesRouter);
  app.use(salesPlanRouter);
  app.use(analyticsRouter);
  app.use(notesRouter);
  app.use(tickerRouter);
  app.use(pollsRouter);
  app.use(pushReportRouter);
  app.use(aiAnalysisRouter);
  app.use(executiveSummaryRouter);
  app.use(surveyCaptureRouter);
  app.use(gradingConfigRouter);
  app.use(helperRewardsRouter);
  app.use(adminApiKeysRouter);  // admin key management (session auth enforced inside)
  app.use(externalApiRouter);   // /api/v1/* external API (api-key auth enforced inside)

  // Diagnostic: verify server has latest code
  app.get("/api/grading-config/ping", (_req: Request, res: Response) => {
    res.json({ ok: true, version: "v3-direct-post", timestamp: new Date().toISOString() });
  });

  // Grading config save — registered directly on app to avoid Router matching issues
  app.post("/api/grading-config/save", async (req: Request, res: Response) => {
    console.log("[grading-config] POST handler reached (direct registration)");
    try {
      const config = req.body as GradingConfigData;
      const { weights } = config;
      if (!weights || !config.salesTiers || !config.osatTiers || !config.speedTiers || !config.transactionTiers || !config.feedbackSpeedTiers) {
        return res.status(400).json({ message: "Missing required configuration fields" });
      }
      const totalWeight =
        weights.sales +
        weights.transactions +
        weights.osat +
        weights.speed +
        weights.staffing +
        (weights.feedbackSpeed ?? 0);
      if (totalWeight !== 100) {
        return res.status(400).json({ message: `Weights must sum to 100 (currently ${totalWeight})` });
      }
      if (config.staffingTolerance === undefined || config.staffingTolerance < 0) {
        return res.status(400).json({ message: "Staffing tolerance must be >= 0" });
      }
      await db.delete(gradingConfigTable);
      const [row] = await db.insert(gradingConfigTable).values({
        config,
        updatedBy: req.session?.userId || "unknown",
      }).returning();
      console.log("[grading-config] Saved successfully, id:", row.id);
      invalidateGradingCache();
      return res.json(row.config);
    } catch (error) {
      console.error("[grading-config] POST error:", error);
      return res.status(500).json({ message: "Failed to save grading configuration" });
    }
  });

  // Version/diagnostics endpoint to verify production deployment
  app.get("/api/version", (req, res) => {
    res.json({
      version: process.env.npm_package_version || "2.1.0",
      buildTime: new Date().toISOString(),
      features: {
        leaderNames: true,
        experienceScores: true,
        hmeTimers: true,
        googleReviews: true,
      },
      deployedAt: process.env.REPLIT_DEPLOYMENT_ID || "development",
    });
  });

  return httpServer;
}
