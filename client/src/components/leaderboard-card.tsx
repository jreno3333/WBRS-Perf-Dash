import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Clock, MapPin } from "lucide-react";
import type { RestaurantSales } from "@shared/schema";

interface LeaderboardCardProps {
  restaurant: RestaurantSales;
}

export function LeaderboardCard({ restaurant }: LeaderboardCardProps) {
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

  const paceVariance = ((restaurant.todaySales / Math.max(restaurant.lastWeekSales * (restaurant.pacePercentage / 100), 1)) - 1) * 100;

  return (
    <Card 
      className="hover-elevate transition-all duration-200"
      data-testid={`card-restaurant-${restaurant.restaurantId}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          {/* Rank Badge */}
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

          {/* Restaurant Info */}
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
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Hour {restaurant.normalizedHour}
              </span>
              <span className="text-xs">
                Last week: {formatCurrency(restaurant.lastWeekSales)}
              </span>
            </div>
          </div>

          {/* Sales & Pace */}
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

        {/* Progress Bar */}
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
      </CardContent>
    </Card>
  );
}
