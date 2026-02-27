import { Router } from "express";
import { db } from "../db";
import { emailAlerts, restaurants, dailySales } from "@shared/schema";
import { eq, desc, sql, and, gte, lte, count } from "drizzle-orm";
import { classifyEmailAlert } from "../email-alert-classifier";
import type { ComplaintIndexData, ComplaintDashboardData } from "@shared/schema";

const router = Router();

// ─── Zapier Webhook: Ingest email alerts ────────────────────────────────────
// This endpoint is called by Zapier when a new email arrives in Gmail.
// It's open (no session auth) but secured by an optional webhook secret.
// Zapier sends: { subject, body, from, date, zapier_id }

router.post("/api/zapier/email-alerts", async (req, res) => {
  try {
    // Optional webhook secret verification
    const webhookSecret = process.env.EMAIL_ALERT_WEBHOOK_SECRET;
    if (webhookSecret) {
      const provided = req.headers["x-webhook-secret"] || req.body?.webhook_secret;
      if (provided !== webhookSecret) {
        return res.status(401).json({ error: "Invalid webhook secret" });
      }
    }

    const {
      subject,
      body,
      body_text,
      from,
      sender,
      date,
      email_date,
      zapier_id,
      external_id,
      // Allow explicit overrides from Zapier
      restaurant_name,
      restaurant_id,
      sentiment: explicitSentiment,
      category: explicitCategory,
    } = req.body;

    const emailSubject = subject || "(No subject)";
    const emailBody = body_text || body || null;
    const senderEmail = from || sender || null;
    const emailDateParsed = date || email_date ? new Date(date || email_date) : null;
    const dedupeId = zapier_id || external_id || null;

    // Dedup check: skip if we already have this external_id
    if (dedupeId) {
      const existing = await db
        .select({ id: emailAlerts.id })
        .from(emailAlerts)
        .where(eq(emailAlerts.externalId, dedupeId))
        .limit(1);
      if (existing.length > 0) {
        return res.json({ status: "duplicate", id: existing[0].id });
      }
    }

    // Classify the email
    const classification = await classifyEmailAlert(emailSubject, emailBody);

    const [alert] = await db
      .insert(emailAlerts)
      .values({
        restaurantId: restaurant_id || classification.restaurantId,
        restaurantName: restaurant_name || classification.restaurantName,
        subject: emailSubject,
        bodyText: emailBody,
        senderEmail: senderEmail,
        sentiment: explicitSentiment || classification.sentiment,
        category: explicitCategory || classification.category,
        severity: classification.severity,
        source: "zapier",
        externalId: dedupeId,
        rawPayload: req.body,
        emailDate: emailDateParsed,
      })
      .returning();

    console.log(
      `[email-alerts] Ingested alert: ${alert.id} | sentiment=${alert.sentiment} | category=${alert.category} | restaurant=${alert.restaurantName || "unmatched"}`
    );

    res.json({
      status: "ok",
      id: alert.id,
      sentiment: alert.sentiment,
      category: alert.category,
      severity: alert.severity,
      restaurantName: alert.restaurantName,
    });
  } catch (error) {
    console.error("[email-alerts] Webhook error:", error);
    res.status(500).json({ error: "Failed to process email alert" });
  }
});

// ─── Manual alert submission (from dashboard) ───────────────────────────────

router.post("/api/email-alerts", async (req, res) => {
  try {
    const { subject, bodyText, senderEmail, restaurantId, sentiment, category, severity, emailDate } = req.body;

    if (!subject) {
      return res.status(400).json({ error: "Subject is required" });
    }

    // If restaurantId provided, look up the name
    let restaurantName = null;
    if (restaurantId) {
      const [r] = await db
        .select({ name: restaurants.name })
        .from(restaurants)
        .where(eq(restaurants.id, restaurantId))
        .limit(1);
      restaurantName = r?.name || null;
    }

    // Classify if sentiment not explicitly provided
    let finalSentiment = sentiment;
    let finalCategory = category;
    let finalSeverity = severity;
    if (!finalSentiment || !finalCategory) {
      const classification = await classifyEmailAlert(subject, bodyText || null);
      if (!finalSentiment) finalSentiment = classification.sentiment;
      if (!finalCategory) finalCategory = classification.category;
      if (!finalSeverity) finalSeverity = classification.severity;
      if (!restaurantId && classification.restaurantId) {
        restaurantName = classification.restaurantName;
      }
    }

    const [alert] = await db
      .insert(emailAlerts)
      .values({
        restaurantId: restaurantId || null,
        restaurantName,
        subject,
        bodyText: bodyText || null,
        senderEmail: senderEmail || null,
        sentiment: finalSentiment || "negative",
        category: finalCategory || "general",
        severity: finalSeverity || 1,
        source: "manual",
        emailDate: emailDate ? new Date(emailDate) : null,
      })
      .returning();

    res.json(alert);
  } catch (error) {
    console.error("[email-alerts] Manual submission error:", error);
    res.status(500).json({ error: "Failed to create email alert" });
  }
});

// ─── Get all alerts (with filters) ──────────────────────────────────────────

router.get("/api/email-alerts", async (req, res) => {
  try {
    const { restaurant_id, sentiment, category, start_date, end_date, limit: limitStr } = req.query;
    const rowLimit = Math.min(parseInt(limitStr as string) || 100, 500);

    let query = db.select().from(emailAlerts).orderBy(desc(emailAlerts.receivedAt)).limit(rowLimit);

    // Apply filters via where conditions
    const conditions = [];
    if (restaurant_id) conditions.push(eq(emailAlerts.restaurantId, restaurant_id as string));
    if (sentiment) conditions.push(eq(emailAlerts.sentiment, sentiment as string));
    if (category) conditions.push(eq(emailAlerts.category, category as string));
    if (start_date) conditions.push(gte(emailAlerts.receivedAt, new Date(start_date as string)));
    if (end_date) conditions.push(lte(emailAlerts.receivedAt, new Date(end_date as string)));

    let results;
    if (conditions.length > 0) {
      results = await db
        .select()
        .from(emailAlerts)
        .where(and(...conditions))
        .orderBy(desc(emailAlerts.receivedAt))
        .limit(rowLimit);
    } else {
      results = await db
        .select()
        .from(emailAlerts)
        .orderBy(desc(emailAlerts.receivedAt))
        .limit(rowLimit);
    }

    res.json(results);
  } catch (error) {
    console.error("[email-alerts] Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch email alerts" });
  }
});

// ─── Update alert (reclassify, assign restaurant) ───────────────────────────

router.patch("/api/email-alerts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { sentiment, category, severity, restaurantId } = req.body;

    const updates: Record<string, any> = {};
    if (sentiment) updates.sentiment = sentiment;
    if (category) updates.category = category;
    if (severity) updates.severity = severity;
    if (restaurantId !== undefined) {
      updates.restaurantId = restaurantId;
      if (restaurantId) {
        const [r] = await db
          .select({ name: restaurants.name })
          .from(restaurants)
          .where(eq(restaurants.id, restaurantId))
          .limit(1);
        updates.restaurantName = r?.name || null;
      } else {
        updates.restaurantName = null;
      }
    }

    const [updated] = await db
      .update(emailAlerts)
      .set(updates)
      .where(eq(emailAlerts.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Alert not found" });
    }
    res.json(updated);
  } catch (error) {
    console.error("[email-alerts] Update error:", error);
    res.status(500).json({ error: "Failed to update alert" });
  }
});

// ─── Delete alert ────────────────────────────────────────────────────────────

router.delete("/api/email-alerts/:id", async (req, res) => {
  try {
    await db.delete(emailAlerts).where(eq(emailAlerts.id, req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error("[email-alerts] Delete error:", error);
    res.status(500).json({ error: "Failed to delete alert" });
  }
});

// ─── Complaint Performance Index ────────────────────────────────────────────
// Calculates a performance index based on complaints per 500 transactions.
// Formula: performanceIndex = max(0, 100 - (negativeCount / transactionEstimate * 500) * scaleFactor)
// The 2/500 baseline means 2 complaints per 500 transactions = ~60 score (needs improvement)

router.get("/api/complaint-index", async (req, res) => {
  try {
    const { days: daysStr } = req.query;
    const days = parseInt(daysStr as string) || 30;

    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = now.toISOString().split("T")[0];

    // Get all restaurants
    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));

    // Get alerts in period grouped by restaurant
    const alertsByRestaurant = await db
      .select({
        restaurantId: emailAlerts.restaurantId,
        sentiment: emailAlerts.sentiment,
        category: emailAlerts.category,
        cnt: count(),
      })
      .from(emailAlerts)
      .where(gte(emailAlerts.receivedAt, startDate))
      .groupBy(emailAlerts.restaurantId, emailAlerts.sentiment, emailAlerts.category);

    // Get transaction estimates from daily sales (sum of totalSales / avg check ~$8)
    const AVG_CHECK = 8;
    const salesData = await db
      .select({
        restaurantId: dailySales.restaurantId,
        totalSales: sql<string>`SUM(${dailySales.totalSales})`,
      })
      .from(dailySales)
      .where(gte(dailySales.salesDate, startDate))
      .groupBy(dailySales.restaurantId);

    const salesMap = new Map(salesData.map((s) => [s.restaurantId, parseFloat(s.totalSales || "0")]));

    // Build index per restaurant
    const restaurantIndex: ComplaintIndexData[] = [];

    for (const r of allRestaurants) {
      const alerts = alertsByRestaurant.filter((a) => a.restaurantId === r.id);
      const totalAlerts = alerts.reduce((sum, a) => sum + Number(a.cnt), 0);
      const negativeCount = alerts
        .filter((a) => a.sentiment === "negative")
        .reduce((sum, a) => sum + Number(a.cnt), 0);
      const positiveCount = alerts
        .filter((a) => a.sentiment === "positive")
        .reduce((sum, a) => sum + Number(a.cnt), 0);
      const neutralCount = totalAlerts - negativeCount - positiveCount;

      // Category breakdown
      const categoryBreakdown: Record<string, number> = {};
      for (const a of alerts) {
        if (a.sentiment === "negative") {
          categoryBreakdown[a.category || "general"] = (categoryBreakdown[a.category || "general"] || 0) + Number(a.cnt);
        }
      }

      // Estimate transactions from sales data
      const totalSales = salesMap.get(r.id) || 0;
      const estimatedTransactions = Math.max(totalSales / AVG_CHECK, 1);

      // Complaints per 500 transactions
      const complaintsPer500 = (negativeCount / estimatedTransactions) * 500;

      // Performance index: 100 = perfect, 0 = terrible
      // Baseline: 2 complaints per 500 txns = score of 60 (needs improvement)
      // 0 complaints = 100, 5+ per 500 = ~0
      const performanceIndex = Math.max(0, Math.min(100, 100 - complaintsPer500 * 20));

      // Simple trend: compare first half vs second half of period
      // (will be refined when more data exists)
      const trend: "improving" | "declining" | "stable" = "stable";

      restaurantIndex.push({
        restaurantId: r.id,
        restaurantName: r.name,
        totalAlerts,
        positiveCount,
        negativeCount,
        neutralCount,
        complaintsPer500: Math.round(complaintsPer500 * 100) / 100,
        performanceIndex: Math.round(performanceIndex * 10) / 10,
        trend,
        categoryBreakdown,
      });
    }

    // Also include unmatched alerts
    const unmatchedAlerts = alertsByRestaurant.filter((a) => !a.restaurantId);
    const unmatchedTotal = unmatchedAlerts.reduce((sum, a) => sum + Number(a.cnt), 0);

    // Recent alerts for the feed
    const recentAlerts = await db
      .select()
      .from(emailAlerts)
      .orderBy(desc(emailAlerts.receivedAt))
      .limit(20);

    const totalAlerts = restaurantIndex.reduce((s, r) => s + r.totalAlerts, 0) + unmatchedTotal;
    const avgComplaintsPer500 =
      restaurantIndex.length > 0
        ? restaurantIndex.reduce((s, r) => s + r.complaintsPer500, 0) / restaurantIndex.length
        : 0;
    const avgPerformanceIndex =
      restaurantIndex.length > 0
        ? restaurantIndex.reduce((s, r) => s + r.performanceIndex, 0) / restaurantIndex.length
        : 100;

    const result: ComplaintDashboardData = {
      restaurants: restaurantIndex.sort((a, b) => b.negativeCount - a.negativeCount),
      totalAlerts,
      avgComplaintsPer500: Math.round(avgComplaintsPer500 * 100) / 100,
      avgPerformanceIndex: Math.round(avgPerformanceIndex * 10) / 10,
      periodStart: startDateStr,
      periodEnd: endDateStr,
      recentAlerts,
    };

    res.json(result);
  } catch (error) {
    console.error("[email-alerts] Complaint index error:", error);
    res.status(500).json({ error: "Failed to calculate complaint index" });
  }
});

export default router;
