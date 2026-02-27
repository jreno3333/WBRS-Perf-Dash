import { Router } from "express";
import { db } from "../db";
import { restaurants, employees, hourlyCrew, hourlyLabor, hourlySales, hmeTimerData, osatData as osatDataTable } from "@shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getAllHourlyPosSalesRange } from "../xenial-webhook";

const router = Router();

// Sync employees from 7shifts
router.post("/api/crew/sync-employees", async (req, res) => {
  try {
    const { syncEmployees } = await import("../scraper/7shifts-api");
    const result = await syncEmployees();
    res.json(result);
  } catch (error) {
    console.error("Error syncing employees:", error);
    res.status(500).json({ error: "Failed to sync employees" });
  }
});

// Sync hourly crew data for a specific date
router.post("/api/crew/sync", async (req, res) => {
  try {
    const date = req.body?.date || req.query?.date;
    const { syncHourlyCrew } = await import("../scraper/7shifts-api");
    const targetDate = date ? new Date(String(date)) : undefined;
    const result = await syncHourlyCrew(targetDate);
    res.json(result);
  } catch (error) {
    console.error("Error syncing crew data:", error);
    res.status(500).json({ error: "Failed to sync crew data" });
  }
});

// Get crew experience data for all restaurants on a specific date
router.get("/api/crew/experience", async (req, res) => {
  try {
    const { date } = req.query;
    const dateStr = date ? String(date) : new Date().toISOString().split('T')[0];

    const { formatTenure, formatTenureMix } = await import("../scraper/7shifts-api");

    const allRestaurants = await db.select().from(restaurants);

    const crewData = await db
      .select()
      .from(hourlyCrew)
      .where(eq(hourlyCrew.date, dateStr));

    const allEmployees = await db.select().from(employees).where(eq(employees.active, true));

    const restaurantCrewMap = new Map<string, typeof crewData>();
    for (const row of crewData) {
      const existing = restaurantCrewMap.get(row.restaurantId) || [];
      existing.push(row);
      restaurantCrewMap.set(row.restaurantId, existing);
    }

    const result = allRestaurants.map(r => {
      const hourlyData = restaurantCrewMap.get(r.id) || [];

      let totalMonths = 0;
      let totalCrew = 0;

      const hourlyFormatted = hourlyData.map(h => {
        const members = (h.crewMembers as any[]) || [];
        totalCrew += members.length;
        members.forEach(m => totalMonths += m.tenureMonths || 0);

        return {
          hour: h.hour,
          label: `${h.hour === 0 ? 12 : h.hour > 12 ? h.hour - 12 : h.hour}${h.hour < 12 ? 'am' : 'pm'}`,
          crewCount: h.crewCount,
          avgTenure: formatTenure(Number(h.avgTenureMonths) || 0),
          score: h.experienceScore || 0,
          mix: formatTenureMix(h.tenureMix as any || { trainee: 0, developing: 0, experienced: 0, veteran: 0 }),
          team: members.map(m => ({
            name: `${m.firstName} ${m.lastName?.charAt(0) || ''}.`,
            tenureMonths: m.tenureMonths,
            category: m.category as 'trainee' | 'developing' | 'experienced' | 'veteran',
          })),
        };
      }).sort((a, b) => a.hour - b.hour);

      const avgTenureMonths = totalCrew > 0 ? totalMonths / totalCrew : 0;

      return {
        restaurantId: r.id,
        restaurantName: r.name,
        employeeCount: allEmployees.filter(e => e.restaurantId === r.id).length,
        avgTenure: formatTenure(avgTenureMonths),
        avgScore: hourlyFormatted.length > 0
          ? Math.round(hourlyFormatted.reduce((sum, h) => sum + h.score, 0) / hourlyFormatted.length)
          : 0,
        hourly: hourlyFormatted,
      };
    });

    const dataMap: Record<string, { hour: number; crewCount: number; experienceScore: number; tenureMix: { trainee: number; developing: number; experienced: number; veteran: number } }[]> = {};
    for (const r of result) {
      if (r.hourly.length > 0) {
        dataMap[r.restaurantId] = r.hourly.map(h => ({
          hour: h.hour,
          crewCount: h.crewCount,
          experienceScore: h.score,
          tenureMix: (restaurantCrewMap.get(r.restaurantId)?.find(d => d.hour === h.hour)?.tenureMix as any) || { trainee: 0, developing: 0, experienced: 0, veteran: 0 },
        }));
      }
    }

    res.json({ date: dateStr, restaurants: result, data: dataMap });
  } catch (error) {
    console.error("Error fetching crew experience:", error);
    res.status(500).json({ error: "Failed to fetch crew experience data" });
  }
});

// Get crew experience summary for leaderboard (daily average scores)
router.get("/api/crew/summary", async (req, res) => {
  try {
    const { date } = req.query;
    const dateStr = date ? String(date) : new Date().toISOString().split('T')[0];

    const crewData = await db
      .select({
        restaurantId: hourlyCrew.restaurantId,
        avgScore: sql<number>`avg(${hourlyCrew.experienceScore})`,
        avgCrewCount: sql<number>`avg(${hourlyCrew.crewCount})`,
        avgTenureMonths: sql<number>`avg(${hourlyCrew.avgTenureMonths}::numeric)`,
        hourCount: sql<number>`count(*)`,
      })
      .from(hourlyCrew)
      .where(eq(hourlyCrew.date, dateStr))
      .groupBy(hourlyCrew.restaurantId);

    const summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> = {};
    for (const row of crewData) {
      summary[row.restaurantId] = {
        avgScore: Math.round(Number(row.avgScore) || 0),
        avgCrewCount: Math.round((Number(row.avgCrewCount) || 0) * 10) / 10,
        avgTenureMonths: Math.round((Number(row.avgTenureMonths) || 0) * 10) / 10,
      };
    }

    res.json({ date: dateStr, summary });
  } catch (error) {
    console.error("Error fetching crew summary:", error);
    res.status(500).json({ error: "Failed to fetch crew summary" });
  }
});

// Get manager/supervisor performance rankings
router.get("/api/people/performance", async (req, res) => {
  try {
    const { date, days = "7", restaurantId: filterRestaurantId, search: searchQuery, position: positionFilter } = req.query;

    // Exclude current day (Central Time) — partial day data creates misleading
    // scores. Matches leader-detail.ts so both views use the same date range.
    const now = new Date();
    const todayCentral = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const yesterdayCentral = new Date(`${todayCentral}T12:00:00Z`);
    yesterdayCentral.setDate(yesterdayCentral.getDate() - 1);

    let endDate = date ? new Date(String(date)) : yesterdayCentral;
    const endDateCheck = endDate.toISOString().split('T')[0];
    if (endDateCheck >= todayCentral) {
      endDate = yesterdayCentral;
    }

    const numDays = Math.min(parseInt(String(days)) || 7, 180);

    const getScalingRequirements = (periodDays: number): { minHours: number; minSurveys: number } => {
      if (periodDays <= 7) return { minHours: 30, minSurveys: 2 };
      if (periodDays <= 14) return { minHours: 40, minSurveys: 4 };
      if (periodDays <= 30) return { minHours: 60, minSurveys: 8 };
      if (periodDays <= 60) return { minHours: 100, minSurveys: 14 };
      if (periodDays <= 90) return { minHours: 140, minSurveys: 20 };
      return { minHours: 200, minSurveys: 30 };
    };

    const { minHours: MIN_HOURS_REQUIRED, minSurveys: MIN_SURVEYS_REQUIRED } = getScalingRequirements(numDays);

    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numDays + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const leaderEmployees = await db
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.active, true),
          sql`(${employees.position} ILIKE '%manager%' OR ${employees.position} ILIKE '%supervisor%' OR ${employees.type} IN ('manager', 'asst_manager'))`,
          sql`${employees.position} NOT ILIKE '%team member trainer%'`
        )
      );

    if (leaderEmployees.length === 0) {
      return res.json({
        dateRange: { start: startDateStr, end: endDateStr },
        byStore: {},
        companyRankings: [],
      });
    }

    const crewData = await db
      .select()
      .from(hourlyCrew)
      .where(
        and(
          gte(hourlyCrew.date, startDateStr),
          sql`${hourlyCrew.date} <= ${endDateStr}`
        )
      );

    const laborData = await db
      .select()
      .from(hourlyLabor)
      .where(
        and(
          gte(hourlyLabor.date, startDateStr),
          sql`${hourlyLabor.date} <= ${endDateStr}`
        )
      );

    const extendedStartDate = new Date(startDate);
    extendedStartDate.setDate(extendedStartDate.getDate() - 7);
    const extendedStartDateStr = extendedStartDate.toISOString().split('T')[0];

    // Use POS orders as primary sales source (matches dashboard leaders.ts)
    const posSalesByKey = await getAllHourlyPosSalesRange(extendedStartDateStr, endDateStr);

    // Also fetch 7shifts hourly_sales as fallback
    const salesData = await db
      .select()
      .from(hourlySales)
      .where(
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
    for (const l of laborData) {
      laborByKey.set(`${l.restaurantId}-${l.date}-${l.hour}`, l);
    }

    const salesByKey = new Map<string, typeof salesData[0]>();
    for (const s of salesData) {
      const dateStr = s.salesDate.toISOString().split('T')[0];
      salesByKey.set(`${s.restaurantId}-${dateStr}-${s.hour}`, s);
    }

    const hmeByKey = new Map<string, typeof hmeData[0]>();
    for (const h of hmeData) {
      hmeByKey.set(`${h.restaurantId}-${h.date}-${h.hour}`, h);
    }

    const osatByKey = new Map<string, typeof hourlyOsatData[0]>();
    for (const o of hourlyOsatData) {
      osatByKey.set(`${o.restaurantId}-${o.date}-${o.hour}`, o);
    }

    type LeaderPerformance = {
      employeeId: string;
      name: string;
      position: string;
      restaurantId: string;
      restaurantName: string;
      hoursWorked: number;
      avgGradeScore: number;
      grade: string;
      avgTransactionsPerHour: number | null;
      surveyResponses: number;
    };

    const allRestaurants = await db.select().from(restaurants);
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    const leaderPerformance: LeaderPerformance[] = [];

    for (const leader of leaderEmployees) {
      const userId = leader.sevenShiftsUserId;

      const dailyAggregates = new Map<string, {
        restaurantId: string;
        totalSalesToday: number;
        totalSalesLastWeek: number;
        staffingDiffs: number[];
        speedCars: { carCount: number; carsUnder6Min: number }[];
        osatWeighted: { percent: number; responses: number }[];
        hoursCount: number;
      }>();
      const workedAtRestaurants = new Map<string, number>();
      let totalHoursWorked = 0;
      let totalSalesAllHours = 0;
      let totalSurveyResponses = 0;

      for (const crew of crewData) {
        const members = (crew.crewMembers as any[]) || [];
        const wasWorking = members.some(m => m.userId === userId);

        if (wasWorking) {
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
                staffingDiffs: [], speedCars: [], osatWeighted: [], hoursCount: 0,
              });
            }
            const day = dailyAggregates.get(dayKey)!;
            day.hoursCount++;

            day.totalSalesToday += hourSales;

            // Look up last week's sales — POS first, then 7shifts fallback
            const crewDate = new Date(crew.date + 'T12:00:00');
            const lastWeekDate = new Date(crewDate);
            lastWeekDate.setDate(lastWeekDate.getDate() - 7);
            const lastWeekDateStr = lastWeekDate.toISOString().split('T')[0];
            const posLastWeekKey = `${crew.restaurantId}-${lastWeekDateStr}-${crew.hour}`;
            const posLastWeekSales = posSalesByKey.get(posLastWeekKey);
            const fallbackLastWeekSales = salesByKey.get(posLastWeekKey);
            day.totalSalesLastWeek += posLastWeekSales !== undefined ? posLastWeekSales : (fallbackLastWeekSales ? Number(fallbackLastWeekSales.actualSales) || 0 : 0);

            const actualStaff = Number(labor.employeeCount) || 0;
            const projectedStaff = (Number(labor.projectedLabor) || 0) / 10;
            day.staffingDiffs.push(actualStaff - projectedStaff);

            if (hme && hme.carCount > 0 && (hme.carsUnder6Min || 0) > 0) {
              day.speedCars.push({ carCount: hme.carCount, carsUnder6Min: hme.carsUnder6Min || 0 });
            }

            const osatPercent = osatHour && osatHour.totalResponses > 0 ? Number(osatHour.osatPercent) : undefined;
            const osatResponses = osatHour && osatHour.totalResponses > 0 ? osatHour.totalResponses : 0;
            if (osatPercent !== undefined) {
              day.osatWeighted.push({ percent: osatPercent, responses: osatResponses });
              totalSurveyResponses += osatResponses;
            }
          }
        }
      }

      const dailyGrades: { score: number; hours: number }[] = [];
      for (const [, day] of Array.from(dailyAggregates)) {
        const hasComparableSales = day.totalSalesLastWeek > 0;
        let salesVariancePct = hasComparableSales
          ? ((day.totalSalesToday - day.totalSalesLastWeek) / day.totalSalesLastWeek) * 100
          : 0;
        if (hasComparableSales) {
          salesVariancePct = Math.max(-200, Math.min(200, salesVariancePct));
        }
        const avgStaffingDiff = day.staffingDiffs.reduce((a: number, b: number) => a + b, 0) / day.staffingDiffs.length;
        const totalCars = day.speedCars.reduce((s: number, h: { carCount: number; carsUnder6Min: number }) => s + h.carCount, 0);
        const totalUnder6 = day.speedCars.reduce((s: number, h: { carCount: number; carsUnder6Min: number }) => s + h.carsUnder6Min, 0);
        const avgSpeed = totalCars > 0 ? Math.round((totalUnder6 / totalCars) * 100) : undefined;
        const totalOsatResponses = day.osatWeighted.reduce((s: number, o: { percent: number; responses: number }) => s + o.responses, 0);
        const osatPercent = totalOsatResponses > 0
          ? day.osatWeighted.reduce((s: number, o: { percent: number; responses: number }) => s + o.percent * o.responses, 0) / totalOsatResponses
          : undefined;
        const salesSurge = salesVariancePct >= 20;

        const components: { weight: number; score: number }[] = [];
        if (hasComparableSales) {
          components.push({ weight: 35, score: salesVariancePct >= -5 ? 100 : 50 });
        } else {
          components.push({ weight: 35, score: 100 });
        }
        const effectiveSurge = salesSurge || !hasComparableSales;
        let staffingScore = 100;
        if (Math.abs(avgStaffingDiff) <= 1) staffingScore = 100;
        else if (avgStaffingDiff > 1) staffingScore = 60;
        else staffingScore = effectiveSurge ? 100 : 60;
        components.push({ weight: 15, score: staffingScore });
        if (avgSpeed !== undefined) {
          let speedScore = 100;
          if (avgSpeed < 50) speedScore = 40;
          else if (avgSpeed < 70) speedScore = 70;
          components.push({ weight: 25, score: speedScore });
        }
        if (osatPercent !== undefined) {
          let osatScore = 100;
          if (osatPercent < 80) osatScore = 40;
          else if (osatPercent < 85) osatScore = 70;
          components.push({ weight: 25, score: osatScore });
        }

        if (components.length > 0) {
          const totalWeight = components.reduce((s, c) => s + c.weight, 0);
          const score = components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
          dailyGrades.push({ score, hours: day.hoursCount });
        }
      }

      if (totalHoursWorked >= MIN_HOURS_REQUIRED && totalSurveyResponses >= MIN_SURVEYS_REQUIRED && dailyGrades.length > 0) {
        const totalGradeHours = dailyGrades.reduce((s, d) => s + d.hours, 0);
        const avgScoreRaw = dailyGrades.reduce((s, d) => s + d.score * d.hours, 0) / totalGradeHours;
        const avgScore = Math.round(avgScoreRaw);

        let grade = 'F';
        if (avgScore >= 97) grade = 'A+';
        else if (avgScore >= 93) grade = 'A';
        else if (avgScore >= 90) grade = 'A-';
        else if (avgScore >= 87) grade = 'B+';
        else if (avgScore >= 83) grade = 'B';
        else if (avgScore >= 80) grade = 'B-';
        else if (avgScore >= 77) grade = 'C+';
        else if (avgScore >= 73) grade = 'C';
        else if (avgScore >= 70) grade = 'C-';
        else if (avgScore >= 67) grade = 'D+';
        else if (avgScore >= 63) grade = 'D';
        else if (avgScore >= 60) grade = 'D-';

        let primaryRestaurantId = '';
        let maxHours = 0;
        workedAtRestaurants.forEach((hours, rid) => {
          if (hours > maxHours) {
            maxHours = hours;
            primaryRestaurantId = rid;
          }
        });

        const restaurantName = restaurantNameMap.get(primaryRestaurantId) || '';

        if (!primaryRestaurantId || !restaurantName) {
          continue;
        }

        let displayPosition = leader.position || '';
        if (!displayPosition) {
          if (leader.type === 'asst_manager') displayPosition = 'Manager';
          else if (leader.type === 'manager') displayPosition = 'Manager';
          else displayPosition = 'Leader';
        }
        if (displayPosition === 'asst_manager') displayPosition = 'Manager';
        if (displayPosition.toLowerCase().includes('supervisor')) displayPosition = 'Shift Supervisor';
        else if (displayPosition.toLowerCase().includes('manager')) displayPosition = 'Manager';
        // Fallback: if position doesn't normalize, use employee type to classify
        if (displayPosition !== 'Manager' && displayPosition !== 'Shift Supervisor') {
          if (displayPosition.toLowerCase().includes('team member')) continue;
          displayPosition = (leader.type === 'manager' || leader.type === 'asst_manager') ? 'Manager' : 'Shift Supervisor';
        }

        leaderPerformance.push({
          employeeId: leader.id,
          name: `${leader.firstName} ${leader.lastName}`,
          position: displayPosition,
          restaurantId: primaryRestaurantId,
          restaurantName: restaurantName,
          hoursWorked: totalHoursWorked,
          avgGradeScore: Math.round(avgScore),
          grade,
          avgTransactionsPerHour: totalHoursWorked > 0 ? Math.round(totalSalesAllHours / totalHoursWorked) : null,
          surveyResponses: totalSurveyResponses,
        });
      }
    }

    leaderPerformance.sort((a, b) => b.avgGradeScore - a.avgGradeScore);

    let filtered = leaderPerformance;
    if (positionFilter) {
      const pf = String(positionFilter).toLowerCase();
      filtered = filtered.filter(lp => {
        if (pf === 'manager') return lp.position.toLowerCase().includes('manager');
        if (pf === 'ss') return lp.position.toLowerCase().includes('supervisor');
        return true;
      });
    }
    if (filterRestaurantId) {
      filtered = filtered.filter(lp => lp.restaurantId === String(filterRestaurantId));
    }
    if (searchQuery) {
      const q = String(searchQuery).toLowerCase();
      filtered = filtered.filter(lp => lp.name.toLowerCase().includes(q));
    }

    const byStore: Record<string, LeaderPerformance[]> = {};
    for (const lp of filtered) {
      if (lp.restaurantId) {
        if (!byStore[lp.restaurantId]) {
          byStore[lp.restaurantId] = [];
        }
        byStore[lp.restaurantId].push(lp);
      }
    }

    for (const rid of Object.keys(byStore)) {
      byStore[rid].sort((a, b) => b.avgGradeScore - a.avgGradeScore);
    }

    const leadersWithVolume = leaderPerformance.filter(lp => lp.avgTransactionsPerHour !== null);
    const totalWeightedSales = leadersWithVolume.reduce((s, lp) => s + (lp.avgTransactionsPerHour as number) * lp.hoursWorked, 0);
    const totalWeightedHours = leadersWithVolume.reduce((s, lp) => s + lp.hoursWorked, 0);
    const companyAvgHourlyVolume = totalWeightedHours > 0
      ? Math.round(totalWeightedSales / totalWeightedHours)
      : null;

    res.json({
      dateRange: { start: startDateStr, end: endDateStr },
      byStore,
      companyRankings: filtered,
      companyAvgHourlyVolume,
      requirements: { minHours: MIN_HOURS_REQUIRED, minSurveys: MIN_SURVEYS_REQUIRED },
    });
  } catch (error) {
    console.error("Error fetching people performance:", error);
    res.status(500).json({ error: "Failed to fetch people performance data" });
  }
});

export default router;
