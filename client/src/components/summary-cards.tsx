import { memo } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

interface WeeklySalesData {
  currentWeekStart: string;
  currentWeekEnd: string;
  priorWeekStart: string;
  priorWeekEnd: string;
  daysInCurrentWeek: number;
  daysInPriorWeek: number;
  restaurants: Record<string, { currentWeek: number; priorWeek: number; eowForecast: number; priorWeekFull: number; daysInCurrentWeek: number }>;
}

interface SummaryCardsProps {
  restaurants: RestaurantSales[];
  lastUpdated: string;
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  yoyData?: Record<string, { priorNetSales: number; priorGuestCount: number; priorDate: string }>;
  weeklySalesData?: WeeklySalesData;
}

// Grade scoring for X-Score calculation
const scoreToGrade = (score: number): string => {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  return 'F';
};

const getGradeColor = (grade: string): string => {
  if (grade.startsWith('A')) return 'text-green-500';
  if (grade.startsWith('B')) return 'text-blue-500';
  if (grade.startsWith('C')) return 'text-yellow-500';
  if (grade === 'D') return 'text-orange-500';
  return 'text-red-500';
};

const getGradeBgColor = (grade: string): string => {
  if (grade.startsWith('A')) return 'bg-green-500/10 border-green-500/30';
  if (grade.startsWith('B')) return 'bg-blue-500/10 border-blue-500/30';
  if (grade.startsWith('C')) return 'bg-yellow-500/10 border-yellow-500/30';
  if (grade === 'D') return 'bg-orange-500/10 border-orange-500/30';
  return 'bg-red-500/10 border-red-500/30';
};

// WEIGHTS: Sales 35%, Speed 25%, OSAT 25%, Staffing 15%
const GRADE_WEIGHTS = {
  sales: 35,
  speed: 25,
  osat: 25,
  staffing: 15,
};

function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean = true,
  osatPercent: number | undefined = undefined,
  hasValidStaffing: boolean = true
): { grade: string; score: number; hasGrade: boolean } {
  const components: { name: string; score: number; weight: number }[] = [];
  
  if (hasComparableSales) {
    const salesScore = salesVariancePct >= -5 ? 100 : 50;
    components.push({ name: 'sales', score: salesScore, weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ name: 'sales', score: 100, weight: GRADE_WEIGHTS.sales });
  }
  
  if (speedAttainment !== undefined && speedAttainment >= 0) {
    let speedScore = 100;
    if (speedAttainment < 50) speedScore = 40;
    else if (speedAttainment < 70) speedScore = 70;
    components.push({ name: 'speed', score: speedScore, weight: GRADE_WEIGHTS.speed });
  }
  
  // OSAT component (weight: 25%) - only if we have customer satisfaction data
  if (osatPercent !== undefined && osatPercent > 0) {
    let osatScore = 100;
    if (osatPercent < 80) osatScore = 40;
    else if (osatPercent < 85) osatScore = 70;
    components.push({ name: 'osat', score: osatScore, weight: GRADE_WEIGHTS.osat });
  }
  
  // Staffing component (weight: 15%) - only if we have valid staffing data
  // SALES SURGE EXCEPTION: No understaffing penalty when sales are 20%+ above last week
  if (hasValidStaffing) {
    let staffingScore = 100;
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    if (staffingDiff > 1) staffingScore = 60;
    else if (staffingDiff < -1 && !isSalesSurge) staffingScore = 60;
    components.push({ name: 'staffing', score: staffingScore, weight: GRADE_WEIGHTS.staffing });
  }
  
  if (components.length === 0) {
    return { grade: '-', score: 0, hasGrade: false };
  }
  
  // Calculate weighted average - normalize weights based on available components
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const avgScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;
  
  const grade = scoreToGrade(avgScore);
  return { grade, score: avgScore, hasGrade: true };
}

export const SummaryCards = memo(function SummaryCards({ restaurants, lastUpdated, hourlyByRestaurant, yoyData, weeklySalesData }: SummaryCardsProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  // Exclude training units from totals
  const activeRestaurants = restaurants.filter(r => r.status !== "training");
  
  // SSS (Same Store Sales): Only units open >18 months
  const sssRestaurants = activeRestaurants.filter(r => {
    if (!r.openDate) return true;
    const openDate = new Date(r.openDate);
    const now = new Date();
    const monthsOpen = (now.getFullYear() - openDate.getFullYear()) * 12 + (now.getMonth() - openDate.getMonth());
    return monthsOpen > 18;
  });
  
  // Calculate OSAT totals from restaurant-level daily data (not hourly)
  // This ensures we count all surveys regardless of whether there's hourly sales data
  const dailyOsatTotals = activeRestaurants.reduce((acc, r) => {
    const osat = (r as any).osat;
    if (osat && osat.totalResponses > 0) {
      acc.totalResponses += osat.totalResponses;
      acc.fiveStarCount += osat.fiveStarCount;
      acc.restaurantsWithOsat++;
    }
    return acc;
  }, { totalResponses: 0, fiveStarCount: 0, restaurantsWithOsat: 0 });
  const dailyOsatPercent = dailyOsatTotals.totalResponses > 0 
    ? (dailyOsatTotals.fiveStarCount / dailyOsatTotals.totalResponses) * 100 
    : 0;
  
  // Total Sales: Use ALL active restaurants (not SSS-filtered)
  const totalTodaySales = activeRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const totalLastWeekSales = activeRestaurants.reduce((sum, r) => sum + r.actualLastWeekSales, 0);
  const totalForecastSales = activeRestaurants.reduce((sum, r) => sum + r.forecastSales, 0);
  
  // Projected: Use ALL active restaurants for projected daily total and LW full day comparison
  const totalLastWeekFullDay = activeRestaurants.reduce((sum, r) => {
    const lwRemaining = Math.max(0, (r.forecastSales || 0) - (r.actualSales || 0));
    return sum + (r.actualLastWeekSales || 0) + lwRemaining;
  }, 0);
  const aheadOfPaceCount = activeRestaurants.filter((r) => r.isAheadOfPace).length;
  
  // Calculate variance vs last week
  const lwVariance = totalLastWeekSales > 0 
    ? ((totalTodaySales / totalLastWeekSales) - 1) * 100 
    : 0;
  const lwDollarDiff = totalTodaySales - totalLastWeekSales;

  // Calculate company-wide weekly sales totals (Sat-Fri)
  let weeklyCurrentTotal = 0;
  let weeklyPriorTotal = 0;
  let weeklyEowForecast = 0;
  let weeklyPriorWeekFull = 0;
  if (weeklySalesData?.restaurants) {
    for (const r of activeRestaurants) {
      const wk = weeklySalesData.restaurants[r.restaurantId];
      if (wk) {
        weeklyCurrentTotal += wk.currentWeek;
        weeklyPriorTotal += wk.priorWeek;
        weeklyEowForecast += wk.eowForecast;
        weeklyPriorWeekFull += wk.priorWeekFull;
      }
    }
  }
  const weeklyVariance = weeklyPriorTotal > 0
    ? ((weeklyCurrentTotal / weeklyPriorTotal) - 1) * 100
    : 0;
  const weeklyDollarDiff = weeklyCurrentTotal - weeklyPriorTotal;
  const eowVariance = weeklyPriorWeekFull > 0
    ? ((weeklyEowForecast / weeklyPriorWeekFull) - 1) * 100
    : 0;

  // Calculate overall execution score across all restaurants
  const allHourlyScores: number[] = [];
  const restaurantGrades: Record<string, string> = {}; // Store each restaurant's overall grade
  
  // Track scores by hour for trend calculation
  const scoresByHour: Record<number, number[]> = {};
  
  // Track overall staffing, speed, and OSAT metrics
  let staffingProperCount = 0;
  let staffingOverCount = 0;
  let staffingUnderCount = 0;
  let speedGreenCount = 0;
  let speedYellowCount = 0;
  let speedRedCount = 0;
  let totalSpeedHours = 0;
  let totalStaffingHours = 0;
  let osatGoodCount = 0;
  let osatCautionCount = 0;
  let osatPoorCount = 0;
  let totalOsatHours = 0;
  let totalOsatResponses = 0;
  
  if (hourlyByRestaurant) {
    for (const [restaurantId, hours] of Object.entries(hourlyByRestaurant)) {
      // Skip training units
      const restaurant = activeRestaurants.find(r => r.restaurantId === restaurantId);
      if (!restaurant) continue;
      
      // Use restaurant's local hour cutoff to only count completed hours
      // This matches the leaderboard card logic for consistent grading
      const localGradeCutoff = (restaurant as any).localCurrentHour ?? restaurant.normalizedHour;
      
      const restaurantHourlyScores: number[] = [];
      for (const hour of hours) {
        // Only include completed hours (matching leaderboard card behavior)
        if (hour.hour > localGradeCutoff) continue;
        // No sales today = no grade (don't penalize hours without transactions)
        if (!hour.todaySales || hour.todaySales === 0) continue;
        
        const hasComparableSales = hour.lastWeekSales > 0; // Only compare if LW had sales
        const salesVariancePct = hasComparableSales 
          ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
          : 0;
        const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
        // Exclude operator from labor hours (matching leaderboard card logic)
        const positions = hour.positionBreakdown || {};
        const operatorHrs = positions['_operatorScheduled'] || 0;
        const rawEmployeeCount = Number(hour.employeeCount) || 0;
        const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
        const staffingDiff = actualStaff - staffing.total;
        const hasValidStaffing = rawEmployeeCount >= 1;
        
        // Track staffing metrics (only if valid staffing data)
        if (hasValidStaffing) {
          totalStaffingHours++;
          if (Math.abs(staffingDiff) <= 1) {
            staffingProperCount++;
          } else if (staffingDiff > 1) {
            staffingOverCount++;
          } else {
            staffingUnderCount++;
          }
        }
        
        // Track speed metrics using attainment (% of cars under 6 min)
        const speedAtt = (hour as any).speedAttainment;
        if (speedAtt !== undefined && speedAtt >= 0) {
          totalSpeedHours++;
          if (speedAtt >= 70) {
            speedGreenCount++;
          } else if (speedAtt >= 50) {
            speedYellowCount++;
          } else {
            speedRedCount++;
          }
        }
        
        // Track OSAT metrics (only if customer satisfaction data exists)
        if (hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0) {
          totalOsatHours++;
          totalOsatResponses += hour.osatResponses;
          if (hour.osatPercent >= 85) {
            osatGoodCount++;
          } else if (hour.osatPercent >= 80) {
            osatCautionCount++;
          } else {
            osatPoorCount++;
          }
        }
        
        const gradeInfo = getExecutionGrade(salesVariancePct, speedAtt, staffingDiff, hasComparableSales, hour.osatPercent, hasValidStaffing);
        if (gradeInfo.hasGrade) {
          if (gradeInfo.score > 0) {
            allHourlyScores.push(gradeInfo.score);
            restaurantHourlyScores.push(gradeInfo.score);
            // Track by hour for trend calculation
            if (!scoresByHour[hour.hour]) scoresByHour[hour.hour] = [];
            scoresByHour[hour.hour].push(gradeInfo.score);
          }
        }
      }
      
      // Calculate this restaurant's overall grade
      if (restaurantHourlyScores.length > 0) {
        const avgScore = restaurantHourlyScores.reduce((a, b) => a + b, 0) / restaurantHourlyScores.length;
        restaurantGrades[restaurantId] = scoreToGrade(avgScore);
      }
    }
  }
  
  // Calculate staffing, speed, and OSAT percentages
  const staffingProperPct = totalStaffingHours > 0 ? Math.round((staffingProperCount / totalStaffingHours) * 100) : 0;
  const speedGreenPct = totalSpeedHours > 0 ? Math.round((speedGreenCount / totalSpeedHours) * 100) : 0;
  const osatGoodPct = totalOsatHours > 0 ? Math.round((osatGoodCount / totalOsatHours) * 100) : 0;
  
  // Count stores by execution grade (group by letter family)
  const gradeCounts = { 'A': 0, 'B': 0, 'C': 0, 'D': 0, 'F': 0 };
  Object.values(restaurantGrades).forEach(grade => {
    const family = grade.startsWith('A') ? 'A' : grade.startsWith('B') ? 'B' : grade.startsWith('C') ? 'C' : grade === 'D' ? 'D' : 'F';
    gradeCounts[family as keyof typeof gradeCounts]++;
  });
  
  // Count D/F hourly scores (score < 55 = D or F grade)
  const dfHourCount = allHourlyScores.filter(s => s < 55).length;

  const overallXScore = allHourlyScores.length > 0
    ? allHourlyScores.reduce((a, b) => a + b, 0) / allHourlyScores.length
    : 0;
  const overallGrade = scoreToGrade(overallXScore);
  const gradeColor = getGradeColor(overallGrade);

  // Calculate projected daily: sum of all restaurant forecast sales
  // Each restaurant's forecastSales = actual + LW remaining hours (same methodology)
  // This gives us the total projected daily sales using consistent logic
  // Determine if day is complete by checking the normalized hour (23 = end of day)
  const maxNormalizedHour = activeRestaurants.length > 0 
    ? Math.max(...activeRestaurants.map(r => r.normalizedHour ?? -1))
    : -1;
  const isDayComplete = maxNormalizedHour >= 23;
  
  const projectedData = {
    projected: totalForecastSales,
    actualSoFar: totalTodaySales,
    remainingForecast: Math.max(0, totalForecastSales - totalTodaySales),
    isDayComplete
  };

  // Grade background color for the large display
  const gradeBgColor = getGradeBgColor(overallGrade);

  // Calculate 3-hour execution trend
  const hoursWithScores = Object.keys(scoresByHour)
    .map(h => parseInt(h))
    .filter(h => scoresByHour[h].length > 0)
    .sort((a, b) => b - a); // Sort descending (most recent first)
  
  const last4Hours = hoursWithScores.slice(0, 4);
  const hourlyAvgScores = last4Hours.map(h => ({
    hour: h,
    avgScore: scoresByHour[h].reduce((a, b) => a + b, 0) / scoresByHour[h].length,
    grade: scoreToGrade(scoresByHour[h].reduce((a, b) => a + b, 0) / scoresByHour[h].length)
  })).reverse(); // Reverse so oldest is first for trend display
  
  // Determine trend direction (compare first hour to last hour in the 3-hour window)
  let executionTrend: 'up' | 'down' | 'flat' | null = null;
  if (hourlyAvgScores.length >= 2) {
    const firstScore = hourlyAvgScores[0].avgScore;
    const lastScore = hourlyAvgScores[hourlyAvgScores.length - 1].avgScore;
    if (lastScore > firstScore + 2) executionTrend = 'up';
    else if (lastScore < firstScore - 2) executionTrend = 'down';
    else executionTrend = 'flat';
  }

  // Calculate 3-hour sales trend (company-wide hourly totals)
  const salesByHour: Record<number, { today: number; lastWeek: number }> = {};
  if (hourlyByRestaurant) {
    for (const [restaurantId, hours] of Object.entries(hourlyByRestaurant)) {
      const restaurant = activeRestaurants.find(r => r.restaurantId === restaurantId);
      if (!restaurant) continue;
      const localGradeCutoff = (restaurant as any).localCurrentHour ?? restaurant.normalizedHour;
      
      for (const hour of hours) {
        if (hour.hour > localGradeCutoff) continue;
        if (!hour.todaySales || hour.todaySales === 0) continue;
        
        if (!salesByHour[hour.hour]) salesByHour[hour.hour] = { today: 0, lastWeek: 0 };
        salesByHour[hour.hour].today += hour.todaySales;
        salesByHour[hour.hour].lastWeek += hour.lastWeekSales;
      }
    }
  }
  
  const hoursWithSales = Object.keys(salesByHour)
    .map(h => parseInt(h))
    .filter(h => salesByHour[h].today > 0)
    .sort((a, b) => b - a);
  
  const last4SalesHours = hoursWithSales.slice(0, 4);
  const hourlySales = last4SalesHours.map(h => ({
    hour: h,
    today: salesByHour[h].today,
    lastWeek: salesByHour[h].lastWeek,
    diff: salesByHour[h].today - salesByHour[h].lastWeek
  })).reverse();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
      {/* Execution Score */}
      <div data-testid="card-summary-execution" className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Execution</p>
              <Popover>
                <PopoverTrigger asChild>
                  <Info className="w-3 h-3 text-muted-foreground/50 cursor-help" />
                </PopoverTrigger>
                <PopoverContent side="top" className="w-auto max-w-[200px] p-2 text-xs">
                  Overall grade based on sales vs LW, drive-thru speed, and staffing levels
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-2xl font-bold ${gradeColor}`} data-testid="text-execution-grade">
                {overallGrade}
              </span>
              <span className="text-xs text-muted-foreground">
                {allHourlyScores.length} hrs
              </span>
            </div>
            {dailyOsatTotals.totalResponses > 0 && (
              <p className={`text-xs mt-1 ${dailyOsatPercent >= 85 ? 'text-green-500' : dailyOsatPercent >= 80 ? 'text-yellow-500' : 'text-red-500'}`}>
                OSAT {Math.round(dailyOsatPercent)}%
                <span className="text-muted-foreground ml-1">({dailyOsatTotals.totalResponses})</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1 justify-end max-w-[120px]">
            {gradeCounts['A'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-500">
                A:{gradeCounts['A']}
              </span>
            )}
            {gradeCounts['B'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-500">
                B:{gradeCounts['B']}
              </span>
            )}
            {gradeCounts['C'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-yellow-500/10 text-yellow-500">
                C:{gradeCounts['C']}
              </span>
            )}
            {gradeCounts['D'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-orange-500/10 text-orange-500">
                D:{gradeCounts['D']}
              </span>
            )}
            {gradeCounts['F'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-500/10 text-red-500">
                F:{gradeCounts['F']}
              </span>
            )}
            {dfHourCount > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 border border-red-500/30 cursor-help">
                    D/F Hrs <span className="font-bold">{dfHourCount}</span>
                  </span>
                </PopoverTrigger>
                <PopoverContent side="bottom" className="w-auto max-w-[220px] p-2 text-xs">
                  <p className="font-semibold text-red-500">{dfHourCount} hourly D/F grades today</p>
                  <p className="text-muted-foreground mt-1">Hours scoring below 55 across all restaurants — indicating poor execution (low sales vs LW, slow drive-thru, or staffing gaps).</p>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>

      {/* Total Sales Today */}
      <div data-testid="card-summary-sales" className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Sales</p>
        <div className="flex items-baseline gap-2 mt-1">
          <p className="text-2xl font-bold tabular-nums" data-testid="text-total-sales">
            {formatCurrency(totalTodaySales)}
          </p>
          <span className={`text-xs font-medium ${lwVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
            {lwVariance >= 0 ? "+" : ""}{lwVariance.toFixed(1)}%
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          vs LW {lwDollarDiff >= 0 ? "+" : ""}{formatCurrency(lwDollarDiff)}
        </p>
        {weeklySalesData && weeklyCurrentTotal > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40 space-y-0.5">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">WTD</span>
              <span className="font-semibold tabular-nums" data-testid="text-weekly-sales-total">
                {formatCurrency(weeklyCurrentTotal)}
              </span>
              {weeklyPriorTotal > 0 && (
                <span className={`font-medium ${weeklyVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {weeklyVariance >= 0 ? "+" : ""}{Math.round(weeklyVariance)}%
                </span>
              )}
            </div>
            {weeklyEowForecast > weeklyCurrentTotal && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">EOW</span>
                <span className="font-semibold tabular-nums text-primary" data-testid="text-eow-forecast-total">
                  {formatCurrency(weeklyEowForecast)}
                </span>
                {weeklyPriorWeekFull > 0 && (
                  <span className={`font-medium ${eowVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {eowVariance >= 0 ? "+" : ""}{Math.round(eowVariance)}%
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Projected Daily Sales */}
      <div data-testid="card-summary-projected" className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Projected</p>
          <Popover>
            <PopoverTrigger asChild>
              <Info className="w-3 h-3 text-muted-foreground/50 cursor-help" />
            </PopoverTrigger>
            <PopoverContent side="top" className="w-auto max-w-[220px] p-2 text-xs">
              Today's sales plus remaining hours from last week
            </PopoverContent>
          </Popover>
        </div>
        {projectedData.isDayComplete ? (
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-2xl font-bold tabular-nums" data-testid="text-projected-daily">
              {formatCurrency(projectedData.actualSoFar)}
            </p>
            <span className={`text-xs font-medium ${totalLastWeekFullDay > 0 && projectedData.actualSoFar >= totalLastWeekFullDay ? "text-green-500" : "text-red-500"}`}>
              vs LW
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="text-2xl font-bold tabular-nums" data-testid="text-projected-daily">
                {formatCurrency(projectedData.projected)}
              </p>
              <span className={`text-xs font-medium ${totalLastWeekFullDay > 0 && projectedData.projected >= totalLastWeekFullDay ? "text-green-500" : "text-red-500"}`}>
                vs LW
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              {formatCurrency(projectedData.actualSoFar)} actual + {formatCurrency(projectedData.remainingForecast)} remaining
            </p>
          </>
        )}
        {yoyData && (() => {
          const yoyTotalPrior = sssRestaurants.reduce((sum, r) => sum + (yoyData[r.restaurantId]?.priorNetSales || 0), 0);
          if (yoyTotalPrior > 0) {
            const projectedSSSTotal = sssRestaurants.reduce((sum, r) => sum + r.forecastSales, 0);
            const projectedYoYVariance = ((projectedSSSTotal - yoyTotalPrior) / yoyTotalPrior) * 100;
            const projYoYDiff = projectedSSSTotal - yoyTotalPrior;
            return (
              <p className={`text-xs font-medium mt-1.5 tabular-nums ${projectedYoYVariance >= 0 ? "text-blue-500" : "text-orange-500"}`} data-testid="text-yoy-projected-summary">
                SSS YoY {projectedYoYVariance >= 0 ? "+" : ""}{Math.round(projectedYoYVariance)}%
                <span className="text-muted-foreground ml-1">({projYoYDiff >= 0 ? "+" : ""}{formatCurrency(projYoYDiff)})</span>
              </p>
            );
          }
          return null;
        })()}
      </div>
    </div>
  );
});
