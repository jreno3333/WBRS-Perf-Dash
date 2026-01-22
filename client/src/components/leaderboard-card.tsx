import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Clock, MapPin, Car, Smartphone, Utensils, ShoppingBag, AlertTriangle, Ban, ChevronDown, ChevronUp, Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle, Droplets, Wind } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

const REVENUE_PORT_CONFIG = {
  dine_in: { label: "Dine In", icon: Utensils, color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Indoor dining available", disabledDesc: "No indoor dining" },
  drive_thru: { label: "Drive Thru", icon: Car, color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Drive-thru window service", disabledDesc: "No drive-thru" },
  app: { label: "APP", icon: Smartphone, color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Mobile app ordering", disabledDesc: "No app ordering" },
  "3pd": { label: "3PD", icon: ShoppingBag, color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Third-party delivery (DoorDash, UberEats, etc.)", disabledDesc: "No third-party delivery" },
} as const;

const ALL_REVENUE_PORTS = ["dine_in", "drive_thru", "app", "3pd"] as const;

function WeatherIcon({ condition }: { condition: string }) {
  const iconClass = "w-3.5 h-3.5";
  switch (condition.toLowerCase()) {
    case "clear":
      return <Sun className={iconClass} />;
    case "partly cloudy":
      return <Cloud className={iconClass} />;
    case "foggy":
      return <CloudFog className={iconClass} />;
    case "rain":
      return <CloudRain className={iconClass} />;
    case "showers":
      return <CloudDrizzle className={iconClass} />;
    case "snow":
      return <CloudSnow className={iconClass} />;
    case "thunderstorm":
      return <CloudLightning className={iconClass} />;
    default:
      return <Sun className={iconClass} />;
  }
}

interface LeaderboardCardProps {
  restaurant: RestaurantSales;
  hourlyData?: HourlySalesData[];
}

export function LeaderboardCard({ restaurant, hourlyData }: LeaderboardCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
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

  const getTimezoneDisplay = (tz: string, normalizedHour: number) => {
    // Show "up to X" time - the next hour after the last completed hour
    // If normalizedHour is 19 (7pm completed), show "up to 8pm"
    const upToHour = (normalizedHour + 1) % 24;
    const displayHour = upToHour === 0 ? 12 : upToHour > 12 ? upToHour - 12 : upToHour;
    const ampm = upToHour >= 12 ? 'pm' : 'am';
    const timeStr = `${displayHour}${ampm}`;
    
    if (tz.includes("New_York") || tz.includes("Eastern")) return `${timeStr} EST`;
    if (tz.includes("Chicago") || tz.includes("Central")) return `${timeStr} CST`;
    return `${timeStr}`;
  };

  const paceVariance = restaurant.lastWeekSales > 0 
    ? ((restaurant.todaySales / restaurant.lastWeekSales) - 1) * 100 
    : 0;

  // Eastern timezone units have data issues with Early Bird extending through 8am
  // Central units use the standard 0-6 Early Bird range
  const isEasternTimezone = restaurant.timezone?.includes("New_York") || restaurant.timezone?.includes("Eastern");
  const earlyBirdEndHour = isEasternTimezone ? 8 : 6;
  
  // Combine early morning hours into "Early Bird" bucket
  // For Eastern: hours 0-8, For Central: hours 0-6
  const processedHours = (hourlyData || []).reduce((acc: HourlySalesData[], item) => {
    // Skip hours before 5am (no sales displayed, but labor is included in Early Bird)
    if (item.hour < 5) return acc;
    
    // Combine hours into "Early Bird" with summed sales and labor from midnight
    if (item.hour === 5) {
      // Get all hours within Early Bird range
      const earlyBirdHours = (hourlyData || []).filter(h => h.hour <= earlyBirdEndHour);
      
      // SUM sales for all Early Bird hours (data is per-hour, not cumulative)
      const totalSales = earlyBirdHours.reduce((sum, h) => ({
        todaySales: sum.todaySales + (h.todaySales || 0),
        lastWeekSales: sum.lastWeekSales + (h.lastWeekSales || 0),
        forecastSales: sum.forecastSales + (h.forecastSales || 0),
      }), { todaySales: 0, lastWeekSales: 0, forecastSales: 0 });
      
      // Sum labor from hours 0 through earlyBirdEndHour for Early Bird
      const cumulativeLabor = earlyBirdHours.reduce((sum, h) => ({
        projectedLabor: sum.projectedLabor + (h.projectedLabor || 0),
        actualLabor: sum.actualLabor + (h.actualLabor || 0),
      }), { projectedLabor: 0, actualLabor: 0 });
      
      // Sum labor hours across the Early Bird period
      const totalLaborHours = earlyBirdHours.reduce((sum, h) => sum + (Number(h.employeeCount) || 0), 0);
      
      // Combine position breakdowns from all Early Bird hours
      const combinedPositionBreakdown: Record<string, number> = {};
      earlyBirdHours.forEach(h => {
        const breakdown = h.positionBreakdown || {};
        Object.entries(breakdown).forEach(([pos, hours]) => {
          combinedPositionBreakdown[pos] = (combinedPositionBreakdown[pos] || 0) + (hours as number);
        });
      });
      
      // Push combined Early Bird data with summed sales
      acc.push({
        hour: 5,
        label: "Early Bird",
        todaySales: totalSales.todaySales,
        lastWeekSales: totalSales.lastWeekSales,
        forecastSales: totalSales.forecastSales,
        projectedLabor: cumulativeLabor.projectedLabor,
        actualLabor: cumulativeLabor.actualLabor,
        employeeCount: totalLaborHours,
        positionBreakdown: combinedPositionBreakdown,
      });
      return acc;
    }
    
    // Skip hours that are combined into Early Bird
    if (item.hour <= earlyBirdEndHour) return acc;
    
    // Keep all other hours as-is
    acc.push(item);
    return acc;
  }, []);

  // Filter to only show hours up to the normalized cutoff (used for ranking)
  // This keeps the chart consistent with the sales figures displayed
  const normalizedCutoff = restaurant.normalizedHour;
  const activeHours = processedHours.filter(h => {
    // Early Bird (hour 5) represents hours 0 through earlyBirdEndHour
    // Show it if the normalized cutoff is at or past the Early Bird end
    if (h.hour === 5 && h.label === "Early Bird") {
      return normalizedCutoff >= earlyBirdEndHour;
    }
    // For other hours, only show if within the normalized cutoff
    return h.hour <= normalizedCutoff && (h.todaySales > 0 || h.lastWeekSales > 0 || h.forecastSales > 0);
  });
  const maxSales = Math.max(
    ...activeHours.map(h => Math.max(h.todaySales, h.lastWeekSales, h.forecastSales)),
    1
  );
  
  // No in-progress hour needed since we only show completed hours now

  return (
    <Card 
      className="hover-elevate transition-all duration-200"
      data-testid={`card-restaurant-${restaurant.restaurantId}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <div className="flex-shrink-0">
            {restaurant.status === "training" ? (
              <div 
                className="w-12 h-12 rounded-full flex items-center justify-center text-xs font-bold bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                data-testid={`text-rank-${restaurant.restaurantId}`}
              >
                N/A
              </div>
            ) : (
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
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 
                className="font-semibold text-base truncate"
                data-testid={`text-restaurant-name-${restaurant.restaurantId}`}
              >
                {restaurant.restaurantName}
              </h3>
              {restaurant.status === "training" && (
                <Badge variant="secondary" className="flex-shrink-0 text-xs" data-testid={`badge-training-${restaurant.restaurantId}`}>
                  Training - Opens {restaurant.openDate ? new Date(restaurant.openDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBD'}
                </Badge>
              )}
              {restaurant.status === "new" && (
                <Badge className="bg-blue-500 hover:bg-blue-600 flex-shrink-0 text-xs text-white" data-testid={`badge-new-unit-${restaurant.restaurantId}`}>
                  NEW UNIT ({restaurant.daysOpen && restaurant.daysOpen >= 7 ? `${Math.floor(restaurant.daysOpen / 7)}w ${restaurant.daysOpen % 7}d` : `${restaurant.daysOpen || 0}d`})
                </Badge>
              )}
              <Badge variant="secondary" className="flex-shrink-0 text-xs">
                <Clock className="w-3 h-3 mr-1" />
                {getTimezoneDisplay(restaurant.timezone, restaurant.normalizedHour)}
              </Badge>
              {/* Revenue Port Badges - Show all with enabled/disabled state */}
              <div className="flex items-center gap-1">
                {ALL_REVENUE_PORTS.map(port => {
                  const config = REVENUE_PORT_CONFIG[port];
                  const isEnabled = restaurant.revenuePorts?.includes(port) ?? false;
                  const Icon = config.icon;
                  return (
                    <div key={port} className="relative group">
                      <Badge 
                        className={`${isEnabled ? config.color : config.disabledColor} border-0 flex-shrink-0 text-xs px-1.5 cursor-help relative`}
                        data-testid={`badge-port-${port}-${restaurant.restaurantId}`}
                      >
                        <Icon className="w-3 h-3" />
                        {!isEnabled && (
                          <Ban className="w-4 h-4 absolute -top-0.5 -right-0.5 text-red-500 dark:text-red-400" strokeWidth={2.5} />
                        )}
                      </Badge>
                      <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                        <div className="font-medium">{config.label}</div>
                        <div className="text-muted-foreground">{isEnabled ? config.description : config.disabledDesc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Weather Badge */}
              {restaurant.weather && (
                <div className="relative group">
                  <Badge 
                    variant="secondary" 
                    className="flex-shrink-0 text-xs cursor-help gap-1"
                    data-testid={`badge-weather-${restaurant.restaurantId}`}
                  >
                    <WeatherIcon condition={restaurant.weather.condition} />
                    <span>{Math.round(restaurant.weather.temp)}°F</span>
                  </Badge>
                  <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                    <div className="font-medium capitalize">{restaurant.weather.condition}</div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Droplets className="w-3 h-3" />
                      {restaurant.weather.humidity}%
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Wind className="w-3 h-3" />
                      {Math.round(restaurant.weather.windSpeed)} mph
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              <span className="text-xs">
                LW up to {(() => {
                  const upToHour = (restaurant.normalizedHour + 1) % 24;
                  const displayHour = upToHour === 0 ? 12 : upToHour > 12 ? upToHour - 12 : upToHour;
                  const ampm = upToHour >= 12 ? 'pm' : 'am';
                  return `${displayHour}${ampm}`;
                })()}: {formatCurrency(restaurant.lastWeekSales)}
              </span>
              <div className="relative group">
                <span className="text-xs cursor-help">
                  EOD Forecast: {(() => {
                    // If forecast equals actual (no remaining hours), day is complete - show N/A
                    const forecastPortion = restaurant.forecastSales - restaurant.actualSales;
                    if (forecastPortion <= 0) {
                      return "N/A";
                    }
                    return formatCurrency(restaurant.forecastSales);
                  })()}
                </span>
                <div className="absolute -top-14 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                  <div className="font-medium">End-of-Day Forecast</div>
                  <div className="text-muted-foreground">
                    {restaurant.forecastSales - restaurant.actualSales <= 0 
                      ? "Day complete - no forecast needed" 
                      : "Today's actual + last week's remaining hours"}
                  </div>
                </div>
              </div>
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
          
          <div 
            className="flex-shrink-0 text-muted-foreground cursor-pointer p-2 -m-2 rounded-full hover:bg-muted/50 transition-colors"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid={`toggle-expand-${restaurant.restaurantId}`}
          >
            {isExpanded ? (
              <ChevronUp className="w-5 h-5" data-testid={`chevron-collapse-${restaurant.restaurantId}`} />
            ) : (
              <ChevronDown className="w-5 h-5" data-testid={`chevron-expand-${restaurant.restaurantId}`} />
            )}
          </div>
        </div>


        {isExpanded && activeHours.length > 0 && (
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
                
                return (
                  <div
                    key={hour.hour}
                    className="flex-1 flex items-end group relative h-full"
                  >
                    <div
                      className={`w-full rounded-t-sm transition-all ${
                        isAhead 
                          ? "bg-green-500 dark:bg-green-400" 
                          : "bg-red-500 dark:bg-red-400"
                      }`}
                      style={{ height: `${barHeightPx}px` }}
                      title={`${hour.label}: $${hour.todaySales.toLocaleString()} vs $${hour.lastWeekSales.toLocaleString()}`}
                    />
                    <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10">
                      <div className="font-medium">{hour.label}</div>
                      <div className="text-primary">Today: ${hour.todaySales.toLocaleString()}</div>
                      <div className="text-blue-600 dark:text-blue-400">Last Week: ${hour.lastWeekSales.toLocaleString()}</div>
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
                const nextHour = (lastHour + 1) % 24;
                return nextHour === 0 ? "12am" : nextHour < 12 ? `${nextHour}am` : nextHour === 12 ? "12pm" : `${nextHour - 12}pm`;
              })()}</span>
            </div>
            
            {/* Staffing Chart - Labor Hours Deployed vs Recommended */}
            <div className="mt-3 pt-3 border-t border-border/50">
              <div className="flex justify-between text-xs text-muted-foreground mb-2">
                <span>Labor Hours Deployed</span>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-green-500" />
                    Right-sized
                  </span>
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-red-500" />
                    Overstaffed
                  </span>
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-yellow-500" />
                    Understaffed
                  </span>
                  <span className="flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-orange-500" />
                    No Mgr
                  </span>
                </div>
              </div>
              <div className="flex items-end gap-0.5 h-10" data-testid={`staffing-chart-${restaurant.restaurantId}`}>
                {processedHours.map((hour) => {
                  // Early Bird hours are excluded from staffing display - not meaningful
                  // Eastern units: hours 0-8, Central units: hours 0-6
                  const isEarlyBirdHour = hour.label === "Early Bird" || hour.hour <= earlyBirdEndHour;
                  
                  if (isEarlyBirdHour) {
                    return (
                      <div
                        key={`staff-${hour.hour}`}
                        className="flex-1 flex items-end group relative h-full"
                      >
                        <div className="w-full h-1 bg-gray-300 dark:bg-gray-600 rounded-sm" />
                        <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10">
                          <div className="font-medium">{hour.label}</div>
                          <div className="text-muted-foreground">Staffing: N/A</div>
                        </div>
                      </div>
                    );
                  }
                  
                  const laborHours = Number(hour.employeeCount) || 0;
                  const sales = hour.todaySales || 0;
                  
                  // Labor deployment model: Non-production + Production staff
                  // Uses different ramp-up charts for breakfast (6am-11am) vs non-breakfast
                  const staffingDetails = getStaffingBreakdown(hour.hour, sales);
                  const recommendedHours = staffingDetails.total;
                  
                  // Staffing status: Green ±1 hr, Red >1 over, Yellow >1 under
                  const staffingDiff = laborHours - recommendedHours;
                  const isRightSized = Math.abs(staffingDiff) <= 1;
                  const isOverstaffed = staffingDiff > 1;
                  const isUnderstaffed = staffingDiff < -1;
                  
                  const hasNoData = laborHours === 0 && sales === 0;
                  
                  // Bar height based on labor hours (cap at 15 for display)
                  const maxDisplayHours = 15;
                  const displayHours = Math.min(laborHours, maxDisplayHours);
                  const barHeightPx = hasNoData ? 0 : Math.max(3, (displayHours / maxDisplayHours) * 40);
                  
                  // Target line position (cap at same max for consistency)
                  const targetDisplayHours = Math.min(recommendedHours, maxDisplayHours);
                  const targetLineHeightPx = (targetDisplayHours / maxDisplayHours) * 40;
                  
                  // Bar color: green (right-sized), red (>2 over), yellow (>2 under)
                  const barColor = isRightSized 
                    ? "bg-green-500 dark:bg-green-400" 
                    : isOverstaffed 
                      ? "bg-red-500 dark:bg-red-400" 
                      : "bg-yellow-500 dark:bg-yellow-400";
                  
                  // Check for missing manager/shift supervisor
                  const positions = hour.positionBreakdown || {};
                  const positionKeys = Object.keys(positions).map(k => k.toLowerCase());
                  const hasManager = positionKeys.some(p => p.includes("manager"));
                  const hasShiftSupervisor = positionKeys.some(p => p.includes("shift supervisor") || p.includes("supervisor"));
                  const missingLeadership = !hasManager && !hasShiftSupervisor && laborHours > 0;
                  
                  return (
                    <div
                      key={`staff-${hour.hour}`}
                      className="flex-1 flex items-end group relative h-full"
                    >
                      {hasNoData ? (
                        <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-sm" />
                      ) : (
                        <>
                          <div
                            className={`w-full rounded-t-sm transition-all ${barColor}`}
                            style={{ height: `${barHeightPx}px` }}
                          />
                          {/* Target line showing recommended staffing level */}
                          <div
                            className="absolute w-full border-t-2 border-slate-800 dark:border-slate-200 pointer-events-none"
                            style={{ bottom: `${targetLineHeightPx}px` }}
                          />
                          {/* Hazard indicator for missing manager/supervisor */}
                          {missingLeadership && (
                            <div className="absolute -top-1 left-1/2 -translate-x-1/2">
                              <AlertTriangle className="w-3 h-3 text-orange-500 animate-pulse" />
                            </div>
                          )}
                        </>
                      )}
                      <div className={`absolute ${missingLeadership ? '-top-24' : '-top-20'} left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none z-10 min-w-[160px]`}>
                        <div className="font-medium">{hour.label} {staffingDetails.isBreakfast ? "(Breakfast)" : ""}</div>
                        {missingLeadership && (
                          <div className="text-orange-500 flex items-center gap-1 font-medium">
                            <AlertTriangle className="w-3 h-3" />
                            No Manager/Supervisor
                          </div>
                        )}
                        <div className={isRightSized ? "text-green-600" : isOverstaffed ? "text-red-600" : "text-yellow-600"}>
                          Deployed: {laborHours.toFixed(1)} hrs
                        </div>
                        <div className="text-muted-foreground">
                          Target: {recommendedHours} hrs ({staffingDetails.nonProduction} non-prod + {staffingDetails.production} prod)
                        </div>
                        <div className={`text-xs ${isOverstaffed ? "text-red-600" : isUnderstaffed ? "text-yellow-600" : "text-green-600"}`}>
                          {isOverstaffed ? `+${staffingDiff.toFixed(1)} overstaffed` : isUnderstaffed ? `${staffingDiff.toFixed(1)} understaffed` : "Right-sized"}
                        </div>
                        {hour.positionBreakdown && Object.keys(hour.positionBreakdown).length > 0 && (
                          <div className="border-t border-border/50 mt-1 pt-1">
                            <div className="text-[10px] text-muted-foreground mb-0.5">By Position:</div>
                            {Object.entries(hour.positionBreakdown)
                              .sort(([,a], [,b]) => b - a)
                              .map(([position, hrs]) => (
                                <div key={position} className="text-[10px] flex justify-between gap-2">
                                  <span className="truncate">{position}</span>
                                  <span className="font-medium">{hrs.toFixed(1)}h</span>
                                </div>
                              ))
                            }
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Total Staffing Summary for the Day - excludes Early Bird hours */}
              {(() => {
                const totals = processedHours.reduce((acc, hour) => {
                  // Skip Early Bird hours - labor data not meaningful
                  // Eastern units: hours 0-8, Central units: hours 0-6
                  const isEarlyBirdHour = hour.label === "Early Bird" || hour.hour <= earlyBirdEndHour;
                  if (isEarlyBirdHour) return acc;
                  
                  const laborHrs = Number(hour.employeeCount) || 0;
                  const sales = hour.todaySales || 0;
                  const hasData = laborHrs > 0 || sales > 0;
                  
                  if (hasData) {
                    const staffingDetails = getStaffingBreakdown(hour.hour, sales);
                    acc.totalDeployed += laborHrs;
                    acc.totalTarget += staffingDetails.total;
                    acc.hoursWithData++;
                  }
                  return acc;
                }, { totalDeployed: 0, totalTarget: 0, hoursWithData: 0 });
                
                const staffingDiff = totals.totalDeployed - totals.totalTarget;
                const isOverstaffed = staffingDiff > 0;
                const isUnderstaffed = staffingDiff < 0;
                
                if (totals.hoursWithData === 0) return null;
                
                return (
                  <div className="mt-2 flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">
                      Day Total: {totals.totalDeployed.toFixed(1)} labor hrs / {totals.totalTarget} target
                    </span>
                    <span className={`font-medium ${
                      isOverstaffed ? "text-red-600 dark:text-red-400" : 
                      isUnderstaffed ? "text-yellow-600 dark:text-yellow-400" : 
                      "text-green-600 dark:text-green-400"
                    }`} data-testid={`staffing-total-${restaurant.restaurantId}`}>
                      {isOverstaffed ? `+${staffingDiff.toFixed(1)} overstaffed` : 
                       isUnderstaffed ? `${staffingDiff.toFixed(1)} understaffed` : 
                       "Right-sized"}
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {isExpanded && activeHours.length === 0 && (
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
