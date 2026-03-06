import { Router } from "express";
import { db, posDb } from "../db";
import { hourlySales, restaurants, dailyOsat, osatData, posOrders, locationMapping, dailySales, dailyLabor, hourlyLabor, hmeTimerData, dailyWeather, dailyGoogleReviews, hourlyCrew, employees, historicalDailySales, osatCategoryIssues } from "@shared/schema";
import { sql, and, gte, lte, lt, eq, desc, asc } from "drizzle-orm";
import { getAttachmentRatesFromDetail } from "../xenial-webhook";

const router = Router();

/**
 * AI Sales Analysis API
 * Provides pre-built analytical queries for key business questions:
 * 1. Hours with sales over $2000
 * 2. Highest OSAT scores
 * 3. Dine-in % change by unit
 * 4. App order % by unit
 * 5. Full Lane B (dt3) usage
 * 6. Top growing products week-over-week (attachment rates)
 */

// Run all analysis queries for a given date range
router.get("/api/ai-analysis", async (req, res) => {
  try {
    const { date, days = "7" } = req.query;
    const numDays = Math.min(parseInt(days as string) || 7, 90);

    // Determine date range
    const endDate = date
      ? new Date(date as string + "T12:00:00Z")
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
      highSalesHours1k,
      osatLeaders,
      destinationData,
      prevDestinationData,
      ootData,
    ] = await Promise.all([
      // 1a. Hours with sales over $2000
      getHighSalesHours(startDateStr, endDateStr, 2000),
      // 1b. Hours with sales over $1000
      getHighSalesHours(startDateStr, endDateStr, 1000),
      // 2. Highest OSAT scores
      getOsatLeaders(startDateStr, endDateStr),
      // 3 & 4. Destination breakdown (current period)
      getDestinationBreakdown(startDateStr, endDateStr),
      // 3 & 4. Destination breakdown (previous period for comparison)
      getDestinationBreakdown(prevStartDateStr, prevEndDateStr),
      // 5. Full Lane B usage
      getFullLaneBUsage(startDateStr, endDateStr),
    ]);

    // Process dine-in % change
    const dineInChange = calculateDestinationChange(destinationData, prevDestinationData, "dine_in", restaurantMap);
    const appPercentages = calculateDestinationPercentages(destinationData, "app", restaurantMap);
    const deliveryPercentages = calculateDeliveryPercentages(destinationData, restaurantMap);

    res.json({
      dateRange: { start: startDateStr, end: endDateStr, days: numDays },
      previousPeriod: { start: prevStartDateStr, end: prevEndDateStr },
      insights: {
        highSalesHours: formatHighSalesHours(highSalesHours, restaurantMap),
        highSalesHours1k: formatHighSalesHours1k(highSalesHours1k, restaurantMap),
        osatLeaders: formatOsatLeaders(osatLeaders, restaurantMap),
        dineInChange,
        appPercentages,
        deliveryPercentages,
        fullLaneB: formatFullLaneBData(ootData, restaurantMap),
      },
    });
  } catch (error) {
    console.error("Error in AI analysis:", error);
    res.status(500).json({ error: "Failed to run analysis" });
  }
});

// ---- Query Functions ----

async function getHighSalesHours(startDate: string, endDate: string, threshold: number) {
  const startTs = new Date(startDate + "T00:00:00Z");
  const endTs = new Date(endDate + "T23:59:59Z");

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
  const startTs = new Date(startDate + "T00:00:00Z");
  const endTs = new Date(endDate + "T23:59:59Z");

  // Get location mappings for restaurant name resolution
  const mappings = await db.select().from(locationMapping);
  const storeToRestaurant = new Map(mappings.map((m) => [m.xenialStoreNumber, m.restaurantId]));

  // Use a SQL CASE expression to classify orders correctly:
  // order_source takes priority for app/3PD, destination for physical lane
  const chExpr = destChannelExpr();

  const rows = await posDb
    .select({
      storeNumber: posOrders.storeNumber,
      channel: sql<string>`${chExpr}`,
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
    .groupBy(posOrders.storeNumber, chExpr);

  // Group by restaurant
  const result = new Map<string, Map<string, { orders: number; sales: number }>>();

  for (const row of rows) {
    const restaurantId = storeToRestaurant.get(row.storeNumber) || row.storeNumber;
    if (!result.has(restaurantId)) {
      result.set(restaurantId, new Map());
    }
    const destMap = result.get(restaurantId)!;
    const dest = row.channel || "unknown";
    const existing = destMap.get(dest) || { orders: 0, sales: 0 };
    existing.orders += row.orderCount;
    existing.sales += Number(row.totalSales);
    destMap.set(dest, existing);
  }

  return result;
}

async function getFullLaneBUsage(startDate: string, endDate: string) {
  const startTs = new Date(startDate + "T00:00:00Z");
  const endTs = new Date(endDate + "T23:59:59Z");

  const mappings = await db.select().from(locationMapping);
  const storeToRestaurant = new Map(mappings.map((m) => [m.xenialStoreNumber, m.restaurantId]));

  // dt3 = Full Lane B — check both destination and order_source
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
        sql`COALESCE(LOWER(${posOrders.destination}), LOWER(${posOrders.orderSource})) like '%dt3%'`
      )
    )
    .groupBy(posOrders.storeNumber, sql`${posOrders.businessDate}::date::text`, sql`extract(hour from ${posOrders.orderClosedAt})::int`)
    .orderBy(desc(sql`count(*)`));

  // Aggregate by restaurant
  const restaurantLaneB = new Map<string, { totalOrders: number; hoursUsed: number; daysUsed: Set<string> }>();

  for (const row of rows) {
    const restaurantId = storeToRestaurant.get(row.storeNumber) || row.storeNumber;
    if (!restaurantLaneB.has(restaurantId)) {
      restaurantLaneB.set(restaurantId, { totalOrders: 0, hoursUsed: 0, daysUsed: new Set() });
    }
    const data = restaurantLaneB.get(restaurantId)!;
    data.totalOrders += row.orderCount;
    data.hoursUsed += 1;
    data.daysUsed.add(row.businessDate);
  }

  return restaurantLaneB;
}

// ---- Helper Functions ----


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
      data.peakDate = new Date(row.salesDate).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
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

function formatHighSalesHours1k(rows: any[], restaurantMap: Map<string, string>) {
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
      data.peakDate = new Date(row.salesDate).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    }
  }

  const results = Array.from(byRestaurant.entries())
    .map(([name, data]) => ({
      restaurant: name,
      hoursOver1k: data.count,
      avgSalesPerHour: Math.round(data.totalSales / data.count),
      peakSales: Math.round(data.peakSales),
      peakHour: data.peakHour,
      peakDate: data.peakDate,
    }))
    .sort((a, b) => b.hoursOver1k - a.hoursOver1k);

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

function calculateDeliveryPercentages(
  data: Map<string, Map<string, { orders: number; sales: number }>>,
  restaurantMap: Map<string, string>
) {
  const results: { restaurant: string; percentage: number; orders: number; totalOrders: number }[] = [];

  for (const [restaurantId, destMap] of data) {
    const name = restaurantMap.get(restaurantId) || restaurantId;
    const totalOrders = Array.from(destMap.values()).reduce((sum, d) => sum + d.orders, 0);
    // Combine 3pd and delivery orders for total delivery %
    const deliveryOrders = (destMap.get("3pd")?.orders || 0) + (destMap.get("delivery")?.orders || 0);
    const percentage = totalOrders > 0 ? Math.round((deliveryOrders / totalOrders) * 10000) / 100 : 0;

    results.push({
      restaurant: name,
      percentage,
      orders: deliveryOrders,
      totalOrders,
    });
  }

  return results.sort((a, b) => b.percentage - a.percentage);
}

function formatFullLaneBData(
  data: Map<string, { totalOrders: number; hoursUsed: number; daysUsed: Set<string> }>,
  restaurantMap: Map<string, string>
) {
  const results: { restaurant: string; totalOrders: number; hoursUsed: number; daysUsed: number; active: boolean }[] = [];

  for (const [restaurantId, name] of restaurantMap) {
    const laneBData = data.get(restaurantId);
    results.push({
      restaurant: name,
      totalOrders: laneBData?.totalOrders || 0,
      hoursUsed: laneBData?.hoursUsed || 0,
      daysUsed: laneBData?.daysUsed?.size || 0,
      active: !!laneBData && laneBData.totalOrders > 0,
    });
  }

  return results.sort((a, b) => b.totalOrders - a.totalOrders);
}

// ======================================================================
// DYNAMIC QUERY ENGINE - Accepts free-form questions from the frontend
// ======================================================================

interface QueryTemplate {
  id: string;
  keywords: string[];
  description: string;
  execute: (params: QueryParams) => Promise<QueryResult>;
}

interface QueryParams {
  startDate: string;
  endDate: string;
  prevStartDate: string;
  prevEndDate: string;
  restaurantMap: Map<string, string>;
  threshold?: number;
  restaurantFilter?: string;
}

interface QueryResult {
  title: string;
  summary: string;
  columns: { key: string; label: string; align?: "left" | "center" | "right" }[];
  rows: Record<string, any>[];
  highlight?: { label: string; value: string; detail?: string };
}

// Extract a dollar amount from a question like "over $3000" or "above 1500"
function extractThreshold(question: string): number | undefined {
  const match = question.match(/\$?\s*([\d,]+)/);
  if (match) return parseFloat(match[1].replace(",", ""));
  return undefined;
}

// Extract a restaurant name filter from the question
function extractRestaurantFilter(question: string, restaurantMap: Map<string, string>): string | undefined {
  const lowerQ = question.toLowerCase();
  for (const [id, name] of restaurantMap) {
    if (lowerQ.includes(name.toLowerCase())) return id;
  }
  return undefined;
}

// Score how well a question matches a template
function scoreMatch(question: string, template: QueryTemplate): number {
  const lower = question.toLowerCase();
  let score = 0;
  for (const kw of template.keywords) {
    if (lower.includes(kw.toLowerCase())) {
      score += kw.length; // longer keyword matches = higher score
    }
  }
  return score;
}

// Helper to get store-to-restaurant mapping
async function getStoreMapping() {
  const mappings = await db.select().from(locationMapping);
  return new Map(mappings.map((m) => [m.xenialStoreNumber, m.restaurantId]));
}

// COALESCE expression for destination — falls back to order_source for app/3PD orders
const destCoalesce = sql`COALESCE(LOWER(${posOrders.destination}), LOWER(${posOrders.orderSource}))`;

// SQL CASE expression to classify order channel using both order_source and destination
function destChannelExpr() {
  return sql`CASE
    WHEN LOWER(${posOrders.orderSource}) IN ('app', 'mobile', 'online') THEN 'app'
    WHEN LOWER(${posOrders.orderSource}) LIKE '%3pd%' OR LOWER(${posOrders.orderSource}) IN ('doordash', 'ubereats', 'grubhub') THEN '3pd'
    WHEN LOWER(${posOrders.orderSource}) LIKE '%delivery%' THEN 'delivery'
    WHEN LOWER(${posOrders.destination}) IN ('in', 'dine-in') OR LOWER(${posOrders.destination}) LIKE '%dine%' THEN 'dine_in'
    WHEN LOWER(${posOrders.destination}) = 'dt3' THEN 'dt3_outside'
    WHEN LOWER(${posOrders.destination}) IN ('dt1', 'dt2', 'drive-thru', 'drive_thru') THEN 'drive_thru'
    WHEN LOWER(${posOrders.destination}) IN ('app', 'mobile', 'online') THEN 'app'
    WHEN LOWER(${posOrders.destination}) LIKE '%3pd%' THEN '3pd'
    WHEN LOWER(${posOrders.destination}) LIKE '%delivery%' THEN 'delivery'
    WHEN LOWER(${posOrders.destination}) IN ('doordash', 'ubereats', 'grubhub') THEN '3pd'
    WHEN LOWER(${posOrders.orderSource}) = 'pos' THEN 'drive_thru'
    ELSE COALESCE(LOWER(${posOrders.destination}), LOWER(${posOrders.orderSource}), 'unknown')
  END`;
}

// Categories to exclude from product/item-level queries (non-food, modifiers, surcharges)
const EXCLUDED_CATEGORIES = new Set([
  "modifiers", "modifier", "surcharges", "surcharge", "non-food items", "non-food",
  "non food", "non food items", "supplies", "misc", "miscellaneous",
]);

function isExcludedCategory(category: string): boolean {
  return EXCLUDED_CATEGORIES.has(category.toLowerCase().trim());
}

// Build the query template library
function buildTemplates(): QueryTemplate[] {
  return [
    // ---- SALES ----
    {
      id: "hours_over_threshold",
      keywords: ["hours", "sales", "over", "above", "exceed", "$2000", "$3000", "$1500", "$1000", "high sales"],
      description: "Hours of sales over a threshold",
      execute: async (params) => {
        const threshold = params.threshold || 2000;
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const rows = await db
          .select({
            restaurantId: hourlySales.restaurantId,
            salesDate: hourlySales.salesDate,
            hour: hourlySales.hour,
            actualSales: hourlySales.actualSales,
          })
          .from(hourlySales)
          .where(and(
            gte(hourlySales.salesDate, startTs),
            lte(hourlySales.salesDate, endTs),
            gte(hourlySales.actualSales, threshold.toString()),
            ...(params.restaurantFilter ? [eq(hourlySales.restaurantId, params.restaurantFilter)] : [])
          ))
          .orderBy(desc(hourlySales.actualSales));

        const byUnit = new Map<string, { count: number; total: number; peak: number }>();
        for (const r of rows) {
          const name = params.restaurantMap.get(r.restaurantId) || r.restaurantId;
          const d = byUnit.get(name) || { count: 0, total: 0, peak: 0 };
          d.count++;
          const s = Number(r.actualSales);
          d.total += s;
          if (s > d.peak) d.peak = s;
          byUnit.set(name, d);
        }

        const formatted = Array.from(byUnit.entries())
          .map(([name, d]) => ({ unit: name, hours: d.count, avgSales: `$${Math.round(d.total / d.count).toLocaleString()}`, peakHour: `$${Math.round(d.peak).toLocaleString()}` }))
          .sort((a, b) => b.hours - a.hours);

        return {
          title: `Hours with Sales Over $${threshold.toLocaleString()}`,
          summary: `${rows.length} total hours across ${byUnit.size} units exceeded $${threshold.toLocaleString()} in sales.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "hours", label: "Hours", align: "center" },
            { key: "avgSales", label: "Avg/Hour", align: "right" },
            { key: "peakHour", label: "Peak Hour", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Top Unit", value: formatted[0].unit, detail: `${formatted[0].hours} hours` } : undefined,
        };
      },
    },
    {
      id: "daily_sales_by_unit",
      keywords: ["daily sales", "total sales", "sales by unit", "sales by restaurant", "sales summary", "revenue"],
      description: "Daily sales totals by unit",
      execute: async (params) => {
        // Use hourlySales aggregated by restaurant+date to avoid duplicate dailySales rows
        const salesRows = await db
          .select({
            restaurantId: hourlySales.restaurantId,
            salesDate: hourlySales.salesDate,
            hour: hourlySales.hour,
            actualSales: hourlySales.actualSales,
          })
          .from(hourlySales)
          .where(and(
            gte(hourlySales.salesDate, new Date(params.startDate + "T00:00:00Z")),
            lte(hourlySales.salesDate, new Date(params.endDate + "T23:59:59Z")),
            ...(params.restaurantFilter ? [eq(hourlySales.restaurantId, params.restaurantFilter)] : [])
          ));

        // Aggregate by restaurant → date → sum of hourly sales
        const byRestaurant = new Map<string, Map<string, number>>();
        for (const row of salesRows) {
          const dateStr = new Date(row.salesDate).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
          if (!byRestaurant.has(row.restaurantId)) byRestaurant.set(row.restaurantId, new Map());
          const dateMap = byRestaurant.get(row.restaurantId)!;
          dateMap.set(dateStr, (dateMap.get(dateStr) || 0) + Number(row.actualSales));
        }

        const rows = Array.from(byRestaurant.entries()).map(([restaurantId, dateMap]) => {
          const dailyTotals = Array.from(dateMap.values());
          const totalSales = dailyTotals.reduce((s, v) => s + v, 0);
          return {
            restaurantId,
            totalSales,
            dayCount: dailyTotals.length,
            avgDaily: Math.round(totalSales / dailyTotals.length),
          };
        }).sort((a, b) => b.totalSales - a.totalSales);

        const formatted = rows.map((r) => ({
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          totalSales: `$${Math.round(r.totalSales).toLocaleString()}`,
          days: r.dayCount,
          avgDaily: `$${r.avgDaily.toLocaleString()}`,
        }));

        const grandTotal = rows.reduce((s, r) => s + r.totalSales, 0);

        return {
          title: "Sales Summary by Unit",
          summary: `Total sales across all units: $${Math.round(grandTotal).toLocaleString()} over ${params.startDate} to ${params.endDate}.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "totalSales", label: "Total Sales", align: "right" },
            { key: "days", label: "Days", align: "center" },
            { key: "avgDaily", label: "Avg/Day", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Top Unit", value: formatted[0].unit, detail: formatted[0].totalSales } : undefined,
        };
      },
    },
    {
      id: "top_sales_day",
      keywords: ["best day", "highest day", "top day", "best sales day", "peak day", "busiest day"],
      description: "Best sales day by unit",
      execute: async (params) => {
        // Use hourlySales aggregated by restaurant+date to avoid duplicate dailySales rows
        const salesRows = await db
          .select({
            restaurantId: hourlySales.restaurantId,
            salesDate: hourlySales.salesDate,
            actualSales: hourlySales.actualSales,
          })
          .from(hourlySales)
          .where(and(
            gte(hourlySales.salesDate, new Date(params.startDate + "T00:00:00Z")),
            lte(hourlySales.salesDate, new Date(params.endDate + "T23:59:59Z")),
          ));

        // Aggregate by restaurant+date
        const byKey = new Map<string, { restaurantId: string; dateStr: string; total: number }>();
        for (const row of salesRows) {
          const dateStr = new Date(row.salesDate).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
          const key = `${row.restaurantId}|${dateStr}`;
          if (!byKey.has(key)) byKey.set(key, { restaurantId: row.restaurantId, dateStr, total: 0 });
          byKey.get(key)!.total += Number(row.actualSales);
        }

        const sorted = Array.from(byKey.values()).sort((a, b) => b.total - a.total).slice(0, 20);

        const formatted = sorted.map((r, i) => ({
          rank: i + 1,
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          date: r.dateStr,
          sales: `$${Math.round(r.total).toLocaleString()}`,
        }));

        return {
          title: "Top Sales Days",
          summary: `Highest single-day sales across all units.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "date", label: "Date", align: "center" },
            { key: "sales", label: "Sales", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Best Day", value: `${formatted[0].unit} on ${formatted[0].date}`, detail: formatted[0].sales } : undefined,
        };
      },
    },
    // ---- OSAT ----
    {
      id: "osat_scores",
      keywords: ["osat", "satisfaction", "5 star", "five star", "customer", "survey", "highest osat", "best osat", "lowest osat", "worst osat"],
      description: "OSAT scores by unit",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: dailyOsat.restaurantId,
            avgOsat: sql<number>`round(avg(${dailyOsat.osatPercent}::numeric), 1)`,
            totalResponses: sql<number>`sum(${dailyOsat.totalResponses})::int`,
            totalFiveStar: sql<number>`sum(${dailyOsat.fiveStarCount})::int`,
            days: sql<number>`count(distinct ${dailyOsat.date})::int`,
          })
          .from(dailyOsat)
          .where(and(
            gte(dailyOsat.date, params.startDate),
            lte(dailyOsat.date, params.endDate),
            gte(dailyOsat.totalResponses, 1),
            ...(params.restaurantFilter ? [eq(dailyOsat.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(dailyOsat.restaurantId)
          .orderBy(desc(sql`avg(${dailyOsat.osatPercent}::numeric)`));

        const formatted = rows.map((r, i) => ({
          rank: i + 1,
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          osat: `${Number(r.avgOsat)}%`,
          responses: r.totalResponses,
          fiveStar: r.totalFiveStar,
        }));

        return {
          title: "OSAT Scores by Unit",
          summary: `Customer satisfaction (5-star %) ranked by unit. ${formatted.length} units with survey data.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "osat", label: "OSAT %", align: "right" },
            { key: "responses", label: "Responses", align: "right" },
            { key: "fiveStar", label: "5-Star", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Highest OSAT", value: formatted[0].unit, detail: formatted[0].osat } : undefined,
        };
      },
    },
    {
      id: "osat_category_breakdown",
      keywords: ["osat category", "accuracy", "food quality", "speed of service", "cleanliness", "friendliness", "order accuracy", "osat breakdown", "osat detail"],
      description: "OSAT category issue breakdown",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: osatCategoryIssues.restaurantId,
            avgAccuracy: sql<number>`round(avg(${osatCategoryIssues.orderAccuracy}::numeric), 2)`,
            avgFoodQuality: sql<number>`round(avg(${osatCategoryIssues.foodQuality}::numeric), 2)`,
            avgSpeed: sql<number>`round(avg(${osatCategoryIssues.speedOfService}::numeric), 2)`,
            avgCleanliness: sql<number>`round(avg(${osatCategoryIssues.cleanliness}::numeric), 2)`,
            avgFriendliness: sql<number>`round(avg(${osatCategoryIssues.employeeFriendliness}::numeric), 2)`,
            cnt: sql<number>`count(*)::int`,
          })
          .from(osatCategoryIssues)
          .where(and(
            gte(osatCategoryIssues.date, params.startDate),
            lte(osatCategoryIssues.date, params.endDate),
            ...(params.restaurantFilter ? [eq(osatCategoryIssues.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(osatCategoryIssues.restaurantId)
          .orderBy(asc(sql`avg(${osatCategoryIssues.orderAccuracy}::numeric)`));

        const formatted = rows.map((r) => ({
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          accuracy: r.avgAccuracy ? Number(r.avgAccuracy).toFixed(1) : "-",
          foodQuality: r.avgFoodQuality ? Number(r.avgFoodQuality).toFixed(1) : "-",
          speed: r.avgSpeed ? Number(r.avgSpeed).toFixed(1) : "-",
          cleanliness: r.avgCleanliness ? Number(r.avgCleanliness).toFixed(1) : "-",
          friendliness: r.avgFriendliness ? Number(r.avgFriendliness).toFixed(1) : "-",
          surveys: r.cnt,
        }));

        return {
          title: "OSAT Category Breakdown",
          summary: `Average category ratings (1-5 scale) across survey responses.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "accuracy", label: "Accuracy", align: "center" },
            { key: "foodQuality", label: "Food", align: "center" },
            { key: "speed", label: "Speed", align: "center" },
            { key: "cleanliness", label: "Clean", align: "center" },
            { key: "friendliness", label: "Friendly", align: "center" },
            { key: "surveys", label: "Surveys", align: "right" },
          ],
          rows: formatted,
        };
      },
    },
    // ---- LABOR ----
    {
      id: "labor_percent",
      keywords: ["labor", "labor %", "labor percent", "labor cost", "staffing cost", "payroll"],
      description: "Labor percentage by unit",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: dailyLabor.restaurantId,
            avgLabor: sql<number>`round(avg(${dailyLabor.laborPercent}::numeric), 1)`,
            avgCost: sql<number>`round(avg(${dailyLabor.actualLaborCost}::numeric), 0)`,
            days: sql<number>`count(*)::int`,
          })
          .from(dailyLabor)
          .where(and(
            gte(dailyLabor.date, params.startDate),
            lte(dailyLabor.date, params.endDate),
            ...(params.restaurantFilter ? [eq(dailyLabor.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(dailyLabor.restaurantId)
          .orderBy(asc(sql`avg(${dailyLabor.laborPercent}::numeric)`));

        const formatted = rows.map((r, i) => ({
          rank: i + 1,
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          laborPct: r.avgLabor ? `${Number(r.avgLabor)}%` : "-",
          avgDailyCost: r.avgCost ? `$${Number(r.avgCost).toLocaleString()}` : "-",
          days: r.days,
        }));

        return {
          title: "Labor % by Unit",
          summary: `Average labor percentage (lower is better). Target is typically 25%.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "laborPct", label: "Labor %", align: "right" },
            { key: "avgDailyCost", label: "Avg Daily Cost", align: "right" },
            { key: "days", label: "Days", align: "center" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Best Labor %", value: formatted[0].unit, detail: formatted[0].laborPct } : undefined,
        };
      },
    },
    // ---- DRIVE THRU ----
    {
      id: "drive_thru_speed",
      keywords: ["drive thru", "drive-thru", "speed", "service time", "sos", "dt time", "timer", "hme", "car count", "cars"],
      description: "Drive-thru speed metrics",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: hmeTimerData.restaurantId,
            avgService: sql<number>`round(avg(${hmeTimerData.avgServiceTime}::numeric), 0)`,
            avgTotal: sql<number>`round(avg(${hmeTimerData.avgTotalTime}::numeric), 0)`,
            totalCars: sql<number>`sum(${hmeTimerData.carCount})::int`,
            carsUnder6: sql<number>`sum(${hmeTimerData.carsUnder6Min})::int`,
            hours: sql<number>`count(*)::int`,
          })
          .from(hmeTimerData)
          .where(and(
            gte(hmeTimerData.date, params.startDate),
            lte(hmeTimerData.date, params.endDate),
            ...(params.restaurantFilter ? [eq(hmeTimerData.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(hmeTimerData.restaurantId)
          .orderBy(asc(sql`avg(${hmeTimerData.avgServiceTime}::numeric)`));

        const formatted = rows.map((r, i) => {
          const totalCars = Number(r.totalCars) || 0;
          const under6 = Number(r.carsUnder6) || 0;
          return {
            rank: i + 1,
            unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
            avgService: r.avgService ? `${Number(r.avgService)}s` : "-",
            avgTotal: r.avgTotal ? `${Number(r.avgTotal)}s` : "-",
            cars: totalCars.toLocaleString(),
            under6Pct: totalCars > 0 ? `${Math.round((under6 / totalCars) * 100)}%` : "-",
          };
        });

        return {
          title: "Drive-Thru Speed",
          summary: `Average service time and car counts. Faster is better.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "avgService", label: "Avg Service", align: "right" },
            { key: "avgTotal", label: "Avg Total", align: "right" },
            { key: "cars", label: "Cars", align: "right" },
            { key: "under6Pct", label: "<6min %", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Fastest", value: formatted[0].unit, detail: formatted[0].avgService } : undefined,
        };
      },
    },
    // ---- DESTINATIONS ----
    {
      id: "dine_in_percent",
      keywords: ["dine in", "dine-in", "dining", "eat in", "lobby"],
      description: "Dine-in percentage by unit",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");
        const prevStartTs = new Date(params.prevStartDate + "T00:00:00Z");
        const prevEndTs = new Date(params.prevEndDate + "T23:59:59Z");

        const chExpr = destChannelExpr();

        const [current, previous] = await Promise.all([
          posDb.select({
            storeNumber: posOrders.storeNumber,
            channel: sql<string>`${chExpr}`,
            cnt: sql<number>`count(*)::int`,
          }).from(posOrders).where(and(gte(posOrders.businessDate, startTs), lte(posOrders.businessDate, endTs))).groupBy(posOrders.storeNumber, chExpr),
          posDb.select({
            storeNumber: posOrders.storeNumber,
            channel: sql<string>`${chExpr}`,
            cnt: sql<number>`count(*)::int`,
          }).from(posOrders).where(and(gte(posOrders.businessDate, prevStartTs), lte(posOrders.businessDate, prevEndTs))).groupBy(posOrders.storeNumber, chExpr),
        ]);

        function calcPct(rows: any[]) {
          const byStore = new Map<string, { dineIn: number; total: number }>();
          for (const r of rows) {
            const rid = storeMap.get(r.storeNumber) || r.storeNumber;
            const d = byStore.get(rid) || { dineIn: 0, total: 0 };
            d.total += r.cnt;
            if (r.channel === "dine_in") d.dineIn += r.cnt;
            byStore.set(rid, d);
          }
          return byStore;
        }

        const curPcts = calcPct(current);
        const prevPcts = calcPct(previous);

        const formatted: any[] = [];
        for (const [rid, d] of curPcts) {
          const name = params.restaurantMap.get(rid) || rid;
          const curP = d.total > 0 ? Math.round((d.dineIn / d.total) * 10000) / 100 : 0;
          const prev = prevPcts.get(rid);
          const prevP = prev && prev.total > 0 ? Math.round((prev.dineIn / prev.total) * 10000) / 100 : 0;
          formatted.push({ unit: name, current: `${curP}%`, previous: `${prevP}%`, change: `${curP - prevP > 0 ? "+" : ""}${(curP - prevP).toFixed(1)} pp` });
        }
        formatted.sort((a, b) => parseFloat(b.change) - parseFloat(a.change));

        return {
          title: "Dine-In % by Unit",
          summary: `Dine-in order percentage compared to previous period.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "current", label: "Current %", align: "right" },
            { key: "previous", label: "Previous %", align: "right" },
            { key: "change", label: "Change", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Biggest Increase", value: formatted[0].unit, detail: formatted[0].change } : undefined,
        };
      },
    },
    {
      id: "app_percent",
      keywords: ["app", "mobile", "app order", "app %", "app percentage", "online order"],
      description: "App order percentage by unit",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const chExpr = destChannelExpr();
        const rows = await posDb.select({
          storeNumber: posOrders.storeNumber,
          channel: sql<string>`${chExpr}`,
          cnt: sql<number>`count(*)::int`,
        }).from(posOrders).where(and(gte(posOrders.businessDate, startTs), lte(posOrders.businessDate, endTs))).groupBy(posOrders.storeNumber, chExpr);

        const byStore = new Map<string, { app: number; total: number }>();
        for (const r of rows) {
          const rid = storeMap.get(r.storeNumber) || r.storeNumber;
          const d = byStore.get(rid) || { app: 0, total: 0 };
          d.total += r.cnt;
          if (r.channel === "app") d.app += r.cnt;
          byStore.set(rid, d);
        }

        const formatted = Array.from(byStore.entries())
          .map(([rid, d]) => ({
            unit: params.restaurantMap.get(rid) || rid,
            appPct: d.total > 0 ? `${(Math.round((d.app / d.total) * 10000) / 100)}%` : "0%",
            appOrders: d.app.toLocaleString(),
            totalOrders: d.total.toLocaleString(),
          }))
          .sort((a, b) => parseFloat(b.appPct) - parseFloat(a.appPct));

        return {
          title: "App Order % by Unit",
          summary: `Percentage of orders placed through the mobile app.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "appPct", label: "App %", align: "right" },
            { key: "appOrders", label: "App Orders", align: "right" },
            { key: "totalOrders", label: "Total Orders", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Highest App %", value: formatted[0].unit, detail: formatted[0].appPct } : undefined,
        };
      },
    },
    {
      id: "3pd_percent",
      keywords: ["3pd", "third party", "doordash", "uber eats", "delivery", "3rd party"],
      description: "3PD (third-party delivery) percentage by unit",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const chExpr = destChannelExpr();
        const rows = await posDb.select({
          storeNumber: posOrders.storeNumber,
          channel: sql<string>`${chExpr}`,
          cnt: sql<number>`count(*)::int`,
        }).from(posOrders).where(and(gte(posOrders.businessDate, startTs), lte(posOrders.businessDate, endTs))).groupBy(posOrders.storeNumber, chExpr);

        const byStore = new Map<string, { thirdParty: number; total: number }>();
        for (const r of rows) {
          const rid = storeMap.get(r.storeNumber) || r.storeNumber;
          const d = byStore.get(rid) || { thirdParty: 0, total: 0 };
          d.total += r.cnt;
          if (r.channel === "3pd" || r.channel === "delivery") d.thirdParty += r.cnt;
          byStore.set(rid, d);
        }

        const formatted = Array.from(byStore.entries())
          .map(([rid, d]) => ({
            unit: params.restaurantMap.get(rid) || rid,
            pct: d.total > 0 ? `${(Math.round((d.thirdParty / d.total) * 10000) / 100)}%` : "0%",
            orders: d.thirdParty.toLocaleString(),
            total: d.total.toLocaleString(),
          }))
          .sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));

        return {
          title: "3PD (Delivery) % by Unit",
          summary: `Third-party delivery orders (DoorDash, Uber Eats, etc.) as a percentage of total.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "pct", label: "3PD %", align: "right" },
            { key: "orders", label: "3PD Orders", align: "right" },
            { key: "total", label: "Total Orders", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Highest 3PD %", value: formatted[0].unit, detail: formatted[0].pct } : undefined,
        };
      },
    },
    {
      id: "destination_full_breakdown",
      keywords: ["destination", "channel", "order type", "order breakdown", "where are orders", "order mix", "channel mix"],
      description: "Full destination breakdown (dine-in, drive-thru, app, 3PD, delivery)",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const chExpr = destChannelExpr();
        const rows = await posDb.select({
          storeNumber: posOrders.storeNumber,
          channel: sql<string>`${chExpr}`,
          cnt: sql<number>`count(*)::int`,
        }).from(posOrders).where(and(gte(posOrders.businessDate, startTs), lte(posOrders.businessDate, endTs))).groupBy(posOrders.storeNumber, chExpr);

        const byStore = new Map<string, Record<string, number>>();
        for (const r of rows) {
          const rid = storeMap.get(r.storeNumber) || r.storeNumber;
          const d = byStore.get(rid) || {};
          const ch = r.channel || "unknown";
          d[ch] = (d[ch] || 0) + r.cnt;
          d._total = (d._total || 0) + r.cnt;
          byStore.set(rid, d);
        }

        const formatted = Array.from(byStore.entries())
          .map(([rid, d]) => {
            const t = d._total || 1;
            return {
              unit: params.restaurantMap.get(rid) || rid,
              driveThru: `${Math.round(((d.drive_thru || 0) / t) * 100)}%`,
              dineIn: `${Math.round(((d.dine_in || 0) / t) * 100)}%`,
              app: `${Math.round(((d.app || 0) / t) * 100)}%`,
              thirdParty: `${Math.round(((d["3pd"] || 0) / t) * 100)}%`,
              delivery: `${Math.round(((d.delivery || 0) / t) * 100)}%`,
              oot: `${Math.round(((d.dt3_outside || 0) / t) * 100)}%`,
              total: t.toLocaleString(),
            };
          })
          .sort((a, b) => parseInt(b.total.replace(/,/g, "")) - parseInt(a.total.replace(/,/g, "")));

        return {
          title: "Order Channel Mix",
          summary: `Full breakdown of order destinations across all units.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "driveThru", label: "Drive-Thru", align: "center" },
            { key: "dineIn", label: "Dine-In", align: "center" },
            { key: "app", label: "App", align: "center" },
            { key: "thirdParty", label: "3PD", align: "center" },
            { key: "delivery", label: "Delivery", align: "center" },
            { key: "oot", label: "Full Lane B", align: "center" },
            { key: "total", label: "Orders", align: "right" },
          ],
          rows: formatted,
        };
      },
    },
    // ---- OOT ----
    {
      id: "full_lane_b",
      keywords: ["full lane b", "lane b", "dt3", "full lane"],
      description: "Full Lane B (dt3) usage",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const rows = await posDb.select({
          storeNumber: posOrders.storeNumber,
          businessDate: sql<string>`${posOrders.businessDate}::date::text`,
          cnt: sql<number>`count(*)::int`,
        }).from(posOrders).where(and(
          gte(posOrders.businessDate, startTs),
          lte(posOrders.businessDate, endTs),
          sql`${destCoalesce} like '%dt3%'`
        )).groupBy(posOrders.storeNumber, sql`${posOrders.businessDate}::date::text`);

        const byStore = new Map<string, { orders: number; days: Set<string> }>();
        for (const r of rows) {
          const rid = storeMap.get(r.storeNumber) || r.storeNumber;
          const d = byStore.get(rid) || { orders: 0, days: new Set() };
          d.orders += r.cnt;
          d.days.add(r.businessDate);
          byStore.set(rid, d);
        }

        const formatted: any[] = [];
        for (const [rid, name] of params.restaurantMap) {
          const d = byStore.get(rid);
          formatted.push({
            unit: name,
            active: d ? "Yes" : "No",
            orders: d ? d.orders.toLocaleString() : "0",
            days: d ? d.days.size : 0,
          });
        }
        formatted.sort((a, b) => parseInt(b.orders.replace(/,/g, "")) - parseInt(a.orders.replace(/,/g, "")));

        const activeCount = formatted.filter((r) => r.active === "Yes").length;
        return {
          title: "Full Lane B Usage",
          summary: `${activeCount} unit(s) ran Full Lane B (DT3) during this period.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "active", label: "Active", align: "center" },
            { key: "orders", label: "Full Lane B Orders", align: "right" },
            { key: "days", label: "Days Used", align: "center" },
          ],
          rows: formatted,
          highlight: formatted[0] && formatted[0].active === "Yes" ? { label: "Most Full Lane B Orders", value: formatted[0].unit, detail: `${formatted[0].orders} orders` } : undefined,
        };
      },
    },
    // ---- WEATHER ----
    {
      id: "weather_impact",
      keywords: ["weather", "temperature", "rain", "snow", "wind", "hot", "cold", "storm"],
      description: "Weather conditions by unit",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: dailyWeather.restaurantId,
            avgHigh: sql<number>`round(avg(${dailyWeather.highTemp}::numeric), 0)`,
            avgLow: sql<number>`round(avg(${dailyWeather.lowTemp}::numeric), 0)`,
            days: sql<number>`count(*)::int`,
          })
          .from(dailyWeather)
          .where(and(
            gte(dailyWeather.date, params.startDate),
            lte(dailyWeather.date, params.endDate),
            ...(params.restaurantFilter ? [eq(dailyWeather.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(dailyWeather.restaurantId)
          .orderBy(desc(sql`avg(${dailyWeather.highTemp}::numeric)`));

        const formatted = rows.map((r) => ({
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          avgHigh: r.avgHigh ? `${Number(r.avgHigh)}°F` : "-",
          avgLow: r.avgLow ? `${Number(r.avgLow)}°F` : "-",
          days: r.days,
        }));

        return {
          title: "Weather by Location",
          summary: `Average temperature data by unit location.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "avgHigh", label: "Avg High", align: "right" },
            { key: "avgLow", label: "Avg Low", align: "right" },
            { key: "days", label: "Days", align: "center" },
          ],
          rows: formatted,
        };
      },
    },
    // ---- GOOGLE REVIEWS ----
    {
      id: "google_reviews",
      keywords: ["google", "review", "rating", "google review", "google rating", "stars"],
      description: "Google review ratings",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: dailyGoogleReviews.restaurantId,
            avgRating: sql<number>`round(avg(${dailyGoogleReviews.rating}::numeric), 2)`,
            latestReviews: sql<number>`max(${dailyGoogleReviews.reviewCount})::int`,
            days: sql<number>`count(*)::int`,
          })
          .from(dailyGoogleReviews)
          .where(and(
            gte(dailyGoogleReviews.date, params.startDate),
            lte(dailyGoogleReviews.date, params.endDate),
            ...(params.restaurantFilter ? [eq(dailyGoogleReviews.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(dailyGoogleReviews.restaurantId)
          .orderBy(desc(sql`avg(${dailyGoogleReviews.rating}::numeric)`));

        const formatted = rows.map((r, i) => ({
          rank: i + 1,
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          rating: r.avgRating ? Number(r.avgRating).toFixed(2) : "-",
          reviews: r.latestReviews || 0,
        }));

        return {
          title: "Google Ratings",
          summary: `Average Google rating by unit.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "rating", label: "Avg Rating", align: "right" },
            { key: "reviews", label: "Reviews", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Top Rated", value: formatted[0].unit, detail: `${formatted[0].rating} stars` } : undefined,
        };
      },
    },
    // ---- CREW / PEOPLE ----
    {
      id: "crew_experience",
      keywords: ["crew", "experience", "tenure", "team", "employee", "staff", "people"],
      description: "Crew experience scores",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: hourlyCrew.restaurantId,
            avgScore: sql<number>`round(avg(${hourlyCrew.experienceScore}::numeric), 1)`,
            avgTenure: sql<number>`round(avg(${hourlyCrew.avgTenureMonths}::numeric), 1)`,
            avgCount: sql<number>`round(avg(${hourlyCrew.crewCount}::numeric), 1)`,
          })
          .from(hourlyCrew)
          .where(and(
            gte(hourlyCrew.date, params.startDate),
            lte(hourlyCrew.date, params.endDate),
            ...(params.restaurantFilter ? [eq(hourlyCrew.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(hourlyCrew.restaurantId)
          .orderBy(desc(sql`avg(${hourlyCrew.experienceScore}::numeric)`));

        const formatted = rows.map((r, i) => ({
          rank: i + 1,
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          expScore: r.avgScore ? Number(r.avgScore).toFixed(1) : "-",
          avgTenure: r.avgTenure ? `${Number(r.avgTenure).toFixed(1)} mo` : "-",
          avgCrew: r.avgCount ? Number(r.avgCount).toFixed(1) : "-",
        }));

        return {
          title: "Crew Experience",
          summary: `Average crew experience score and tenure by unit.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "expScore", label: "Exp Score", align: "right" },
            { key: "avgTenure", label: "Avg Tenure", align: "right" },
            { key: "avgCrew", label: "Avg Crew", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Most Experienced", value: formatted[0].unit, detail: `Score: ${formatted[0].expScore}` } : undefined,
        };
      },
    },
    // ---- CHECK AVERAGE ----
    {
      id: "check_average",
      keywords: ["check average", "avg check", "average ticket", "ticket size", "order size", "average order", "check avg"],
      description: "Average check/ticket size",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const rows = await posDb.select({
          storeNumber: posOrders.storeNumber,
          avgCheck: sql<number>`round(avg(${posOrders.orderTotal}::numeric), 2)`,
          orders: sql<number>`count(*)::int`,
          totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
        }).from(posOrders).where(and(
          gte(posOrders.businessDate, startTs),
          lte(posOrders.businessDate, endTs)
        )).groupBy(posOrders.storeNumber).orderBy(desc(sql`avg(${posOrders.orderTotal}::numeric)`));

        const formatted = rows.map((r, i) => ({
          rank: i + 1,
          unit: params.restaurantMap.get(storeMap.get(r.storeNumber) || r.storeNumber) || r.storeNumber,
          avgCheck: `$${Number(r.avgCheck).toFixed(2)}`,
          orders: r.orders.toLocaleString(),
          totalSales: `$${Math.round(Number(r.totalSales)).toLocaleString()}`,
        }));

        return {
          title: "Check Average by Unit",
          summary: `Average order value ranked by unit.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "unit", label: "Unit", align: "left" },
            { key: "avgCheck", label: "Avg Check", align: "right" },
            { key: "orders", label: "Orders", align: "right" },
            { key: "totalSales", label: "Total Sales", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Highest Avg Check", value: formatted[0].unit, detail: formatted[0].avgCheck } : undefined,
        };
      },
    },
    // ---- YEAR OVER YEAR ----
    {
      id: "yoy_comparison",
      keywords: ["year over year", "yoy", "vs last year", "compared to last year", "year ago", "same period last year"],
      description: "Year-over-year sales comparison",
      execute: async (params) => {
        const rows = await db
          .select({
            restaurantId: historicalDailySales.restaurantId,
            totalSales: sql<number>`sum(${historicalDailySales.netSales}::numeric)`,
            totalGuests: sql<number>`sum(${historicalDailySales.guestCount})::int`,
            days: sql<number>`count(*)::int`,
          })
          .from(historicalDailySales)
          .where(and(
            gte(historicalDailySales.date, params.startDate),
            lte(historicalDailySales.date, params.endDate),
          ))
          .groupBy(historicalDailySales.restaurantId)
          .orderBy(desc(sql`sum(${historicalDailySales.netSales}::numeric)`));

        const formatted = rows.map((r) => ({
          unit: params.restaurantMap.get(r.restaurantId) || r.restaurantId,
          historicalSales: `$${Math.round(Number(r.totalSales)).toLocaleString()}`,
          guests: (r.totalGuests || 0).toLocaleString(),
          days: r.days,
        }));

        return {
          title: "Historical Sales (YoY Data)",
          summary: `Historical sales data available for comparison.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "historicalSales", label: "Net Sales", align: "right" },
            { key: "guests", label: "Guests", align: "right" },
            { key: "days", label: "Days", align: "center" },
          ],
          rows: formatted,
        };
      },
    },
    // ---- SALES BY HOUR ----
    {
      id: "sales_by_hour",
      keywords: ["hourly", "by hour", "sales by hour", "peak hour", "busiest hour", "hour breakdown", "hourly breakdown"],
      description: "Sales breakdown by hour",
      execute: async (params) => {
        const rows = await db
          .select({
            hour: hourlySales.hour,
            totalSales: sql<number>`sum(${hourlySales.actualSales}::numeric)`,
            avgSales: sql<number>`round(avg(${hourlySales.actualSales}::numeric), 0)`,
            cnt: sql<number>`count(*)::int`,
          })
          .from(hourlySales)
          .where(and(
            gte(hourlySales.salesDate, new Date(params.startDate + "T00:00:00Z")),
            lte(hourlySales.salesDate, new Date(params.endDate + "T23:59:59Z")),
            ...(params.restaurantFilter ? [eq(hourlySales.restaurantId, params.restaurantFilter)] : [])
          ))
          .groupBy(hourlySales.hour)
          .orderBy(asc(hourlySales.hour));

        const formatted = rows.map((r) => ({
          hour: r.hour < 12 ? (r.hour === 0 ? "12 AM" : `${r.hour} AM`) : (r.hour === 12 ? "12 PM" : `${r.hour - 12} PM`),
          totalSales: `$${Math.round(Number(r.totalSales)).toLocaleString()}`,
          avgSales: `$${Math.round(Number(r.avgSales)).toLocaleString()}`,
          dataPoints: r.cnt,
        }));

        const peakRow = rows.reduce((best, r) => (Number(r.avgSales) > Number(best.avgSales) ? r : best), rows[0]);
        const peakHour = peakRow ? (peakRow.hour < 12 ? (peakRow.hour === 0 ? "12 AM" : `${peakRow.hour} AM`) : (peakRow.hour === 12 ? "12 PM" : `${peakRow.hour - 12} PM`)) : "-";

        return {
          title: "Sales by Hour",
          summary: `Average sales per hour across all units.`,
          columns: [
            { key: "hour", label: "Hour", align: "left" },
            { key: "totalSales", label: "Total Sales", align: "right" },
            { key: "avgSales", label: "Avg Sales", align: "right" },
            { key: "dataPoints", label: "Data Points", align: "right" },
          ],
          rows: formatted,
          highlight: peakRow ? { label: "Peak Hour", value: peakHour, detail: `$${Math.round(Number(peakRow.avgSales)).toLocaleString()} avg` } : undefined,
        };
      },
    },
    // ---- PRODUCT / ITEM LEVEL ----
    {
      id: "top_sellers",
      keywords: ["top seller", "top selling", "best seller", "popular item", "product", "menu item", "most ordered", "top product", "top item"],
      description: "Top selling products/items from POS data",
      execute: async (params) => {
        const storeMap = await getStoreMapping();
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        // Parse item names from rawJson across all orders in the period
        const orders = await posDb
          .select({ storeNumber: posOrders.storeNumber, rawJson: posOrders.rawJson })
          .from(posOrders)
          .where(and(
            gte(posOrders.businessDate, startTs),
            lte(posOrders.businessDate, endTs),
            sql`${posOrders.rawJson} IS NOT NULL`,
            ...(params.restaurantFilter ? [
              sql`${posOrders.storeNumber} IN (SELECT xenial_store_number FROM location_mapping WHERE restaurant_id = ${params.restaurantFilter})`
            ] : [])
          ));

        const itemCounts = new Map<string, { count: number; category: string }>();
        for (const order of orders) {
          if (!order.rawJson) continue;
          try {
            const payload = JSON.parse(order.rawJson);
            const rawItems = payload?.data?.items;
            if (!Array.isArray(rawItems)) continue;
            for (const item of rawItems) {
              if (item.item_type === "modifier") continue;
              const name = (item.name || "").trim().toUpperCase();
              if (!name || name.length < 3) continue;
              const category = item.reporting_category?.major_reporting_category?.name || "Other";
              if (isExcludedCategory(category)) continue;
              const existing = itemCounts.get(name) || { count: 0, category };
              existing.count++;
              itemCounts.set(name, existing);
            }
          } catch { /* skip bad json */ }
        }

        const sorted = Array.from(itemCounts.entries())
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 30);

        const totalOrders = orders.length;
        const formatted = sorted.map(([ name, data ], i) => ({
          rank: i + 1,
          item: name,
          category: data.category,
          count: data.count.toLocaleString(),
          pctOfOrders: totalOrders > 0 ? `${Math.round((data.count / totalOrders) * 100)}%` : "-",
        }));

        return {
          title: "Top Selling Items",
          summary: `Most frequently ordered items across ${totalOrders.toLocaleString()} orders.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "item", label: "Item", align: "left" },
            { key: "category", label: "Category", align: "left" },
            { key: "count", label: "Times Sold", align: "right" },
            { key: "pctOfOrders", label: "% of Orders", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Top Seller", value: formatted[0].item, detail: `${formatted[0].count} sold` } : undefined,
        };
      },
    },
    {
      id: "product_mix_change",
      keywords: ["mix change", "product change", "item change", "grew", "growth", "trending", "product trend", "item trend", "product mix", "product growth"],
      description: "Product mix % change week over week",
      execute: async (params) => {
        const endTs = new Date(params.endDate + "T23:59:59Z");
        const midTs = new Date(endTs);
        midTs.setDate(midTs.getDate() - 6);
        const startTs = new Date(midTs);
        startTs.setDate(startTs.getDate() - 7);

        async function getItemCounts(from: Date, to: Date) {
          const orders = await posDb.select({ rawJson: posOrders.rawJson }).from(posOrders)
            .where(and(gte(posOrders.businessDate, from), lte(posOrders.businessDate, to), sql`${posOrders.rawJson} IS NOT NULL`));
          const counts = new Map<string, number>();
          let total = 0;
          for (const order of orders) {
            if (!order.rawJson) continue;
            total++;
            try {
              const payload = JSON.parse(order.rawJson);
              const rawItems = payload?.data?.items;
              if (!Array.isArray(rawItems)) continue;
              const seen = new Set<string>();
              for (const item of rawItems) {
                if (item.item_type === "modifier") continue;
                const cat = item.reporting_category?.major_reporting_category?.name || "Other";
                if (isExcludedCategory(cat)) continue;
                const name = (item.name || "").trim().toUpperCase();
                if (!name || name.length < 3 || seen.has(name)) continue;
                seen.add(name);
                counts.set(name, (counts.get(name) || 0) + 1);
              }
            } catch { /* skip */ }
          }
          return { counts, total };
        }

        const [thisWeek, lastWeek] = await Promise.all([
          getItemCounts(midTs, endTs),
          getItemCounts(startTs, midTs),
        ]);

        // Calculate mix % change for items that exist in both weeks
        const changes: { item: string; thisWeekPct: number; lastWeekPct: number; change: number; thisWeekCount: number }[] = [];
        for (const [name, count] of thisWeek.counts) {
          const lastCount = lastWeek.counts.get(name) || 0;
          if (lastCount < 3 && count < 3) continue; // Skip rare items
          const thisPct = thisWeek.total > 0 ? (count / thisWeek.total) * 100 : 0;
          const lastPct = lastWeek.total > 0 ? (lastCount / lastWeek.total) * 100 : 0;
          changes.push({ item: name, thisWeekPct: thisPct, lastWeekPct: lastPct, change: thisPct - lastPct, thisWeekCount: count });
        }

        // Sort by biggest positive change first
        changes.sort((a, b) => b.change - a.change);

        const formatted = changes.slice(0, 25).map((c, i) => ({
          rank: i + 1,
          item: c.item,
          thisWeek: `${c.thisWeekPct.toFixed(1)}%`,
          lastWeek: `${c.lastWeekPct.toFixed(1)}%`,
          change: `${c.change > 0 ? "+" : ""}${c.change.toFixed(1)} pp`,
          count: c.thisWeekCount.toLocaleString(),
        }));

        return {
          title: "Product Mix Change (Week over Week)",
          summary: `Items with the biggest change in order mix % from last week to this week. ${thisWeek.total.toLocaleString()} orders this week vs ${lastWeek.total.toLocaleString()} last week.`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "item", label: "Item", align: "left" },
            { key: "thisWeek", label: "This Week", align: "right" },
            { key: "lastWeek", label: "Last Week", align: "right" },
            { key: "change", label: "Change", align: "right" },
            { key: "count", label: "Sold", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Biggest Gainer", value: formatted[0].item, detail: formatted[0].change } : undefined,
        };
      },
    },
    {
      id: "attachment_rates",
      keywords: ["attachment", "upsell", "cheese", "bacon", "dessert", "shake", "sauce", "whatasize", "add-on", "addon", "modifier"],
      description: "Attachment/upsell rates (cheese, bacon, desserts, etc.)",
      execute: async (params) => {
        // Use the last day of the range for the attachment analysis
        const targetDate = new Date(params.endDate + "T12:00:00Z");
        const rateData = await getAttachmentRatesFromDetail(targetDate);

        const formatted: any[] = [];
        rateData.forEach((data, rid) => {
          const name = params.restaurantMap.get(rid) || data.restaurantName || rid;
          const cats = data.categories;
          formatted.push({
            unit: name,
            cheese: cats.cheese ? `${cats.cheese.attachRate}%` : "-",
            bacon: cats.bacon ? `${cats.bacon.attachRate}%` : "-",
            desserts: cats.desserts ? `${cats.desserts.attachRate}%` : "-",
            sauces: cats.dipping_sauces ? `${cats.dipping_sauces.attachRate}%` : "-",
            whatasize: cats.whatasize ? `${cats.whatasize.attachRate}%` : "-",
            score: data.overallAttachScore,
            orders: data.totalOrders.toLocaleString(),
          });
        });

        formatted.sort((a, b) => b.score - a.score);

        return {
          title: "Attachment / Upsell Rates",
          summary: `Percentage of orders containing each add-on category (latest day data). Higher is better.`,
          columns: [
            { key: "unit", label: "Unit", align: "left" },
            { key: "cheese", label: "Cheese", align: "center" },
            { key: "bacon", label: "Bacon", align: "center" },
            { key: "desserts", label: "Desserts", align: "center" },
            { key: "sauces", label: "Sauces", align: "center" },
            { key: "whatasize", label: "Whatasize", align: "center" },
            { key: "score", label: "Score", align: "right" },
            { key: "orders", label: "Orders", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Best Upsell Score", value: formatted[0].unit, detail: `${formatted[0].score}/100` } : undefined,
        };
      },
    },
    {
      id: "product_category_sales",
      keywords: ["category", "entree", "side", "drink", "beverage", "breakfast", "product category", "menu category", "category breakdown"],
      description: "Sales by product category (entrees, sides, drinks, etc.)",
      execute: async (params) => {
        const startTs = new Date(params.startDate + "T00:00:00Z");
        const endTs = new Date(params.endDate + "T23:59:59Z");

        const orders = await posDb
          .select({ rawJson: posOrders.rawJson })
          .from(posOrders)
          .where(and(
            gte(posOrders.businessDate, startTs),
            lte(posOrders.businessDate, endTs),
            sql`${posOrders.rawJson} IS NOT NULL`
          ));

        const categoryCounts = new Map<string, number>();
        let totalItems = 0;

        for (const order of orders) {
          if (!order.rawJson) continue;
          try {
            const payload = JSON.parse(order.rawJson);
            const rawItems = payload?.data?.items;
            if (!Array.isArray(rawItems)) continue;
            for (const item of rawItems) {
              if (item.item_type === "modifier") continue;
              const cat = item.reporting_category?.major_reporting_category?.name || "Other";
              if (isExcludedCategory(cat)) continue;
              categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
              totalItems++;
            }
          } catch { /* skip */ }
        }

        const sorted = Array.from(categoryCounts.entries())
          .sort((a, b) => b[1] - a[1]);

        const formatted = sorted.map(([cat, count], i) => ({
          rank: i + 1,
          category: cat,
          count: count.toLocaleString(),
          pct: totalItems > 0 ? `${Math.round((count / totalItems) * 100)}%` : "-",
        }));

        return {
          title: "Product Category Breakdown",
          summary: `Item counts by major reporting category across ${orders.length.toLocaleString()} orders (${totalItems.toLocaleString()} total items).`,
          columns: [
            { key: "rank", label: "#", align: "center" },
            { key: "category", label: "Category", align: "left" },
            { key: "count", label: "Items Sold", align: "right" },
            { key: "pct", label: "% of Items", align: "right" },
          ],
          rows: formatted,
          highlight: formatted[0] ? { label: "Top Category", value: formatted[0].category, detail: formatted[0].pct } : undefined,
        };
      },
    },
  ];
}

// List available query types for the frontend
router.get("/api/ai-analysis/templates", (_req, res) => {
  const templates = buildTemplates();
  res.json(
    templates.map((t) => ({
      id: t.id,
      description: t.description,
      keywords: t.keywords.slice(0, 5),
    }))
  );
});

// Execute a dynamic query based on a natural language question
router.post("/api/ai-analysis/query", async (req, res) => {
  try {
    const { question, days = 7 } = req.body;
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Question is required" });
    }

    const numDays = Math.min(parseInt(days) || 7, 90);

    // Calculate date ranges
    const endDate = new Date();
    const endDateStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numDays + 1);
    const startDateStr = startDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    const prevEndDate = new Date(startDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
    const prevEndDateStr = prevEndDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const prevStartDate = new Date(prevEndDate);
    prevStartDate.setDate(prevStartDate.getDate() - numDays + 1);
    const prevStartDateStr = prevStartDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Get restaurant map
    const restaurantList = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const restaurantMap = new Map(restaurantList.map((r) => [r.id, r.name]));

    // Match question to templates
    const templates = buildTemplates();
    const scored = templates
      .map((t) => ({ template: t, score: scoreMatch(question, t) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return res.json({
        matched: false,
        question,
        suggestion: "Try asking about: sales, OSAT, labor, drive-thru speed, dine-in %, app orders, Full Lane B, Google reviews, crew experience, check average, weather, or hourly breakdown.",
        availableTopics: templates.map((t) => t.description),
      });
    }

    const bestMatch = scored[0].template;
    const threshold = extractThreshold(question);
    const restaurantFilter = extractRestaurantFilter(question, restaurantMap);

    const result = await bestMatch.execute({
      startDate: startDateStr,
      endDate: endDateStr,
      prevStartDate: prevStartDateStr,
      prevEndDate: prevEndDateStr,
      restaurantMap,
      threshold,
      restaurantFilter,
    });

    res.json({
      matched: true,
      question,
      templateId: bestMatch.id,
      dateRange: { start: startDateStr, end: endDateStr, days: numDays },
      result,
    });
  } catch (error) {
    console.error("Error in dynamic query:", error);
    res.status(500).json({ error: "Query failed. Please try rephrasing your question." });
  }
});

export default router;
