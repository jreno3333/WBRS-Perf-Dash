import { Router } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { hmeTimerData } from "@shared/schema";
import { gte, lte } from "drizzle-orm";

const router = Router();

// Check HME configuration status (for debugging production issues)
router.get("/api/hme/status", async (req, res) => {
  try {
    const { checkHMECredentials, getDailyDriveThruSummary } = await import("../scraper/hme-api");
    const credentials = checkHMECredentials();

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    let dataCount = 0;
    let restaurantsWithData = 0;

    try {
      const summary = await getDailyDriveThruSummary(todayStr);
      restaurantsWithData = summary.size;
      Array.from(summary.values()).forEach(data => {
        dataCount += data.carCount;
      });
    } catch (e) {
      // Ignore errors getting summary
    }

    res.json({
      credentialsConfigured: credentials.configured,
      missingCredentials: credentials.missing,
      dateChecked: todayStr,
      restaurantsWithData,
      totalCarsToday: dataCount,
      environment: process.env.NODE_ENV || "development",
      isDeployment: process.env.REPLIT_DEPLOYMENT === "1",
    });
  } catch (error) {
    console.error("Error checking HME status:", error);
    res.status(500).json({
      error: "Failed to check HME status",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

router.get("/api/hme/stores", async (req, res) => {
  try {
    const { fetchHMEStores } = await import("../scraper/hme-api");
    const hmeStores = await fetchHMEStores();

    const allRestaurants = await storage.getRestaurants();
    const restaurantMap = new Map<string, string>();
    for (const r of allRestaurants) {
      if (r.unitNumber) restaurantMap.set(r.unitNumber, r.name);
      const nameMatch = r.name.match(/^(\d{4})\s*-/);
      if (nameMatch && !restaurantMap.has(nameMatch[1])) restaurantMap.set(nameMatch[1], r.name);
    }

    const storeList = hmeStores.map(s => ({
      storeNumber: s.StoreNumber,
      storeName: s.StoreName,
      city: s.City,
      state: s.State,
      laneConfig: s.LaneConfig,
      brand: s.Brand,
      matchedRestaurant: restaurantMap.get(s.StoreNumber) || null,
    }));

    const unmatchedRestaurants = Array.from(restaurantMap.entries())
      .filter(([num]) => !hmeStores.some(s => s.StoreNumber === num))
      .map(([num, name]) => ({ unitNumber: num, name }));

    res.json({
      hmeStoreCount: hmeStores.length,
      stores: storeList.sort((a, b) => a.storeNumber.localeCompare(b.storeNumber)),
      unmatchedRestaurants,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch HME stores" });
  }
});

// Sync HME timer data
router.post("/api/hme/sync", async (req, res) => {
  try {
    const { date } = req.body || {};
    const targetDate = date ? new Date(date) : undefined;

    const { syncHMETimerData } = await import("../scraper/hme-api");
    const result = await syncHMETimerData(targetDate);
    console.log("[HME] Sync completed:", result);

    res.json({
      message: result.saved > 0 ? "HME sync completed successfully" : "HME sync completed but no data saved",
      status: "completed",
      saved: result.saved,
      errors: result.errors
    });
  } catch (error: any) {
    console.error("Error during HME sync:", error);
    res.status(500).json({ error: error.message || "Failed to sync HME data" });
  }
});

// Get HME timer metrics for a restaurant
router.get("/api/hme/metrics/:restaurantId", async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date } = req.query;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const dateStr = date ? String(date) : todayStr;

    const { getHMETimerMetrics } = await import("../scraper/hme-api");
    const metrics = await getHMETimerMetrics(restaurantId, dateStr);

    res.json({ date: dateStr, metrics });
  } catch (error) {
    console.error("Error fetching HME metrics:", error);
    res.status(500).json({ error: "Failed to fetch HME metrics" });
  }
});

// Get HME daily summary for all restaurants
router.get("/api/hme/daily-summary", async (req, res) => {
  try {
    const { date } = req.query;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const dateStr = date ? String(date) : todayStr;

    const { getDailyDriveThruSummary } = await import("../scraper/hme-api");
    const summary = await getDailyDriveThruSummary(dateStr);

    const result: Record<string, { carCount: number; avgTotalTime: number; avgServiceTime: number; speedAttainment: number; carsUnder6Min: number }> = {};
    summary.forEach((value, key) => {
      result[key] = value;
    });

    res.json({ date: dateStr, summary: result });
  } catch (error) {
    console.error("Error fetching HME daily summary:", error);
    res.status(500).json({ error: "Failed to fetch HME daily summary" });
  }
});

// Detailed HME data validation
router.get("/api/hme/validate", async (req, res) => {
  try {
    const { days } = req.query;
    const numDays = Math.min(parseInt(String(days || '3')), 7);
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    const dates: string[] = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(todayStr + 'T12:00:00-06:00');
      d.setDate(d.getDate() - i);
      dates.push(d.toLocaleDateString('en-CA'));
    }
    const oldestDate = dates[dates.length - 1];

    const { sql: sqlTag } = await import("drizzle-orm");
    const hmeAgg = await db.select({
      restaurantId: hmeTimerData.restaurantId,
      date: hmeTimerData.date,
      hours: sqlTag<number>`count(*)::int`,
      totalCars: sqlTag<number>`coalesce(sum(${hmeTimerData.carCount}), 0)::int`,
      weightedServiceTime: sqlTag<number>`coalesce(sum(${hmeTimerData.avgServiceTime} * ${hmeTimerData.carCount}), 0)`,
    })
    .from(hmeTimerData)
    .where(sqlTag`${hmeTimerData.date} >= ${oldestDate}`)
    .groupBy(hmeTimerData.restaurantId, hmeTimerData.date);

    const dataMap = new Map<string, Map<string, { hours: number; totalCars: number; avgServiceTime: number | null }>>();
    for (const row of hmeAgg) {
      if (!dataMap.has(row.restaurantId)) {
        dataMap.set(row.restaurantId, new Map());
      }
      dataMap.get(row.restaurantId)!.set(row.date, {
        hours: row.hours,
        totalCars: row.totalCars,
        avgServiceTime: row.totalCars > 0 ? Math.round(row.weightedServiceTime / row.totalCars) : null,
      });
    }

    const allRestaurants = await storage.getRestaurants();
    const activeRestaurants = allRestaurants
      .filter(r => r.isActive && !r.name.includes('Training'))
      .sort((a, b) => a.name.localeCompare(b.name));

    const validation = activeRestaurants.map(restaurant => ({
      name: restaurant.name,
      restaurantId: restaurant.id,
      dailyData: dates.map(date => {
        const d = dataMap.get(restaurant.id)?.get(date);
        return {
          date,
          hours: d?.hours || 0,
          totalCars: d?.totalCars || 0,
          avgServiceTime: d?.avgServiceTime ?? null,
        };
      }),
    }));

    let hmeStoreCount = 0;
    let hmeStoreNumbers: string[] = [];
    try {
      const { fetchHMEStores } = await import("../scraper/hme-api");
      const stores = await fetchHMEStores();
      hmeStoreCount = stores.length;
      hmeStoreNumbers = stores.map(s => s.StoreNumber).sort();
    } catch (e) {
      // ignore
    }

    res.json({
      generatedAt: new Date().toISOString(),
      timezone: 'America/Chicago',
      dates,
      hmeApiStores: hmeStoreCount,
      hmeStoreNumbers,
      restaurants: validation,
    });
  } catch (error) {
    console.error("Error validating HME data:", error);
    res.status(500).json({ error: "Failed to validate HME data" });
  }
});

export default router;
