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
import analyticsRouter from "./analytics";
import notesRouter from "./notes";
import tickerRouter from "./ticker";
import pollsRouter from "./polls";
import pushReportRouter, { registerPublicShareRoute } from "./push-report";

import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  const [user] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user || !user.isActive) {
    req.session.destroy(() => {});
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
  app.use(analyticsRouter);
  app.use(notesRouter);
  app.use(tickerRouter);
  app.use(pollsRouter);
  app.use(pushReportRouter);

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
