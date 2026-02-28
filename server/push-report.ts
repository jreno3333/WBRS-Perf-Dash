import { db } from "./db";
import { emailSubscribers, emailSendLog, reportSchedules, restaurantNotes, restaurants } from "@shared/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import type { HourlySalesData } from "@shared/schema";
import { getTotalRequiredStaff } from "./labor-model";

const GRADE_WEIGHTS = {
  sales: 35,
  speed: 25,
  osat: 25,
  staffing: 15,
};

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

function scoreToGradeLabel(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
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

function formatHour(hour: number): string {
  if (hour === 0) return "12AM";
  if (hour === 12) return "12PM";
  if (hour < 12) return `${hour}AM`;
  return `${hour - 12}PM`;
}

export async function buildUnitReportHtml(dateStr: string, restaurantId: string): Promise<string | null> {
  try {
    const parts = dateStr.split('-');
    const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);

    const leaderboard = await storage.getLeaderboard(targetDate);
    const hourlyDataByRestaurant = await storage.getHourlyDataByRestaurant(targetDate);

    const restaurant = leaderboard.restaurants.find(r => r.restaurantId === restaurantId);
    if (!restaurant) return null;

    const hourlyData: HourlySalesData[] = hourlyDataByRestaurant[restaurantId] || [];
    const completedHours = hourlyData.filter(h => h.hour <= 23 && h.todaySales > 0);

    const sales = restaurant.actualSales;
    const lastWeekSales = restaurant.actualLastWeekSales;
    const salesVariance = lastWeekSales > 0
      ? ((sales - lastWeekSales) / lastWeekSales) * 100
      : 0;

    const isFirstWeek = (restaurant.daysOpen !== undefined && restaurant.daysOpen < 7);

    // Calculate hourly grades
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
    }[] = [];

    for (const hour of completedHours) {
      const hasComparableSales = hour.lastWeekSales > 0;
      const hourVariance = hasComparableSales
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
        hourVariance,
        (hour as any).speedAttainment,
        staffingDiff,
        hasComparableSales,
        isFirstWeek,
        hasValidStaffing,
        (hour as any).osatPercent
      );

      if (gradeInfo.hasGrade) {
        hourlyGradeScores.push(gradeInfo.score);
      }

      hourlyDetails.push({
        hour: hour.hour,
        sales: hour.todaySales,
        lastWeekSales: hour.lastWeekSales,
        variance: hourVariance,
        grade: gradeInfo.hasGrade ? gradeInfo.grade : '-',
        score: gradeInfo.score,
        employeeCount: actualStaff,
        speedAttainment: (hour as any).speedAttainment,
        osatPercent: (hour as any).osatPercent,
      });
    }

    const validScores = hourlyGradeScores.filter(s => s > 0);
    const overallScore = validScores.length > 0
      ? validScores.reduce((a, b) => a + b, 0) / validScores.length
      : 0;
    const gradeLabel = validScores.length > 0 ? scoreToGradeLabel(overallScore) : '-';

    // Speed summary
    const speedData = hourlyData.reduce((acc, h) => {
      const sa = (h as any).speedAttainment;
      if (sa !== undefined && sa >= 0) {
        acc.total += sa;
        acc.count++;
      }
      return acc;
    }, { total: 0, count: 0 });
    const avgSpeed = speedData.count > 0 ? Math.round(speedData.total / speedData.count) : null;

    // OSAT summary
    const osatSummary = hourlyData.reduce((acc, h) => {
      const op = (h as any).osatPercent;
      const or = (h as any).osatResponses;
      if (op !== undefined && op > 0 && or > 0) {
        acc.totalWeighted += op * or;
        acc.totalResponses += or;
      }
      return acc;
    }, { totalWeighted: 0, totalResponses: 0 });
    const avgOsat = osatSummary.totalResponses > 0 ? osatSummary.totalWeighted / osatSummary.totalResponses : null;

    // Drive-thru summary
    const driveThru = restaurant.driveThru;

    // Weather
    const weather = restaurant.weather;

    // Fetch notes for this unit on this date
    let unitNotes: { note: string; hour: number | null; category: string }[] = [];
    try {
      const notes = await db.select().from(restaurantNotes)
        .where(and(
          eq(restaurantNotes.date, dateStr),
          eq(restaurantNotes.restaurantId, restaurantId)
        ))
        .orderBy(desc(restaurantNotes.createdAt));
      unitNotes = notes.map(n => ({ note: n.note, hour: n.hour, category: n.category || 'general' }));
    } catch (e) {
      // Notes table might not exist yet
    }

    // Compute strengths / concerns
    const strengths: string[] = [];
    const concerns: string[] = [];

    if (salesVariance >= 5) strengths.push(`Sales up ${salesVariance.toFixed(1)}% vs last week`);
    if (avgSpeed !== null && avgSpeed >= 70) strengths.push(`Strong drive-thru speed (${avgSpeed}% attainment)`);
    if (avgOsat !== null && avgOsat >= 85) strengths.push(`Excellent customer satisfaction (${avgOsat.toFixed(0)}% OSAT)`);

    if (salesVariance <= -10) concerns.push(`Sales down ${Math.abs(salesVariance).toFixed(1)}% vs last week`);
    if (avgSpeed !== null && avgSpeed < 50) concerns.push(`Low drive-thru speed (${avgSpeed}% attainment)`);
    if (avgOsat !== null && avgOsat < 80) concerns.push(`Low customer satisfaction (${avgOsat.toFixed(0)}% OSAT)`);

    // Staffing analysis
    let understaffedCount = 0;
    let overstaffedCount = 0;
    for (const hour of completedHours) {
      const positions = (hour as any).positionBreakdown || {};
      const operatorHrs = positions['_operatorScheduled'] || 0;
      const rawEmployeeCount = Number(hour.employeeCount) || 0;
      const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
      const requiredStaff = getTotalRequiredStaff(hour.hour, hour.todaySales);
      const diff = actualStaff - requiredStaff;
      if (diff < -1) understaffedCount++;
      else if (diff > 1) overstaffedCount++;
    }

    if (understaffedCount === 0 && overstaffedCount === 0 && completedHours.length > 0) {
      strengths.push("Properly staffed throughout the day");
    }
    if (understaffedCount >= 2) concerns.push(`Understaffed ${understaffedCount} hours`);
    if (overstaffedCount >= 2) concerns.push(`Overstaffed ${overstaffedCount} hours`);

    // Rank among all restaurants
    const activeRestaurants = leaderboard.restaurants.filter(r => r.status !== 'training');
    const sortedByGrade = [...activeRestaurants].sort((a, b) => {
      // Use same grade calc for ranking
      return 0; // We'll use leaderboard order
    });
    const rank = activeRestaurants.findIndex(r => r.restaurantId === restaurantId) + 1;

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
  <title>${restaurant.restaurantName} - ${formattedDate}</title>
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <div style="background-color: #18181b; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 600;">${restaurant.restaurantName}</h1>
      <p style="margin: 8px 0 0; font-size: 14px; color: #a1a1aa;">Unit Performance Report</p>
      <p style="margin: 4px 0 0; font-size: 13px; color: #a1a1aa;">${dayOfWeek}, ${formattedDate}</p>
    </div>

    <!-- Overall Grade & KPIs -->
    <div style="background: white; padding: 24px; border: 1px solid #e4e4e7; border-top: none;">
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
    <div style="background: white; padding: 12px 24px; border: 1px solid #e4e4e7; border-top: none; display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 12px; color: #71717a;">Weather:</span>
      <span style="font-size: 12px; font-weight: 500;">${Math.round(weather.temp)}\u00B0F${weather.highTemp ? ` (H: ${Math.round(weather.highTemp)}\u00B0 L: ${Math.round(weather.lowTemp!)}\u00B0)` : ''}</span>
      <span style="font-size: 12px; color: #71717a;">${weather.condition}</span>
      ${weather.humidity ? `<span style="font-size: 12px; color: #71717a;">\u2022 ${weather.humidity}% humidity</span>` : ''}
    </div>` : ''}

    ${driveThru ? `
    <!-- Drive-Thru Summary -->
    <div style="background: white; padding: 12px 24px; border: 1px solid #e4e4e7; border-top: none; display: flex; align-items: center; gap: 16px;">
      <span style="font-size: 12px; color: #71717a;">Drive-Thru:</span>
      <span style="font-size: 12px; font-weight: 500;">${driveThru.carCount} cars</span>
      <span style="font-size: 12px; color: #71717a;">Avg Total: ${Math.floor(driveThru.avgTotalTime / 60)}:${String(driveThru.avgTotalTime % 60).padStart(2, '0')}</span>
      <span style="font-size: 12px; color: #71717a;">Avg SOS: ${Math.floor(driveThru.avgServiceTime / 60)}:${String(driveThru.avgServiceTime % 60).padStart(2, '0')}</span>
    </div>` : ''}

    <!-- Strengths & Concerns -->
    ${strengths.length > 0 || concerns.length > 0 ? `
    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      ${strengths.length > 0 ? `
      <h3 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #16a34a;">Strengths</h3>
      ${strengths.map(s => `
        <div style="font-size: 12px; color: #374151; padding: 3px 0 3px 12px; border-left: 2px solid #16a34a; margin-bottom: 4px;">${s}</div>
      `).join('')}` : ''}
      ${concerns.length > 0 ? `
      <h3 style="margin: ${strengths.length > 0 ? '12px' : '0'} 0 8px; font-size: 13px; font-weight: 600; color: #dc2626;">Needs Attention</h3>
      ${concerns.map(c => `
        <div style="font-size: 12px; color: #374151; padding: 3px 0 3px 12px; border-left: 2px solid #dc2626; margin-bottom: 4px;">${c}</div>
      `).join('')}` : ''}
    </div>` : ''}

    <!-- Hourly Breakdown -->
    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600;">Hourly Breakdown</h3>
      <div style="display: flex; align-items: center; padding: 4px 0; border-bottom: 2px solid #e4e4e7;">
        <span style="width: 40px; font-size: 10px; color: #a1a1aa; font-weight: 600;">HOUR</span>
        <span style="width: 32px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: center;">GRD</span>
        <span style="flex: 1; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">SALES</span>
        <span style="width: 50px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">LW</span>
        <span style="width: 48px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">VAR</span>
        <span style="width: 36px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">CREW</span>
        <span style="width: 42px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">SPEED</span>
        <span style="width: 42px; font-size: 10px; color: #a1a1aa; font-weight: 600; text-align: right;">OSAT</span>
      </div>
      ${hourlyDetails.map((h, i) => `
        <div style="display: flex; align-items: center; padding: 5px 0; ${i < hourlyDetails.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
          <span style="width: 40px; font-size: 11px; color: #71717a; font-weight: 500;">${formatHour(h.hour)}</span>
          <span style="width: 32px; font-size: 11px; font-weight: 600; color: ${getGradeColor(h.grade)}; text-align: center;">${h.grade}</span>
          <span style="flex: 1; font-size: 11px; font-weight: 500; text-align: right;">${formatCurrency(h.sales)}</span>
          <span style="width: 50px; font-size: 11px; color: #a1a1aa; text-align: right;">${formatCurrency(h.lastWeekSales)}</span>
          <span style="width: 48px; font-size: 11px; text-align: right; color: ${h.variance >= 0 ? '#16a34a' : '#dc2626'};">${h.variance >= 0 ? '+' : ''}${h.variance.toFixed(0)}%</span>
          <span style="width: 36px; font-size: 11px; text-align: right; color: #71717a;">${h.employeeCount > 0 ? h.employeeCount.toFixed(1) : '--'}</span>
          ${h.speedAttainment !== undefined ? `<span style="width: 42px; font-size: 11px; text-align: right; color: ${h.speedAttainment >= 70 ? '#16a34a' : h.speedAttainment >= 50 ? '#d97706' : '#dc2626'};">${Math.round(h.speedAttainment)}%</span>` : '<span style="width: 42px; font-size: 11px; text-align: right; color: #a1a1aa;">--</span>'}
          ${h.osatPercent !== undefined && h.osatPercent > 0 ? `<span style="width: 42px; font-size: 11px; text-align: right; color: ${h.osatPercent >= 85 ? '#16a34a' : h.osatPercent >= 80 ? '#d97706' : '#dc2626'};">${Math.round(h.osatPercent)}%</span>` : '<span style="width: 42px; font-size: 11px; text-align: right; color: #a1a1aa;">--</span>'}
        </div>
      `).join("")}

      <!-- Totals Row -->
      <div style="display: flex; align-items: center; padding: 6px 0; border-top: 2px solid #e4e4e7; margin-top: 2px;">
        <span style="width: 40px; font-size: 11px; font-weight: 600;">Total</span>
        <span style="width: 32px; font-size: 12px; font-weight: 700; color: ${getGradeColor(gradeLabel)}; text-align: center;">${gradeLabel}</span>
        <span style="flex: 1; font-size: 11px; font-weight: 600; text-align: right;">${formatCurrency(sales)}</span>
        <span style="width: 50px; font-size: 11px; font-weight: 500; color: #a1a1aa; text-align: right;">${formatCurrency(lastWeekSales)}</span>
        <span style="width: 48px; font-size: 11px; font-weight: 500; text-align: right; color: ${salesVariance >= 0 ? '#16a34a' : '#dc2626'};">${salesVariance >= 0 ? '+' : ''}${salesVariance.toFixed(1)}%</span>
        <span style="width: 36px;"></span>
        ${avgSpeed !== null ? `<span style="width: 42px; font-size: 11px; font-weight: 500; text-align: right; color: ${avgSpeed >= 70 ? '#16a34a' : avgSpeed >= 50 ? '#d97706' : '#dc2626'};">${avgSpeed}%</span>` : '<span style="width: 42px;"></span>'}
        ${avgOsat !== null ? `<span style="width: 42px; font-size: 11px; font-weight: 500; text-align: right; color: ${avgOsat >= 85 ? '#16a34a' : avgOsat >= 80 ? '#d97706' : '#dc2626'};">${Math.round(avgOsat)}%</span>` : '<span style="width: 42px;"></span>'}
      </div>
    </div>

    ${unitNotes.length > 0 ? `
    <!-- Manager Notes -->
    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #d97706;">Manager Notes (${unitNotes.length})</h3>
      ${unitNotes.map(n => `
        <div style="font-size: 11px; color: #52525b; padding-left: 8px; border-left: 2px solid #fbbf24; margin-bottom: 6px;">
          ${n.note}${n.hour !== null ? ` <span style="color: #d97706;">(${n.hour < 12 ? n.hour + 'am' : n.hour === 12 ? '12pm' : (n.hour - 12) + 'pm'})</span>` : ''}${n.category !== 'general' ? ` <span style="color: #a1a1aa;">[${n.category}]</span>` : ''}
        </div>
      `).join('')}
    </div>` : ''}

    <!-- Footer -->
    <div style="background: white; padding: 16px 24px; border: 1px solid #e4e4e7; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
      <a href="${baseUrl}/dashboard-view?date=${dateStr}&unit=${restaurantId}" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;" class="no-print">
        View in Dashboard
      </a>
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 12px;">
        MWB Daily Performance \u2022 ${dayOfWeek}, ${formattedDate} \u2022 Central Time
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
