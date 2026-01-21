import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, MapPin } from "lucide-react";
import type { RestaurantSales } from "@shared/schema";

interface StateBreakdownProps {
  restaurants: RestaurantSales[];
}

const TENNESSEE_STORES = [
  "1680 - Powell",
  "1681 - Turkey Creek", 
  "1682 - Cumberland Avenue",
  "1679 - East Ridge",
  "1605 - Shallowford Village",
  "1729 - Sevierville"
];

export function StateBreakdown({ restaurants }: StateBreakdownProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  // Exclude training units from state breakdowns
  const activeRestaurants = restaurants.filter(r => r.status !== "training");
  const tennesseeRestaurants = activeRestaurants.filter(r => 
    TENNESSEE_STORES.some(name => r.restaurantName.includes(name.split(" - ")[1]))
  );
  const alabamaRestaurants = activeRestaurants.filter(r => 
    !TENNESSEE_STORES.some(name => r.restaurantName.includes(name.split(" - ")[1]))
  );

  // Use actualSales (all available hours) for display to match 7shifts
  const alabamaTodaySales = alabamaRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const alabamaLastWeekSales = alabamaRestaurants.reduce((sum, r) => sum + r.lastWeekSales, 0);
  const alabamaAheadCount = alabamaRestaurants.filter(r => r.isAheadOfPace).length;
  const alabamaVariance = alabamaLastWeekSales > 0 
    ? ((alabamaTodaySales / alabamaLastWeekSales) - 1) * 100 
    : 0;

  const tennesseeTodaySales = tennesseeRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const tennesseeLastWeekSales = tennesseeRestaurants.reduce((sum, r) => sum + r.lastWeekSales, 0);
  const tennesseeAheadCount = tennesseeRestaurants.filter(r => r.isAheadOfPace).length;
  const tennesseeVariance = tennesseeLastWeekSales > 0 
    ? ((tennesseeTodaySales / tennesseeLastWeekSales) - 1) * 100 
    : 0;

  const states = [
    {
      name: "Alabama",
      abbr: "AL",
      todaySales: alabamaTodaySales,
      lastWeekSales: alabamaLastWeekSales,
      variance: alabamaVariance,
      aheadCount: alabamaAheadCount,
      totalCount: alabamaRestaurants.length,
      isAhead: alabamaVariance >= 0,
    },
    {
      name: "Tennessee",
      abbr: "TN",
      todaySales: tennesseeTodaySales,
      lastWeekSales: tennesseeLastWeekSales,
      variance: tennesseeVariance,
      aheadCount: tennesseeAheadCount,
      totalCount: tennesseeRestaurants.length,
      isAhead: tennesseeVariance >= 0,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {states.map((state) => (
        <Card key={state.abbr} data-testid={`card-state-${state.abbr.toLowerCase()}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground" />
                <span className="font-semibold">{state.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {state.totalCount} stores
                </Badge>
              </div>
              {state.isAhead ? (
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">
                  <TrendingUp className="w-3.5 h-3.5 mr-1" />
                  +{state.variance.toFixed(1)}%
                </Badge>
              ) : (
                <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0">
                  <TrendingDown className="w-3.5 h-3.5 mr-1" />
                  {state.variance.toFixed(1)}%
                </Badge>
              )}
            </div>
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-2xl font-bold">{formatCurrency(state.todaySales)}</div>
                <div className="text-xs text-muted-foreground">
                  vs {formatCurrency(state.lastWeekSales)} last week
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold">
                  {state.aheadCount}/{state.totalCount}
                </div>
                <div className="text-xs text-muted-foreground">ahead of LW</div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
