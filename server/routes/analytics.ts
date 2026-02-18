import { Router } from "express";
import { db, posDb } from "../db";
import { employees, restaurants, hourlySales, hourlyLabor, hmeTimerData, osatData as osatDataTable, posOrders } from "@shared/schema";
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

    // Get day of week (0=Sun, 1=Mon, ... 6=Sat). CFA closed Sunday.
    const dayOfWeek = today.getDay();
    // Monday=1, Saturday=6. Compute Monday of this week.
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Sunday -> last Monday
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    // Build an array for Mon-Sat (6 business days)
    const weekDays: { date: string; dayName: string; isComplete: boolean; isPast: boolean }[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dStr = d.toISOString().split("T")[0];
      weekDays.push({
        date: dStr,
        dayName: d.toLocaleDateString("en-US", { weekday: "long" }),
        isComplete: dStr < todayStr,
        isPast: dStr <= todayStr,
      });
    }

    // Fetch sales for this week and last week for projection
    const mondayStr = monday.toISOString().split("T")[0];
    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const lastMondayStr = lastMonday.toISOString().split("T")[0];
    const lastSatStr = (() => { const d = new Date(lastMonday); d.setDate(d.getDate() + 5); return d.toISOString().split("T")[0]; })();
    const satStr = (() => { const d = new Date(monday); d.setDate(d.getDate() + 5); return d.toISOString().split("T")[0]; })();

    // Get daily sales for both weeks
    const salesData = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      totalSales: sql<number>`sum(${hourlySales.actualSales}::numeric)`,
    })
    .from(hourlySales)
    .where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${lastMondayStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${satStr}`
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
      weekStart: mondayStr,
      weekEnd: satStr,
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
// Standard deviation of daily execution scores over a trailing window
router.get("/api/analytics/consistency", async (req, res) => {
  try {
    const { days = "14" } = req.query;
    const numDays = Math.min(parseInt(String(days)) || 14, 90);

    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const todayStr = centralFormatter.format(new Date());
    const startDate = new Date(todayStr + "T12:00:00");
    startDate.setDate(startDate.getDate() - numDays);
    const startDateStr = startDate.toISOString().split("T")[0];

    // Get daily sales with last week comparison for each restaurant
    const salesData = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      hour: hourlySales.hour,
      todaySales: sql<number>`${hourlySales.actualSales}::numeric`,
    })
    .from(hourlySales)
    .where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${startDateStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${todayStr}`
    );

    // Get last-week-extended sales for variance calc
    const extendedStartDate = new Date(startDate);
    extendedStartDate.setDate(extendedStartDate.getDate() - 7);
    const extStartStr = extendedStartDate.toISOString().split("T")[0];

    const lwSalesData = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      hour: hourlySales.hour,
      todaySales: sql<number>`${hourlySales.actualSales}::numeric`,
    })
    .from(hourlySales)
    .where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') >= ${extStartStr} AND to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') < ${startDateStr}`
    );

    // Build LW lookup
    const lwByKey = new Map<string, number>();
    for (const row of lwSalesData) {
      const d = row.salesDate.toISOString().split("T")[0];
      const key = `${row.restaurantId}-${d}-${row.hour}`;
      lwByKey.set(key, Number(row.todaySales) || 0);
    }

    // Compute daily sales variance per restaurant
    // Map: restaurantId -> dailyVariances[]
    const dailyVariances = new Map<string, number[]>();
    const dailySales = new Map<string, Map<string, { today: number; lw: number }>>();

    for (const row of salesData) {
      const d = row.salesDate.toISOString().split("T")[0];
      const rid = row.restaurantId;
      const sales = Number(row.todaySales) || 0;

      if (!dailySales.has(rid)) dailySales.set(rid, new Map());
      const rMap = dailySales.get(rid)!;
      if (!rMap.has(d)) rMap.set(d, { today: 0, lw: 0 });
      rMap.get(d)!.today += sales;

      // Find last week same day + hour
      const currentDate = new Date(d + "T12:00:00");
      const lwDate = new Date(currentDate);
      lwDate.setDate(lwDate.getDate() - 7);
      const lwDateStr = lwDate.toISOString().split("T")[0];
      const lwSales = lwByKey.get(`${rid}-${lwDateStr}-${row.hour}`) || 0;
      rMap.get(d)!.lw += lwSales;
    }

    // Calculate variance per day per restaurant
    for (const [rid, dates] of dailySales) {
      const variances: number[] = [];
      for (const [, totals] of dates) {
        if (totals.lw > 0) {
          const variance = ((totals.today - totals.lw) / totals.lw) * 100;
          variances.push(variance);
        }
      }
      if (variances.length > 0) {
        dailyVariances.set(rid, variances);
      }
    }

    // Calculate consistency score per restaurant
    // Low std deviation = high consistency = good
    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    interface ConsistencyResult {
      restaurantId: string;
      restaurantName: string;
      avgVariance: number;
      stdDeviation: number;
      consistencyScore: number; // 0-100, higher = more consistent
      daysAnalyzed: number;
    }

    const results: ConsistencyResult[] = [];

    for (const [rid, variances] of dailyVariances) {
      const name = restaurantNameMap.get(rid);
      if (!name || variances.length < 3) continue;

      const avg = variances.reduce((a, b) => a + b, 0) / variances.length;
      const sqDiffs = variances.map(v => Math.pow(v - avg, 2));
      const variance = sqDiffs.reduce((a, b) => a + b, 0) / variances.length;
      const stdDev = Math.sqrt(variance);

      // Convert std deviation to a 0-100 score
      // stdDev of 0 = 100 (perfect consistency), stdDev of 30+ = 0
      const consistencyScore = Math.max(0, Math.min(100, Math.round(100 - (stdDev * 100 / 30))));

      results.push({
        restaurantId: rid,
        restaurantName: name,
        avgVariance: Math.round(avg * 10) / 10,
        stdDeviation: Math.round(stdDev * 10) / 10,
        consistencyScore,
        daysAnalyzed: variances.length,
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

// ─── Scheduled vs Actual / Call-in Rate ────────────────────────────────────
// Compares projected (scheduled) labor cost vs actual labor cost by restaurant
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

    // Aggregate by restaurant
    const byRestaurant = new Map<string, {
      totalScheduledCost: number;
      totalActualCost: number;
      totalScheduledHours: number;
      totalActualHours: number;
      hoursUnder: number;  // hours where actual < projected significantly
      hoursOver: number;   // hours where actual > projected significantly
      totalHours: number;
    }>();

    for (const row of laborData) {
      const rid = row.restaurantId;
      if (!byRestaurant.has(rid)) {
        byRestaurant.set(rid, {
          totalScheduledCost: 0, totalActualCost: 0,
          totalScheduledHours: 0, totalActualHours: 0,
          hoursUnder: 0, hoursOver: 0, totalHours: 0,
        });
      }
      const entry = byRestaurant.get(rid)!;
      const scheduled = Number(row.projectedLabor) || 0;
      const actual = Number(row.actualLabor) || 0;
      const employees = Number(row.employeeCount) || 0;

      entry.totalScheduledCost += scheduled;
      entry.totalActualCost += actual;
      entry.totalActualHours += employees;

      // Use projected labor as a proxy for scheduled hours
      // Rough conversion: cost / avg_hourly_rate. We'll use the cost ratio instead.
      if (scheduled > 0) {
        entry.totalHours++;
        const ratio = actual / scheduled;
        if (ratio < 0.75) entry.hoursUnder++;     // 25%+ under-delivery
        else if (ratio > 1.25) entry.hoursOver++;  // 25%+ over-delivery
      }
    }

    interface ComplianceResult {
      restaurantId: string;
      restaurantName: string;
      scheduledLaborCost: number;
      actualLaborCost: number;
      compliancePercent: number;  // actual / scheduled * 100
      underHours: number;
      overHours: number;
      totalHours: number;
      callInRate: number;  // % of hours significantly understaffed
    }

    const results: ComplianceResult[] = [];

    for (const [rid, data] of byRestaurant) {
      const name = restaurantNameMap.get(rid);
      if (!name || data.totalHours === 0) continue;

      results.push({
        restaurantId: rid,
        restaurantName: name,
        scheduledLaborCost: Math.round(data.totalScheduledCost),
        actualLaborCost: Math.round(data.totalActualCost),
        compliancePercent: data.totalScheduledCost > 0
          ? Math.round((data.totalActualCost / data.totalScheduledCost) * 100)
          : 0,
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

    interface SuppressedSalesResult {
      restaurantId: string;
      restaurantName: string;
      estimatedLostSales: number;
      understaffedHours: number;
      slowDtHours: number;
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
        results.push({
          restaurantId: rid,
          restaurantName: name,
          estimatedLostSales: Math.round(totalLost),
          understaffedHours: understaffedCount,
          slowDtHours: slowDtCount,
          details,
        });
      }
    }

    results.sort((a, b) => b.estimatedLostSales - a.estimatedLostSales);

    const companyTotal = results.reduce((s, r) => s + r.estimatedLostSales, 0);

    res.json({
      date: todayStr,
      companyTotalSuppressed: companyTotal,
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
