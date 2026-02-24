import { db } from "./db";
import { emailSubscribers, emailSendLog, reportSchedules } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import type { HourlySalesData } from "@shared/schema";

const GRADE_WEIGHTS = {
  sales: 35,
  speed: 25,
  osat: 25,
  staffing: 15,
};

const BREAKFAST_RAMP_UP: Array<{ maxSales: number; staff: number }> = [
  { maxSales: 118.87, staff: 3 }, { maxSales: 237.76, staff: 4 },
  { maxSales: 356.67, staff: 5 }, { maxSales: 475.55, staff: 6 },
  { maxSales: 594.45, staff: 7 }, { maxSales: 686.95, staff: 8 },
  { maxSales: 779.42, staff: 9 }, { maxSales: 871.93, staff: 10 },
  { maxSales: 964.42, staff: 11 }, { maxSales: 1056.89, staff: 12 },
  { maxSales: 1149.40, staff: 13 }, { maxSales: 1241.89, staff: 14 },
  { maxSales: 1334.39, staff: 15 }, { maxSales: 1426.87, staff: 16 },
  { maxSales: 1519.37, staff: 17 }, { maxSales: 1611.87, staff: 18 },
  { maxSales: 1704.37, staff: 19 }, { maxSales: 1796.84, staff: 20 },
  { maxSales: 1889.35, staff: 21 }, { maxSales: 1981.84, staff: 22 },
  { maxSales: 2074.32, staff: 23 }, { maxSales: 2166.82, staff: 24 },
  { maxSales: 2259.32, staff: 25 }, { maxSales: 2351.81, staff: 26 },
  { maxSales: 2444.29, staff: 27 }, { maxSales: 2536.79, staff: 28 },
  { maxSales: 2629.28, staff: 29 }, { maxSales: Infinity, staff: 30 },
];

const NON_BREAKFAST_RAMP_UP: Array<{ maxSales: number; staff: number }> = [
  { maxSales: 154.53, staff: 3 }, { maxSales: 309.09, staff: 4 },
  { maxSales: 463.67, staff: 5 }, { maxSales: 618.23, staff: 6 },
  { maxSales: 772.79, staff: 7 }, { maxSales: 893.04, staff: 8 },
  { maxSales: 1013.28, staff: 9 }, { maxSales: 1133.53, staff: 10 },
  { maxSales: 1253.76, staff: 11 }, { maxSales: 1374.01, staff: 12 },
  { maxSales: 1494.26, staff: 13 }, { maxSales: 1614.50, staff: 14 },
  { maxSales: 1734.74, staff: 15 }, { maxSales: 1854.98, staff: 16 },
  { maxSales: 1975.23, staff: 17 }, { maxSales: 2095.47, staff: 18 },
  { maxSales: 2215.72, staff: 19 }, { maxSales: 2335.95, staff: 20 },
  { maxSales: 2456.20, staff: 21 }, { maxSales: 2576.44, staff: 22 },
  { maxSales: 2696.69, staff: 23 }, { maxSales: 2816.93, staff: 24 },
  { maxSales: 2937.17, staff: 25 }, { maxSales: 3057.42, staff: 26 },
  { maxSales: 3177.66, staff: 27 }, { maxSales: 3297.90, staff: 28 },
  { maxSales: 3418.14, staff: 29 }, { maxSales: Infinity, staff: 30 },
];

const NON_PRODUCTION_BY_HOUR: Record<number, number> = {
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
  6: 0.5, 7: 0.5, 8: 1, 9: 0.5,
  10: 1, 11: 1, 12: 1.5, 13: 1.5,
  14: 0, 15: 0.5, 16: 1, 17: 1.5, 18: 1.5,
  19: 1, 20: 0.5, 21: 0, 22: 0, 23: 0.5,
};

function isBreakfastHour(hour: number): boolean {
  return hour >= 6 && hour < 11;
}

function getProductionStaff(hour: number, hourlySales: number): number {
  if (hourlySales <= 0) return 0;
  const rampUp = isBreakfastHour(hour) ? BREAKFAST_RAMP_UP : NON_BREAKFAST_RAMP_UP;
  for (const tier of rampUp) {
    if (hourlySales <= tier.maxSales) return tier.staff;
  }
  return 30;
}

function getTotalRequiredStaff(hour: number, hourlySales: number): number {
  return (NON_PRODUCTION_BY_HOUR[hour] || 0) + getProductionStaff(hour, hourlySales);
}

function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean,
  isFirstWeek: boolean,
  hasValidStaffing: boolean,
  osatPercent: number | undefined
): { grade: string; score: number; hasGrade: boolean } {
  const components: { score: number; weight: number }[] = [];

  if (hasComparableSales) {
    components.push({ score: salesVariancePct >= -5 ? 100 : 50, weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ score: 100, weight: GRADE_WEIGHTS.sales });
  }

  if (speedAttainment !== undefined && speedAttainment >= 0) {
    let speedScore = 100;
    if (speedAttainment < 50) speedScore = 40;
    else if (speedAttainment < 70) speedScore = 70;
    components.push({ score: speedScore, weight: GRADE_WEIGHTS.speed });
  }

  if (osatPercent !== undefined && osatPercent > 0) {
    let osatScore = 100;
    if (osatPercent < 80) osatScore = 40;
    else if (osatPercent < 85) osatScore = 70;
    components.push({ score: osatScore, weight: GRADE_WEIGHTS.osat });
  }

  if (hasValidStaffing) {
    let staffingScore = 100;
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    const isUnderstaffed = staffingDiff < -1;
    const isOverstaffed = staffingDiff > 1;
    if (isOverstaffed) staffingScore = 60;
    else if (isUnderstaffed && !isSalesSurge) staffingScore = 60;
    components.push({ score: staffingScore, weight: GRADE_WEIGHTS.staffing });
  }

  if (components.length === 0) return { grade: '-', score: 0, hasGrade: false };

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const avgScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;

  return { grade: scoreToGradeLabel(avgScore), score: avgScore, hasGrade: true };
}

function gradeToScore(grade: string): number {
  const scores: Record<string, number> = {
    'A+': 97, 'A': 92, 'A-': 87, 'B+': 82, 'B': 77, 'B-': 72,
    'C+': 67, 'C': 62, 'C-': 57, 'D': 52, 'F': 25
  };
  return scores[grade] ?? 0;
}

function scoreToGradeLabel(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B+";
  if (score >= 75) return "B";
  if (score >= 70) return "B-";
  if (score >= 65) return "C+";
  if (score >= 60) return "C";
  if (score >= 55) return "C-";
  if (score >= 50) return "D";
  return "F";
}

function getGradeColor(grade: string): string {
  if (grade.startsWith("A")) return "#16a34a";
  if (grade.startsWith("B")) return "#2563eb";
  if (grade.startsWith("C")) return "#d97706";
  if (grade.startsWith("D")) return "#dc2626";
  return "#dc2626";
}

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

interface RestaurantSummary {
  id: string;
  name: string;
  sales: number;
  lastWeekSales: number;
  variance: number;
  grade: number;
  gradeLabel: string;
  avgSpeed: number | null;
  osatPercent: number | null;
  staffingPct: number | null;
}

export async function sendDailyReports(force = false): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
    // Check if automated sending is enabled (skip check for manual /send-now)
    if (!force) {
      const schedules = await db.select().from(reportSchedules)
        .where(eq(reportSchedules.reportType, 'daily_report'));
      const schedule = schedules[0];
      if (schedule && !schedule.isEnabled) {
        console.log("[daily-report] Automated sending is disabled - skipping");
        return result;
      }
    }

    const subscribers = await db.select()
      .from(emailSubscribers)
      .where(and(
        eq(emailSubscribers.isActive, true),
        sql`${emailSubscribers.reportTypes} @> ARRAY['daily_report']`
      ));

    if (subscribers.length === 0) {
      console.log("[daily-report] No active subscribers for daily_report");
      return result;
    }

    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = centralFormatter.format(yesterday);

    const reportKey = `daily-${yesterdayStr}`;
    const alreadySent = await db.select()
      .from(emailSendLog)
      .where(and(
        eq(emailSendLog.reportDate, reportKey),
        eq(emailSendLog.status, "sent")
      ));
    const sentEmails = new Set(alreadySent.map(s => s.email));

    const pendingSubscribers = subscribers.filter(s => !sentEmails.has(s.email));

    if (pendingSubscribers.length === 0) {
      console.log("[daily-report] All reports already sent for", yesterdayStr);
      return result;
    }

    const reportHtml = await buildDailyReportHtml(yesterdayStr);

    if (!reportHtml) {
      console.log("[daily-report] No data available for", yesterdayStr);
      return result;
    }

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(yesterday);
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(yesterday);

    const subject = `Daily Performance Summary - ${dayOfWeek}, ${formattedDate}`;

    for (const subscriber of pendingSubscribers) {
      const sent = await sendDailyReportEmail(subscriber.email, subject, reportHtml);

      await db.insert(emailSendLog).values({
        reportDate: reportKey,
        email: subscriber.email,
        status: sent ? "sent" : "failed",
      });

      if (sent) {
        result.sent++;
      } else {
        result.failed++;
      }
    }

    console.log(`[daily-report] Sent ${result.sent} reports, ${result.failed} failed for ${yesterdayStr}`);
  } catch (error) {
    console.error("[daily-report] Error sending daily reports:", error);
  }

  return result;
}

export async function buildDailyReportHtml(dateStr: string): Promise<string | null> {
  try {
    const parts = dateStr.split('-');
    const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);

    const leaderboard = await storage.getLeaderboard(targetDate);
    const hourlyDataByRestaurant = await storage.getHourlyDataByRestaurant(targetDate);

    if (leaderboard.restaurants.length === 0) return null;

    const activeRestaurants = leaderboard.restaurants.filter(r => r.status !== 'training');
    if (activeRestaurants.length === 0) return null;

    const summaries: RestaurantSummary[] = [];
    let totalSales = 0;
    let totalLastWeek = 0;

    for (const restaurant of activeRestaurants) {
      const sales = restaurant.actualSales;
      const lastWeekSales = restaurant.actualLastWeekSales;

      if (sales === 0 && lastWeekSales === 0) continue;

      const variance = lastWeekSales > 0
        ? ((sales - lastWeekSales) / lastWeekSales) * 100
        : 0;

      const hourlyData: HourlySalesData[] = hourlyDataByRestaurant[restaurant.restaurantId] || [];

      const isFirstWeek = (restaurant.daysOpen !== undefined && restaurant.daysOpen < 7);
      const hourlyGradeScores: number[] = [];

      for (const hour of hourlyData) {
        if (hour.hour > 23) continue;
        if (!hour.todaySales || hour.todaySales <= 0) continue;

        const hasComparableSales = hour.lastWeekSales > 0;
        const salesVariancePct = hasComparableSales
          ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100
          : 0;

        const positions = (hour as any).positionBreakdown || {};
        const operatorHrs = positions['_operatorScheduled'] || 0;
        const rawEmployeeCount = Number(hour.employeeCount) || 0;
        const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
        const requiredStaff = getTotalRequiredStaff(hour.hour, hour.todaySales);
        const staffingDiff = actualStaff - requiredStaff;
        const hasValidStaffing = rawEmployeeCount >= 1;

        const gradeInfo = getExecutionGrade(
          salesVariancePct,
          (hour as any).speedAttainment,
          staffingDiff,
          hasComparableSales,
          isFirstWeek,
          hasValidStaffing,
          (hour as any).osatPercent
        );

        if (gradeInfo.hasGrade) {
          hourlyGradeScores.push(gradeToScore(gradeInfo.grade));
        }
      }

      const validScores = hourlyGradeScores.filter(s => s > 0);
      const overallScore = validScores.length > 0
        ? validScores.reduce((a, b) => a + b, 0) / validScores.length
        : 0;
      const gradeLabel = validScores.length > 0 ? scoreToGradeLabel(overallScore) : '-';

      const speedData = hourlyData.reduce((acc, h) => {
        const sa = (h as any).speedAttainment;
        if (sa !== undefined && sa >= 0) {
          acc.total += sa;
          acc.count++;
        }
        return acc;
      }, { total: 0, count: 0 });

      const osatData = hourlyData.reduce((acc, h) => {
        const op = (h as any).osatPercent;
        if (op !== undefined && op > 0) {
          acc.total += op;
          acc.count++;
        }
        return acc;
      }, { total: 0, count: 0 });

      totalSales += sales;
      totalLastWeek += lastWeekSales;

      summaries.push({
        id: restaurant.restaurantId,
        name: restaurant.restaurantName,
        sales,
        lastWeekSales,
        variance,
        grade: overallScore,
        gradeLabel,
        avgSpeed: speedData.count > 0 ? Math.round(speedData.total / speedData.count) : null,
        osatPercent: osatData.count > 0 ? osatData.total / osatData.count : null,
        staffingPct: null,
      });
    }

    if (summaries.length === 0) return null;

    summaries.sort((a, b) => b.grade - a.grade);

    const gradedSummaries = summaries.filter(s => s.grade > 0);
    const avgGrade = gradedSummaries.length > 0
      ? gradedSummaries.reduce((s, r) => s + r.grade, 0) / gradedSummaries.length
      : 0;
    const totalVariance = totalLastWeek > 0
      ? ((totalSales - totalLastWeek) / totalLastWeek) * 100
      : 0;

    const top3 = summaries.slice(0, 3);
    const bottom3 = summaries.slice(-3).reverse();

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(new Date(`${dateStr}T12:00:00`));

    const baseUrl = process.env.REPL_SLUG
      ? `https://${process.env.REPL_SLUG}.replit.app`
      : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : "http://localhost:5000";

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #18181b; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
      <h1 style="margin: 0; font-size: 20px; font-weight: 600;">MWB Daily Performance</h1>
      <p style="margin: 8px 0 0; font-size: 14px; color: #a1a1aa;">${dayOfWeek}, ${formattedDate}</p>
    </div>

    <div style="background: white; padding: 24px; border: 1px solid #e4e4e7; border-top: none;">
      <div style="display: flex; justify-content: space-around; text-align: center; margin-bottom: 20px;">
        <div>
          <div style="font-size: 28px; font-weight: 700; color: ${getGradeColor(scoreToGradeLabel(avgGrade))};">${avgGrade > 0 ? scoreToGradeLabel(avgGrade) : '-'}</div>
          <div style="font-size: 12px; color: #71717a; margin-top: 2px;">Avg Grade</div>
        </div>
        <div>
          <div style="font-size: 28px; font-weight: 700;">${formatCurrency(totalSales)}</div>
          <div style="font-size: 12px; color: #71717a; margin-top: 2px;">Total Sales</div>
        </div>
        <div>
          <div style="font-size: 28px; font-weight: 700; color: ${totalVariance >= 0 ? '#16a34a' : '#dc2626'};">${totalVariance >= 0 ? '+' : ''}${totalVariance.toFixed(1)}%</div>
          <div style="font-size: 12px; color: #71717a; margin-top: 2px;">vs Last Week</div>
        </div>
      </div>
    </div>

    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #16a34a;">Top Performers</h3>
      <div style="display: flex; align-items: center; padding: 4px 0; border-bottom: 2px solid #e4e4e7;">
        <span style="width: 20px; font-size: 10px; color: #a1a1aa; font-weight: 600;">#</span>
        <span style="flex: 1; font-size: 10px; color: #a1a1aa; font-weight: 600;">RESTAURANT</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 36px; text-align: center;">GRADE</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 55px; text-align: right;">SALES</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 48px; text-align: right;">VAR</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 44px; text-align: right;">SPEED</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 44px; text-align: right;">OSAT</span>
      </div>
      ${top3.map((r, i) => `
        <div style="display: flex; align-items: center; padding: 8px 0; ${i < top3.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
          <span style="width: 20px; font-size: 12px; color: #a1a1aa; font-weight: 600;">${i + 1}</span>
          <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.id}" style="flex: 1; font-size: 13px; font-weight: 500; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.name}</a>
          <span style="font-size: 13px; font-weight: 700; color: ${getGradeColor(r.gradeLabel)}; width: 36px; text-align: center;">${r.gradeLabel}</span>
          <span style="font-size: 12px; font-weight: 500; width: 55px; text-align: right; color: ${r.variance >= 0 ? '#16a34a' : '#dc2626'};">${formatCurrency(r.sales)}</span>
          <span style="font-size: 12px; width: 48px; text-align: right; color: ${r.variance >= 0 ? '#16a34a' : '#dc2626'};">${r.variance >= 0 ? '+' : ''}${r.variance.toFixed(1)}%</span>
          ${r.avgSpeed !== null ? `<span style="font-size: 12px; width: 44px; text-align: right; color: ${r.avgSpeed >= 70 ? '#16a34a' : r.avgSpeed >= 50 ? '#d97706' : '#dc2626'};">${r.avgSpeed}%</span>` : '<span style="font-size: 12px; width: 44px; text-align: right; color: #a1a1aa;">--</span>'}
          ${r.osatPercent !== null ? `<span style="font-size: 12px; width: 44px; text-align: right; color: ${r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626'};">${Math.round(r.osatPercent)}%</span>` : '<span style="font-size: 12px; width: 44px; text-align: right; color: #a1a1aa;">--</span>'}
        </div>
      `).join("")}
    </div>

    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #dc2626;">Needs Attention</h3>
      <div style="display: flex; align-items: center; padding: 4px 0; border-bottom: 2px solid #e4e4e7;">
        <span style="width: 20px; font-size: 10px; color: #a1a1aa; font-weight: 600;">#</span>
        <span style="flex: 1; font-size: 10px; color: #a1a1aa; font-weight: 600;">RESTAURANT</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 36px; text-align: center;">GRADE</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 55px; text-align: right;">SALES</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 48px; text-align: right;">VAR</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 44px; text-align: right;">SPEED</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 44px; text-align: right;">OSAT</span>
      </div>
      ${bottom3.map((r, i) => `
        <div style="display: flex; align-items: center; padding: 8px 0; ${i < bottom3.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
          <span style="width: 20px; font-size: 12px; color: #a1a1aa; font-weight: 600;">${summaries.length - bottom3.length + i + 1}</span>
          <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.id}" style="flex: 1; font-size: 13px; font-weight: 500; color: inherit; text-decoration: none; border-bottom: 1px dashed #71717a;">${r.name}</a>
          <span style="font-size: 13px; font-weight: 700; color: ${getGradeColor(r.gradeLabel)}; width: 36px; text-align: center;">${r.gradeLabel}</span>
          <span style="font-size: 12px; font-weight: 500; width: 55px; text-align: right; color: ${r.variance >= 0 ? '#16a34a' : '#dc2626'};">${formatCurrency(r.sales)}</span>
          <span style="font-size: 12px; width: 48px; text-align: right; color: ${r.variance >= 0 ? '#16a34a' : '#dc2626'};">${r.variance >= 0 ? '+' : ''}${r.variance.toFixed(1)}%</span>
          ${r.avgSpeed !== null ? `<span style="font-size: 12px; width: 44px; text-align: right; color: ${r.avgSpeed >= 70 ? '#16a34a' : r.avgSpeed >= 50 ? '#d97706' : '#dc2626'};">${r.avgSpeed}%</span>` : '<span style="font-size: 12px; width: 44px; text-align: right; color: #a1a1aa;">--</span>'}
          ${r.osatPercent !== null ? `<span style="font-size: 12px; width: 44px; text-align: right; color: ${r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626'};">${Math.round(r.osatPercent)}%</span>` : '<span style="font-size: 12px; width: 44px; text-align: right; color: #a1a1aa;">--</span>'}
        </div>
      `).join("")}
    </div>

    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600;">All Restaurants</h3>
      <div style="display: flex; align-items: center; padding: 4px 0; border-bottom: 2px solid #e4e4e7;">
        <span style="width: 20px; font-size: 10px; color: #a1a1aa; font-weight: 600;">#</span>
        <span style="flex: 1; font-size: 10px; color: #a1a1aa; font-weight: 600;">RESTAURANT</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 28px; text-align: center;">GRD</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 50px; text-align: right;">SALES</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 48px; text-align: right;">VAR</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 40px; text-align: right;">SPEED</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 40px; text-align: right;">OSAT</span>
      </div>
      ${summaries.map((r, i) => `
        <div style="display: flex; align-items: center; padding: 6px 0; ${i < summaries.length - 1 ? 'border-bottom: 1px solid #fafafa;' : ''}">
          <span style="width: 20px; font-size: 11px; color: #a1a1aa;">${i + 1}</span>
          <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${r.id}" style="flex: 1; font-size: 12px; color: inherit; text-decoration: none; border-bottom: 1px dashed #a1a1aa;">${r.name}</a>
          <span style="font-size: 12px; font-weight: 600; color: ${getGradeColor(r.gradeLabel)}; width: 28px; text-align: center;">${r.gradeLabel}</span>
          <span style="font-size: 11px; font-weight: 500; width: 50px; text-align: right; color: ${r.variance >= 0 ? '#16a34a' : '#dc2626'};">${formatCurrency(r.sales)}</span>
          <span style="font-size: 11px; width: 48px; text-align: right; color: ${r.variance >= 0 ? '#16a34a' : '#dc2626'};">${r.variance >= 0 ? '+' : ''}${r.variance.toFixed(1)}%</span>
          ${r.avgSpeed !== null ? `<span style="font-size: 11px; width: 40px; text-align: right; color: ${r.avgSpeed >= 70 ? '#16a34a' : r.avgSpeed >= 50 ? '#d97706' : '#dc2626'};">${r.avgSpeed}%</span>` : '<span style="font-size: 11px; width: 40px; text-align: right; color: #a1a1aa;">--</span>'}
          ${r.osatPercent !== null ? `<span style="font-size: 11px; width: 40px; text-align: right; color: ${r.osatPercent >= 85 ? '#16a34a' : r.osatPercent >= 80 ? '#d97706' : '#dc2626'};">${Math.round(r.osatPercent)}%</span>` : '<span style="font-size: 11px; width: 40px; text-align: right; color: #a1a1aa;">--</span>'}
        </div>
      `).join("")}
    </div>

    <div style="background: white; padding: 16px 24px; border: 1px solid #e4e4e7; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
      <a href="${baseUrl}" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">
        View Full Dashboard
      </a>
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 12px;">
        All figures reflect full day in Central Time
      </p>
    </div>
  </div>
</body>
</html>`;
  } catch (error) {
    console.error("[daily-report] Error building report HTML:", error);
    return null;
  }
}
