import { getBaseUrl } from "./base-url";
import { db } from "./db";
import { emailSubscribers, emailSendLog, reportSchedules, restaurants, historicalDailySales, hourlySales, dailyWeather } from "@shared/schema";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import type { HourlySalesData, RestaurantSales } from "@shared/schema";
import { computeHourlyScore, scoreToGradeLabel, getGradeColorHex, formatCurrency, computeDailyBonuses, countAttachmentCategoriesAtTarget, BONUS_DEFINITIONS } from "./lib/scoring";
import { getTotalRequiredStaff } from "./labor-model";
import { getAttachmentRatesFromDetail, getAllHourlyPosSalesRange } from "./xenial-webhook";
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
  // Labor
  modelHours: number;
  actualHours: number;
  // Weather
  weatherCondition: string | null;
  weatherHighTemp: number | null;
  // Multi-day rolling totals
  prior7Sales: number;
  prior7LWSales: number;
  prior30Sales: number;
  prior30LWSales: number;
  prior90Sales: number;
  prior90LWSales: number;
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
    if (!force) {
      const schedules = await db.select().from(reportSchedules)
        .where(eq(reportSchedules.reportType, "sales_summary"));
      const schedule = schedules[0];
      if (schedule && !schedule.isEnabled) {
        console.log("[sales-summary] Automated sending is disabled - skipping");
        return result;
      }
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
    const alreadySent = await db.select()
      .from(emailSendLog)
      .where(and(eq(emailSendLog.reportDate, reportKey), eq(emailSendLog.status, "sent")));
    const sentEmails = new Set(alreadySent.map(s => s.email));
    const pendingSubscribers = subscribers.filter(s => !sentEmails.has(s.email));

    if (pendingSubscribers.length === 0) {
      console.log("[sales-summary] All reports already sent for", yesterdayStr);
      return result;
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

        const positions = (hour as any).positionBreakdown || {};
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
          speedAttainment: (hour as any).ootActive ? undefined : (hour as any).speedAttainment,
          osatPercent: (hour as any).osatPercent,
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
      const osatHoursForBonus = completedHours.filter(h => (h as any).osatPercent !== undefined && ((h as any).osatResponses ?? 0) > 0);
      const dailyOsatResponses = osatHoursForBonus.reduce((s, h) => s + ((h as any).osatResponses ?? 0), 0);
      const dailyOsatPct = dailyOsatResponses > 0
        ? osatHoursForBonus.reduce((s, h) => s + ((h as any).osatPercent ?? 0) * ((h as any).osatResponses ?? 0), 0) / dailyOsatResponses
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
        const sa = (h as any).speedAttainment;
        if (sa !== undefined && sa >= 0) { acc.total += sa; acc.count++; }
        return acc;
      }, { total: 0, count: 0 });

      // OSAT
      const osatData = hourlyData.reduce((acc, h) => {
        const op = (h as any).osatPercent;
        const or2 = (h as any).osatResponses;
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
        const positions = (hour as any).positionBreakdown || {};
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
        modelHours: Math.round(modelHoursTotal * 10) / 10,
        actualHours: Math.round(actualHoursTotal * 10) / 10,
        weatherCondition: weather?.condition ?? null,
        weatherHighTemp: weather?.highTemp ? parseFloat(String(weather.highTemp)) : null,
        prior7Sales: 0, prior7LWSales: 0,
        prior30Sales: 0, prior30LWSales: 0,
        prior90Sales: 0, prior90LWSales: 0,
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

    // Comp YoY rolling: fetch last year's 7D and 30D sales for comp stores
    const compStoreIds = new Set(compStores.map(r => r.restaurantId));
    const yesterday = new Date(`${dateStr}T12:00:00`);
    const fmt = (d: Date) => d.toISOString().split("T")[0];

    // Current period: 7D and 30D ending on dateStr
    const comp7Sales = compStores.reduce((s, r) => s + r.prior7Sales, 0);
    const comp30Sales = compStores.reduce((s, r) => s + r.prior30Sales, 0);

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
    try {
      const lyRows = await db.select().from(historicalDailySales)
        .where(and(
          gte(historicalDailySales.date, fmt(ly30Start)),
          lte(historicalDailySales.date, fmt(lyYesterday))
        ));
      let ly7Total = 0, ly30Total = 0;
      for (const row of lyRows) {
        if (!compStoreIds.has(row.restaurantId)) continue;
        const rowDate = new Date(`${row.date}T12:00:00`);
        const sales = parseFloat(row.netSales);
        if (rowDate >= ly7Start) ly7Total += sales;
        ly30Total += sales;
      }
      if (ly7Total > 0) compYoY7 = pctVar(comp7Sales, ly7Total);
      if (ly30Total > 0) compYoY30 = pctVar(comp30Sales, ly30Total);
    } catch { /* historical data may not be available */ }

    // Sort by daily sales (descending) for top performers and all-units
    const sortedBySales = [...restaurantData].sort((a, b) => b.sales - a.sales);
    const top5 = sortedBySales.slice(0, 5);

    // Bottom 3 by sales needing attention
    const bottom3 = sortedBySales.slice(-3).reverse();

    // Units with most badges
    const badgeLeaders = [...restaurantData]
      .filter(r => r.earnedBadges.length > 0)
      .sort((a, b) => b.earnedBadges.length - a.earnedBadges.length)
      .slice(0, 5);

    // New stores (status === "new")
    const newStores = restaurantData.filter(r => r.status === "new");

    // Trend insight
    const var7 = pctVar(total7, total7LW);
    const var30 = pctVar(total30, total30LW);
    const var90 = pctVar(total90, total90LW);

    let trendInsight = "";
    if (var7 !== undefined && var30 !== undefined) {
      if (var7 > 0 && var30 > 0 && var7 > var30) {
        trendInsight = "Sales momentum is accelerating &mdash; the 7-day trend is outpacing the 30-day trend.";
      } else if (var7 > 0 && var30 > 0 && var7 < var30) {
        trendInsight = "Sales are positive but the pace is slowing &mdash; 7-day growth is trailing the 30-day trend.";
      } else if (var7 < 0 && var30 >= 0) {
        trendInsight = "Short-term softness &mdash; the last 7 days are below prior year despite a positive 30-day trend.";
      } else if (var7 < 0 && var30 < 0) {
        trendInsight = "Sustained headwind &mdash; both 7-day and 30-day trends are tracking below prior comparable periods.";
      } else if (var7 >= 0 && var30 < 0) {
        trendInsight = "Encouraging recovery &mdash; the 7-day trend has turned positive despite a negative 30-day backdrop.";
      }
    }

    // Formatting
    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const formattedDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const baseUrl = getBaseUrl();

    // ──── HTML ─────────────────────────────────────────────────

    const sectionStyle = `background: white; border: 1px solid #e4e4e7; border-top: none; padding: 20px 24px;`;
    const headerCell = `font-size: 10px; color: #a1a1aa; font-weight: 600;`;
    const dataCell = `font-size: 12px;`;

    const renderStatRow = (label: string, count: number, sales: number, vsLW: number | undefined, osat: number | null, osatSurveys: number, p7Var: number | undefined, p30Var: number | undefined, vsLY?: number | undefined) => `
      <tr>
        <td style="padding: 6px 4px; font-size: 12px; font-weight: 600;">${label} <span style="color: #a1a1aa; font-weight: 400;">(${count})</span></td>
        <td style="padding: 6px 4px; font-size: 12px; text-align: right;">${formatCurrency(sales)}</td>
        <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${vsLW !== undefined && vsLW >= 0 ? '#16a34a' : '#dc2626'};">${vsLW !== undefined ? pctStr(vsLW) : '--'}</td>
        ${vsLY !== undefined ? `<td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${vsLY >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(vsLY)}</td>` : ''}
        <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${osat !== null ? (osat >= 85 ? '#16a34a' : osat >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${osat !== null ? Math.round(osat) + '%' : '--'} <span style="font-size: 9px; color: #a1a1aa;">${osatSurveys > 0 ? '(' + osatSurveys + ')' : ''}</span></td>
        <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${trendColor(p7Var ?? 0)};">${p7Var !== undefined ? pctStr(p7Var) : '--'}</td>
        <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${trendColor(p30Var ?? 0)};">${p30Var !== undefined ? pctStr(p30Var) : '--'}</td>
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
  <div style="max-width: 720px; margin: 0 auto; padding: 20px;">

    <!-- ═══ HEADER ═══ -->
    <div style="background: linear-gradient(135deg, #18181b 0%, #27272a 100%); color: white; padding: 28px 24px; border-radius: 8px 8px 0 0; text-align: center;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Executive Sales Summary</h1>
      <p style="margin: 6px 0 0; font-size: 14px; color: #a1a1aa;">${dayOfWeek}, ${formattedDate}</p>
      <p style="margin: 4px 0 0; font-size: 12px; color: #71717a;">MWB Restaurant Group &middot; ${restaurantData.length} Active Units</p>
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
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">Yesterday Sales</div>
        </div>
        <div style="min-width: 70px;">
          <div style="font-size: 28px; font-weight: 700; color: ${(companyVsLW ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${companyVsLW !== undefined ? pctStr(companyVsLW) : '--'}</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">vs Last Week</div>
        </div>
        ${companyVsLY !== undefined ? `
        <div style="min-width: 70px;">
          <div style="font-size: 28px; font-weight: 700; color: ${companyVsLY >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(companyVsLY)}</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">vs Last Year</div>
        </div>` : ''}
        ${companyOsat !== null ? `
        <div style="min-width: 70px;">
          <div style="font-size: 28px; font-weight: 700; color: ${companyOsat >= 85 ? '#16a34a' : companyOsat >= 80 ? '#d97706' : '#dc2626'};">${Math.round(companyOsat)}%</div>
          <div style="font-size: 11px; color: #71717a; margin-top: 2px;">OSAT <span style="font-size: 10px;">(${companyOsatResponses} surveys)</span></div>
        </div>` : ''}
      </div>
    </div>

    <!-- ═══ ROLLING TREND ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">Sales Trend vs Prior Year Comparable</h3>
      <div style="display: flex; justify-content: space-around; text-align: center; gap: 8px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">PRIOR 7 DAYS</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(var7 ?? 0)};">${var7 !== undefined ? pctStr(var7) : '--'} <span style="font-size: 14px;">${var7 !== undefined ? trendArrow(var7) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${formatCurrency(total7)}</div>
        </div>
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">PRIOR 30 DAYS</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(var30 ?? 0)};">${var30 !== undefined ? pctStr(var30) : '--'} <span style="font-size: 14px;">${var30 !== undefined ? trendArrow(var30) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${formatCurrency(total30)}</div>
        </div>
        <div style="flex: 1; min-width: 100px; padding: 12px 8px; border-radius: 8px; background: #fafafa;">
          <div style="font-size: 10px; color: #71717a; margin-bottom: 4px;">PRIOR 90 DAYS</div>
          <div style="font-size: 22px; font-weight: 700; color: ${trendColor(var90 ?? 0)};">${var90 !== undefined ? pctStr(var90) : '--'} <span style="font-size: 14px;">${var90 !== undefined ? trendArrow(var90) : ''}</span></div>
          <div style="font-size: 11px; color: #71717a;">${formatCurrency(total90)}</div>
        </div>
      </div>
      ${trendInsight ? `<div style="margin-top: 12px; padding: 10px 12px; border-radius: 6px; background: #f0f9ff; border: 1px solid #bae6fd; font-size: 12px; color: #0c4a6e;">${trendInsight}</div>` : ''}
    </div>

    <!-- ═══ STATE BREAKDOWN: AL vs TN ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">State Breakdown</h3>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 4px; ${headerCell}">STATE</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">SALES</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">vs LW</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">OSAT</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">7D</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">30D</th>
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
            <th style="padding: 4px; ${headerCell}">GROUP</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">SALES</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">vs LW</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">vs LY</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">7D YoY</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">30D YoY</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">OSAT</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 6px 4px; font-size: 12px; font-weight: 600;">Comp <span style="color: #a1a1aa; font-weight: 400;">(${compStats.count})</span></td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right;">${formatCurrency(compStats.sales)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${(compStats.vsLW ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compStats.vsLW !== undefined ? pctStr(compStats.vsLW) : '--'}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${(compStats.vsLY ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compStats.vsLY !== undefined ? pctStr(compStats.vsLY) : '--'}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${(compYoY7 ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compYoY7 !== undefined ? pctStr(compYoY7) : '--'}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${(compYoY30 ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${compYoY30 !== undefined ? pctStr(compYoY30) : '--'}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${compStats.osatPct !== null ? (compStats.osatPct >= 85 ? '#16a34a' : compStats.osatPct >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${compStats.osatPct !== null ? Math.round(compStats.osatPct) + '%' : '--'} <span style="font-size: 9px; color: #a1a1aa;">${compStats.osatSurveys > 0 ? '(' + compStats.osatSurveys + ')' : ''}</span></td>
          </tr>
          ${nonCompStores.length > 0 ? `
          <tr>
            <td style="padding: 6px 4px; font-size: 12px; font-weight: 600;">Non-Comp <span style="color: #a1a1aa; font-weight: 400;">(${nonCompStats.count})</span></td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right;">${formatCurrency(nonCompStats.sales)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${(nonCompStats.vsLW ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${nonCompStats.vsLW !== undefined ? pctStr(nonCompStats.vsLW) : '--'}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: #a1a1aa;">N/A</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: #a1a1aa;">N/A</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: #a1a1aa;">N/A</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${nonCompStats.osatPct !== null ? (nonCompStats.osatPct >= 85 ? '#16a34a' : nonCompStats.osatPct >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${nonCompStats.osatPct !== null ? Math.round(nonCompStats.osatPct) + '%' : '--'} <span style="font-size: 9px; color: #a1a1aa;">${nonCompStats.osatSurveys > 0 ? '(' + nonCompStats.osatSurveys + ')' : ''}</span></td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>

    <!-- ═══ TOP PERFORMERS ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600; color: #16a34a;">Top Performers <span style="font-size: 11px; color: #71717a; font-weight: 400;">(by daily sales)</span></h3>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 4px; ${headerCell} width: 20px;">#</th>
            <th style="padding: 4px; ${headerCell}">UNIT</th>
            <th style="padding: 4px; ${headerCell} text-align: right; width: 60px;">SALES</th>
            <th style="padding: 4px; ${headerCell} text-align: right; width: 50px;">vs LW</th>
            ${hasLYData ? `<th style="padding: 4px; ${headerCell} text-align: right; width: 50px;">vs LY</th>` : ''}
            <th style="padding: 4px; ${headerCell} text-align: right; width: 60px;">OSAT</th>
            <th style="padding: 4px; ${headerCell} width: 90px;">BADGES</th>
          </tr>
        </thead>
        <tbody>
          ${top5.map((r, i) => `
          <tr style="border-bottom: 1px solid #f4f4f5;">
            <td style="padding: 6px 4px; font-size: 12px; color: #16a34a; font-weight: 700;">${i + 1}</td>
            <td style="padding: 6px 4px;">
              <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 12px; font-weight: 500; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.restaurantName}</a>
              ${r.status === 'new' ? `<span style="font-size: 9px; background: #dbeafe; color: #1e40af; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">NEW ${r.storeAge}</span>` : ''}
              <span style="font-size: 9px; color: #a1a1aa; margin-left: 2px;">${r.state}${!r.isComp ? ' NC' : ''}</span>
            </td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right;">${formatCurrency(r.sales)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(r.salesVsLW)}</td>
            ${hasLYData ? `<td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${(r.salesVsLY ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${r.salesVsLY !== undefined ? pctStr(r.salesVsLY) : '--'}</td>` : ''}
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${r.osatPercent !== null ? (r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${r.osatPercent !== null ? Math.round(r.osatPercent) + '%' : '--'} <span style="font-size: 9px; color: #a1a1aa;">${r.osatResponses > 0 ? '(' + r.osatResponses + ')' : ''}</span></td>
            <td style="padding: 6px 4px; font-size: 9px; color: #71717a;">${r.earnedBadges.length > 0 ? r.earnedBadges.join(', ') : '--'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- ═══ NEEDS ATTENTION ═══ -->
    ${bottom3.length > 0 ? `
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600; color: #dc2626;">Needs Attention <span style="font-size: 11px; color: #71717a; font-weight: 400;">(lowest daily sales)</span></h3>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 4px; ${headerCell} width: 20px;">#</th>
            <th style="padding: 4px; ${headerCell}">UNIT</th>
            <th style="padding: 4px; ${headerCell} text-align: right; width: 60px;">SALES</th>
            <th style="padding: 4px; ${headerCell} text-align: right; width: 50px;">vs LW</th>
            <th style="padding: 4px; ${headerCell} text-align: right; width: 60px;">OSAT</th>
          </tr>
        </thead>
        <tbody>
          ${bottom3.map((r, i) => `
          <tr style="border-bottom: 1px solid #f4f4f5;">
            <td style="padding: 6px 4px; font-size: 12px; color: #a1a1aa;">${restaurantData.length - bottom3.length + i + 1}</td>
            <td style="padding: 6px 4px;">
              <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 12px; font-weight: 500; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.restaurantName}</a>
              ${r.status === 'new' ? `<span style="font-size: 9px; background: #dbeafe; color: #1e40af; padding: 1px 4px; border-radius: 3px; margin-left: 4px;">NEW ${r.storeAge}</span>` : ''}
              <span style="font-size: 9px; color: #a1a1aa; margin-left: 2px;">${r.state}${!r.isComp ? ' NC' : ''}</span>
            </td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right;">${formatCurrency(r.sales)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(r.salesVsLW)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${r.osatPercent !== null ? (r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${r.osatPercent !== null ? Math.round(r.osatPercent) + '%' : '--'} <span style="font-size: 9px; color: #a1a1aa;">${r.osatResponses > 0 ? '(' + r.osatResponses + ')' : ''}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <!-- ═══ NEW STORES ═══ -->
    ${newStores.length > 0 ? `
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600; color: #2563eb;">New Store Spotlight</h3>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 4px; ${headerCell}">UNIT</th>
            <th style="padding: 4px; ${headerCell} text-align: center;">AGE</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">SALES</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">vs LW</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">OSAT</th>
            <th style="padding: 4px; ${headerCell} text-align: right;">7D TREND</th>
          </tr>
        </thead>
        <tbody>
          ${newStores.map(r => {
            const p7Var = r.prior7LWSales > 0 ? ((r.prior7Sales - r.prior7LWSales) / r.prior7LWSales) * 100 : undefined;
            return `
          <tr style="border-bottom: 1px solid #f4f4f5;">
            <td style="padding: 6px 4px;">
              <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 12px; font-weight: 500; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.restaurantName}</a>
              <span style="font-size: 9px; color: #a1a1aa; margin-left: 2px;">${r.state}</span>
            </td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: center;"><span style="background: #dbeafe; color: #1e40af; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600;">${r.storeAge}</span></td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right;">${formatCurrency(r.sales)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(r.salesVsLW)}</td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${r.osatPercent !== null ? (r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${r.osatPercent !== null ? Math.round(r.osatPercent) + '%' : '--'} <span style="font-size: 9px; color: #a1a1aa;">${r.osatResponses > 0 ? '(' + r.osatResponses + ')' : ''}</span></td>
            <td style="padding: 6px 4px; font-size: 12px; text-align: right; color: ${trendColor(p7Var ?? 0)};">${p7Var !== undefined ? pctStr(p7Var) : '--'}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <!-- ═══ BADGE LEADERS ═══ -->
    ${badgeLeaders.length > 0 ? `
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 10px; font-size: 14px; font-weight: 600;">Badge Leaders</h3>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${badgeLeaders.map(r => `
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; background: #fafafa;">
          <span style="font-size: 12px; font-weight: 600; min-width: 100px;">${r.restaurantName}</span>
          <div style="flex: 1; display: flex; gap: 4px; flex-wrap: wrap;">
            ${r.earnedBadges.map(b => `<span style="display: inline-block; padding: 1px 6px; border-radius: 9999px; font-size: 9px; font-weight: 600; background: #dcfce7; color: #166534;">${b}</span>`).join('')}
          </div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- ═══ ALL UNITS ═══ -->
    <div style="${sectionStyle}">
      <h3 style="margin: 0 0 4px; font-size: 14px; font-weight: 600;">All Units <span style="font-size: 11px; color: #71717a; font-weight: 400;">(sorted by daily sales)</span></h3>
      <div style="font-size: 10px; color: #a1a1aa; margin-bottom: 10px;">C = Comp (open &gt; 18 months) &middot; NC = Non-Comp (open &le; 18 months) &middot; Labor = Model hrs / Actual hrs</div>
      <table>
        <thead>
          <tr style="border-bottom: 2px solid #e4e4e7;">
            <th style="padding: 3px 4px; ${headerCell} width: 18px;">#</th>
            <th style="padding: 3px 4px; ${headerCell}">UNIT</th>
            <th style="padding: 3px 4px; ${headerCell} text-align: right; width: 54px;">SALES</th>
            <th style="padding: 3px 4px; ${headerCell} text-align: right; width: 44px;">vs LW</th>
            ${hasLYData ? `<th style="padding: 3px 4px; ${headerCell} text-align: right; width: 44px;">vs LY</th>` : ''}
            <th style="padding: 3px 4px; ${headerCell} text-align: right; width: 50px;">OSAT</th>
            <th style="padding: 3px 4px; ${headerCell} text-align: right; width: 64px;">LABOR</th>
            <th style="padding: 3px 4px; ${headerCell} text-align: center; width: 28px;">WX</th>
          </tr>
        </thead>
        <tbody>
          ${sortedBySales.map((r, i) => {
            const laborDiff = r.actualHours - r.modelHours;
            const laborColor = r.modelHours > 0 ? (Math.abs(laborDiff) <= 2 ? '#16a34a' : laborDiff > 0 ? '#dc2626' : '#d97706') : '#a1a1aa';
            return `
          <tr style="border-bottom: 1px solid #fafafa;">
            <td style="padding: 4px; font-size: 10px; color: #a1a1aa;">${i + 1}</td>
            <td style="padding: 4px;">
              <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.restaurantId}" style="font-size: 11px; color: inherit; text-decoration: none; border-bottom: 1px dashed #a1a1aa;">${r.restaurantName}</a>
              ${r.status === 'new' ? '<span style="font-size: 8px; background: #dbeafe; color: #1e40af; padding: 0 3px; border-radius: 2px; margin-left: 2px;">NEW</span>' : ''}
              <span style="font-size: 8px; padding: 0 3px; border-radius: 2px; margin-left: 1px; ${r.isComp ? 'color: #a1a1aa;' : 'background: #fef3c7; color: #92400e;'}">${r.isComp ? 'C' : 'NC'}</span>
              <span style="font-size: 8px; color: #a1a1aa;">${r.state}</span>
            </td>
            <td style="padding: 4px; font-size: 11px; text-align: right;">${formatCurrency(r.sales)}</td>
            <td style="padding: 4px; font-size: 11px; text-align: right; color: ${r.salesVsLW >= 0 ? '#16a34a' : '#dc2626'};">${pctStr(r.salesVsLW)}</td>
            ${hasLYData ? `<td style="padding: 4px; font-size: 11px; text-align: right; color: ${(r.salesVsLY ?? 0) >= 0 ? '#16a34a' : '#dc2626'};">${r.salesVsLY !== undefined ? pctStr(r.salesVsLY) : '--'}</td>` : ''}
            <td style="padding: 4px; font-size: 11px; text-align: right; color: ${r.osatPercent !== null ? (r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626') : '#a1a1aa'};">${r.osatPercent !== null ? Math.round(r.osatPercent) + '%' : '--'} <span style="font-size: 8px; color: #a1a1aa;">${r.osatResponses > 0 ? '(' + r.osatResponses + ')' : ''}</span></td>
            <td style="padding: 4px; font-size: 10px; text-align: right; color: ${laborColor};">${r.modelHours > 0 ? r.modelHours.toFixed(0) + '/' + r.actualHours.toFixed(0) : '--'}</td>
            <td style="padding: 4px; font-size: 11px; text-align: center;" title="${r.weatherCondition || ''}">${weatherIcon(r.weatherCondition)}${r.weatherHighTemp !== null ? '<span style="font-size: 9px; color: #71717a;">' + Math.round(r.weatherHighTemp) + '&deg;</span>' : ''}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- ═══ FOOTER ═══ -->
    <div style="${sectionStyle} border-radius: 0 0 8px 8px; text-align: center;">
      <a href="${baseUrl}" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">
        Open Full Dashboard
      </a>
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 12px;">
        MWB Executive Sales Summary &middot; All figures in Central Time
      </p>
      <p style="font-size: 10px; color: #a1a1aa; margin-top: 4px;">
        Comp threshold: 18 months from open date &middot; Rolling trends compare same day-of-week period prior year
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
