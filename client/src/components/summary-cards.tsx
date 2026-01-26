import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown, Store, Target, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

interface SummaryCardsProps {
  restaurants: RestaurantSales[];
  lastUpdated: string;
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
}

// Grade scoring for X-Score calculation
const gradeToScore = (grade: string): number => {
  const scores: Record<string, number> = { 'A+': 100, 'A': 90, 'B': 80, 'C': 70, 'D': 60, 'F': 50 };
  return scores[grade] || 0;
};

const scoreToGrade = (score: number): string => {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 75) return 'B';
  if (score >= 65) return 'C';
  if (score >= 55) return 'D';
  return 'F';
};

function getExecutionGrade(
  salesVariancePct: number, // Percentage variance from last week (e.g., -3 means 3% down)
  avgServiceTime: number | undefined, 
  staffingDiff: number,
  hasComparableSales: boolean = true
): { grade: string; hasGrade: boolean } {
  // Track which components are available for grading
  const components: { name: string; score: number }[] = [];
  
  // Sales component (only if we have comparable data - last week had sales)
  // Allow 5% variance to still count as "meeting expectations" (score 100)
  if (hasComparableSales) {
    const salesScore = salesVariancePct >= -5 ? 100 : 50;
    components.push({ name: 'sales', score: salesScore });
  }
  
  // Speed component (only if we have drive-thru data)
  if (avgServiceTime !== undefined) {
    let speedScore = 100;
    if (avgServiceTime > 420) speedScore = 40;
    else if (avgServiceTime > 300) speedScore = 70;
    components.push({ name: 'speed', score: speedScore });
  }
  
  // Staffing component (always available)
  let staffingScore = 100;
  if (staffingDiff > 1 || staffingDiff < -1) staffingScore = 60;
  components.push({ name: 'staffing', score: staffingScore });
  
  if (components.length === 0) {
    return { grade: '-', hasGrade: false };
  }
  
  const avgScore = components.reduce((sum, c) => sum + c.score, 0) / components.length;
  
  let grade: string;
  if (avgScore >= 95) grade = 'A+';
  else if (avgScore >= 85) grade = 'A';
  else if (avgScore >= 75) grade = 'B';
  else if (avgScore >= 65) grade = 'C';
  else if (avgScore >= 55) grade = 'D';
  else grade = 'F';
  
  return { grade, hasGrade: true };
}

export function SummaryCards({ restaurants, lastUpdated, hourlyByRestaurant }: SummaryCardsProps) {
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
  // Use actualSales and actualLastWeekSales (all available hours) for display to match 7shifts
  const totalTodaySales = activeRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const totalLastWeekSales = activeRestaurants.reduce((sum, r) => sum + r.actualLastWeekSales, 0);
  const totalForecastSales = activeRestaurants.reduce((sum, r) => sum + r.forecastSales, 0);
  
  // Calculate last week's full day total for comparison
  // We need to compare projected (actual + remaining from LW) against LW full day
  // Since forecastSales = actual + LW remaining, and we have actualLastWeekSales for the same hour cutoff
  // LW full day = actualLastWeekSales + remaining hours from LW = same as forecastSales but using LW data
  // For simplicity, we estimate LW full day by using the forecast total (which represents the pattern)
  // A more accurate approach: sum each restaurant's forecastSales minus their actual plus their lastWeek
  // But since forecastSales = actual + lwRemaining, and we want lwFullDay = lwThruHour + lwRemaining
  // We can calculate: lwFullDay = actualLastWeekSales + (forecastSales - actualSales)
  const totalLastWeekFullDay = activeRestaurants.reduce((sum, r) => {
    // LW remaining = forecastSales - actualSales
    const lwRemaining = Math.max(0, (r.forecastSales || 0) - (r.actualSales || 0));
    // LW full day = LW through current hour + LW remaining
    return sum + (r.actualLastWeekSales || 0) + lwRemaining;
  }, 0);
  const aheadOfPaceCount = activeRestaurants.filter((r) => r.isAheadOfPace).length;
  
  // Calculate variance vs last week
  const lwVariance = totalLastWeekSales > 0 
    ? ((totalTodaySales / totalLastWeekSales) - 1) * 100 
    : 0;
  const lwDollarDiff = totalTodaySales - totalLastWeekSales;

  // Calculate overall execution score across all restaurants
  const allHourlyScores: number[] = [];
  const restaurantGrades: Record<string, string> = {}; // Store each restaurant's overall grade
  
  // Track scores by hour for trend calculation
  const scoresByHour: Record<number, number[]> = {};
  
  // Track overall staffing and speed metrics
  let staffingProperCount = 0;
  let staffingOverCount = 0;
  let staffingUnderCount = 0;
  let speedGreenCount = 0;
  let speedYellowCount = 0;
  let speedRedCount = 0;
  let totalSpeedHours = 0;
  let totalStaffingHours = 0;
  
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
        const actualStaff = Number(hour.employeeCount) || 0;
        const staffingDiff = actualStaff - staffing.total;
        
        // Track staffing metrics
        totalStaffingHours++;
        if (Math.abs(staffingDiff) <= 1) {
          staffingProperCount++;
        } else if (staffingDiff > 1) {
          staffingOverCount++;
        } else {
          staffingUnderCount++;
        }
        
        // Track speed metrics (only if drive-thru data exists)
        if (hour.avgServiceTime !== undefined) {
          totalSpeedHours++;
          if (hour.avgServiceTime <= 300) {
            speedGreenCount++;
          } else if (hour.avgServiceTime <= 420) {
            speedYellowCount++;
          } else {
            speedRedCount++;
          }
        }
        
        const gradeInfo = getExecutionGrade(salesVariancePct, hour.avgServiceTime, staffingDiff, hasComparableSales);
        if (gradeInfo.hasGrade) {
          const score = gradeToScore(gradeInfo.grade);
          if (score > 0) {
            allHourlyScores.push(score);
            restaurantHourlyScores.push(score);
            // Track by hour for trend calculation
            if (!scoresByHour[hour.hour]) scoresByHour[hour.hour] = [];
            scoresByHour[hour.hour].push(score);
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
  
  // Calculate staffing and speed percentages
  const staffingProperPct = totalStaffingHours > 0 ? Math.round((staffingProperCount / totalStaffingHours) * 100) : 0;
  const speedGreenPct = totalSpeedHours > 0 ? Math.round((speedGreenCount / totalSpeedHours) * 100) : 0;
  
  // Count stores by execution grade
  const gradeCounts = { 'A+': 0, 'A': 0, 'B': 0, 'C': 0, 'D': 0, 'F': 0 };
  Object.values(restaurantGrades).forEach(grade => {
    if (grade in gradeCounts) {
      gradeCounts[grade as keyof typeof gradeCounts]++;
    }
  });
  
  const overallXScore = allHourlyScores.length > 0 
    ? allHourlyScores.reduce((a, b) => a + b, 0) / allHourlyScores.length 
    : 0;
  const overallGrade = scoreToGrade(overallXScore);
  const gradeColor = overallGrade === 'A+' || overallGrade === 'A' ? 'text-green-600 dark:text-green-400' 
    : overallGrade === 'B' ? 'text-blue-600 dark:text-blue-400' 
    : overallGrade === 'C' ? 'text-yellow-600 dark:text-yellow-400'
    : 'text-red-600 dark:text-red-400';

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
  const gradeBgColor = overallGrade === 'A+' || overallGrade === 'A' ? 'bg-green-500/20 border-green-500/50' 
    : overallGrade === 'B' ? 'bg-blue-500/20 border-blue-500/50' 
    : overallGrade === 'C' ? 'bg-yellow-500/20 border-yellow-500/50'
    : 'bg-red-500/20 border-red-500/50';

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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Execution Score - Prominent Display */}
      <Card data-testid="card-summary-execution" className={`border-2 ${gradeBgColor}`}>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <div className={`w-16 h-16 rounded-xl flex items-center justify-center ${gradeBgColor} border-2`}>
              <span className={`text-4xl font-bold ${gradeColor}`} data-testid="text-execution-grade">
                {overallGrade}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-lg font-semibold">Daily Execution</p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                  </PopoverTrigger>
                  <PopoverContent side="top" className="w-auto max-w-[200px] p-2 text-xs">
                    Overall grade based on sales vs LW, drive-thru speed, and staffing levels
                  </PopoverContent>
                </Popover>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {allHourlyScores.length} hours graded
              </p>
              <div className="flex items-center gap-3 mt-1.5 text-xs">
                {totalStaffingHours > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <span className={`font-medium cursor-help ${staffingProperPct >= 70 ? 'text-green-600 dark:text-green-400' : staffingProperPct >= 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                        Staff: {staffingProperPct}%
                        {staffingProperPct < 70 && (staffingOverCount > staffingUnderCount ? ' ↑' : staffingUnderCount > staffingOverCount ? ' ↓' : '')}
                      </span>
                    </PopoverTrigger>
                    <PopoverContent side="bottom" className="w-auto max-w-[200px] p-2 text-xs">
                      <div>% of hours with proper staffing (within ±1 of target)</div>
                      {staffingProperPct < 100 && (
                        <div className="mt-1 text-muted-foreground">
                          {staffingOverCount > 0 && <span>Over: {staffingOverCount}h</span>}
                          {staffingOverCount > 0 && staffingUnderCount > 0 && <span> · </span>}
                          {staffingUnderCount > 0 && <span>Under: {staffingUnderCount}h</span>}
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                )}
                {totalSpeedHours > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <span className={`font-medium cursor-help ${speedGreenPct >= 70 ? 'text-green-600 dark:text-green-400' : speedGreenPct >= 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                        Speed: {speedGreenPct}%
                      </span>
                    </PopoverTrigger>
                    <PopoverContent side="bottom" className="w-auto max-w-[180px] p-2 text-xs">
                      % of hours with drive-thru time under 5 min
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Store Performance - Grades and Execution Trend */}
      <Card data-testid="card-summary-ahead">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
              <Store className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm text-muted-foreground">Store Performance</p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                  </PopoverTrigger>
                  <PopoverContent side="top" className="w-auto max-w-[200px] p-2 text-xs">
                    Number of stores at each grade level today
                  </PopoverContent>
                </Popover>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {gradeCounts['A+'] > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    A+ <span className="font-bold">{gradeCounts['A+']}</span>
                  </span>
                )}
                {gradeCounts['A'] > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    A <span className="font-bold">{gradeCounts['A']}</span>
                  </span>
                )}
                {gradeCounts['B'] > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    B <span className="font-bold">{gradeCounts['B']}</span>
                  </span>
                )}
                {gradeCounts['C'] > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                    C <span className="font-bold">{gradeCounts['C']}</span>
                  </span>
                )}
                {gradeCounts['D'] > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                    D <span className="font-bold">{gradeCounts['D']}</span>
                  </span>
                )}
                {gradeCounts['F'] > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    F <span className="font-bold">{gradeCounts['F']}</span>
                  </span>
                )}
              </div>
              {/* 4-Hour Execution Trend */}
              {hourlyAvgScores.length >= 2 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <div className="flex items-center gap-1 text-xs">
                    <Popover>
                      <PopoverTrigger asChild>
                        <span className="text-muted-foreground cursor-help">4hr trend:</span>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" className="w-auto max-w-[180px] p-2 text-xs">
                        Average grade across all stores for each of the last 4 hours
                      </PopoverContent>
                    </Popover>
                    <div className="flex items-center gap-0.5">
                      {hourlyAvgScores.map((h, i) => (
                        <span key={h.hour} className="flex items-center">
                          <span className={`font-semibold ${
                            h.grade === 'A+' || h.grade === 'A' ? 'text-green-600 dark:text-green-400' :
                            h.grade === 'B' ? 'text-blue-600 dark:text-blue-400' :
                            h.grade === 'C' ? 'text-yellow-600 dark:text-yellow-400' :
                            'text-red-600 dark:text-red-400'
                          }`}>{h.grade}</span>
                          {i < hourlyAvgScores.length - 1 && <span className="text-muted-foreground mx-0.5">→</span>}
                        </span>
                      ))}
                    </div>
                    {executionTrend === 'up' && <TrendingUp className="w-3.5 h-3.5 text-green-600 dark:text-green-400 ml-1" />}
                    {executionTrend === 'down' && <TrendingDown className="w-3.5 h-3.5 text-red-600 dark:text-red-400 ml-1" />}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Total Sales Today */}
      <Card data-testid="card-summary-sales">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-orange-100 dark:bg-orange-900/30">
              <DollarSign className="w-5 h-5 text-orange-600 dark:text-orange-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm text-muted-foreground">Total Sales Today</p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                  </PopoverTrigger>
                  <PopoverContent side="top" className="w-auto max-w-[200px] p-2 text-xs">
                    Combined sales across all stores so far today
                  </PopoverContent>
                </Popover>
              </div>
              <p className="text-xl font-bold" data-testid="text-total-sales">
                {formatCurrency(totalTodaySales)}
              </p>
              <Popover>
                <PopoverTrigger asChild>
                  <p className={`text-xs font-medium mt-1 cursor-help ${lwVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    vs LW: {lwVariance >= 0 ? "+" : ""}{Math.round(lwVariance)}% ({lwDollarDiff >= 0 ? "+" : ""}{formatCurrency(lwDollarDiff)})
                  </p>
                </PopoverTrigger>
                <PopoverContent side="bottom" className="w-auto max-w-[180px] p-2 text-xs">
                  Comparison to same day last week at this time
                </PopoverContent>
              </Popover>
              {/* 4-Hour Sales Trend - simple up/down indicators */}
              {hourlySales.length >= 2 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <div className="flex items-center gap-1 text-xs flex-wrap">
                    <Popover>
                      <PopoverTrigger asChild>
                        <span className="text-muted-foreground cursor-help">4hr:</span>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" className="w-auto max-w-[180px] p-2 text-xs">
                        Each arrow shows if that hour beat last week (▲) or not (▼)
                      </PopoverContent>
                    </Popover>
                    {hourlySales.map((h, i) => (
                      <span key={h.hour} className="flex items-center">
                        <span className={`font-bold text-base ${h.diff >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {h.diff >= 0 ? '▲' : '▼'}
                        </span>
                        {i < hourlySales.length - 1 && <span className="text-muted-foreground mx-0.5"></span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Projected Daily Sales */}
      <Card data-testid="card-summary-projected">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
              <Target className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm text-muted-foreground">Projected Daily Total</p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                  </PopoverTrigger>
                  <PopoverContent side="top" className="w-auto max-w-[220px] p-2 text-xs">
                    Today's sales plus remaining hours from last week
                  </PopoverContent>
                </Popover>
              </div>
              {projectedData.isDayComplete ? (
                <>
                  <p className="text-xl font-bold flex items-center gap-2" data-testid="text-projected-daily">
                    {formatCurrency(projectedData.actualSoFar)}
                    {totalLastWeekFullDay > 0 && (
                      projectedData.actualSoFar >= totalLastWeekFullDay ? (
                        <span className="text-green-600 dark:text-green-400 flex items-center text-sm font-medium">
                          <TrendingUp className="w-4 h-4 mr-0.5" />
                          vs LW
                        </span>
                      ) : (
                        <span className="text-red-600 dark:text-red-400 flex items-center text-sm font-medium">
                          <TrendingDown className="w-4 h-4 mr-0.5" />
                          vs LW
                        </span>
                      )
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">Day complete</p>
                  <Popover>
                    <PopoverTrigger asChild>
                      <div className="mt-1 text-xs cursor-help">
                        <span className="font-semibold text-green-600 dark:text-green-400">{aheadOfPaceCount}</span>
                        <span className="text-muted-foreground"> ahead</span>
                        <span className="mx-1 text-muted-foreground">·</span>
                        <span className="font-semibold text-red-600 dark:text-red-400">{activeRestaurants.length - aheadOfPaceCount}</span>
                        <span className="text-muted-foreground"> behind LW</span>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent side="bottom" className="w-auto max-w-[180px] p-2 text-xs">
                      Stores beating or trailing last week's pace
                    </PopoverContent>
                  </Popover>
                </>
              ) : (
                <>
                  <p className="text-xl font-bold flex items-center gap-2" data-testid="text-projected-daily">
                    {formatCurrency(projectedData.projected)}
                    {totalLastWeekFullDay > 0 && (
                      projectedData.projected >= totalLastWeekFullDay ? (
                        <span className="text-green-600 dark:text-green-400 flex items-center text-sm font-medium">
                          <TrendingUp className="w-4 h-4 mr-0.5" />
                          vs LW
                        </span>
                      ) : (
                        <span className="text-red-600 dark:text-red-400 flex items-center text-sm font-medium">
                          <TrendingDown className="w-4 h-4 mr-0.5" />
                          vs LW
                        </span>
                      )
                    )}
                  </p>
                  <Popover>
                    <PopoverTrigger asChild>
                      <p className="text-xs text-muted-foreground cursor-help">
                        {formatCurrency(projectedData.actualSoFar)} actual + {formatCurrency(projectedData.remainingForecast)} LW remaining
                      </p>
                    </PopoverTrigger>
                    <PopoverContent side="bottom" className="w-auto max-w-[200px] p-2 text-xs">
                      Uses last week's remaining hours to estimate today's total
                    </PopoverContent>
                  </Popover>
                  <Popover>
                    <PopoverTrigger asChild>
                      <div className="mt-1 text-xs cursor-help">
                        <span className="font-semibold text-green-600 dark:text-green-400">{aheadOfPaceCount}</span>
                        <span className="text-muted-foreground"> ahead</span>
                        <span className="mx-1 text-muted-foreground">·</span>
                        <span className="font-semibold text-red-600 dark:text-red-400">{activeRestaurants.length - aheadOfPaceCount}</span>
                        <span className="text-muted-foreground"> behind LW</span>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent side="bottom" className="w-auto max-w-[180px] p-2 text-xs">
                      Stores beating or trailing last week's pace
                    </PopoverContent>
                  </Popover>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
