import { db } from "./db";
import { emailSubscribers, emailSendLog, reportSchedules, restaurantNotes } from "@shared/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import type { HourlySalesData } from "@shared/schema";
import { getTotalRequiredStaff } from "./labor-model";
import { computeHourlyScore, scoreToGradeLabel as sharedScoreToGradeLabel, getGradeColorHex, formatCurrency as sharedFormatCurrency, computeDailyBonuses } from "./lib/scoring";


function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean,
  hasValidStaffing: boolean,
  osatPercent: number | undefined,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
): { grade: string; score: number; hasGrade: boolean } {
  const result = computeHourlyScore({
    salesVariancePct,
    hasComparableSales,
    transactionVariancePct,
    hasComparableTransactions,
    speedAttainment,
    staffingDiff,
    hasValidStaffing,
    osatPercent,
  });
  return { grade: result.grade, score: result.score, hasGrade: result.hasGrade };
}

const scoreToGradeLabel = sharedScoreToGradeLabel;

const getGradeColor = getGradeColorHex;

const formatCurrency = sharedFormatCurrency;

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

        const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
        const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
        const gradeInfo = getExecutionGrade(
          salesVariancePct,
          (hour as any).speedAttainment,
          staffingDiff,
          hasComparableSales,
          hasValidStaffing,
          (hour as any).osatPercent,
          txnVar,
          hasCompTxn
        );

        if (gradeInfo.hasGrade) {
          hourlyGradeScores.push(gradeInfo.score);
        }
      }

      const validScores = hourlyGradeScores.filter(s => s > 0);
      const baseScore = validScores.length > 0
        ? validScores.reduce((a, b) => a + b, 0) / validScores.length
        : 0;

      // Compute daily bonus points (same logic as dashboard + trends)
      const completedHours = hourlyData.filter(h => h.todaySales && h.todaySales > 0);
      const dailyTotalSales = completedHours.reduce((s, h) => s + h.todaySales, 0);
      const dailyTotalLWSales = completedHours.reduce((s, h) => s + h.lastWeekSales, 0);
      const dailySalesVar = dailyTotalLWSales > 0 ? ((dailyTotalSales - dailyTotalLWSales) / dailyTotalLWSales) * 100 : undefined;
      const dailyTotalTxn = completedHours.reduce((s, h) => s + (h.transactionCount || 0), 0);
      const dailyTotalLWTxn = completedHours.reduce((s, h) => s + (h.lastWeekTransactionCount || 0), 0);
      const dailyTxnVar = dailyTotalLWTxn > 0 ? ((dailyTotalTxn - dailyTotalLWTxn) / dailyTotalLWTxn) * 100 : undefined;
      const osatHoursForBonus = completedHours.filter(h => (h as any).osatPercent !== undefined && ((h as any).osatResponses ?? 0) > 0);
      const dailyOsatResponses = osatHoursForBonus.reduce((s, h) => s + ((h as any).osatResponses ?? 0), 0);
      const dailyOsatPct = dailyOsatResponses > 0 ? osatHoursForBonus.reduce((s, h) => s + ((h as any).osatPercent ?? 0) * ((h as any).osatResponses ?? 0), 0) / dailyOsatResponses : undefined;

      const bonusResult = baseScore > 0 ? computeDailyBonuses({
        dailyOsatPercent: dailyOsatPct,
        dailySurveyCount: dailyOsatResponses,
        dailySalesVariancePct: dailySalesVar,
        dailyTransactionVariancePct: dailyTxnVar,
        hourlyScores: validScores,
      }) : { bonuses: [], totalBonus: 0, cappedBonus: 0 };

      const overallScore = baseScore > 0 ? Math.min(baseScore + bonusResult.cappedBonus, 100) : 0;
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
        if (op !== undefined && op >= 0) {
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

    // Fetch notes for this date
    let notesByRestaurant: Record<string, { note: string; hour: number | null; category: string }[]> = {};
    try {
      const notes = await db.select().from(restaurantNotes)
        .where(eq(restaurantNotes.date, dateStr))
        .orderBy(desc(restaurantNotes.createdAt));
      for (const n of notes) {
        if (!notesByRestaurant[n.restaurantId]) notesByRestaurant[n.restaurantId] = [];
        notesByRestaurant[n.restaurantId].push({ note: n.note, hour: n.hour, category: n.category || 'general' });
      }
    } catch (e) {
      // Table might not exist yet - that's fine
      console.log("[daily-report] Notes table not available:", (e as Error).message?.slice(0, 50));
    }

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

    ${(() => {
      const allNotes = Object.entries(notesByRestaurant);
      if (allNotes.length === 0) return '';
      const totalNoteCount = allNotes.reduce((s, [, n]) => s + n.length, 0);
      return `
    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #d97706;">Manager Notes (${totalNoteCount})</h3>
      ${allNotes.map(([restaurantId, notes]) => {
        const restaurantName = summaries.find(s => s.id === restaurantId)?.name || restaurantId;
        return `
        <div style="margin-bottom: 8px;">
          <div style="font-size: 12px; font-weight: 600; color: #18181b; margin-bottom: 2px;">${restaurantName}</div>
          ${notes.map(n => `
            <div style="font-size: 11px; color: #52525b; padding-left: 8px; border-left: 2px solid #fbbf24; margin-bottom: 4px;">
              ${n.note}${n.hour !== null ? ` <span style="color: #d97706;">(${n.hour < 12 ? n.hour + 'am' : n.hour === 12 ? '12pm' : (n.hour - 12) + 'pm'})</span>` : ''}${n.category !== 'general' ? ` <span style="color: #a1a1aa;">[${n.category}]</span>` : ''}
            </div>
          `).join('')}
        </div>`;
      }).join('')}
    </div>`;
    })()}

    <div style="background: white; padding: 16px 24px; border: 1px solid #e4e4e7; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
      <a href="${baseUrl}" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">
        View Full Dashboard
      </a>
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 12px;">
        All figures reflect full day in Central Time
      </p>
      <p style="font-size: 11px; margin-top: 8px;">
        <a href="${baseUrl}/scoring" style="color: #2563eb; text-decoration: underline;">How is my score calculated?</a>
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
