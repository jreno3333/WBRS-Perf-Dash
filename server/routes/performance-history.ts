import { Router } from "express";
import { db } from "../db";
import { storage } from "../storage";
import { hourlySales, hourlyLabor, dailyOsat, hmeTimerData, hourlyCrew, markets, restaurantMarkets } from "@shared/schema";
import { and, gte, lte, sql } from "drizzle-orm";

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

    // Fetch OSAT data for the date range
    const allOsatData = await db.select().from(dailyOsat)
      .where(and(
        gte(dailyOsat.date, dateRange[0]),
        lte(dailyOsat.date, dateRange[dateRange.length - 1])
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

    // Helper function to calculate execution grade - ALIGNED WITH CLIENT-SIDE LOGIC
    // Matches getExecutionGrade in leaderboard-card.tsx exactly
    const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 };

    const calculateGrade = (
      salesVariancePct: number,
      speedSeconds: number | undefined,
      staffingDiff: number,
      hasComparableSales: boolean,
      hasValidStaffing: boolean,
      osatPercent: number | undefined,
      isFirstWeek: boolean = false
    ): { grade: number; gradeLabel: string; hasGrade: boolean } => {
      const components: { name: string; score: number; weight: number }[] = [];

      // Sales component (weight: 35%)
      // For units with comparable data: Within -5% to +infinity = 100, Below -5% = 50
      // When last week had $0, treat as positive (store was likely closed last week)
      if (hasComparableSales) {
        const salesScore = salesVariancePct >= -5 ? 100 : 50;
        components.push({ name: 'sales', score: salesScore, weight: GRADE_WEIGHTS.sales });
      } else {
        components.push({ name: 'sales', score: 100, weight: GRADE_WEIGHTS.sales });
      }

      // Speed component (weight: 25%) - uses attainment (% of cars under 6 min)
      // >=70% = 100 (green), >=50% = 70 (yellow), <50% = 40 (red)
      if (speedSeconds !== undefined && speedSeconds >= 0) {
        let speedScore = 100;
        if (speedSeconds < 50) speedScore = 40;
        else if (speedSeconds < 70) speedScore = 70;
        components.push({ name: 'speed', score: speedScore, weight: GRADE_WEIGHTS.speed });
      }

      // OSAT component (weight: 25%) - only if we have customer satisfaction data
      // 85%+ = 100 (excellent), 80-85% = 70 (acceptable), <80% = 40 (needs improvement)
      if (osatPercent !== undefined && osatPercent > 0) {
        let osatScore = 100;
        if (osatPercent < 80) osatScore = 40;
        else if (osatPercent < 85) osatScore = 70;
        components.push({ name: 'osat', score: osatScore, weight: GRADE_WEIGHTS.osat });
      }

      // Staffing component (weight: 15%) - only if we have valid staffing data
      // PROPER (within +/-1) = 100, UNDER/OVER = 60
      // SALES SURGE EXCEPTION: No understaffing penalty when sales are 20%+ above last week
      // or when last week had no sales (can't plan staffing for unexpected activity)
      if (hasValidStaffing) {
        let staffingScore = 100;
        const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
        const isUnderstaffed = staffingDiff < -1;
        const isOverstaffed = staffingDiff > 1;

        if (isOverstaffed) {
          staffingScore = 60;
        } else if (isUnderstaffed && !isSalesSurge) {
          staffingScore = 60;
        }
        components.push({ name: 'staffing', score: staffingScore, weight: GRADE_WEIGHTS.staffing });
      }

      // If no components to grade, return no grade
      if (components.length === 0) {
        return { grade: 0, gradeLabel: '-', hasGrade: false };
      }

      // Calculate weighted average - normalize weights based on available components
      const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
      const avgScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;

      return { grade: avgScore, gradeLabel: getGradeLabel(avgScore), hasGrade: true };
    };

    // Helper to get grade label - ALIGNED WITH CLIENT-SIDE LOGIC (detailed scale)
    const getGradeLabel = (score: number): string => {
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
    };

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

    // Process each date
    for (const dateStr of dateRange) {
      // Filter hourly sales by salesDate (timestamp) - extract date portion
      const salesForDate = allHourlySales.filter(s => {
        const salesDateStr = s.salesDate.toISOString().split('T')[0];
        return salesDateStr === dateStr;
      });
      const laborForDate = allHourlyLabor.filter(l => l.date.startsWith(dateStr));
      const osatForDate = allOsatData.filter(o => o.date === dateStr);
      const hmeForDate = allHmeData.filter(h => h.date === dateStr);
      const crewForDate = allCrewData.filter(c => c.date === dateStr);

      // Group by restaurant
      const salesByRestaurant = new Map<string, typeof salesForDate>();
      salesForDate.forEach(s => {
        const key = s.restaurantId;
        if (!salesByRestaurant.has(key)) salesByRestaurant.set(key, []);
        salesByRestaurant.get(key)!.push(s);
      });

      // Process each restaurant
      for (const restaurant of restaurantList) {
        const restaurantSales = salesByRestaurant.get(restaurant.id) || [];
        const restaurantLabor = laborForDate.filter(l => l.restaurantId === restaurant.id);
        const restaurantOsat = osatForDate.find(o => o.restaurantId === restaurant.id);
        const restaurantHme = hmeForDate.filter(h => h.restaurantId === restaurant.id);
        const restaurantCrew = crewForDate.filter(c => c.restaurantId === restaurant.id);

        // Skip if no sales data for this date
        if (restaurantSales.length === 0) continue;

        // Calculate daily totals using actualSales
        const totalSales = restaurantSales.reduce((sum, s) => sum + parseFloat(s.actualSales || "0"), 0);

        // Calculate variance by looking up actual sales from 7 days ago in our own data
        // Use simple ISO date string comparison (salesDate stored at noon, toISOString is safe)
        const [year, month, day] = dateStr.split('-').map(Number);
        const weekAgoDate = new Date(Date.UTC(year, month - 1, day - 7, 12, 0, 0));
        const weekAgoDateStr = weekAgoDate.toISOString().split('T')[0];

        const weekAgoSales = allHourlySales
          .filter(s => {
            const salesDateStr = s.salesDate.toISOString().split('T')[0];
            return salesDateStr === weekAgoDateStr && s.restaurantId === restaurant.id;
          })
          .reduce((sum, s) => sum + parseFloat(s.actualSales || "0"), 0);

        // Handle missing comparison data - require meaningful last-week sales (>$500 minimum)
        // to avoid extreme variance from grand opening days or partial-day data
        const hasComparableSales = weekAgoSales > 500;
        const salesVariance = hasComparableSales ? ((totalSales - weekAgoSales) / weekAgoSales) * 100 : 0;

        // Calculate speed attainment (% of cars under 6 min) from HME timer data
        let avgSpeed: number | undefined;
        const hmeWithCars = restaurantHme.filter(h => h.carCount > 0 && h.carsUnder6Min > 0);
        if (hmeWithCars.length > 0) {
          const totalCars = hmeWithCars.reduce((sum, h) => sum + h.carCount, 0);
          const totalUnder6 = hmeWithCars.reduce((sum, h) => sum + h.carsUnder6Min, 0);
          avgSpeed = totalCars > 0 ? Math.round((totalUnder6 / totalCars) * 100) : undefined;
        }

        // Calculate staffing diff using labor cost variance as a proxy
        // NOTE: Server-side uses labor cost ratio instead of headcount-based labor model
        // that the client uses in getStaffingBreakdown(). This provides reasonable approximation
        // for historical grade calculations where we don't have the full hourly sales-to-headcount mapping.
        let staffingDiff = 0;
        let hasValidStaffing = false;
        const validLabor = restaurantLabor.filter(l => {
          const actual = parseFloat(l.actualLabor || "0");
          const projected = parseFloat(l.projectedLabor || "0");
          return actual > 0 && projected > 0;
        });
        if (validLabor.length > 0) {
          hasValidStaffing = true;
          // Calculate average labor variance as a proxy for staffing diff
          // Positive = overstaffed, negative = understaffed
          const laborVariances = validLabor.map(l => {
            const actual = parseFloat(l.actualLabor || "0");
            const projected = parseFloat(l.projectedLabor || "0");
            return (actual - projected) / projected;
          });
          const avgLaborVariance = laborVariances.reduce((sum, v) => sum + v, 0) / laborVariances.length;
          // Convert to roughly equivalent staffing diff scale (-3 to +3)
          staffingDiff = avgLaborVariance * 10;
        }

        // Get OSAT data - osatPercent is a string that needs conversion
        const osatPercent = restaurantOsat?.osatPercent ? parseFloat(restaurantOsat.osatPercent) : undefined;
        const osatResponses = restaurantOsat?.totalResponses ?? 0;

        // Calculate average experience score (XP) from crew data
        let avgXp: number | undefined;
        const crewWithXp = restaurantCrew.filter(c => c.experienceScore !== null && c.experienceScore !== undefined && c.experienceScore > 0);
        if (crewWithXp.length > 0) {
          const totalXp = crewWithXp.reduce((sum, c) => sum + (c.experienceScore || 0), 0);
          avgXp = totalXp / crewWithXp.length;
        }

        // Determine if this is a first-week unit (opened within the past 7 days from the date being graded)
        const gradeDate = new Date(dateStr);
        const openDate = restaurant.openDate ? new Date(restaurant.openDate) : null;
        const isFirstWeek = openDate ?
          (gradeDate.getTime() - openDate.getTime()) <= 7 * 24 * 60 * 60 * 1000 : false;

        // Calculate grade using aligned logic with hasComparableSales, hasValidStaffing, and isFirstWeek
        const gradeResult = calculateGrade(
          salesVariance,
          avgSpeed,
          staffingDiff,
          hasComparableSales,
          hasValidStaffing,
          osatPercent,
          isFirstWeek
        );
        const grade = gradeResult.grade;
        const gradeLabel = gradeResult.gradeLabel;

        // Initialize or update restaurant history
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
          hasComparableSales,
          avgSpeed,
          staffingDiff,
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
