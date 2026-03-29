import { Router } from "express";
import { db, posDb } from "../db";
import {
  restaurants, dailyOsat, posOrders, locationMapping,
  hmeTimerData, dailyGoogleReviews, hourlyLabor, hourlySales, markets, restaurantMarkets,
  historicalDailySales,
} from "@shared/schema";
import { sql, and, gte, lte, eq, desc } from "drizzle-orm";
import { getAttachmentRatesFromDetail } from "../xenial-webhook";
import { getStaffingBreakdown } from "../lib/labor-model";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pctChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10; // one decimal
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function destChannelExpr() {
  return sql`CASE
    WHEN LOWER(${posOrders.orderSource}) IN ('app', 'mobile', 'online', 'web') THEN 'app'
    WHEN LOWER(${posOrders.orderSource}) LIKE '%3pd%'
      OR LOWER(${posOrders.orderSource}) IN ('doordash', 'ubereats', 'grubhub')
      OR LOWER(${posOrders.orderSource}) LIKE '%door dash%'
      OR LOWER(${posOrders.orderSource}) LIKE '%uber eat%'
      OR LOWER(${posOrders.orderSource}) LIKE '%grub%'
      THEN '3pd'
    WHEN LOWER(${posOrders.orderSource}) LIKE '%delivery%' THEN '3pd'
    WHEN LOWER(${posOrders.orderSource}) IN ('in', 'dine-in', 'kiosk', 'cat', 'pho') OR LOWER(${posOrders.orderSource}) LIKE '%dine%' THEN 'dine_in'
    WHEN LOWER(${posOrders.orderSource}) IN ('dt3', 'out') THEN 'dt3_outside'
    WHEN LOWER(${posOrders.orderSource}) IN ('dt1', 'dt2', 'drive-thru', 'drive_thru') THEN 'drive_thru'
    WHEN LOWER(${posOrders.orderSource}) = 'pos' THEN 'drive_thru'
    ELSE COALESCE(LOWER(${posOrders.orderSource}), 'unknown')
  END`;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

router.get("/api/executive-summary", async (req, res) => {
  try {
    const { days = "7", date } = req.query;
    const numDays = Math.min(parseInt(days as string) || 7, 90);

    // Date range computation — anchored in America/Chicago
    // Default end date is YESTERDAY so we compare complete days only
    let endDate: Date;
    if (date) {
      endDate = new Date(date as string + "T12:00:00Z");
    } else {
      endDate = new Date();
      const todayStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      endDate = new Date(todayStr + "T12:00:00Z");
      endDate.setDate(endDate.getDate() - 1);
    }
    const endDateStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numDays + 1);
    const startDateStr = startDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Previous period
    const prevEndDate = new Date(startDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
    const prevEndDateStr = prevEndDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const prevStartDate = new Date(prevEndDate);
    prevStartDate.setDate(prevStartDate.getDate() - numDays + 1);
    const prevStartDateStr = prevStartDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Timestamps for timestamp-based columns (dailySales.salesDate, posOrders.businessDate)
    const startTs = new Date(startDateStr + "T00:00:00Z");
    const endTs = new Date(endDateStr + "T23:59:59Z");
    const prevStartTs = new Date(prevStartDateStr + "T00:00:00Z");
    const prevEndTs = new Date(prevEndDateStr + "T23:59:59Z");

    // YoY date range — same day-of-week from prior year
    const yoyEndDate = new Date(endDate);
    yoyEndDate.setFullYear(yoyEndDate.getFullYear() - 1);
    const yoyEndDateStr = yoyEndDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const yoyStartDate = new Date(startDate);
    yoyStartDate.setFullYear(yoyStartDate.getFullYear() - 1);
    const yoyStartDateStr = yoyStartDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // ------------------------------------------------------------------
    // Run all queries in parallel
    // ------------------------------------------------------------------
    const [
      restaurantList,
      salesCurrent,
      salesPrevious,
      _salesDailyUnused,
      osatCurrent,
      osatPrevious,
      osatDaily,
      googleCurrent,
      googlePrevious,
      hmeCurrent,
      hmePrevious,
      posCurrent,
      posPrevious,
      channelCurrent,
      channelPrevious,
      laborRows,
      hourlySalesRows,
      marketRows,
      restaurantMarketRows,
      locationMappingRows,
      attachmentRates,
      yoySalesRows,
      posDailyRows,
    ] = await Promise.all([
      // Restaurants
      db.select().from(restaurants).where(eq(restaurants.isActive, true)),

      // Sales — current period (from POS orders)
      posDb.select({
        storeNumber: posOrders.storeNumber,
        total: sql<string>`SUM(${posOrders.orderTotal})`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.orderClosedAt, sql`${startDateStr}::date::timestamptz`),
                   lte(posOrders.orderClosedAt, sql`(${endDateStr}::date + interval '1 day')::timestamptz`)))
        .groupBy(posOrders.storeNumber),

      // Sales — previous period (from POS orders)
      posDb.select({
        storeNumber: posOrders.storeNumber,
        total: sql<string>`SUM(${posOrders.orderTotal})`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.orderClosedAt, sql`${prevStartDateStr}::date::timestamptz`),
                   lte(posOrders.orderClosedAt, sql`(${prevEndDateStr}::date + interval '1 day')::timestamptz`)))
        .groupBy(posOrders.storeNumber),

      // Sales — daily breakdown (for anomaly detection) — placeholder, replaced by posDailyRows
      Promise.resolve([] as { restaurantId: string; date: string; total: string }[]),

      // OSAT — current period (response-weighted: five_star / total_responses)
      db.select({
        restaurantId: dailyOsat.restaurantId,
        avgOsat: sql<string>`CASE WHEN SUM(${dailyOsat.totalResponses}) > 0 THEN ROUND(SUM(${dailyOsat.fiveStarCount})::numeric / SUM(${dailyOsat.totalResponses})::numeric * 100, 2) ELSE 0 END`,
        totalResponses: sql<string>`SUM(${dailyOsat.totalResponses})`,
        totalFiveStars: sql<string>`SUM(${dailyOsat.fiveStarCount})`,
      })
        .from(dailyOsat)
        .where(and(gte(dailyOsat.date, startDateStr), lte(dailyOsat.date, endDateStr)))
        .groupBy(dailyOsat.restaurantId),

      // OSAT — previous period (response-weighted: five_star / total_responses)
      db.select({
        restaurantId: dailyOsat.restaurantId,
        avgOsat: sql<string>`CASE WHEN SUM(${dailyOsat.totalResponses}) > 0 THEN ROUND(SUM(${dailyOsat.fiveStarCount})::numeric / SUM(${dailyOsat.totalResponses})::numeric * 100, 2) ELSE 0 END`,
        totalResponses: sql<string>`SUM(${dailyOsat.totalResponses})`,
        totalFiveStars: sql<string>`SUM(${dailyOsat.fiveStarCount})`,
      })
        .from(dailyOsat)
        .where(and(gte(dailyOsat.date, prevStartDateStr), lte(dailyOsat.date, prevEndDateStr)))
        .groupBy(dailyOsat.restaurantId),

      // OSAT — daily breakdown (for anomaly detection)
      db.select({
        restaurantId: dailyOsat.restaurantId,
        date: dailyOsat.date,
        osatPercent: dailyOsat.osatPercent,
      })
        .from(dailyOsat)
        .where(and(gte(dailyOsat.date, startDateStr), lte(dailyOsat.date, endDateStr))),

      // Google Reviews — current period
      db.select({
        restaurantId: dailyGoogleReviews.restaurantId,
        avgRating: sql<string>`AVG(${dailyGoogleReviews.rating})`,
        totalReviews: sql<string>`SUM(${dailyGoogleReviews.reviewCount})`,
      })
        .from(dailyGoogleReviews)
        .where(and(gte(dailyGoogleReviews.date, startDateStr), lte(dailyGoogleReviews.date, endDateStr)))
        .groupBy(dailyGoogleReviews.restaurantId),

      // Google Reviews — previous period
      db.select({
        restaurantId: dailyGoogleReviews.restaurantId,
        avgRating: sql<string>`AVG(${dailyGoogleReviews.rating})`,
        totalReviews: sql<string>`SUM(${dailyGoogleReviews.reviewCount})`,
      })
        .from(dailyGoogleReviews)
        .where(and(gte(dailyGoogleReviews.date, prevStartDateStr), lte(dailyGoogleReviews.date, prevEndDateStr)))
        .groupBy(dailyGoogleReviews.restaurantId),

      // HME Speed — current period (compute speedAttainment from carsUnder6Min / carCount)
      db.select({
        restaurantId: hmeTimerData.restaurantId,
        totalCars: sql<string>`SUM(${hmeTimerData.carCount})`,
        totalUnder6: sql<string>`SUM(${hmeTimerData.carsUnder6Min})`,
        avgTotalTime: sql<string>`AVG(${hmeTimerData.avgTotalTime})`,
      })
        .from(hmeTimerData)
        .where(and(gte(hmeTimerData.date, startDateStr), lte(hmeTimerData.date, endDateStr)))
        .groupBy(hmeTimerData.restaurantId),

      // HME Speed — previous period
      db.select({
        restaurantId: hmeTimerData.restaurantId,
        totalCars: sql<string>`SUM(${hmeTimerData.carCount})`,
        totalUnder6: sql<string>`SUM(${hmeTimerData.carsUnder6Min})`,
        avgTotalTime: sql<string>`AVG(${hmeTimerData.avgTotalTime})`,
      })
        .from(hmeTimerData)
        .where(and(gte(hmeTimerData.date, prevStartDateStr), lte(hmeTimerData.date, prevEndDateStr)))
        .groupBy(hmeTimerData.restaurantId),

      // POS Transactions & Check Avg — current period
      posDb.select({
        storeNumber: posOrders.storeNumber,
        orderCount: sql<string>`COUNT(*)`,
        totalRevenue: sql<string>`SUM(${posOrders.orderTotal})`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.businessDate, startTs), lte(posOrders.businessDate, endTs)))
        .groupBy(posOrders.storeNumber),

      // POS Transactions & Check Avg — previous period
      posDb.select({
        storeNumber: posOrders.storeNumber,
        orderCount: sql<string>`COUNT(*)`,
        totalRevenue: sql<string>`SUM(${posOrders.orderTotal})`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.businessDate, prevStartTs), lte(posOrders.businessDate, prevEndTs)))
        .groupBy(posOrders.storeNumber),

      // Channel Mix — current period
      posDb.select({
        storeNumber: posOrders.storeNumber,
        channel: sql<string>`${destChannelExpr()}`,
        orderCount: sql<string>`COUNT(*)`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.businessDate, startTs), lte(posOrders.businessDate, endTs)))
        .groupBy(posOrders.storeNumber, destChannelExpr()),

      // Channel Mix — previous period
      posDb.select({
        storeNumber: posOrders.storeNumber,
        channel: sql<string>`${destChannelExpr()}`,
        orderCount: sql<string>`COUNT(*)`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.businessDate, prevStartTs), lte(posOrders.businessDate, prevEndTs)))
        .groupBy(posOrders.storeNumber, destChannelExpr()),

      // Hourly Labor — current period (with hour for labor model)
      db.select({
        restaurantId: hourlyLabor.restaurantId,
        hour: hourlyLabor.hour,
        employeeCount: hourlyLabor.employeeCount,
      })
        .from(hourlyLabor)
        .where(and(gte(hourlyLabor.date, startDateStr), lte(hourlyLabor.date, endDateStr))),

      // Hourly Sales — current period (for labor model target calculation)
      db.select({
        restaurantId: hourlySales.restaurantId,
        hour: hourlySales.hour,
        actualSales: hourlySales.actualSales,
      })
        .from(hourlySales)
        .where(and(gte(hourlySales.salesDate, startTs), lte(hourlySales.salesDate, endTs))),

      // Markets
      db.select().from(markets),

      // Restaurant-Market assignments
      db.select().from(restaurantMarkets),

      // Location mapping (xenial store → restaurantId)
      db.select().from(locationMapping),

      // Attachment rates (wrapped in try/catch)
      (async () => {
        try {
          return await getAttachmentRatesFromDetail(endDate);
        } catch {
          return null;
        }
      })(),

      // YoY historical sales — same date range from prior year
      db.select({
        restaurantId: historicalDailySales.restaurantId,
        total: sql<string>`SUM(${historicalDailySales.netSales})`,
      })
        .from(historicalDailySales)
        .where(and(gte(historicalDailySales.date, yoyStartDateStr), lte(historicalDailySales.date, yoyEndDateStr)))
        .groupBy(historicalDailySales.restaurantId),

      // POS daily breakdown (for anomaly detection — more reliable than 7shifts daily_sales)
      posDb.select({
        storeNumber: posOrders.storeNumber,
        date: sql<string>`(${posOrders.orderClosedAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date::text`,
        total: sql<string>`SUM(${posOrders.orderTotal})`,
      })
        .from(posOrders)
        .where(and(gte(posOrders.orderClosedAt, sql`${startDateStr}::date::timestamptz`), 
                   lte(posOrders.orderClosedAt, sql`(${endDateStr}::date + interval '1 day')::timestamptz`)))
        .groupBy(posOrders.storeNumber, sql`(${posOrders.orderClosedAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date`),
    ]);

    // ------------------------------------------------------------------
    // Build lookup maps
    // ------------------------------------------------------------------
    const restaurantMap = new Map(restaurantList.map((r) => [r.id, r]));
    const storeToRestaurant = new Map<string, string>();
    for (const lm of locationMappingRows) {
      storeToRestaurant.set(lm.xenialStoreNumber, lm.restaurantId);
    }

    // Market assignments: restaurantId → { marketId, marketName }
    const marketMap = new Map(marketRows.map((m) => [m.id, m.name]));
    const restaurantToMarket = new Map<string, { marketId: string; marketName: string }>();
    for (const rm of restaurantMarketRows) {
      const mName = marketMap.get(rm.marketId);
      if (mName) {
        restaurantToMarket.set(rm.restaurantId, { marketId: rm.marketId, marketName: mName });
      }
    }

    // YoY sales lookup: restaurantId → last year total (in dollars, already stored in dollars)
    const yoyByRest: Record<string, number> = {};
    for (const r of yoySalesRows) {
      yoyByRest[r.restaurantId] = parseFloat(r.total) || 0;
    }

    // ------------------------------------------------------------------
    // Index query results by restaurantId
    // ------------------------------------------------------------------
    type MetricPair = { current: number; previous: number };

    const salesByRestPos: Record<string, MetricPair> = {};
    for (const r of salesCurrent) {
      const restId = storeToRestaurant.get(r.storeNumber);
      if (!restId) continue;
      salesByRestPos[restId] = { current: (salesByRestPos[restId]?.current || 0) + (parseFloat(r.total) || 0), previous: salesByRestPos[restId]?.previous || 0 };
    }
    for (const r of salesPrevious) {
      const restId = storeToRestaurant.get(r.storeNumber);
      if (!restId) continue;
      if (!salesByRestPos[restId]) salesByRestPos[restId] = { current: 0, previous: 0 };
      salesByRestPos[restId].previous += parseFloat(r.total) || 0;
    }

    const osatByRest: Record<string, MetricPair & { responses: number; prevResponses: number; fiveStars: number; prevFiveStars: number }> = {};
    for (const r of osatCurrent) {
      osatByRest[r.restaurantId] = {
        current: parseFloat(r.avgOsat) || 0,
        previous: 0,
        responses: parseInt(r.totalResponses) || 0,
        prevResponses: 0,
        fiveStars: parseInt(r.totalFiveStars) || 0,
        prevFiveStars: 0,
      };
    }
    for (const r of osatPrevious) {
      if (!osatByRest[r.restaurantId]) osatByRest[r.restaurantId] = { current: 0, previous: 0, responses: 0, prevResponses: 0, fiveStars: 0, prevFiveStars: 0 };
      osatByRest[r.restaurantId].previous = parseFloat(r.avgOsat) || 0;
      osatByRest[r.restaurantId].prevResponses = parseInt(r.totalResponses) || 0;
      osatByRest[r.restaurantId].prevFiveStars = parseInt(r.totalFiveStars) || 0;
    }

    const googleByRest: Record<string, MetricPair> = {};
    for (const r of googleCurrent) googleByRest[r.restaurantId] = { current: parseFloat(r.avgRating) || 0, previous: 0 };
    for (const r of googlePrevious) {
      if (!googleByRest[r.restaurantId]) googleByRest[r.restaurantId] = { current: 0, previous: 0 };
      googleByRest[r.restaurantId].previous = parseFloat(r.avgRating) || 0;
    }

    // Speed attainment = (carsUnder6Min / carCount) * 100
    const speedByRest: Record<string, MetricPair> = {};
    for (const r of hmeCurrent) {
      const cars = parseInt(r.totalCars) || 0;
      const under6 = parseInt(r.totalUnder6) || 0;
      speedByRest[r.restaurantId] = { current: cars > 0 ? round1((under6 / cars) * 100) : 0, previous: 0 };
    }
    for (const r of hmePrevious) {
      const cars = parseInt(r.totalCars) || 0;
      const under6 = parseInt(r.totalUnder6) || 0;
      if (!speedByRest[r.restaurantId]) speedByRest[r.restaurantId] = { current: 0, previous: 0 };
      speedByRest[r.restaurantId].previous = cars > 0 ? round1((under6 / cars) * 100) : 0;
    }

    // POS transactions & check average — map store numbers to restaurantIds
    const txByRest: Record<string, MetricPair> = {};
    const revenueByRest: Record<string, MetricPair> = {};
    for (const r of posCurrent) {
      const restId = storeToRestaurant.get(r.storeNumber);
      if (!restId) continue;
      const count = parseInt(r.orderCount) || 0;
      const rev = parseFloat(r.totalRevenue) || 0;
      txByRest[restId] = { current: (txByRest[restId]?.current || 0) + count, previous: txByRest[restId]?.previous || 0 };
      revenueByRest[restId] = { current: (revenueByRest[restId]?.current || 0) + rev, previous: revenueByRest[restId]?.previous || 0 };
    }
    for (const r of posPrevious) {
      const restId = storeToRestaurant.get(r.storeNumber);
      if (!restId) continue;
      const count = parseInt(r.orderCount) || 0;
      const rev = parseFloat(r.totalRevenue) || 0;
      if (!txByRest[restId]) txByRest[restId] = { current: 0, previous: 0 };
      if (!revenueByRest[restId]) revenueByRest[restId] = { current: 0, previous: 0 };
      txByRest[restId].previous += count;
      revenueByRest[restId].previous += rev;
    }

    const salesByRest: Record<string, MetricPair> = {};
    for (const rest of restaurantList) {
      const pos = revenueByRest[rest.id];
      const posDirect = salesByRestPos[rest.id];
      const current = pos?.current || posDirect?.current || 0;
      const previous = pos?.previous || posDirect?.previous || 0;
      if (current > 0 || previous > 0) {
        salesByRest[rest.id] = { current, previous };
      }
    }

    // Channel mix — map store numbers → restaurantId, compute % of total
    type ChannelMixPct = { drive_thru: number; dine_in: number; app: number; delivery_3pd: number };
    function buildChannelMix(rows: typeof channelCurrent): Record<string, ChannelMixPct> {
      const byRest: Record<string, Record<string, number>> = {};
      for (const r of rows) {
        const restId = storeToRestaurant.get(r.storeNumber);
        if (!restId) continue;
        if (!byRest[restId]) byRest[restId] = {};
        byRest[restId][r.channel] = (byRest[restId][r.channel] || 0) + (parseInt(r.orderCount) || 0);
      }
      const result: Record<string, ChannelMixPct> = {};
      for (const [restId, channels] of Object.entries(byRest)) {
        const total = Object.values(channels).reduce((a, b) => a + b, 0);
        if (total === 0) {
          result[restId] = { drive_thru: 0, dine_in: 0, app: 0, delivery_3pd: 0 };
          continue;
        }
        const driveThru = ((channels["drive_thru"] || 0) + (channels["dt3_outside"] || 0)) / total * 100;
        const dineIn = (channels["dine_in"] || 0) / total * 100;
        const app = (channels["app"] || 0) / total * 100;
        const delivery3pd = ((channels["3pd"] || 0) + (channels["delivery"] || 0)) / total * 100;
        result[restId] = {
          drive_thru: round1(driveThru),
          dine_in: round1(dineIn),
          app: round1(app),
          delivery_3pd: round1(delivery3pd),
        };
      }
      return result;
    }

    const channelMixCurrent = buildChannelMix(channelCurrent);
    const channelMixPrevious = buildChannelMix(channelPrevious);

    // Labor hours vs model hours
    const laborByRest: Record<string, { actualHours: number; modelHours: number }> = {};
    for (const row of laborRows) {
      const ec = parseFloat(row.employeeCount as string) || 0;
      if (ec <= 0) continue;
      if (!laborByRest[row.restaurantId]) laborByRest[row.restaurantId] = { actualHours: 0, modelHours: 0 };
      laborByRest[row.restaurantId].actualHours += ec;
    }
    for (const row of hourlySalesRows) {
      const sales = parseFloat(row.actualSales as string) || 0;
      if (sales <= 0) continue;
      const model = getStaffingBreakdown(row.hour, sales);
      if (!laborByRest[row.restaurantId]) laborByRest[row.restaurantId] = { actualHours: 0, modelHours: 0 };
      laborByRest[row.restaurantId].modelHours += model.total;
    }
    for (const restId of Object.keys(laborByRest)) {
      laborByRest[restId].actualHours = round1(laborByRest[restId].actualHours);
      laborByRest[restId].modelHours = round1(laborByRest[restId].modelHours);
    }

    // Attachment rates
    const attachByRest: Record<string, {
      score: number;
      categories: Record<string, { rate: number; benchmark: number; vsTarget: number }>;
    }> = {};
    if (attachmentRates) {
      for (const [restId, data] of attachmentRates.entries()) {
        const cats: Record<string, { rate: number; benchmark: number; vsTarget: number }> = {};
        if (data.categories) {
          for (const [catName, catData] of Object.entries(data.categories)) {
            cats[catName] = {
              rate: round1(catData.attachRate),
              benchmark: round1(catData.benchmark),
              vsTarget: round1(catData.vsTarget),
            };
          }
        }
        attachByRest[restId] = {
          score: round1(data.overallAttachScore),
          categories: cats,
        };
      }
    }

    // ------------------------------------------------------------------
    // Build per-restaurant response
    // ------------------------------------------------------------------
    type RestaurantResult = {
      id: string;
      name: string;
      marketId: string | null;
      marketName: string | null;
      sales: { current: number; previous: number; pctChange: number };
      transactions: { current: number; previous: number; pctChange: number };
      checkAverage: { current: number; previous: number; pctChange: number };
      osat: { current: number; previous: number; pctChange: number; responses: number };
      googleRating: { current: number; previous: number; pctChange: number };
      speedAttainment: { current: number; previous: number; pctChange: number };
      labor: { actualHours: number; modelHours: number; variance: number; variancePct: number };
      channelMix: ChannelMixPct;
      prevChannelMix: ChannelMixPct;
      attachmentScore: number | null;
      attachmentCategories: Record<string, { rate: number; benchmark: number; vsTarget: number }> | null;
      yoySales: { lastYear: number; pctChange: number } | null;
    };

    const restaurantResults: RestaurantResult[] = [];
    const defaultChannel: ChannelMixPct = { drive_thru: 0, dine_in: 0, app: 0, delivery_3pd: 0 };

    for (const rest of restaurantList) {
      const mkt = restaurantToMarket.get(rest.id);
      const s = salesByRest[rest.id] || { current: 0, previous: 0 };
      const o = osatByRest[rest.id] || { current: 0, previous: 0, responses: 0 };
      const g = googleByRest[rest.id] || { current: 0, previous: 0 };
      const sp = speedByRest[rest.id] || { current: 0, previous: 0 };
      const tx = txByRest[rest.id] || { current: 0, previous: 0 };
      const rev = revenueByRest[rest.id] || { current: 0, previous: 0 };
      const checkCurrent = tx.current > 0 ? round1(rev.current / tx.current) : 0;
      const checkPrevious = tx.previous > 0 ? round1(rev.previous / tx.previous) : 0;
      const lb = laborByRest[rest.id] || { actualHours: 0, modelHours: 0 };
      const laborVariance = round1(lb.actualHours - lb.modelHours);
      const laborVariancePct = lb.modelHours > 0 ? round1(((lb.actualHours - lb.modelHours) / lb.modelHours) * 100) : 0;

      const attach = attachByRest[rest.id];

      const yoyLastYear = yoyByRest[rest.id];
      const currentSalesDollars = round1(s.current);
      const yoySalesData = yoyLastYear && yoyLastYear > 0
        ? { lastYear: round1(yoyLastYear), pctChange: pctChange(currentSalesDollars, yoyLastYear) }
        : null;

      restaurantResults.push({
        id: rest.id,
        name: rest.name,
        marketId: mkt?.marketId ?? null,
        marketName: mkt?.marketName ?? null,
        sales: { current: currentSalesDollars, previous: round1(s.previous), pctChange: pctChange(s.current, s.previous) },
        transactions: { current: tx.current, previous: tx.previous, pctChange: pctChange(tx.current, tx.previous) },
        checkAverage: { current: checkCurrent, previous: checkPrevious, pctChange: pctChange(checkCurrent, checkPrevious) },
        osat: { current: round1(o.current), previous: round1(o.previous), pctChange: pctChange(o.current, o.previous), responses: o.responses },
        googleRating: { current: round1(g.current), previous: round1(g.previous), pctChange: pctChange(g.current, g.previous) },
        speedAttainment: { current: sp.current, previous: sp.previous, pctChange: pctChange(sp.current, sp.previous) },
        labor: { actualHours: lb.actualHours, modelHours: lb.modelHours, variance: laborVariance, variancePct: laborVariancePct },
        channelMix: channelMixCurrent[rest.id] || { ...defaultChannel },
        prevChannelMix: channelMixPrevious[rest.id] || { ...defaultChannel },
        attachmentScore: attach?.score ?? null,
        attachmentCategories: attach?.categories ?? null,
        yoySales: yoySalesData,
      });
    }

    // ------------------------------------------------------------------
    // Company pulse — aggregate all restaurants
    // ------------------------------------------------------------------
    function sumMetric(getter: (r: RestaurantResult) => { current: number; previous: number }) {
      let cur = 0, prev = 0;
      for (const r of restaurantResults) { cur += getter(r).current; prev += getter(r).previous; }
      return { current: round1(cur), previous: round1(prev), pctChange: pctChange(cur, prev) };
    }
    function avgMetric(getter: (r: RestaurantResult) => { current: number; previous: number }) {
      let curSum = 0, prevSum = 0, curN = 0, prevN = 0;
      for (const r of restaurantResults) {
        const m = getter(r);
        if (m.current > 0) { curSum += m.current; curN++; }
        if (m.previous > 0) { prevSum += m.previous; prevN++; }
      }
      const cur = curN > 0 ? round1(curSum / curN) : 0;
      const prev = prevN > 0 ? round1(prevSum / prevN) : 0;
      return { current: cur, previous: prev, pctChange: pctChange(cur, prev) };
    }

    const companySales = sumMetric((r) => r.sales);
    const companyTx = sumMetric((r) => r.transactions);
    const companyCheckCur = companyTx.current > 0 ? round1(companySales.current / companyTx.current) : 0;
    const companyCheckPrev = companyTx.previous > 0 ? round1(companySales.previous / companyTx.previous) : 0;

    // Response-weighted OSAT for company
    let coOsatCurFS = 0, coOsatCurR = 0, coOsatPrevFS = 0, coOsatPrevR = 0;
    for (const r of restaurantResults) {
      const o = osatByRest[r.id];
      if (o) {
        coOsatCurFS += o.fiveStars; coOsatCurR += o.responses;
        coOsatPrevFS += o.prevFiveStars; coOsatPrevR += o.prevResponses;
      }
    }
    const coOsatCur = coOsatCurR > 0 ? round1(coOsatCurFS / coOsatCurR * 100) : 0;
    const coOsatPrev = coOsatPrevR > 0 ? round1(coOsatPrevFS / coOsatPrevR * 100) : 0;

    const companyPulse = {
      sales: companySales,
      transactions: companyTx,
      checkAverage: { current: companyCheckCur, previous: companyCheckPrev, pctChange: pctChange(companyCheckCur, companyCheckPrev) },
      osat: { current: coOsatCur, previous: coOsatPrev, pctChange: pctChange(coOsatCur, coOsatPrev) },
      googleRating: avgMetric((r) => r.googleRating),
      speedAttainment: avgMetric((r) => r.speedAttainment),
    };

    // ------------------------------------------------------------------
    // Alerts & outperformers
    // ------------------------------------------------------------------
    type AlertEntry = {
      restaurantId: string;
      restaurant: string;
      metric: string;
      metricLabel: string;
      current: number;
      previous: number;
      pctChange: number;
      severity: "high" | "medium" | "low";
    };
    type OutperformerEntry = Omit<AlertEntry, "severity">;

    const alerts: AlertEntry[] = [];
    const outperformers: OutperformerEntry[] = [];

    for (const r of restaurantResults) {
      // OSAT
      const osatDelta = r.osat.current - r.osat.previous;
      if (r.osat.previous > 0 && osatDelta < -5) {
        alerts.push({ restaurantId: r.id, restaurant: r.name, metric: "osat", metricLabel: "OSAT", current: r.osat.current, previous: r.osat.previous, pctChange: r.osat.pctChange, severity: "high" });
      } else if (r.osat.previous > 0 && osatDelta > 5) {
        outperformers.push({ restaurantId: r.id, restaurant: r.name, metric: "osat", metricLabel: "OSAT", current: r.osat.current, previous: r.osat.previous, pctChange: r.osat.pctChange });
      }

      // Google rating
      const googleDelta = r.googleRating.current - r.googleRating.previous;
      if (r.googleRating.previous > 0 && googleDelta < -0.2) {
        alerts.push({ restaurantId: r.id, restaurant: r.name, metric: "googleRating", metricLabel: "Google Rating", current: r.googleRating.current, previous: r.googleRating.previous, pctChange: r.googleRating.pctChange, severity: "high" });
      } else if (r.googleRating.previous > 0 && googleDelta > 0.2) {
        outperformers.push({ restaurantId: r.id, restaurant: r.name, metric: "googleRating", metricLabel: "Google Rating", current: r.googleRating.current, previous: r.googleRating.previous, pctChange: r.googleRating.pctChange });
      }

      // Sales
      if (r.sales.previous > 0 && r.sales.pctChange < -10) {
        alerts.push({ restaurantId: r.id, restaurant: r.name, metric: "sales", metricLabel: "Sales", current: r.sales.current, previous: r.sales.previous, pctChange: r.sales.pctChange, severity: "high" });
      } else if (r.sales.previous > 0 && r.sales.pctChange > 10) {
        outperformers.push({ restaurantId: r.id, restaurant: r.name, metric: "sales", metricLabel: "Sales", current: r.sales.current, previous: r.sales.previous, pctChange: r.sales.pctChange });
      }

      // Speed attainment
      const speedDelta = r.speedAttainment.current - r.speedAttainment.previous;
      if (r.speedAttainment.previous > 0 && speedDelta < -10) {
        alerts.push({ restaurantId: r.id, restaurant: r.name, metric: "speedAttainment", metricLabel: "Speed Attainment", current: r.speedAttainment.current, previous: r.speedAttainment.previous, pctChange: r.speedAttainment.pctChange, severity: "medium" });
      } else if (r.speedAttainment.previous > 0 && speedDelta > 10) {
        outperformers.push({ restaurantId: r.id, restaurant: r.name, metric: "speedAttainment", metricLabel: "Speed Attainment", current: r.speedAttainment.current, previous: r.speedAttainment.previous, pctChange: r.speedAttainment.pctChange });
      }

      // Check average
      const checkDelta = r.checkAverage.current - r.checkAverage.previous;
      if (r.checkAverage.previous > 0 && checkDelta < -0.5) {
        alerts.push({ restaurantId: r.id, restaurant: r.name, metric: "checkAverage", metricLabel: "Check Average", current: r.checkAverage.current, previous: r.checkAverage.previous, pctChange: r.checkAverage.pctChange, severity: "medium" });
      } else if (r.checkAverage.previous > 0 && checkDelta > 0.5) {
        outperformers.push({ restaurantId: r.id, restaurant: r.name, metric: "checkAverage", metricLabel: "Check Average", current: r.checkAverage.current, previous: r.checkAverage.previous, pctChange: r.checkAverage.pctChange });
      }

      // Labor overstaffing alert (>20% over model)
      if (r.labor.modelHours > 0 && r.labor.variancePct > 20) {
        alerts.push({ restaurantId: r.id, restaurant: r.name, metric: "laborVariance", metricLabel: "Labor vs Model", current: r.labor.actualHours, previous: r.labor.modelHours, pctChange: r.labor.variancePct, severity: r.labor.variancePct > 40 ? "high" : "medium" });
      }
    }

    // Sort alerts by severity (high first), then by pctChange magnitude
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || Math.abs(b.pctChange) - Math.abs(a.pctChange));

    // ------------------------------------------------------------------
    // Anomaly detection (sales & OSAT daily)
    // ------------------------------------------------------------------
    type AnomalyEntry = {
      restaurantId: string;
      restaurant: string;
      date: string;
      metric: string;
      metricLabel: string;
      value: number;
      avgValue: number;
      direction: "spike" | "drop";
      deviationPct: number;
    };

    const anomalies: AnomalyEntry[] = [];

    // Group daily sales by restaurant — prefer POS data, fall back to 7shifts
    const posDailyByRest: Record<string, Record<string, number>> = {};
    for (const row of posDailyRows) {
      const restId = storeToRestaurant.get(row.storeNumber);
      if (!restId) continue;
      if (!posDailyByRest[restId]) posDailyByRest[restId] = {};
      posDailyByRest[restId][row.date] = (posDailyByRest[restId][row.date] || 0) + (parseFloat(row.total) || 0);
    }

    const dailySalesByRest: Record<string, { date: string; value: number }[]> = {};
    for (const [restId, posDays] of Object.entries(posDailyByRest)) {
      dailySalesByRest[restId] = Object.entries(posDays).map(([date, value]) => ({ date, value }));
    }

    for (const [restId, days] of Object.entries(dailySalesByRest)) {
      if (days.length < 3) continue; // need enough data points
      const values = days.map((d) => d.value);
      const avg = mean(values);
      const sd = stddev(values);
      if (sd === 0 || avg === 0) continue;
      for (const day of days) {
        const deviation = Math.abs(day.value - avg);
        if (deviation > 2 * sd) {
          const restName = restaurantMap.get(restId)?.name || restId;
          anomalies.push({
            restaurantId: restId,
            restaurant: restName,
            date: day.date,
            metric: "sales",
            metricLabel: "Daily Sales",
            value: round1(day.value),
            avgValue: round1(avg),
            direction: day.value > avg ? "spike" : "drop",
            deviationPct: round1(((day.value - avg) / avg) * 100),
          });
        }
      }
    }

    // Group daily OSAT by restaurant
    const dailyOsatByRest: Record<string, { date: string; value: number }[]> = {};
    for (const row of osatDaily) {
      const restId = row.restaurantId;
      const val = parseFloat(row.osatPercent as string) || 0;
      if (val <= 0) continue;
      if (!dailyOsatByRest[restId]) dailyOsatByRest[restId] = [];
      dailyOsatByRest[restId].push({ date: row.date, value: val });
    }

    for (const [restId, days] of Object.entries(dailyOsatByRest)) {
      if (days.length < 3) continue;
      const values = days.map((d) => d.value);
      const avg = mean(values);
      const sd = stddev(values);
      if (sd === 0 || avg === 0) continue;
      for (const day of days) {
        const deviation = Math.abs(day.value - avg);
        if (deviation > 2 * sd) {
          const restName = restaurantMap.get(restId)?.name || restId;
          anomalies.push({
            restaurantId: restId,
            restaurant: restName,
            date: day.date,
            metric: "osat",
            metricLabel: "Daily OSAT",
            value: round1(day.value),
            avgValue: round1(avg),
            direction: day.value > avg ? "spike" : "drop",
            deviationPct: round1(((day.value - avg) / avg) * 100),
          });
        }
      }
    }

    // Sort anomalies by absolute deviation descending
    anomalies.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));

    // ------------------------------------------------------------------
    // Market rollups
    // ------------------------------------------------------------------
    type MarketRollup = {
      marketId: string;
      marketName: string;
      restaurantCount: number;
      sales: { current: number; previous: number; pctChange: number };
      transactions: { current: number; previous: number; pctChange: number };
      checkAverage: { current: number; previous: number; pctChange: number };
      osat: { current: number; previous: number; pctChange: number };
      googleRating: { current: number; previous: number; pctChange: number };
      speedAttainment: { current: number; previous: number; pctChange: number };
    };

    const marketRestaurants: Record<string, RestaurantResult[]> = {};
    for (const r of restaurantResults) {
      if (r.marketId) {
        if (!marketRestaurants[r.marketId]) marketRestaurants[r.marketId] = [];
        marketRestaurants[r.marketId].push(r);
      }
    }

    const marketRollups: MarketRollup[] = [];
    for (const [mktId, rests] of Object.entries(marketRestaurants)) {
      const mktName = marketMap.get(mktId) || mktId;
      const count = rests.length;

      // Sum for sales and transactions, average for rates/percentages
      const mktSalesCur = rests.reduce((s, r) => s + r.sales.current, 0);
      const mktSalesPrev = rests.reduce((s, r) => s + r.sales.previous, 0);
      const mktTxCur = rests.reduce((s, r) => s + r.transactions.current, 0);
      const mktTxPrev = rests.reduce((s, r) => s + r.transactions.previous, 0);
      const mktCheckCur = mktTxCur > 0 ? round1(mktSalesCur / mktTxCur) : 0;
      const mktCheckPrev = mktTxPrev > 0 ? round1(mktSalesPrev / mktTxPrev) : 0;

      function mktAvg(getter: (r: RestaurantResult) => { current: number; previous: number }) {
        let curS = 0, prevS = 0, curN = 0, prevN = 0;
        for (const r of rests) {
          const m = getter(r);
          if (m.current > 0) { curS += m.current; curN++; }
          if (m.previous > 0) { prevS += m.previous; prevN++; }
        }
        const c = curN > 0 ? round1(curS / curN) : 0;
        const p = prevN > 0 ? round1(prevS / prevN) : 0;
        return { current: c, previous: p, pctChange: pctChange(c, p) };
      }

      // Response-weighted OSAT for market: sum five-stars / sum responses
      let mktOsatCurFiveStars = 0, mktOsatCurResponses = 0;
      let mktOsatPrevFiveStars = 0, mktOsatPrevResponses = 0;
      for (const r of rests) {
        const o = osatByRest[r.id];
        if (o) {
          mktOsatCurFiveStars += o.fiveStars;
          mktOsatCurResponses += o.responses;
          mktOsatPrevFiveStars += o.prevFiveStars;
          mktOsatPrevResponses += o.prevResponses;
        }
      }
      const mktOsatCur = mktOsatCurResponses > 0 ? round1(mktOsatCurFiveStars / mktOsatCurResponses * 100) : 0;
      const mktOsatPrev = mktOsatPrevResponses > 0 ? round1(mktOsatPrevFiveStars / mktOsatPrevResponses * 100) : 0;

      marketRollups.push({
        marketId: mktId,
        marketName: mktName,
        restaurantCount: count,
        sales: { current: round1(mktSalesCur), previous: round1(mktSalesPrev), pctChange: pctChange(mktSalesCur, mktSalesPrev) },
        transactions: { current: mktTxCur, previous: mktTxPrev, pctChange: pctChange(mktTxCur, mktTxPrev) },
        checkAverage: { current: mktCheckCur, previous: mktCheckPrev, pctChange: pctChange(mktCheckCur, mktCheckPrev) },
        osat: { current: mktOsatCur, previous: mktOsatPrev, pctChange: pctChange(mktOsatCur, mktOsatPrev) },
        googleRating: mktAvg((r) => r.googleRating),
        speedAttainment: mktAvg((r) => r.speedAttainment),
      });
    }

    // ------------------------------------------------------------------
    // Send response
    // ------------------------------------------------------------------
    res.json({
      dateRange: { start: startDateStr, end: endDateStr, days: numDays },
      previousPeriod: { start: prevStartDateStr, end: prevEndDateStr },
      companyPulse,
      restaurants: restaurantResults,
      alerts,
      outperformers,
      anomalies,
      marketRollups,
    });
  } catch (error) {
    console.error("Error in executive summary:", error);
    res.status(500).json({ error: "Failed to generate executive summary" });
  }
});

export default router;
