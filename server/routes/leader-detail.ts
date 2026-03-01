import { Router } from "express";
import { db } from "../db";
import { employees, hourlyCrew, hourlyLabor, hourlySales, hmeTimerData, osatData as osatDataTable, restaurants } from "@shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getAllHourlyPosSalesRange, getAllHourlyPosOrderCountRange } from "../xenial-webhook";
import { getTotalRequiredStaff } from "../labor-model";
import { computeHourlyScore, scoreToGradeLabel, computeDailyScore } from "../lib/scoring";

const router = Router();

// Get daily performance detail for a specific leader
router.get("/api/people/leader-detail", async (req, res) => {
  try {
    const { employeeId, date, days = "14" } = req.query;
    if (!employeeId) {
      return res.status(400).json({ error: "employeeId is required" });
    }

    // Exclude current day (Central Time) - partial day data creates misleading variance
    const now = new Date();
    const todayCentral = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const yesterdayCentral = new Date(`${todayCentral}T12:00:00Z`);
    yesterdayCentral.setDate(yesterdayCentral.getDate() - 1);

    let endDate = date ? new Date(String(date)) : yesterdayCentral;
    const endDateCheck = endDate.toISOString().split('T')[0];
    if (endDateCheck >= todayCentral) {
      endDate = yesterdayCentral;
    }
    const numDays = Math.min(parseInt(String(days)) || 14, 180);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numDays + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    console.log(`[LEADER-DETAIL] Query: employeeId=${employeeId}, date=${date}, days=${days}, startDateStr=${startDateStr}, endDateStr=${endDateStr}`);

    const leader = await db.select().from(employees).where(eq(employees.id, String(employeeId))).limit(1);
    if (leader.length === 0) {
      return res.status(404).json({ error: "Leader not found" });
    }
    const leaderInfo = leader[0];
    const userId = leaderInfo.sevenShiftsUserId;

    const crewData = await db.select().from(hourlyCrew).where(
      and(gte(hourlyCrew.date, startDateStr), sql`${hourlyCrew.date} <= ${endDateStr}`)
    );
    
    // Debug: Check how many crew records match this leader
    const leaderCrewRecords = crewData.filter(c => {
      const members = (c.crewMembers as any[]) || [];
      return members.some((m: any) => m.userId === userId);
    });
    const leaderDates = [...new Set(leaderCrewRecords.map(c => c.date))].sort();
    console.log(`[LEADER-DETAIL] userId=${userId}, crewData total=${crewData.length}, leaderCrewRecords=${leaderCrewRecords.length}, dates=${leaderDates.join(', ')}`);

    const laborData = await db.select().from(hourlyLabor).where(
      and(gte(hourlyLabor.date, startDateStr), sql`${hourlyLabor.date} <= ${endDateStr}`)
    );

    // Extend sales range 7 days earlier to look up last week's sales for variance
    const detailExtStart = new Date(startDate);
    detailExtStart.setDate(detailExtStart.getDate() - 7);
    const detailExtStartStr = detailExtStart.toISOString().split('T')[0];

    // Use POS orders as primary sales source (includes 12am-5am hours)
    // Falls back to 7shifts hourly_sales only if POS data is unavailable
    const posSalesByKey = await getAllHourlyPosSalesRange(detailExtStartStr, endDateStr);

    // Fetch POS order counts for transaction variance scoring
    const posOrderCounts = await getAllHourlyPosOrderCountRange(detailExtStartStr, endDateStr);

    // Also fetch 7shifts hourly_sales as fallback
    const salesData = await db.select().from(hourlySales).where(
      and(
        gte(sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`, detailExtStartStr),
        sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${endDateStr}`
      )
    );

    const hmeData = await db.select().from(hmeTimerData).where(
      and(gte(hmeTimerData.date, startDateStr), lte(hmeTimerData.date, endDateStr))
    );

    // Use hourly OSAT data instead of daily aggregates
    const hourlyOsatData = await db.select().from(osatDataTable).where(
      and(gte(osatDataTable.date, startDateStr), lte(osatDataTable.date, endDateStr))
    );

    const allRestaurants = await db.select().from(restaurants);
    const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));

    const laborByKey = new Map<string, typeof laborData[0]>();
    for (const l of laborData) {
      laborByKey.set(`${l.restaurantId}-${l.date}-${l.hour}`, l);
    }
    const salesByKey = new Map<string, typeof salesData[0]>();
    for (const s of salesData) {
      const d = s.salesDate.toISOString().split('T')[0];
      salesByKey.set(`${s.restaurantId}-${d}-${s.hour}`, s);
    }
    const hmeByKey = new Map<string, typeof hmeData[0]>();
    for (const h of hmeData) {
      hmeByKey.set(`${h.restaurantId}-${h.date}-${h.hour}`, h);
    }
    const osatByKey = new Map<string, typeof hourlyOsatData[0]>();
    for (const o of hourlyOsatData) {
      osatByKey.set(`${o.restaurantId}-${o.date}-${o.hour}`, o);
    }

    type HourDetail = {
      hour: number;
      restaurantId: string;
      salesVariancePct: number;
      hasComparableSales: boolean;
      todaySales: number;
      lastWeekSales: number;
      speedSeconds?: number;
      speedAttainment?: number;
      carCount?: number;
      carsUnder6Min?: number;
      staffingDiff: number;
      actualStaff: number;
      requiredStaff: number;
      osatPercent?: number;
      osatResponses?: number;
      score: number;
    };

    const dailyMap = new Map<string, { restaurantId: string; hours: HourDetail[] }>();

    for (const crew of crewData) {
      const members = (crew.crewMembers as any[]) || [];
      const wasWorking = members.some((m: any) => m.userId === userId);
      if (!wasWorking) continue;

      const key = crew.date;
      if (!dailyMap.has(key)) {
        dailyMap.set(key, { restaurantId: crew.restaurantId, hours: [] });
      }
      const dayData = dailyMap.get(key)!;

      const labor = laborByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
      const hme = hmeByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
      const osatHour = osatByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);

      // Use POS orders as primary sales source, fall back to 7shifts
      const posKey = `${crew.restaurantId}-${crew.date}-${crew.hour}`;
      const posSales = posSalesByKey.get(posKey);
      const fallbackSales = salesByKey.get(posKey);
      const todaySales = posSales !== undefined ? posSales : (fallbackSales ? (Number(fallbackSales.actualSales) || 0) : 0);
      const hasSalesData = posSales !== undefined || (fallbackSales && Number(fallbackSales.actualSales) > 0);

      if (labor && hasSalesData && todaySales > 0) {

        // Look up last week's sales (7 days ago, same hour) — POS first, then 7shifts fallback
        const crewDate = new Date(crew.date + 'T12:00:00');
        const lastWeekDate = new Date(crewDate);
        lastWeekDate.setDate(lastWeekDate.getDate() - 7);
        const lastWeekDateStr = lastWeekDate.toISOString().split('T')[0];
        const posLastWeekKey = `${crew.restaurantId}-${lastWeekDateStr}-${crew.hour}`;
        const posLastWeekSales = posSalesByKey.get(posLastWeekKey);
        const fallbackLastWeekSales = salesByKey.get(posLastWeekKey);
        const lastWeekSales = posLastWeekSales !== undefined ? posLastWeekSales : (fallbackLastWeekSales ? Number(fallbackLastWeekSales.actualSales) || 0 : 0);

        const hasComparableSales = lastWeekSales > 0;
        const salesVariancePct = hasComparableSales
          ? ((todaySales - lastWeekSales) / lastWeekSales) * 100 : 0;

        const actualStaff = Number(labor.employeeCount) || 0;
        const requiredStaff = getTotalRequiredStaff(crew.hour, todaySales);
        const staffingDiff = actualStaff - requiredStaff;

        const speedSeconds = hme && hme.avgTotalTime > 0 ? hme.avgTotalTime : undefined;
        const hmeCarCount = hme && hme.carCount > 0 ? hme.carCount : undefined;
        const rawCarsUnder6 = hme ? (hme.carsUnder6Min || 0) : 0;
        const hasValidAttainmentData = hmeCarCount && hmeCarCount > 0 && rawCarsUnder6 > 0;
        const hmeCarsUnder6Min = hasValidAttainmentData ? rawCarsUnder6 : undefined;
        const hourSpeedAttainment = hasValidAttainmentData
          ? Math.round((rawCarsUnder6 / hmeCarCount!) * 100)
          : undefined;

        const hourOsatPercent = osatHour && osatHour.totalResponses > 0 ? Number(osatHour.osatPercent) : undefined;
        const hourOsatResponses = osatHour && osatHour.totalResponses > 0 ? osatHour.totalResponses : undefined;

        // Transaction data for this hour
        const txnKey = `${crew.restaurantId}-${crew.date}-${crew.hour}`;
        const txnLastWeekKey = `${crew.restaurantId}-${lastWeekDateStr}-${crew.hour}`;
        const hourTxnCount = posOrderCounts.get(txnKey) || 0;
        const hourTxnLastWeek = posOrderCounts.get(txnLastWeekKey) || 0;
        const hasComparableTransactions = hourTxnLastWeek > 0 && hourTxnCount > 0;
        const txnVariancePct = hasComparableTransactions
          ? ((hourTxnCount - hourTxnLastWeek) / hourTxnLastWeek) * 100 : undefined;

        const hourlyResult = computeHourlyScore({
          salesVariancePct,
          hasComparableSales,
          transactionVariancePct: txnVariancePct,
          hasComparableTransactions,
          speedAttainment: hourSpeedAttainment,
          staffingDiff,
          hasValidStaffing: true,
          osatPercent: hourOsatPercent,
          osatResponses: hourOsatResponses,
        });
        const score = hourlyResult.score;

        dayData.hours.push({
          hour: crew.hour,
          restaurantId: crew.restaurantId,
          salesVariancePct,
          hasComparableSales,
          todaySales,
          lastWeekSales,
          speedSeconds,
          speedAttainment: hourSpeedAttainment,
          carCount: hmeCarCount,
          carsUnder6Min: hmeCarsUnder6Min,
          staffingDiff,
          actualStaff,
          requiredStaff,
          osatPercent: hourOsatPercent,
          osatResponses: hourOsatResponses,
          score,
        });
      }
    }

    const getGradeLabel = scoreToGradeLabel;

    type DayFeedback = {
      wentWell: string[];
      needsImprovement: string[];
    };

    type HourGradeDetail = {
      hour: number;
      sales: number;
      lastWeekSales: number;
      variancePct: number;
      hasComparableSales: boolean;
      speedAttainment?: number;
      staffingDiff: number;
      actualStaff: number;
      requiredStaff: number;
      osatPercent?: number;
      gradeScore: number;
      gradeLabel: string;
    };

    type DailyDetail = {
      date: string;
      restaurantId: string;
      restaurantName: string;
      hoursWorked: number;
      gradeScore: number;
      gradeLabel: string;
      avgSalesVariance: number;
      totalSales: number;
      avgSpeed?: number;
      avgStaffingDiff: number;
      osatPercent?: number;
      osatResponses?: number;
      avgHourlyVolume: number;
      feedback: DayFeedback;
      hourlyGrades: HourGradeDetail[];
    };

    const dailyDetails: DailyDetail[] = [];
    const dailyRawScores = new Map<string, number>();

    const dailyEntries = Array.from(dailyMap.entries());
    for (const [dateKey, dayData] of dailyEntries) {
      if (dayData.hours.length === 0) continue;

      // Compute daily aggregates first
      const totalSales = dayData.hours.reduce((s: number, h: HourDetail) => s + h.todaySales, 0);
      const totalLastWeekSales = dayData.hours.reduce((s: number, h: HourDetail) => s + h.lastWeekSales, 0);
      const hasComparableSales = totalLastWeekSales > 0;
      let dailySalesVariancePct = hasComparableSales
        ? ((totalSales - totalLastWeekSales) / totalLastWeekSales) * 100
        : 0;
      if (hasComparableSales) {
        dailySalesVariancePct = Math.max(-200, Math.min(200, dailySalesVariancePct));
      }
      const avgStaffingDiff = dayData.hours.reduce((s: number, h: HourDetail) => s + h.staffingDiff, 0) / dayData.hours.length;
      const speedHours = dayData.hours.filter((h: HourDetail) => h.carCount !== undefined && h.carCount! > 0 && h.carsUnder6Min !== undefined && h.carsUnder6Min! > 0);
      let avgSpeed: number | undefined = undefined;
      let dailyAvgSpeedSeconds: number | undefined = undefined;
      if (speedHours.length > 0) {
        const totalCars = speedHours.reduce((s: number, h: HourDetail) => s + (h.carCount || 0), 0);
        const totalUnder6 = speedHours.reduce((s: number, h: HourDetail) => s + (h.carsUnder6Min || 0), 0);
        avgSpeed = totalCars > 0 ? Math.round((totalUnder6 / totalCars) * 100) : undefined;
        const totalSpeedSeconds = speedHours.reduce((s: number, h: HourDetail) => s + (h.speedSeconds || 0) * (h.carCount || 0), 0);
        dailyAvgSpeedSeconds = totalCars > 0 ? totalSpeedSeconds / totalCars : undefined;
      }

      const osatHours = dayData.hours.filter((h: HourDetail) => h.osatPercent !== undefined && h.osatResponses !== undefined && h.osatResponses > 0);
      let osatPercent: number | undefined = undefined;
      let osatResponses: number | undefined = undefined;
      if (osatHours.length > 0) {
        const totalOsatResponses = osatHours.reduce((s: number, h: HourDetail) => s + (h.osatResponses || 0), 0);
        const weightedOsat = osatHours.reduce((s: number, h: HourDetail) => s + (h.osatPercent || 0) * (h.osatResponses || 0), 0);
        osatPercent = totalOsatResponses > 0 ? weightedOsat / totalOsatResponses : undefined;
        osatResponses = totalOsatResponses;
      }

      // Compute daily grade from daily aggregates (not hourly average)
      const dailyResult = computeHourlyScore({
        salesVariancePct: dailySalesVariancePct,
        hasComparableSales,
        speedAttainment: avgSpeed,
        staffingDiff: avgStaffingDiff,
        hasValidStaffing: true,
        osatPercent,
        osatResponses,
      });
      const dailyGradeScore = dailyResult.score;
      dailyRawScores.set(dateKey, dailyGradeScore);

      const wentWell: string[] = [];
      const needsImprovement: string[] = [];

      if (hasComparableSales) {
        if (dailySalesVariancePct >= 5) {
          wentWell.push(`Sales were up ${dailySalesVariancePct.toFixed(1)}% compared to last week`);
        } else if (dailySalesVariancePct >= -5) {
          wentWell.push(`Sales were on track (${dailySalesVariancePct >= 0 ? '+' : ''}${dailySalesVariancePct.toFixed(1)}% vs last week)`);
        } else {
          needsImprovement.push(`Sales were down ${Math.abs(dailySalesVariancePct).toFixed(1)}% compared to last week`);
        }
      }

      if (avgSpeed !== undefined) {
        const timeStr = dailyAvgSpeedSeconds !== undefined
          ? `${Math.floor(dailyAvgSpeedSeconds / 60)}:${Math.round(dailyAvgSpeedSeconds % 60).toString().padStart(2, '0')}`
          : '';
        if (avgSpeed >= 70) {
          wentWell.push(`Drive-thru speed attainment was ${avgSpeed}%${timeStr ? ` (avg ${timeStr})` : ''}`);
        } else if (avgSpeed >= 50) {
          needsImprovement.push(`Drive-thru speed attainment was ${avgSpeed}%${timeStr ? ` (avg ${timeStr})` : ''} - aim for 70%+`);
        } else {
          needsImprovement.push(`Drive-thru speed attainment was only ${avgSpeed}%${timeStr ? ` (avg ${timeStr})` : ''} - needs significant improvement (target: 70%+)`);
        }
      }

      const salesSurge = dailySalesVariancePct >= 20;
      if (Math.abs(avgStaffingDiff) <= 1) {
        wentWell.push("Staffing levels were properly aligned with projections");
      } else if (avgStaffingDiff > 1) {
        needsImprovement.push(`Overstaffed by an average of ${avgStaffingDiff.toFixed(1)} employees per hour`);
      } else {
        if (salesSurge) {
          wentWell.push("Handled high sales volume despite being understaffed");
        } else {
          needsImprovement.push(`Understaffed by an average of ${Math.abs(avgStaffingDiff).toFixed(1)} employees per hour`);
        }
      }

      if (osatPercent !== undefined && osatResponses && osatResponses > 0) {
        if (osatPercent >= 85) {
          wentWell.push(`Customer satisfaction was ${osatPercent.toFixed(0)}% (${osatResponses} responses)`);
        } else if (osatPercent >= 80) {
          needsImprovement.push(`Customer satisfaction was ${osatPercent.toFixed(0)}% - close to target but room to improve (${osatResponses} responses)`);
        } else {
          needsImprovement.push(`Customer satisfaction was low at ${osatPercent.toFixed(0)}% (${osatResponses} responses) - needs attention`);
        }
      }

      if (wentWell.length === 0) {
        wentWell.push("Keep working on building consistency across all metrics");
      }

      const hourlyGrades: HourGradeDetail[] = dayData.hours
        .sort((a, b) => a.hour - b.hour)
        .map(h => ({
          hour: h.hour,
          sales: Math.round(h.todaySales * 100) / 100,
          lastWeekSales: Math.round(h.lastWeekSales * 100) / 100,
          variancePct: Math.round(h.salesVariancePct * 10) / 10,
          hasComparableSales: h.hasComparableSales,
          speedAttainment: h.speedAttainment,
          staffingDiff: Math.round(h.staffingDiff * 10) / 10,
          actualStaff: Math.round(h.actualStaff * 10) / 10,
          requiredStaff: Math.round(h.requiredStaff * 10) / 10,
          osatPercent: h.osatPercent,
          gradeScore: Math.round(h.score),
          gradeLabel: getGradeLabel(h.score),
        }));

      dailyDetails.push({
        date: dateKey,
        restaurantId: dayData.restaurantId,
        restaurantName: restaurantNameMap.get(dayData.restaurantId) || '',
        hoursWorked: dayData.hours.length,
        gradeScore: Math.round(dailyGradeScore),
        gradeLabel: getGradeLabel(dailyGradeScore),
        avgSalesVariance: Math.round(dailySalesVariancePct * 10) / 10,
        totalSales: Math.round(totalSales * 100) / 100,
        avgSpeed,
        avgStaffingDiff: Math.round(avgStaffingDiff * 10) / 10,
        osatPercent,
        osatResponses,
        avgHourlyVolume: dayData.hours.length > 0 ? Math.round(totalSales / dayData.hours.length) : 0,
        feedback: { wentWell, needsImprovement },
        hourlyGrades,
      });
    }

    // Keep raw (unrounded) daily scores for computing the overall average,
    // matching crew.ts which rounds only once at the end.
    const rawDailyGrades: { score: number; hours: number }[] = [];
    for (const d of dailyDetails) {
      rawDailyGrades.push({ score: dailyRawScores.get(d.date) ?? d.gradeScore, hours: d.hoursWorked });
    }

    dailyDetails.sort((a, b) => b.date.localeCompare(a.date));

    let displayPosition = leaderInfo.position || '';
    if (!displayPosition) {
      if (leaderInfo.type === 'asst_manager') displayPosition = 'Manager';
      else if (leaderInfo.type === 'manager') displayPosition = 'Manager';
      else displayPosition = 'Leader';
    }
    if (displayPosition === 'asst_manager') displayPosition = 'Manager';
    if (displayPosition.toLowerCase().includes('supervisor')) displayPosition = 'Shift Supervisor';
    if (displayPosition.toLowerCase().includes('manager') && displayPosition !== 'Shift Supervisor') displayPosition = 'Manager';

    // Compute overall from raw (unrounded) daily scores — matches crew.ts which
    // rounds only once at the end, avoiding per-day rounding drift.
    const totalGradeHours = rawDailyGrades.reduce((s, d) => s + d.hours, 0);
    const totalHours = totalGradeHours;
    const overallScore = rawDailyGrades.length > 0
      ? rawDailyGrades.reduce((s, d) => s + d.score * d.hours, 0) / totalGradeHours : 0;

    res.json({
      leader: {
        employeeId: leaderInfo.id,
        name: `${leaderInfo.firstName} ${leaderInfo.lastName}`,
        position: displayPosition,
        totalHours,
        avgGradeScore: Math.round(overallScore),
        gradeLabel: getGradeLabel(Math.round(overallScore)),
      },
      dateRange: { start: startDateStr, end: endDateStr },
      dailyDetails,
    });
  } catch (error) {
    console.error("Error fetching leader detail:", error);
    res.status(500).json({ error: "Failed to fetch leader detail" });
  }
});

export default router;
