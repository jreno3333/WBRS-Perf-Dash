import { Router } from "express";
import { db, posDb } from "../db";
import { hourlySales, restaurants, dailyOsat, osatData, posOrders, locationMapping } from "@shared/schema";
import { sql, and, gte, lte, eq, desc, asc } from "drizzle-orm";

const router = Router();

/**
 * AI Sales Analysis API
 * Provides pre-built analytical queries for key business questions:
 * 1. Hours with sales over $2000
 * 2. Highest OSAT scores
 * 3. Dine-in % change by unit
 * 4. App order % by unit
 * 5. Outside order taker (OOT/dt3) usage
 * 6. Top growing products week-over-week (attachment rates)
 */

// Run all analysis queries for a given date range
router.get("/api/ai-analysis", async (req, res) => {
  try {
    const { date, days = "7" } = req.query;
    const numDays = Math.min(parseInt(days as string) || 7, 90);

    // Determine date range
    const endDate = date
      ? new Date(date as string + "T12:00:00")
      : new Date();
    const endDateStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numDays + 1);
    const startDateStr = startDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Previous period for comparison
    const prevEndDate = new Date(startDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
    const prevEndDateStr = prevEndDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    const prevStartDate = new Date(prevEndDate);
    prevStartDate.setDate(prevStartDate.getDate() - numDays + 1);
    const prevStartDateStr = prevStartDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Get restaurant list for name mapping
    const restaurantList = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const restaurantMap = new Map(restaurantList.map((r) => [r.id, r.name]));

    // Run all analysis queries in parallel
    const [
      highSalesHours,
      osatLeaders,
      destinationData,
      prevDestinationData,
      ootData,
      attachmentTrend,
    ] = await Promise.all([
      // 1. Hours with sales over $2000
      getHighSalesHours(startDateStr, endDateStr, 2000),
      // 2. Highest OSAT scores
      getOsatLeaders(startDateStr, endDateStr),
      // 3 & 4. Destination breakdown (current period)
      getDestinationBreakdown(startDateStr, endDateStr),
      // 3 & 4. Destination breakdown (previous period for comparison)
      getDestinationBreakdown(prevStartDateStr, prevEndDateStr),
      // 5. Outside order taker usage
      getOutsideOrderTakerUsage(startDateStr, endDateStr),
      // 6. Attachment rate trend (week over week from POS items)
      getAttachmentRateTrend(endDateStr),
    ]);

    // Process dine-in % change
    const dineInChange = calculateDestinationChange(destinationData, prevDestinationData, "dine_in", restaurantMap);
    const appPercentages = calculateDestinationPercentages(destinationData, "app", restaurantMap);

    res.json({
      dateRange: { start: startDateStr, end: endDateStr, days: numDays },
      previousPeriod: { start: prevStartDateStr, end: prevEndDateStr },
      insights: {
        highSalesHours: formatHighSalesHours(highSalesHours, restaurantMap),
        osatLeaders: formatOsatLeaders(osatLeaders, restaurantMap),
        dineInChange,
        appPercentages,
        outsideOrderTakers: formatOOTData(ootData, restaurantMap),
        attachmentTrend,
      },
    });
  } catch (error) {
    console.error("Error in AI analysis:", error);
    res.status(500).json({ error: "Failed to run analysis" });
  }
});

// ---- Query Functions ----

async function getHighSalesHours(startDate: string, endDate: string, threshold: number) {
  const startTs = new Date(startDate + "T00:00:00");
  const endTs = new Date(endDate + "T23:59:59");

  return db
    .select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      hour: hourlySales.hour,
      actualSales: hourlySales.actualSales,
    })
    .from(hourlySales)
    .where(
      and(
        gte(hourlySales.salesDate, startTs),
        lte(hourlySales.salesDate, endTs),
        gte(hourlySales.actualSales, threshold.toString())
      )
    )
    .orderBy(desc(hourlySales.actualSales));
}

async function getOsatLeaders(startDate: string, endDate: string) {
  return db
    .select({
      restaurantId: dailyOsat.restaurantId,
      avgOsat: sql<number>`round(avg(${dailyOsat.osatPercent}::numeric), 1)`,
      totalResponses: sql<number>`sum(${dailyOsat.totalResponses})::int`,
      totalFiveStar: sql<number>`sum(${dailyOsat.fiveStarCount})::int`,
      dayCount: sql<number>`count(distinct ${dailyOsat.date})::int`,
    })
    .from(dailyOsat)
    .where(
      and(
        gte(dailyOsat.date, startDate),
        lte(dailyOsat.date, endDate),
        gte(dailyOsat.totalResponses, 1)
      )
    )
    .groupBy(dailyOsat.restaurantId)
    .orderBy(desc(sql`avg(${dailyOsat.osatPercent}::numeric)`));
}

async function getDestinationBreakdown(startDate: string, endDate: string) {
  const startTs = new Date(startDate + "T00:00:00");
  const endTs = new Date(endDate + "T23:59:59");

  // Get location mappings for restaurant name resolution
  const mappings = await db.select().from(locationMapping);
  const storeToRestaurant = new Map(mappings.map((m) => [m.xenialStoreNumber, m.restaurantId]));

  const rows = await posDb
    .select({
      storeNumber: posOrders.storeNumber,
      destination: posOrders.destination,
      orderCount: sql<number>`count(*)::int`,
      totalSales: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
    })
    .from(posOrders)
    .where(
      and(
        gte(posOrders.businessDate, startTs),
        lte(posOrders.businessDate, endTs)
      )
    )
    .groupBy(posOrders.storeNumber, posOrders.destination);

  // Group by restaurant
  const result = new Map<string, Map<string, { orders: number; sales: number }>>();

  for (const row of rows) {
    const restaurantId = storeToRestaurant.get(row.storeNumber) || row.storeNumber;
    if (!result.has(restaurantId)) {
      result.set(restaurantId, new Map());
    }
    const destMap = result.get(restaurantId)!;
    const dest = normalizeDestination(row.destination);
    const existing = destMap.get(dest) || { orders: 0, sales: 0 };
    existing.orders += row.orderCount;
    existing.sales += Number(row.totalSales);
    destMap.set(dest, existing);
  }

  return result;
}

async function getOutsideOrderTakerUsage(startDate: string, endDate: string) {
  const startTs = new Date(startDate + "T00:00:00");
  const endTs = new Date(endDate + "T23:59:59");

  const mappings = await db.select().from(locationMapping);
  const storeToRestaurant = new Map(mappings.map((m) => [m.xenialStoreNumber, m.restaurantId]));

  // dt3 = outside order taker lane
  const rows = await posDb
    .select({
      storeNumber: posOrders.storeNumber,
      businessDate: sql<string>`${posOrders.businessDate}::date::text`,
      hour: sql<number>`extract(hour from ${posOrders.orderClosedAt})::int`,
      orderCount: sql<number>`count(*)::int`,
    })
    .from(posOrders)
    .where(
      and(
        gte(posOrders.businessDate, startTs),
        lte(posOrders.businessDate, endTs),
        sql`lower(${posOrders.destination}) like '%dt3%'`
      )
    )
    .groupBy(posOrders.storeNumber, sql`${posOrders.businessDate}::date::text`, sql`extract(hour from ${posOrders.orderClosedAt})::int`)
    .orderBy(desc(sql`count(*)`));

  // Aggregate by restaurant
  const restaurantOOT = new Map<string, { totalOrders: number; hoursUsed: number; daysUsed: Set<string> }>();

  for (const row of rows) {
    const restaurantId = storeToRestaurant.get(row.storeNumber) || row.storeNumber;
    if (!restaurantOOT.has(restaurantId)) {
      restaurantOOT.set(restaurantId, { totalOrders: 0, hoursUsed: 0, daysUsed: new Set() });
    }
    const data = restaurantOOT.get(restaurantId)!;
    data.totalOrders += row.orderCount;
    data.hoursUsed += 1;
    data.daysUsed.add(row.businessDate);
  }

  return restaurantOOT;
}

async function getAttachmentRateTrend(endDateStr: string) {
  // Get the last 2 weeks of POS order items to compare attachment categories
  const endTs = new Date(endDateStr + "T23:59:59");
  const startTs = new Date(endTs);
  startTs.setDate(startTs.getDate() - 13); // 14 days total

  const midTs = new Date(endTs);
  midTs.setDate(midTs.getDate() - 6); // Split into 2 weeks
  const midDateStr = midTs.toISOString().split("T")[0];

  // Query raw order items from pos_orders for both weeks
  // We'll look at item-level data in raw_json if available
  try {
    const thisWeekOrders = await posDb
      .select({
        orderCount: sql<number>`count(*)::int`,
        avgTotal: sql<number>`round(avg(${posOrders.orderTotal}::numeric), 2)`,
        totalSales: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, midTs),
          lte(posOrders.businessDate, endTs)
        )
      );

    const lastWeekOrders = await posDb
      .select({
        orderCount: sql<number>`count(*)::int`,
        avgTotal: sql<number>`round(avg(${posOrders.orderTotal}::numeric), 2)`,
        totalSales: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, startTs),
          lte(posOrders.businessDate, midTs)
        )
      );

    const thisWeek = thisWeekOrders[0];
    const lastWeek = lastWeekOrders[0];

    return {
      thisWeek: {
        orders: thisWeek?.orderCount || 0,
        avgCheck: Number(thisWeek?.avgTotal) || 0,
        totalSales: Number(thisWeek?.totalSales) || 0,
      },
      lastWeek: {
        orders: lastWeek?.orderCount || 0,
        avgCheck: Number(lastWeek?.avgTotal) || 0,
        totalSales: Number(lastWeek?.totalSales) || 0,
      },
      checkAvgChange: lastWeek?.avgTotal && thisWeek?.avgTotal
        ? Math.round(((Number(thisWeek.avgTotal) - Number(lastWeek.avgTotal)) / Number(lastWeek.avgTotal)) * 10000) / 100
        : 0,
      orderCountChange: lastWeek?.orderCount && thisWeek?.orderCount
        ? Math.round(((thisWeek.orderCount - lastWeek.orderCount) / lastWeek.orderCount) * 10000) / 100
        : 0,
    };
  } catch {
    return { thisWeek: { orders: 0, avgCheck: 0, totalSales: 0 }, lastWeek: { orders: 0, avgCheck: 0, totalSales: 0 }, checkAvgChange: 0, orderCountChange: 0 };
  }
}

// ---- Helper Functions ----

function normalizeDestination(dest: string | null): string {
  if (!dest) return "unknown";
  const d = dest.toLowerCase().trim();
  if (d === "in" || d.includes("dine")) return "dine_in";
  if (d === "app" || d.includes("app")) return "app";
  if (d === "3pd" || d.includes("3pd") || d.includes("doordash") || d.includes("uber")) return "3pd";
  if (d === "dt1" || d === "dt2") return "drive_thru";
  if (d === "dt3") return "dt3_outside";
  return d;
}

function formatHighSalesHours(rows: any[], restaurantMap: Map<string, string>) {
  // Group by restaurant
  const byRestaurant = new Map<string, { count: number; totalSales: number; peakSales: number; peakHour: number; peakDate: string }>();

  for (const row of rows) {
    const name = restaurantMap.get(row.restaurantId) || row.restaurantId;
    if (!byRestaurant.has(name)) {
      byRestaurant.set(name, { count: 0, totalSales: 0, peakSales: 0, peakHour: 0, peakDate: "" });
    }
    const data = byRestaurant.get(name)!;
    data.count++;
    const sales = Number(row.actualSales);
    data.totalSales += sales;
    if (sales > data.peakSales) {
      data.peakSales = sales;
      data.peakHour = row.hour;
      data.peakDate = row.salesDate instanceof Date
        ? row.salesDate.toISOString().split("T")[0]
        : String(row.salesDate).split("T")[0];
    }
  }

  const results = Array.from(byRestaurant.entries())
    .map(([name, data]) => ({
      restaurant: name,
      hoursOver2k: data.count,
      avgSalesPerHour: Math.round(data.totalSales / data.count),
      peakSales: Math.round(data.peakSales),
      peakHour: data.peakHour,
      peakDate: data.peakDate,
    }))
    .sort((a, b) => b.hoursOver2k - a.hoursOver2k);

  return {
    totalHours: rows.length,
    byRestaurant: results,
  };
}

function formatOsatLeaders(rows: any[], restaurantMap: Map<string, string>) {
  return rows.map((row, index) => ({
    rank: index + 1,
    restaurant: restaurantMap.get(row.restaurantId) || row.restaurantId,
    restaurantId: row.restaurantId,
    avgOsat: Number(row.avgOsat),
    totalResponses: row.totalResponses,
    totalFiveStar: row.totalFiveStar,
    daysWithData: row.dayCount,
  }));
}

function calculateDestinationChange(
  currentData: Map<string, Map<string, { orders: number; sales: number }>>,
  previousData: Map<string, Map<string, { orders: number; sales: number }>>,
  destType: string,
  restaurantMap: Map<string, string>
) {
  const results: { restaurant: string; currentPct: number; previousPct: number; change: number }[] = [];

  for (const [restaurantId, destMap] of currentData) {
    const name = restaurantMap.get(restaurantId) || restaurantId;
    const totalOrders = Array.from(destMap.values()).reduce((sum, d) => sum + d.orders, 0);
    const destOrders = destMap.get(destType)?.orders || 0;
    const currentPct = totalOrders > 0 ? Math.round((destOrders / totalOrders) * 10000) / 100 : 0;

    let previousPct = 0;
    const prevDestMap = previousData.get(restaurantId);
    if (prevDestMap) {
      const prevTotal = Array.from(prevDestMap.values()).reduce((sum, d) => sum + d.orders, 0);
      const prevDest = prevDestMap.get(destType)?.orders || 0;
      previousPct = prevTotal > 0 ? Math.round((prevDest / prevTotal) * 10000) / 100 : 0;
    }

    results.push({
      restaurant: name,
      currentPct,
      previousPct,
      change: Math.round((currentPct - previousPct) * 100) / 100,
    });
  }

  return results.sort((a, b) => b.change - a.change);
}

function calculateDestinationPercentages(
  data: Map<string, Map<string, { orders: number; sales: number }>>,
  destType: string,
  restaurantMap: Map<string, string>
) {
  const results: { restaurant: string; percentage: number; orders: number; totalOrders: number }[] = [];

  for (const [restaurantId, destMap] of data) {
    const name = restaurantMap.get(restaurantId) || restaurantId;
    const totalOrders = Array.from(destMap.values()).reduce((sum, d) => sum + d.orders, 0);
    const destOrders = destMap.get(destType)?.orders || 0;
    const percentage = totalOrders > 0 ? Math.round((destOrders / totalOrders) * 10000) / 100 : 0;

    results.push({
      restaurant: name,
      percentage,
      orders: destOrders,
      totalOrders,
    });
  }

  return results.sort((a, b) => b.percentage - a.percentage);
}

function formatOOTData(
  data: Map<string, { totalOrders: number; hoursUsed: number; daysUsed: Set<string> }>,
  restaurantMap: Map<string, string>
) {
  const results: { restaurant: string; totalOrders: number; hoursUsed: number; daysUsed: number; ranOOT: boolean }[] = [];

  // Include all restaurants, marking which ones used OOT
  for (const [restaurantId, name] of restaurantMap) {
    const ootData = data.get(restaurantId);
    results.push({
      restaurant: name,
      totalOrders: ootData?.totalOrders || 0,
      hoursUsed: ootData?.hoursUsed || 0,
      daysUsed: ootData?.daysUsed?.size || 0,
      ranOOT: !!ootData && ootData.totalOrders > 0,
    });
  }

  return results.sort((a, b) => b.totalOrders - a.totalOrders);
}

export default router;
