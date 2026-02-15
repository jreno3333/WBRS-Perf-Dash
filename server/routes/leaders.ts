import { Router } from "express";
import { db } from "../db";
import { employees, hourlyCrew, hourlyLabor, hourlySales, hmeTimerData, osatData as osatDataTable, restaurants } from "@shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getAllHourlyPosSalesRange } from "../xenial-webhook";

const router = Router();

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

const MIN_HOURS_REQUIRED = 8;
const MIN_HOURS_TOP10 = 20;

router.get("/api/leaders", async (req, res) => {
  try {
    const { date, days = "7" } = req.query;

    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const now = new Date();
    const endDateStr = date ? String(date) : centralFormatter.format(now);
    const numDays = Math.min(parseInt(String(days)) || 7, 30);

    const endDate = new Date(`${endDateStr}T23:59:59`);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (numDays - 1));
    const startDateStr = startDate.toISOString().split("T")[0];

    const allRestaurants = await db.select().from(restaurants);
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    const leaderEmployees = await db.select().from(employees).where(
      and(
        eq(employees.active, true),
        sql`(${employees.position} ILIKE '%manager%' OR ${employees.position} ILIKE '%supervisor%' OR ${employees.type} IN ('manager', 'asst_manager'))`,
        sql`${employees.position} NOT ILIKE '%team member trainer%'`
      )
    );

    if (leaderEmployees.length === 0) {
      return res.json({ top10: [], storeEntries: [], periodStart: startDateStr, periodEnd: endDateStr, totalEligible: 0 });
    }

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

    // Use POS orders as primary sales source (includes 12am-5am hours)
    const posSalesByKey = await getAllHourlyPosSalesRange(extendedStartDateStr, endDateStr);

    // Also fetch 7shifts hourly_sales as fallback
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

    interface LeaderSummary {
      employeeId: string;
      name: string;
      position: string;
      restaurantId: string;
      restaurantName: string;
      hoursWorked: number;
      avgGradeScore: number;
      grade: string;
      avgHourlySales: number | null;
      avgSpeed: number | null;
      osatPercent: number | null;
      surveyCount: number;
      companyRank: number;
      totalLeaders: number;
    }

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
      let allSpeedValues: number[] = [];
      let allOsatWeighted: { percent: number; responses: number }[] = [];

      for (const crew of crewData) {
        const members = (crew.crewMembers as any[]) || [];
        const wasWorking = members.some(m => m.userId === userId);
        if (!wasWorking) continue;

        workedAtRestaurants.set(crew.restaurantId, (workedAtRestaurants.get(crew.restaurantId) || 0) + 1);

        const labor = laborByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
        const hme = hmeByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
        const osatHour = osatByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);

        // Use POS orders as primary sales source, fall back to 7shifts
        const posKey = `${crew.restaurantId}-${crew.date}-${crew.hour}`;
        const posSales = posSalesByKey.get(posKey);
        const fallbackSales = salesByKey.get(posKey);
        const hourSales = posSales !== undefined ? posSales : (fallbackSales ? (Number(fallbackSales.actualSales) || 0) : 0);
        const hasSalesData = posSales !== undefined || (fallbackSales && Number(fallbackSales.actualSales) > 0);

        if (labor && hasSalesData && hourSales > 0) {
          totalHoursWorked++;
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

          // Look up last week's sales — POS first, then 7shifts fallback
          const crewDate = new Date(crew.date + "T12:00:00");
          const lastWeekDate = new Date(crewDate);
          lastWeekDate.setDate(lastWeekDate.getDate() - 7);
          const lastWeekDateStr = lastWeekDate.toISOString().split("T")[0];
          const posLastWeekKey = `${crew.restaurantId}-${lastWeekDateStr}-${crew.hour}`;
          const posLastWeekSales = posSalesByKey.get(posLastWeekKey);
          const fallbackLastWeekSales = salesByKey.get(posLastWeekKey);
          day.totalSalesLastWeek += posLastWeekSales !== undefined ? posLastWeekSales : (fallbackLastWeekSales ? Number(fallbackLastWeekSales.actualSales) || 0 : 0);

          const actualStaff = Number(labor.employeeCount) || 0;
          const projectedStaff = (Number(labor.projectedLabor) || 0) / 10;
          day.staffingDiffs.push(actualStaff - projectedStaff);

          if (hme && hme.carCount > 0 && hme.carsUnder6Min > 0) {
            const attainment = Math.round((hme.carsUnder6Min / hme.carCount) * 100);
            day.speedValues.push(attainment);
            allSpeedValues.push(attainment);
          }
          if (osatHour && osatHour.totalResponses > 0) {
            day.osatWeighted.push({ percent: Number(osatHour.osatPercent), responses: osatHour.totalResponses });
            allOsatWeighted.push({ percent: Number(osatHour.osatPercent), responses: osatHour.totalResponses });
          }
        }
      }

      const dailyGrades: { score: number; hours: number }[] = [];
      for (const [, day] of Array.from(dailyAggregates)) {
        const hasComparableSales = day.totalSalesLastWeek > 0;
        let salesVariancePct = hasComparableSales
          ? ((day.totalSalesToday - day.totalSalesLastWeek) / day.totalSalesLastWeek) * 100 : 0;
        if (hasComparableSales) {
          salesVariancePct = Math.max(-200, Math.min(200, salesVariancePct));
        }
        const avgStaffingDiff = day.staffingDiffs.reduce((a, b) => a + b, 0) / day.staffingDiffs.length;
        const avgSpeed = day.speedValues.length > 0 ? day.speedValues.reduce((a, b) => a + b, 0) / day.speedValues.length : undefined;
        const totalOsatResponses = day.osatWeighted.reduce((s, o) => s + o.responses, 0);
        const osatPercent = totalOsatResponses > 0
          ? day.osatWeighted.reduce((s, o) => s + o.percent * o.responses, 0) / totalOsatResponses : undefined;
        const salesSurge = salesVariancePct >= 20;

        const components: { weight: number; score: number }[] = [];
        if (hasComparableSales) {
          components.push({ weight: 35, score: salesVariancePct >= -5 ? 100 : 50 });
        } else {
          components.push({ weight: 35, score: 100 });
        }

        const effectiveSurge = salesSurge || !hasComparableSales;
        let staffingScore = 100;
        if (Math.abs(avgStaffingDiff) > 1) staffingScore = avgStaffingDiff > 1 ? 60 : (effectiveSurge ? 100 : 60);
        components.push({ weight: 15, score: staffingScore });

        if (avgSpeed !== undefined) {
          components.push({ weight: 25, score: avgSpeed < 50 ? 40 : avgSpeed < 70 ? 70 : 100 });
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

        const overallAvgSpeed = allSpeedValues.length > 0
          ? allSpeedValues.reduce((a, b) => a + b, 0) / allSpeedValues.length : null;
        const totalSurveyResponses = allOsatWeighted.reduce((s, o) => s + o.responses, 0);
        const overallOsatPercent = totalSurveyResponses > 0
          ? allOsatWeighted.reduce((s, o) => s + o.percent * o.responses, 0) / totalSurveyResponses : null;

        leaders.push({
          employeeId: leader.id,
          name: `${leader.firstName} ${leader.lastName}`,
          position: displayPosition,
          restaurantId: primaryRestaurantId,
          restaurantName,
          hoursWorked: totalHoursWorked,
          avgGradeScore: Math.round(avgScore),
          grade: getGradeLabel(Math.round(avgScore)),
          avgHourlySales: totalHoursWorked > 0 ? Math.round(totalSalesAllHours / totalHoursWorked) : null,
          avgSpeed: overallAvgSpeed,
          osatPercent: overallOsatPercent !== null ? Math.round(overallOsatPercent) : null,
          surveyCount: totalSurveyResponses,
          companyRank: 0,
          totalLeaders: 0,
        });
      }
    }

    const top10Eligible = leaders
      .filter(l => l.hoursWorked >= MIN_HOURS_TOP10 && l.surveyCount > 0)
      .sort((a, b) => b.avgGradeScore - a.avgGradeScore);

    top10Eligible.forEach((l, i) => { l.companyRank = i + 1; l.totalLeaders = top10Eligible.length; });

    const top10 = top10Eligible.slice(0, 10);

    leaders.sort((a, b) => b.avgGradeScore - a.avgGradeScore);

    const byStore: Record<string, LeaderSummary[]> = {};
    for (const l of leaders) {
      if (!byStore[l.restaurantId]) byStore[l.restaurantId] = [];
      byStore[l.restaurantId].push(l);
    }

    const storeEntries = Object.entries(byStore)
      .map(([rid, storeLeaders]) => ({
        restaurantId: rid,
        restaurantName: storeLeaders[0].restaurantName,
        leaders: storeLeaders.sort((a, b) => b.avgGradeScore - a.avgGradeScore).map(l => {
          const coRank = top10Eligible.find(t => t.name === l.name);
          return {
            ...l,
            companyRankDisplay: coRank ? `${coRank.companyRank}/${coRank.totalLeaders}` : null,
          };
        }),
      }))
      .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName));

    res.json({
      top10,
      storeEntries,
      periodStart: startDateStr,
      periodEnd: endDateStr,
      totalEligible: top10Eligible.length,
      minHoursTop10: MIN_HOURS_TOP10,
      minHoursRequired: MIN_HOURS_REQUIRED,
    });
  } catch (error) {
    console.error("Error fetching leaders:", error);
    res.status(500).json({ error: "Failed to fetch leader rankings" });
  }
});

export default router;
