import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, Clock, MapPin, Car, Smartphone, Utensils, ShoppingBag, AlertTriangle } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

const REVENUE_PORT_CONFIG = {
  dine_in: { label: "Dine In", icon: Utensils, color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400", description: "Indoor dining available" },
  drive_thru: { label: "Drive Thru", icon: Car, color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", description: "Drive-thru window service" },
  app: { label: "APP", icon: Smartphone, color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", description: "Mobile app ordering" },
  "3pd": { label: "3PD", icon: ShoppingBag, color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400", description: "Third-party delivery (DoorDash, UberEats, etc.)" },
} as const;

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
  // Early Bird labor includes ALL labor from midnight (hours 0-6) to match cumulative sales methodology
  const processedHours = (hourlyData || []).reduce((acc: HourlySalesData[], item) => {
    // Skip hours 0-4 (no sales, but labor is included in Early Bird)
    if (item.hour < 5) return acc;
    
    // Combine 5am and 6am into "Early Bird" with cumulative labor from midnight
    if (item.hour === 5) {
      const hour6 = hourlyData?.find(d => d.hour === 6);
      // Sum labor from hours 0-6 (midnight through 6am) for Early Bird
      const cumulativeLabor = (hourlyData || [])
        .filter(h => h.hour <= 6)
        .reduce((sum, h) => ({
          projectedLabor: sum.projectedLabor + (h.projectedLabor || 0),
          actualLabor: sum.actualLabor + (h.actualLabor || 0),
        }), { projectedLabor: 0, actualLabor: 0 });
      
      // Peak labor hours across hours 0-6
      const peakLaborHours = Math.max(
        ...(hourlyData || []).filter(h => h.hour <= 6).map(h => Number(h.employeeCount) || 0)
      );
      
      // Sales values are cumulative (running total), so use hour6's cumulative value
      // which already includes all sales from open through 6am
      acc.push({
        hour: 5,
        label: "Early Bird",
        todaySales: hour6?.todaySales || item.todaySales,
        lastWeekSales: hour6?.lastWeekSales || item.lastWeekSales,
        forecastSales: hour6?.forecastSales || item.forecastSales,
        projectedLabor: cumulativeLabor.projectedLabor,
        actualLabor: cumulativeLabor.actualLabor,
        employeeCount: peakLaborHours,
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
                <MapPin className="w-3 h-3 mr-1" />
                {getTimezoneLabel(restaurant.timezone)}
              </Badge>
              {/* Revenue Port Badges */}
              {restaurant.revenuePorts && restaurant.revenuePorts.length > 0 && (
                <div className="flex items-center gap-1">
                  {restaurant.revenuePorts.map(port => {
                    const config = REVENUE_PORT_CONFIG[port as keyof typeof REVENUE_PORT_CONFIG];
                    if (!config) return null;
                    const Icon = config.icon;
                    return (
                      <Tooltip key={port}>
                        <TooltipTrigger asChild>
                          <Badge 
                            className={`${config.color} border-0 flex-shrink-0 text-xs px-1.5 cursor-help`}
                            data-testid={`badge-port-${port}-${restaurant.restaurantId}`}
                          >
                            <Icon className="w-3 h-3" />
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-medium">{config.label}</p>
                          <p className="text-xs text-muted-foreground">{config.description}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Hour {restaurant.normalizedHour}
              </span>
              <span className="text-xs">
                Last wk: {formatCurrency(restaurant.lastWeekSales)}
              </span>
              <span className="text-xs flex items-center gap-1">
                Forecast: {formatCurrency(restaurant.forecastSales)}
                {restaurant.forecastSales > 0 && restaurant.lastWeekSales > 0 && (
                  restaurant.forecastSales >= restaurant.lastWeekSales ? (
                    <span className="text-green-600 dark:text-green-400 flex items-center">
                      <TrendingUp className="w-3 h-3" />
                    </span>
                  ) : (
                    <span className="text-red-600 dark:text-red-400 flex items-center">
                      <TrendingDown className="w-3 h-3" />
                    </span>
                  )
                )}
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
                  // Early Bird hours (0-6) are excluded from staffing display - not meaningful
                  const isEarlyBird = hour.label === "Early Bird" || hour.hour <= 6;
                  
                  if (isEarlyBird) {
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
              
              {/* Total Staffing Summary for the Day - excludes Early Bird (hours 0-6) */}
              {(() => {
                const totals = processedHours.reduce((acc, hour) => {
                  // Skip Early Bird hours (0-6) - labor data not meaningful
                  const isEarlyBird = hour.label === "Early Bird" || hour.hour <= 6;
                  if (isEarlyBird) return acc;
                  
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
