import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown, Store, Target } from "lucide-react";
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

function getExecutionGrade(salesUp: boolean, avgServiceTime: number | undefined, staffingDiff: number): string {
  const speed = !avgServiceTime ? 'GREEN' : avgServiceTime <= 300 ? 'GREEN' : avgServiceTime <= 420 ? 'YELLOW' : 'RED';
  const staffing = staffingDiff > 1 ? 'OVER' : staffingDiff < -1 ? 'UNDER' : 'PROPER';
  const scores: Record<string, string> = {
    'UP-GREEN-PROPER': 'A+', 'UP-GREEN-UNDER': 'A', 'UP-GREEN-OVER': 'B',
    'UP-YELLOW-PROPER': 'A', 'UP-YELLOW-UNDER': 'B', 'UP-YELLOW-OVER': 'C',
    'UP-RED-PROPER': 'B', 'UP-RED-UNDER': 'C', 'UP-RED-OVER': 'D',
    'DOWN-GREEN-PROPER': 'B', 'DOWN-GREEN-UNDER': 'C', 'DOWN-GREEN-OVER': 'D',
    'DOWN-YELLOW-PROPER': 'C', 'DOWN-YELLOW-UNDER': 'D', 'DOWN-YELLOW-OVER': 'F',
    'DOWN-RED-PROPER': 'D', 'DOWN-RED-UNDER': 'F', 'DOWN-RED-OVER': 'F',
  };
  return scores[`${salesUp ? 'UP' : 'DOWN'}-${speed}-${staffing}`] ?? 'C';
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
  
  if (hourlyByRestaurant) {
    for (const [restaurantId, hours] of Object.entries(hourlyByRestaurant)) {
      // Skip training units
      const restaurant = activeRestaurants.find(r => r.restaurantId === restaurantId);
      if (!restaurant) continue;
      
      const restaurantHourlyScores: number[] = [];
      for (const hour of hours) {
        // Include all hours with sales data
        if (!hour.todaySales && !hour.lastWeekSales) continue;
        
        const isAhead = hour.todaySales >= hour.lastWeekSales;
        const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
        const actualStaff = Number(hour.employeeCount) || 0;
        const staffingDiff = actualStaff - staffing.total;
        const grade = getExecutionGrade(isAhead, hour.avgServiceTime, staffingDiff);
        const score = gradeToScore(grade);
        if (score > 0) {
          allHourlyScores.push(score);
          restaurantHourlyScores.push(score);
        }
      }
      
      // Calculate this restaurant's overall grade
      if (restaurantHourlyScores.length > 0) {
        const avgScore = restaurantHourlyScores.reduce((a, b) => a + b, 0) / restaurantHourlyScores.length;
        restaurantGrades[restaurantId] = scoreToGrade(avgScore);
      }
    }
  }
  
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
              <p className="text-lg font-semibold">Daily Execution</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {allHourlyScores.length} hours graded
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Total Sales with vs LW */}
      <Card data-testid="card-summary-sales">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-orange-100 dark:bg-orange-900/30">
              <DollarSign className="w-5 h-5 text-orange-600 dark:text-orange-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">Total Sales Today</p>
              <p className="text-xl font-bold" data-testid="text-total-sales">
                {formatCurrency(totalTodaySales)}
              </p>
              <p className={`text-xs font-medium mt-1 ${lwVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                vs LW: {lwVariance >= 0 ? "+" : ""}{lwVariance.toFixed(1)}% ({lwDollarDiff >= 0 ? "+" : ""}{formatCurrency(lwDollarDiff)})
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Store Performance by Execution Grade */}
      <Card data-testid="card-summary-ahead">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
              <Store className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">Execution by Store</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {gradeCounts['A+'] > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    A+ <span className="font-bold">{gradeCounts['A+']}</span>
                  </span>
                )}
                {gradeCounts['A'] > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    A <span className="font-bold">{gradeCounts['A']}</span>
                  </span>
                )}
                {gradeCounts['B'] > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    B <span className="font-bold">{gradeCounts['B']}</span>
                  </span>
                )}
                {gradeCounts['C'] > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                    C <span className="font-bold">{gradeCounts['C']}</span>
                  </span>
                )}
                {gradeCounts['D'] > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                    D <span className="font-bold">{gradeCounts['D']}</span>
                  </span>
                )}
                {gradeCounts['F'] > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    F <span className="font-bold">{gradeCounts['F']}</span>
                  </span>
                )}
                {Object.values(gradeCounts).every(c => c === 0) && (
                  <span className="text-xs text-muted-foreground">No grades yet</span>
                )}
              </div>
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
              <p className="text-sm text-muted-foreground">Projected Daily Total</p>
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
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(projectedData.actualSoFar)} actual + {formatCurrency(projectedData.remainingForecast)} LW remaining
                  </p>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
