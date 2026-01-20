import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Clock, MapPin, Users, Target } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";

interface LeaderboardCardProps {
  restaurant: RestaurantSales;
  hourlyData?: HourlySalesData[];
}

export function LeaderboardCard({ restaurant, hourlyData }: LeaderboardCardProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatPercentage = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}%`;
  };

  const getTimezoneLabel = (tz: string) => {
    if (tz.includes("New_York") || tz.includes("Eastern")) return "ET";
    if (tz.includes("Chicago") || tz.includes("Central")) return "CT";
    return tz.split("/").pop()?.substring(0, 2) || "??";
  };

  const paceVariance = restaurant.lastWeekSales > 0 
    ? ((restaurant.todaySales / restaurant.lastWeekSales) - 1) * 100 
    : 0;

  // Combine 5am and 6am into "Early Bird" and filter out hours 0-4
  const processedHours = (hourlyData || []).reduce((acc: HourlySalesData[], item) => {
    // Skip hours 0-4 (no sales)
    if (item.hour < 5) return acc;
    
    // Combine 5am and 6am into "Early Bird"
    if (item.hour === 5) {
      const hour6 = hourlyData?.find(d => d.hour === 6);
      acc.push({
        hour: 5,
        label: "Early Bird",
        todaySales: item.todaySales + (hour6?.todaySales || 0),
        lastWeekSales: item.lastWeekSales + (hour6?.lastWeekSales || 0),
        forecastSales: item.forecastSales + (hour6?.forecastSales || 0),
        projectedLabor: item.projectedLabor + (hour6?.projectedLabor || 0),
        actualLabor: item.actualLabor + (hour6?.actualLabor || 0),
      });
      return acc;
    }
    
    // Skip 6am since it's combined with 5am
    if (item.hour === 6) return acc;
    
    // Keep all other hours as-is
    acc.push(item);
    return acc;
  }, []);

  const activeHours = processedHours.filter(h => h.todaySales > 0 || h.lastWeekSales > 0 || h.forecastSales > 0);
  const maxSales = Math.max(
    ...activeHours.map(h => Math.max(h.todaySales, h.lastWeekSales, h.forecastSales)),
    1
  );
  
  // Calculate cumulative ACTUAL labor spent for completed hours
  // actualLabor from 7shifts reflects punched hours, not just scheduled
  const cumulativeActualLabor = processedHours.reduce(
    (sum, h) => sum + (h.actualLabor || 0), 0
  );
  
  // Scheduled labor for comparison with forecast
  const cumulativeScheduledLabor = processedHours.reduce(
    (sum, h) => sum + (h.projectedLabor || 0), 0
  );
  
  // Calculate what labor SHOULD be at this point based on sales performance
  // If sales are above forecast, labor % should be lower (good)
  // If sales are below forecast, labor % should be higher (bad)
  const cumulativeSales = processedHours.reduce((sum, h) => sum + h.todaySales, 0);
  const cumulativeForecast = processedHours.reduce((sum, h) => sum + h.forecastSales, 0);
  
  // Current labor % = (ACTUAL labor spent so far / actual sales so far) * 100
  const currentLaborPercent = cumulativeSales > 0 
    ? (cumulativeActualLabor / cumulativeSales) * 100 
    : 0;
  
  // Forecasted labor % at this point = (scheduled labor / forecast sales) * 100  
  const forecastLaborPercent = cumulativeForecast > 0
    ? (cumulativeScheduledLabor / cumulativeForecast) * 100
    : 0;
  
  // Are we making labor? (actual labor % is better than forecasted)
  const isMakingLabor = currentLaborPercent < forecastLaborPercent;

  // Calculate in-progress hour from full timeline (not just filtered activeHours)
  // Find the last hour that has actual sales data in the full timeline
  const lastHourWithSales = processedHours.reduce((max, h) => 
    h.todaySales > 0 ? h.hour : max, -1
  );
  // The in-progress hour is the first hour after lastHourWithSales
  const inProgressHour = lastHourWithSales >= 0 ? lastHourWithSales + 1 : -1;

  return (
    <Card 
      className="hover-elevate transition-all duration-200"
      data-testid={`card-restaurant-${restaurant.restaurantId}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <div className="flex-shrink-0">
            <div 
              className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold ${
                restaurant.rank === 1 
                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" 
                  : restaurant.rank === 2 
                    ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                    : restaurant.rank === 3 
                      ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                      : "bg-muted text-muted-foreground"
              }`}
              data-testid={`text-rank-${restaurant.restaurantId}`}
            >
              #{restaurant.rank}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 
                className="font-semibold text-base truncate"
                data-testid={`text-restaurant-name-${restaurant.restaurantId}`}
              >
                {restaurant.restaurantName}
              </h3>
              <Badge variant="secondary" className="flex-shrink-0 text-xs">
                <MapPin className="w-3 h-3 mr-1" />
                {getTimezoneLabel(restaurant.timezone)}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Hour {restaurant.normalizedHour}
              </span>
              <span className="text-xs">
                Last wk: {formatCurrency(restaurant.lastWeekSales)}
              </span>
              <span className="text-xs">
                Forecast: {formatCurrency(restaurant.forecastSales)}
              </span>
            </div>
          </div>

          <div className="flex-shrink-0 text-right">
            <div 
              className="text-xl font-bold mb-1"
              data-testid={`text-sales-${restaurant.restaurantId}`}
            >
              {formatCurrency(restaurant.todaySales)}
            </div>
            <div className="flex items-center justify-end gap-1">
              {restaurant.isAheadOfPace ? (
                <Badge 
                  className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0"
                  data-testid={`badge-pace-${restaurant.restaurantId}`}
                >
                  <TrendingUp className="w-3.5 h-3.5 mr-1" />
                  {formatPercentage(paceVariance)}
                </Badge>
              ) : (
                <Badge 
                  className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0"
                  data-testid={`badge-pace-${restaurant.restaurantId}`}
                >
                  <TrendingDown className="w-3.5 h-3.5 mr-1" />
                  {formatPercentage(paceVariance)}
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Labor Tracking - Based on Scheduled Labor vs Actual Sales */}
        {cumulativeScheduledLabor > 0 && (
          <div className="mt-3 pt-3 border-t border-border" data-testid={`labor-forecast-${restaurant.restaurantId}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <Users className="w-4 h-4 text-muted-foreground" />
                <span className="text-muted-foreground">Labor:</span>
                <span className={`font-semibold ${
                  isMakingLabor 
                    ? "text-green-600 dark:text-green-400" 
                    : "text-red-600 dark:text-red-400"
                }`}>
                  {currentLaborPercent.toFixed(1)}%
                </span>
                <span className="text-xs text-muted-foreground">
                  (forecast: {forecastLaborPercent.toFixed(1)}%)
                </span>
              </div>
              <Badge 
                className={`border-0 ${
                  isMakingLabor 
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" 
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}
                data-testid={`badge-labor-${restaurant.restaurantId}`}
              >
                <Target className="w-3 h-3 mr-1" />
                {isMakingLabor ? "Making Labor" : "Missing Labor"}
              </Badge>
            </div>
            <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
              <span>
                Actual Labor: {formatCurrency(cumulativeActualLabor)}
              </span>
              <span>
                Sales: {formatCurrency(cumulativeSales)}
              </span>
              <span>
                Forecast: {formatCurrency(cumulativeForecast)}
              </span>
            </div>
          </div>
        )}

        {activeHours.length > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-muted-foreground mb-2">
              <span>Hourly Sales</span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-green-500" />
                  Above
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-red-500" />
                  Below
                </span>
              </div>
            </div>
            <div className="flex items-end gap-0.5 h-12" data-testid={`hourly-chart-${restaurant.restaurantId}`}>
              {activeHours.map((hour) => {
                const isAhead = hour.todaySales >= hour.lastWeekSales;
                const displayValue = hour.todaySales > 0 ? hour.todaySales : hour.lastWeekSales;
                const barHeightPx = Math.max(4, (displayValue / maxSales) * 48);
                const hasNoData = hour.todaySales === 0 && hour.lastWeekSales > 0;
                // Only flag as "in progress" the first hour after the last hour with actual sales
                const isInProgress = hasNoData && hour.hour === inProgressHour;
                
                return (
                  <div
                    key={hour.hour}
                    className="flex-1 flex items-end group relative h-full"
                  >
                    <div
                      className={`w-full rounded-t-sm transition-all ${
                        isInProgress
                          ? "bg-gradient-to-t from-orange-400 to-orange-300 dark:from-orange-600 dark:to-orange-500 animate-pulse"
                          : hasNoData 
                            ? "bg-gray-300 dark:bg-gray-600" 
                            : isAhead 
                              ? "bg-green-500 dark:bg-green-400" 
                              : "bg-red-500 dark:bg-red-400"
                      }`}
                      style={{ height: `${barHeightPx}px` }}
                      title={`${hour.label}: $${hour.todaySales.toLocaleString()} vs $${hour.lastWeekSales.toLocaleString()}`}
                    />
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10">
                      <div className="font-medium">{hour.label}{isInProgress && " (In Progress)"}</div>
                      <div className="text-primary">Today: ${hour.todaySales.toLocaleString()}</div>
                      <div className="text-blue-600 dark:text-blue-400">Last wk: ${hour.lastWeekSales.toLocaleString()}</div>
                      <div className="text-green-600 dark:text-green-400">Forecast: ${hour.forecastSales.toLocaleString()}</div>
                      {isInProgress && <div className="text-orange-500 text-[10px]">Data updating...</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{activeHours[0]?.label || ""}</span>
              <span>{(() => {
                const lastHour = activeHours[activeHours.length - 1]?.hour;
                if (lastHour === undefined) return "";
                const nextHour = lastHour + 1;
                return nextHour === 0 ? "12am" : nextHour < 12 ? `${nextHour}am` : nextHour === 12 ? "12pm" : `${nextHour - 12}pm`;
              })()}</span>
            </div>
            
            {/* Hourly Labor Chart - Actual vs Target vs Forecast */}
            <div className="mt-3 pt-3 border-t border-border/50">
              <div className="flex justify-between text-xs text-muted-foreground mb-2">
                <span>Hourly Labor</span>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-blue-500" />
                    Actual
                  </span>
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-green-500" />
                    Target
                  </span>
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-amber-500" />
                    Forecast
                  </span>
                </div>
              </div>
              <div className="flex items-end gap-0.5 h-12" data-testid={`labor-chart-${restaurant.restaurantId}`}>
                {processedHours.map((hour) => {
                  const actualLabor = hour.actualLabor || 0;
                  const forecastLabor = hour.projectedLabor || 0;
                  // Target labor based on restaurant's labor target % (default 25%)
                  const laborTargetPercent = (restaurant.laborTarget || 25) / 100;
                  const targetLabor = hour.todaySales * laborTargetPercent;
                  const maxLabor = Math.max(
                    ...processedHours.map(h => Math.max(
                      h.actualLabor || 0, 
                      h.projectedLabor || 0, 
                      h.todaySales * laborTargetPercent
                    )), 
                    1
                  );
                  const hasNoData = actualLabor === 0 && forecastLabor === 0 && hour.todaySales === 0;
                  
                  // Calculate bar heights (max 48px for h-12)
                  const actualHeightPx = hasNoData ? 0 : Math.max(2, (actualLabor / maxLabor) * 48);
                  const targetHeightPx = hasNoData ? 0 : Math.max(2, (targetLabor / maxLabor) * 48);
                  const forecastHeightPx = hasNoData ? 0 : Math.max(2, (forecastLabor / maxLabor) * 48);
                  
                  return (
                    <div
                      key={`labor-${hour.hour}`}
                      className="flex-1 flex items-end justify-center gap-px group relative h-full"
                    >
                      {hasNoData ? (
                        <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-sm" />
                      ) : (
                        <>
                          {/* Actual - Blue */}
                          <div
                            className="w-1/3 bg-blue-500 dark:bg-blue-400 rounded-t-sm"
                            style={{ height: `${actualHeightPx}px` }}
                          />
                          {/* Target - Green */}
                          <div
                            className="w-1/3 bg-green-500 dark:bg-green-400 rounded-t-sm"
                            style={{ height: `${targetHeightPx}px` }}
                          />
                          {/* Forecast - Amber */}
                          <div
                            className="w-1/3 bg-amber-500 dark:bg-amber-400 rounded-t-sm"
                            style={{ height: `${forecastHeightPx}px` }}
                          />
                        </>
                      )}
                      <div className="absolute -top-14 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10">
                        <div className="font-medium">{hour.label}</div>
                        <div className="text-blue-600 dark:text-blue-400">
                          Actual: {formatCurrency(actualLabor)}
                        </div>
                        <div className="text-green-600 dark:text-green-400">
                          Target: {formatCurrency(targetLabor)}
                        </div>
                        <div className="text-amber-600 dark:text-amber-400">
                          Forecast: {formatCurrency(forecastLabor)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {activeHours.length === 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Progress vs. last week</span>
              <span>{restaurant.pacePercentage.toFixed(0)}% of day</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  restaurant.isAheadOfPace ? "bg-green-500" : "bg-red-500"
                }`}
                style={{ 
                  width: `${Math.min(100, (restaurant.todaySales / Math.max(restaurant.lastWeekSales, 1)) * 100)}%` 
                }}
                data-testid={`progress-${restaurant.restaurantId}`}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
