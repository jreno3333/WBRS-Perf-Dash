import { Router } from "express";
import { db } from "../db";
import { dailyOsat } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { syncOsatData, getOsatForDate } from "../scraper/qualtrics-api";

const router = Router();

// Get OSAT sync status
router.get("/api/osat/status", async (req, res) => {
  try {
    const apiToken = process.env.QUALTRICS_API_TOKEN;
    const surveyId = process.env.QUALTRICS_SURVEY_ID;

    const credentialsConfigured = !!(apiToken && surveyId);

    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
    const todayStr = centralFormatter.format(now);

    const todayData = await db.select().from(dailyOsat).where(eq(dailyOsat.date, todayStr));

    const restaurantsWithData = todayData.length;
    const totalResponses = todayData.reduce((sum, r) => sum + r.totalResponses, 0);
    const totalFiveStar = todayData.reduce((sum, r) => sum + r.fiveStarCount, 0);
    const avgOsat = totalResponses > 0 ? ((totalFiveStar / totalResponses) * 100).toFixed(1) : null;

    const latestSync = todayData.length > 0
      ? todayData.reduce((latest, r) => {
          const syncTime = r.syncedAt ? new Date(r.syncedAt) : new Date(0);
          return syncTime > latest ? syncTime : latest;
        }, new Date(0))
      : null;

    res.json({
      credentialsConfigured,
      surveyIdConfigured: !!surveyId,
      restaurantsWithData,
      totalResponses,
      avgOsat,
      dateChecked: todayStr,
      lastSync: latestSync?.toISOString() || null,
    });
  } catch (error) {
    console.error("Error getting OSAT status:", error);
    res.status(500).json({ error: "Failed to get OSAT status" });
  }
});

// Sync OSAT data from Qualtrics (default 3 days)
router.post("/api/osat/sync", async (req, res) => {
  try {
    const daysBack = req.body?.daysBack || 3;
    const result = await syncOsatData(daysBack);
    res.json({
      message: "OSAT sync completed",
      synced: result.synced,
      daysBack,
      errors: result.errors,
    });
  } catch (error: any) {
    console.error("Error syncing OSAT data:", error);
    res.status(500).json({ error: error.message || "Failed to sync OSAT data" });
  }
});

// Historical OSAT sync (7 days)
router.post("/api/osat/sync-historical", async (req, res) => {
  try {
    const daysBack = req.body?.daysBack || 7;
    console.log(`[OSAT] Starting historical sync for ${daysBack} days`);
    const result = await syncOsatData(daysBack);
    res.json({
      message: "Historical OSAT sync completed",
      synced: result.synced,
      daysBack,
      errors: result.errors,
    });
  } catch (error: any) {
    console.error("Error syncing historical OSAT data:", error);
    res.status(500).json({ error: error.message || "Failed to sync historical OSAT data" });
  }
});

// Get OSAT summary for a specific date
router.get("/api/osat/summary", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? String(date) : new Date().toISOString().split('T')[0];

    const osatMap = await getOsatForDate(targetDate);
    res.json({ date: targetDate, osat: osatMap });
  } catch (error) {
    console.error("Error fetching OSAT summary:", error);
    res.status(500).json({ error: "Failed to fetch OSAT summary" });
  }
});

// Get category issues for a restaurant on a specific date
router.get("/api/osat/category-issues", async (req, res) => {
  try {
    const { osatCategoryIssues } = await import("@shared/schema");
    const { restaurantId, date } = req.query;

    if (!restaurantId || !date) {
      return res.status(400).json({ error: "restaurantId and date are required" });
    }

    const issues = await db.select()
      .from(osatCategoryIssues)
      .where(and(
        eq(osatCategoryIssues.restaurantId, String(restaurantId)),
        eq(osatCategoryIssues.date, String(date))
      ));

    const categoryNames: Record<string, string> = {
      orderAccuracy: 'Order Accuracy',
      foodQuality: 'Food Quality',
      menuOptions: 'Menu Options',
      value: 'Value',
      easeOfOrdering: 'Ease of Ordering',
      employeeFriendliness: 'Employee Friendliness',
      speedOfService: 'Speed of Service',
      cleanliness: 'Cleanliness',
      driveThruWaitTime: 'Drive-Thru Wait Time',
    };

    const categoryIssues: { category: string; lowCount: number; totalCount: number; avgRating: number }[] = [];

    for (const [key, label] of Object.entries(categoryNames)) {
      const ratings = issues
        .map(i => i[key as keyof typeof i])
        .filter((r): r is number => r !== null && r !== undefined) as number[];

      if (ratings.length > 0) {
        const lowCount = ratings.filter(r => r < 3).length;
        const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;

        if (lowCount > 0 || avgRating < 3) {
          categoryIssues.push({
            category: label,
            lowCount,
            totalCount: ratings.length,
            avgRating: Math.round(avgRating * 10) / 10,
          });
        }
      }
    }

    categoryIssues.sort((a, b) => b.lowCount - a.lowCount || a.avgRating - b.avgRating);

    res.json({
      restaurantId,
      date,
      totalSurveys: issues.length,
      categoryIssues
    });
  } catch (error) {
    console.error("Error fetching category issues:", error);
    res.status(500).json({ error: "Failed to fetch category issues" });
  }
});

// Get category issues aggregated for all restaurants on a specific date
const handleCategoryIssuesAll = async (date: string, res: any) => {
  try {
    const { osatCategoryIssues } = await import("@shared/schema");

    const issues = await db.select()
      .from(osatCategoryIssues)
      .where(eq(osatCategoryIssues.date, date));

    const byRestaurant: Record<string, typeof issues> = {};
    for (const issue of issues) {
      if (!byRestaurant[issue.restaurantId]) {
        byRestaurant[issue.restaurantId] = [];
      }
      byRestaurant[issue.restaurantId].push(issue);
    }

    res.json({ date, issuesByRestaurant: byRestaurant });
  } catch (error) {
    console.error("Error fetching all category issues:", error);
    res.status(500).json({ error: "Failed to fetch category issues" });
  }
};

// Query param version: /api/osat/category-issues/all?date=2026-02-04
router.get("/api/osat/category-issues/all", async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }
  return handleCategoryIssuesAll(String(date), res);
});

// Path param version: /api/osat/category-issues/all/2026-02-04
router.get("/api/osat/category-issues/all/:date", async (req, res) => {
  const { date } = req.params;
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }
  return handleCategoryIssuesAll(date, res);
});

export default router;
