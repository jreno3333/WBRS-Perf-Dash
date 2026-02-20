import { useState } from "react";
// Card/CardContent imports removed - using plain divs
import { Badge } from "@/components/ui/badge";
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { TrendingUp, TrendingDown, Clock, MapPin, Car, Smartphone, Utensils, ShoppingBag, AlertTriangle, Ban, ChevronDown, ChevronUp, Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle, Droplets, Wind, Star, GraduationCap, ThumbsUp, Receipt } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { DAYPARTS, getDaypart, gradeToScore as dpGradeToScore, scoreToGrade as dpScoreToGrade, getGradeColor as dpGetGradeColor } from "@/lib/dayparts";

const REVENUE_PORT_CONFIG = {
  dine_in: { label: "Dine In", icon: Utensils, color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Indoor dining available", disabledDesc: "No indoor dining" },
  drive_thru: { label: "Drive Thru", icon: Car, color: "bg-amber-500/10 text-amber-600 dark:text-amber-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Drive-thru window service", disabledDesc: "No drive-thru" },
  app: { label: "APP", icon: Smartphone, color: "bg-blue-500/10 text-blue-500", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Mobile app ordering", disabledDesc: "No app ordering" },
  "3pd": { label: "3PD", icon: ShoppingBag, color: "bg-purple-500/10 text-purple-500", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Third-party delivery (DoorDash, UberEats, etc.)", disabledDesc: "No third-party delivery" },
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
// Sales: UP/DOWN (with 5% tolerance), Speed: attainment %, Staffing: PROPER/UNDER/OVER
// OSAT: 85%+ = excellent, 80-85% = acceptable, <80% = needs improvement
// WEIGHTS: Sales 35%, Speed 25%, OSAT 25%, Staffing 15%
const GRADE_WEIGHTS = {
  sales: 35,
  speed: 25,
  osat: 25,
  staffing: 15,
};

function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean = true,
  isFirstWeek: boolean = false,
  hasValidStaffing: boolean = true,
  osatPercent: number | undefined = undefined
): { grade: string; color: string; hasGrade: boolean } {
  const components: { name: string; score: number; weight: number }[] = [];
  
  if (hasComparableSales) {
    const salesScore = salesVariancePct >= -5 ? 100 : 50;
    components.push({ name: 'sales', score: salesScore, weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ name: 'sales', score: 100, weight: GRADE_WEIGHTS.sales });
  }
  
  // Speed component (weight: 25%) - uses attainment (% of cars under 6 min)
  // >=70% = 100 (green), >=50% = 70 (yellow), <50% = 40 (red)
  if (speedAttainment !== undefined && speedAttainment >= 0) {
    let speedScore = 100;
    if (speedAttainment < 50) speedScore = 40;
    else if (speedAttainment < 70) speedScore = 70;
    components.push({ name: 'speed', score: speedScore, weight: GRADE_WEIGHTS.speed });
  }
  
  // OSAT component (weight: 25%) - only if we have customer satisfaction data
  // 85%+ = 100 (excellent), 80-85% = 70 (acceptable), <80% = 40 (needs improvement)
  if (osatPercent !== undefined && osatPercent > 0) {
    let osatScore = 100;
    if (osatPercent < 80) osatScore = 40;
    else if (osatPercent < 85) osatScore = 70;
    components.push({ name: 'osat', score: osatScore, weight: GRADE_WEIGHTS.osat });
  }
  
  // Staffing component (weight: 15%) - only if we have valid staffing data
  // Skip when employee count is near-zero (indicates missing/incomplete API data)
  // PROPER = 100, UNDER/OVER = 60
  // SALES SURGE EXCEPTION: No understaffing penalty when sales are 20%+ above last week
  // or when last week had no sales (store was closed/no data - can't plan staffing for that)
  if (hasValidStaffing) {
    let staffingScore = 100;
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    const isUnderstaffed = staffingDiff < -1;
    const isOverstaffed = staffingDiff > 1;
    
    if (isOverstaffed) {
      staffingScore = 60;
    } else if (isUnderstaffed && !isSalesSurge) {
      staffingScore = 60;
    }
    components.push({ name: 'staffing', score: staffingScore, weight: GRADE_WEIGHTS.staffing });
  }
  
  // If no components to grade, return no grade
  if (components.length === 0) {
    return { grade: '-', color: 'text-muted-foreground', hasGrade: false };
  }
  
  // Calculate weighted average - normalize weights based on available components
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const avgScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;
  
  // Convert score to detailed letter grade
  const { grade, color } = scoreToGrade(avgScore);
  return { grade, color, hasGrade: true };
}

function getGradeColor(grade: string): string {
  if (grade.startsWith('A')) return 'text-green-500';
  if (grade.startsWith('B')) return 'text-blue-500';
  if (grade.startsWith('C')) return 'text-yellow-500';
  if (grade === 'D') return 'text-orange-500';
  return 'text-red-500';
}

// Convert letter grade to numeric score for averaging (midpoint of each range)
function gradeToScore(grade: string): number {
  const scores: Record<string, number> = {
    'A+': 97, 'A': 92, 'A-': 87, 'B+': 82, 'B': 77, 'B-': 72,
    'C+': 67, 'C': 62, 'C-': 57, 'D': 52, 'F': 25
  };
  return scores[grade] ?? 0;
}

// Convert average score back to detailed letter grade
function scoreToGrade(score: number): { grade: string; color: string } {
  let grade: string;
  if (score >= 95) grade = 'A+';
  else if (score >= 90) grade = 'A';
  else if (score >= 85) grade = 'A-';
  else if (score >= 80) grade = 'B+';
  else if (score >= 75) grade = 'B';
  else if (score >= 70) grade = 'B-';
  else if (score >= 65) grade = 'C+';
  else if (score >= 60) grade = 'C';
  else if (score >= 55) grade = 'C-';
  else if (score >= 50) grade = 'D';
  else grade = 'F';
  return { grade, color: getGradeColor(grade) };
}

interface CrewSummary {
  avgScore: number;
  avgCrewCount: number;
  avgTenureMonths: number;
}

interface HourlyCrewData {
  hour: number;
  crewCount: number;
  experienceScore: number;
  tenureMix: { trainee: number; developing: number; experienced: number; veteran: number };
}

interface YoYData {
  priorNetSales: number;
  priorGuestCount: number;
  priorDate: string;
}

interface WeeklyRestaurantData {
  currentWeek: number;
  priorWeek: number;
  eowForecast: number;
  priorWeekFull: number;
  daysInCurrentWeek: number;
}

interface CheckAverageData {
  totalOrders: number;
  totalSales: number;
  checkAverage: number;
  hourly: Record<number, { orders: number; sales: number; avg: number }>;
}

interface DemandCurveHour {
  hour: number;
  quarters: { label: string; orders: number; sales: number }[];
  totalOrders: number;
  totalSales: number;
  loadProfile: string;
}

interface LeaderboardCardProps {
  restaurant: RestaurantSales;
  hourlyData?: HourlySalesData[];
  crewSummary?: CrewSummary;
  hourlyCrewData?: HourlyCrewData[];
  checkAverage?: CheckAverageData;
  consistencyScore?: number;
  demandCurveHours?: DemandCurveHour[];
  isToday?: boolean;
  yoyData?: YoYData;
  weeklyData?: WeeklyRestaurantData;
}

function formatTenure(months: number): string {
  if (months < 1) return '<1mo';
  const years = Math.floor(months / 12);
  const remainingMonths = Math.round(months % 12);
  if (years === 0) return `${remainingMonths}mo`;
  if (remainingMonths === 0) return `${years}yr`;
  return `${years}yr ${remainingMonths}mo`;
}

export function LeaderboardCard({ restaurant, hourlyData, crewSummary, hourlyCrewData, checkAverage, consistencyScore, demandCurveHours, isToday = true, yoyData, weeklyData }: LeaderboardCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoveredHourIndex, setHoveredHourIndex] = useState<number | null>(null);
  
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
    return `${sign}${Math.round(value)}%`;
  };

  // Display variance uses actual local-timezone sales for accurate store-level comparison
  const displayLastWeek = restaurant.actualLastWeekSales ?? restaurant.lastWeekSales;
  const paceVariance = displayLastWeek > 0 
    ? ((restaurant.actualSales / displayLastWeek) - 1) * 100 
    : 0;
  
  // Check if restaurant is in first week (no historical data expected)
  const isFirstWeek = (restaurant.daysOpen !== undefined && restaurant.daysOpen < 7);

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
      const hasComparableSales = hour.lastWeekSales > 0; // Only compare if LW had sales
      const salesVariancePct = hasComparableSales 
        ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
        : 0;
      const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
      // Exclude operator from labor hours (not production/non-production)
      const positions = hour.positionBreakdown || {};
      const operatorHrs = positions['_operatorScheduled'] || 0;
      const rawEmployeeCount = Number(hour.employeeCount) || 0;
      const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
      const staffingDiff = actualStaff - staffing.total;
      // Exclude staffing from grade when employee count is near-zero (indicates missing/incomplete data)
      const hasValidStaffing = rawEmployeeCount >= 1;
      const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
      return gradeInfo.hasGrade ? gradeToScore(gradeInfo.grade) : 0;
    }).filter(score => score > 0);
  
  // Overall grade is the straight average of hourly execution grades
  // (OSAT is already factored into each hourly grade when available)
  let overallScore = 0;
  if (hourlyGradeScores.length > 0) {
    overallScore = hourlyGradeScores.reduce((a, b) => a + b, 0) / hourlyGradeScores.length;
  }
  const overallGrade = hourlyGradeScores.length > 0 ? scoreToGrade(overallScore) : null;

  // Calculate daypart grades from completed hourly grades
  const daypartGrades = DAYPARTS.map(dp => {
    const dpScores = activeHours
      .filter(hour => hour.hour >= dp.startHour && hour.hour <= dp.endHour)
      .filter(hour => hour.hour <= localGradeCutoff)
      .filter(hour => hour.todaySales && hour.todaySales > 0)
      .map(hour => {
        const hasComparableSales = hour.lastWeekSales > 0;
        const salesVariancePct = hasComparableSales
          ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100
          : 0;
        const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
        const positions = hour.positionBreakdown || {};
        const operatorHrs = positions['_operatorScheduled'] || 0;
        const rawEmployeeCount = Number(hour.employeeCount) || 0;
        const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
        const staffingDiff = actualStaff - staffing.total;
        const hasValidStaffing = rawEmployeeCount >= 1;
        const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
        return gradeInfo.hasGrade ? gradeToScore(gradeInfo.grade) : 0;
      }).filter(s => s > 0);

    if (dpScores.length === 0) return { ...dp, grade: null, score: 0 };
    const avg = dpScores.reduce((a, b) => a + b, 0) / dpScores.length;
    const gradeResult = scoreToGrade(avg);
    return { ...dp, grade: gradeResult.grade, score: avg };
  }).filter(dp => dp.grade !== null);

  // Build demand curve lookup for 15-min interval display
  const demandCurveMap = new Map<number, DemandCurveHour>();
  if (demandCurveHours) {
    demandCurveHours.forEach(h => demandCurveMap.set(h.hour, h));
  }

  // No in-progress hour needed since we only show completed hours now

  return (
    <div
      className="rounded-xl border border-border/50 bg-card transition-colors hover:border-border"
      data-testid={`card-restaurant-${restaurant.restaurantId}`}
    >
      <div className="p-2.5 sm:p-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex-shrink-0">
            {restaurant.status === "training" ? (
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold text-muted-foreground bg-muted/50"
                data-testid={`text-rank-${restaurant.restaurantId}`}
              >
                --
              </div>
            ) : (
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold ${
                  restaurant.rank === 1
                    ? "bg-yellow-500/15 text-yellow-500"
                    : restaurant.rank === 2
                      ? "bg-muted text-foreground/70"
                      : restaurant.rank === 3
                        ? "bg-orange-500/15 text-orange-500"
                        : "bg-muted/50 text-muted-foreground"
                }`}
                data-testid={`text-rank-${restaurant.restaurantId}`}
              >
                #{restaurant.rank}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
              <h3
                className="font-medium text-sm truncate"
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
              {/* Overall Execution Grade + Daypart Grades */}
              {overallGrade && (
                <BadgeWithTooltip
                  variant="outline"
                  className={`flex-shrink-0 text-xs font-bold ${overallGrade.color} border-current`}
                  data-testid={`badge-grade-${restaurant.restaurantId}`}
                  tooltipContent={
                    daypartGrades.length > 0 ? (
                      <div>
                        <div className="font-medium mb-1">Daypart Grades</div>
                        <div className="flex flex-col gap-0.5">
                          {daypartGrades.map(dp => (
                            <div key={dp.id} className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">{dp.label}</span>
                              <span className={`font-bold ${dpGetGradeColor(dp.grade!)}`}>{dp.grade}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div>Overall execution grade based on sales, speed, OSAT, and staffing</div>
                    )
                  }
                >
                  EXC: {overallGrade.grade}
                </BadgeWithTooltip>
              )}
              {/* Google Reviews Badge */}
              {restaurant.googleReviews && (
                <BadgeWithTooltip
                  className={`flex-shrink-0 text-xs px-1.5 gap-1 ${
                    restaurant.googleReviews.rating >= 4.5
                      ? "bg-green-500/10 text-green-500"
                      : restaurant.googleReviews.rating >= 4.0
                        ? "bg-blue-500/10 text-blue-500"
                        : restaurant.googleReviews.rating >= 3.5
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : "bg-red-500/10 text-red-500"
                  } border-0`}
                  data-testid={`badge-reviews-${restaurant.restaurantId}`}
                  tooltipTitle="Google Reviews"
                  tooltipDetail={`${restaurant.googleReviews.reviewCount.toLocaleString()} total reviews`}
                >
                  <Star className="w-3 h-3" />
                  <span className="font-medium">
                    {restaurant.googleReviews.rating.toFixed(1)}
                    {(restaurant.googleReviews.newReviewsToday || 0) > 0 && (
                      <span className="ml-1 text-muted-foreground">+{restaurant.googleReviews.newReviewsToday}</span>
                    )}
                  </span>
                </BadgeWithTooltip>
              )}
              {/* OSAT Badge */}
              {restaurant.osat && restaurant.osat.totalResponses > 0 && (
                <BadgeWithTooltip
                  className={`flex-shrink-0 text-xs px-1.5 gap-1 ${
                    restaurant.osat.osatPercent >= 85
                      ? "bg-green-500/10 text-green-500"
                      : restaurant.osat.osatPercent >= 80
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "bg-red-500/10 text-red-500"
                  } border-0`}
                  data-testid={`badge-osat-${restaurant.restaurantId}`}
                  tooltipTitle="Customer Satisfaction (OSAT)"
                  tooltipDetail={`${restaurant.osat.fiveStarCount} of ${restaurant.osat.totalResponses} responses = 5 stars`}
                >
                  <ThumbsUp className="w-3 h-3" />
                  <span className="font-medium">{restaurant.osat.osatPercent.toFixed(0)}%</span>
                </BadgeWithTooltip>
              )}
              {/* Drive-Thru SOS Badge */}
              {restaurant.driveThru && (() => {
                const carCount = restaurant.driveThru.carCount || 0;
                const carsUnder6 = (restaurant.driveThru as any).carsUnder6Min || 0;
                const attainment = carCount > 0 ? Math.round((carsUnder6 / carCount) * 100) : 0;
                const attColor = attainment >= 70
                  ? "bg-green-500/10 text-green-500"
                  : attainment >= 50
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "bg-red-500/10 text-red-500";

                const isRed = attainment < 50;
                const avgTime = restaurant.driveThru.avgTotalTime;
                const timeStr = `${Math.floor(avgTime / 60)}:${(avgTime % 60).toString().padStart(2, '0')}`;
                return (
                  <BadgeWithTooltip
                    className={`${attColor} border-0 flex-shrink-0 text-xs px-1.5 gap-1 ${isRed ? 'animate-pulse' : ''}`}
                    data-testid={`badge-sos-${restaurant.restaurantId}`}
                    tooltipContent={
                      <div>
                        <div className="font-medium">Drive-Thru Speed</div>
                        <div className="text-muted-foreground">
                          Attainment: {attainment}% under 6 min
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          Avg total: {timeStr}
                        </div>
                        <div className="text-muted-foreground">
                          Cars today: {carCount} ({carsUnder6} under 6 min)
                        </div>
                      </div>
                    }
                  >
                    <Car className="w-3 h-3" />
                    <span>{attainment}%</span>
                  </BadgeWithTooltip>
                );
              })()}
              {/* Crew Experience Badge */}
              {crewSummary && crewSummary.avgScore > 0 && (
                <BadgeWithTooltip
                  className={`flex-shrink-0 text-xs px-1.5 gap-1 ${
                    crewSummary.avgScore >= 75
                      ? "bg-green-500/10 text-green-500"
                      : crewSummary.avgScore >= 50
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "bg-red-500/10 text-red-500"
                  } border-0`}
                  data-testid={`badge-crew-${restaurant.restaurantId}`}
                  tooltipTitle="Crew Experience Score"
                  tooltipDetail={`Weighted score (0-100) based on crew tenure mix. Avg tenure: ${formatTenure(crewSummary.avgTenureMonths)}, ${crewSummary.avgCrewCount.toFixed(0)} avg crew/hr. 75+ green, 50-74 caution, <50 concern.`}
                >
                  <GraduationCap className="w-3 h-3" />
                  <span className="font-medium">{crewSummary.avgScore}</span>
                </BadgeWithTooltip>
              )}
              {/* Check Average Badge */}
              {checkAverage && checkAverage.totalOrders > 0 && (
                <BadgeWithTooltip
                  className="flex-shrink-0 text-xs px-1.5 gap-1 bg-teal-500/10 text-teal-600 dark:text-teal-400 border-0"
                  data-testid={`badge-check-avg-${restaurant.restaurantId}`}
                  tooltipContent={
                    <div>
                      <div className="font-medium">Check Average</div>
                      <div className="text-muted-foreground">{checkAverage.totalOrders} orders today</div>
                      <div className="text-muted-foreground">Total: ${checkAverage.totalSales.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
                    </div>
                  }
                >
                  <Receipt className="w-3 h-3" />
                  <span className="font-medium">${checkAverage.checkAverage.toFixed(2)}</span>
                </BadgeWithTooltip>
              )}
              {/* Consistency Score Badge */}
              {consistencyScore !== undefined && consistencyScore > 0 && (
                <BadgeWithTooltip
                  variant="outline"
                  className={`flex-shrink-0 text-xs font-bold ${
                    consistencyScore >= 75 ? "text-green-500 border-green-300" :
                    consistencyScore >= 50 ? "text-amber-600 dark:text-amber-400 border-amber-300" :
                    "text-red-500 border-red-300"
                  }`}
                  data-testid={`badge-consistency-${restaurant.restaurantId}`}
                  tooltipTitle="Consistency Score (0-100)"
                  tooltipDetail="Measures how stable hourly execution grades are over the last 14 days. Lower grade variance and fewer D/F hours = higher score. 75+ consistent, 50-74 variable, <50 erratic."
                >
                  CST: {consistencyScore}
                </BadgeWithTooltip>
              )}
              {/* Revenue Port Badges */}
              {restaurant.revenuePorts && restaurant.revenuePorts.length > 0 && (
                <div className="hidden sm:flex items-center gap-1">
                  {restaurant.revenuePorts.filter(p => !(p === "drive_thru" && restaurant.driveThru)).map(port => {
                    const config = REVENUE_PORT_CONFIG[port as keyof typeof REVENUE_PORT_CONFIG];
                    if (!config) return null;
                    const Icon = config.icon;
                    return (
                      <BadgeWithTooltip
                        key={port}
                        className={`${config.color} border-0 flex-shrink-0 text-xs px-1.5`}
                        data-testid={`badge-port-${port}-${restaurant.restaurantId}`}
                        tooltipTitle={config.label}
                        tooltipDetail={config.description}
                      >
                        <Icon className="w-3 h-3" />
                      </BadgeWithTooltip>
                    );
                  })}
                </div>
              )}
              {/* Weather Badge */}
              {restaurant.weather && (
                <BadgeWithTooltip
                  variant="secondary"
                  className="flex-shrink-0 text-xs gap-1"
                  data-testid={`badge-weather-${restaurant.restaurantId}`}
                  tooltipContent={
                    <div>
                      <div className="font-medium capitalize">{restaurant.weather!.condition}</div>
                      {restaurant.weather!.highTemp !== undefined ? (
                        <div className="text-muted-foreground">
                          High: {Math.round(restaurant.weather!.highTemp)}°F / Low: {Math.round(restaurant.weather!.lowTemp ?? 0)}°F
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Droplets className="w-3 h-3" />{restaurant.weather!.humidity}%
                          </div>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Wind className="w-3 h-3" />{Math.round(restaurant.weather!.windSpeed)} mph
                          </div>
                        </>
                      )}
                    </div>
                  }
                >
                  <WeatherIcon condition={restaurant.weather.condition} />
                  {restaurant.weather.highTemp !== undefined ? (
                    <span>{Math.round(restaurant.weather.highTemp)}°/{Math.round(restaurant.weather.lowTemp ?? 0)}°</span>
                  ) : (
                    <span>{Math.round(restaurant.weather.temp)}°F</span>
                  )}
                </BadgeWithTooltip>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
              <span className="text-xs">
                LW: {formatCurrency(displayLastWeek)}
              </span>
              <BadgeWithTooltip
                variant="secondary"
                className="flex-shrink-0 text-xs border-0 bg-transparent px-0 font-normal text-muted-foreground"
                tooltipTitle="End-of-Day Forecast"
                tooltipDetail={
                  restaurant.normalizedHour >= 23
                    ? "Day complete"
                    : `${formatCurrency(restaurant.actualSales)} + ${formatCurrency(Math.max(0, restaurant.forecastSales - restaurant.actualSales))} LW remaining`
                }
              >
                <span className="text-xs">
                  EOD Forecast: {(() => {
                    const isDayComplete = restaurant.normalizedHour >= 23;
                    if (isDayComplete) {
                      return formatCurrency(restaurant.actualSales);
                    }
                    return formatCurrency(restaurant.forecastSales);
                  })()}
                </span>
              </BadgeWithTooltip>
              {yoyData && yoyData.priorNetSales > 0 && (() => {
                const isSSS = !restaurant.openDate || (() => {
                  const open = new Date(restaurant.openDate);
                  const now = new Date();
                  return ((now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth())) > 18;
                })();
                if (!isSSS) return null;
                return (
                  <span className="text-xs">
                    LY: {formatCurrency(yoyData.priorNetSales)}
                  </span>
                );
              })()}
            </div>
          </div>

          <div className="flex-shrink-0 text-right">
            <div className="flex items-center justify-end gap-1.5 sm:gap-2">
              <div
                className="text-sm sm:text-base font-semibold tabular-nums"
                data-testid={`text-sales-${restaurant.restaurantId}`}
              >
                {formatCurrency(restaurant.actualSales)}
              </div>
              <span className={`text-[10px] sm:text-xs font-medium whitespace-nowrap ${paceVariance >= 0 ? "text-green-500" : "text-red-500"}`} data-testid={`badge-pace-${restaurant.restaurantId}`}>
                {formatPercentage(paceVariance)}
              </span>
            </div>
            {yoyData && yoyData.priorNetSales > 0 && (() => {
              const isDayComplete = restaurant.normalizedHour >= 23;
              const projectedTotal = isDayComplete ? restaurant.actualSales : restaurant.forecastSales;
              const projYoYVariance = ((projectedTotal - yoyData.priorNetSales) / yoyData.priorNetSales) * 100;
              const monthsOpen = restaurant.openDate ? (() => {
                const open = new Date(restaurant.openDate);
                const now = new Date();
                return (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
              })() : null;
              return (
                <div className="flex items-center justify-end gap-1.5 mt-0.5">
                  <span
                    className={`text-xs font-medium whitespace-nowrap ${projYoYVariance >= 0 
                      ? "text-blue-500" 
                      : "text-orange-500"}`}
                    data-testid={`badge-yoy-${restaurant.restaurantId}`}
                  >
                    {projYoYVariance >= 0 ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> : <TrendingDown className="w-3 h-3 inline mr-0.5" />}
                    YoY {projYoYVariance >= 0 ? "+" : ""}{Math.round(projYoYVariance)}%
                  </span>
                  {monthsOpen !== null && (
                    <span
                      className="text-[10px] text-muted-foreground whitespace-nowrap"
                      data-testid={`text-months-open-${restaurant.restaurantId}`}
                    >
                      {monthsOpen >= 12 ? `${Math.floor(monthsOpen / 12)}y ${monthsOpen % 12}m` : `${monthsOpen}mo`}
                    </span>
                  )}
                </div>
              );
            })()}
            {weeklyData && weeklyData.currentWeek > 0 && (
              <>
                <div className="flex items-center justify-end gap-1.5 mt-0.5">
                  <span className="text-xs text-muted-foreground">WTD:</span>
                  <span className="text-xs font-semibold" data-testid={`text-weekly-${restaurant.restaurantId}`}>
                    {formatCurrency(weeklyData.currentWeek)}
                  </span>
                  {weeklyData.priorWeek > 0 && (() => {
                    const wkVar = ((weeklyData.currentWeek / weeklyData.priorWeek) - 1) * 100;
                    return (
                      <span className={`text-xs font-medium whitespace-nowrap ${wkVar >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {wkVar >= 0 ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> : <TrendingDown className="w-3 h-3 inline mr-0.5" />}
                        vs LW {wkVar >= 0 ? "+" : ""}{Math.round(wkVar)}%
                      </span>
                    );
                  })()}
                </div>
                {weeklyData.eowForecast > weeklyData.currentWeek && (
                  <div className="flex items-center justify-end gap-1.5 mt-0.5">
                    <span className="text-xs text-muted-foreground">EOW:</span>
                    <span className="text-xs font-semibold text-purple-500" data-testid={`text-eow-${restaurant.restaurantId}`}>
                      {formatCurrency(weeklyData.eowForecast)}
                    </span>
                    {weeklyData.priorWeekFull > 0 && (() => {
                      const eowVar = ((weeklyData.eowForecast / weeklyData.priorWeekFull) - 1) * 100;
                      return (
                        <span className={`text-xs font-medium whitespace-nowrap ${eowVar >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {eowVar >= 0 ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> : <TrendingDown className="w-3 h-3 inline mr-0.5" />}
                          vs LW {eowVar >= 0 ? "+" : ""}{Math.round(eowVar)}%
                        </span>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </div>
          
          <div
            className="flex-shrink-0 text-muted-foreground cursor-pointer p-1.5 -m-1.5 rounded-lg hover:bg-muted/50 transition-colors"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid={`toggle-expand-${restaurant.restaurantId}`}
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" data-testid={`chevron-collapse-${restaurant.restaurantId}`} />
            ) : (
              <ChevronDown className="w-4 h-4" data-testid={`chevron-expand-${restaurant.restaurantId}`} />
            )}
          </div>
        </div>

        {isExpanded && activeHours.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/30">
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
                {activeHours.some(h => (h as any).speedAttainment !== undefined) && (
                  <span className="flex items-center gap-1">
                    <div className="w-3 h-0.5 bg-cyan-500" />
                    SOS
                  </span>
                )}
                {activeHours.some(h => h.osatResponses && h.osatResponses > 0) && (
                  <span className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    OSAT
                  </span>
                )}
              </div>
            </div>
            {/* Execution Grades Row - only show grades for completed hours (using restaurant's local hour) */}
            <div className="flex gap-0.5 mb-1">
              {activeHours.map((hour) => {
                const isCompleted = hour.hour <= localGradeCutoff;
                const hasComparableSales = hour.lastWeekSales > 0;
                const salesVariancePct = hasComparableSales 
                  ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
                  : 0;
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                // Exclude operator from labor hours (not production/non-production)
                const positions = hour.positionBreakdown || {};
                const operatorHrs = positions['_operatorScheduled'] || 0;
                const rawEmployeeCount = Number(hour.employeeCount) || 0;
                const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
                const staffingDiff = actualStaff - staffing.total;
                // Exclude staffing from grade when employee count is near-zero (indicates missing/incomplete data)
                const hasValidStaffing = rawEmployeeCount >= 1;
                const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
                
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
                const hasComparableSales = hour.lastWeekSales > 0;
                const salesVariancePct = hasComparableSales 
                  ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
                  : 0;
                const displayValue = hour.todaySales > 0 ? hour.todaySales : hour.lastWeekSales;
                const barHeightPx = Math.max(4, (displayValue / maxSales) * 48);
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                // Exclude operator from labor hours (not production/non-production)
                const positions = hour.positionBreakdown || {};
                const operatorHrs = positions['_operatorScheduled'] || 0;
                const rawEmployeeCount = Number(hour.employeeCount) || 0;
                const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
                const staffingDiff = actualStaff - staffing.total;
                // Exclude staffing from grade when employee count is near-zero (indicates missing/incomplete data)
                const hasValidStaffing = rawEmployeeCount >= 1;
                const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
                const isHovered = hoveredHourIndex === hourIndex;
                
                return (
                  <div
                    key={hour.hour}
                    className="flex-1 flex items-end relative h-full cursor-pointer"
                    onMouseEnter={() => setHoveredHourIndex(hourIndex)}
                    onMouseLeave={() => setHoveredHourIndex(null)}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      setHoveredHourIndex(hoveredHourIndex === hourIndex ? null : hourIndex);
                    }}
                  >
                    {(() => {
                      const barColor = salesVariancePct >= -5
                        ? "bg-green-500 dark:bg-green-400"
                        : "bg-red-500 dark:bg-red-400";
                      const dcHour = demandCurveMap.get(hour.hour);
                      if (dcHour && dcHour.quarters.length === 4 && dcHour.totalOrders > 0) {
                        const maxQ = Math.max(...dcHour.quarters.map(q => q.orders), 1);
                        return (
                          <div
                            className="w-full flex items-end gap-px"
                            style={{ height: `${barHeightPx}px` }}
                          >
                            {dcHour.quarters.map((q, qi) => (
                              <div
                                key={qi}
                                className={`flex-1 rounded-t-[1px] ${barColor}`}
                                style={{
                                  height: `${Math.max(2, (q.orders / maxQ) * barHeightPx)}px`,
                                  opacity: q.orders > 0 ? 1 : 0.3
                                }}
                              />
                            ))}
                          </div>
                        );
                      }
                      return (
                        <div
                          className={`w-full rounded-t-sm transition-all ${barColor}`}
                          style={{ height: `${barHeightPx}px` }}
                        />
                      );
                    })()}
                    <div className={`absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs pointer-events-none whitespace-nowrap z-10 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{hour.label}</span>
                        {isCompleted && hour.todaySales > 0 && <span className={gradeInfo.color}>{gradeInfo.grade}</span>}
                        {!isCompleted && <span className="text-muted-foreground">pending</span>}
                        <span className={salesVariancePct >= -5 ? "text-green-500" : "text-red-500"}>
                          ${hour.todaySales.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">LW ${hour.lastWeekSales.toLocaleString()}</span>
                        {isCompleted && (hour as any).speedAttainment !== undefined && (
                          <span className={
                            (hour as any).speedAttainment < 50 ? "text-red-500" :
                            (hour as any).speedAttainment < 70 ? "text-yellow-500" :
                            "text-green-500"
                          }>
                            {(hour as any).speedAttainment}%
                          </span>
                        )}
                        {isCompleted && (() => {
                          const crewHour = hourlyCrewData?.find(c => c.hour === hour.hour);
                          if (!crewHour || crewHour.experienceScore === 0) return null;
                          const score = crewHour.experienceScore;
                          const color = score >= 75 ? "text-green-500" : score >= 50 ? "text-amber-600 dark:text-amber-400" : "text-red-500";
                          const { trainee = 0, developing = 0, experienced = 0, veteran = 0 } = crewHour.tenureMix || {};
                          const parts = [];
                          if (veteran > 0) parts.push(`${veteran}V`);
                          if (experienced > 0) parts.push(`${experienced}E`);
                          if (developing > 0) parts.push(`${developing}D`);
                          if (trainee > 0) parts.push(`${trainee}T`);
                          return <span className={color}>{parts.join('/') || '0'}</span>;
                        })()}
                        {isCompleted && hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0 && (
                          <span className={
                            hour.osatPercent >= 85 ? "text-green-500" :
                            hour.osatPercent >= 80 ? "text-amber-600 dark:text-amber-400" :
                            "text-red-500"
                          }>
                            OSAT {Math.round(hour.osatPercent)}% ({hour.osatResponses})
                          </span>
                        )}
                        {isCompleted && (() => {
                          const hourCA = checkAverage?.hourly?.[hour.hour];
                          if (!hourCA || hourCA.orders === 0) return null;
                          return <span className="text-teal-600 dark:text-teal-400">${hourCA.avg.toFixed(2)} ({hourCA.orders})</span>;
                        })()}
                      </div>
                      {/* 15-minute interval breakdown */}
                      {isCompleted && (() => {
                        const dcHour = demandCurveMap.get(hour.hour);
                        if (!dcHour || dcHour.quarters.every(q => q.orders === 0)) return null;
                        const h12 = hour.hour === 0 ? 12 : hour.hour > 12 ? hour.hour - 12 : hour.hour;
                        const ampm = hour.hour < 12 ? 'am' : 'pm';
                        return (
                          <div className="flex gap-2 mt-0.5 text-[10px] text-muted-foreground border-t border-border/50 pt-0.5">
                            {dcHour.quarters.map((q, qi) => {
                              const min = qi * 15;
                              return (
                                <span key={qi} className={q.orders > 0 ? "text-foreground" : ""}>
                                  {h12}:{min.toString().padStart(2, '0')}{ampm} <span className="font-medium">{q.orders}</span>
                                </span>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
              {/* SOS Line Overlay - speed attainment */}
              {activeHours.some(h => (h as any).speedAttainment !== undefined) && (
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
                        const att = (hour as any).speedAttainment;
                        if (att === undefined) return null;
                        const x = ((idx + 0.5) / activeHours.length) * 100;
                        // Scale: 0-100% attainment maps to chart height (higher = better = higher on chart)
                        const y = (1 - att / 100) * 100;
                        return `${x},${y}`;
                      })
                      .filter(Boolean)
                      .join(' ')}
                  />
                </svg>
              )}
              {/* OSAT Dots Overlay - colored dots on hours with survey responses */}
              {activeHours.some(h => h.osatResponses && h.osatResponses > 0) && (
                <div className="absolute inset-0 w-full h-full pointer-events-none flex">
                  {activeHours.map((hour, idx) => {
                    const hasOsat = hour.osatResponses && hour.osatResponses > 0;
                    const osatPct = hour.osatPercent || 0;
                    const fillColor = osatPct >= 85 ? "bg-green-500" : osatPct >= 80 ? "bg-yellow-500" : "bg-red-500";
                    const borderColor = osatPct >= 85 ? "border-green-700" : osatPct >= 80 ? "border-yellow-700" : "border-red-700";
                    return (
                      <div key={`osat-${hour.hour}`} className="flex-1 flex justify-center">
                        {hasOsat && (
                          <div 
                            className={`w-3 h-3 rounded-full ${fillColor} border-2 ${borderColor} mt-1`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
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
            {/* Daypart brackets with grades */}
            <div className="flex mt-0.5">
              {DAYPARTS.map(dp => {
                const spanHours = dp.endHour - dp.startHour + 1;
                const widthPercent = (spanHours / 24) * 100;
                const dpGrade = daypartGrades.find(dg => dg.id === dp.id);
                return (
                  <div key={dp.id} style={{ width: `${widthPercent}%` }} className="text-center px-px">
                    <div className={`h-1 rounded-sm ${dp.bgColor}`} style={{ opacity: dpGrade?.grade ? 1 : 0.3 }} />
                    <div className="text-[8px] leading-tight mt-px flex items-center justify-center gap-0.5">
                      <span className={`font-medium ${dp.color}`}>{dp.shortLabel}</span>
                      {dpGrade?.grade && (
                        <span className={`font-bold ${dpGetGradeColor(dpGrade.grade)}`}>{dpGrade.grade}</span>
                      )}
                    </div>
                  </div>
                );
              })}
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
                  // Exclude _operatorScheduled from labor hours (they are neither production nor non-production)
                  const positions = hour.positionBreakdown || {};
                  const operatorHours = positions['_operatorScheduled'] || 0;
                  const laborHours = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHours);
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
                  
                  const hasNoData = laborHours === 0 && sales === 0 && operatorHours === 0;
                  
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
                      onMouseLeave={() => setHoveredHourIndex(null)}
                      onTouchStart={(e) => {
                        e.preventDefault();
                        setHoveredHourIndex(hoveredHourIndex === hourIndex ? null : hourIndex);
                      }}
                    >
                      {hasNoData ? (
                        <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-sm" />
                      ) : (
                        <>
                          {/* Staffing bar — split into 15-min sub-bars when quarter data is available */}
                          {(() => {
                            const qb = hour.quarterBreakdown;
                            if (qb && (qb.q0 > 0 || qb.q1 > 0 || qb.q2 > 0 || qb.q3 > 0)) {
                              const maxQ = Math.max(qb.q0, qb.q1, qb.q2, qb.q3, 0.01);
                              // Each quarter's max possible is 0.25h per person; scale relative to total bar height
                              return (
                                <div
                                  className="w-full flex items-end gap-px"
                                  style={{ height: `${barHeightPx}px` }}
                                >
                                  {[qb.q0, qb.q1, qb.q2, qb.q3].map((qVal, qi) => (
                                    <div
                                      key={qi}
                                      className={`flex-1 rounded-t-[1px] ${barColor}`}
                                      style={{
                                        height: `${Math.max(1, (qVal / maxQ) * barHeightPx)}px`,
                                        opacity: qVal > 0 ? 1 : 0.3
                                      }}
                                    />
                                  ))}
                                </div>
                              );
                            }
                            return (
                              <div
                                className={`w-full rounded-t-sm transition-all ${barColor}`}
                                style={{ height: `${barHeightPx}px` }}
                              />
                            );
                          })()}
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
                      <div className={`absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs pointer-events-none z-10 whitespace-nowrap transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{hour.label}</span>
                            {missingLeadership && (
                              <span className="text-orange-500 flex items-center gap-0.5">
                                <AlertTriangle className="w-3 h-3" />
                              </span>
                            )}
                            <span className={isRightSized ? "text-green-600" : isOverstaffed ? "text-red-600" : "text-yellow-600"}>
                              {laborHours.toFixed(1)}h/{recommendedHours}h
                            </span>
                            {/* Crew experience score */}
                            {(() => {
                              const crewHour = hourlyCrewData?.find(c => c.hour === hour.hour);
                              if (!crewHour || crewHour.experienceScore === 0) return null;
                              const score = crewHour.experienceScore;
                              const color = score >= 75 ? "text-green-600" : score >= 50 ? "text-amber-600" : "text-red-600";
                              return <span className={color}>XP:{score}</span>;
                            })()}
                          </div>
                          {/* Leaders list - show managers, shift supervisors, operators by name */}
                          {(() => {
                            const leaders = hour.leaders || [];
                            if (leaders.length > 0) {
                              return (
                                <div className="text-muted-foreground text-[10px]">
                                  {leaders.map((l, i) => (
                                    <span key={i}>
                                      {i > 0 && ', '}
                                      <span className="font-medium">{l.firstName}</span>
                                      <span className="opacity-70"> ({l.position.includes('Manager') ? 'MGR' : l.position.includes('Supervisor') ? 'SS' : 'OP'})</span>
                                    </span>
                                  ))}
                                </div>
                              );
                            }
                            // Fallback to position breakdown if no leaders data
                            const posKeys = Object.keys(positions)
                              .filter(k => !k.startsWith('_') && positions[k] > 0);
                            if (posKeys.length === 0) return null;
                            return (
                              <div className="text-muted-foreground text-[10px]">
                                {posKeys.slice(0, 5).join(', ')}{posKeys.length > 5 ? '...' : ''}
                              </div>
                            );
                          })()}
                          {/* 15-min quarter labor breakdown */}
                          {(() => {
                            const qb = hour.quarterBreakdown;
                            if (!qb || (qb.q0 === 0 && qb.q1 === 0 && qb.q2 === 0 && qb.q3 === 0)) return null;
                            const h12 = hour.hour === 0 ? 12 : hour.hour > 12 ? hour.hour - 12 : hour.hour;
                            const ampm = hour.hour < 12 ? 'am' : 'pm';
                            return (
                              <div className="flex gap-2 text-[10px] text-muted-foreground border-t border-border/50 pt-0.5">
                                {[qb.q0, qb.q1, qb.q2, qb.q3].map((qVal, qi) => {
                                  const min = qi * 15;
                                  return (
                                    <span key={qi} className={qVal > 0 ? "text-foreground" : ""}>
                                      {h12}:{min.toString().padStart(2, '0')}{ampm} <span className="font-medium">{qVal.toFixed(1)}h</span>
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Total Staffing Summary for the Day */}
              {(() => {
                const totals = activeHours.reduce((acc, hour) => {
                  // Exclude operator from labor hours calculation
                  const positions = hour.positionBreakdown || {};
                  const operatorHrs = positions['_operatorScheduled'] || 0;
                  const laborHrs = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHrs);
                  const sales = hour.todaySales || 0;
                  const hasData = laborHrs > 0 || sales > 0 || operatorHrs > 0;
                  
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
                      isOverstaffed ? "text-red-500" : 
                      isUnderstaffed ? "text-yellow-500" : 
                      "text-green-500"
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
                  width: `${Math.min(100, (restaurant.actualSales / Math.max(displayLastWeek, 1)) * 100)}%` 
                }}
                data-testid={`progress-${restaurant.restaurantId}`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
