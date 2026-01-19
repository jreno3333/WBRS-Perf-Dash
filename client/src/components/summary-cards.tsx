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

  const cards = [
    {
      title: "vs Last Week",
      value: `${lwVariance >= 0 ? "+" : ""}${lwVariance.toFixed(1)}%`,
      subValue: `${lwDollarDiff >= 0 ? "+" : ""}${formatCurrency(lwDollarDiff)}`,
      description: `Today ${formatCurrency(totalTodaySales)} vs LW ${formatCurrency(totalLastWeekSales)}`,
      icon: TrendingUp,
      iconColor: lwVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
      bgColor: lwVariance >= 0 ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30",
    },
    {
      title: "vs Forecast",
      value: `${fcVariance >= 0 ? "+" : ""}${fcVariance.toFixed(1)}%`,
      subValue: `${fcDollarDiff >= 0 ? "+" : ""}${formatCurrency(fcDollarDiff)}`,
      description: `Today ${formatCurrency(totalTodaySales)} vs FC ${formatCurrency(totalForecastSales)}`,
      icon: TrendingUp,
      iconColor: fcVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
      bgColor: fcVariance >= 0 ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30",
    },
    {
      title: "Restaurants Ahead",
      value: `${aheadOfPaceCount}/${restaurants.length}`,
      subValue: null,
      description: `${restaurants.length - aheadOfPaceCount} behind pace`,
      icon: Store,
      iconColor: "text-blue-600 dark:text-blue-400",
      bgColor: "bg-blue-100 dark:bg-blue-900/30",
    },
    {
      title: "Last Updated",
      value: lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "--:--",
      subValue: null,
      description: "Refreshes every 5 min",
      icon: Clock,
      iconColor: "text-purple-600 dark:text-purple-400",
      bgColor: "bg-purple-100 dark:bg-purple-900/30",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, index) => (
        <Card key={index} data-testid={`card-summary-${index}`}>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${card.bgColor}`}>
                <card.icon className={`w-5 h-5 ${card.iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground truncate">
                  {card.title}
                </p>
                <div className="flex items-baseline gap-2">
                  <p className="text-xl font-bold truncate" data-testid={`text-summary-value-${index}`}>
                    {card.value}
                  </p>
                  {card.subValue && (
                    <p className="text-sm font-medium text-muted-foreground truncate">
                      ({card.subValue})
                    </p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {card.description}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
