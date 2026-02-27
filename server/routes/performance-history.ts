import { Router } from "express";
import { db } from "../db";
import { storage } from "../storage";
import { hourlySales, hourlyLabor, osatData, hmeTimerData, hourlyCrew, markets, restaurantMarkets } from "@shared/schema";
import { and, gte, lte, sql } from "drizzle-orm";
import { getStaffingBreakdown } from "../lib/labor-model";

const router = Router();

// Performance History endpoint - returns daily grades over a date range
router.get("/api/performance-history", async (req, res) => {
  try {
    const { days = "7", startDate, endDate } = req.query;

    // Calculate date range based on available data
    // Exclude the current day (Central Time) since partial-day data creates misleading variance
    const now = new Date();
    const todayCentral = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

    // First, find the most recent COMPLETED date that has data (exclude today)
    const latestDataResult = await db.select({ maxDate: sql<string>`MAX(DATE(sales_date))` })
      .from(hourlySales)
      .where(sql`DATE(sales_date) < ${todayCentral}`);
    const latestDataDate = latestDataResult[0]?.maxDate;

    let dateRange: string[] = [];

    if (startDate && endDate) {
      // Custom date range - still cap at yesterday
      const start = new Date(`${startDate}T12:00:00Z`);
      let end = new Date(`${endDate}T12:00:00Z`);
      const yesterdayCentral = new Date(`${todayCentral}T12:00:00Z`);
      yesterdayCentral.setDate(yesterdayCentral.getDate() - 1);
      if (end > yesterdayCentral) end = yesterdayCentral;
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      for (let i = 0; i < daysDiff; i++) {
        const date = new Date(start);
        date.setDate(date.getDate() + i);
        dateRange.push(date.toISOString().split('T')[0]);
      }
    } else {
      // Last N days - use the most recent completed date with data as the end point
      const numDays = parseInt(days as string) || 7;
      const endDate = latestDataDate
        ? new Date(`${latestDataDate}T12:00:00Z`)
        : new Date();
      const startDateCalc = new Date(endDate);
      startDateCalc.setDate(startDateCalc.getDate() - (numDays - 1));

      for (let i = 0; i < numDays; i++) {
        const date = new Date(startDateCalc);
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        if (dateStr < todayCentral) {
          dateRange.push(dateStr);
        }
      }
    }

    // Fetch all hourly sales data for the date range PLUS 7 days before for variance calculation
    // hourlySales uses salesDate (timestamp) - we need to filter by date range
    const expandedStartDate = new Date(`${dateRange[0]}T00:00:00Z`);
    expandedStartDate.setDate(expandedStartDate.getDate() - 7); // Go back 7 days for comparison data
    const startDateTs = expandedStartDate;
    const endDateTs = new Date(`${dateRange[dateRange.length - 1]}T23:59:59Z`);
    const allHourlySales = await db.select().from(hourlySales)
      .where(and(
        gte(hourlySales.salesDate, startDateTs),
        lte(hourlySales.salesDate, endDateTs)
      ));

    // Fetch all hourly labor data for the date range
    const allHourlyLabor = await db.select().from(hourlyLabor)
      .where(and(
        gte(hourlyLabor.date, dateRange[0]),
        lte(hourlyLabor.date, dateRange[dateRange.length - 1])
      ));

    // Fetch per-hour OSAT data for the date range (matches dashboard per-hour OSAT)
    const allOsatData = await db.select().from(osatData)
      .where(and(
        gte(osatData.date, dateRange[0]),
        lte(osatData.date, dateRange[dateRange.length - 1])
      ));

    // Fetch HME timer data for speed
    const allHmeData = await db.select().from(hmeTimerData)
      .where(and(
        gte(hmeTimerData.date, dateRange[0]),
        lte(hmeTimerData.date, dateRange[dateRange.length - 1])
      ));

    // Fetch hourly crew data for experience scores (XP)
    const allCrewData = await db.select().from(hourlyCrew)
      .where(and(
        gte(hourlyCrew.date, dateRange[0]),
        lte(hourlyCrew.date, dateRange[dateRange.length - 1])
      ));

    // Get all restaurants and filter out training stores
    const allRestaurants = await storage.getRestaurants();

    // Helper function to determine restaurant status based on openDate
    const getRestaurantStatus = (openDate: string | Date | null | undefined): "training" | "new" | "established" => {
      if (!openDate) return "established";
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const openDateNorm = new Date(openDate);
      openDateNorm.setHours(0, 0, 0, 0);
      if (openDateNorm > today) return "training";
      const diffTime = today.getTime() - openDateNorm.getTime();
      const daysOpen = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      return daysOpen < 90 ? "new" : "established";
    };

    // Filter out training stores
    const restaurantList = allRestaurants.filter(r => getRestaurantStatus(r.openDate) !== "training");

    // Get markets
    const allMarkets = await db.select().from(markets);
    const marketAssignments = await db.select().from(restaurantMarkets);

    // Build market lookup (restaurant.id is string, rm.restaurantId is number, market.id is string)
    const restaurantToMarket = new Map<string, { id: string; name: string }>();
    marketAssignments.forEach(rm => {
      const market = allMarkets.find(m => m.id === String(rm.marketId));
      if (market) {
        restaurantToMarket.set(String(rm.restaurantId), { id: market.id, name: market.name });
      }
    });

    // Per-hour execution grade calculation - EXACTLY matches leaderboard-card.tsx getExecutionGrade
    const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 };

    const getHourlyExecutionGrade = (
      salesVariancePct: number,
      speedAttainment: number | undefined,
      staffingDiff: number,
      hasComparableSales: boolean,
      isFirstWeek: boolean,
      hasValidStaffing: boolean,
      osatPercent: number | undefined
    ): { score: number; hasGrade: boolean } => {
      const components: { score: number; weight: number }[] = [];

      if (hasComparableSales) {
        const salesScore = salesVariancePct >= -5 ? 100 : 50;
        components.push({ score: salesScore, weight: GRADE_WEIGHTS.sales });
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
        if (staffingDiff > 1) staffingScore = 60;
        else if (staffingDiff < -1 && !isSalesSurge) staffingScore = 60;
        components.push({ score: staffingScore, weight: GRADE_WEIGHTS.staffing });
      }

      if (components.length === 0) return { score: 0, hasGrade: false };
      const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
      const avgScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;
      return { score: avgScore, hasGrade: true };
    };

    // Convert numeric score to letter grade then to midpoint score for averaging
    // Matches leaderboard-card.tsx gradeToScore/scoreToGrade exactly
    const scoreToGradeLabel = (score: number): string => {
      if (score >= 97) return 'A+';
      if (score >= 93) return 'A';
      if (score >= 90) return 'A-';
      if (score >= 87) return 'B+';
      if (score >= 83) return 'B';
      if (score >= 80) return 'B-';
      if (score >= 77) return 'C+';
      if (score >= 73) return 'C';
      if (score >= 70) return 'C-';
      if (score >= 67) return 'D+';
      if (score >= 63) return 'D';
      if (score >= 60) return 'D-';
      return 'F';
    };

    const gradeMidpoints: Record<string, number> = {
      'A+': 98, 'A': 95, 'A-': 91, 'B+': 88, 'B': 85, 'B-': 81,
      'C+': 78, 'C': 75, 'C-': 71, 'D+': 68, 'D': 65, 'D-': 61, 'F': 30
    };

    const gradeToMidpoint = (score: number): number => {
      const label = scoreToGradeLabel(score);
      return gradeMidpoints[label] ?? 0;
    };

    const getGradeLabel = scoreToGradeLabel;

    // Process data by date and restaurant
    type DailyGrade = {
      date: string;
      grade: number;
      gradeLabel: string;
      totalSales: number;
      salesVariance: number;
      hasComparableSales: boolean;
      avgSpeed?: number;
      staffingDiff: number;
      osatPercent?: number;
      osatResponses?: number;
      avgXp?: number; // Average experience score for the day (0-100)
    };

    type RestaurantHistory = {
      restaurantId: string;
      restaurantName: string;
      state: string;
      marketId?: string;
      marketName?: string;
      dailyGrades: DailyGrade[];
      avgGrade: number;
      avgGradeLabel: string;
      totalSales: number;
      avgSalesVariance: number;
      avgSpeed?: number;
      avgStaffingDiff: number;
      avgOsat?: number;
      totalOsatResponses: number;
      avgXp?: number; // Average experience score across all days (0-100)
      gradeImprovement: number; // Trend: positive = improving
    };

    const historyByRestaurant = new Map<string, RestaurantHistory>();

    // Tennessee stores identification
    const TENNESSEE_STORES = [
      "1680 - Powell", "1681 - Turkey Creek", "1682 - Cumberland Avenue",
      "1679 - East Ridge", "1605 - Shallowford Village", "1729 - Sevierville"
    ];

    const getState = (name: string): string => {
      return TENNESSEE_STORES.some(store => name.includes(store.split(" - ")[1])) ? "Tennessee" : "Alabama";
    };

    // Build lookup for hourly sales by restaurantId-dateStr-hour for quick last-week comparison
    const salesByKey = new Map<string, typeof allHourlySales[0]>();
    allHourlySales.forEach(s => {
      const salesDateStr = s.salesDate.toISOString().split('T')[0];
      const key = `${s.restaurantId}-${salesDateStr}-${s.hour}`;
      salesByKey.set(key, s);
    });

    // Build HME lookup by restaurantId-date-hour
    const hmeByKey = new Map<string, typeof allHmeData[0]>();
    allHmeData.forEach(h => {
      const key = `${h.restaurantId}-${h.date}-${h.hour}`;
      hmeByKey.set(key, h);
    });

    // Build labor lookup by restaurantId-date-hour
    const laborByKey = new Map<string, typeof allHourlyLabor[0]>();
    allHourlyLabor.forEach(l => {
      const key = `${l.restaurantId}-${l.date}-${l.hour}`;
      laborByKey.set(key, l);
    });

    // Build per-hour OSAT lookup by restaurantId-date-hour (matches dashboard exactly)
    const osatByKey = new Map<string, { osatPercent: number; totalResponses: number }>();
    allOsatData.forEach(o => {
      const key = `${o.restaurantId}-${o.date}-${o.hour}`;
      const pct = o.osatPercent ? parseFloat(o.osatPercent) : 0;
      osatByKey.set(key, { osatPercent: pct, totalResponses: o.totalResponses });
    });

    // Process each date - using PER-HOUR grade calculation matching dashboard exactly
    for (const dateStr of dateRange) {
      const salesForDate = allHourlySales.filter(s => {
        const salesDateStr = s.salesDate.toISOString().split('T')[0];
        return salesDateStr === dateStr;
      });
      const crewForDate = allCrewData.filter(c => c.date === dateStr);

      const salesByRestaurant = new Map<string, typeof salesForDate>();
      salesForDate.forEach(s => {
        const key = s.restaurantId;
        if (!salesByRestaurant.has(key)) salesByRestaurant.set(key, []);
        salesByRestaurant.get(key)!.push(s);
      });

      for (const restaurant of restaurantList) {
        const restaurantSales = salesByRestaurant.get(restaurant.id) || [];
        const restaurantCrew = crewForDate.filter(c => c.restaurantId === restaurant.id);

        if (restaurantSales.length === 0) continue;

        const totalSales = restaurantSales.reduce((sum, s) => sum + parseFloat(s.actualSales || "0"), 0);

        const gradeDate = new Date(dateStr);
        const openDate = restaurant.openDate ? new Date(restaurant.openDate) : null;
        const isFirstWeek = openDate ?
          (gradeDate.getTime() - openDate.getTime()) <= 7 * 24 * 60 * 60 * 1000 : false;

        // Calculate last week date string for per-hour comparison
        const [year, month, day] = dateStr.split('-').map(Number);
        const weekAgoDate = new Date(Date.UTC(year, month - 1, day - 7, 12, 0, 0));
        const weekAgoDateStr = weekAgoDate.toISOString().split('T')[0];

        // Calculate daily speed attainment from HME data (for display, not grading)
        let avgSpeed: number | undefined;
        const restaurantHme = allHmeData.filter(h => h.date === dateStr && h.restaurantId === restaurant.id);
        const hmeWithCars = restaurantHme.filter(h => h.carCount > 0 && h.carsUnder6Min > 0);
        if (hmeWithCars.length > 0) {
          const totalCars = hmeWithCars.reduce((sum, h) => sum + h.carCount, 0);
          const totalUnder6 = hmeWithCars.reduce((sum, h) => sum + h.carsUnder6Min, 0);
          avgSpeed = totalCars > 0 ? Math.round((totalUnder6 / totalCars) * 100) : undefined;
        }

        // OSAT for display - aggregate from per-hour OSAT data (same source as dashboard)
        let osatPercent: number | undefined;
        let osatResponses = 0;
        let osatFiveStarTotal = 0;
        for (let h = 0; h < 24; h++) {
          const osatRecord = osatByKey.get(`${restaurant.id}-${dateStr}-${h}`);
          if (osatRecord && osatRecord.totalResponses > 0) {
            osatResponses += osatRecord.totalResponses;
            osatFiveStarTotal += (osatRecord.osatPercent / 100) * osatRecord.totalResponses;
          }
        }
        if (osatResponses > 0) {
          osatPercent = (osatFiveStarTotal / osatResponses) * 100;
        }

        // XP for display
        let avgXp: number | undefined;
        const crewWithXp = restaurantCrew.filter(c => c.experienceScore !== null && c.experienceScore !== undefined && c.experienceScore > 0);
        if (crewWithXp.length > 0) {
          const totalXp = crewWithXp.reduce((sum, c) => sum + (c.experienceScore || 0), 0);
          avgXp = totalXp / crewWithXp.length;
        }

        // PER-HOUR GRADE CALCULATION — matches leaderboard-card.tsx exactly
        // Each hour gets a grade → converted to letter → converted to midpoint score → averaged
        const hourlyMidpoints: number[] = [];
        for (const hourSales of restaurantSales) {
          const todaySales = parseFloat(hourSales.actualSales || "0");
          if (todaySales <= 0) continue;

          const hour = hourSales.hour;

          const lastWeekKey = `${restaurant.id}-${weekAgoDateStr}-${hour}`;
          const lastWeekRecord = salesByKey.get(lastWeekKey);
          const lastWeekSales = lastWeekRecord ? parseFloat(lastWeekRecord.actualSales || "0") : 0;
          const hasComparableSales = lastWeekSales > 0;
          const salesVariancePct = hasComparableSales
            ? ((todaySales - lastWeekSales) / lastWeekSales) * 100
            : 0;

          const staffing = getStaffingBreakdown(hour, todaySales);
          const laborRecord = laborByKey.get(`${restaurant.id}-${dateStr}-${hour}`);
          const rawEmployeeCount = laborRecord ? parseFloat(laborRecord.employeeCount || "0") : 0;
          const positions = laborRecord?.positionBreakdown as Record<string, number> || {};
          const operatorHrs = positions['_operatorScheduled'] || 0;
          const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
          const staffingDiff = actualStaff - staffing.total;
          const hasValidStaffing = rawEmployeeCount >= 1;

          const hmeRecord = hmeByKey.get(`${restaurant.id}-${dateStr}-${hour}`);
          let speedAttainment: number | undefined;
          if (hmeRecord && hmeRecord.carCount > 0 && hmeRecord.carsUnder6Min > 0) {
            speedAttainment = Math.round((hmeRecord.carsUnder6Min / hmeRecord.carCount) * 100);
          }

          // Per-hour OSAT - only include if this specific hour has survey responses
          // This matches the dashboard exactly (dashboard uses per-hour OSAT from osatData table)
          const hourOsatRecord = osatByKey.get(`${restaurant.id}-${dateStr}-${hour}`);
          const hourOsatPercent = (hourOsatRecord && hourOsatRecord.totalResponses > 0)
            ? hourOsatRecord.osatPercent : undefined;

          const result = getHourlyExecutionGrade(
            salesVariancePct,
            speedAttainment,
            staffingDiff,
            hasComparableSales,
            isFirstWeek,
            hasValidStaffing,
            hourOsatPercent
          );
          if (result.hasGrade && result.score > 0) {
            hourlyMidpoints.push(gradeToMidpoint(result.score));
          }
        }

        const grade = hourlyMidpoints.length > 0
          ? hourlyMidpoints.reduce((a, b) => a + b, 0) / hourlyMidpoints.length
          : 0;
        const gradeLabel = grade > 0 ? scoreToGradeLabel(grade) : '-';

        // Calculate daily-level sales variance for display
        const weekAgoTotalSales = allHourlySales
          .filter(s => {
            const sDate = s.salesDate.toISOString().split('T')[0];
            return sDate === weekAgoDateStr && s.restaurantId === restaurant.id;
          })
          .reduce((sum, s) => sum + parseFloat(s.actualSales || "0"), 0);
        const hasComparableSalesDaily = weekAgoTotalSales > 2000 && totalSales > 500;
        let salesVariance = hasComparableSalesDaily ? ((totalSales - weekAgoTotalSales) / weekAgoTotalSales) * 100 : 0;
        if (hasComparableSalesDaily) {
          salesVariance = Math.max(-200, Math.min(200, salesVariance));
        }

        // Staffing diff for display (average across hours)
        let staffingDiffDisplay = 0;
        const laborForDate = allHourlyLabor.filter(l => l.date === dateStr && l.restaurantId === restaurant.id);
        const staffingDiffs: number[] = [];
        for (const hourSales of restaurantSales) {
          const todaySales = parseFloat(hourSales.actualSales || "0");
          if (todaySales <= 0) continue;
          const staffing = getStaffingBreakdown(hourSales.hour, todaySales);
          const laborRecord = laborByKey.get(`${restaurant.id}-${dateStr}-${hourSales.hour}`);
          const rawEmployeeCount = laborRecord ? parseFloat(laborRecord.employeeCount || "0") : 0;
          const positions = laborRecord?.positionBreakdown as Record<string, number> || {};
          const operatorHrs = positions['_operatorScheduled'] || 0;
          const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
          if (rawEmployeeCount >= 1) {
            staffingDiffs.push(actualStaff - staffing.total);
          }
        }
        if (staffingDiffs.length > 0) {
          staffingDiffDisplay = staffingDiffs.reduce((a, b) => a + b, 0) / staffingDiffs.length;
        }

        if (!historyByRestaurant.has(restaurant.id)) {
          const market = restaurantToMarket.get(restaurant.id);
          historyByRestaurant.set(restaurant.id, {
            restaurantId: restaurant.id,
            restaurantName: restaurant.name,
            state: getState(restaurant.name),
            marketId: market?.id,
            marketName: market?.name,
            dailyGrades: [],
            avgGrade: 0,
            avgGradeLabel: "",
            totalSales: 0,
            avgSalesVariance: 0,
            avgSpeed: undefined,
            avgStaffingDiff: 0,
            avgOsat: undefined,
            totalOsatResponses: 0,
            avgXp: undefined,
            gradeImprovement: 0,
          });
        }

        historyByRestaurant.get(restaurant.id)!.dailyGrades.push({
          date: dateStr,
          grade,
          gradeLabel,
          totalSales,
          salesVariance,
          hasComparableSales: hasComparableSalesDaily,
          avgSpeed,
          staffingDiff: staffingDiffDisplay,
          osatPercent,
          osatResponses,
          avgXp,
        });
      }
    }

    // Calculate aggregates for each restaurant
    const restaurantHistories: RestaurantHistory[] = [];

    historyByRestaurant.forEach(history => {
      const grades = history.dailyGrades;
      if (grades.length === 0) return;

      // Sort by date
      grades.sort((a, b) => a.date.localeCompare(b.date));

      // Calculate averages
      history.avgGrade = grades.reduce((sum, g) => sum + g.grade, 0) / grades.length;
      history.avgGradeLabel = getGradeLabel(history.avgGrade);
      history.totalSales = grades.reduce((sum, g) => sum + g.totalSales, 0);
      // Only average variance for days with comparable sales (excludes new store openings, store closures)
      const comparableGrades = grades.filter(g => g.hasComparableSales);
      history.avgSalesVariance = comparableGrades.length > 0
        ? comparableGrades.reduce((sum, g) => sum + g.salesVariance, 0) / comparableGrades.length
        : 0;
      history.avgStaffingDiff = grades.reduce((sum, g) => sum + g.staffingDiff, 0) / grades.length;
      history.totalOsatResponses = grades.reduce((sum, g) => sum + (g.osatResponses || 0), 0);

      // Calculate average OSAT (weighted by responses)
      const osatGrades = grades.filter(g => g.osatPercent !== undefined && g.osatResponses && g.osatResponses > 0);
      if (osatGrades.length > 0) {
        const totalResponses = osatGrades.reduce((sum, g) => sum + (g.osatResponses || 0), 0);
        const weightedOsat = osatGrades.reduce((sum, g) => sum + (g.osatPercent! * (g.osatResponses || 0)), 0);
        history.avgOsat = totalResponses > 0 ? weightedOsat / totalResponses : undefined;
      }

      // Calculate average speed
      const speedGrades = grades.filter(g => g.avgSpeed !== undefined);
      if (speedGrades.length > 0) {
        history.avgSpeed = speedGrades.reduce((sum, g) => sum + g.avgSpeed!, 0) / speedGrades.length;
      }

      // Calculate average XP (experience score)
      const xpGrades = grades.filter(g => g.avgXp !== undefined);
      if (xpGrades.length > 0) {
        history.avgXp = xpGrades.reduce((sum, g) => sum + g.avgXp!, 0) / xpGrades.length;
      }

      // Calculate grade improvement (last half vs first half)
      if (grades.length >= 2) {
        const midpoint = Math.floor(grades.length / 2);
        const firstHalf = grades.slice(0, midpoint);
        const secondHalf = grades.slice(midpoint);
        const firstAvg = firstHalf.reduce((sum, g) => sum + g.grade, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((sum, g) => sum + g.grade, 0) / secondHalf.length;
        history.gradeImprovement = secondAvg - firstAvg;
      }

      restaurantHistories.push(history);
    });

    // Sort by average grade descending
    restaurantHistories.sort((a, b) => b.avgGrade - a.avgGrade);

    // Calculate state summaries
    const stateMap = new Map<string, RestaurantHistory[]>();
    restaurantHistories.forEach(r => {
      if (!stateMap.has(r.state)) stateMap.set(r.state, []);
      stateMap.get(r.state)!.push(r);
    });

    const stateSummaries = Array.from(stateMap.entries()).map(([state, restaurants]) => {
      const avgGrade = restaurants.reduce((sum, r) => sum + r.avgGrade, 0) / restaurants.length;
      const totalSales = restaurants.reduce((sum, r) => sum + r.totalSales, 0);
      const avgSalesVariance = restaurants.reduce((sum, r) => sum + r.avgSalesVariance, 0) / restaurants.length;
      const osatRestaurants = restaurants.filter(r => r.avgOsat !== undefined);
      const avgOsat = osatRestaurants.length > 0
        ? osatRestaurants.reduce((sum, r) => sum + r.avgOsat!, 0) / osatRestaurants.length
        : undefined;
      const avgImprovement = restaurants.reduce((sum, r) => sum + r.gradeImprovement, 0) / restaurants.length;

      return {
        state,
        restaurantCount: restaurants.length,
        avgGrade,
        avgGradeLabel: getGradeLabel(avgGrade),
        totalSales,
        avgSalesVariance,
        avgOsat,
        avgImprovement,
      };
    });

    // Calculate market summaries
    const marketMap = new Map<string, RestaurantHistory[]>();
    restaurantHistories.forEach(r => {
      if (r.marketName) {
        if (!marketMap.has(r.marketName)) marketMap.set(r.marketName, []);
        marketMap.get(r.marketName)!.push(r);
      }
    });

    const marketSummaries = Array.from(marketMap.entries()).map(([market, restaurants]) => {
      const avgGrade = restaurants.reduce((sum, r) => sum + r.avgGrade, 0) / restaurants.length;
      const totalSales = restaurants.reduce((sum, r) => sum + r.totalSales, 0);
      const avgSalesVariance = restaurants.reduce((sum, r) => sum + r.avgSalesVariance, 0) / restaurants.length;
      const osatRestaurants = restaurants.filter(r => r.avgOsat !== undefined);
      const avgOsat = osatRestaurants.length > 0
        ? osatRestaurants.reduce((sum, r) => sum + r.avgOsat!, 0) / osatRestaurants.length
        : undefined;
      const avgImprovement = restaurants.reduce((sum, r) => sum + r.gradeImprovement, 0) / restaurants.length;

      return {
        market,
        restaurantCount: restaurants.length,
        avgGrade,
        avgGradeLabel: getGradeLabel(avgGrade),
        totalSales,
        avgSalesVariance,
        avgOsat,
        avgImprovement,
      };
    });

    // Overall company summary
    const companySummary = {
      restaurantCount: restaurantHistories.length,
      avgGrade: restaurantHistories.length > 0
        ? restaurantHistories.reduce((sum, r) => sum + r.avgGrade, 0) / restaurantHistories.length
        : 0,
      avgGradeLabel: getGradeLabel(
        restaurantHistories.length > 0
          ? restaurantHistories.reduce((sum, r) => sum + r.avgGrade, 0) / restaurantHistories.length
          : 0
      ),
      totalSales: restaurantHistories.reduce((sum, r) => sum + r.totalSales, 0),
      avgSalesVariance: restaurantHistories.length > 0
        ? restaurantHistories.reduce((sum, r) => sum + r.avgSalesVariance, 0) / restaurantHistories.length
        : 0,
      avgOsat: (() => {
        const osatRestaurants = restaurantHistories.filter(r => r.avgOsat !== undefined);
        return osatRestaurants.length > 0
          ? osatRestaurants.reduce((sum, r) => sum + r.avgOsat!, 0) / osatRestaurants.length
          : undefined;
      })(),
      avgImprovement: restaurantHistories.length > 0
        ? restaurantHistories.reduce((sum, r) => sum + r.gradeImprovement, 0) / restaurantHistories.length
        : 0,
    };

    res.json({
      dateRange,
      restaurants: restaurantHistories,
      stateSummaries,
      marketSummaries,
      companySummary,
    });
  } catch (error) {
    console.error("Error fetching performance history:", error);
    res.status(500).json({ error: "Failed to fetch performance history" });
  }
});

export default router;
