import { db } from "./db";
import { emailSubscribers, emailSendLog, restaurants, hourlyCrew, hourlyLabor, hourlySales, hmeTimerData, employees } from "@shared/schema";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { sendDailyReportEmail } from "./email";
import { osatData as osatDataTable } from "@shared/schema";

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
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}k`;
  }
  return `$${Math.round(amount)}`;
}

interface LeaderSummary {
  name: string;
  position: string;
  restaurantId: string;
  restaurantName: string;
  hoursWorked: number;
  avgGradeScore: number;
  grade: string;
  avgHourlySales: number | null;
  companyRank: number;
  totalLeaders: number;
}

const MIN_HOURS_REQUIRED = 8;

export async function sendLeaderReports(): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };

  try {
    const subscribers = await db.select()
      .from(emailSubscribers)
      .where(eq(emailSubscribers.isActive, true));

    if (subscribers.length === 0) {
      console.log("[leader-report] No active subscribers");
      return result;
    }

    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = centralFormatter.format(now);

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = centralFormatter.format(yesterday);

    const reportKey = `leader-${yesterdayStr}`;
    const alreadySent = await db.select()
      .from(emailSendLog)
      .where(and(
        eq(emailSendLog.reportDate, reportKey),
        eq(emailSendLog.status, "sent")
      ));
    const sentEmails = new Set(alreadySent.map(s => s.email));
    const pendingSubscribers = subscribers.filter(s => !sentEmails.has(s.email));

    if (pendingSubscribers.length === 0) {
      console.log("[leader-report] All leader reports already sent for", yesterdayStr);
      return result;
    }

    const reportHtml = await buildLeaderReportHtml(yesterdayStr);
    if (!reportHtml) {
      console.log("[leader-report] No data available for", yesterdayStr);
      return result;
    }

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(yesterday);
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(yesterday);

    const subject = `Leader Rankings Report - ${dayOfWeek}, ${formattedDate}`;

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

    console.log(`[leader-report] Sent ${result.sent} reports, ${result.failed} failed for ${yesterdayStr}`);
  } catch (error) {
    console.error("[leader-report] Error sending leader reports:", error);
  }

  return result;
}

export async function buildLeaderReportHtml(dateStr: string): Promise<string | null> {
  try {
    const endDate = new Date(`${dateStr}T23:59:59`);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);
    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = dateStr;

    const allRestaurants = await db.select().from(restaurants);
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    const leaderEmployees = await db.select().from(employees).where(
      inArray(employees.type, ["manager", "asst_manager"])
    );

    if (leaderEmployees.length === 0) return null;

    const crewData = await db.select().from(hourlyCrew).where(
      and(gte(hourlyCrew.date, startDateStr), lte(hourlyCrew.date, endDateStr))
    );

    const laborData = await db.select().from(hourlyLabor).where(
      and(
        sql`${hourlyLabor.date} >= ${startDateStr}`,
        sql`${hourlyLabor.date} <= ${endDateStr}`
      )
    );

    const extendedStartDate = new Date(startDate);
    extendedStartDate.setDate(extendedStartDate.getDate() - 7);
    const extendedStartDateStr = extendedStartDate.toISOString().split("T")[0];

    const salesData = await db.select().from(hourlySales).where(
      and(
        gte(sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`, extendedStartDateStr),
        sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${endDateStr}`
      )
    );

    const hmeData = await db.select().from(hmeTimerData).where(
      and(gte(hmeTimerData.date, startDateStr), lte(hmeTimerData.date, endDateStr))
    );

    const hourlyOsatData = await db.select().from(osatDataTable).where(
      and(gte(osatDataTable.date, startDateStr), lte(osatDataTable.date, endDateStr))
    );

    const laborByKey = new Map<string, typeof laborData[0]>();
    for (const l of laborData) laborByKey.set(`${l.restaurantId}-${l.date}-${l.hour}`, l);

    const salesByKey = new Map<string, typeof salesData[0]>();
    for (const s of salesData) {
      const d = s.salesDate.toISOString().split("T")[0];
      salesByKey.set(`${s.restaurantId}-${d}-${s.hour}`, s);
    }

    const hmeByKey = new Map<string, typeof hmeData[0]>();
    for (const h of hmeData) hmeByKey.set(`${h.restaurantId}-${h.date}-${h.hour}`, h);

    const osatByKey = new Map<string, typeof hourlyOsatData[0]>();
    for (const o of hourlyOsatData) osatByKey.set(`${o.restaurantId}-${o.date}-${o.hour}`, o);

    const leaders: LeaderSummary[] = [];

    for (const leader of leaderEmployees) {
      const userId = leader.sevenShiftsUserId;
      const dailyAggregates = new Map<string, {
        restaurantId: string;
        totalSalesToday: number;
        totalSalesLastWeek: number;
        staffingDiffs: number[];
        speedValues: number[];
        osatWeighted: { percent: number; responses: number }[];
        hoursCount: number;
      }>();
      const workedAtRestaurants = new Map<string, number>();
      let totalHoursWorked = 0;
      let totalSalesAllHours = 0;

      for (const crew of crewData) {
        const members = (crew.crewMembers as any[]) || [];
        const wasWorking = members.some(m => m.userId === userId);
        if (!wasWorking) continue;

        workedAtRestaurants.set(crew.restaurantId, (workedAtRestaurants.get(crew.restaurantId) || 0) + 1);

        const labor = laborByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
        const sales = salesByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
        const hme = hmeByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
        const osatHour = osatByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);

        if (labor && sales) {
          totalHoursWorked++;
          const hourSales = Number(sales.actualSales) || 0;
          totalSalesAllHours += hourSales;

          const dayKey = crew.date;
          if (!dailyAggregates.has(dayKey)) {
            dailyAggregates.set(dayKey, {
              restaurantId: crew.restaurantId,
              totalSalesToday: 0, totalSalesLastWeek: 0,
              staffingDiffs: [], speedValues: [], osatWeighted: [], hoursCount: 0,
            });
          }
          const day = dailyAggregates.get(dayKey)!;
          day.hoursCount++;
          day.totalSalesToday += hourSales;

          const crewDate = new Date(crew.date + "T12:00:00");
          const lastWeekDate = new Date(crewDate);
          lastWeekDate.setDate(lastWeekDate.getDate() - 7);
          const lastWeekDateStr = lastWeekDate.toISOString().split("T")[0];
          const lastWeekSalesRecord = salesByKey.get(`${crew.restaurantId}-${lastWeekDateStr}-${crew.hour}`);
          day.totalSalesLastWeek += lastWeekSalesRecord ? Number(lastWeekSalesRecord.actualSales) || 0 : 0;

          const actualStaff = Number(labor.employeeCount) || 0;
          const projectedStaff = (Number(labor.projectedLabor) || 0) / 10;
          day.staffingDiffs.push(actualStaff - projectedStaff);

          if (hme && hme.avgTotalTime && hme.avgTotalTime > 0) day.speedValues.push(hme.avgTotalTime);
          if (osatHour && osatHour.totalResponses > 0) {
            day.osatWeighted.push({ percent: Number(osatHour.osatPercent), responses: osatHour.totalResponses });
          }
        }
      }

      const dailyGrades: { score: number; hours: number }[] = [];
      for (const [, day] of Array.from(dailyAggregates)) {
        const hasComparableSales = day.totalSalesLastWeek > 0;
        const salesVariancePct = hasComparableSales
          ? ((day.totalSalesToday - day.totalSalesLastWeek) / day.totalSalesLastWeek) * 100 : 0;
        const avgStaffingDiff = day.staffingDiffs.reduce((a, b) => a + b, 0) / day.staffingDiffs.length;
        const avgSpeed = day.speedValues.length > 0 ? day.speedValues.reduce((a, b) => a + b, 0) / day.speedValues.length : undefined;
        const totalOsatResponses = day.osatWeighted.reduce((s, o) => s + o.responses, 0);
        const osatPercent = totalOsatResponses > 0
          ? day.osatWeighted.reduce((s, o) => s + o.percent * o.responses, 0) / totalOsatResponses : undefined;
        const salesSurge = salesVariancePct >= 20;

        const components: { weight: number; score: number }[] = [];
        if (hasComparableSales) components.push({ weight: 35, score: salesVariancePct >= -5 ? 100 : 50 });

        let staffingScore = 100;
        if (Math.abs(avgStaffingDiff) > 1) staffingScore = avgStaffingDiff > 1 ? 60 : (salesSurge ? 100 : 60);
        components.push({ weight: 15, score: staffingScore });

        if (avgSpeed !== undefined) {
          components.push({ weight: 25, score: avgSpeed > 420 ? 40 : avgSpeed > 300 ? 70 : 100 });
        }
        if (osatPercent !== undefined) {
          components.push({ weight: 25, score: osatPercent < 80 ? 40 : osatPercent < 85 ? 70 : 100 });
        }

        if (components.length > 0) {
          const totalWeight = components.reduce((s, c) => s + c.weight, 0);
          const score = components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
          dailyGrades.push({ score, hours: day.hoursCount });
        }
      }

      if (totalHoursWorked >= MIN_HOURS_REQUIRED && dailyGrades.length > 0) {
        const totalGradeHours = dailyGrades.reduce((s, d) => s + d.hours, 0);
        const avgScore = dailyGrades.reduce((s, d) => s + d.score * d.hours, 0) / totalGradeHours;

        let primaryRestaurantId = "";
        let maxHours = 0;
        workedAtRestaurants.forEach((hours, rid) => {
          if (hours > maxHours) { maxHours = hours; primaryRestaurantId = rid; }
        });

        const restaurantName = restaurantNameMap.get(primaryRestaurantId) || "";
        if (!primaryRestaurantId || !restaurantName) continue;

        let displayPosition = leader.position || "";
        if (!displayPosition) {
          if (leader.type === "asst_manager" || leader.type === "manager") displayPosition = "Manager";
          else displayPosition = "Leader";
        }
        if (displayPosition === "asst_manager") displayPosition = "Manager";
        if (displayPosition.toLowerCase().includes("supervisor")) displayPosition = "Shift Supervisor";
        else if (displayPosition.toLowerCase().includes("manager")) displayPosition = "Manager";

        leaders.push({
          name: `${leader.firstName} ${leader.lastName}`,
          position: displayPosition,
          restaurantId: primaryRestaurantId,
          restaurantName,
          hoursWorked: totalHoursWorked,
          avgGradeScore: Math.round(avgScore),
          grade: getGradeLabel(Math.round(avgScore)),
          avgHourlySales: totalHoursWorked > 0 ? Math.round(totalSalesAllHours / totalHoursWorked) : null,
          companyRank: 0,
          totalLeaders: 0,
        });
      }
    }

    if (leaders.length === 0) return null;

    leaders.sort((a, b) => b.avgGradeScore - a.avgGradeScore);
    leaders.forEach((l, i) => { l.companyRank = i + 1; l.totalLeaders = leaders.length; });

    const top10 = leaders.slice(0, 10);

    const byStore: Record<string, LeaderSummary[]> = {};
    for (const l of leaders) {
      if (!byStore[l.restaurantId]) byStore[l.restaurantId] = [];
      byStore[l.restaurantId].push(l);
    }

    const storeEntries = Object.entries(byStore)
      .map(([rid, storeLeaders]) => ({
        restaurantId: rid,
        restaurantName: storeLeaders[0].restaurantName,
        leaders: storeLeaders.sort((a, b) => b.avgGradeScore - a.avgGradeScore),
      }))
      .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName));

    const dayOfWeek = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Chicago" }).format(new Date(`${dateStr}T12:00:00`));
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago"
    }).format(new Date(`${dateStr}T12:00:00`));

    const periodStart = new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", timeZone: "America/Chicago"
    }).format(startDate);
    const periodEnd = new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", timeZone: "America/Chicago"
    }).format(endDate);

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
      <h1 style="margin: 0; font-size: 20px; font-weight: 600;">MWB Leader Rankings</h1>
      <p style="margin: 8px 0 0; font-size: 14px; color: #a1a1aa;">${dayOfWeek}, ${formattedDate}</p>
      <p style="margin: 4px 0 0; font-size: 12px; color: #71717a;">7-day rolling period: ${periodStart} - ${periodEnd}</p>
    </div>

    <div style="background: white; padding: 20px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h3 style="margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #18181b;">Top 10 Leaders - Company Wide</h3>
      <p style="margin: 0 0 12px; font-size: 11px; color: #71717a;">${leaders.length} total leaders ranked (min ${MIN_HOURS_REQUIRED} hrs)</p>
      <div style="display: flex; align-items: center; padding: 4px 0; border-bottom: 2px solid #e4e4e7;">
        <span style="width: 28px; font-size: 10px; color: #a1a1aa; font-weight: 600;">RANK</span>
        <span style="flex: 1; font-size: 10px; color: #a1a1aa; font-weight: 600;">LEADER</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 36px; text-align: center;">GRADE</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 36px; text-align: right;">HRS</span>
        <span style="font-size: 10px; color: #a1a1aa; font-weight: 600; width: 48px; text-align: right;">$/HR</span>
      </div>
      ${top10.map((l, i) => `
        <div style="display: flex; align-items: center; padding: 8px 0; ${i < top10.length - 1 ? 'border-bottom: 1px solid #f4f4f5;' : ''}">
          <span style="width: 28px; font-size: 13px; font-weight: 700; color: ${i < 3 ? '#16a34a' : '#71717a'};">${l.companyRank}</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 13px; font-weight: 500;">${l.name}</div>
            <div style="font-size: 11px; color: #a1a1aa;">${l.restaurantName} &middot; ${l.position}</div>
          </div>
          <span style="font-size: 14px; font-weight: 700; color: ${getGradeColor(l.grade)}; width: 36px; text-align: center;">${l.grade}</span>
          <span style="font-size: 12px; color: #71717a; width: 36px; text-align: right;">${l.hoursWorked}</span>
          <span style="font-size: 12px; color: #71717a; width: 48px; text-align: right;">${l.avgHourlySales !== null ? formatCurrency(l.avgHourlySales) : '--'}</span>
        </div>
      `).join("")}
    </div>

    ${storeEntries.map(store => `
    <div style="background: white; padding: 16px 24px; border: 1px solid #e4e4e7; border-top: none;">
      <h4 style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #18181b;">${store.restaurantName}</h4>
      <div style="display: flex; align-items: center; padding: 3px 0; border-bottom: 1px solid #e4e4e7;">
        <span style="width: 28px; font-size: 9px; color: #a1a1aa; font-weight: 600;">RANK</span>
        <span style="flex: 1; font-size: 9px; color: #a1a1aa; font-weight: 600;">LEADER</span>
        <span style="font-size: 9px; color: #a1a1aa; font-weight: 600; width: 32px; text-align: center;">GRD</span>
        <span style="font-size: 9px; color: #a1a1aa; font-weight: 600; width: 32px; text-align: right;">HRS</span>
        <span style="font-size: 9px; color: #a1a1aa; font-weight: 600; width: 44px; text-align: right;">$/HR</span>
        <span style="font-size: 9px; color: #a1a1aa; font-weight: 600; width: 44px; text-align: right;">CO. #</span>
      </div>
      ${store.leaders.map((l, i) => `
        <div style="display: flex; align-items: center; padding: 5px 0; ${i < store.leaders.length - 1 ? 'border-bottom: 1px solid #fafafa;' : ''}">
          <span style="width: 28px; font-size: 11px; color: #a1a1aa;">${i + 1}</span>
          <div style="flex: 1; min-width: 0;">
            <span style="font-size: 12px;">${l.name}</span>
            <span style="font-size: 10px; color: #a1a1aa; margin-left: 4px;">${l.position}</span>
          </div>
          <span style="font-size: 12px; font-weight: 600; color: ${getGradeColor(l.grade)}; width: 32px; text-align: center;">${l.grade}</span>
          <span style="font-size: 11px; color: #71717a; width: 32px; text-align: right;">${l.hoursWorked}</span>
          <span style="font-size: 11px; color: #71717a; width: 44px; text-align: right;">${l.avgHourlySales !== null ? formatCurrency(l.avgHourlySales) : '--'}</span>
          <span style="font-size: 11px; color: #71717a; width: 44px; text-align: right;">${l.companyRank}/${l.totalLeaders}</span>
        </div>
      `).join("")}
    </div>
    `).join("")}

    <div style="background: white; padding: 16px 24px; border: 1px solid #e4e4e7; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
      <a href="${baseUrl}/leaders" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">
        View Full Leader Rankings
      </a>
      <p style="font-size: 11px; color: #a1a1aa; margin-top: 12px;">
        Based on 7-day rolling execution grades &middot; Min ${MIN_HOURS_REQUIRED} hours required
      </p>
    </div>
  </div>
</body>
</html>`;
  } catch (error) {
    console.error("[leader-report] Error building report HTML:", error);
    return null;
  }
}
