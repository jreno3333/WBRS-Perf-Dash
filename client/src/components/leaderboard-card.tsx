import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Clock, MapPin } from "lucide-react";
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

  const activeHours = hourlyData?.filter(h => h.todaySales > 0 || h.lastWeekSales > 0 || h.forecastSales > 0) || [];
  const maxSales = Math.max(
    ...activeHours.map(h => Math.max(h.todaySales, h.lastWeekSales, h.forecastSales)),
    1
  );

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

        {activeHours.length > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-muted-foreground mb-2">
              <span>Hourly vs. Last Week</span>
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
                
                return (
                  <div
                    key={hour.hour}
                    className="flex-1 flex items-end group relative h-full"
                  >
                    <div
                      className={`w-full rounded-t-sm transition-all ${
                        hasNoData 
                          ? "bg-gray-300 dark:bg-gray-600" 
                          : isAhead 
                            ? "bg-green-500 dark:bg-green-400" 
                            : "bg-red-500 dark:bg-red-400"
                      }`}
                      style={{ height: `${barHeightPx}px` }}
                      title={`${hour.label}: $${hour.todaySales.toLocaleString()} vs $${hour.lastWeekSales.toLocaleString()}`}
                    />
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10">
                      <div className="font-medium">{hour.label}</div>
                      <div className="text-primary">Today: ${hour.todaySales.toLocaleString()}</div>
                      <div className="text-blue-600 dark:text-blue-400">Last wk: ${hour.lastWeekSales.toLocaleString()}</div>
                      <div className="text-green-600 dark:text-green-400">Forecast: ${hour.forecastSales.toLocaleString()}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{activeHours[0]?.label || ""}</span>
              <span>{activeHours[activeHours.length - 1]?.label || ""}</span>
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
