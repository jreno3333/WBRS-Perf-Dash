import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown, Store, Target } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";

interface SummaryCardsProps {
  restaurants: RestaurantSales[];
  lastUpdated: string;
  paceData?: HourlySalesData[];
}

export function SummaryCards({ restaurants, lastUpdated, paceData }: SummaryCardsProps) {
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
  const totalTodaySales = activeRestaurants.reduce((sum, r) => sum + r.todaySales, 0);
  const totalLastWeekSales = activeRestaurants.reduce((sum, r) => sum + r.lastWeekSales, 0);
  const totalForecastSales = activeRestaurants.reduce((sum, r) => sum + r.forecastSales, 0);
  
  // Calculate total last week full day sales for projected comparison
  const totalLastWeekFullDay = activeRestaurants.reduce((sum, r) => {
    // forecastSales is: today's actual + remainder from last week
    // So lastWeek full day = forecastSales represents the projected total based on last week's pattern
    return sum + (r.forecastSales || 0);
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

  // Calculate projected daily sales: actual sales so far + remaining forecast
  // Data is cumulative, so actualSoFar = last hour's todaySales
  // remainingForecast = full day forecast - forecast at last data hour
  const calculateProjectedDaily = () => {
    if (!paceData || paceData.length === 0) {
      return { projected: 0, actualSoFar: 0, remainingForecast: 0 };
    }
    
    // Find cumulative actual sales (highest todaySales value)
    let actualSoFar = 0;
    let lastHourWithSales = -1;
    let forecastAtLastHour = 0;
    
    paceData.forEach((hour) => {
      if (hour.todaySales > 0) {
        actualSoFar = hour.todaySales; // Cumulative - last value is total so far
        lastHourWithSales = hour.hour;
        forecastAtLastHour = hour.forecastSales;
      }
    });
    
    // Find the full day forecast (max forecastSales value)
    const fullDayForecast = Math.max(...paceData.map(h => h.forecastSales), 0);
    
    // Remaining forecast = full day forecast - forecast at last hour with actual data
    const remainingForecast = Math.max(0, fullDayForecast - forecastAtLastHour);
    
    return {
      projected: actualSoFar + remainingForecast,
      actualSoFar,
      remainingForecast
    };
  };
  
  const projectedData = calculateProjectedDaily();

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

      {/* Projected Daily Sales */}
      <Card data-testid="card-summary-projected">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
              <Target className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">Projected Daily Total</p>
              <p className="text-xl font-bold flex items-center gap-2" data-testid="text-projected-daily">
                {projectedData.projected > 0 ? formatCurrency(projectedData.projected) : "--"}
                {projectedData.projected > 0 && totalLastWeekFullDay > 0 && (
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
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
