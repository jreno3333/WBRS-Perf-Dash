import { getBaseUrl } from "../base-url";
import { Router } from "express";
import { db } from "../db";
import { reportShareTokens, restaurants } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const router = Router();

// Preview a unit report for a specific restaurant and date
router.get("/api/push-report/preview", async (req, res) => {
  try {
    const { buildUnitReportHtml } = await import("../push-report");
    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = req.query.date as string || centralFormatter.format(yesterday);
    const restaurantId = req.query.unit as string;

    if (!restaurantId) {
      res.status(400).json({ error: "unit parameter is required" });
      return;
    }

    const html = await buildUnitReportHtml(dateStr, restaurantId);
    if (!html) {
      res.status(404).json({ error: "No data available for this unit/date" });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Error generating push report preview:", error);
    res.status(500).json({ error: "Failed to generate push report preview" });
  }
});

// Create a shareable link for a unit report
router.post("/api/push-report/share", async (req, res) => {
  try {
    const { date, restaurantId } = req.body;

    if (!date || !restaurantId) {
      res.status(400).json({ error: "date and restaurantId are required" });
      return;
    }

    // Check if a share token already exists for this restaurant+date
    const existing = await db.select().from(reportShareTokens)
      .where(and(
        eq(reportShareTokens.restaurantId, restaurantId),
        eq(reportShareTokens.date, date)
      ))
      .limit(1);

    if (existing.length > 0) {
      const baseUrl = getBaseUrl();

      res.json({
        token: existing[0].token,
        url: `${baseUrl}/api/push-report/shared/${existing[0].token}`,
        existing: true,
      });
      return;
    }

    // Generate a unique token
    const token = crypto.randomBytes(24).toString('hex');

    // Get user email from session
    const userEmail = req.session?.email || null;

    const [created] = await db.insert(reportShareTokens).values({
      token,
      restaurantId,
      date,
      createdBy: userEmail,
      expiresAt: null, // No expiration
    }).returning();

    const baseUrl = getBaseUrl();

    res.json({
      token: created.token,
      url: `${baseUrl}/api/push-report/shared/${created.token}`,
      existing: false,
    });
  } catch (error) {
    console.error("Error creating share link:", error);
    res.status(500).json({ error: "Failed to create share link" });
  }
});

// Send push reports manually (send-now)
router.post("/api/push-report/send-now", async (req, res) => {
  try {
    const { sendPushReports } = await import("../push-report");
    const result = await sendPushReports(true);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Error sending push reports:", error);
    res.status(500).json({ error: "Failed to send push reports" });
  }
});

// Send a single unit report to a specific email
router.post("/api/push-report/send-unit", async (req, res) => {
  try {
    const { date, restaurantId, email } = req.body;

    if (!date || !restaurantId || !email) {
      res.status(400).json({ error: "date, restaurantId, and email are required" });
      return;
    }

    const { buildUnitReportHtml } = await import("../push-report");
    const { sendDailyReportEmail } = await import("../email");

    const html = await buildUnitReportHtml(date, restaurantId);
    if (!html) {
      res.status(404).json({ error: "No data available for this unit/date" });
      return;
    }

    // Look up restaurant name
    const [rest] = await db.select().from(restaurants)
      .where(eq(restaurants.id, restaurantId)).limit(1);
    const restaurantName = rest?.name || restaurantId;

    const formattedDate = new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(new Date(`${date}T12:00:00`));

    const subject = `${restaurantName} - Performance Report - ${formattedDate}`;

    const sent = await sendDailyReportEmail(email, subject, html);

    res.json({ success: sent });
  } catch (error) {
    console.error("Error sending unit report:", error);
    res.status(500).json({ error: "Failed to send unit report" });
  }
});

export default router;

// Public shared report view - registered separately to bypass auth
export function registerPublicShareRoute(app: import("express").Express) {
  app.get("/api/push-report/shared/:token", async (req, res) => {
    try {
      const { token } = req.params;

      const [shareRecord] = await db.select().from(reportShareTokens)
        .where(eq(reportShareTokens.token, token))
        .limit(1);

      if (!shareRecord) {
        res.status(404).send(`
          <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h2>Report Not Found</h2>
            <p>This share link is invalid or has been removed.</p>
          </body></html>
        `);
        return;
      }

      // Check expiration
      if (shareRecord.expiresAt && new Date() > shareRecord.expiresAt) {
        res.status(410).send(`
          <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h2>Report Expired</h2>
            <p>This share link has expired.</p>
          </body></html>
        `);
        return;
      }

      const { buildUnitReportHtml } = await import("../push-report");
      const html = await buildUnitReportHtml(shareRecord.date, shareRecord.restaurantId);

      if (!html) {
        res.status(404).send(`
          <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
            <h2>No Data Available</h2>
            <p>No performance data is available for this date.</p>
          </body></html>
        `);
        return;
      }

      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch (error) {
      console.error("Error serving shared report:", error);
      res.status(500).send(`
        <html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
          <h2>Error</h2>
          <p>Failed to load report. Please try again.</p>
        </body></html>
      `);
    }
  });
}
