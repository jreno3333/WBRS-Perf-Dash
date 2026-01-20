import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, TrendingUp, Store, Clock } from "lucide-react";
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

  const totalTodaySales = restaurants.reduce((sum, r) => sum + r.todaySales, 0);
  const totalLastWeekSales = restaurants.reduce((sum, r) => sum + r.lastWeekSales, 0);
  const totalForecastSales = restaurants.reduce((sum, r) => sum + r.forecastSales, 0);
  const aheadOfPaceCount = restaurants.filter((r) => r.isAheadOfPace).length;
  
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

  // Count stores ahead of last week (vs forecast comparison)
  const aheadOfForecastCount = restaurants.filter((r) => r.todaySales >= r.forecastSales).length;

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

      {/* Last Updated */}
      <Card data-testid="card-summary-updated">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
              <Clock className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">Last Updated</p>
              <p className="text-xl font-bold" data-testid="text-last-updated">
                {lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "--:--"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Refreshes every 2 min
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
