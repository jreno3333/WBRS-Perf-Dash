import { Router } from "express";
import { db, posDb, pool } from "../db";
import { employees, restaurants, hourlySales, hourlyLabor, hmeTimerData, osatData as osatDataTable, posOrders, dailySuppressedSales, locationMapping } from "@shared/schema";
import { eq, and, gte, lte, lt, sql } from "drizzle-orm";
import { computeHourlyScore, scoreToGradeLabel, type HourlyScoreInput } from "../lib/scoring";
import { getActiveGradingConfig } from "./grading-config";

const router = Router();

// ─── Employee Anniversaries ────────────────────────────────────────────────
// Returns employees whose work anniversary falls within the next N days
router.get("/api/analytics/anniversaries", async (req, res) => {
  try {
    const { days = "30" } = req.query;
    const numDays = Math.min(parseInt(String(days)) || 30, 365);

    const [activeEmployees, allRestaurants] = await Promise.all([
      db.select().from(employees).where(eq(employees.active, true)),
      db.select().from(restaurants),
    ]);
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    const today = new Date();
    const currentYear = today.getFullYear();
    const todayMonth = today.getMonth();
    const todayDay = today.getDate();

    interface Anniversary {
      employeeId: string;
      name: string;
      position: string;
      restaurantId: string | null;
      restaurantName: string;
      hireDate: string;
      anniversaryDate: string;
      yearsCompleted: number;
      daysUntil: number;
    }

    const anniversaries: Anniversary[] = [];

    for (const emp of activeEmployees) {
      const hireDateStr = emp.hireDate;
      if (!hireDateStr) continue;

      const hireDate = new Date(hireDateStr + "T12:00:00");
      const hireMonth = hireDate.getMonth();
      const hireDay = hireDate.getDate();

      // Find the next anniversary date
      let anniversaryYear = currentYear;
      let annivDate = new Date(anniversaryYear, hireMonth, hireDay);
      if (annivDate < today) {
        // If this year's anniversary has passed, check next year's
        anniversaryYear = currentYear + 1;
        annivDate = new Date(anniversaryYear, hireMonth, hireDay);
      }

      const daysUntil = Math.floor((annivDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil < 0 || daysUntil > numDays) continue;

      const yearsCompleted = anniversaryYear - hireDate.getFullYear();
      if (yearsCompleted < 1) continue; // Skip if not even 1 year yet

      anniversaries.push({
        employeeId: emp.id,
        name: `${emp.firstName} ${emp.lastName}`,
        position: emp.position || "Team Member",
        restaurantId: emp.restaurantId,
        restaurantName: emp.restaurantId ? (restaurantNameMap.get(emp.restaurantId) || "Unknown") : "Unknown",
        hireDate: hireDateStr,
        anniversaryDate: annivDate.toISOString().split("T")[0],
        yearsCompleted,
        daysUntil,
      });
    }

    anniversaries.sort((a, b) => a.daysUntil - b.daysUntil);

    res.json({
      windowDays: numDays,
      count: anniversaries.length,
      anniversaries,
    });
  } catch (error) {
    console.error("Error fetching anniversaries:", error);
    res.status(500).json({ error: "Failed to fetch anniversaries" });
  }
});

// ─── Weekly Sales Forecast ─────────────────────────────────────────────────
// Projects remaining days of the week using same-day-last-week data
router.get("/api/analytics/weekly-forecast", async (req, res) => {
  try {
    const { date } = req.query;

    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = date ? String(date) : centralFormatter.format(new Date());
    const today = new Date(todayStr + "T12:00:00");

    // Sat-Fri business week (7 days)
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceSaturday = (dayOfWeek + 1) % 7; // Sat=0, Sun=1, Mon=2, ..., Fri=6
    const saturday = new Date(today);
    saturday.setDate(today.getDate() - daysSinceSaturday);

    // Build an array for all 7 days: Sat, Sun, Mon, Tue, Wed, Thu, Fri
    const weekDays: { date: string; dayName: string; isComplete: boolean; isPast: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(saturday);
      d.setDate(saturday.getDate() + i);
      const dStr = d.toISOString().split("T")[0];
      weekDays.push({
        date: dStr,
        dayName: d.toLocaleDateString("en-US", { weekday: "long" }),
        isComplete: dStr < todayStr,
        isPast: dStr <= todayStr,
      });
    }

    // Fetch sales for this week and last week for projection
    const saturdayStr = saturday.toISOString().split("T")[0];
    const friday = new Date(saturday);
    friday.setDate(saturday.getDate() + 6);
    const fridayStr = friday.toISOString().split("T")[0];
    const lastSaturday = new Date(saturday);
    lastSaturday.setDate(lastSaturday.getDate() - 7);
    const lastSaturdayStr = lastSaturday.toISOString().split("T")[0];
    const lastFriday = new Date(friday);
    lastFriday.setDate(lastFriday.getDate() - 7);
    const lastFridayStr = lastFriday.toISOString().split("T")[0];

    const partialDay = weekDays.find(wd => wd.isPast && !wd.isComplete);

    const salesDataQuery = db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      totalSales: sql<number>`sum(${hourlySales.actualSales}::numeric)`,
    })
    .from(hourlySales)
    .where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${lastSaturdayStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${fridayStr}`
    )
    .groupBy(hourlySales.restaurantId, hourlySales.salesDate);

    let progressMatchedQuery: Promise<{ totalSales: number }[]> | null = null;
    let lastWeekProgressMatched: number | null = null;

    if (partialDay) {
      const centralHourFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        hour12: false,
      });
      const currentCentralHour = parseInt(centralHourFormatter.format(new Date()), 10);
      const completedHourCutoff = currentCentralHour - 1;
      const lastWeekDate = new Date(partialDay.date + "T12:00:00");
      lastWeekDate.setDate(lastWeekDate.getDate() - 7);
      const lwDateStr = lastWeekDate.toISOString().split("T")[0];

      progressMatchedQuery = db.select({
        totalSales: sql<number>`sum(${hourlySales.actualSales}::numeric)`,
      })
      .from(hourlySales)
      .where(
        sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${lwDateStr} AND ${hourlySales.hour} <= ${completedHourCutoff}`
      );
    }

    const [salesData, progressMatchedRows] = await Promise.all([
      salesDataQuery,
      progressMatchedQuery,
    ]);

    if (progressMatchedRows) {
      lastWeekProgressMatched = Number(progressMatchedRows[0]?.totalSales) || 0;
    }

    const salesByDate = new Map<string, number>();
    for (const row of salesData) {
      const dateKey = row.salesDate.toISOString().split("T")[0];
      salesByDate.set(dateKey, (salesByDate.get(dateKey) || 0) + (Number(row.totalSales) || 0));
    }

    // Build weekly forecast
    let actualTotal = 0;
    let forecastTotal = 0;
    const dailyBreakdown = weekDays.map(wd => {
      const actual = salesByDate.get(wd.date) || 0;
      const lastWeekDate = new Date(wd.date + "T12:00:00");
      lastWeekDate.setDate(lastWeekDate.getDate() - 7);
      const lwStr = lastWeekDate.toISOString().split("T")[0];
      const lastWeek = salesByDate.get(lwStr) || 0;

      if (wd.isComplete) {
        actualTotal += actual;
        forecastTotal += actual;
        return { ...wd, actual, lastWeek, forecast: actual, source: "actual" as const, lastWeekAtThisPoint: undefined as number | undefined };
      } else if (wd.isPast) {
        // Today: actual so far + remaining projected from LW
        actualTotal += actual;
        forecastTotal += Math.max(actual, lastWeek);
        return { ...wd, actual, lastWeek, forecast: Math.max(actual, lastWeek), source: "partial" as const, lastWeekAtThisPoint: lastWeekProgressMatched ?? undefined };
      } else {
        // Future: use last week same day
        forecastTotal += lastWeek;
        return { ...wd, actual: 0, lastWeek, forecast: lastWeek, source: "projected" as const, lastWeekAtThisPoint: undefined as number | undefined };
      }
    });

    const lastWeekTotal = weekDays.reduce((sum, wd) => {
      const lwDate = new Date(wd.date + "T12:00:00");
      lwDate.setDate(lwDate.getDate() - 7);
      return sum + (salesByDate.get(lwDate.toISOString().split("T")[0]) || 0);
    }, 0);

    res.json({
      weekStart: saturdayStr,
      weekEnd: fridayStr,
      currentDate: todayStr,
      actualTotal,
      forecastTotal,
      lastWeekTotal,
      variancePercent: lastWeekTotal > 0 ? ((forecastTotal - lastWeekTotal) / lastWeekTotal) * 100 : 0,
      daily: dailyBreakdown,
    });
  } catch (error) {
    console.error("Error fetching weekly forecast:", error);
    res.status(500).json({ error: "Failed to fetch weekly forecast" });
  }
});

// ─── Consistency Metric ────────────────────────────────────────────────────
// Uses hourly execution grade std deviation + D/F frequency to measure
// operational consistency. A restaurant that grades A-then-F-then-B is
// inconsistent; one that grades B-B-B every hour is consistent.
router.get("/api/analytics/consistency", async (req, res) => {
  try {
    const { days = "14" } = req.query;
    const numDays = Math.min(parseInt(String(days)) || 14, 90);

    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = centralFormatter.format(new Date());
    const startDate = new Date(todayStr + "T12:00:00");
    startDate.setDate(startDate.getDate() - numDays);
    const startDateStr = startDate.toISOString().split("T")[0];

    // Extend 7 days back for last-week sales comparison
    const extendedStart = new Date(startDate);
    extendedStart.setDate(extendedStart.getDate() - 7);
    const extStartStr = extendedStart.toISOString().split("T")[0];

    const [allSalesData, allLaborData, allHmeData, allOsatData, allRestaurants] = await Promise.all([
      db.select().from(hourlySales).where(
        sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${extStartStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${todayStr}`
      ),
      db.select().from(hourlyLabor).where(
        and(sql`${hourlyLabor.date} >= ${startDateStr}`, sql`${hourlyLabor.date} <= ${todayStr}`)
      ),
      db.select().from(hmeTimerData).where(
        and(gte(hmeTimerData.date, startDateStr), lte(hmeTimerData.date, todayStr))
      ),
      db.select().from(osatDataTable).where(
        and(gte(osatDataTable.date, startDateStr), lte(osatDataTable.date, todayStr))
      ),
      db.select().from(restaurants).where(eq(restaurants.isActive, true)),
    ]);

    // Build lookups keyed by restaurantId-date-hour
    const salesByKey = new Map<string, number>();
    for (const s of allSalesData) {
      const d = s.salesDate.toISOString().split("T")[0];
      salesByKey.set(`${s.restaurantId}-${d}-${s.hour}`, Number(s.actualSales) || 0);
    }

    const laborByKey = new Map<string, { actual: number; projected: number; employees: number }>();
    for (const l of allLaborData) {
      laborByKey.set(`${l.restaurantId}-${l.date}-${l.hour}`, {
        actual: Number(l.actualLabor) || 0,
        projected: Number(l.projectedLabor) || 0,
        employees: Number(l.employeeCount) || 0,
      });
    }

    const hmeByKey = new Map<string, { carCount: number; carsUnder6Min: number }>();
    for (const h of allHmeData) {
      if (h.carCount > 0) {
        hmeByKey.set(`${h.restaurantId}-${h.date}-${h.hour}`, {
          carCount: h.carCount,
          carsUnder6Min: h.carsUnder6Min || 0,
        });
      }
    }

    const osatByKey = new Map<string, { percent: number; responses: number }>();
    for (const o of allOsatData) {
      if (o.totalResponses > 0) {
        osatByKey.set(`${o.restaurantId}-${o.date}-${o.hour}`, {
          percent: Number(o.osatPercent), responses: o.totalResponses,
        });
      }
    }

    const gradingCfg = await getActiveGradingConfig();

    // Build date range for the analysis window
    const dateRange: string[] = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      dateRange.push(d.toISOString().split("T")[0]);
    }

    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));
    const restaurantIds = allRestaurants.map(r => r.id);

    interface ConsistencyResult {
      restaurantId: string;
      restaurantName: string;
      avgGrade: number;           // average hourly grade score (0-100)
      avgGradeLabel: string;
      gradeStdDev: number;        // std deviation of hourly grades
      consistencyScore: number;   // 0-100, higher = more consistent
      dfCount: number;            // number of D or F hourly grades
      dfPercent: number;          // % of graded hours that were D or F
      totalGradedHours: number;
      daysAnalyzed: number;
    }

    const results: ConsistencyResult[] = [];

    for (const rid of restaurantIds) {
      const name = restaurantNameMap.get(rid);
      if (!name) continue;

      const hourlyScores: number[] = [];
      let dfCount = 0;
      const daysWithData = new Set<string>();

      for (const dateStr2 of dateRange) {
        for (let hour = 6; hour <= 22; hour++) {
          const key = `${rid}-${dateStr2}-${hour}`;
          const sales = salesByKey.get(key);
          if (sales === undefined || sales <= 0) continue;

          // Last week comparison
          const lwDate = new Date(dateStr2 + "T12:00:00");
          lwDate.setDate(lwDate.getDate() - 7);
          const lwKey = `${rid}-${lwDate.toISOString().split("T")[0]}-${hour}`;
          const lwSales = salesByKey.get(lwKey) || 0;
          const hasComparable = lwSales > 0;
          const salesVariance = hasComparable ? ((sales - lwSales) / lwSales) * 100 : 0;

          const labor = laborByKey.get(key);
          let staffingDiff = 0;
          let hasValidStaffing = false;
          if (labor && labor.projected > 0 && labor.employees >= 1) {
            hasValidStaffing = true;
            staffingDiff = ((labor.actual - labor.projected) / labor.projected) * 10;
          }

          const hmeRecord = hmeByKey.get(key);
          let speedAttainment: number | undefined;
          if (hmeRecord && hmeRecord.carCount > 0 && hmeRecord.carsUnder6Min > 0) {
            speedAttainment = Math.round((hmeRecord.carsUnder6Min / hmeRecord.carCount) * 100);
          }

          const osat = osatByKey.get(key);

          const scoreInput: HourlyScoreInput = {
            salesVariancePct: salesVariance,
            hasComparableSales: hasComparable,
            speedAttainment,
            staffingDiff,
            hasValidStaffing,
            osatPercent: osat ? osat.percent : undefined,
            osatResponses: osat ? osat.responses : undefined,
          };
          const result = computeHourlyScore(scoreInput, gradingCfg);

          if (result.hasGrade) {
            hourlyScores.push(result.score);
            daysWithData.add(dateStr2);
            if (result.grade.startsWith("D") || result.grade === "F") dfCount++;
          }
        }
      }

      if (hourlyScores.length < 10 || daysWithData.size < 3) continue;

      const avg = hourlyScores.reduce((a, b) => a + b, 0) / hourlyScores.length;
      const sqDiffs = hourlyScores.map(s => Math.pow(s - avg, 2));
      const variance = sqDiffs.reduce((a, b) => a + b, 0) / hourlyScores.length;
      const stdDev = Math.sqrt(variance);
      const dfPercent = (dfCount / hourlyScores.length) * 100;

      // Consistency score: blend of low std deviation (60%) + low D/F rate (40%)
      // stdDev component: 0 = 100 (perfect), 25+ = 0
      const stdDevScore = Math.max(0, Math.min(100, 100 - (stdDev * 4)));
      // D/F component: 0% = 100 (perfect), 30%+ = 0
      const dfScore = Math.max(0, Math.min(100, 100 - (dfPercent * 100 / 30)));
      const consistencyScore = Math.round(stdDevScore * 0.6 + dfScore * 0.4);

      results.push({
        restaurantId: rid,
        restaurantName: name,
        avgGrade: Math.round(avg * 10) / 10,
        avgGradeLabel: scoreToGradeLabel(avg),
        gradeStdDev: Math.round(stdDev * 10) / 10,
        consistencyScore,
        dfCount,
        dfPercent: Math.round(dfPercent * 10) / 10,
        totalGradedHours: hourlyScores.length,
        daysAnalyzed: daysWithData.size,
      });
    }

    results.sort((a, b) => b.consistencyScore - a.consistencyScore);

    const avgConsistency = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.consistencyScore, 0) / results.length)
      : 0;

    res.json({
      period: numDays,
      companyAvgConsistency: avgConsistency,
      restaurants: results,
    });
  } catch (error) {
    console.error("Error computing consistency:", error);
    res.status(500).json({ error: "Failed to compute consistency metric" });
  }
});

// ─── Schedule Compliance / Staffing Fill ───────────────────────────────────
// Compares scheduled vs actual labor hours deployed by restaurant
router.get("/api/analytics/schedule-compliance", async (req, res) => {
  try {
    const { date, days = "7" } = req.query;
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const endDateStr = date ? String(date) : centralFormatter.format(new Date());
    const numDays = Math.min(parseInt(String(days)) || 7, 30);

    const endDate = new Date(endDateStr + "T23:59:59");
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (numDays - 1));
    const startDateStr = startDate.toISOString().split("T")[0];

    const [laborData, allRestaurants] = await Promise.all([
      db.select().from(hourlyLabor).where(
        and(
          sql`${hourlyLabor.date} >= ${startDateStr}`,
          sql`${hourlyLabor.date} <= ${endDateStr}`
        )
      ),
      db.select().from(restaurants).where(eq(restaurants.isActive, true)),
    ]);
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    // Aggregate by restaurant — two passes so we can exclude operator-scheduled
    // cost from projected labor. Operators are scheduled but never clock in,
    // which would otherwise always look like a no-show.

    // Pass 1: compute totals & avg hourly rate per restaurant
    const byRestaurant = new Map<string, {
      totalScheduledCost: number;
      totalActualCost: number;
      totalActualHours: number;
      operatorSlots: number;  // count of hour-slots with an operator scheduled
      hoursUnder: number;
      hoursOver: number;
      totalHours: number;
    }>();

    for (const row of laborData) {
      const rid = row.restaurantId;
      if (!byRestaurant.has(rid)) {
        byRestaurant.set(rid, {
          totalScheduledCost: 0, totalActualCost: 0,
          totalActualHours: 0, operatorSlots: 0,
          hoursUnder: 0, hoursOver: 0, totalHours: 0,
        });
      }
      const entry = byRestaurant.get(rid)!;
      const scheduled = Number(row.projectedLabor) || 0;
      const actual = Number(row.actualLabor) || 0;
      const employees = Number(row.employeeCount) || 0;
      const positions = row.positionBreakdown as Record<string, number> | null;
      const hasOperator = positions?.['_operatorScheduled'] ? true : false;

      entry.totalScheduledCost += scheduled;
      entry.totalActualCost += actual;
      entry.totalActualHours += employees;
      if (hasOperator) entry.operatorSlots++;
    }

    // Pass 2: compute per-hour ratios with operator cost removed from scheduled
    for (const row of laborData) {
      const rid = row.restaurantId;
      const entry = byRestaurant.get(rid)!;
      const scheduled = Number(row.projectedLabor) || 0;
      const actual = Number(row.actualLabor) || 0;
      const positions = row.positionBreakdown as Record<string, number> | null;
      const hasOperator = positions?.['_operatorScheduled'] ? true : false;

      if (scheduled > 0) {
        // Estimate operator cost for this hour using avg hourly rate
        let adjustedScheduled = scheduled;
        if (hasOperator && entry.totalActualHours > 0) {
          const avgRate = entry.totalActualCost / entry.totalActualHours;
          adjustedScheduled = Math.max(0, scheduled - avgRate);
        }

        entry.totalHours++;
        if (adjustedScheduled > 0) {
          const ratio = actual / adjustedScheduled;
          if (ratio < 0.75) entry.hoursUnder++;
          else if (ratio > 1.25) entry.hoursOver++;
        }
      }
    }

    interface ComplianceResult {
      restaurantId: string;
      restaurantName: string;
      compliancePercent: number;  // actual hrs / scheduled hrs * 100
      actualHoursDeployed: number; // total labor hours worked
      underHours: number;
      overHours: number;
      totalHours: number;
      callInRate: number;  // % of hours significantly understaffed
    }

    const results: ComplianceResult[] = [];

    for (const [rid, data] of byRestaurant) {
      const name = restaurantNameMap.get(rid);
      if (!name || data.totalHours === 0) continue;

      // Remove estimated operator cost from total scheduled
      let adjustedScheduledCost = data.totalScheduledCost;
      if (data.operatorSlots > 0 && data.totalActualHours > 0) {
        const avgRate = data.totalActualCost / data.totalActualHours;
        adjustedScheduledCost = Math.max(0, data.totalScheduledCost - (data.operatorSlots * avgRate));
      }

      results.push({
        restaurantId: rid,
        restaurantName: name,
        compliancePercent: adjustedScheduledCost > 0
          ? Math.round((data.totalActualCost / adjustedScheduledCost) * 100)
          : 0,
        actualHoursDeployed: Math.round(data.totalActualHours),
        underHours: data.hoursUnder,
        overHours: data.hoursOver,
        totalHours: data.totalHours,
        callInRate: data.totalHours > 0
          ? Math.round((data.hoursUnder / data.totalHours) * 100)
          : 0,
      });
    }

    results.sort((a, b) => a.compliancePercent - b.compliancePercent);

    res.json({
      period: { start: startDateStr, end: endDateStr, days: numDays },
      restaurants: results,
    });
  } catch (error) {
    console.error("Error computing schedule compliance:", error);
    res.status(500).json({ error: "Failed to compute schedule compliance" });
  }
});

// ─── Suppressed Sales Estimation ───────────────────────────────────────────
// Estimates revenue lost to understaffing and slow DT during peak hours
router.get("/api/analytics/suppressed-sales", async (req, res) => {
  try {
    const { date } = req.query;
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = date ? String(date) : centralFormatter.format(new Date());

    const lwDate = new Date(todayStr + "T12:00:00");
    lwDate.setDate(lwDate.getDate() - 7);
    const lwStr = lwDate.toISOString().split("T")[0];
    const todayStart = new Date(todayStr + "T00:00:00");
    const todayEnd = new Date(todayStr + "T23:59:59");

    const [salesData, laborData, hmeData, lwSalesData, allRestaurants, posSalesRows, locationMappingRows] = await Promise.all([
      db.select().from(hourlySales).where(
        sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${todayStr}`
      ),
      db.select().from(hourlyLabor).where(
        eq(hourlyLabor.date, todayStr)
      ),
      db.select().from(hmeTimerData).where(
        eq(hmeTimerData.date, todayStr)
      ),
      db.select().from(hourlySales).where(
        sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${lwStr}`
      ),
      db.select().from(restaurants).where(eq(restaurants.isActive, true)),
      posDb.select({
        storeNumber: posOrders.storeNumber,
        total: sql<string>`SUM(${posOrders.orderTotal})`,
      })
        .from(posOrders)
        .where(and(
          gte(posOrders.orderClosedAt, sql`(${todayStr}::timestamp AT TIME ZONE 'America/Chicago')`),
          lt(posOrders.orderClosedAt, sql`((${todayStr}::date + interval '1 day')::timestamp AT TIME ZONE 'America/Chicago')`)
        ))
        .groupBy(posOrders.storeNumber),
      db.select().from(locationMapping),
    ]);

    const laborByKey = new Map<string, typeof laborData[0]>();
    for (const l of laborData) laborByKey.set(`${l.restaurantId}-${l.hour}`, l);

    const hmeByKey = new Map<string, typeof hmeData[0]>();
    for (const h of hmeData) hmeByKey.set(`${h.restaurantId}-${h.hour}`, h);

    const lwByKey = new Map<string, number>();
    for (const s of lwSalesData) {
      lwByKey.set(`${s.restaurantId}-${s.hour}`, Number(s.actualSales) || 0);
    }

    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));
    const storeToRestaurantMap = new Map<string, string>();
    for (const lm of locationMappingRows) {
      storeToRestaurantMap.set(lm.xenialStoreNumber, lm.restaurantId);
    }
    const dailySalesByRestaurant = new Map<string, number>();
    for (const row of posSalesRows) {
      const restId = storeToRestaurantMap.get(row.storeNumber);
      if (!restId) continue;
      dailySalesByRestaurant.set(restId, (dailySalesByRestaurant.get(restId) || 0) + (parseFloat(row.total) || 0));
    }

    interface SuppressedSalesResult {
      restaurantId: string;
      restaurantName: string;
      estimatedLostSales: number;
      understaffedHours: number;
      slowDtHours: number;
      totalRestaurantSales: number;
      lostPercent: number;
      details: { hour: number; reason: string; estimatedLoss: number }[];
    }

    const results: SuppressedSalesResult[] = [];

    // Group sales by restaurant
    const salesByRestaurant = new Map<string, typeof salesData>();
    for (const s of salesData) {
      if (!salesByRestaurant.has(s.restaurantId)) salesByRestaurant.set(s.restaurantId, []);
      salesByRestaurant.get(s.restaurantId)!.push(s);
    }

    for (const [rid, hours] of salesByRestaurant) {
      const name = restaurantNameMap.get(rid);
      if (!name) continue;

      let totalLost = 0;
      let understaffedCount = 0;
      let slowDtCount = 0;
      const details: { hour: number; reason: string; estimatedLoss: number }[] = [];

      for (const hourData of hours) {
        const h = hourData.hour;
        const sales = Number(hourData.actualSales) || 0;
        const lwSales = lwByKey.get(`${rid}-${h}`) || 0;
        const labor = laborByKey.get(`${rid}-${h}`);
        const hme = hmeByKey.get(`${rid}-${h}`);

        // Understaffing penalty: if actual labor is 25%+ below projected during an hour
        // with sales > $200, estimate 10% of LW sales as lost
        if (labor) {
          const scheduled = Number(labor.projectedLabor) || 0;
          const actual = Number(labor.actualLabor) || 0;
          if (scheduled > 0 && actual < scheduled * 0.75 && sales > 200) {
            const shortfall = (scheduled - actual) / scheduled;
            const estimatedLoss = lwSales * shortfall * 0.15; // 15% of LW proportional
            if (estimatedLoss > 10) {
              totalLost += estimatedLoss;
              understaffedCount++;
              details.push({ hour: h, reason: "Understaffed", estimatedLoss: Math.round(estimatedLoss) });
            }
          }
        }

        // Slow drive-thru penalty: > 7 min avg during peak hours = estimated 5% loss
        if (hme && hme.avgTotalTime && hme.avgTotalTime > 420 && lwSales > 200) {
          const excessTime = (hme.avgTotalTime - 300) / 300; // how much over 5 min target
          const estimatedLoss = lwSales * Math.min(excessTime, 0.5) * 0.08;
          if (estimatedLoss > 10) {
            totalLost += estimatedLoss;
            slowDtCount++;
            details.push({ hour: h, reason: "Slow DT", estimatedLoss: Math.round(estimatedLoss) });
          }
        }
      }

      if (totalLost > 0) {
        const unitDailySales = dailySalesByRestaurant.get(rid) || 0;
        results.push({
          restaurantId: rid,
          restaurantName: name,
          estimatedLostSales: Math.round(totalLost),
          understaffedHours: understaffedCount,
          slowDtHours: slowDtCount,
          totalRestaurantSales: Math.round(unitDailySales),
          lostPercent: unitDailySales > 0 ? Math.round((totalLost / unitDailySales) * 1000) / 10 : 0,
          details,
        });
      }
    }

    results.sort((a, b) => b.estimatedLostSales - a.estimatedLostSales);

    const companyTotal = results.reduce((s, r) => s + r.estimatedLostSales, 0);
    const companyTotalSales = Array.from(dailySalesByRestaurant.values()).reduce((s, v) => s + v, 0);
    const companyLostPercent = companyTotalSales > 0 ? Math.round((companyTotal / companyTotalSales) * 1000) / 10 : 0;

    // Persist snapshot for historical review and future rollups
    if (results.length > 0) {
      try {
        for (const r of results) {
          await db.insert(dailySuppressedSales)
            .values({
              date: todayStr,
              restaurantId: r.restaurantId,
              restaurantName: r.restaurantName,
              estimatedLostSales: String(r.estimatedLostSales),
              understaffedHours: r.understaffedHours,
              slowDtHours: r.slowDtHours,
              totalRestaurantSales: String(r.totalRestaurantSales),
            })
            .onConflictDoUpdate({
              target: [dailySuppressedSales.date, dailySuppressedSales.restaurantId],
              set: {
                estimatedLostSales: sql`excluded.estimated_lost_sales`,
                understaffedHours: sql`excluded.understaffed_hours`,
                slowDtHours: sql`excluded.slow_dt_hours`,
                totalRestaurantSales: sql`excluded.total_restaurant_sales`,
                restaurantName: sql`excluded.restaurant_name`,
                savedAt: sql`now()`,
              },
            });
        }
      } catch (persistError) {
        console.error("Failed to persist suppressed sales snapshot:", persistError);
        // Non-fatal — still return the computed data
      }
    }

    res.json({
      date: todayStr,
      companyTotalSuppressed: companyTotal,
      companyTotalSales: Math.round(companyTotalSales),
      companyLostPercent,
      restaurants: results,
    });
  } catch (error) {
    console.error("Error computing suppressed sales:", error);
    res.status(500).json({ error: "Failed to compute suppressed sales" });
  }
});

// ─── Demand Curves (Sub-hourly POS Transaction Analysis) ───────────────────
// Groups POS transactions into 15-minute buckets within each hour
router.get("/api/analytics/demand-curves", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: "date parameter required" });
    }
    const dateStr = String(date);
    const startOfDay = new Date(dateStr + "T00:00:00.000Z");
    const endOfDay = new Date(dateStr + "T23:59:59.999Z");

    const [mappings, allRestaurants] = await Promise.all([
      db.select().from(locationMapping),
      db.select({ id: restaurants.id, timezone: restaurants.timezone }).from(restaurants),
    ]);
    const restaurantTzMap = new Map<string, string>();
    for (const r of allRestaurants) {
      restaurantTzMap.set(r.id, r.timezone || "America/New_York");
    }
    const storeToRestaurantId = new Map<string, string>();
    for (const m of mappings) {
      if (m.restaurantId) {
        storeToRestaurantId.set(m.xenialStoreNumber, m.restaurantId);
      }
    }

    // Group stores by timezone so each query uses the correct local time
    const tzToStores = new Map<string, string[]>();
    for (const [store, restaurantId] of storeToRestaurantId) {
      const tz = restaurantTzMap.get(restaurantId) || "America/New_York";
      if (!tzToStores.has(tz)) tzToStores.set(tz, []);
      tzToStores.get(tz)!.push(store);
    }

    // Build per-restaurant, per-hour, per-quarter structure
    const restaurantHours = new Map<string, Map<number, { orders: number; sales: number }[]>>();

    const VALID_TIMEZONES = new Set(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]);
    const tzQueries = Array.from(tzToStores.entries()).map(([tz, storeNumbers]) => {
      const safeTz = VALID_TIMEZONES.has(tz) ? tz : "America/New_York";
      const tzSql = sql.raw(`'${safeTz}'`);
      return posDb
        .select({
          storeNumber: posOrders.storeNumber,
          hour: sql<number>`extract(hour from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${tzSql})::int`,
          quarter: sql<number>`floor(extract(minute from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${tzSql}) / 15)::int`,
          orders: sql<number>`count(*)::int`,
          sales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
        })
        .from(posOrders)
        .where(
          and(
            sql`${posOrders.storeNumber} IN (${sql.join(storeNumbers.map(s => sql`${s}`), sql`, `)})`,
            gte(posOrders.businessDate, startOfDay),
            lt(posOrders.businessDate, endOfDay)
          )
        )
        .groupBy(
          posOrders.storeNumber,
          sql`extract(hour from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${tzSql})`,
          sql`floor(extract(minute from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${tzSql}) / 15)`
        );
    });

    const tzResults = await Promise.all(tzQueries);

    for (const rows of tzResults) {
      for (const row of rows) {
        const restaurantId = storeToRestaurantId.get(row.storeNumber);
        if (!restaurantId) continue;

        if (!restaurantHours.has(restaurantId)) {
          restaurantHours.set(restaurantId, new Map());
        }
        const hourMap = restaurantHours.get(restaurantId)!;
        if (!hourMap.has(row.hour)) {
          hourMap.set(row.hour, [
            { orders: 0, sales: 0 },
            { orders: 0, sales: 0 },
            { orders: 0, sales: 0 },
            { orders: 0, sales: 0 },
          ]);
        }
        const quarters = hourMap.get(row.hour)!;
        const qi = Math.min(Math.max(row.quarter, 0), 3);
        quarters[qi].orders = Number(row.orders) || 0;
        quarters[qi].sales = Number(row.sales) || 0;
      }
    }

    // Format response
    const result: {
      restaurantId: string;
      hours: {
        hour: number;
        quarters: { label: string; orders: number; sales: number }[];
        totalOrders: number;
        totalSales: number;
        loadProfile: string;
      }[];
    }[] = [];

    for (const [restaurantId, hourMap] of restaurantHours) {
      const hours: typeof result[0]["hours"] = [];
      for (const [hour, quarters] of hourMap) {
        const totalOrders = quarters.reduce((s, q) => s + q.orders, 0);
        const totalSales = quarters.reduce((s, q) => s + q.sales, 0);
        const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        const ampm = hour < 12 ? "am" : "pm";
        const quarterLabels = quarters.map((q, qi) => ({
          label: `${h12}:${(qi * 15).toString().padStart(2, "0")}${ampm}`,
          orders: q.orders,
          sales: Math.round(q.sales * 100) / 100,
        }));

        // Classify load profile based on order distribution across quarters
        const maxQ = Math.max(...quarters.map((q) => q.orders));
        const minQ = Math.min(...quarters.map((q) => q.orders));
        const loadProfile =
          totalOrders === 0
            ? "none"
            : maxQ - minQ <= 2
              ? "steady"
              : quarters[0].orders + quarters[1].orders > quarters[2].orders + quarters[3].orders
                ? "front-loaded"
                : "back-loaded";

        hours.push({
          hour,
          quarters: quarterLabels,
          totalOrders,
          totalSales: Math.round(totalSales * 100) / 100,
          loadProfile,
        });
      }
      hours.sort((a, b) => a.hour - b.hour);
      result.push({ restaurantId, hours });
    }

    res.json({ restaurants: result });
  } catch (error) {
    console.error("Error computing demand curves:", error);
    res.status(500).json({ error: "Failed to compute demand curves" });
  }
});

// ─── Operator Schedule (Week View) ────────────────────────────────────────
// Shows which hours the operator is scheduled at each unit for the current
// Sat-Fri business week. Uses synced hourly labor data which includes
// _operatorScheduled flags from 7shifts scheduled shifts.
router.get("/api/analytics/operator-schedule", async (req, res) => {
  try {
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = centralFormatter.format(new Date());
    const today = new Date(todayStr + "T12:00:00");

    // Use Sat-Fri business week (matching weekly forecast)
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceSaturday = (dayOfWeek + 1) % 7;
    const saturday = new Date(today);
    saturday.setDate(today.getDate() - daysSinceSaturday);

    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(saturday);
      d.setDate(saturday.getDate() + i);
      days.push(d.toISOString().split("T")[0]);
    }
    const startDateStr = days[0];
    const endDateStr = days[6];

    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const activeIds = allRestaurants.map(r => r.id);

    if (activeIds.length === 0) {
      return res.json({ weekStart: startDateStr, weekEnd: endDateStr, dayLabels: [], restaurants: [] });
    }

    // Use raw SQL with statement timeout to avoid hanging
    // Query each restaurant individually using the composite index (restaurantId, date, hour)
    const operatorRows: { restaurantId: string; date: string; hour: number }[] = [];
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 10000'); // 10s timeout
      for (const rid of activeIds) {
        const result = await client.query(
          `SELECT restaurant_id, date, hour FROM hourly_labor
           WHERE restaurant_id = $1 AND date >= $2 AND date <= $3
             AND position_breakdown @> '{"_operatorScheduled": 1}'::jsonb`,
          [rid, startDateStr, endDateStr]
        );
        for (const row of result.rows) {
          operatorRows.push({ restaurantId: row.restaurant_id, date: row.date, hour: row.hour });
        }
      }
    } finally {
      client.release();
    }

    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    // Build operator schedule by restaurant and date
    const scheduleMap = new Map<string, Map<string, number[]>>();

    for (const row of operatorRows) {
      const rid = row.restaurantId;
      if (!restaurantNameMap.has(rid)) continue;

      if (!scheduleMap.has(rid)) scheduleMap.set(rid, new Map());
      const dateMap = scheduleMap.get(rid)!;
      if (!dateMap.has(row.date)) dateMap.set(row.date, []);
      dateMap.get(row.date)!.push(row.hour);
    }

    // Format response
    interface OperatorDay {
      date: string;
      dayName: string;
      hours: number[];
      startHour: number | null;
      endHour: number | null;
    }

    interface OperatorRestaurant {
      restaurantId: string;
      restaurantName: string;
      scheduledDays: number;
      totalHours: number;
      days: OperatorDay[];
    }

    const results: OperatorRestaurant[] = [];

    for (const [rid, dateMap] of scheduleMap) {
      const name = restaurantNameMap.get(rid);
      if (!name) continue;

      const dayResults: OperatorDay[] = days.map(dateStr => {
        const hours = dateMap.get(dateStr) || [];
        hours.sort((a, b) => a - b);
        return {
          date: dateStr,
          dayName: new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }),
          hours,
          startHour: hours.length > 0 ? hours[0] : null,
          endHour: hours.length > 0 ? hours[hours.length - 1] : null,
        };
      });

      const scheduledDays = dayResults.filter(d => d.hours.length > 0).length;
      const totalHours = dayResults.reduce((sum, d) => sum + d.hours.length, 0);

      results.push({
        restaurantId: rid,
        restaurantName: name,
        scheduledDays,
        totalHours,
        days: dayResults,
      });
    }

    // Sort: units with fewer scheduled days first (so you can see gaps)
    results.sort((a, b) => a.scheduledDays - b.scheduledDays || a.restaurantName.localeCompare(b.restaurantName));

    res.json({
      weekStart: startDateStr,
      weekEnd: endDateStr,
      dayLabels: days.map(d => ({
        date: d,
        dayName: new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }),
        isToday: d === todayStr,
      })),
      restaurants: results,
    });
  } catch (error) {
    console.error("Error fetching operator schedule:", error);
    res.status(500).json({ error: "Failed to fetch operator schedule" });
  }
});

export default router;
