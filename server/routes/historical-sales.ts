import { Router } from "express";
import { db } from "../db";
import { historicalDailySales, restaurants } from "@shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";

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

    if (rows.length === 0) {
      return res.json({ found: false, priorDate: priorDateStr });
    }

    const row = rows[0];
    res.json({
      found: true,
      priorDate: priorDateStr,
      priorNetSales: parseFloat(row.netSales),
      priorGuestCount: row.guestCount,
    });
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

    const rows = await db.select()
      .from(historicalDailySales)
      .where(eq(historicalDailySales.date, priorDateStr));

    const result: Record<string, { priorNetSales: number; priorGuestCount: number; priorDate: string }> = {};
    for (const row of rows) {
      result[row.restaurantId] = {
        priorNetSales: parseFloat(row.netSales),
        priorGuestCount: row.guestCount,
        priorDate: priorDateStr,
      };
    }

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
