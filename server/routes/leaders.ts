import { Router } from "express";
import { db } from "../db";
import { employees, hourlyCrew, hourlyLabor, hourlySales, hmeTimerData, osatData as osatDataTable, restaurants, historicalDailySales } from "@shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getAllHourlyPosSalesRange, getAllHourlyPosOrderCountRange, getOotHoursByDateRange } from "../xenial-webhook";
import { getTotalRequiredStaff } from "../labor-model";
import { computeHourlyScore, scoreToGradeLabel, computeDailyBonuses } from "../lib/scoring";

const router = Router();

const getGradeLabel = scoreToGradeLabel;

const MIN_HOURS_REQUIRED = 8;
const MIN_HOURS_TOP10 = 20;

router.get("/api/leaders", async (req, res) => {
  try {
    const { date, days = "7", position: positionFilter } = req.query;

    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const now = new Date();
    const todayCentral = centralFormatter.format(now);
    const numDays = Math.min(parseInt(String(days)) || 7, 30);

    // Exclude current day — partial day data creates misleading grades (match leader-detail)
    let endDateStr = date ? String(date) : todayCentral;
    if (endDateStr >= todayCentral) {
      const yesterday = new Date(`${todayCentral}T12:00:00Z`);
      yesterday.setDate(yesterday.getDate() - 1);
      endDateStr = yesterday.toISOString().split("T")[0];
    }

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

    // Fetch POS order counts for transaction variance scoring
    const posOrderCounts = await getAllHourlyPosOrderCountRange(extendedStartDateStr, endDateStr);

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

    // OOT (dt3) hours — skip speed measurement for these hours
    const ootHours = await getOotHoursByDateRange(startDateStr, endDateStr);

    // Fetch last year's daily sales from historical_daily_sales for YoY bonus
    // Use DOW-matching: subtract 1 year, then adjust to same day-of-week (matches yoy-bulk endpoint)
    // Expand range by ±3 days to cover all possible DOW shifts
    const yoyStart = new Date(startDate); yoyStart.setFullYear(yoyStart.getFullYear() - 1); yoyStart.setDate(yoyStart.getDate() - 3);
    const yoyEnd = new Date(endDate); yoyEnd.setFullYear(yoyEnd.getFullYear() - 1); yoyEnd.setDate(yoyEnd.getDate() + 3);
    const yoyStartStr = yoyStart.toISOString().split("T")[0];
    const yoyEndStr = yoyEnd.toISOString().split("T")[0];
    const yoySalesData = await db.select().from(historicalDailySales).where(
      and(gte(historicalDailySales.date, yoyStartStr), lte(historicalDailySales.date, yoyEndStr))
    );
    const yoySalesMap = new Map<string, number>();
    for (const row of yoySalesData) {
      yoySalesMap.set(`${row.restaurantId}-${row.date}`, parseFloat(String(row.netSales)) || 0);
    }

    // POS fallback for YoY data — fill gaps for restaurants without uploaded CSV data
    // (matches yoy-bulk endpoint which also falls back to hourlySales)
    const yoyPosStart = new Date(`${yoyStartStr}T00:00:00.000Z`);
    const yoyPosEnd = new Date(`${yoyEndStr}T23:59:59.999Z`);
    const yoyPosRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: sql<string>`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`,
      totalSales: sql<string>`SUM(CAST(${hourlySales.actualSales} AS numeric))`,
    })
      .from(hourlySales)
      .where(and(gte(hourlySales.salesDate, yoyPosStart), lte(hourlySales.salesDate, yoyPosEnd)))
      .groupBy(hourlySales.restaurantId, sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`);
    for (const row of yoyPosRows) {
      const key = `${row.restaurantId}-${row.salesDate}`;
      if (!yoySalesMap.has(key)) {
        const total = parseFloat(row.totalSales || "0");
        if (total > 0) {
          yoySalesMap.set(key, total);
        }
      }
    }

    // Helper: get DOW-matched year-ago date string
    function getDowMatchedYoyDate(dateStr: string): string {
      const dt = new Date(`${dateStr}T12:00:00Z`);
      const yoy = new Date(dt);
      yoy.setFullYear(yoy.getFullYear() - 1);
      const sameDow = yoy.getDay();
      const targetDow = dt.getDay();
      yoy.setDate(yoy.getDate() + (targetDow - sameDow));
      return yoy.toISOString().split('T')[0];
    }

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
        txnToday: number;
        txnLastWeek: number;
        staffingDiffs: number[];
        speedCarCount: number;
        speedCarsUnder6: number;
        osatWeighted: { percent: number; responses: number }[];
        hoursCount: number;
      }>();
      const workedAtRestaurants = new Map<string, number>();
      let totalHoursWorked = 0;
      let totalSalesAllHours = 0;
      let allSpeedCarCount = 0;
      let allSpeedCarsUnder6 = 0;
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
              txnToday: 0, txnLastWeek: 0,
              staffingDiffs: [], speedCarCount: 0, speedCarsUnder6: 0, osatWeighted: [], hoursCount: 0,
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

          // Accumulate transaction counts for the day
          const txnKey = `${crew.restaurantId}-${crew.date}-${crew.hour}`;
          const txnLastWeekKey = `${crew.restaurantId}-${lastWeekDateStr}-${crew.hour}`;
          day.txnToday += posOrderCounts.get(txnKey) || 0;
          day.txnLastWeek += posOrderCounts.get(txnLastWeekKey) || 0;

          const actualStaff = Number(labor.employeeCount) || 0;
          const requiredStaff = getTotalRequiredStaff(crew.hour, hourSales);
          day.staffingDiffs.push(actualStaff - requiredStaff);

          // Skip speed accumulation when OOT (dt3) is active — lane config changes make timing unreliable
          const isOotHour = ootHours.has(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
          if (!isOotHour && hme && hme.carCount > 0 && (hme.carsUnder6Min || 0) > 0) {
            day.speedCarCount += hme.carCount;
            day.speedCarsUnder6 += hme.carsUnder6Min || 0;
            allSpeedCarCount += hme.carCount;
            allSpeedCarsUnder6 += hme.carsUnder6Min || 0;
          }
          if (osatHour && osatHour.totalResponses > 0) {
            day.osatWeighted.push({ percent: Number(osatHour.osatPercent), responses: osatHour.totalResponses });
            allOsatWeighted.push({ percent: Number(osatHour.osatPercent), responses: osatHour.totalResponses });
          }
        }
      }

      const dailyGrades: { score: number; hours: number }[] = [];
      for (const [dayDate, day] of Array.from(dailyAggregates)) {
        const hasComparableSales = day.totalSalesLastWeek > 0;
        let salesVariancePct = hasComparableSales
          ? ((day.totalSalesToday - day.totalSalesLastWeek) / day.totalSalesLastWeek) * 100 : 0;
        if (hasComparableSales) {
          salesVariancePct = Math.max(-200, Math.min(200, salesVariancePct));
        }
        const avgStaffingDiff = day.staffingDiffs.reduce((a, b) => a + b, 0) / day.staffingDiffs.length;
        const avgSpeed = day.speedCarCount > 0 ? Math.round((day.speedCarsUnder6 / day.speedCarCount) * 100) : undefined;
        const totalOsatResponses = day.osatWeighted.reduce((s, o) => s + o.responses, 0);
        const osatPercent = totalOsatResponses > 0
          ? day.osatWeighted.reduce((s, o) => s + o.percent * o.responses, 0) / totalOsatResponses : undefined;
        const hasComparableTransactions = day.txnLastWeek > 0 && day.txnToday > 0;
        const txnVariancePct = hasComparableTransactions
          ? ((day.txnToday - day.txnLastWeek) / day.txnLastWeek) * 100 : undefined;

        const gradeResult = computeHourlyScore({
          salesVariancePct,
          hasComparableSales,
          transactionVariancePct: txnVariancePct,
          hasComparableTransactions,
          speedAttainment: avgSpeed,
          staffingDiff: avgStaffingDiff,
          hasValidStaffing: day.staffingDiffs.length > 0,
          osatPercent,
        });

        if (gradeResult.hasGrade) {
          // YoY variance from historical_daily_sales (DOW-matched)
          const yoyMatchedDate = getDowMatchedYoyDate(dayDate);
          const lastYearSales = yoySalesMap.get(`${day.restaurantId}-${yoyMatchedDate}`);
          const dailyYoySalesVar = lastYearSales && lastYearSales > 0
            ? ((day.totalSalesToday - lastYearSales) / lastYearSales) * 100
            : undefined;

          // Apply daily bonus to each day's score (matches dashboard + trends)
          const bonusResult = computeDailyBonuses({
            dailyOsatPercent: osatPercent,
            dailySurveyCount: totalOsatResponses,
            dailySalesVariancePct: hasComparableSales ? salesVariancePct : undefined,
            dailyTransactionVariancePct: txnVariancePct,
            dailyYoySalesVariancePct: dailyYoySalesVar,
            hourlyScores: [gradeResult.score], // day-level aggregate (recovery/consistency need per-hour data)
          });
          const finalScore = Math.min(gradeResult.score + bonusResult.cappedBonus, 100);
          dailyGrades.push({ score: finalScore, hours: day.hoursCount });
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
        // Fallback: if position doesn't normalize, use employee type to classify
        if (displayPosition !== "Manager" && displayPosition !== "Shift Supervisor") {
          displayPosition = (leader.type === "manager" || leader.type === "asst_manager") ? "Manager" : "Shift Supervisor";
        }

        const overallAvgSpeed = allSpeedCarCount > 0
          ? Math.round((allSpeedCarsUnder6 / allSpeedCarCount) * 100) : null;
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

    // Apply position filter if provided
    const posFilterStr = positionFilter ? String(positionFilter).toLowerCase() : null;
    const filteredLeaders = posFilterStr
      ? leaders.filter(l => {
          const pos = l.position.toLowerCase();
          if (posFilterStr === 'manager') return pos.includes('manager');
          if (posFilterStr === 'ss') return pos.includes('supervisor');
          return true;
        })
      : leaders;

    const top10Eligible = filteredLeaders
      .filter(l => l.hoursWorked >= MIN_HOURS_TOP10 && l.surveyCount > 0)
      .sort((a, b) => b.avgGradeScore - a.avgGradeScore);

    top10Eligible.forEach((l, i) => { l.companyRank = i + 1; l.totalLeaders = top10Eligible.length; });

    const top10 = top10Eligible.slice(0, 10);

    filteredLeaders.sort((a, b) => b.avgGradeScore - a.avgGradeScore);

    const byStore: Record<string, LeaderSummary[]> = {};
    for (const l of filteredLeaders) {
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
