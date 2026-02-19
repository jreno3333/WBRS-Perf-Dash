import { Router } from "express";
import { db, posDb } from "../db";
import { employees, restaurants, hourlySales, hourlyLabor, hmeTimerData, osatData as osatDataTable, posOrders, dailySuppressedSales, dailySales } from "@shared/schema";
import { eq, and, gte, lte, lt, sql } from "drizzle-orm";

const router = Router();

// ─── Employee Anniversaries ────────────────────────────────────────────────
// Returns employees whose work anniversary falls within the next N days
router.get("/api/analytics/anniversaries", async (req, res) => {
  try {
    const { days = "30" } = req.query;
    const numDays = Math.min(parseInt(String(days)) || 30, 365);

    const activeEmployees = await db.select().from(employees).where(eq(employees.active, true));
    const allRestaurants = await db.select().from(restaurants);
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

    // Get daily sales for both weeks (last Saturday through this Friday)
    const salesData = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      totalSales: sql<number>`sum(${hourlySales.actualSales}::numeric)`,
    })
    .from(hourlySales)
    .where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${lastSaturdayStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${fridayStr}`
    )
    .groupBy(hourlySales.restaurantId, hourlySales.salesDate);

    // Organize sales by date
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
        return { ...wd, actual, lastWeek, forecast: actual, source: "actual" as const };
      } else if (wd.isPast) {
        // Today: actual so far + remaining projected from LW
        actualTotal += actual;
        forecastTotal += Math.max(actual, lastWeek);
        return { ...wd, actual, lastWeek, forecast: Math.max(actual, lastWeek), source: "partial" as const };
      } else {
        // Future: use last week same day
        forecastTotal += lastWeek;
        return { ...wd, actual: 0, lastWeek, forecast: lastWeek, source: "projected" as const };
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

    // Fetch all hourly data for the window
    const allSalesData = await db.select().from(hourlySales).where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${extStartStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${todayStr}`
    );

    const allLaborData = await db.select().from(hourlyLabor).where(
      and(sql`${hourlyLabor.date} >= ${startDateStr}`, sql`${hourlyLabor.date} <= ${todayStr}`)
    );

    const allHmeData = await db.select().from(hmeTimerData).where(
      and(gte(hmeTimerData.date, startDateStr), lte(hmeTimerData.date, todayStr))
    );

    const allOsatData = await db.select().from(osatDataTable).where(
      and(gte(osatDataTable.date, startDateStr), lte(osatDataTable.date, todayStr))
    );

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

    const hmeByKey = new Map<string, number>();
    for (const h of allHmeData) {
      if (h.avgTotalTime > 0 && h.carCount > 0) {
        hmeByKey.set(`${h.restaurantId}-${h.date}-${h.hour}`, h.avgTotalTime);
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

    // Grade calculation aligned with performance-history.ts
    const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 };

    function computeHourlyGrade(
      salesVariancePct: number, speedSec: number | undefined,
      staffingDiff: number, hasComparableSales: boolean,
      hasValidStaffing: boolean, osatPercent: number | undefined
    ): number | null {
      const components: { score: number; weight: number }[] = [];

      if (hasComparableSales) {
        components.push({ score: salesVariancePct >= -5 ? 100 : 50, weight: GRADE_WEIGHTS.sales });
      }
      if (speedSec !== undefined && speedSec > 0) {
        const speedScore = speedSec > 420 ? 40 : speedSec > 300 ? 70 : 100;
        components.push({ score: speedScore, weight: GRADE_WEIGHTS.speed });
      }
      if (osatPercent !== undefined && osatPercent > 0) {
        const osatScore = osatPercent < 80 ? 40 : osatPercent < 85 ? 70 : 100;
        components.push({ score: osatScore, weight: GRADE_WEIGHTS.osat });
      }
      if (hasValidStaffing) {
        const isSurge = salesVariancePct >= 20;
        let staffScore = 100;
        if (staffingDiff > 1) staffScore = 60;
        else if (staffingDiff < -1 && !isSurge) staffScore = 60;
        components.push({ score: staffScore, weight: GRADE_WEIGHTS.staffing });
      }
      if (components.length === 0) return null;
      const totalWeight = components.reduce((s, c) => s + c.weight, 0);
      return components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
    }

    function scoreToLabel(score: number): string {
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

    // Build date range for the analysis window
    const dateRange: string[] = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      dateRange.push(d.toISOString().split("T")[0]);
    }

    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
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

          const speed = hmeByKey.get(key);
          const osat = osatByKey.get(key);
          const osatPct = osat ? osat.percent : undefined;

          const grade = computeHourlyGrade(
            salesVariance, speed, staffingDiff,
            hasComparable, hasValidStaffing, osatPct
          );

          if (grade !== null) {
            hourlyScores.push(grade);
            daysWithData.add(dateStr2);
            const label = scoreToLabel(grade);
            if (label === "D" || label === "F") dfCount++;
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
        avgGradeLabel: scoreToLabel(avg),
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

    const laborData = await db.select().from(hourlyLabor).where(
      and(
        sql`${hourlyLabor.date} >= ${startDateStr}`,
        sql`${hourlyLabor.date} <= ${endDateStr}`
      )
    );

    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
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

    // Fetch hourly sales, labor, and HME for today
    const salesData = await db.select().from(hourlySales).where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${todayStr}`
    );
    const laborData = await db.select().from(hourlyLabor).where(
      eq(hourlyLabor.date, todayStr)
    );
    const hmeData = await db.select().from(hmeTimerData).where(
      eq(hmeTimerData.date, todayStr)
    );

    // Build lookups
    const laborByKey = new Map<string, typeof laborData[0]>();
    for (const l of laborData) laborByKey.set(`${l.restaurantId}-${l.hour}`, l);

    const hmeByKey = new Map<string, typeof hmeData[0]>();
    for (const h of hmeData) hmeByKey.set(`${h.restaurantId}-${h.hour}`, h);

    // Last week sales for comparison
    const lwDate = new Date(todayStr + "T12:00:00");
    lwDate.setDate(lwDate.getDate() - 7);
    const lwStr = lwDate.toISOString().split("T")[0];

    const lwSalesData = await db.select().from(hourlySales).where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${lwStr}`
    );
    const lwByKey = new Map<string, number>();
    for (const s of lwSalesData) {
      lwByKey.set(`${s.restaurantId}-${s.hour}`, Number(s.actualSales) || 0);
    }

    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    // Fetch dailySales for all restaurants — used as denominator for accurate % lost
    const todayStart = new Date(todayStr + "T00:00:00");
    const todayEnd = new Date(todayStr + "T23:59:59");
    const allDailySales = await db.select().from(dailySales).where(
      and(gte(dailySales.salesDate, todayStart), lte(dailySales.salesDate, todayEnd))
    );
    const dailySalesByRestaurant = new Map<string, number>();
    for (const d of allDailySales) {
      dailySalesByRestaurant.set(d.restaurantId, (parseFloat(d.totalSales || "0") / 100));
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
    const companyTotalSales = allDailySales.reduce((s, d) => s + (parseFloat(d.totalSales || "0") / 100), 0);
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
    const { date, restaurantId } = req.query;
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = date ? String(date) : centralFormatter.format(new Date());

    const startOfDay = new Date(todayStr + "T00:00:00.000Z");
    const endOfDay = new Date(todayStr + "T23:59:59.999Z");

    const allRestaurants = await db.select().from(restaurants);
    const storeToRestaurant = new Map<string, { id: string; timezone: string; name: string }>();
    for (const r of allRestaurants) {
      const match = r.name.match(/^(\d{4})\s*-/);
      if (match) {
        storeToRestaurant.set(match[1], { id: r.id, timezone: r.timezone || 'America/Chicago', name: r.name });
      }
    }

    // Build timezone groups
    const timezoneSet = new Set<string>();
    storeToRestaurant.forEach(info => timezoneSet.add(info.timezone));

    // Query POS orders grouped by 15-minute buckets
    const allResults: { restaurantId: string; restaurantName: string; hour: number; quarter: number; orders: number; sales: number }[] = [];

    for (const tz of timezoneSet) {
      const storesInTz: string[] = [];
      storeToRestaurant.forEach((info, storeNum) => {
        if (info.timezone === tz) {
          if (!restaurantId || info.id === String(restaurantId)) {
            storesInTz.push(storeNum);
          }
        }
      });
      if (storesInTz.length === 0) continue;

      const hourExpr = sql.raw(`extract(hour from (order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::int`);
      const minuteExpr = sql.raw(`floor(extract(minute from (order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}') / 15)::int`);

      const posResults = await posDb
        .select({
          storeNumber: posOrders.storeNumber,
          hour: sql<number>`${hourExpr}`,
          quarter: sql<number>`${minuteExpr}`,
          orderCount: sql<number>`count(*)::int`,
          totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
        })
        .from(posOrders)
        .where(
          and(
            gte(posOrders.businessDate, startOfDay),
            lt(posOrders.businessDate, endOfDay),
            sql`${posOrders.storeNumber} = ANY(ARRAY[${sql.raw(storesInTz.map(s => `'${s}'`).join(','))}])`
          )
        )
        .groupBy(posOrders.storeNumber, sql`${hourExpr}`, sql`${minuteExpr}`);

      for (const row of posResults) {
        const info = storeToRestaurant.get(row.storeNumber);
        if (!info) continue;
        allResults.push({
          restaurantId: info.id,
          restaurantName: info.name,
          hour: row.hour,
          quarter: row.quarter,
          orders: row.orderCount,
          sales: Number(row.totalSales) || 0,
        });
      }
    }

    // Organize by restaurant, then by hour
    const byRestaurant = new Map<string, {
      restaurantName: string;
      hours: Map<number, { q0: { orders: number; sales: number }; q1: { orders: number; sales: number }; q2: { orders: number; sales: number }; q3: { orders: number; sales: number } }>;
    }>();

    for (const row of allResults) {
      if (!byRestaurant.has(row.restaurantId)) {
        byRestaurant.set(row.restaurantId, { restaurantName: row.restaurantName, hours: new Map() });
      }
      const rest = byRestaurant.get(row.restaurantId)!;
      if (!rest.hours.has(row.hour)) {
        rest.hours.set(row.hour, {
          q0: { orders: 0, sales: 0 }, q1: { orders: 0, sales: 0 },
          q2: { orders: 0, sales: 0 }, q3: { orders: 0, sales: 0 },
        });
      }
      const hourData = rest.hours.get(row.hour)!;
      const qKey = `q${row.quarter}` as 'q0' | 'q1' | 'q2' | 'q3';
      hourData[qKey] = { orders: row.orders, sales: Math.round(row.sales * 100) / 100 };
    }

    // Build response
    const restaurantList: any[] = [];
    byRestaurant.forEach((data, rid) => {
      const hours: any[] = [];
      data.hours.forEach((quarters, hour) => {
        const totalOrders = quarters.q0.orders + quarters.q1.orders + quarters.q2.orders + quarters.q3.orders;
        const totalSales = quarters.q0.sales + quarters.q1.sales + quarters.q2.sales + quarters.q3.sales;
        const frontHalf = quarters.q0.orders + quarters.q1.orders;
        const backHalf = quarters.q2.orders + quarters.q3.orders;
        const loadProfile = totalOrders > 0
          ? (frontHalf > backHalf * 1.2 ? "front-loaded" : backHalf > frontHalf * 1.2 ? "back-loaded" : "balanced")
          : "no-data";

        hours.push({
          hour,
          quarters: [
            { label: ":00-:14", ...quarters.q0 },
            { label: ":15-:29", ...quarters.q1 },
            { label: ":30-:44", ...quarters.q2 },
            { label: ":45-:59", ...quarters.q3 },
          ],
          totalOrders,
          totalSales: Math.round(totalSales),
          loadProfile,
        });
      });
      hours.sort((a, b) => a.hour - b.hour);
      restaurantList.push({ restaurantId: rid, restaurantName: data.restaurantName, hours });
    });

    res.json({
      date: todayStr,
      restaurants: restaurantList,
    });
  } catch (error) {
    console.error("Error computing demand curves:", error);
    res.status(500).json({ error: "Failed to compute demand curves" });
  }
});

export default router;
