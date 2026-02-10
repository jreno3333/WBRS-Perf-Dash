import { db } from "./db";
import { emailSubscribers, emailSendLog, dailySales, hourlySales, restaurants, hmeTimerData, dailyOsat } from "@shared/schema";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { storage } from "./storage";
import { getAllHourlyPosSales } from "./xenial-webhook";

function getGradeLabel(score: number): string {
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

function formatTime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
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
}

export async function sendDailyReports(): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
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
    const todayStr = centralFormatter.format(now);

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
    const allRestaurants = await storage.getRestaurants();
    const activeRestaurants = allRestaurants.filter(r => {
      if (!r.isActive) return false;
      if (r.name.includes("Training")) return false;
      return true;
    });

    if (activeRestaurants.length === 0) return null;

    const targetDate = new Date(`${dateStr}T12:00:00`);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const lastWeekDate = new Date(targetDate);
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const lastWeekStr = lastWeekDate.toISOString().split("T")[0];

    const lastWeekStartOfDay = new Date(lastWeekDate);
    lastWeekStartOfDay.setHours(0, 0, 0, 0);
    const lastWeekEndOfDay = new Date(lastWeekDate);
    lastWeekEndOfDay.setHours(23, 59, 59, 999);

    const posHourlySales = await getAllHourlyPosSales(targetDate);
    const posLastWeekHourlySales = await getAllHourlyPosSales(lastWeekDate);

    const allHourlySales = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, lastWeekStartOfDay),
        lte(hourlySales.salesDate, endOfDay)
      )
    );

    const selectedDateHourly = allHourlySales.filter(s => {
      const d = new Date(s.salesDate).toISOString().split("T")[0];
      return d === dateStr;
    });
    const lastWeekHourly = allHourlySales.filter(s => {
      const d = new Date(s.salesDate).toISOString().split("T")[0];
      return d === lastWeekStr;
    });

    const allDailySales = await db.select().from(dailySales).where(
      and(
        gte(dailySales.salesDate, lastWeekStartOfDay),
        lte(dailySales.salesDate, endOfDay)
      )
    );
    const dailySalesByRestaurant = new Map<string, number>();
    const dailySalesLastWeekByRestaurant = new Map<string, number>();
    allDailySales.forEach(d => {
      const saleDate = new Date(d.salesDate).toISOString().split("T")[0];
      if (saleDate === dateStr) {
        dailySalesByRestaurant.set(d.restaurantId, parseFloat(d.totalSales || '0') / 100);
      }
      if (saleDate === lastWeekStr) {
        dailySalesLastWeekByRestaurant.set(d.restaurantId, parseFloat(d.totalSales || '0') / 100);
      }
    });

    const osatData = await db.select()
      .from(dailyOsat)
      .where(eq(dailyOsat.date, dateStr));

    const hmeData = await db.select()
      .from(hmeTimerData)
      .where(eq(hmeTimerData.date, dateStr));

    const osatByRestaurant = new Map(osatData.map(o => [o.restaurantId, o]));

    const hmeByRestaurant = new Map<string, { totalTime: number; count: number; carsUnder6Min: number }>();
    hmeData.forEach(h => {
      const rid = h.restaurantId;
      if (!hmeByRestaurant.has(rid)) {
        hmeByRestaurant.set(rid, { totalTime: 0, count: 0, carsUnder6Min: 0 });
      }
      const entry = hmeByRestaurant.get(rid)!;
      if (h.avgTotalTime) {
        entry.totalTime += Number(h.avgTotalTime) * (h.carCount || 1);
        entry.count += h.carCount || 1;
      }
      entry.carsUnder6Min += h.carsUnder6Min || 0;
    });

    const summaries: RestaurantSummary[] = [];
    let totalSales = 0;
    let totalLastWeek = 0;

    for (const restaurant of activeRestaurants) {
      const osat = osatByRestaurant.get(restaurant.id);
      const hme = hmeByRestaurant.get(restaurant.id);

      let todaySalesAmount = 0;
      const posData = posHourlySales.get(restaurant.id);
      if (posData && posData.size > 0) {
        posData.forEach((sales) => { todaySalesAmount += sales; });
      } else {
        const hourlyForRestaurant = selectedDateHourly.filter(s => s.restaurantId === restaurant.id);
        if (hourlyForRestaurant.length > 0) {
          todaySalesAmount = hourlyForRestaurant.reduce((sum, s) => sum + parseFloat(s.actualSales || '0'), 0);
        } else {
          todaySalesAmount = dailySalesByRestaurant.get(restaurant.id) || 0;
        }
      }

      let lastWeekSalesAmount = 0;
      const posLastWeekData = posLastWeekHourlySales.get(restaurant.id);
      if (posLastWeekData && posLastWeekData.size > 0) {
        posLastWeekData.forEach((sales) => { lastWeekSalesAmount += sales; });
      } else {
        const hourlyLastWeekForRestaurant = lastWeekHourly.filter(s => s.restaurantId === restaurant.id);
        if (hourlyLastWeekForRestaurant.length > 0) {
          lastWeekSalesAmount = hourlyLastWeekForRestaurant.reduce((sum, s) => sum + parseFloat(s.actualSales || '0'), 0);
        } else {
          lastWeekSalesAmount = dailySalesLastWeekByRestaurant.get(restaurant.id) || 0;
        }
      }

      if (todaySalesAmount === 0 && lastWeekSalesAmount === 0) continue;

      const variance = lastWeekSalesAmount > 0
        ? ((todaySalesAmount - lastWeekSalesAmount) / lastWeekSalesAmount) * 100
        : 0;

      let grade = 0;
      let components = 0;
      let totalWeight = 0;

      const salesScore = variance >= -5 ? 100 : 50;
      grade += salesScore * 35;
      totalWeight += 35;
      components++;

      if (hme && hme.count > 0) {
        const attainment = Math.round((hme.carsUnder6Min / hme.count) * 100);
        const speedScore = attainment >= 70 ? 100 : attainment >= 50 ? 70 : 40;
        grade += speedScore * 25;
        totalWeight += 25;
        components++;
      }

      if (osat && osat.totalResponses > 0) {
        const osatPct = (osat.fiveStarCount / osat.totalResponses) * 100;
        const osatScore = osatPct >= 85 ? 100 : osatPct >= 80 ? 70 : 40;
        grade += osatScore * 25;
        totalWeight += 25;
        components++;
      }

      const normalizedGrade = totalWeight > 0 ? grade / totalWeight : 50;

      totalSales += todaySalesAmount;
      totalLastWeek += lastWeekSalesAmount;

      summaries.push({
        id: restaurant.id,
        name: restaurant.name,
        sales: todaySalesAmount,
        lastWeekSales: lastWeekSalesAmount,
        variance,
        grade: normalizedGrade,
        gradeLabel: getGradeLabel(normalizedGrade),
        avgSpeed: hme && hme.count > 0 ? Math.round((hme.carsUnder6Min / hme.count) * 100) : null,
        osatPercent: osat && osat.totalResponses > 0 ? (osat.fiveStarCount / osat.totalResponses) * 100 : null,
      });
    }

    if (summaries.length === 0) return null;

    summaries.sort((a, b) => b.grade - a.grade);

    const avgGrade = summaries.reduce((s, r) => s + r.grade, 0) / summaries.length;
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
          <div style="font-size: 28px; font-weight: 700; color: ${getGradeColor(getGradeLabel(avgGrade))};">${getGradeLabel(avgGrade)}</div>
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
