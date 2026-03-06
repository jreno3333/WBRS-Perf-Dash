import { Router } from "express";
import { db } from "../db";
import { storage } from "../storage";
import { hourlySales, hourlyLabor, osatData, hmeTimerData, hourlyCrew, markets, restaurantMarkets, dailyWeather, historicalDailySales } from "@shared/schema";
import { and, gte, lte, sql } from "drizzle-orm";
import { getStaffingBreakdown } from "../lib/labor-model";
import { computeHourlyScore, scoreToGradeLabel, gradeToMidpoint as scoringGradeToMidpoint, computeDailyBonuses } from "../lib/scoring";
import { getAllHourlyPosOrderCountRange, getAllHourlyPosSalesRange, getOotHoursByDateRange } from "../xenial-webhook";

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

    // Fetch POS order counts for transaction variance (current + comparison week)
    const txnExpandedStart = expandedStartDate.toISOString().split('T')[0];
    const txnExpandedEnd = endDateTs.toISOString().split('T')[0];
    const posOrderCounts = await getAllHourlyPosOrderCountRange(txnExpandedStart, txnExpandedEnd);

    // Fetch POS sales data — overlays 7shifts sales (matches dashboard exactly)
    const posSalesByKey = await getAllHourlyPosSalesRange(txnExpandedStart, txnExpandedEnd);

    // Fetch hourly crew data for experience scores (XP)
    const allCrewData = await db.select().from(hourlyCrew)
      .where(and(
        gte(hourlyCrew.date, dateRange[0]),
        lte(hourlyCrew.date, dateRange[dateRange.length - 1])
      ));

    // Fetch daily weather data for the date range
    const allWeatherData = await db.select().from(dailyWeather)
      .where(and(
        gte(dailyWeather.date, dateRange[0]),
        lte(dailyWeather.date, dateRange[dateRange.length - 1])
      ));

    // Build weather lookup by restaurantId-date
    const weatherByKey = new Map<string, typeof allWeatherData[0]>();
    allWeatherData.forEach(w => {
      const key = `${w.restaurantId}-${w.date}`;
      weatherByKey.set(key, w);
    });

    // Fetch last year's daily sales from historical_daily_sales for YoY bonus
    // Use DOW-matching: subtract 1 year, then adjust to same day-of-week (matches yoy-bulk endpoint)
    // Expand range by ±3 days to cover all possible DOW shifts (matches leaders.ts / leader-detail.ts)
    const yoyDateMap = new Map<string, string>(); // currentDate -> dowMatchedYoyDate
    for (const d of dateRange) {
      const dt = new Date(`${d}T12:00:00Z`);
      const yoy = new Date(dt);
      yoy.setFullYear(yoy.getFullYear() - 1);
      const sameDow = yoy.getDay();
      const targetDow = dt.getDay();
      yoy.setDate(yoy.getDate() + (targetDow - sameDow));
      yoyDateMap.set(d, yoy.toISOString().split('T')[0]);
    }
    const yoyRangeStart = new Date(`${dateRange[0]}T12:00:00Z`);
    yoyRangeStart.setFullYear(yoyRangeStart.getFullYear() - 1);
    yoyRangeStart.setDate(yoyRangeStart.getDate() - 3);
    const yoyRangeEnd = new Date(`${dateRange[dateRange.length - 1]}T12:00:00Z`);
    yoyRangeEnd.setFullYear(yoyRangeEnd.getFullYear() - 1);
    yoyRangeEnd.setDate(yoyRangeEnd.getDate() + 3);
    const yoyStartStr = yoyRangeStart.toISOString().split('T')[0];
    const yoyEndStr = yoyRangeEnd.toISOString().split('T')[0];
    const yoySalesData = await db.select().from(historicalDailySales).where(
      and(gte(historicalDailySales.date, yoyStartStr), lte(historicalDailySales.date, yoyEndStr))
    );
    // Map: "restaurantId-yoyDate" -> netSales
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
      return daysOpen < 120 ? "new" : "established";
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

    const getGradeLabel = scoreToGradeLabel;

    // Daypart definitions (mirrors client/src/lib/dayparts.ts)
    const DAYPARTS = [
      { id: 'earlybird', label: 'Earlybird', shortLabel: 'EB', startHour: 0, endHour: 5 },
      { id: 'breakfast', label: 'Breakfast', shortLabel: 'BRK', startHour: 6, endHour: 10 },
      { id: 'lunch', label: 'Lunch', shortLabel: 'LCH', startHour: 11, endHour: 14 },
      { id: 'snack', label: 'Snack', shortLabel: 'SNK', startHour: 15, endHour: 16 },
      { id: 'evening', label: 'Evening', shortLabel: 'EVE', startHour: 17, endHour: 19 },
      { id: 'evening_snack', label: 'Evening Snack', shortLabel: 'ES', startHour: 20, endHour: 23 },
    ];

    function getDaypartForHour(hour: number) {
      return DAYPARTS.find(dp => hour >= dp.startHour && hour <= dp.endHour);
    }

    // Process data by date and restaurant
    type DaypartGrade = {
      id: string;
      label: string;
      shortLabel: string;
      score: number;
      gradeLabel: string;
      sales: number;
      salesVariance: number;
      osatPercent?: number;
      osatResponses: number;
      speedAttainment?: number;
      staffingDiff: number;
      hoursWithData: number;
    };

    type DailyGrade = {
      date: string;
      grade: number;
      gradeLabel: string;
      baseGrade: number;
      totalSales: number;
      salesVariance: number;
      hasComparableSales: boolean;
      avgSpeed?: number;
      staffingDiff: number;
      osatPercent?: number;
      osatResponses?: number;
      transactionVariance?: number;
      avgXp?: number; // Average experience score for the day (0-100)
      weather?: { highTemp: number; lowTemp: number; condition: string } | null;
      bonuses?: { id: string; label: string; points: number }[];
      bonusPoints?: number;
      daypartGrades?: DaypartGrade[];
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

    // OOT (dt3) hours — skip speed measurement for these hours
    const ootHours = dateRange.length > 0
      ? await getOotHoursByDateRange(dateRange[0], dateRange[dateRange.length - 1])
      : new Set<string>();

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

        // Check if ANY data exists (7shifts or POS) for this restaurant/date
        const hasPosData = Array.from({ length: 24 }, (_, h) => h).some(h => posSalesByKey.has(`${restaurant.id}-${dateStr}-${h}`));
        if (restaurantSales.length === 0 && !hasPosData) continue;

        // Total sales: sum POS-overlaid hourly sales (matches dashboard)
        let totalSales = 0;
        for (let h = 0; h < 24; h++) {
          const posKey = `${restaurant.id}-${dateStr}-${h}`;
          const posSale = posSalesByKey.get(posKey);
          const dbRecord = salesByKey.get(`${restaurant.id}-${dateStr}-${h}`);
          const hourSale = posSale !== undefined && posSale > 0
            ? posSale
            : (dbRecord ? parseFloat(dbRecord.actualSales || "0") : 0);
          totalSales += hourSale;
        }

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

        // PER-HOUR GRADE CALCULATION — uses POS sales when available (matches dashboard exactly)
        const hourlyMidpoints: number[] = [];
        const hourlyRawScores: number[] = []; // Raw scores for bonus evaluation
        let dailyTxnTotal = 0;
        let dailyTxnLastWeekTotal = 0;

        // Track per-hour details for daypart aggregation
        const hourlyDetails: { hour: number; score: number; sales: number; lastWeekSales: number; osatPct?: number; osatResp: number; speed?: number; staffDiff: number; hasStaffing: boolean }[] = [];

        // Build set of hours that have data (7shifts OR POS)
        const hoursWithData = new Set<number>();
        for (const hourSales of restaurantSales) {
          hoursWithData.add(hourSales.hour);
        }
        // Also check POS data for hours that might not be in 7shifts (e.g. 12am-5am)
        for (let h = 0; h < 24; h++) {
          const posKey = `${restaurant.id}-${dateStr}-${h}`;
          if (posSalesByKey.has(posKey)) hoursWithData.add(h);
        }

        for (const hour of Array.from(hoursWithData).sort((a, b) => a - b)) {
          // POS sales take priority over 7shifts (matches dashboard storage.ts)
          const posKey = `${restaurant.id}-${dateStr}-${hour}`;
          const posSales = posSalesByKey.get(posKey);
          const dbSales = salesByKey.get(`${restaurant.id}-${dateStr}-${hour}`);
          const todaySales = posSales !== undefined && posSales > 0
            ? posSales
            : (dbSales ? parseFloat(dbSales.actualSales || "0") : 0);
          if (todaySales <= 0) continue;

          // Last week comparison — POS takes priority
          const posLwKey = `${restaurant.id}-${weekAgoDateStr}-${hour}`;
          const posLwSales = posSalesByKey.get(posLwKey);
          const dbLwRecord = salesByKey.get(`${restaurant.id}-${weekAgoDateStr}-${hour}`);
          const lastWeekSales = posLwSales !== undefined && posLwSales > 0
            ? posLwSales
            : (dbLwRecord ? parseFloat(dbLwRecord.actualSales || "0") : 0);
          const hasComparableSales = lastWeekSales > 0;
          const salesVariancePct = hasComparableSales
            ? ((todaySales - lastWeekSales) / lastWeekSales) * 100
            : 0;

          // Transaction data from POS orders
          const txnKey = `${restaurant.id}-${dateStr}-${hour}`;
          const txnLastWeekKey = `${restaurant.id}-${weekAgoDateStr}-${hour}`;
          const hourTxnCount = posOrderCounts.get(txnKey) || 0;
          const hourTxnLastWeek = posOrderCounts.get(txnLastWeekKey) || 0;
          dailyTxnTotal += hourTxnCount;
          dailyTxnLastWeekTotal += hourTxnLastWeek;
          const hasComparableTransactions = hourTxnLastWeek > 0 && hourTxnCount > 0;
          const txnVariancePct = hasComparableTransactions
            ? ((hourTxnCount - hourTxnLastWeek) / hourTxnLastWeek) * 100
            : undefined;

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

          // Skip speed in grading when OOT (dt3) is active — lane config changes make timing unreliable
          const isOotHour = ootHours.has(`${restaurant.id}-${dateStr}-${hour}`);

          // Per-hour OSAT - only include if this specific hour has survey responses
          // This matches the dashboard exactly (dashboard uses per-hour OSAT from osatData table)
          const hourOsatRecord = osatByKey.get(`${restaurant.id}-${dateStr}-${hour}`);
          const hourOsatPercent = (hourOsatRecord && hourOsatRecord.totalResponses > 0)
            ? hourOsatRecord.osatPercent : undefined;

          const result = computeHourlyScore({
            salesVariancePct,
            hasComparableSales,
            transactionVariancePct: txnVariancePct,
            hasComparableTransactions,
            speedAttainment: isOotHour ? undefined : speedAttainment,
            staffingDiff,
            hasValidStaffing,
            osatPercent: hourOsatPercent,
          });
          if (result.hasGrade && result.score > 0) {
            hourlyRawScores.push(result.score);
            hourlyMidpoints.push(scoringGradeToMidpoint(scoreToGradeLabel(result.score)));
            // Track for daypart aggregation
            hourlyDetails.push({
              hour,
              score: result.score,
              sales: todaySales,
              lastWeekSales,
              osatPct: hourOsatPercent,
              osatResp: hourOsatRecord?.totalResponses || 0,
              speed: isOotHour ? undefined : speedAttainment,
              staffDiff: staffingDiff,
              hasStaffing: hasValidStaffing,
            });
          }
        }

        // Compute daily transaction variance for bonus evaluation
        const dailyTxnVariance = dailyTxnLastWeekTotal > 0
          ? ((dailyTxnTotal - dailyTxnLastWeekTotal) / dailyTxnLastWeekTotal) * 100
          : undefined;

        // Use raw hourly scores for base grade (matches leaderboard-card + daily-summary)
        const baseGrade = hourlyRawScores.length > 0
          ? hourlyRawScores.reduce((a, b) => a + b, 0) / hourlyRawScores.length
          : 0;

        // Calculate daily-level sales variance for display (POS-overlaid, matches dashboard)
        let weekAgoTotalSales = 0;
        for (let h = 0; h < 24; h++) {
          const posLwKey = `${restaurant.id}-${weekAgoDateStr}-${h}`;
          const posLw = posSalesByKey.get(posLwKey);
          const dbLw = salesByKey.get(`${restaurant.id}-${weekAgoDateStr}-${h}`);
          weekAgoTotalSales += posLw !== undefined && posLw > 0
            ? posLw
            : (dbLw ? parseFloat(dbLw.actualSales || "0") : 0);
        }
        const hasComparableSalesDaily = weekAgoTotalSales > 2000 && totalSales > 500;
        let salesVariance = hasComparableSalesDaily ? ((totalSales - weekAgoTotalSales) / weekAgoTotalSales) * 100 : 0;
        if (hasComparableSalesDaily) {
          salesVariance = Math.max(-200, Math.min(200, salesVariance));
        }

        // Sales variance for bonus evaluation — matches dashboard & daily-summary logic
        // (simply requires last week sales > 0, NOT the stricter display threshold)
        const dailySalesVarForBonus = weekAgoTotalSales > 0
          ? ((totalSales - weekAgoTotalSales) / weekAgoTotalSales) * 100
          : undefined;

        // YoY variance from historical_daily_sales (DOW-matched)
        const yoyMatchedDate = yoyDateMap.get(dateStr) || '';
        const lastYearSales = yoySalesMap.get(`${restaurant.id}-${yoyMatchedDate}`);
        const dailyYoySalesVar = lastYearSales && lastYearSales > 0
          ? ((totalSales - lastYearSales) / lastYearSales) * 100
          : undefined;

        // Compute daily bonus points using raw hourly scores + daily-level metrics
        const bonusResult = baseGrade > 0 ? computeDailyBonuses({
          dailyOsatPercent: osatPercent,
          dailySurveyCount: osatResponses,
          dailySalesVariancePct: dailySalesVarForBonus,
          dailyTransactionVariancePct: dailyTxnVariance,
          dailyYoySalesVariancePct: dailyYoySalesVar,
          hourlyScores: hourlyRawScores,
        }) : { bonuses: [], totalBonus: 0, cappedBonus: 0 };

        // Apply bonus points to get final grade (capped at 100)
        const grade = baseGrade > 0 ? Math.min(baseGrade + bonusResult.cappedBonus, 100) : 0;
        const gradeLabel = grade > 0 ? scoreToGradeLabel(grade) : '-';

        // Staffing diff for display (average across hours)
        let staffingDiffDisplay = 0;
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

        // Look up weather for this restaurant+date
        const weatherRecord = weatherByKey.get(`${restaurant.id}-${dateStr}`);
        const dayWeather = weatherRecord && weatherRecord.highTemp != null && weatherRecord.condition
          ? { highTemp: parseFloat(String(weatherRecord.highTemp)), lowTemp: parseFloat(String(weatherRecord.lowTemp ?? "0")), condition: weatherRecord.condition }
          : null;

        // Compute daypart grades from hourly details
        const daypartGrades: DaypartGrade[] = [];
        for (const dp of DAYPARTS) {
          const dpHours = hourlyDetails.filter(h => h.hour >= dp.startHour && h.hour <= dp.endHour);
          if (dpHours.length === 0) continue;
          const dpScore = dpHours.reduce((s, h) => s + h.score, 0) / dpHours.length;
          const dpSales = dpHours.reduce((s, h) => s + h.sales, 0);
          const dpLastWeekSales = dpHours.reduce((s, h) => s + h.lastWeekSales, 0);
          const dpSalesVar = dpLastWeekSales > 0 ? ((dpSales - dpLastWeekSales) / dpLastWeekSales) * 100 : 0;
          const dpOsatHours = dpHours.filter(h => h.osatPct !== undefined && h.osatResp > 0);
          const dpOsatResp = dpOsatHours.reduce((s, h) => s + h.osatResp, 0);
          const dpOsatPct = dpOsatResp > 0
            ? dpOsatHours.reduce((s, h) => s + (h.osatPct! / 100) * h.osatResp, 0) / dpOsatResp * 100
            : undefined;
          const dpSpeedHours = dpHours.filter(h => h.speed !== undefined);
          const dpSpeed = dpSpeedHours.length > 0
            ? dpSpeedHours.reduce((s, h) => s + h.speed!, 0) / dpSpeedHours.length
            : undefined;
          const dpStaffHours = dpHours.filter(h => h.hasStaffing);
          const dpStaffDiff = dpStaffHours.length > 0
            ? dpStaffHours.reduce((s, h) => s + h.staffDiff, 0) / dpStaffHours.length
            : 0;

          daypartGrades.push({
            id: dp.id,
            label: dp.label,
            shortLabel: dp.shortLabel,
            score: Math.round(dpScore * 10) / 10,
            gradeLabel: scoreToGradeLabel(dpScore),
            sales: dpSales,
            salesVariance: Math.round(dpSalesVar * 10) / 10,
            osatPercent: dpOsatPct !== undefined ? Math.round(dpOsatPct * 10) / 10 : undefined,
            osatResponses: dpOsatResp,
            speedAttainment: dpSpeed !== undefined ? Math.round(dpSpeed) : undefined,
            staffingDiff: Math.round(dpStaffDiff * 10) / 10,
            hoursWithData: dpHours.length,
          });
        }

        historyByRestaurant.get(restaurant.id)!.dailyGrades.push({
          date: dateStr,
          grade,
          gradeLabel,
          baseGrade,
          totalSales,
          salesVariance,
          hasComparableSales: hasComparableSalesDaily,
          avgSpeed,
          staffingDiff: staffingDiffDisplay,
          osatPercent,
          osatResponses,
          transactionVariance: dailyTxnVariance,
          avgXp,
          weather: dayWeather,
          bonuses: bonusResult.bonuses.length > 0
            ? bonusResult.bonuses.map(b => ({ id: b.id, label: b.label, points: b.points }))
            : undefined,
          bonusPoints: bonusResult.cappedBonus > 0 ? bonusResult.cappedBonus : undefined,
          daypartGrades: daypartGrades.length > 0 ? daypartGrades : undefined,
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

      // Calculate trend days: count consecutive days from the end of the period
      // where grade is improving (each day >= previous) or declining (each day <= previous).
      // Returns positive number for consecutive improving days, negative for declining.
      // This matches the "trend days" metric shown on Dashboard and Daily Reports.
      if (grades.length >= 2) {
        // Walk backwards from the most recent day
        let consecutiveUp = 0;
        let consecutiveDown = 0;

        for (let i = grades.length - 1; i > 0; i--) {
          const curr = grades[i].grade;
          const prev = grades[i - 1].grade;
          if (curr > prev) {
            if (consecutiveDown > 0) break; // direction changed
            consecutiveUp++;
          } else if (curr < prev) {
            if (consecutiveUp > 0) break; // direction changed
            consecutiveDown++;
          } else {
            // Equal grades continue the current streak
            if (consecutiveUp > 0) consecutiveUp++;
            else if (consecutiveDown > 0) consecutiveDown++;
            // If no streak started yet, skip (don't start a streak on equal)
          }
        }

        if (consecutiveUp > 0) {
          history.gradeImprovement = consecutiveUp;
        } else if (consecutiveDown > 0) {
          history.gradeImprovement = -consecutiveDown;
        } else {
          history.gradeImprovement = 0;
        }
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
