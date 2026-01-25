import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Clock, MapPin, Car, Smartphone, Utensils, ShoppingBag, AlertTriangle, Ban, ChevronDown, ChevronUp, Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle, Droplets, Wind, Star } from "lucide-react";
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

// Execution Grade Calculator
// Sales: UP/DOWN, Speed: GREEN(<300s)/YELLOW(300-420s)/RED(>420s), Staffing: PROPER/UNDER/OVER
function getExecutionGrade(
  salesUp: boolean,
  speedSeconds: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean = true // Whether last week had sales to compare against
): { grade: string; color: string; hasGrade: boolean } {
  // Track which components are available for grading
  const components: { name: string; score: number }[] = [];
  
  // Sales component (only if we have comparable data - last week had sales)
  if (hasComparableSales) {
    // Sales UP = 100, DOWN = 50
    components.push({ name: 'sales', score: salesUp ? 100 : 50 });
  }
  
  // Speed component (only if we have drive-thru data)
  if (speedSeconds !== undefined) {
    // GREEN (<5min) = 100, YELLOW (5-7min) = 70, RED (>7min) = 40
    let speedScore = 100;
    if (speedSeconds > 420) speedScore = 40;
    else if (speedSeconds > 300) speedScore = 70;
    components.push({ name: 'speed', score: speedScore });
  }
  
  // Staffing component (always available)
  // PROPER = 100, UNDER/OVER = 60
  let staffingScore = 100;
  if (staffingDiff > 1 || staffingDiff < -1) staffingScore = 60;
  components.push({ name: 'staffing', score: staffingScore });
  
  // If no components to grade, return no grade
  if (components.length === 0) {
    return { grade: '-', color: 'text-muted-foreground', hasGrade: false };
  }
  
  // Calculate weighted average (equal weights for available components)
  const avgScore = components.reduce((sum, c) => sum + c.score, 0) / components.length;
  
  // Convert score to letter grade
  let grade: string;
  let color: string;
  if (avgScore >= 95) {
    grade = 'A+'; color = 'text-green-600 dark:text-green-400';
  } else if (avgScore >= 85) {
    grade = 'A'; color = 'text-green-600 dark:text-green-400';
  } else if (avgScore >= 75) {
    grade = 'B'; color = 'text-blue-600 dark:text-blue-400';
  } else if (avgScore >= 65) {
    grade = 'C'; color = 'text-yellow-600 dark:text-yellow-400';
  } else if (avgScore >= 55) {
    grade = 'D'; color = 'text-orange-600 dark:text-orange-400';
  } else {
    grade = 'F'; color = 'text-red-600 dark:text-red-400';
  }
  
  return { grade, color, hasGrade: true };
}

// Convert letter grade to numeric score for averaging
function gradeToScore(grade: string): number {
  const scores: Record<string, number> = {
    'A+': 100, 'A': 90, 'B': 80, 'C': 70, 'D': 60, 'F': 50
  };
  return scores[grade] ?? 0;
}

// Convert average score back to letter grade
function scoreToGrade(score: number): { grade: string; color: string } {
  if (score >= 95) return { grade: 'A+', color: 'text-green-600 dark:text-green-400' };
  if (score >= 85) return { grade: 'A', color: 'text-green-600 dark:text-green-400' };
  if (score >= 75) return { grade: 'B', color: 'text-blue-600 dark:text-blue-400' };
  if (score >= 65) return { grade: 'C', color: 'text-yellow-600 dark:text-yellow-400' };
  if (score >= 55) return { grade: 'D', color: 'text-orange-600 dark:text-orange-400' };
  return { grade: 'F', color: 'text-red-600 dark:text-red-400' };
}

interface LeaderboardCardProps {
  restaurant: RestaurantSales;
  hourlyData?: HourlySalesData[];
}

export function LeaderboardCard({ restaurant, hourlyData }: LeaderboardCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoveredHourIndex, setHoveredHourIndex] = useState<number | null>(null);
  
  // Debug: Log driveThru data for this restaurant
  if (restaurant.driveThru) {
    console.log(`[Card ${restaurant.restaurantName}] Has driveThru:`, restaurant.driveThru);
  }
  
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

  const getTimezoneDisplay = (tz: string) => {
    // Show compact time format: "5P-EST"
    const now = new Date();
    const hour = parseInt(now.toLocaleTimeString('en-US', { 
      timeZone: tz, 
      hour: 'numeric', 
      hour12: true 
    }));
    const isPM = now.toLocaleTimeString('en-US', { 
      timeZone: tz, 
      hour: 'numeric', 
      hour12: true 
    }).includes('PM');
    const ampm = isPM ? 'P' : 'A';
    
    if (tz.includes("New_York") || tz.includes("Eastern")) return `${hour}${ampm}-EST`;
    if (tz.includes("Chicago") || tz.includes("Central")) return `${hour}${ampm}-CST`;
    return `${hour}${ampm}`;
  };

  // Use normalized sales for pace variance comparison (fair timezone comparison for rankings)
  const paceVariance = restaurant.lastWeekSales > 0 
    ? ((restaurant.todaySales / restaurant.lastWeekSales) - 1) * 100 
    : 0;

  // Show all 24 hours individually (no Early Bird combining since we have full POS data)
  // Generate all 24 hours, filling in zeros for missing hours
  // Use localCurrentHour for grade display (restaurant's own timezone)
  // Fall back to normalizedHour if not available (for backward compatibility)
  const localGradeCutoff = (restaurant as any).localCurrentHour ?? restaurant.normalizedHour;
  const normalizedCutoff = restaurant.normalizedHour;
  
  // Create a map of existing hourly data
  const hourlyDataMap = new Map<number, HourlySalesData>();
  (hourlyData || []).forEach(item => {
    hourlyDataMap.set(item.hour, item);
  });
  
  // Generate all 24 hours (0-23)
  const allHours: HourlySalesData[] = [];
  for (let h = 0; h < 24; h++) {
    const existing = hourlyDataMap.get(h);
    if (existing) {
      allHours.push(existing);
    } else {
      // Create placeholder for missing hour
      allHours.push({
        hour: h,
        todaySales: 0,
        lastWeekSales: 0,
        forecastSales: 0,
        employeeCount: 0,
        projectedLabor: 0,
        actualLabor: 0,
        label: h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`,
      } as HourlySalesData);
    }
  }
  
  const activeHours = allHours;
  const maxSales = Math.max(
    ...activeHours.map(h => Math.max(h.todaySales, h.lastWeekSales, h.forecastSales)),
    1
  );
  
  // Calculate overall execution grade from completed hourly grades only (using restaurant's local hour)
  // Only grade hours that have actual sales - no sales = no grade
  const hourlyGradeScores = activeHours
    .filter(hour => hour.hour <= localGradeCutoff) // Only completed hours for this restaurant
    .filter(hour => hour.todaySales && hour.todaySales > 0) // No sales = no grade
    .map(hour => {
      const isAhead = hour.todaySales >= hour.lastWeekSales;
      const hasComparableSales = hour.lastWeekSales > 0; // Only compare if LW had sales
      const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
      const actualStaff = Number(hour.employeeCount) || 0;
      const staffingDiff = actualStaff - staffing.total;
      const gradeInfo = getExecutionGrade(isAhead, hour.avgServiceTime, staffingDiff, hasComparableSales);
      return gradeInfo.hasGrade ? gradeToScore(gradeInfo.grade) : 0;
    }).filter(score => score > 0);
  
  const overallScore = hourlyGradeScores.length > 0 
    ? hourlyGradeScores.reduce((a, b) => a + b, 0) / hourlyGradeScores.length 
    : 0;
  const overallGrade = hourlyGradeScores.length > 0 ? scoreToGrade(overallScore) : null;
  
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
                  NU {restaurant.daysOpen && restaurant.daysOpen >= 7 ? `${Math.floor(restaurant.daysOpen / 7)}w${restaurant.daysOpen % 7}d` : `${restaurant.daysOpen || 0}d`}
                </Badge>
              )}
              <Badge variant="secondary" className="flex-shrink-0 text-xs">
                <Clock className="w-3 h-3 mr-1" />
                {getTimezoneDisplay(restaurant.timezone)}
              </Badge>
              {/* Overall Execution Grade - Always visible */}
              {overallGrade && (
                <Badge 
                  variant="outline" 
                  className={`flex-shrink-0 text-xs font-bold ${overallGrade.color} border-current`}
                  data-testid={`badge-grade-${restaurant.restaurantId}`}
                >
                  EXC: {overallGrade.grade}
                </Badge>
              )}
              {/* Google Reviews Badge - Shows overall rating + new reviews today */}
              {restaurant.googleReviews && (
                <div className="relative group">
                  <Badge 
                    className={`flex-shrink-0 text-xs px-1.5 cursor-help gap-1 ${
                      restaurant.googleReviews.rating >= 4.5
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : restaurant.googleReviews.rating >= 4.0
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                          : restaurant.googleReviews.rating >= 3.5
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    } border-0`}
                    data-testid={`badge-reviews-${restaurant.restaurantId}`}
                  >
                    <Star className="w-3 h-3" />
                    <span className="font-medium">
                      {restaurant.googleReviews.rating.toFixed(1)}
                      {(restaurant.googleReviews.newReviewsToday || 0) > 0 && (
                        <span className="ml-1 text-green-600 dark:text-green-400">+{restaurant.googleReviews.newReviewsToday}</span>
                      )}
                    </span>
                  </Badge>
                  <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                    <div className="font-medium">Google Reviews</div>
                    <div className="text-muted-foreground">{restaurant.googleReviews.reviewCount.toLocaleString()} total reviews</div>
                  </div>
                </div>
              )}
              {/* Drive-Thru SOS Badge - Always visible */}
              {restaurant.driveThru && (() => {
                const avgTime = restaurant.driveThru.avgTotalTime;
                const timeColor = avgTime > 420 
                  ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  : avgTime > 300 
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
                const timeStr = `${Math.floor(avgTime / 60)}:${(avgTime % 60).toString().padStart(2, '0')}`;
                
                return (
                  <div className="relative group">
                    <Badge 
                      className={`${timeColor} border-0 flex-shrink-0 text-xs px-1.5 cursor-help gap-1`}
                      data-testid={`badge-sos-${restaurant.restaurantId}`}
                    >
                      <Car className="w-3 h-3" />
                      <span>{timeStr}</span>
                    </Badge>
                    <div className="absolute -top-20 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Drive-Thru Speed</div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        Avg total: {timeStr}
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Car className="w-3 h-3" />
                        Window: {Math.floor(restaurant.driveThru.avgServiceTime / 60)}:{(restaurant.driveThru.avgServiceTime % 60).toString().padStart(2, '0')}
                      </div>
                      <div className="text-muted-foreground">
                        Cars today: {restaurant.driveThru.carCount}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Revenue Port Badges - Hidden on small screens, exclude drive_thru as it's shown separately */}
              {restaurant.revenuePorts && restaurant.revenuePorts.length > 0 && (
                <div className="hidden sm:flex items-center gap-1">
                  {restaurant.revenuePorts.filter(p => !(p === "drive_thru" && restaurant.driveThru)).map(port => {
                    const config = REVENUE_PORT_CONFIG[port as keyof typeof REVENUE_PORT_CONFIG];
                    if (!config) return null;
                    const Icon = config.icon;
                    
                    return (
                      <div key={port} className="relative group">
                        <Badge 
                          className={`${config.color} border-0 flex-shrink-0 text-xs px-1.5 cursor-help`}
                          data-testid={`badge-port-${port}-${restaurant.restaurantId}`}
                        >
                          <Icon className="w-3 h-3" />
                        </Badge>
                        <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                          <div className="font-medium">{config.label}</div>
                          <div className="text-muted-foreground">{config.description}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Weather Badge */}
              {restaurant.weather && (
                <div className="relative group">
                  <Badge 
                    variant="secondary" 
                    className="flex-shrink-0 text-xs cursor-help gap-1"
                    data-testid={`badge-weather-${restaurant.restaurantId}`}
                  >
                    <WeatherIcon condition={restaurant.weather.condition} />
                    {restaurant.weather.highTemp !== undefined ? (
                      <span>{Math.round(restaurant.weather.highTemp)}°/{Math.round(restaurant.weather.lowTemp ?? 0)}°</span>
                    ) : (
                      <span>{Math.round(restaurant.weather.temp)}°F</span>
                    )}
                  </Badge>
                  <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                    <div className="font-medium capitalize">{restaurant.weather.condition}</div>
                    {restaurant.weather.highTemp !== undefined ? (
                      <div className="text-muted-foreground">
                        High: {Math.round(restaurant.weather.highTemp)}°F / Low: {Math.round(restaurant.weather.lowTemp ?? 0)}°F
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Droplets className="w-3 h-3" />
                          {restaurant.weather.humidity}%
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Wind className="w-3 h-3" />
                          {Math.round(restaurant.weather.windSpeed)} mph
                        </div>
                      </>
                    )}
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
                    // Check if day is complete by normalized hour (23 = end of day)
                    const isDayComplete = restaurant.normalizedHour >= 23;
                    if (isDayComplete) {
                      return formatCurrency(restaurant.actualSales);
                    }
                    // Show actual + LW remaining
                    const lwRemaining = restaurant.forecastSales - restaurant.actualSales;
                    return formatCurrency(restaurant.forecastSales);
                  })()}
                </span>
                <div className="absolute -top-14 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                  <div className="font-medium">End-of-Day Forecast</div>
                  <div className="text-muted-foreground">
                    {restaurant.normalizedHour >= 23 
                      ? "Day complete" 
                      : `${formatCurrency(restaurant.actualSales)} + ${formatCurrency(Math.max(0, restaurant.forecastSales - restaurant.actualSales))} LW remaining`}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-shrink-0 text-right">
            <div 
              className="text-xl font-bold"
              data-testid={`text-sales-${restaurant.restaurantId}`}
            >
              {formatCurrency(restaurant.actualSales)}
            </div>
            <div className="flex items-center justify-end gap-1 mt-1">
              {paceVariance >= 0 ? (
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
                {activeHours.some(h => h.avgServiceTime) && (
                  <span className="flex items-center gap-1">
                    <div className="w-3 h-0.5 bg-cyan-500" />
                    SOS
                  </span>
                )}
              </div>
            </div>
            {/* Execution Grades Row - only show grades for completed hours (using restaurant's local hour) */}
            <div className="flex gap-0.5 mb-1">
              {activeHours.map((hour) => {
                const isCompleted = hour.hour <= localGradeCutoff;
                const isAhead = hour.todaySales >= hour.lastWeekSales;
                const hasComparableSales = hour.lastWeekSales > 0;
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                const actualStaff = Number(hour.employeeCount) || 0;
                const staffingDiff = actualStaff - staffing.total;
                const gradeInfo = getExecutionGrade(isAhead, hour.avgServiceTime, staffingDiff, hasComparableSales);
                
                // No sales = no grade displayed
                const hasSales = hour.todaySales && hour.todaySales > 0;
                
                return (
                  <div
                    key={`grade-${hour.hour}`}
                    className="flex-1 text-center"
                  >
                    {isCompleted && hasSales ? (
                      <span className={`text-[10px] font-bold ${gradeInfo.color}`}>
                        {gradeInfo.grade}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">-</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div 
              className="relative flex items-end gap-0.5 h-12" 
              data-testid={`hourly-chart-${restaurant.restaurantId}`}
              onMouseLeave={() => setHoveredHourIndex(null)}
            >
              {activeHours.map((hour, hourIndex) => {
                const isCompleted = hour.hour <= localGradeCutoff;
                const isAhead = hour.todaySales >= hour.lastWeekSales;
                const hasComparableSales = hour.lastWeekSales > 0;
                const displayValue = hour.todaySales > 0 ? hour.todaySales : hour.lastWeekSales;
                const barHeightPx = Math.max(4, (displayValue / maxSales) * 48);
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                const actualStaff = Number(hour.employeeCount) || 0;
                const staffingDiff = actualStaff - staffing.total;
                const gradeInfo = getExecutionGrade(isAhead, hour.avgServiceTime, staffingDiff, hasComparableSales);
                const isHovered = hoveredHourIndex === hourIndex;
                
                return (
                  <div
                    key={hour.hour}
                    className="flex-1 flex items-end relative h-full cursor-pointer"
                    onMouseEnter={() => setHoveredHourIndex(hourIndex)}
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
                    <div className={`absolute -top-14 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs pointer-events-none whitespace-nowrap z-10 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                      <div className="font-medium">
                        {hour.label}
                        {isCompleted && hour.todaySales > 0 && <> - Grade: <span className={gradeInfo.color}>{gradeInfo.grade}</span></>}
                        {isCompleted && (!hour.todaySales || hour.todaySales === 0) && <span className="text-muted-foreground"> (no sales)</span>}
                        {!isCompleted && <span className="text-muted-foreground"> (pending)</span>}
                      </div>
                      <div className={isAhead ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                        Today: ${hour.todaySales.toLocaleString()}
                      </div>
                      <div className="text-muted-foreground">Last Week: ${hour.lastWeekSales.toLocaleString()}</div>
                      {isCompleted && hour.avgServiceTime && (
                        <div className={
                          hour.avgServiceTime > 420 ? "text-red-600 dark:text-red-400" :
                          hour.avgServiceTime > 300 ? "text-yellow-600 dark:text-yellow-400" :
                          "text-green-600 dark:text-green-400"
                        }>
                          SOS: {Math.floor(hour.avgServiceTime / 60)}:{(hour.avgServiceTime % 60).toString().padStart(2, '0')}
                        </div>
                      )}
                      {isCompleted && (
                        <div className={staffingDiff > 1 ? "text-red-600" : staffingDiff < -1 ? "text-yellow-600" : "text-green-600"}>
                          Staff: {staffingDiff > 1 ? "Over" : staffingDiff < -1 ? "Under" : "Proper"}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* SOS Line Overlay */}
              {activeHours.some(h => h.avgServiceTime) && (
                <svg 
                  className="absolute inset-0 w-full h-full pointer-events-none" 
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  <polyline
                    fill="none"
                    stroke="rgb(6, 182, 212)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    points={activeHours
                      .map((hour, idx) => {
                        if (!hour.avgServiceTime) return null;
                        const x = ((idx + 0.5) / activeHours.length) * 100;
                        // Scale: 0-600s maps to chart height (600s = 10min max for display)
                        const maxTime = 600;
                        const normalizedTime = Math.min(hour.avgServiceTime, maxTime) / maxTime;
                        const y = (1 - normalizedTime) * 100;
                        return `${x},${y}`;
                      })
                      .filter(Boolean)
                      .join(' ')}
                  />
                </svg>
              )}
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
              <div 
                className="flex items-end gap-0.5 h-10" 
                data-testid={`staffing-chart-${restaurant.restaurantId}`}
                onMouseLeave={() => setHoveredHourIndex(null)}
              >
                {activeHours.map((hour, hourIndex) => {
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
                  // Operators don't punch in but are considered leaders if scheduled
                  const positions = hour.positionBreakdown || {};
                  const positionKeys = Object.keys(positions).map(k => k.toLowerCase());
                  const hasManager = positionKeys.some(p => p.includes("manager"));
                  const hasShiftSupervisor = positionKeys.some(p => p.includes("shift supervisor") || p.includes("supervisor"));
                  const hasOperatorScheduled = positions['_operatorScheduled'] === 1;
                  const missingLeadership = !hasManager && !hasShiftSupervisor && !hasOperatorScheduled && laborHours > 0;
                  
                  const isHovered = hoveredHourIndex === hourIndex;
                  
                  return (
                    <div
                      key={`staff-${hour.hour}`}
                      className="flex-1 flex items-end relative h-full cursor-pointer"
                      onMouseEnter={() => setHoveredHourIndex(hourIndex)}
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
                      <div className={`absolute ${missingLeadership ? '-top-24' : '-top-20'} left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs pointer-events-none z-10 min-w-[160px] transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
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
              
              {/* Total Staffing Summary for the Day */}
              {(() => {
                const totals = activeHours.reduce((acc, hour) => {
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
                  paceVariance >= 0 ? "bg-green-500" : "bg-red-500"
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
