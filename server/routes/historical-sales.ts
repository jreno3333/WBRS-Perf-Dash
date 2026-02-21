import { Router } from "express";
import { db } from "../db";
import { historicalDailySales, hourlySales, restaurants } from "@shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getNormalizedHourCutoff, getTodayInTimezone } from "../utils/dates";

const router = Router();

router.post("/api/historical-sales/upload", async (req, res) => {
  try {
    const { csvData } = req.body;
    if (!csvData || typeof csvData !== "string") {
      return res.status(400).json({ error: "csvData string is required" });
    }

    const allRestaurants = await db.select({
      id: restaurants.id,
      unitNumber: restaurants.unitNumber,
      name: restaurants.name,
    }).from(restaurants);

    const unitMap = new Map<string, string>();
    for (const r of allRestaurants) {
      if (r.unitNumber) {
        unitMap.set(r.unitNumber, r.id);
      }
    }

    const lines = csvData.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const header = lines[0];
    if (!header.toLowerCase().includes("location") || !header.toLowerCase().includes("net sales")) {
      return res.status(400).json({ error: "Invalid CSV format. Expected: Location, Date, Net Sales, Guest Count" });
    }

    let inserted = 0;
    let skipped = 0;
    let unmatchedStores = new Set<string>();
    const rows: Array<{ restaurantId: string; date: string; netSales: string; guestCount: number }> = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 4) continue;

      const location = parts[0].trim();
      const dateStr = parts[1].trim();
      const netSalesStr = parts[2].trim();
      const guestCountStr = parts[3].trim();

      const unitMatch = location.match(/^(\d+)/);
      if (!unitMatch) {
        skipped++;
        continue;
      }

      const unitNumber = unitMatch[1];
      const restaurantId = unitMap.get(unitNumber);
      if (!restaurantId) {
        unmatchedStores.add(location);
        skipped++;
        continue;
      }

      const dateParts = dateStr.split("/");
      if (dateParts.length !== 3) {
        skipped++;
        continue;
      }

      let [month, day, year] = dateParts.map(Number);
      if (year < 100) year += 2000;
      const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      const netSales = parseFloat(netSalesStr);
      const guestCount = parseInt(guestCountStr) || 0;

      if (isNaN(netSales)) {
        skipped++;
        continue;
      }

      rows.push({
        restaurantId,
        date: isoDate,
        netSales: netSales.toFixed(2),
        guestCount,
      });
    }

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await db.insert(historicalDailySales)
        .values(batch)
        .onConflictDoUpdate({
          target: [historicalDailySales.restaurantId, historicalDailySales.date],
          set: {
            netSales: sql`EXCLUDED.net_sales`,
            guestCount: sql`EXCLUDED.guest_count`,
            uploadedAt: sql`NOW()`,
          },
        });
      inserted += batch.length;
    }

    res.json({
      success: true,
      inserted,
      skipped,
      totalRows: lines.length - 1,
      unmatchedStores: Array.from(unmatchedStores),
    });
  } catch (error: any) {
    console.error("Error uploading historical sales:", error);
    res.status(500).json({ error: "Failed to upload historical sales data", details: error.message });
  }
});

router.get("/api/historical-sales/summary", async (req, res) => {
  try {
    const result = await db.select({
      totalRecords: sql<number>`COUNT(*)::int`,
      minDate: sql<string>`MIN(date)`,
      maxDate: sql<string>`MAX(date)`,
      storeCount: sql<number>`COUNT(DISTINCT restaurant_id)::int`,
    }).from(historicalDailySales);

    res.json(result[0] || { totalRecords: 0, minDate: null, maxDate: null, storeCount: 0 });
  } catch (error: any) {
    console.error("Error fetching historical sales summary:", error);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

router.get("/api/historical-sales/yoy", async (req, res) => {
  try {
    const { restaurantId, date } = req.query;
    if (!restaurantId || !date) {
      return res.status(400).json({ error: "restaurantId and date are required" });
    }

    const currentDate = new Date(date as string);
    const priorYearDate = new Date(currentDate);
    priorYearDate.setFullYear(priorYearDate.getFullYear() - 1);

    const sameDow = priorYearDate.getDay();
    const targetDow = currentDate.getDay();
    const diff = targetDow - sameDow;
    priorYearDate.setDate(priorYearDate.getDate() + diff);

    const priorDateStr = priorYearDate.toISOString().split("T")[0];

    const rows = await db.select()
      .from(historicalDailySales)
      .where(
        and(
          eq(historicalDailySales.restaurantId, restaurantId as string),
          eq(historicalDailySales.date, priorDateStr)
        )
      );

    if (rows.length > 0) {
      const row = rows[0];
      return res.json({
        found: true,
        priorDate: priorDateStr,
        priorNetSales: parseFloat(row.netSales),
        priorGuestCount: row.guestCount,
      });
    }

    const priorDateStart = new Date(priorDateStr + "T00:00:00.000Z");
    const priorDateEnd = new Date(priorDateStr + "T23:59:59.999Z");
    const posRows = await db.select({
      totalSales: sql<string>`SUM(CAST(${hourlySales.actualSales} AS numeric))`,
    })
      .from(hourlySales)
      .where(
        and(
          eq(hourlySales.restaurantId, restaurantId as string),
          gte(hourlySales.salesDate, priorDateStart),
          lte(hourlySales.salesDate, priorDateEnd)
        )
      );

    const totalSales = parseFloat(posRows[0]?.totalSales || "0");
    if (totalSales > 0) {
      return res.json({
        found: true,
        priorDate: priorDateStr,
        priorNetSales: totalSales,
        priorGuestCount: 0,
        source: "pos",
      });
    }

    res.json({ found: false, priorDate: priorDateStr });
  } catch (error: any) {
    console.error("Error fetching YoY data:", error);
    res.status(500).json({ error: "Failed to fetch YoY comparison" });
  }
});

router.get("/api/historical-sales/yoy-bulk", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    }

    const currentDate = new Date(date as string);
    const priorYearDate = new Date(currentDate);
    priorYearDate.setFullYear(priorYearDate.getFullYear() - 1);

    const sameDow = priorYearDate.getDay();
    const targetDow = currentDate.getDay();
    const diff = targetDow - sameDow;
    priorYearDate.setDate(priorYearDate.getDate() + diff);

    const priorDateStr = priorYearDate.toISOString().split("T")[0];

    console.log(`[YoY] Fetching bulk data for date=${date}, priorDate=${priorDateStr}`);

    const result: Record<string, { priorNetSales: number; priorNetSalesPartial: number; priorGuestCount: number; priorDate: string }> = {};

    // Determine normalized hour cutoff so we can compute partial-day LY sales
    const todayStr = getTodayInTimezone('America/Chicago');
    const isToday = (date as string) === todayStr;
    const restaurantList = await db.select({ timezone: restaurants.timezone }).from(restaurants);
    const hourCutoff = isToday ? getNormalizedHourCutoff(restaurantList) : 23;

    const rows = await db.select()
      .from(historicalDailySales)
      .where(eq(historicalDailySales.date, priorDateStr));

    console.log(`[YoY] Found ${rows.length} uploaded CSV records for ${priorDateStr}`);

    for (const row of rows) {
      result[row.restaurantId] = {
        priorNetSales: parseFloat(row.netSales),
        priorNetSalesPartial: 0,
        priorGuestCount: row.guestCount,
        priorDate: priorDateStr,
      };
    }

    const priorDateStart = new Date(priorDateStr + "T00:00:00.000Z");
    const priorDateEnd = new Date(priorDateStr + "T23:59:59.999Z");

    const posRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      totalSales: sql<string>`SUM(CAST(${hourlySales.actualSales} AS numeric))`,
    })
      .from(hourlySales)
      .where(
        and(
          gte(hourlySales.salesDate, priorDateStart),
          lte(hourlySales.salesDate, priorDateEnd)
        )
      )
      .groupBy(hourlySales.restaurantId);

    let posCount = 0;
    for (const row of posRows) {
      if (!result[row.restaurantId]) {
        const totalSales = parseFloat(row.totalSales || "0");
        if (totalSales > 0) {
          result[row.restaurantId] = {
            priorNetSales: totalSales,
            priorNetSalesPartial: 0,
            priorGuestCount: 0,
            priorDate: priorDateStr,
          };
          posCount++;
        }
      }
    }

    if (posCount > 0) {
      console.log(`[YoY] Added ${posCount} restaurants from POS hourly_sales data`);
    }

    // Compute partial-day prior year sales (hours 0..hourCutoff) for same-time-of-day YoY
    const partialPosRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      totalSales: sql<string>`SUM(CAST(${hourlySales.actualSales} AS numeric))`,
    })
      .from(hourlySales)
      .where(
        and(
          gte(hourlySales.salesDate, priorDateStart),
          lte(hourlySales.salesDate, priorDateEnd),
          lte(hourlySales.hour, hourCutoff)
        )
      )
      .groupBy(hourlySales.restaurantId);

    for (const row of partialPosRows) {
      const partialSales = parseFloat(row.totalSales || "0");
      if (result[row.restaurantId]) {
        result[row.restaurantId].priorNetSalesPartial = partialSales;
      }
    }

    // For restaurants with CSV data but no hourly POS data for partial calc,
    // estimate partial day from the full day total using hour proportion
    for (const [restId, data] of Object.entries(result)) {
      if (data.priorNetSalesPartial === 0 && data.priorNetSales > 0 && hourCutoff < 23) {
        data.priorNetSalesPartial = data.priorNetSales * ((hourCutoff + 1) / 24);
      }
    }

    console.log(`[YoY] Total: ${Object.keys(result).length} restaurants with YoY data (hourCutoff=${hourCutoff})`);

    res.json({ priorDate: priorDateStr, data: result });
  } catch (error: any) {
    console.error("Error fetching bulk YoY data:", error);
    res.status(500).json({ error: "Failed to fetch bulk YoY comparison" });
  }
});

router.delete("/api/historical-sales", async (req, res) => {
  try {
    await db.delete(historicalDailySales);
    res.json({ success: true, message: "All historical sales data deleted" });
  } catch (error: any) {
    console.error("Error deleting historical sales:", error);
    res.status(500).json({ error: "Failed to delete historical sales data" });
  }
});

export default router;
