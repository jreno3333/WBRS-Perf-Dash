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
  const aheadOfPaceCount = restaurants.filter((r) => r.isAheadOfPace).length;
  const avgPacePercentage = restaurants.length > 0 
    ? restaurants.reduce((sum, r) => sum + r.pacePercentage, 0) / restaurants.length 
    : 0;
  
  const overallVariance = totalLastWeekSales > 0 
    ? ((totalTodaySales / (totalLastWeekSales * (avgPacePercentage / 100))) - 1) * 100 
    : 0;

  const cards = [
    {
      title: "Total Sales Today",
      value: formatCurrency(totalTodaySales),
      description: `vs ${formatCurrency(totalLastWeekSales)} last week`,
      icon: DollarSign,
      iconColor: "text-green-600 dark:text-green-400",
      bgColor: "bg-green-100 dark:bg-green-900/30",
    },
    {
      title: "vs Last Week Pace",
      value: `${overallVariance >= 0 ? "+" : ""}${overallVariance.toFixed(1)}%`,
      description: overallVariance >= 0 ? "Ahead of pace" : "Behind pace",
      icon: TrendingUp,
      iconColor: overallVariance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
      bgColor: overallVariance >= 0 ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30",
    },
    {
      title: "Restaurants Ahead",
      value: `${aheadOfPaceCount}/${restaurants.length}`,
      description: `${restaurants.length - aheadOfPaceCount} behind pace`,
      icon: Store,
      iconColor: "text-blue-600 dark:text-blue-400",
      bgColor: "bg-blue-100 dark:bg-blue-900/30",
    },
    {
      title: "Last Updated",
      value: lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "--:--",
      description: "Refreshes every 15 min",
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
                <p className="text-xl font-bold truncate" data-testid={`text-summary-value-${index}`}>
                  {card.value}
                </p>
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
