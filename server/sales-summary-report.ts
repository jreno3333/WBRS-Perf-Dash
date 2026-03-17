import { getBaseUrl } from "./base-url";
import { db } from "./db";
import { emailSubscribers, emailSendLog, reportSchedules, restaurants, historicalDailySales, hourlySales, dailyWeather } from "@shared/schema";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import type { HourlySalesData, RestaurantSales } from "@shared/schema";
import { computeHourlyScore, scoreToGradeLabel, getGradeColorHex, formatCurrency, computeDailyBonuses, countAttachmentCategoriesAtTarget, BONUS_DEFINITIONS } from "./lib/scoring";
import { getTotalRequiredStaff } from "./labor-model";
import { getAttachmentRatesFromDetail, getAllHourlyPosSalesRange, getAllHourlyPosOrderCountRange } from "./xenial-webhook";
import type { GradingConfigData } from "@shared/schema";
import { getActiveGradingConfig } from "./routes/grading-config";
import { getHolidayContext, getHolidayComparisonContext } from "./holidays";

// Tennessee store names - must match client/src/components/state-breakdown.tsx
const TENNESSEE_STORES = [
  "1680 - Powell",
  "1681 - Turkey Creek",
  "1682 - Cumberland Avenue",
  "1679 - East Ridge",
  "1605 - Shallowford Village",
  "1729 - Sevierville",
];

function isTennesseeStore(restaurantName: string): boolean {
  return TENNESSEE_STORES.some(name => restaurantName.includes(name.split(" - ")[1]));
}

/** Comp = open > 18 months. Non-comp = open <= 18 months or no openDate. */
function isCompStore(openDate: string | Date | null | undefined): boolean {
  if (!openDate) return true; // assume comp if no date
  const open = new Date(openDate);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 18);
  return open <= cutoff;
}

function getStoreAgeLabel(openDate: string | Date | null | undefined): string {
  if (!openDate) return "";
  const open = new Date(openDate);
  if (isNaN(open.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - open.getTime();
  if (diffMs < 0) return "Pre-Open";
  const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const months = Math.floor(totalDays / 30);
  if (months < 1) return `${totalDays}d`;
  if (months < 24) return `${months}mo`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return remainingMonths > 0 ? `${years}y${remainingMonths}m` : `${years}y`;
}

function getStoreAgeWeeks(openDate: string | Date | null | undefined): number | null {
  if (!openDate) return null;
  const open = new Date(openDate);
  if (isNaN(open.getTime())) return null;
  const now = new Date();
  const diffMs = now.getTime() - open.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7));
}

function getGradeColor(grade: string): string {
  return getGradeColorHex(grade);
}

function weatherIcon(condition: string | null): string {
  if (!condition) return "";
  const c = condition.toLowerCase();
  if (c.includes("snow") || c.includes("blizzard")) return "&#10052;&#65039;"; // snowflake
  if (c.includes("rain") || c.includes("shower") || c.includes("drizzle")) return "&#127783;&#65039;"; // rain
  if (c.includes("thunder") || c.includes("storm")) return "&#9889;"; // lightning
  if (c.includes("fog")) return "&#127787;&#65039;"; // fog
  if (c.includes("cloud") || c.includes("overcast")) return "&#9729;&#65039;"; // cloud
  if (c.includes("clear") || c.includes("sunny")) return "&#9728;&#65039;"; // sun
  return "&#9729;&#65039;"; // default cloud
}

function trendArrow(value: number): string {
  if (value >= 3) return "&#9650;"; // ▲ up
  if (value <= -3) return "&#9660;"; // ▼ down
  return "&#9644;"; // ▬ flat
}

function trendColor(value: number): string {
  if (value >= 3) return "#16a34a";
  if (value <= -3) return "#dc2626";
  return "#71717a";
}

function pctStr(value: number | undefined): string {
  if (value === undefined) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

interface RestaurantDayData {
  restaurantId: string;
  restaurantName: string;
  openDate: string | null;
  state: "AL" | "TN";
  isComp: boolean;
  storeAge: string;
  storeAgeWeeks: number | null;
  status: "training" | "new" | "established";
  // Yesterday's numbers
  sales: number;
  lastWeekSales: number;
  lastYearSales: number | undefined;
  salesVsLW: number; // % variance vs last week
  salesVsLY: number | undefined; // % variance vs last year
  grade: number; // execution score 0-100
  gradeLabel: string;
  avgSpeed: number | null;
  osatPercent: number | null;
  osatResponses: number;
  earnedBadges: string[];
  // Transactions
  transactionCount: number;
  lastWeekTransactionCount: number;
  // Labor
  modelHours: number;
  actualHours: number;
  // Weather
  weatherCondition: string | null;
  weatherHighTemp: number | null;
  // EOW forecast
  eowForecast: number; // projected end-of-week sales (Sat-Fri)
  // Multi-day rolling totals
  prior7Sales: number;
  prior7LWSales: number;
  prior30Sales: number;
  prior30LWSales: number;
  prior90Sales: number;
  prior90LWSales: number;
  // Multi-day rolling transaction totals
  prior7Txn: number;
  prior30Txn: number;
}

/**
 * Fetch daily POS sales aggregated by restaurant for a date range.
 * Returns Map<"restaurantId-YYYY-MM-DD", totalSales>
 */
async function getDailySalesForRange(startDate: string, endDate: string): Promise<Map<string, number>> {
  const hourlySalesMap = await getAllHourlyPosSalesRange(startDate, endDate);
  // Aggregate hourly into daily: key format is "restaurantId-date-hour"
  const dailyMap = new Map<string, number>();
  for (const [key, sales] of hourlySalesMap) {
    const parts = key.split("-");
    // key = "restaurantId-YYYY-MM-DD-hour" but restaurantId may contain dashes (UUID)
    // Format: restaurantId is everything before the date portion
    // Since dates are YYYY-MM-DD (10 chars) and hour is 1-2 chars at end
    const lastDash = key.lastIndexOf("-");
    const hourStr = key.substring(lastDash + 1);
    const restAndDate = key.substring(0, lastDash);
    const dateDash = restAndDate.lastIndexOf("-");
    const monthDash = restAndDate.lastIndexOf("-", dateDash - 1);
    const yearDash = restAndDate.lastIndexOf("-", monthDash - 1);
    const dateStr = restAndDate.substring(yearDash + 1);
    const restaurantId = restAndDate.substring(0, yearDash);

    const dailyKey = `${restaurantId}-${dateStr}`;
    dailyMap.set(dailyKey, (dailyMap.get(dailyKey) || 0) + sales);
  }
  return dailyMap;
}

/**
 * Fallback: fetch daily sales from hourly_sales (7shifts) for a date range.
 */
async function getDailySalesFromHourlyTable(startDate: string, endDate: string): Promise<Map<string, number>> {
  const startTs = new Date(`${startDate}T00:00:00.000Z`);
  const endTs = new Date(`${endDate}T23:59:59.999Z`);

  const rows = await db.select({
    restaurantId: hourlySales.restaurantId,
    date: sql<string>`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`,
    totalSales: sql<string>`SUM(CAST(${hourlySales.actualSales} AS numeric))`,
  })
    .from(hourlySales)
    .where(and(gte(hourlySales.salesDate, startTs), lte(hourlySales.salesDate, endTs)))
    .groupBy(hourlySales.restaurantId, sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`);

  const dailyMap = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.restaurantId}-${row.date}`;
    dailyMap.set(key, parseFloat(row.totalSales || "0"));
  }
  return dailyMap;
}

/**
 * Fetch daily POS transaction (order) counts aggregated by restaurant for a date range.
 * Returns Map<"restaurantId-YYYY-MM-DD", orderCount>
 */
async function getDailyTransactionsForRange(startDate: string, endDate: string): Promise<Map<string, number>> {
  const hourlyOrderMap = await getAllHourlyPosOrderCountRange(startDate, endDate);
  const dailyMap = new Map<string, number>();
  for (const [key, orders] of hourlyOrderMap) {
    const lastDash = key.lastIndexOf("-");
    const restAndDate = key.substring(0, lastDash);
    const dateDash = restAndDate.lastIndexOf("-");
    const monthDash = restAndDate.lastIndexOf("-", dateDash - 1);
    const yearDash = restAndDate.lastIndexOf("-", monthDash - 1);
    const dateStr = restAndDate.substring(yearDash + 1);
    const restaurantId = restAndDate.substring(0, yearDash);

    const dailyKey = `${restaurantId}-${dateStr}`;
    dailyMap.set(dailyKey, (dailyMap.get(dailyKey) || 0) + orders);
  }
  return dailyMap;
}

/**
 * Build multi-day rolling sales totals per restaurant.
 * Returns Map<restaurantId, { prior7, prior7LW, prior30, prior30LW, prior90, prior90LW }>
 */
async function getRollingSalesData(
  yesterdayStr: string,
  restaurantIds: string[]
): Promise<Map<string, { prior7: number; prior7LW: number; prior30: number; prior30LW: number; prior90: number; prior90LW: number }>> {

  const yesterday = new Date(`${yesterdayStr}T12:00:00`);

  // Date ranges
  const prior7Start = new Date(yesterday);
  prior7Start.setDate(prior7Start.getDate() - 6);
  const prior30Start = new Date(yesterday);
  prior30Start.setDate(prior30Start.getDate() - 29);
  const prior90Start = new Date(yesterday);
  prior90Start.setDate(prior90Start.getDate() - 89);

  // Last week equivalents (shift back 7 days from each range)
  const prior7LWStart = new Date(prior7Start);
  prior7LWStart.setDate(prior7LWStart.getDate() - 7);
  const prior7LWEnd = new Date(yesterday);
  prior7LWEnd.setDate(prior7LWEnd.getDate() - 7);

  const prior30LWStart = new Date(prior30Start);
  prior30LWStart.setDate(prior30LWStart.getDate() - 7);
  const prior30LWEnd = new Date(yesterday);
  prior30LWEnd.setDate(prior30LWEnd.getDate() - 7);

  const prior90LWStart = new Date(prior90Start);
  prior90LWStart.setDate(prior90LWStart.getDate() - 7);
  const prior90LWEnd = new Date(yesterday);
  prior90LWEnd.setDate(prior90LWEnd.getDate() - 7);

  const fmt = (d: Date) => d.toISOString().split("T")[0];

  // Fetch all POS data in one big range covering the widest window
  const widestStart = fmt(prior90LWStart);
  const widestEnd = yesterdayStr;

  let dailyMap: Map<string, number>;
  try {
    dailyMap = await getDailySalesForRange(widestStart, widestEnd);
  } catch {
    dailyMap = new Map();
  }

  // Fallback to hourly_sales table if POS data is sparse
  let fallbackMap: Map<string, number> | null = null;

  const result = new Map<string, { prior7: number; prior7LW: number; prior30: number; prior30LW: number; prior90: number; prior90LW: number }>();

  for (const rid of restaurantIds) {
    let prior7 = 0, prior7LW = 0, prior30 = 0, prior30LW = 0, prior90 = 0, prior90LW = 0;

    // Sum sales for each range
    const sumRange = (start: Date, end: Date, map: Map<string, number>): number => {
      let total = 0;
      const d = new Date(start);
      while (d <= end) {
        const key = `${rid}-${fmt(d)}`;
        total += map.get(key) || 0;
        d.setDate(d.getDate() + 1);
      }
      return total;
    };

    prior7 = sumRange(prior7Start, yesterday, dailyMap);
    prior30 = sumRange(prior30Start, yesterday, dailyMap);
    prior90 = sumRange(prior90Start, yesterday, dailyMap);
    prior7LW = sumRange(prior7LWStart, prior7LWEnd, dailyMap);
    prior30LW = sumRange(prior30LWStart, prior30LWEnd, dailyMap);
    prior90LW = sumRange(prior90LWStart, prior90LWEnd, dailyMap);

    // If POS data seems missing for this restaurant, try fallback
    if (prior7 === 0) {
      if (!fallbackMap) {
        try {
          fallbackMap = await getDailySalesFromHourlyTable(widestStart, widestEnd);
        } catch {
          fallbackMap = new Map();
        }
      }
      prior7 = sumRange(prior7Start, yesterday, fallbackMap);
      prior30 = sumRange(prior30Start, yesterday, fallbackMap);
      prior90 = sumRange(prior90Start, yesterday, fallbackMap);
      prior7LW = sumRange(prior7LWStart, prior7LWEnd, fallbackMap);
      prior30LW = sumRange(prior30LWStart, prior30LWEnd, fallbackMap);
      prior90LW = sumRange(prior90LWStart, prior90LWEnd, fallbackMap);
    }

    result.set(rid, { prior7, prior7LW, prior30, prior30LW, prior90, prior90LW });
  }

  return result;
}

export async function sendSalesSummaryReports(force = false): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
    const schedules = await db.select().from(reportSchedules)
      .where(eq(reportSchedules.reportType, "sales_summary"));
    const schedule = schedules[0];

    if (!force) {
      if (schedule && !schedule.isEnabled) {
        console.log("[sales-summary] Automated sending is disabled - skipping");
        return result;
      }
      // Double-check we're past the scheduled time (belt-and-suspenders guard)
      if (schedule) {
        const now = new Date();
        const centralHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(now));
        const centralMinute = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', minute: 'numeric' }).format(now));
        const currentMinutes = centralHour * 60 + centralMinute;
        const targetMinutes = schedule.sendHour * 60 + schedule.sendMinute;
        if (currentMinutes < targetMinutes) {
          console.log(`[sales-summary] Too early to send: CT ${centralHour}:${String(centralMinute).padStart(2, '0')}, scheduled for ${schedule.sendHour}:${String(schedule.sendMinute).padStart(2, '0')} - skipping`);
          return result;
        }
      }
    } else {
      console.log("[sales-summary] Force send requested (Send Now button)");
    }

    const subscribers = await db.select()
      .from(emailSubscribers)
      .where(and(
        eq(emailSubscribers.isActive, true),
        sql`${emailSubscribers.reportTypes} @> ARRAY['sales_summary']`
      ));

    if (subscribers.length === 0) {
      console.log("[sales-summary] No active subscribers for sales_summary");
      return result;
    }

    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = centralFormatter.format(yesterday);

    const reportKey = `sales-summary-${yesterdayStr}`;
    let pendingSubscribers = subscribers;

    if (!force) {
      const alreadySent = await db.select()
        .from(emailSendLog)
        .where(and(eq(emailSendLog.reportDate, reportKey), eq(emailSendLog.status, "sent")));
      const sentEmails = new Set(alreadySent.map(s => s.email));
      pendingSubscribers = subscribers.filter(s => !sentEmails.has(s.email));

      if (pendingSubscribers.length === 0) {
        console.log("[sales-summary] All reports already sent for", yesterdayStr);
        return result;
      }
    }

    const reportHtml = await buildSalesSummaryHtml(yesterdayStr);
    if (!reportHtml) {
      console.log("[sales-summary] No data available for", yesterdayStr);
      return result;
    }

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(yesterday);
    const formattedDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }).format(yesterday);
    const subject = `Executive Sales Summary - ${dayOfWeek}, ${formattedDate}`;

    for (const subscriber of pendingSubscribers) {
      const sent = await sendDailyReportEmail(subscriber.email, subject, reportHtml);
      await db.insert(emailSendLog).values({
        reportDate: reportKey,
        email: subscriber.email,
        status: sent ? "sent" : "failed",
      });
      if (sent) result.sent++;
      else result.failed++;
    }

    console.log(`[sales-summary] Sent ${result.sent} reports, ${result.failed} failed for ${yesterdayStr}`);
  } catch (error) {
    console.error("[sales-summary] Error sending sales summary reports:", error);
  }

  return result;
}

export async function buildSalesSummaryHtml(dateStr: string): Promise<string | null> {
  try {
    const parts = dateStr.split("-");
    const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);

    const gradingCfg = await getActiveGradingConfig();
    const leaderboard = await storage.getLeaderboard(targetDate);
    const hourlyDataByRestaurant = await storage.getHourlyDataByRestaurant(targetDate);

    if (leaderboard.restaurants.length === 0) return null;

    const activeRestaurants = leaderboard.restaurants.filter(r => r.status !== "training");
    if (activeRestaurants.length === 0) return null;

    // Fetch all restaurant records for openDate
    const allRestaurantRecords = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const restaurantMap = new Map(allRestaurantRecords.map(r => [r.id, r]));

    // Fetch attachment rates
    let attachmentByRestaurant: Map<string, { categories: Record<string, { attachRate: number }> }> = new Map();
    try {
      attachmentByRestaurant = await getAttachmentRatesFromDetail(targetDate);
    } catch { /* POS data may not be available */ }

    // Fetch YoY data
    const currentDate = new Date(dateStr);
    const priorYearDate = new Date(currentDate);
    priorYearDate.setFullYear(priorYearDate.getFullYear() - 1);
    const sameDow = priorYearDate.getDay();
    const targetDow = currentDate.getDay();
    const diff = targetDow - sameDow;
    priorYearDate.setDate(priorYearDate.getDate() + diff);
    const priorDateStr = priorYearDate.toISOString().split("T")[0];

    const yoyRows = await db.select().from(historicalDailySales)
      .where(eq(historicalDailySales.date, priorDateStr));
    const yoyMap = new Map(yoyRows.map(r => [r.restaurantId, parseFloat(r.netSales)]));
    const yoyTxnMap = new Map(yoyRows.filter(r => r.guestCount > 0).map(r => [r.restaurantId, r.guestCount]));

    // Fetch weather data for the target date
    const weatherRows = await db.select().from(dailyWeather)
      .where(eq(dailyWeather.date, dateStr));
    const weatherMap = new Map(weatherRows.map(w => [w.restaurantId, w]));

    // Holiday context
    const holidayCtx = getHolidayContext(targetDate);
    const holidayComp = getHolidayComparisonContext(targetDate);

    // Build per-restaurant yesterday data
    const restaurantData: RestaurantDayData[] = [];

    for (const restaurant of activeRestaurants) {
      const sales = restaurant.actualSales;
      const lastWeekSales = restaurant.actualLastWeekSales;
      if (sales === 0 && lastWeekSales === 0) continue;

      const salesVsLW = lastWeekSales > 0 ? ((sales - lastWeekSales) / lastWeekSales) * 100 : 0;
      const lastYearSales = yoyMap.get(restaurant.restaurantId);
      const salesVsLY = lastYearSales && lastYearSales > 0
        ? ((sales - lastYearSales) / lastYearSales) * 100
        : undefined;

      const hourlyData: HourlySalesData[] = hourlyDataByRestaurant[restaurant.restaurantId] || [];
      const completedHours = hourlyData.filter(h => h.hour <= 23 && h.todaySales > 0);

      // Calculate execution grade
      const hourlyGradeScores: number[] = [];
      for (const hour of completedHours) {
        const hasComparableSales = hour.lastWeekSales > 0;
        const salesVariancePct = hasComparableSales
          ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 : 0;

        const positions = hour.positionBreakdown || {};
        const operatorHrs = positions["_operatorScheduled"] || 0;
        const rawEmployeeCount = Number(hour.employeeCount) || 0;
        const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
        const requiredStaff = getTotalRequiredStaff(hour.hour, hour.todaySales);
        const staffingDiff = actualStaff - requiredStaff;
        const hasValidStaffing = rawEmployeeCount >= 1;

        const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
        const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;

        const gradeInfo = computeHourlyScore({
          salesVariancePct,
          hasComparableSales,
          transactionVariancePct: txnVar,
          hasComparableTransactions: hasCompTxn,
          speedAttainment: hour.ootActive ? undefined : hour.speedAttainment,
          osatPercent: hour.osatPercent,
          staffingDiff,
          hasValidStaffing,
        }, gradingCfg);

        if (gradeInfo.hasGrade) hourlyGradeScores.push(gradeInfo.score);
      }

      const validScores = hourlyGradeScores.filter(s => s > 0);
      const baseScore = validScores.length > 0
        ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 0;

      // Compute daily bonuses
      const dailyTotalSales = completedHours.reduce((s, h) => s + h.todaySales, 0);
      const dailyTotalLWSales = completedHours.reduce((s, h) => s + h.lastWeekSales, 0);
      const dailySalesVar = dailyTotalLWSales > 0 ? ((dailyTotalSales - dailyTotalLWSales) / dailyTotalLWSales) * 100 : undefined;
      const dailyTotalTxn = completedHours.reduce((s, h) => s + (h.transactionCount || 0), 0);
      const dailyTotalLWTxn = completedHours.reduce((s, h) => s + (h.lastWeekTransactionCount || 0), 0);
      const dailyTxnVar = dailyTotalLWTxn > 0 ? ((dailyTotalTxn - dailyTotalLWTxn) / dailyTotalLWTxn) * 100 : undefined;
      const osatHoursForBonus = completedHours.filter(h => h.osatPercent !== undefined && (h.osatResponses ?? 0) > 0);
      const dailyOsatResponses = osatHoursForBonus.reduce((s, h) => s + (h.osatResponses ?? 0), 0);
      const dailyOsatPct = dailyOsatResponses > 0
        ? osatHoursForBonus.reduce((s, h) => s + (h.osatPercent ?? 0) * (h.osatResponses ?? 0), 0) / dailyOsatResponses
        : undefined;

      const lastYearDaily = completedHours[0]?.lastYearDailySales;
      const dailyYoySalesVar = lastYearDaily && lastYearDaily > 0
        ? ((dailyTotalSales - lastYearDaily) / lastYearDaily) * 100 : undefined;

      const attachData = attachmentByRestaurant.get(restaurant.restaurantId);
      const attachCatsAtTarget = attachData ? countAttachmentCategoriesAtTarget(attachData.categories) : undefined;

      const bonusResult = baseScore > 0 ? computeDailyBonuses({
        dailyOsatPercent: dailyOsatPct,
        dailySurveyCount: dailyOsatResponses,
        dailySalesVariancePct: dailySalesVar,
        dailyTransactionVariancePct: dailyTxnVar,
        dailyYoySalesVariancePct: dailyYoySalesVar,
        attachmentCategoriesAtTarget: attachCatsAtTarget,
        hourlyScores: validScores,
      }) : { bonuses: [], totalBonus: 0, cappedBonus: 0 };

      const overallScore = baseScore > 0 ? Math.min(baseScore + bonusResult.cappedBonus, 100) : 0;
      const gradeLabel = validScores.length > 0 ? scoreToGradeLabel(overallScore) : "-";

      // Speed
      const speedData = hourlyData.reduce((acc, h) => {
        const sa = h.speedAttainment;
        if (sa !== undefined && sa >= 0) { acc.total += sa; acc.count++; }
        return acc;
      }, { total: 0, count: 0 });

      // OSAT
      const osatData = hourlyData.reduce((acc, h) => {
        const op = h.osatPercent;
        const or2 = h.osatResponses;
        if (op !== undefined && op >= 0 && or2 > 0) { acc.totalWeighted += op * or2; acc.totalResponses += or2; }
        return acc;
      }, { totalWeighted: 0, totalResponses: 0 });

      const restRecord = restaurantMap.get(restaurant.restaurantId);
      const openDate = restRecord?.openDate ?? null;

      // Labor: model hours vs actual hours for the day
      let modelHoursTotal = 0;
      let actualHoursTotal = 0;
      for (const hour of completedHours) {
        modelHoursTotal += getTotalRequiredStaff(hour.hour, hour.todaySales);
        const positions = hour.positionBreakdown || {};
        const operatorHrs = positions["_operatorScheduled"] || 0;
        const rawEmployeeCount = Number(hour.employeeCount) || 0;
        actualHoursTotal += Math.max(0, rawEmployeeCount - operatorHrs);
      }

      // Weather
      const weather = weatherMap.get(restaurant.restaurantId);

      restaurantData.push({
        restaurantId: restaurant.restaurantId,
        restaurantName: restaurant.restaurantName,
        openDate,
        state: isTennesseeStore(restaurant.restaurantName) ? "TN" : "AL",
        isComp: isCompStore(openDate),
        storeAge: getStoreAgeLabel(openDate),
        storeAgeWeeks: getStoreAgeWeeks(openDate),
        status: restaurant.status || "established",
        sales,
        lastWeekSales,
        lastYearSales,
        salesVsLW,
        salesVsLY,
        grade: overallScore,
        gradeLabel,
        avgSpeed: speedData.count > 0 ? Math.round(speedData.total / speedData.count) : null,
        osatPercent: osatData.totalResponses > 0 ? osatData.totalWeighted / osatData.totalResponses : null,
        osatResponses: osatData.totalResponses,
        earnedBadges: bonusResult.bonuses.map(b => b.label),
        transactionCount: dailyTotalTxn,
        lastWeekTransactionCount: dailyTotalLWTxn,
        modelHours: Math.round(modelHoursTotal * 10) / 10,
        actualHours: Math.round(actualHoursTotal * 10) / 10,
        weatherCondition: weather?.condition ?? null,
        weatherHighTemp: weather?.highTemp ? parseFloat(String(weather.highTemp)) : null,
        eowForecast: 0,
        prior7Sales: 0, prior7LWSales: 0,
        prior30Sales: 0, prior30LWSales: 0,
        prior90Sales: 0, prior90LWSales: 0,
        prior7Txn: 0, prior30Txn: 0,
      });
    }

    if (restaurantData.length === 0) return null;

    // Fetch multi-day rolling data
    const restaurantIds = restaurantData.map(r => r.restaurantId);
    const rollingData = await getRollingSalesData(dateStr, restaurantIds);

    for (const r of restaurantData) {
      const rd = rollingData.get(r.restaurantId);
      if (rd) {
        r.prior7Sales = rd.prior7;
        r.prior7LWSales = rd.prior7LW;
        r.prior30Sales = rd.prior30;
        r.prior30LWSales = rd.prior30LW;
        r.prior90Sales = rd.prior90;
        r.prior90LWSales = rd.prior90LW;
      }
    }

    // Fetch rolling transaction data (7D and 30D)
    {
      const yesterday = new Date(`${dateStr}T12:00:00`);
      const fmtD = (d: Date) => d.toISOString().split("T")[0];
      const prior7Start = new Date(yesterday);
      prior7Start.setDate(prior7Start.getDate() - 6);
      const prior30Start = new Date(yesterday);
      prior30Start.setDate(prior30Start.getDate() - 29);

      try {
        const txnDailyMap = await getDailyTransactionsForRange(fmtD(prior30Start), dateStr);
        for (const r of restaurantData) {
          let txn7 = 0, txn30 = 0;
          const d = new Date(prior30Start);
          while (d <= yesterday) {
            const key = `${r.restaurantId}-${fmtD(d)}`;
            const val = txnDailyMap.get(key) || 0;
            txn30 += val;
            if (d >= prior7Start) txn7 += val;
            d.setDate(d.getDate() + 1);
          }
          r.prior7Txn = txn7;
          r.prior30Txn = txn30;
        }
      } catch { /* POS transaction data may not be available */ }
    }

    // ──── EOW Forecast (Sat-Fri business week) ────────────────
    {
      const reportDate = new Date(dateStr + "T12:00:00");
      const dayOfWeek = reportDate.getDay(); // 0=Sun, 6=Sat
      const daysSinceSaturday = (dayOfWeek + 1) % 7; // Sat=0, Sun=1, ..., Fri=6
      const weekSaturday = new Date(reportDate);
      weekSaturday.setDate(reportDate.getDate() - daysSinceSaturday);
      const weekFriday = new Date(weekSaturday);
      weekFriday.setDate(weekSaturday.getDate() + 6);

      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const satStr = fmt(weekSaturday);
      const friStr = fmt(weekFriday);

      // Last week's same window for projection
      const lastWeekSat = new Date(weekSaturday);
      lastWeekSat.setDate(lastWeekSat.getDate() - 7);
      const lastWeekFri = new Date(weekFriday);
      lastWeekFri.setDate(lastWeekFri.getDate() - 7);

      // Fetch this week's actuals and last week's sales
      const [thisWeekMap, lastWeekMap] = await Promise.all([
        getDailySalesForRange(satStr, dateStr),
        getDailySalesForRange(fmt(lastWeekSat), fmt(lastWeekFri)),
      ]);

      for (const r of restaurantData) {
        // Sum WTD actuals (Sat through report date)
        let wtdActual = 0;
        const d = new Date(weekSaturday);
        while (d <= reportDate) {
          wtdActual += thisWeekMap.get(`${r.restaurantId}-${fmt(d)}`) || 0;
          d.setDate(d.getDate() + 1);
        }

        // Project remaining days (day after report date through Fri) using last week
        let projectedRemaining = 0;
        const nextDay = new Date(reportDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const d2 = new Date(nextDay);
        while (d2 <= weekFriday) {
          // Use last week's same day-of-week sales as projection
          const lwSameDay = new Date(d2);
          lwSameDay.setDate(lwSameDay.getDate() - 7);
          projectedRemaining += lastWeekMap.get(`${r.restaurantId}-${fmt(lwSameDay)}`) || 0;
          d2.setDate(d2.getDate() + 1);
        }

        r.eowForecast = wtdActual + projectedRemaining;
      }
    }

    // ──── Aggregations ─────────────────────────────────────────

    const sum = (arr: RestaurantDayData[], fn: (r: RestaurantDayData) => number) =>
      arr.reduce((s, r) => s + fn(r), 0);
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const pctVar = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : undefined;

    // Company totals
    const totalSales = sum(restaurantData, r => r.sales);
    const totalLWSales = sum(restaurantData, r => r.lastWeekSales);
    const totalLYSales = restaurantData.filter(r => r.lastYearSales !== undefined).reduce((s, r) => s + (r.lastYearSales || 0), 0);
    const hasLYData = restaurantData.some(r => r.lastYearSales !== undefined);
    const companyVsLW = pctVar(totalSales, totalLWSales);
    const companyVsLY = hasLYData ? pctVar(totalSales, totalLYSales) : undefined;

    const total7 = sum(restaurantData, r => r.prior7Sales);
    const total7LW = sum(restaurantData, r => r.prior7LWSales);
    const total30 = sum(restaurantData, r => r.prior30Sales);
    const total30LW = sum(restaurantData, r => r.prior30LWSales);
    const total90 = sum(restaurantData, r => r.prior90Sales);
    const total90LW = sum(restaurantData, r => r.prior90LWSales);

    const gradedRestaurants = restaurantData.filter(r => r.grade > 0);
    const companyAvgGrade = avg(gradedRestaurants.map(r => r.grade));
    const companyGradeLabel = gradedRestaurants.length > 0 ? scoreToGradeLabel(companyAvgGrade) : "-";

    const speedValues = restaurantData.filter(r => r.avgSpeed !== null).map(r => r.avgSpeed!);
    const companyAvgSpeed = speedValues.length > 0 ? Math.round(avg(speedValues)) : null;

    const osatWeighted = restaurantData.filter(r => r.osatPercent !== null && r.osatResponses > 0);
    const companyOsat = osatWeighted.length > 0
      ? osatWeighted.reduce((s, r) => s + r.osatPercent! * r.osatResponses, 0) / osatWeighted.reduce((s, r) => s + r.osatResponses, 0)
      : null;
    const companyOsatResponses = restaurantData.reduce((s, r) => s + r.osatResponses, 0);

    // Transactions & Check Average
    const totalTransactions = sum(restaurantData, r => r.transactionCount);
    const totalLWTransactions = sum(restaurantData, r => r.lastWeekTransactionCount);
    const transactionsVsLW = pctVar(totalTransactions, totalLWTransactions);
    const checkAverage = totalTransactions > 0 ? totalSales / totalTransactions : 0;
    const lwCheckAverage = totalLWTransactions > 0 ? totalLWSales / totalLWTransactions : 0;
    const checkAvgVsLW = pctVar(checkAverage, lwCheckAverage);

    // State breakdowns
    const alStores = restaurantData.filter(r => r.state === "AL");
    const tnStores = restaurantData.filter(r => r.state === "TN");

    const stateStats = (stores: RestaurantDayData[]) => {
      const sales = sum(stores, r => r.sales);
      const lw = sum(stores, r => r.lastWeekSales);
      const ly = stores.filter(r => r.lastYearSales !== undefined).reduce((s, r) => s + (r.lastYearSales || 0), 0);
      const hasLY = stores.some(r => r.lastYearSales !== undefined);
      const osats = stores.filter(r => r.osatPercent !== null && r.osatResponses > 0);
      const osatPct = osats.length > 0
        ? osats.reduce((s, r) => s + r.osatPercent! * r.osatResponses, 0) / osats.reduce((s, r) => s + r.osatResponses, 0)
        : null;
      const osatSurveys = stores.reduce((s, r) => s + r.osatResponses, 0);
      const p7 = sum(stores, r => r.prior7Sales);
      const p7lw = sum(stores, r => r.prior7LWSales);
      const p30 = sum(stores, r => r.prior30Sales);
      const p30lw = sum(stores, r => r.prior30LWSales);
      return {
        count: stores.length,
        sales,
        vsLW: pctVar(sales, lw),
        vsLY: hasLY ? pctVar(sales, ly) : undefined,
        osatPct,
        osatSurveys,
        p7Var: pctVar(p7, p7lw),
        p30Var: pctVar(p30, p30lw),
      };
    };

    const alStats = stateStats(alStores);
    const tnStats = stateStats(tnStores);

    // Comp vs Non-Comp
    const compStores = restaurantData.filter(r => r.isComp);
    const nonCompStores = restaurantData.filter(r => !r.isComp);
    const compStats = stateStats(compStores);
    const nonCompStats = stateStats(nonCompStores);

    // Comp YoY rolling: fetch last year's 1D, 7D, and 30D sales for comp stores
    const compStoreIds = new Set(compStores.map(r => r.restaurantId));
    const yesterday = new Date(`${dateStr}T12:00:00`);
    const fmt = (d: Date) => d.toISOString().split("T")[0];

    // Current period: 1D, 7D, and 30D ending on dateStr (comp stores only)
    const compStoresWithLY = compStores.filter(r => r.lastYearSales !== undefined && r.lastYearSales > 0);
    const comp1Sales = compStoresWithLY.reduce((s, r) => s + r.sales, 0);
    const comp1LYSales = compStoresWithLY.reduce((s, r) => s + (r.lastYearSales || 0), 0);
    const comp7Sales = compStores.reduce((s, r) => s + r.prior7Sales, 0);
    const comp30Sales = compStores.reduce((s, r) => s + r.prior30Sales, 0);

    // Current period transactions (comp stores)
    const compStoresWithLYTxn = compStores.filter(r => yoyTxnMap.has(r.restaurantId) && r.transactionCount > 0);
    const comp1Txn = compStoresWithLYTxn.reduce((s, r) => s + r.transactionCount, 0);
    const comp1LYTxn = compStoresWithLYTxn.reduce((s, r) => s + (yoyTxnMap.get(r.restaurantId) || 0), 0);
    const comp7Txn = compStores.reduce((s, r) => s + r.prior7Txn, 0);
    const comp30Txn = compStores.reduce((s, r) => s + r.prior30Txn, 0);

    // 1-Day comp YoY from existing per-store data (same cohort for both current and LY)
    const compYoY1: number | undefined = comp1LYSales > 0 ? pctVar(comp1Sales, comp1LYSales) : undefined;
    const compTxnYoY1: number | undefined = comp1LYTxn > 0 ? pctVar(comp1Txn, comp1LYTxn) : undefined;

    // Last year equivalent date ranges (same DOW aligned)
    const lyYesterday = new Date(yesterday);
    lyYesterday.setFullYear(lyYesterday.getFullYear() - 1);
    const lyDowDiff = yesterday.getDay() - lyYesterday.getDay();
    lyYesterday.setDate(lyYesterday.getDate() + lyDowDiff);

    const ly7Start = new Date(lyYesterday);
    ly7Start.setDate(ly7Start.getDate() - 6);
    const ly30Start = new Date(lyYesterday);
    ly30Start.setDate(ly30Start.getDate() - 29);

    let compYoY7: number | undefined;
    let compYoY30: number | undefined;
    let compTxnYoY7: number | undefined;
    let compTxnYoY30: number | undefined;
    try {
      const lyRows = await db.select().from(historicalDailySales)
        .where(and(
          gte(historicalDailySales.date, fmt(ly30Start)),
          lte(historicalDailySales.date, fmt(lyYesterday))
        ));
      let ly7Total = 0, ly30Total = 0;
      let ly7Txn = 0, ly30Txn = 0;
      const ly7Days = new Set<string>();
      const ly30Days = new Set<string>();
      for (const row of lyRows) {
        if (!compStoreIds.has(row.restaurantId)) continue;
        const rowDate = new Date(`${row.date}T12:00:00`);
        const sales = parseFloat(row.netSales);
        const txn = row.guestCount || 0;
        if (rowDate >= ly7Start) {
          ly7Total += sales;
          ly7Txn += txn;
          ly7Days.add(`${row.restaurantId}-${row.date}`);
        }
        ly30Total += sales;
        ly30Txn += txn;
        ly30Days.add(`${row.restaurantId}-${row.date}`);
      }
      if (ly7Total > 0) compYoY7 = pctVar(comp7Sales, ly7Total);
      if (ly30Total > 0) compYoY30 = pctVar(comp30Sales, ly30Total);
      if (ly7Txn > 0) compTxnYoY7 = pctVar(comp7Txn, ly7Txn);
      if (ly30Txn > 0) compTxnYoY30 = pctVar(comp30Txn, ly30Txn);
    } catch { /* historical data may not be available */ }

    // Sort by daily sales (descending) for top performers and all-units
    const sortedBySales = [...restaurantData].sort((a, b) => b.sales - a.sales);
    const top5 = sortedBySales.slice(0, 5);

    // Units with most badges (bottom3 removed - Needs Attention section removed)
    const badgeLeaders = [...restaurantData]
      .filter(r => r.earnedBadges.length > 0)
      .sort((a, b) => b.earnedBadges.length - a.earnedBadges.length)
      .slice(0, 5);

    // New stores (status === "new")
    const newStores = restaurantData.filter(r => r.status === "new");

    // Trend insight - compare 7-day vs 30-day YoY (adjacent windows, most intuitive)
    let trendInsight = "";
    if (compYoY7 !== undefined && compYoY30 !== undefined) {
      // 7-day better than 30-day means trend is improving (gap closing)
      const gapClosing = compYoY7 > compYoY30;
      if (compYoY7 >= 0 && compYoY30 >= 0) {
        trendInsight = gapClosing
          ? "&#9650; Accelerating &mdash; 7-day YoY is outpacing the 30-day trend. Momentum building."
          : "&#9660; Decelerating &mdash; 7-day YoY is trailing the 30-day trend.";
      } else if (compYoY7 < 0 && compYoY30 < 0) {
        trendInsight = gapClosing
          ? "&#9650; Closing the gap &mdash; 7-day YoY deficit is narrower than the 30-day trend. Recovery underway."
          : "&#9660; Widening the gap &mdash; 7-day YoY deficit is larger than the 30-day trend.";
      } else {
        trendInsight = gapClosing
          ? "&#9650; Improving &mdash; 7-day YoY is stronger than the 30-day trend."
          : "&#9660; Softening &mdash; 7-day YoY is weaker than the 30-day trend.";
      }
    }

    // Formatting
    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const formattedDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const baseUrl = getBaseUrl();

    // ──── HTML ─────────────────────────────────────────────────

    const sectionStyle = `background: white; border: 1px solid #e4e4e7; border-top: none; padding: 16px 12px;`;
    const headerCell = `font-size: 10px; color: #a1a1aa; font-weight: 600;`;
    const dataCell = `font-size: 12px;`;

    const renderStatRow = (label: string, count: number, sales: number, vsLW: number | undefined, _osat: number | null, _osatSurveys: number, p7Var: number | undefined, p30Var: number | undefined, vsLY?: number | undefined) => `
      <tr>
        <td style="padding: 5px 2px; font-size: 11px; font-weight: 600;">${label} <span style="color: #a1a1aa; font-weight: 400;">(${count})</span></td>
        <td style="padding: 5px 2px; font-size: 11px; text-align: right;">${formatCurrency(sales)}</td>
        <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${vsLW !== undefined && vsLW >= 0 ? '#16a34a' : '#dc2626'};">${vsLW !== undefined ? pctStr(vsLW) : '--'}</td>
        ${vsLY !== undefined ? `<td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${vsLY >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(vsLY)}</td>` : ''}
        <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${trendColor(p7Var ?? 0)};">${p7Var !== undefined ? pctStr(p7Var) : '--'}</td>
        <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${trendColor(p30Var ?? 0)};">${p30Var !== undefined ? pctStr(p30Var) : '--'}</td>
      </tr>`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 8px;">

    <!-- ═══ HEADER ═══ -->
    <div style="background: linear-gradient(135deg, #18181b 0%, #27272a 100%); color: white; padding: 24px 16px; border-radius: 8px 8px 0 0; text-align: center;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Executive Sales Summary</h1>
      <p style="margin: 6px 0 0; font-size: 14px; color: #a1a1aa;">${dayOfWeek}, ${formattedDate}</p>
      <p style="margin: 4px 0 0; font-size: 12px; color: #71717a;">MWB Restaurants &middot; ${restaurantData.length} Active Units</p>
    </div>

    ${holidayCtx.todayHoliday || holidayCtx.lastWeekHoliday || holidayComp.thisYear ? `
    <!-- ═══ HOLIDAY NOTE ═══ -->
    <div style="${sectionStyle} background: #fffbeb; border-color: #fbbf24;">
      <div style="font-size: 12px; color: #92400e; font-weight: 600;">
        ${holidayCtx.todayHoliday ? `&#127881; Holiday: ${holidayCtx.todayHoliday.name}` : ''}
        ${holidayCtx.lastWeekHoliday ? `&#9888;&#65039; Note: Last week&rsquo;s comparison day (${holidayCtx.lastWeekHoliday.dayOfWeek}) was ${holidayCtx.lastWeekHoliday.name} &mdash; vs LW figures may not be directly comparable.` : ''}
        ${!holidayCtx.todayHoliday && !holidayCtx.lastWeekHoliday && holidayComp.thisYear ? `&#127881; Holiday: ${holidayComp.thisYear.name}` : ''}
      </div>
      ${holidayComp.lastYear ? `<div style="font-size: 11px; color: #92400e; margin-top: 4px;">Last year&rsquo;s comparable: ${holidayComp.lastYear.name} fell on ${holidayComp.lastYear.dayOfWeek}, ${holidayComp.lastYear.date}</div>` : ''}
    </div>` : ''}

    <!-- ═══ COMPANY HEADLINE KPIs ═══ -->
    <div style="${sectionStyle}">
      <div style="display: flex; justify-content: space-around; text-align: center; flex-wrap: wrap; gap: 8px;">
        <div style="min-width: 90px;">
          <div style="font-size: 28px; font-weight: 700;">${formatCurrency(totalSales)}</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">Sales</div>
        </div>
        <div style="min-width: 70px;">
          <div style="font-size: 28px; font-weight: 700; color: ${(companyVsLW ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${companyVsLW !== undefined ? pctStr(companyVsLW) : '--'}</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">vs Last Week</div>
        </div>
        <div style="min-width: 70px;">
          <div style="font-size: 28px; font-weight: 700;">${totalTransactions.toLocaleString()}</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">Transactions</div>
        </div>
        <div style="min-width: 70px;">
          <div style="font-size: 28px; font-weight: 700;">${formatCurrency(checkAverage)}</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">Check Avg</div>
        </div>
      </div>
    </div>

    <!-- ═══ ROLLING TREND YoY ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">Comp Store Sales YoY <span style="font-size: 11px; color: #71717a; font-weight: 400;">(${compStores.length} of ${restaurantData.length} stores, same day-of-week aligned)</span></h3>
      <div style="display: flex; justify-content: space-around; text-align: center; gap: 8px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">1-DAY YoY</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(compYoY1 ?? 0)};">${compYoY1 !== undefined ? pctStr(compYoY1) : '--'} <span style="font-size: 14px;">${compYoY1 !== undefined ? trendArrow(compYoY1) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${formatCurrency(comp1Sales)}</div>
        </div>
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">7-DAY YoY</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(compYoY7 ?? 0)};">${compYoY7 !== undefined ? pctStr(compYoY7) : '--'} <span style="font-size: 14px;">${compYoY7 !== undefined ? trendArrow(compYoY7) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${formatCurrency(comp7Sales)}</div>
        </div>
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">30-DAY YoY</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(compYoY30 ?? 0)};">${compYoY30 !== undefined ? pctStr(compYoY30) : '--'} <span style="font-size: 14px;">${compYoY30 !== undefined ? trendArrow(compYoY30) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${formatCurrency(comp30Sales)}</div>
        </div>
      </div>
    </div>

    <!-- ═══ COMP STORE TRANSACTIONS YoY ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">Comp Store Transactions YoY <span style="font-size: 11px; color: #71717a; font-weight: 400;">(${compStores.length} of ${restaurantData.length} stores, same day-of-week aligned)</span></h3>
      <div style="display: flex; justify-content: space-around; text-align: center; gap: 8px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">1-DAY YoY</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(compTxnYoY1 ?? 0)};">${compTxnYoY1 !== undefined ? pctStr(compTxnYoY1) : '--'} <span style="font-size: 14px;">${compTxnYoY1 !== undefined ? trendArrow(compTxnYoY1) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${comp1Txn.toLocaleString()}</div>
        </div>
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">7-DAY YoY</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(compTxnYoY7 ?? 0)};">${compTxnYoY7 !== undefined ? pctStr(compTxnYoY7) : '--'} <span style="font-size: 14px;">${compTxnYoY7 !== undefined ? trendArrow(compTxnYoY7) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${comp7Txn.toLocaleString()}</div>
        </div>
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">30-DAY YoY</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(compTxnYoY30 ?? 0)};">${compTxnYoY30 !== undefined ? pctStr(compTxnYoY30) : '--'} <span style="font-size: 14px;">${compTxnYoY30 !== undefined ? trendArrow(compTxnYoY30) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${comp30Txn.toLocaleString()}</div>
        </div>
      </div>
    </div>

    <!-- ═══ STATE BREAKDOWN: AL vs TN ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">State Breakdown</h3>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 3px 2px; ${headerCell}">STATE</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">SALES</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">vs LW</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">7D</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">30D</th>
          </tr>
        </thead>
        <tbody>
          ${renderStatRow('Alabama', alStats.count, alStats.sales, alStats.vsLW, alStats.osatPct, alStats.osatSurveys, alStats.p7Var, alStats.p30Var)}
          ${renderStatRow('Tennessee', tnStats.count, tnStats.sales, tnStats.vsLW, tnStats.osatPct, tnStats.osatSurveys, tnStats.p7Var, tnStats.p30Var)}
        </tbody>
      </table>
    </div>

    <!-- ═══ COMP vs NON-COMP ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">Comp vs Non-Comp <span style="font-size: 11px; color: #71717a; font-weight: 400;">(18-month threshold)</span></h3>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 3px 2px; ${headerCell}">GROUP</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">SALES</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">vs LW</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">vs LY</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">7D YoY</th>
            <th style="padding: 3px 2px; ${headerCell} text-align: right;">30D</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 5px 2px; font-size: 11px; font-weight: 600;">Comp <span style="color: #a1a1aa; font-weight: 400;">(${compStats.count})</span></td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right;">${formatCurrency(compStats.sales)}</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${(compStats.vsLW ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compStats.vsLW !== undefined ? pctStr(compStats.vsLW) : '--'}</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${(compStats.vsLY ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compStats.vsLY !== undefined ? pctStr(compStats.vsLY) : '--'}</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${(compYoY7 ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compYoY7 !== undefined ? pctStr(compYoY7) : '--'}</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${(compYoY30 ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compYoY30 !== undefined ? pctStr(compYoY30) : '--'}</td>
          </tr>
          ${nonCompStores.length > 0 ? `
          <tr>
            <td style="padding: 5px 2px; font-size: 11px; font-weight: 600;">Non-Comp <span style="color: #a1a1aa; font-weight: 400;">(${nonCompStats.count})</span></td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right;">${formatCurrency(nonCompStats.sales)}</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: ${(nonCompStats.vsLW ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${nonCompStats.vsLW !== undefined ? pctStr(nonCompStats.vsLW) : '--'}</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: #a1a1aa;">N/A</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: #a1a1aa;">N/A</td>
            <td style="padding: 5px 2px; font-size: 11px; text-align: right; color: #a1a1aa;">N/A</td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>

    <!-- ═══ TOP PERFORMERS ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600; color: #16a34a;">Top Performers <span style="font-size: 11px; color: #71717a; font-weight: 400;">(by daily sales)</span></h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="text-align: left; padding: 6px 4px; font-size: 10px; color: #71717a; font-weight: 600;">#</th>
            <th style="text-align: left; padding: 6px 4px; font-size: 10px; color: #71717a; font-weight: 600;">Store</th>
            <th style="text-align: right; padding: 6px 4px; font-size: 10px; color: #71717a; font-weight: 600;">Sales</th>
            <th style="text-align: right; padding: 6px 4px; font-size: 10px; color: #71717a; font-weight: 600;">vs LW</th>
            ${hasLYData ? `<th style="text-align: right; padding: 6px 4px; font-size: 10px; color: #71717a; font-weight: 600;">YoY</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${top5.map((r, i) => `
          <tr style="${i < top5.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
            <td style="padding: 8px 4px; font-size: 16px; font-weight: 700; color: #16a34a; vertical-align: top;">${i + 1}</td>
            <td style="padding: 8px 4px; vertical-align: top;">
              <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 14px; font-weight: 600; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.restaurantName}</a>
              ${r.status === 'new' ? `<span style="font-size: 9px; background: #dbeafe; color: #1e40af; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">NEW</span>` : ''}
              <div style="margin-top: 2px;">
                <span style="font-size: 10px; color: #a1a1aa;">${r.state}${!r.isComp ? ' &middot; NC' : ''}</span>
                ${r.earnedBadges.length > 0 ? `<span style="margin-left: 6px; font-size: 10px; color: #71717a;">${r.earnedBadges.join(', ')}</span>` : ''}
              </div>
            </td>
            <td style="padding: 8px 4px; text-align: right; font-weight: 600; vertical-align: top;">${formatCurrency(r.sales)}</td>
            <td style="padding: 8px 4px; text-align: right; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'}; vertical-align: top;">${pctStr(r.salesVsLW)}</td>
            ${hasLYData ? `<td style="padding: 8px 4px; text-align: right; color: ${(r.salesVsLY ?? 0) >= 0 ? '#16a34a' : '#dc2626'}; vertical-align: top;">${r.salesVsLY !== undefined ? pctStr(r.salesVsLY) : '--'}</td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- ═══ NEW STORES ═══ -->
    ${newStores.length > 0 ? `
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600; color: #2563eb;">New Store Spotlight</h3>
      ${newStores.map((r, idx) => {
        const p7Var = r.prior7LWSales > 0 ? ((r.prior7Sales - r.prior7LWSales) / r.prior7LWSales) * 100 : undefined;
        const weeksOpen = r.storeAgeWeeks;
        const ageDisplay = weeksOpen !== null && weeksOpen <= 26 ? `${weeksOpen}wk${weeksOpen !== 1 ? 's' : ''}` : r.storeAge;
        return `
      <div style="padding: 10px 0;${idx < newStores.length - 1 ? ' border-bottom: 1px solid #f4f4f5;' : ''}">
        <div>
          <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 14px; font-weight: 600; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.restaurantName}</a>
          <span style="font-size: 10px; background: #dbeafe; color: #1e40af; padding: 1px 5px; border-radius: 3px; margin-left: 6px; font-weight: 600;">${ageDisplay}</span>
          <span style="font-size: 10px; color: #a1a1aa; margin-left: 4px;">${r.state}</span>
        </div>
        <div style="margin-top: 6px;">
          <span style="font-size: 15px; font-weight: 600;">${formatCurrency(r.sales)}</span>
          <span style="margin-left: 10px; font-size: 13px; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(r.salesVsLW)} <span style="font-size: 10px; color: #a1a1aa;">WoW</span></span>
        </div>
        <div style="margin-top: 4px; font-size: 11px; color: #71717a;">
          ${r.eowForecast > 0 ? `EOW <span style="color: #3b82f6; font-weight: 500;">${formatCurrency(r.eowForecast)}</span>` : ''}
          ${r.prior90Sales > 0 ? `<span style="margin-left: 10px;">90D ${formatCurrency(r.prior90Sales)}</span>` : ''}
          ${p7Var !== undefined ? `<span style="margin-left: 10px;">7D Trend <span style="color: ${trendColor(p7Var)}; font-weight: 500;">${pctStr(p7Var)}</span></span>` : ''}
        </div>
      </div>`;
      }).join('')}
    </div>` : ''}

    <!-- ═══ ALL UNITS ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 4px; font-size: 14px; font-weight: 600;">All Units <span style="font-size: 11px; color: #71717a; font-weight: 400;">(sorted by daily sales)</span></h3>
      <div style="font-size: 10px; color: #a1a1aa; margin-bottom: 10px;">C = Comp &middot; NC = Non-Comp &middot; Labor Hours = Actual hrs (&plusmn; vs model)</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="text-align: left; padding: 5px 3px; font-size: 9px; color: #71717a; font-weight: 600;">#</th>
            <th style="text-align: left; padding: 5px 3px; font-size: 9px; color: #71717a; font-weight: 600;">Store</th>
            <th style="text-align: right; padding: 5px 3px; font-size: 9px; color: #71717a; font-weight: 600;">Sales</th>
            <th style="text-align: right; padding: 5px 3px; font-size: 9px; color: #71717a; font-weight: 600;">vs LW</th>
            ${hasLYData ? `<th style="text-align: right; padding: 5px 3px; font-size: 9px; color: #71717a; font-weight: 600;">YoY</th>` : ''}
            <th style="text-align: right; padding: 5px 3px; font-size: 9px; color: #71717a; font-weight: 600;">Labor Hrs</th>
          </tr>
        </thead>
        <tbody>
          ${sortedBySales.map((r, i) => {
        const laborDiff = r.actualHours - r.modelHours;
        const laborColor = r.modelHours > 0 ? (Math.abs(laborDiff) <= 2 ? '#16a34a' : laborDiff > 0 ? '#dc2626' : '#d97706') : '#a1a1aa';
        return `
          <tr style="${i < sortedBySales.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
            <td style="padding: 6px 3px; font-size: 11px; color: #a1a1aa; vertical-align: top;">${i + 1}</td>
            <td style="padding: 6px 3px; vertical-align: top;">
              <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 12px; font-weight: 500; color: inherit; text-decoration: none; border-bottom: 1px dashed #a1a1aa;">${r.restaurantName}</a>
              ${r.status === 'new' ? '<span style="font-size: 8px; background: #dbeafe; color: #1e40af; padding: 0 3px; border-radius: 2px; margin-left: 3px;">NEW</span>' : ''}
              <span style="font-size: 9px; padding: 0 2px; margin-left: 2px; ${r.isComp ? 'color: #a1a1aa;' : 'background: #fef3c7; color: #92400e; border-radius: 2px;'}">${r.isComp ? 'C' : 'NC'}</span>
              <div style="margin-top: 1px; font-size: 9px; color: #a1a1aa;">${r.state} ${weatherIcon(r.weatherCondition)}${r.weatherHighTemp !== null ? Math.round(r.weatherHighTemp) + '&deg;' : ''}</div>
            </td>
            <td style="padding: 6px 3px; text-align: right; font-weight: 600; vertical-align: top;">${formatCurrency(r.sales)}</td>
            <td style="padding: 6px 3px; text-align: right; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'}; vertical-align: top;">${pctStr(r.salesVsLW)}</td>
            ${hasLYData ? `<td style="padding: 6px 3px; text-align: right; color: ${(r.salesVsLY ?? 0) >= 0 ? '#16a34a' : '#dc2626'}; vertical-align: top;">${r.salesVsLY !== undefined ? pctStr(r.salesVsLY) : '--'}</td>` : ''}
            <td style="padding: 6px 3px; text-align: right; vertical-align: top; color: ${laborColor};">
              ${r.modelHours > 0 ? `${r.actualHours.toFixed(0)} <span style="font-size: 10px;">(${laborDiff >= 0 ? '+' : ''}${laborDiff.toFixed(0)})</span>` : '--'}
            </td>
          </tr>`;
      }).join('')}
        </tbody>
      </table>
    </div>

    <!-- ═══ LEGEND ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #71717a;">Legend</h3>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: #52525b;">
        <div><span style="display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; color: #a1a1aa; margin-right: 4px;">C</span> Comp (open &gt; 18 months)</div>
        <div><span style="display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; background: #fef3c7; color: #92400e; margin-right: 4px;">NC</span> Non-Comp (open &le; 18 months)</div>
        <div><span style="display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; background: #dbeafe; color: #1e40af; margin-right: 4px;">NEW</span> New store</div>
      </div>
      <div style="margin-top: 6px; font-size: 10px; color: #a1a1aa;">
        vs LW = compared to same day last week &middot; YoY = year-over-year (same day-of-week aligned) &middot; 7D/30D = rolling period trends
      </div>
    </div>

    <!-- ═══ FOOTER ═══ -->
    <div style="${sectionStyle} border-radius: 0 0 8px 8px; text-align: center;">
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 0;">
        MWB Restaurants
      </p>
    </div>

  </div>
</body>
</html>`;
  } catch (error) {
    console.error("[sales-summary] Error building report HTML:", error);
    return null;
  }
}
