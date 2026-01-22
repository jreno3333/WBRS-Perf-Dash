import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown, Store, Target } from "lucide-react";
import type { RestaurantSales } from "@shared/schema";

interface SummaryCardsProps {
  restaurants: RestaurantSales[];
  lastUpdated: string;
}

export function SummaryCards({ restaurants, lastUpdated }: SummaryCardsProps) {
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
  
  // Calculate variance vs forecast
  const fcVariance = totalForecastSales > 0 
    ? ((totalTodaySales / totalForecastSales) - 1) * 100 
    : 0;
  const fcDollarDiff = totalTodaySales - totalForecastSales;

  // Count stores ahead of last week (vs forecast comparison) - exclude training
  const aheadOfForecastCount = activeRestaurants.filter((r) => r.todaySales >= r.forecastSales).length;

  // Calculate projected daily: sum of all restaurant forecast sales
  // Each restaurant's forecastSales = actual + LW remaining hours (same methodology)
  // This gives us the total projected daily sales using consistent logic
  const projectedData = {
    projected: totalForecastSales,
    actualSoFar: totalTodaySales,
    remainingForecast: Math.max(0, totalForecastSales - totalTodaySales)
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Total Sales with vs LW and vs FC */}
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
              <div className="mt-1 space-y-0.5">
                <p className={`text-xs font-medium ${lwVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                  vs LW: {lwVariance >= 0 ? "+" : ""}{lwVariance.toFixed(1)}% ({lwDollarDiff >= 0 ? "+" : ""}{formatCurrency(lwDollarDiff)})
                </p>
                <p className={`text-xs font-medium ${fcVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                  vs FC: {fcVariance >= 0 ? "+" : ""}{fcVariance.toFixed(1)}% ({fcDollarDiff >= 0 ? "+" : ""}{formatCurrency(fcDollarDiff)})
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Restaurants Ahead */}
      <Card data-testid="card-summary-ahead">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
              <Store className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">Store Performance</p>
              <div className="mt-1 space-y-0.5">
                <p className="text-sm">
                  <span className="font-bold text-green-600 dark:text-green-400">{aheadOfPaceCount}</span>
                  <span className="text-muted-foreground"> ahead of last week</span>
                </p>
                <p className="text-sm">
                  <span className="font-bold text-red-600 dark:text-red-400">{restaurants.length - aheadOfPaceCount}</span>
                  <span className="text-muted-foreground"> behind last week</span>
                </p>
                <p className="text-sm">
                  <span className="font-bold text-green-600 dark:text-green-400">{aheadOfForecastCount}</span>
                  <span className="text-muted-foreground"> ahead of forecast</span>
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Projected Daily Sales - shows N/A when day is complete (no remaining forecast) */}
      <Card data-testid="card-summary-projected">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
              <Target className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">Projected Daily Total</p>
              {projectedData.remainingForecast <= 0 ? (
                <>
                  <p className="text-xl font-bold" data-testid="text-projected-daily">N/A</p>
                  <div className="mt-1 space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      Day complete - no forecast needed
                    </p>
                  </div>
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
                  <div className="mt-1 space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(projectedData.actualSoFar)} actual + {formatCurrency(projectedData.remainingForecast)} forecast
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
