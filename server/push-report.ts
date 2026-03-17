import { getBaseUrl } from "./base-url";
import { db } from "./db";
import { emailSubscribers, emailSendLog, reportSchedules, restaurantNotes, restaurants, osatCategoryIssues } from "@shared/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import type { HourlySalesData } from "@shared/schema";
import { getTotalRequiredStaff } from "./labor-model";
import { computeHourlyScore, scoreToGradeLabel as sharedScoreToGradeLabel, getGradeColorHex, formatCurrency as sharedFormatCurrency, gradeToMidpoint as sharedGradeToMidpoint, computeDailyBonuses, countAttachmentCategoriesAtTarget } from "./lib/scoring";
import { getAttachmentRatesFromDetail } from "./xenial-webhook";
import type { GradingConfigData } from "@shared/schema";
import { getActiveGradingConfig } from "./routes/grading-config";
import { getHelperRewardsForDate } from "./routes/helper-rewards";

// ─── Wrappers that delegate to the shared scoring module ─────────────
function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean,
  hasValidStaffing: boolean,
  osatPercent: number | undefined,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
  gradingCfg?: GradingConfigData,
): { grade: string; score: number; hasGrade: boolean } {
  const result = computeHourlyScore({
    salesVariancePct,
    hasComparableSales,
    transactionVariancePct,
    hasComparableTransactions,
    speedAttainment,
    osatPercent,
    staffingDiff,
    hasValidStaffing,
  }, gradingCfg);
  return { grade: result.grade, score: result.score, hasGrade: result.hasGrade };
}

function scoreToGradeLabel(score: number): string {
  return sharedScoreToGradeLabel(score);
}

function getGradeColor(grade: string): string {
  return getGradeColorHex(grade);
}

function formatCurrency(amount: number): string {
  return sharedFormatCurrency(amount);
}

function formatHour(hour: number): string {
  if (hour === 0) return "12AM";
  if (hour === 12) return "12PM";
  if (hour < 12) return `${hour}AM`;
  return `${hour - 12}PM`;
}

// Daypart definitions (mirrored from client/src/lib/dayparts.ts)
const DAYPARTS = [
  { id: 'earlybird',     label: 'Earlybird',      shortLabel: 'EB',  startHour: 0,  endHour: 5 },
  { id: 'breakfast',     label: 'Breakfast',       shortLabel: 'BRK', startHour: 6,  endHour: 10 },
  { id: 'lunch',         label: 'Lunch',           shortLabel: 'LCH', startHour: 11, endHour: 14 },
  { id: 'snack',         label: 'Snack',           shortLabel: 'SNK', startHour: 15, endHour: 16 },
  { id: 'evening',       label: 'Evening',         shortLabel: 'EVE', startHour: 17, endHour: 19 },
  { id: 'evening_snack', label: 'Evening Snack',   shortLabel: 'ES',  startHour: 20, endHour: 23 },
];

// OSAT category display names
const OSAT_CATEGORY_NAMES: Record<string, string> = {
  orderAccuracy: 'Order Accuracy',
  foodQuality: 'Food Quality',
  menuOptions: 'Menu Options',
  value: 'Value',
  easeOfOrdering: 'Ease of Ordering',
  employeeFriendliness: 'Employee Friendliness',
  speedOfService: 'Speed of Service',
  cleanliness: 'Cleanliness',
  driveThruWaitTime: 'Drive-Thru Wait Time',
};

function gradeToMidpoint(grade: string): number {
  return sharedGradeToMidpoint(grade);
}

export async function buildUnitReportHtml(dateStr: string, restaurantId: string): Promise<string | null> {
  try {
    const parts = dateStr.split('-');
    const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);

    const gradingCfg = await getActiveGradingConfig();
    const leaderboard = await storage.getLeaderboard(targetDate);
    const hourlyDataByRestaurant = await storage.getHourlyDataByRestaurant(targetDate);

    const restaurant = leaderboard.restaurants.find(r => r.restaurantId === restaurantId);
    if (!restaurant) return null;

    const hourlyData: HourlySalesData[] = hourlyDataByRestaurant[restaurantId] || [];
    const completedHours = hourlyData.filter(h => h.hour <= 23 && h.todaySales > 0);

    // Fetch attachment rates for The Closer bonus
    let attachCatsAtTarget: number | undefined;
    try {
      const attachMap = await getAttachmentRatesFromDetail(targetDate);
      const attachData = attachMap.get(restaurantId);
      if (attachData) attachCatsAtTarget = countAttachmentCategoriesAtTarget(attachData.categories);
    } catch (e) { /* POS data may not be available */ }

    // Fetch helper rewards for this date
    const helperRewardsMap = await getHelperRewardsForDate(dateStr);

    const sales = restaurant.actualSales;
    const lastWeekSales = restaurant.actualLastWeekSales;
    const salesVariance = lastWeekSales > 0
      ? ((sales - lastWeekSales) / lastWeekSales) * 100
      : 0;

    // ─── Extract leaders per hour ────────────────────────────────────────
    const leadersByHour = new Map<number, { firstName: string; position: string }[]>();
    const allLeaders = new Map<string, { firstName: string; position: string; hours: number[] }>();

    for (const hour of hourlyData) {
      const leaders = hour.leaders as { firstName: string; position: string }[] | undefined;
      if (leaders && leaders.length > 0) {
        leadersByHour.set(hour.hour, leaders);
        for (const l of leaders) {
          const key = l.firstName;
          if (!allLeaders.has(key)) {
            allLeaders.set(key, { firstName: l.firstName, position: l.position, hours: [] });
          }
          allLeaders.get(key)!.hours.push(hour.hour);
        }
      }
    }

    // ─── Calculate hourly grades & details ───────────────────────────────
    const hourlyGradeScores: number[] = [];
    const hourlyDetails: {
      hour: number;
      sales: number;
      lastWeekSales: number;
      variance: number;
      grade: string;
      score: number;
      employeeCount: number;
      speedAttainment: number | undefined;
      osatPercent: number | undefined;
      osatResponses: number | undefined;
      staffingDiff: number;
      leaders: string[];
    }[] = [];

    for (const hour of completedHours) {
      const hasComparableSales = hour.lastWeekSales > 0;
      const hourVariance = hasComparableSales
        ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100
        : 0;

      const positions = hour.positionBreakdown || {};
      const operatorHrs = positions['_operatorScheduled'] || 0;
      const rawEmployeeCount = Number(hour.employeeCount) || 0;
      const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
      const requiredStaff = getTotalRequiredStaff(hour.hour, hour.todaySales);
      const staffingDiff = actualStaff - requiredStaff;
      const hasValidStaffing = rawEmployeeCount >= 1;

      const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
      const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
      const gradeInfo = getExecutionGrade(
        hourVariance,
        hour.ootActive ? undefined : hour.speedAttainment,
        staffingDiff,
        hasComparableSales,
        hasValidStaffing,
        hour.osatPercent,
        txnVar,
        hasCompTxn,
        gradingCfg
      );

      if (gradeInfo.hasGrade) {
        hourlyGradeScores.push(gradeInfo.score);
      }

      const hourLeaders = leadersByHour.get(hour.hour) || [];
      hourlyDetails.push({
        hour: hour.hour,
        sales: hour.todaySales,
        lastWeekSales: hour.lastWeekSales,
        variance: hourVariance,
        grade: gradeInfo.hasGrade ? gradeInfo.grade : '-',
        score: gradeInfo.score,
        employeeCount: actualStaff,
        speedAttainment: hour.speedAttainment,
        osatPercent: hour.osatPercent,
        osatResponses: hour.osatResponses,
        staffingDiff,
        leaders: hourLeaders.map(l => l.firstName),
      });
    }

    const validScores = hourlyGradeScores.filter(s => s > 0);
    const baseScore = validScores.length > 0
      ? validScores.reduce((a, b) => a + b, 0) / validScores.length
      : 0;

    // Compute daily bonus points (same logic as dashboard + trends)
    const beDailyTotalSales = completedHours.reduce((s, h) => s + h.todaySales, 0);
    const beDailyTotalLWSales = completedHours.reduce((s, h) => s + h.lastWeekSales, 0);
    const dailySalesVar = beDailyTotalLWSales > 0 ? ((beDailyTotalSales - beDailyTotalLWSales) / beDailyTotalLWSales) * 100 : undefined;
    const beDailyTotalTxn = completedHours.reduce((s, h) => s + (h.transactionCount || 0), 0);
    const beDailyTotalLWTxn = completedHours.reduce((s, h) => s + (h.lastWeekTransactionCount || 0), 0);
    const dailyTxnVar = beDailyTotalLWTxn > 0 ? ((beDailyTotalTxn - beDailyTotalLWTxn) / beDailyTotalLWTxn) * 100 : undefined;
    const osatHoursForBonus = completedHours.filter(h => h.osatPercent !== undefined && (h.osatResponses ?? 0) > 0);
    const dailyOsatResponses = osatHoursForBonus.reduce((s, h) => s + (h.osatResponses ?? 0), 0);
    const dailyOsatPct = dailyOsatResponses > 0 ? osatHoursForBonus.reduce((s, h) => s + (h.osatPercent ?? 0) * (h.osatResponses ?? 0), 0) / dailyOsatResponses : undefined;

    // YoY variance from historical_daily_sales (same value on every hour record)
    const lastYearDaily = completedHours[0]?.lastYearDailySales;
    const dailyYoySalesVar = lastYearDaily && lastYearDaily > 0
      ? ((beDailyTotalSales - lastYearDaily) / lastYearDaily) * 100
      : undefined;

    const bonusResult = baseScore > 0 ? computeDailyBonuses({
      dailyOsatPercent: dailyOsatPct,
      dailySurveyCount: dailyOsatResponses,
      dailySalesVariancePct: dailySalesVar,
      dailyTransactionVariancePct: dailyTxnVar,
      dailyYoySalesVariancePct: dailyYoySalesVar,
      attachmentCategoriesAtTarget: attachCatsAtTarget,
      hourlyScores: validScores,
      helperRewardPoints: helperRewardsMap.get(restaurantId),
    }) : { bonuses: [], totalBonus: 0, cappedBonus: 0 };

    const overallScore = baseScore > 0 ? Math.min(baseScore + bonusResult.cappedBonus, 100) : 0;
    const gradeLabel = validScores.length > 0 ? scoreToGradeLabel(overallScore) : '-';

    // ─── Daypart grades (use raw scores, not midpoints) ─────────────────
    const daypartGrades: { id: string; label: string; shortLabel: string; grade: string; score: number }[] = [];
    for (const dp of DAYPARTS) {
      const dpHours = hourlyDetails.filter(h => h.hour >= dp.startHour && h.hour <= dp.endHour && h.score > 0);
      if (dpHours.length > 0) {
        const scores = dpHours.map(h => h.score).filter(s => s > 0);
        if (scores.length > 0) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          daypartGrades.push({ id: dp.id, label: dp.label, shortLabel: dp.shortLabel, grade: scoreToGradeLabel(avg), score: avg });
        }
      }
    }

    // ─── Speed summary ───────────────────────────────────────────────────
    const speedData = hourlyData.reduce((acc, h) => {
      const sa = h.speedAttainment;
      if (sa !== undefined && sa >= 0) { acc.total += sa; acc.count++; }
      return acc;
    }, { total: 0, count: 0 });
    const avgSpeed = speedData.count > 0 ? Math.round(speedData.total / speedData.count) : null;

    // ─── OSAT summary ────────────────────────────────────────────────────
    const osatSummary = hourlyData.reduce((acc, h) => {
      const op = h.osatPercent;
      const or2 = h.osatResponses;
      if (op !== undefined && op >= 0 && or2 > 0) {
        acc.totalWeighted += op * or2;
        acc.totalResponses += or2;
      }
      return acc;
    }, { totalWeighted: 0, totalResponses: 0 });
    const avgOsat = osatSummary.totalResponses > 0 ? osatSummary.totalWeighted / osatSummary.totalResponses : null;

    // Per-hour OSAT detail
    const surveyHours = hourlyDetails
      .filter(h => h.osatPercent !== undefined && h.osatPercent >= 0 && h.osatResponses && h.osatResponses > 0)
      .map(h => ({ hour: h.hour, percent: h.osatPercent!, responses: h.osatResponses!, leaders: h.leaders }));

    // ─── OSAT Category Issues (from DB) ──────────────────────────────────
    let categoryIssues: { category: string; lowCount: number; totalCount: number; avgRating: number }[] = [];
    let categoryWins: { category: string; avgRating: number; totalCount: number }[] = [];
    try {
      const issues = await db.select().from(osatCategoryIssues)
        .where(and(
          eq(osatCategoryIssues.restaurantId, restaurantId),
          eq(osatCategoryIssues.date, dateStr)
        ));

      for (const [key, label] of Object.entries(OSAT_CATEGORY_NAMES)) {
        const ratings = issues.map(i => i[key as keyof typeof i]).filter((r): r is number => r !== null && r !== undefined) as number[];
        if (ratings.length > 0) {
          const lowCount = ratings.filter(r => r < 3).length;
          const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
          if (lowCount > 0 || avgRating < 3) {
            categoryIssues.push({ category: label, lowCount, totalCount: ratings.length, avgRating: Math.round(avgRating * 10) / 10 });
          }
          if (avgRating >= 4.5) {
            categoryWins.push({ category: label, avgRating: Math.round(avgRating * 10) / 10, totalCount: ratings.length });
          }
        }
      }
      categoryIssues.sort((a, b) => b.lowCount - a.lowCount || a.avgRating - b.avgRating);
      categoryWins.sort((a, b) => b.avgRating - a.avgRating);
    } catch {
      // osatCategoryIssues table might not exist yet
    }

    // ─── Drive-thru, weather, Google reviews ─────────────────────────────
    const driveThru = restaurant.driveThru;
    const weather = restaurant.weather;
    const googleReviews = restaurant.googleReviews;

    // ─── Fetch notes ─────────────────────────────────────────────────────
    let unitNotes: { note: string; hour: number | null; category: string }[] = [];
    try {
      const notes = await db.select().from(restaurantNotes)
        .where(and(eq(restaurantNotes.date, dateStr), eq(restaurantNotes.restaurantId, restaurantId)))
        .orderBy(desc(restaurantNotes.createdAt));
      unitNotes = notes.map(n => ({ note: n.note, hour: n.hour, category: n.category || 'general' }));
    } catch { /* Notes table might not exist */ }

    // ─── Strengths & concerns ────────────────────────────────────────────
    const strengths: string[] = [];
    const concerns: string[] = [];

    if (salesVariance >= 5) strengths.push(`Sales up ${salesVariance.toFixed(1)}% vs last week`);
    if (avgSpeed !== null && avgSpeed >= 70) strengths.push(`Strong drive-thru speed (${avgSpeed}% attainment)`);
    if (avgOsat !== null && avgOsat >= 85) strengths.push(`Excellent customer satisfaction (${avgOsat.toFixed(0)}% OSAT, ${osatSummary.totalResponses} surveys)`);
    if (categoryWins.length > 0) strengths.push(`Guest praise: ${categoryWins.map(w => `${w.category} (${w.avgRating}\u2605)`).join(', ')}`);

    if (salesVariance <= -10) concerns.push(`Sales down ${Math.abs(salesVariance).toFixed(1)}% vs last week`);
    if (avgSpeed !== null && avgSpeed < 50) concerns.push(`Low drive-thru speed (${avgSpeed}% attainment)`);
    if (avgOsat !== null && avgOsat < 80) concerns.push(`Low customer satisfaction (${avgOsat.toFixed(0)}% OSAT)`);

    // Staffing analysis
    let understaffedCount = 0;
    let overstaffedCount = 0;
    const staffingIssueHours: { hour: number; type: 'over' | 'under'; diff: number; leaders: string[] }[] = [];
    for (const h of hourlyDetails) {
      if (h.staffingDiff < -1) {
        understaffedCount++;
        staffingIssueHours.push({ hour: h.hour, type: 'under', diff: Math.abs(h.staffingDiff), leaders: h.leaders });
      } else if (h.staffingDiff > 1) {
        overstaffedCount++;
        staffingIssueHours.push({ hour: h.hour, type: 'over', diff: h.staffingDiff, leaders: h.leaders });
      }
    }
    if (understaffedCount === 0 && overstaffedCount === 0 && completedHours.length > 0) {
      strengths.push("Properly staffed throughout the day");
    }
    if (understaffedCount >= 2) {
      const hours = staffingIssueHours.filter(s => s.type === 'under').map(s => formatHour(s.hour)).join(', ');
      concerns.push(`Understaffed ${understaffedCount} hours (${hours})`);
    }
    if (overstaffedCount >= 2) {
      const hours = staffingIssueHours.filter(s => s.type === 'over').map(s => formatHour(s.hour)).join(', ');
      concerns.push(`Overstaffed ${overstaffedCount} hours (${hours})`);
    }

    // Speed issues by hour
    const speedIssueHours = hourlyDetails
      .filter(h => h.speedAttainment !== undefined && h.speedAttainment < 50)
      .map(h => ({ hour: h.hour, attainment: h.speedAttainment!, leaders: h.leaders }));
    if (speedIssueHours.length >= 1 && avgSpeed !== null && avgSpeed < 50) {
      // Already captured in general concerns above
    } else if (speedIssueHours.length >= 1 && (avgSpeed === null || avgSpeed >= 50)) {
      const worst = speedIssueHours.sort((a, b) => a.attainment - b.attainment)[0];
      concerns.push(`Speed below 50% at ${formatHour(worst.hour)} (${worst.attainment}%)${worst.leaders.length ? ' - ' + worst.leaders.join(', ') : ''}`);
    }

    // Sales outliers
    const salesOutliers = hourlyDetails
      .filter(h => h.lastWeekSales > 0 && Math.abs(h.variance) >= 20)
      .map(h => ({ hour: h.hour, variance: h.variance, type: h.variance >= 0 ? 'above' as const : 'below' as const, leaders: h.leaders }));

    // Category issue concerns
    if (categoryIssues.length > 0) {
      concerns.push(`Guest concerns: ${categoryIssues.map(c => `${c.category} (${c.avgRating}\u2605, ${c.lowCount} low)`).join(', ')}`);
    }

    // ─── Rank among all restaurants ──────────────────────────────────────
    const activeRestaurants = leaderboard.restaurants.filter(r => r.status !== 'training');
    const rank = activeRestaurants.findIndex(r => r.restaurantId === restaurantId) + 1;

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(new Date(`${dateStr}T12:00:00`));

    const baseUrl = getBaseUrl();

    // ─── Build the HTML ──────────────────────────────────────────────────
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${restaurant.restaurantName} - ${formattedDate}</title>
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .page-break { page-break-before: always; }
    }
    .section { background: white; border: 1px solid #e4e4e7; border-top: none; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; margin: 2px; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 20px;">

    <!-- ═══ HEADER ═══ -->
    <div style="background-color: #18181b; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 600;">${restaurant.restaurantName}</h1>
      <p style="margin: 8px 0 0; font-size: 14px; color: #a1a1aa;">Unit Performance Report</p>
      <p style="margin: 4px 0 0; font-size: 13px; color: #a1a1aa;">${dayOfWeek}, ${formattedDate}</p>
    </div>

    <!-- ═══ OVERALL GRADE & KPIs ═══ -->
    <div class="section" style="padding: 24px;">
      <div style="text-align: center; margin-bottom: 16px;">
        <div style="display: inline-block; width: 80px; height: 80px; line-height: 80px; border-radius: 50%; background-color: ${getGradeColor(gradeLabel)}15; border: 3px solid ${getGradeColor(gradeLabel)}; text-align: center;">
          <span style="font-size: 32px; font-weight: 700; color: ${getGradeColor(gradeLabel)};">${gradeLabel}</span>
        </div>
        <div style="font-size: 12px; color: #71717a; margin-top: 4px;">Execution Grade${rank > 0 ? ` (#${rank} of ${activeRestaurants.length})` : ''}</div>
      </div>

      <div style="display: flex; justify-content: space-around; text-align: center; flex-wrap: wrap; gap: 8px;">
        <div style="min-width: 80px;">
          <div style="font-size: 22px; font-weight: 700; color: ${salesVariance >= 0 ? '#16a34a' : '#dc2626'};">${formatCurrency(sales)}</div>
          <div style="font-size: 11px; color: #71717a;">Total Sales</div>
        </div>
        <div style="min-width: 60px;">
          <div style="font-size: 22px; font-weight: 700; color: ${salesVariance >= 0 ? '#16a34a' : '#dc2626'};">${salesVariance >= 0 ? '+' : ''}${salesVariance.toFixed(1)}%</div>
          <div style="font-size: 11px; color: #71717a;">vs Last Week</div>
        </div>
        ${avgSpeed !== null ? `
        <div style="min-width: 60px;">
          <div style="font-size: 22px; font-weight: 700; color: ${avgSpeed >= 70 ? '#16a34a' : avgSpeed >= 50 ? '#d97706' : '#dc2626'};">${avgSpeed}%</div>
          <div style="font-size: 11px; color: #71717a;">DT Speed</div>
        </div>` : ''}
        ${avgOsat !== null ? `
        <div style="min-width: 60px;">
          <div style="font-size: 22px; font-weight: 700; color: ${avgOsat >= 85 ? '#16a34a' : avgOsat >= 80 ? '#d97706' : '#dc2626'};">${Math.round(avgOsat)}%</div>
          <div style="font-size: 11px; color: #71717a;">OSAT (${osatSummary.totalResponses})</div>
        </div>` : ''}
      </div>
    </div>

    ${weather ? `
    <!-- Weather Context -->
    <div class="section" style="padding: 10px 24px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
      <span style="font-size: 12px; color: #71717a;">Weather:</span>
      <span style="font-size: 12px; font-weight: 500;">${Math.round(weather.temp)}\u00B0F${weather.highTemp ? ` (H: ${Math.round(weather.highTemp)}\u00B0 L: ${Math.round(weather.lowTemp!)}\u00B0)` : ''}</span>
      <span style="font-size: 12px; color: #71717a;">${weather.condition}</span>
      ${weather.humidity ? `<span style="font-size: 12px; color: #71717a;">\u2022 ${weather.humidity}% humidity</span>` : ''}
      ${googleReviews ? `<span style="font-size: 12px; color: #71717a; margin-left: auto;">\u2605 ${googleReviews.rating} (${googleReviews.reviewCount} reviews${googleReviews.newReviewsToday > 0 ? `, ${googleReviews.newReviewsToday} new` : ''})</span>` : ''}
    </div>` : ''}

    <!-- ═══ DAYPART GRADES ═══ -->
    ${daypartGrades.length > 0 ? `
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #3f3f46;">Daypart Performance</h3>
      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        ${daypartGrades.map(dp => `
          <div style="flex: 1; min-width: 70px; text-align: center; padding: 8px 4px; border-radius: 6px; background-color: ${getGradeColor(dp.grade)}10; border: 1px solid ${getGradeColor(dp.grade)}30;">
            <div style="font-size: 18px; font-weight: 700; color: ${getGradeColor(dp.grade)};">${dp.grade}</div>
            <div style="font-size: 10px; color: #71717a; margin-top: 2px;">${dp.shortLabel}</div>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <!-- ═══ LEADERS ON SHIFT ═══ -->
    ${allLeaders.size > 0 ? `
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #3f3f46;">Leaders On Shift</h3>
      <div style="display: flex; flex-direction: column; gap: 4px;">
        ${Array.from(allLeaders.values()).map(leader => {
          // Find what dayparts this leader covered
          const coveredDayparts = DAYPARTS
            .filter(dp => leader.hours.some(h => h >= dp.startHour && h <= dp.endHour))
            .map(dp => dp.shortLabel);
          // Find grades during this leader's hours
          const leaderHourDetails = hourlyDetails.filter(h => leader.hours.includes(h.hour) && h.grade !== '-');
          const leaderScores = leaderHourDetails.map(h => gradeToMidpoint(h.grade)).filter(s => s > 0);
          const leaderGrade = leaderScores.length > 0 ? scoreToGradeLabel(leaderScores.reduce((a, b) => a + b, 0) / leaderScores.length) : '-';
          const leaderGradeColor = leaderGrade !== '-' ? getGradeColor(leaderGrade) : '#a1a1aa';
          return `
          <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; background: #fafafa;">
            <span style="font-size: 12px; font-weight: 600; min-width: 80px;">${leader.firstName}</span>
            <span style="font-size: 10px; color: #71717a;">${leader.position}</span>
            <span style="font-size: 11px; font-weight: 600; color: ${leaderGradeColor}; margin-left: auto;">${leaderGrade}</span>
            <span style="font-size: 10px; color: #a1a1aa;">${coveredDayparts.join(', ')}</span>
            <span style="font-size: 10px; color: #a1a1aa;">${formatHour(Math.min(...leader.hours))}\u2013${formatHour(Math.max(...leader.hours))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- ═══ STRENGTHS & CONCERNS ═══ -->
    ${strengths.length > 0 || concerns.length > 0 ? `
    <div class="section" style="padding: 16px 24px;">
      ${strengths.length > 0 ? `
      <h3 style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #16a34a;">What Went Well</h3>
      ${strengths.map(s => `
        <div style="font-size: 12px; color: #374151; padding: 3px 0 3px 12px; border-left: 2px solid #16a34a; margin-bottom: 4px;">${s}</div>
      `).join('')}` : ''}
      ${concerns.length > 0 ? `
      <h3 style="margin: ${strengths.length > 0 ? '14px' : '0'} 0 6px; font-size: 13px; font-weight: 600; color: #dc2626;">Needs Attention</h3>
      ${concerns.map(c => `
        <div style="font-size: 12px; color: #374151; padding: 3px 0 3px 12px; border-left: 2px solid #dc2626; margin-bottom: 4px;">${c}</div>
      `).join('')}` : ''}
    </div>` : ''}

    <!-- ═══ GUEST EXPERIENCE (OSAT Detail) ═══ -->
    ${surveyHours.length > 0 ? `
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #3f3f46;">Guest Experience</h3>

      ${/* Per-hour survey results */''}
      <div style="margin-bottom: ${categoryIssues.length > 0 || categoryWins.length > 0 ? '12px' : '0'};">
        <div style="font-size: 11px; color: #71717a; margin-bottom: 4px;">Surveys by Hour (${osatSummary.totalResponses} total)</div>
        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
          ${surveyHours.map(sh => `
            <div class="pill" style="background-color: ${sh.percent >= 85 ? '#dcfce7' : sh.percent >= 80 ? '#fef9c3' : '#fecaca'}; color: ${sh.percent >= 85 ? '#166534' : sh.percent >= 80 ? '#854d0e' : '#991b1b'};">
              ${formatHour(sh.hour)}: ${sh.percent.toFixed(0)}% (${sh.responses})${sh.leaders.length ? ' \u2022 ' + sh.leaders[0] : ''}
            </div>
          `).join('')}
        </div>
      </div>

      ${categoryIssues.length > 0 ? `
      <div style="margin-bottom: ${categoryWins.length > 0 ? '10px' : '0'};">
        <div style="font-size: 11px; font-weight: 600; color: #dc2626; margin-bottom: 4px;">Areas Guests Flagged</div>
        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
          ${categoryIssues.map(ci => `
            <div class="pill" style="background-color: #fecaca; color: #991b1b;">
              ${ci.category}: ${ci.avgRating}\u2605 (${ci.lowCount}/${ci.totalCount} low)
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      ${categoryWins.length > 0 ? `
      <div>
        <div style="font-size: 11px; font-weight: 600; color: #16a34a; margin-bottom: 4px;">Guest Praise</div>
        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
          ${categoryWins.map(cw => `
            <div class="pill" style="background-color: #dcfce7; color: #166534;">
              ${cw.category}: ${cw.avgRating}\u2605
            </div>
          `).join('')}
        </div>
      </div>` : ''}
    </div>` : ''}

    ${driveThru ? `
    <!-- ═══ DRIVE-THRU DETAIL ═══ -->
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #3f3f46;">Drive-Thru Performance</h3>
      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <div style="text-align: center; flex: 1; min-width: 60px; padding: 8px; border-radius: 6px; background: #fafafa;">
          <div style="font-size: 18px; font-weight: 700;">${driveThru.carCount}</div>
          <div style="font-size: 10px; color: #71717a;">Cars</div>
        </div>
        <div style="text-align: center; flex: 1; min-width: 60px; padding: 8px; border-radius: 6px; background: #fafafa;">
          <div style="font-size: 18px; font-weight: 700;">${Math.floor(driveThru.avgTotalTime / 60)}:${String(Math.round(driveThru.avgTotalTime % 60)).padStart(2, '0')}</div>
          <div style="font-size: 10px; color: #71717a;">Avg Total</div>
        </div>
        <div style="text-align: center; flex: 1; min-width: 60px; padding: 8px; border-radius: 6px; background: #fafafa;">
          <div style="font-size: 18px; font-weight: 700;">${Math.floor(driveThru.avgServiceTime / 60)}:${String(Math.round(driveThru.avgServiceTime % 60)).padStart(2, '0')}</div>
          <div style="font-size: 10px; color: #71717a;">Avg SOS</div>
        </div>
        ${avgSpeed !== null ? `
        <div style="text-align: center; flex: 1; min-width: 60px; padding: 8px; border-radius: 6px; background: ${avgSpeed >= 70 ? '#dcfce7' : avgSpeed >= 50 ? '#fef9c3' : '#fecaca'};">
          <div style="font-size: 18px; font-weight: 700; color: ${avgSpeed >= 70 ? '#166534' : avgSpeed >= 50 ? '#854d0e' : '#991b1b'};">${avgSpeed}%</div>
          <div style="font-size: 10px; color: #71717a;">&lt;6 min</div>
        </div>` : ''}
      </div>
      ${speedIssueHours.length > 0 ? `
      <div style="margin-top: 8px;">
        <div style="font-size: 11px; color: #dc2626; font-weight: 500;">Slow hours: ${speedIssueHours.map(s => `${formatHour(s.hour)} (${s.attainment}%)${s.leaders.length ? ' - ' + s.leaders[0] : ''}`).join(' \u2022 ')}</div>
      </div>` : ''}
    </div>` : ''}

    <!-- ═══ SALES OUTLIERS (hours significantly above/below) ═══ -->
    ${salesOutliers.length > 0 ? `
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #3f3f46;">Hourly Sales Outliers</h3>
      <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        ${salesOutliers.slice(0, 8).map(o => `
          <div class="pill" style="background-color: ${o.type === 'above' ? '#dcfce7' : '#fecaca'}; color: ${o.type === 'above' ? '#166534' : '#991b1b'};">
            ${formatHour(o.hour)}: ${o.type === 'above' ? '+' : ''}${o.variance.toFixed(0)}%${o.leaders.length ? ' \u2022 ' + o.leaders[0] : ''}
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <!-- ═══ STAFFING VARIANCES ═══ -->
    ${staffingIssueHours.length > 0 ? `
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #3f3f46;">Staffing Variances</h3>
      <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        ${staffingIssueHours.map(s => `
          <div class="pill" style="background-color: ${s.type === 'over' ? '#dbeafe' : '#fed7aa'}; color: ${s.type === 'over' ? '#1e40af' : '#9a3412'};">
            ${formatHour(s.hour)}: ${s.type === 'over' ? '+' : '-'}${s.diff.toFixed(0)} ${s.type}${s.leaders.length ? ' \u2022 ' + s.leaders[0] : ''}
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <!-- ═══ HOURLY BREAKDOWN TABLE ═══ -->
    <div class="section" style="padding: 20px 24px;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600;">Hourly Detail</h3>
      <div style="display: flex; align-items: center; padding: 4px 0; border-bottom: 2px solid #e4e4e7;">
        <span style="width: 36px; font-size: 10px; color: #a1a1aa; font-weight: 600;">HOUR</span>
        <span style="width: 28px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: center;">GRD</span>
        <span style="flex: 1; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">SALES</span>
        <span style="width: 48px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">LW</span>
        <span style="width: 42px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">VAR</span>
        <span style="width: 32px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">CRW</span>
        <span style="width: 38px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">SPD</span>
        <span style="width: 38px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">OSAT</span>
        <span style="width: 56px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">LEADER</span>
      </div>
      ${hourlyDetails.map((h, i) => `
        <div style="display: flex; align-items: center; padding: 4px 0; ${i < hourlyDetails.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
          <span style="width: 36px; font-size: 10px; color: #71717a; font-weight: 500;">${formatHour(h.hour)}</span>
          <span style="width: 28px; font-size: 10px; font-weight: 600; color: ${getGradeColor(h.grade)}; text-align: center;">${h.grade}</span>
          <span style="flex: 1; font-size: 10px; font-weight: 500; text-align: right;">${formatCurrency(h.sales)}</span>
          <span style="width: 48px; font-size: 10px; color: #a1a1aa; text-align: right;">${formatCurrency(h.lastWeekSales)}</span>
          <span style="width: 42px; font-size: 10px; text-align: right; color: ${h.variance >= 0 ? '#16a34a' : '#dc2626'};">${h.variance >= 0 ? '+' : ''}${h.variance.toFixed(0)}%</span>
          <span style="width: 32px; font-size: 10px; text-align: right; color: #71717a;">${h.employeeCount > 0 ? h.employeeCount.toFixed(1) : '--'}</span>
          ${h.speedAttainment !== undefined ? `<span style="width: 38px; font-size: 10px; text-align: right; color: ${h.speedAttainment >= 70 ? '#16a34a' : h.speedAttainment >= 50 ? '#d97706' : '#dc2626'};">${Math.round(h.speedAttainment)}%</span>` : '<span style="width: 38px; font-size: 10px; text-align: right; color: #a1a1aa;">--</span>'}
          ${h.osatPercent !== undefined && h.osatPercent >= 0 ? `<span style="width: 38px; font-size: 10px; text-align: right; color: ${h.osatPercent >= 85 ? '#16a34a' : h.osatPercent >= 80 ? '#d97706' : '#dc2626'};">${Math.round(h.osatPercent)}%</span>` : '<span style="width: 38px; font-size: 10px; text-align: right; color: #a1a1aa;">--</span>'}
          <span style="width: 56px; font-size: 9px; text-align: right; color: #71717a; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${h.leaders.length > 0 ? h.leaders.join(', ') : '--'}</span>
        </div>
      `).join("")}

      <!-- Totals Row -->
      <div style="display: flex; align-items: center; padding: 6px 0; border-top: 2px solid #e4e4e7; margin-top: 2px;">
        <span style="width: 36px; font-size: 10px; font-weight: 600;">Total</span>
        <span style="width: 28px; font-size: 11px; font-weight: 700; color: ${getGradeColor(gradeLabel)}; text-align: center;">${gradeLabel}</span>
        <span style="flex: 1; font-size: 10px; font-weight: 600; text-align: right;">${formatCurrency(sales)}</span>
        <span style="width: 48px; font-size: 10px; font-weight: 500; color: #a1a1aa; text-align: right;">${formatCurrency(lastWeekSales)}</span>
        <span style="width: 42px; font-size: 10px; font-weight: 500; text-align: right; color: ${salesVariance >= 0 ? '#16a34a' : '#dc2626'};">${salesVariance >= 0 ? '+' : ''}${salesVariance.toFixed(1)}%</span>
        <span style="width: 32px;"></span>
        ${avgSpeed !== null ? `<span style="width: 38px; font-size: 10px; font-weight: 500; text-align: right; color: ${avgSpeed >= 70 ? '#16a34a' : avgSpeed >= 50 ? '#d97706' : '#dc2626'};">${avgSpeed}%</span>` : '<span style="width: 38px;"></span>'}
        ${avgOsat !== null ? `<span style="width: 38px; font-size: 10px; font-weight: 500; text-align: right; color: ${avgOsat >= 85 ? '#16a34a' : avgOsat >= 80 ? '#d97706' : '#dc2626'};">${Math.round(avgOsat)}%</span>` : '<span style="width: 38px;"></span>'}
        <span style="width: 56px;"></span>
      </div>
    </div>

    ${unitNotes.length > 0 ? `
    <!-- ═══ MANAGER NOTES ═══ -->
    <div class="section" style="padding: 16px 24px;">
      <h3 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #d97706;">Manager Notes (${unitNotes.length})</h3>
      ${unitNotes.map(n => `
        <div style="font-size: 11px; color: #52525b; padding-left: 8px; border-left: 2px solid #fbbf24; margin-bottom: 6px;">
          ${n.note}${n.hour !== null ? ` <span style="color: #d97706;">(${n.hour === 0 ? '12am' : n.hour < 12 ? n.hour + 'am' : n.hour === 12 ? '12pm' : (n.hour - 12) + 'pm'})</span>` : ''}${n.category !== 'general' ? ` <span style="color: #a1a1aa;">[${n.category}]</span>` : ''}
        </div>
      `).join('')}
    </div>` : ''}

    <!-- ═══ FOOTER ═══ -->
    <div class="section" style="padding: 16px 24px; border-radius: 0 0 8px 8px; text-align: center;">
      <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${restaurantId}" target="_top" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;" class="no-print">
        View in Dashboard
      </a>
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 12px;">
        MWB Daily Performance \u2022 ${dayOfWeek}, ${formattedDate} \u2022 Central Time
      </p>
      <p style="font-size: 11px; margin-top: 8px;">
        <a href="${baseUrl}/scoring" style="color: #2563eb; text-decoration: underline;">How is my score calculated?</a>
      </p>
    </div>
  </div>
</body>
</html>`;
  } catch (error) {
    console.error("[push-report] Error building unit report HTML:", error);
    return null;
  }
}

export async function sendPushReports(force = false): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
    // Check if automated sending is enabled
    if (!force) {
      const schedules = await db.select().from(reportSchedules)
        .where(eq(reportSchedules.reportType, 'push_report'));
      const schedule = schedules[0];
      if (schedule && !schedule.isEnabled) {
        console.log("[push-report] Automated sending is disabled - skipping");
        return result;
      }
    }

    const subscribers = await db.select()
      .from(emailSubscribers)
      .where(and(
        eq(emailSubscribers.isActive, true),
        sql`${emailSubscribers.reportTypes} @> ARRAY['push_report']`
      ));

    if (subscribers.length === 0) {
      console.log("[push-report] No active subscribers for push_report");
      return result;
    }

    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = centralFormatter.format(yesterday);

    const reportKey = `push-${yesterdayStr}`;
    const alreadySent = await db.select()
      .from(emailSendLog)
      .where(and(
        eq(emailSendLog.reportDate, reportKey),
        eq(emailSendLog.status, "sent")
      ));
    const sentEmails = new Set(alreadySent.map(s => s.email));

    const pendingSubscribers = subscribers.filter(s => !sentEmails.has(s.email));

    if (pendingSubscribers.length === 0) {
      console.log("[push-report] All push reports already sent for", yesterdayStr);
      return result;
    }

    // Get all active restaurants
    const allRestaurants = await db.select().from(restaurants)
      .where(eq(restaurants.isActive, true));

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(yesterday);
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(yesterday);

    // For each restaurant, build and send individual reports
    for (const rest of allRestaurants) {
      const reportHtml = await buildUnitReportHtml(yesterdayStr, rest.id);
      if (!reportHtml) continue;

      const subject = `${rest.name} - Performance Report - ${dayOfWeek}, ${formattedDate}`;

      for (const subscriber of pendingSubscribers) {
        // Check if this specific restaurant+subscriber combo was already sent
        const specificKey = `push-${yesterdayStr}-${rest.id}`;
        const alreadySentSpecific = await db.select()
          .from(emailSendLog)
          .where(and(
            eq(emailSendLog.reportDate, specificKey),
            eq(emailSendLog.email, subscriber.email),
            eq(emailSendLog.status, "sent")
          ));

        if (alreadySentSpecific.length > 0) continue;

        const sent = await sendDailyReportEmail(subscriber.email, subject, reportHtml);

        await db.insert(emailSendLog).values({
          reportDate: specificKey,
          email: subscriber.email,
          status: sent ? "sent" : "failed",
        });

        if (sent) {
          result.sent++;
        } else {
          result.failed++;
        }
      }
    }

    // Mark the overall push report as sent for dedup
    for (const subscriber of pendingSubscribers) {
      await db.insert(emailSendLog).values({
        reportDate: reportKey,
        email: subscriber.email,
        status: "sent",
      });
    }

    console.log(`[push-report] Sent ${result.sent} unit reports, ${result.failed} failed for ${yesterdayStr}`);
  } catch (error) {
    console.error("[push-report] Error sending push reports:", error);
  }

  return result;
}
