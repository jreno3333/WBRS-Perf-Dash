import { Router } from "express";
import { db } from "../db";
import { scraperRuns, hourlySales, restaurants } from "@shared/schema";
import { desc, sql, and, gte, lte, eq } from "drizzle-orm";
import { fetchSalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, fetchHourlySalesFromAPI, syncLocationsFromAPI } from "../scraper/7shifts-api";

const router = Router();

// Comprehensive diagnostics endpoint for production debugging
router.get("/api/diagnostics", async (req, res) => {
  const now = new Date();
  const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';

  res.json({
    timestamp: now.toISOString(),
    environment: process.env.NODE_ENV || 'development',
    isDeployment: process.env.REPLIT_DEPLOYMENT === '1',
    secrets: {
      sevenShiftsApiToken: !!process.env.SEVENSHIFTS_API_TOKEN,
      hmeServiceAccount: !!process.env.HME_SERVICE_ACCOUNT,
      hmeAuthKey: !!process.env.HME_AUTH_KEY,
      hmeAccountEmail: !!process.env.HME_ACCOUNT_EMAIL,
      googlePlacesApiKey: !!process.env.GOOGLE_PLACES_API_KEY,
      databaseUrl: !!process.env.DATABASE_URL,
      sharedDatabaseUrl: !!process.env.SHARED_DATABASE_URL,
    },
    message: isProduction
      ? 'Production environment - scheduler runs while app is awake'
      : 'Development environment - scheduler runs continuously',
  });
});

// Debug endpoint to check database connection
router.get("/api/db-status", async (req, res) => {
  const { posDb } = await import("../db");
  const { posOrders } = await import("@shared/schema");

  const xposSharedDbUrl = process.env.XPOSSHARED_DATABASE_URL?.trim() || '';
  const sharedDbUrl = process.env.SHARED_DATABASE_URL?.trim() || '';
  const defaultDbUrl = process.env.DATABASE_URL?.trim() || '';

  const mainDbSource = defaultDbUrl ? 'DATABASE_URL' : (xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : 'SHARED_DATABASE_URL');
  const posDbSource = xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : (defaultDbUrl ? 'DATABASE_URL' : 'SHARED_DATABASE_URL');
  const posDbIsSeparate = xposSharedDbUrl && xposSharedDbUrl !== (defaultDbUrl || sharedDbUrl);

  const posCount = await posDb.select({ count: sql<number>`count(*)` }).from(posOrders);
  const restaurantCount = await db.select({ count: sql<number>`count(*)` }).from(restaurants);

  res.json({
    environment: process.env.NODE_ENV || 'development',
    mainDatabase: mainDbSource,
    posDatabase: posDbSource,
    posDbSeparate: posDbIsSeparate,
    xposSharedSet: !!xposSharedDbUrl,
    sharedSet: !!sharedDbUrl,
    databaseUrlSet: !!defaultDbUrl,
    posOrdersCount: posCount[0]?.count || 0,
    restaurantsCount: restaurantCount[0]?.count || 0
  });
});

// Trigger manual API sync
router.post("/api/scraper/run", async (req, res) => {
  try {
    const { date } = req.body || {};
    const targetDate = date ? new Date(date) : undefined;

    res.json({ message: "API sync started", status: "running" });

    fetchSalesFromAPI(targetDate).then(result => {
      console.log("API sync completed:", result);
    }).catch(err => {
      console.error("API sync error:", err);
    });
  } catch (error) {
    console.error("Error starting API sync:", error);
    res.status(500).json({ error: "Failed to start API sync" });
  }
});

// Get scraper/sync status
router.get("/api/scraper/status", async (req, res) => {
  try {
    const latestRuns = await db.select()
      .from(scraperRuns)
      .orderBy(desc(scraperRuns.startedAt))
      .limit(10);

    res.json({
      hasApiToken: !!process.env.SEVENSHIFTS_API_TOKEN,
      latestRuns,
    });
  } catch (error) {
    console.error("Error fetching sync status:", error);
    res.status(500).json({ error: "Failed to fetch sync status" });
  }
});

// Diagnostic: Check for duplicate hourly records
router.get("/api/scraper/check-duplicates", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const dateStr = targetDate.toISOString().split('T')[0];

    // OPTIMIZED: Filter at DB level
    const checkDateStart = new Date(`${dateStr}T00:00:00.000Z`);
    const checkDateEnd = new Date(`${dateStr}T23:59:59.999Z`);
    const dayRecords = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, checkDateStart),
        lte(hourlySales.salesDate, checkDateEnd)
      )
    );

    const counts: Record<string, number> = {};
    const duplicates: Array<{restaurantId: string, hour: number, count: number}> = [];

    dayRecords.forEach(r => {
      const key = `${r.restaurantId}-${r.hour}`;
      counts[key] = (counts[key] || 0) + 1;
    });

    Object.entries(counts).forEach(([key, count]) => {
      if (count > 1) {
        const [restaurantId, hour] = key.split('-');
        duplicates.push({ restaurantId, hour: parseInt(hour), count });
      }
    });

    const totalSales = dayRecords.reduce((sum, r) => sum + parseFloat(r.actualSales || '0'), 0);

    res.json({
      date: dateStr,
      totalRecords: dayRecords.length,
      expectedRecords: 22 * 24,
      duplicateGroups: duplicates.length,
      duplicates,
      totalSales: totalSales.toFixed(2),
    });
  } catch (error) {
    console.error("Error checking duplicates:", error);
    res.status(500).json({ error: "Failed to check duplicates" });
  }
});

// Cleanup: Remove duplicate hourly records, keeping the most recent
router.post("/api/scraper/cleanup-duplicates", async (req, res) => {
  try {
    const { date } = req.body;
    const targetDate = date ? new Date(date as string) : new Date();
    const dateStr = targetDate.toISOString().split('T')[0];

    // OPTIMIZED: Filter at DB level
    const cleanupDateStart = new Date(`${dateStr}T00:00:00.000Z`);
    const cleanupDateEnd = new Date(`${dateStr}T23:59:59.999Z`);
    const dayRecords = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, cleanupDateStart),
        lte(hourlySales.salesDate, cleanupDateEnd)
      )
    );

    const groups: Record<string, typeof dayRecords> = {};
    dayRecords.forEach(r => {
      const key = `${r.restaurantId}-${r.hour}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    });

    let deletedCount = 0;
    for (const records of Object.values(groups)) {
      if (records.length > 1) {
        const toDelete = records.slice(1);
        for (const record of toDelete) {
          await db.delete(hourlySales).where(eq(hourlySales.id, record.id));
          deletedCount++;
        }
      }
    }

    // Get new total (re-query only for this date)
    const newDayRecords = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, cleanupDateStart),
        lte(hourlySales.salesDate, cleanupDateEnd)
      )
    );
    const newTotal = newDayRecords.reduce((sum, r) => sum + parseFloat(r.actualSales || '0'), 0);

    res.json({
      date: dateStr,
      deletedRecords: deletedCount,
      remainingRecords: newDayRecords.length,
      newTotalSales: newTotal.toFixed(2),
    });
  } catch (error) {
    console.error("Error cleaning duplicates:", error);
    res.status(500).json({ error: "Failed to cleanup duplicates" });
  }
});

// Sync locations from 7shifts
router.post("/api/scraper/sync-locations", async (req, res) => {
  try {
    const count = await syncLocationsFromAPI();
    res.json({ message: `Synced ${count} locations`, count });
  } catch (error) {
    console.error("Error syncing locations:", error);
    res.status(500).json({ error: "Failed to sync locations" });
  }
});

// Fetch historical data (last N days)
router.post("/api/scraper/historical", async (req, res) => {
  try {
    const days = Number(req.query.days) || (req.body && req.body.days) || 9;

    res.json({ message: `Starting historical fetch for ${days} days`, status: "running" });

    fetchHistoricalSales(days).then(() => {
      console.log("Historical fetch completed");
    }).catch(err => {
      console.error("Historical fetch error:", err);
    });
  } catch (error) {
    console.error("Error starting historical fetch:", error);
    res.status(500).json({ error: "Failed to start historical fetch" });
  }
});

// Fetch historical hourly data (last N days)
router.post("/api/scraper/historical-hourly", async (req, res) => {
  try {
    const days = Number(req.query.days) || (req.body && req.body.days) || 9;

    res.json({ message: `Starting historical hourly fetch for ${days} days`, status: "running" });

    fetchHistoricalHourlySales(days).then(() => {
      console.log("Historical hourly fetch completed");
    }).catch(err => {
      console.error("Historical hourly fetch error:", err);
    });
  } catch (error) {
    console.error("Error starting historical hourly fetch:", error);
    res.status(500).json({ error: "Failed to start historical hourly fetch" });
  }
});

// Sync hourly data for today (with time punches)
router.post("/api/scraper/hourly", async (req, res) => {
  try {
    const { date } = req.body || {};
    const targetDate = date ? new Date(date) : undefined;

    res.json({ message: "Hourly sync with time punches started", status: "running" });

    fetchHourlySalesFromAPI(targetDate).then(result => {
      console.log("Hourly sync completed:", result);
    }).catch(err => {
      console.error("Hourly sync error:", err);
    });
  } catch (error) {
    console.error("Error starting hourly sync:", error);
    res.status(500).json({ error: "Failed to start hourly sync" });
  }
});

// Debug endpoint to resync labor data for a specific restaurant and date
router.post("/api/debug/labor-resync", async (req, res) => {
  try {
    const { restaurantName, date } = req.body;
    if (!restaurantName || !date) {
      return res.status(400).json({ error: "restaurantName and date are required" });
    }

    const { resyncLaborForRestaurant } = await import("../scraper/7shifts-api");
    const result = await resyncLaborForRestaurant(restaurantName, date);
    res.json(result);
  } catch (error) {
    console.error("Error resyncing labor:", error);
    res.status(500).json({ error: "Failed to resync labor data" });
  }
});

// Fix labor data for Eastern timezone stores on a specific date
router.post("/api/debug/fix-labor", async (req, res) => {
  try {
    const { restaurantName, date } = req.body;
    if (!restaurantName || !date) {
      return res.status(400).json({ error: "restaurantName and date are required" });
    }

    const { fixLaborForRestaurant } = await import("../scraper/7shifts-api");
    const result = await fixLaborForRestaurant(restaurantName, date);
    res.json(result);
  } catch (error) {
    console.error("Error fixing labor:", error);
    res.status(500).json({ error: "Failed to fix labor data" });
  }
});

// Sync restaurant coordinates from 7shifts
router.post("/api/sync-restaurants", async (req, res) => {
  try {
    console.log("[Sync] Starting restaurant sync from 7shifts...");
    const count = await syncLocationsFromAPI();
    console.log(`[Sync] Synced ${count} restaurants`);
    res.json({
      message: "Restaurant sync completed",
      synced: count
    });
  } catch (error: any) {
    console.error("[Sync] Error syncing restaurants:", error);
    res.status(500).json({ error: error.message || "Failed to sync restaurants" });
  }
});

export default router;
