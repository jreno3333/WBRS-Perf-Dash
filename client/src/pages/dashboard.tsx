import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { AlertCircle, ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { NavBar } from "@/components/nav-bar";
import { LeaderboardCard } from "@/components/leaderboard-card";
import { SummaryCards } from "@/components/summary-cards";
import { LeaderboardSkeleton } from "@/components/leaderboard-skeleton";
import { StateBreakdown } from "@/components/state-breakdown";
import { MarketBreakdown } from "@/components/market-breakdown";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { format } from "date-fns";
import type { LeaderboardData, HourlySalesData, MarketWithRestaurants } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

// Get current date in Central timezone (business day)
function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [year, month, day] = centralStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

// X-Score calculation — must match leaderboard-card.tsx grade calculation exactly
// WEIGHTS: Sales 35%, Speed 25%, OSAT 25%, Staffing 15%
const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 };

function scoreToGradeLabel(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  return 'F';
}

function gradeToMidpoint(grade: string): number {
  const scores: Record<string, number> = {
    'A+': 97, 'A': 92, 'A-': 87, 'B+': 82, 'B': 77, 'B-': 72,
    'C+': 67, 'C': 62, 'C-': 57, 'D': 52, 'F': 25
  };
  return scores[grade] ?? 0;
}

function getHourlyGradeScore(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean,
  hasValidStaffing: boolean,
  osatPercent: number | undefined
): number {
  const components: { score: number; weight: number }[] = [];

  if (hasComparableSales) {
    components.push({ score: salesVariancePct >= -5 ? 100 : 50, weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ score: 100, weight: GRADE_WEIGHTS.sales });
  }

  if (speedAttainment !== undefined && speedAttainment >= 0) {
    let speedScore = 100;
    if (speedAttainment < 50) speedScore = 40;
    else if (speedAttainment < 70) speedScore = 70;
    components.push({ score: speedScore, weight: GRADE_WEIGHTS.speed });
  }

  if (osatPercent !== undefined && osatPercent > 0) {
    let osatScore = 100;
    if (osatPercent < 80) osatScore = 40;
    else if (osatPercent < 85) osatScore = 70;
    components.push({ score: osatScore, weight: GRADE_WEIGHTS.osat });
  }

  if (hasValidStaffing) {
    let staffingScore = 100;
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    if (staffingDiff > 1) staffingScore = 60;
    else if (staffingDiff < -1 && !isSalesSurge) staffingScore = 60;
    components.push({ score: staffingScore, weight: GRADE_WEIGHTS.staffing });
  }

  if (components.length === 0) return 0;
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const rawScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;
  return gradeToMidpoint(scoreToGradeLabel(rawScore));
}

function calculateXScore(hourlyData: HourlySalesData[] | undefined, localCutoff?: number, restaurant?: { daysOpen?: number }): number {
  if (!hourlyData || hourlyData.length === 0) return -1;

  const cutoff = localCutoff ?? 23;
  const completedHours = hourlyData.filter(hour => hour.hour <= cutoff);

  const scores = completedHours
    .filter(hour => hour.todaySales > 0)
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
      return getHourlyGradeScore(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent);
    }).filter(s => s > 0);
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : -1;
}

export default function Dashboard() {
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [selectedMarket, setSelectedMarket] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"sales" | "variance" | "wtd_variance" | "yoy" | "new_unit" | "missing_manager" | "dt_time" | "xscore" | "google_reviews" | "osat">("sales");

  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const centralToday = getCentralDate();
  const isToday = format(centralToday, "yyyy-MM-dd") === dateStr;

  // Auto-refresh every 5 minutes when viewing today's data
  const refetchInterval = isToday ? 5 * 60 * 1000 : false;

  const { data: leaderboardData, isLoading, error } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return await res.json();
    },
    refetchInterval,
  });

  const { data: hourlyByRestaurant } = useQuery<Record<string, HourlySalesData[]>>({
    queryKey: ["/api/hourly-by-restaurant", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-by-restaurant?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval,
  });

  // Fetch crew summary data for all restaurants
  const { data: crewSummaryResponse } = useQuery<{ date: string; summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> }>({
    queryKey: ["/api/crew/summary", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/summary?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval,
  });
  const crewSummary = crewSummaryResponse?.summary;

  // Fetch hourly crew experience data for all restaurants
  interface HourlyCrewData {
    hour: number;
    crewCount: number;
    experienceScore: number;
    tenureMix: { trainee: number; developing: number; experienced: number; veteran: number };
  }
  const { data: hourlyCrewResponse } = useQuery<{ date: string; data: Record<string, HourlyCrewData[]> }>({
    queryKey: ["/api/crew/experience", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/experience?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval,
  });
  const hourlyCrewByRestaurant = hourlyCrewResponse?.data;

  // Fetch check average data from POS
  interface CheckAverageData {
    totalOrders: number;
    totalSales: number;
    checkAverage: number;
    hourly: Record<number, { orders: number; sales: number; avg: number }>;
  }
  const { data: checkAverageResponse } = useQuery<{ date: string; restaurants: Record<string, CheckAverageData> }>({
    queryKey: ["/api/pos/check-average", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pos/check-average?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval,
  });
  const checkAverageByRestaurant = checkAverageResponse?.restaurants;

  // Fetch markets data
  const { data: markets } = useQuery<MarketWithRestaurants[]>({
    queryKey: ["/api/markets"],
  });

  // Fetch holiday data (no need to refresh frequently)
  const { data: holidayData } = useQuery<{
    todayHoliday: { name: string; date: string; dayOfWeek: string } | null;
    lastWeekHoliday: { name: string; date: string; dayOfWeek: string; isLastWeekComparisonDay?: boolean } | null;
    upcomingHolidays: { name: string; date: string; dayOfWeek: string }[];
    comparison: {
      thisYear: { name: string; date: string; dayOfWeek: string } | null;
      lastYear: { name: string; date: string; dayOfWeek: string } | null;
    };
  }>({
    queryKey: ["/api/holidays", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/holidays?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  // Fetch weekly sales data (Sat-Fri business week)
  interface WeeklySalesData {
    currentWeekStart: string;
    currentWeekEnd: string;
    priorWeekStart: string;
    priorWeekEnd: string;
    daysInCurrentWeek: number;
    daysInPriorWeek: number;
    restaurants: Record<string, { currentWeek: number; priorWeek: number; eowForecast: number; priorWeekFull: number; daysInCurrentWeek: number }>;
  }
  const { data: weeklySalesData } = useQuery<WeeklySalesData>({
    queryKey: ["/api/weekly-sales"],
    refetchInterval,
  });

  // Fetch consistency scores for all restaurants (14-day window)
  const { data: consistencyData } = useQuery<{
    companyAvgConsistency: number;
    restaurants: { restaurantId: string; consistencyScore: number }[];
  }>({
    queryKey: ["/api/analytics/consistency"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/consistency?days=14");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });
  const consistencyByRestaurant = consistencyData?.restaurants?.reduce((acc, r) => {
    acc[r.restaurantId] = r.consistencyScore;
    return acc;
  }, {} as Record<string, number>);

  // Fetch demand curves (15-min intervals) for all restaurants
  interface DemandCurveHour {
    hour: number;
    quarters: { label: string; orders: number; sales: number }[];
    totalOrders: number;
    totalSales: number;
    loadProfile: string;
  }
  const { data: demandCurvesData } = useQuery<{
    restaurants: { restaurantId: string; hours: DemandCurveHour[] }[];
  }>({
    queryKey: ["/api/analytics/demand-curves", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/demand-curves?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });
  const demandCurvesByRestaurant = demandCurvesData?.restaurants?.reduce((acc, r) => {
    acc[r.restaurantId] = r.hours;
    return acc;
  }, {} as Record<string, DemandCurveHour[]>);

  const { data: yoyBulkData } = useQuery<{
    priorDate: string;
    data: Record<string, { priorNetSales: number; priorGuestCount: number; priorDate: string }>;
  }>({
    queryKey: ["/api/historical-sales/yoy-bulk", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/historical-sales/yoy-bulk?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch YoY data");
      return res.json();
    },
  });

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const goToPreviousDay = () => {
    const prev = new Date(selectedDate);
    prev.setDate(prev.getDate() - 1);
    setSelectedDate(prev);
  };

  const goToNextDay = () => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 1);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (next <= today) {
      setSelectedDate(next);
    }
  };

  const goToToday = () => {
    setSelectedDate(getCentralDate());
  };

  // Helper to check if restaurant has missing manager (will be computed from hourly data)
  // Operators don't punch in but are considered leaders if scheduled
  const hasMissingManager = (restaurantId: string) => {
    const data = hourlyByRestaurant?.[restaurantId] || [];
    // Check if any hour with labor has no manager/shift supervisor/operator
    return data.some((hour: HourlySalesData) => {
      const laborHours = Number(hour.employeeCount) || 0;
      if (laborHours === 0) return false;
      const positions = hour.positionBreakdown || {};
      const positionKeys = Object.keys(positions).map(k => k.toLowerCase());
      const hasManager = positionKeys.some(p => p.includes("manager"));
      const hasShiftSupervisor = positionKeys.some(p => p.includes("shift supervisor") || p.includes("supervisor"));
      const hasOperatorScheduled = positions['_operatorScheduled'] === 1;
      return !hasManager && !hasShiftSupervisor && !hasOperatorScheduled;
    });
  };

  // Get selected market restaurant IDs for filtering
  const selectedMarketRestaurantIds = selectedMarket !== "all" && markets
    ? markets.find(m => m.id === selectedMarket)?.restaurantIds || []
    : null;

  // Filter and sort restaurants based on selected criteria
  const sortedRestaurants = leaderboardData?.restaurants
    ? [...leaderboardData.restaurants]
        // First, apply market filter
        .filter((r) => {
          if (selectedMarketRestaurantIds) {
            return selectedMarketRestaurantIds.includes(r.restaurantId);
          }
          return true;
        })
        // Then, apply sort-based filters
        .filter((r) => {
          switch (sortBy) {
            case "new_unit":
              // Only new units
              return r.status === "new";
            case "missing_manager":
              // Only units missing manager
              return hasMissingManager(r.restaurantId);
            case "dt_time":
              // Only units with drive-thru data
              return r.driveThru != null;
            case "google_reviews":
              // Only units with Google Reviews data
              return r.googleReviews != null;
            case "osat":
              // Only units with OSAT data
              return r.osat != null && r.osat.totalResponses > 0;
            case "yoy":
              // Only units with YoY data
              return yoyBulkData?.data?.[r.restaurantId] != null;
            default:
              return true; // No filter for sales/variance/xscore
          }
        })
        // Then sort
        .sort((a, b) => {
          // Training units always go to the bottom
          if (a.status === "training" && b.status !== "training") return 1;
          if (a.status !== "training" && b.status === "training") return -1;
          
          switch (sortBy) {
            case "sales":
              // Sort by actualSales (total sales so far today)
              return b.actualSales - a.actualSales;
            case "variance": {
              const aLastWeek = (a as any).actualLastWeekSales ?? a.lastWeekSales;
              const bLastWeek = (b as any).actualLastWeekSales ?? b.lastWeekSales;
              const aVariance = aLastWeek > 0 ? ((a.actualSales / aLastWeek) - 1) * 100 : 0;
              const bVariance = bLastWeek > 0 ? ((b.actualSales / bLastWeek) - 1) * 100 : 0;
              return bVariance - aVariance;
            }
            case "wtd_variance": {
              const aWk = weeklySalesData?.restaurants?.[a.restaurantId];
              const bWk = weeklySalesData?.restaurants?.[b.restaurantId];
              const aWtdVar = aWk && aWk.priorWeek > 0 ? ((aWk.currentWeek / aWk.priorWeek) - 1) * 100 : -999;
              const bWtdVar = bWk && bWk.priorWeek > 0 ? ((bWk.currentWeek / bWk.priorWeek) - 1) * 100 : -999;
              return bWtdVar - aWtdVar;
            }
            case "dt_time":
              // Sort by speed attainment descending (highest % first)
              const aAtt = a.driveThru ? ((a.driveThru as any).carsUnder6Min / (a.driveThru.carCount || 1)) * 100 : -1;
              const bAtt = b.driveThru ? ((b.driveThru as any).carsUnder6Min / (b.driveThru.carCount || 1)) * 100 : -1;
              return bAtt - aAtt;
            case "xscore":
              // Sort by X-Score descending (highest first)
              // Use each restaurant's localCurrentHour for consistent scoring with display
              const aLocalCutoff = (a as any).localCurrentHour ?? a.normalizedHour;
              const bLocalCutoff = (b as any).localCurrentHour ?? b.normalizedHour;
              const aScore = calculateXScore(hourlyByRestaurant?.[a.restaurantId], aLocalCutoff, a);
              const bScore = calculateXScore(hourlyByRestaurant?.[b.restaurantId], bLocalCutoff, b);
              return bScore - aScore;
            case "google_reviews":
              // Sort by Google rating descending (highest first)
              const aRating = a.googleReviews?.rating ?? 0;
              const bRating = b.googleReviews?.rating ?? 0;
              return bRating - aRating;
            case "osat":
              // Sort by OSAT percentage descending (highest first)
              const aOsat = a.osat?.osatPercent ?? 0;
              const bOsat = b.osat?.osatPercent ?? 0;
              return bOsat - aOsat;
            case "yoy": {
              const aYoy = yoyBulkData?.data?.[a.restaurantId];
              const bYoy = yoyBulkData?.data?.[b.restaurantId];
              const aProjected = a.normalizedHour < 23 ? a.forecastSales : a.actualSales;
              const bProjected = b.normalizedHour < 23 ? b.forecastSales : b.actualSales;
              const aYoyVar = aYoy ? ((aProjected / aYoy.priorNetSales) - 1) * 100 : -999;
              const bYoyVar = bYoy ? ((bProjected / bYoy.priorNetSales) - 1) * 100 : -999;
              return bYoyVar - aYoyVar;
            }
            default:
              // Default sort by actualSales (total sales so far today)
              return b.actualSales - a.actualSales;
          }
        })
    : [];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="container mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-4">
              <h1 className="text-base font-semibold tracking-tight">
                MWB Performance
                {isToday && (
                  <span className="inline-flex items-center gap-1.5 ml-2 text-xs font-medium text-green-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                    Live
                  </span>
                )}
              </h1>
              <div className="hidden sm:flex items-center gap-0.5 text-sm">
                <button
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                  onClick={goToPreviousDay}
                  data-testid="button-prev-day"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                      data-testid="button-date-picker"
                    >
                      {formatDate(selectedDate)}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={selectedDate}
                      onSelect={(date) => date && setSelectedDate(date)}
                      disabled={(date) => date > new Date()}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                <button
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
                  onClick={goToNextDay}
                  disabled={isToday}
                  data-testid="button-next-day"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                {!isToday && (
                  <button
                    className="ml-1 px-2 py-0.5 rounded-md text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                    onClick={goToToday}
                    data-testid="button-go-today"
                  >
                    Today
                  </button>
                )}
              </div>
            </div>

            <NavBar />
          </div>
          {/* Mobile date nav */}
          <div className="sm:hidden flex items-center justify-center gap-1 pb-2 -mt-1">
            <button
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
              onClick={goToPreviousDay}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button className="px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground">
                  {formatDate(selectedDate)}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="center">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  disabled={(date) => date > new Date()}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <button
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
              onClick={goToNextDay}
              disabled={isToday}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            {!isToday && (
              <button
                className="ml-1 px-2 py-0.5 rounded-md text-xs font-medium text-primary"
                onClick={goToToday}
              >
                Today
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 sm:px-6 py-5 space-y-5">
        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-3 text-destructive">
              <AlertCircle className="w-4 h-4" />
              <div>
                <p className="text-sm font-medium">Unable to load sales data</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Please check your database connection and try again.
                </p>
              </div>
            </div>
          </div>
        ) : isLoading ? (
          <LeaderboardSkeleton />
        ) : leaderboardData ? (
          <>
            {/* Holiday Context Banner */}
            {(holidayData?.todayHoliday || holidayData?.lastWeekHoliday || (holidayData?.comparison?.thisYear && holidayData?.comparison?.lastYear)) && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm">
                <CalendarDays className="w-4 h-4 text-amber-500 shrink-0" />
                <div className="flex items-center gap-2 flex-wrap">
                  {holidayData?.todayHoliday && (
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      Today: {holidayData.todayHoliday.name}
                    </span>
                  )}
                  {holidayData?.lastWeekHoliday && (
                    <span className="text-muted-foreground text-xs">
                      {holidayData.lastWeekHoliday.isLastWeekComparisonDay
                        ? `Comparing to: ${holidayData.lastWeekHoliday.name}`
                        : `${holidayData.lastWeekHoliday.name} was ${holidayData.lastWeekHoliday.dayOfWeek}`}
                    </span>
                  )}
                  {holidayData?.comparison?.thisYear && holidayData?.comparison?.lastYear && (
                    <span className="text-xs text-muted-foreground">
                      {holidayData.comparison.thisYear.name}: {holidayData.comparison.thisYear.dayOfWeek} this year vs {holidayData.comparison.lastYear.dayOfWeek} last year
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Summary Cards */}
            <SummaryCards
              restaurants={leaderboardData.restaurants}
              lastUpdated={leaderboardData.lastUpdated}
              hourlyByRestaurant={hourlyByRestaurant}
              yoyData={yoyBulkData?.data}
              weeklySalesData={weeklySalesData}
            />

            {/* State Breakdown */}
            <StateBreakdown restaurants={leaderboardData.restaurants} hourlyByRestaurant={hourlyByRestaurant} crewSummary={crewSummary} weeklySalesData={weeklySalesData} />

            {/* Market Breakdown - Only shown if markets exist */}
            {markets && markets.length > 0 && (
              <MarketBreakdown
                restaurants={leaderboardData.restaurants}
                markets={markets}
                hourlyByRestaurant={hourlyByRestaurant}
                crewSummary={crewSummary}
                weeklySalesData={weeklySalesData}
              />
            )}

            {/* Analytics Panel */}
            <AnalyticsPanel dateStr={dateStr} isToday={isToday} />

            {/* Restaurant Rankings */}
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                    Restaurant Rankings
                    {selectedMarket !== "all" && markets && (
                      <span className="text-xs font-normal normal-case text-primary">
                        {markets.find(m => m.id === selectedMarket)?.name || "Market"}
                      </span>
                    )}
                  </h2>
                  <div className="flex items-center gap-3">
                    {markets && markets.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Market:</span>
                        <Select value={selectedMarket} onValueChange={setSelectedMarket}>
                          <SelectTrigger className="w-[130px] h-7 text-xs" data-testid="select-market">
                            <SelectValue placeholder="All Markets" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Markets</SelectItem>
                            {markets.map((market) => (
                              <SelectItem key={market.id} value={market.id}>
                                <span className="flex items-center gap-2">
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: market.color || "#6366f1" }}
                                  />
                                  {market.name}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Sort:</span>
                      <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                        <SelectTrigger className="w-[130px] h-7 text-xs" data-testid="select-sort">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sales">Total Sales</SelectItem>
                          <SelectItem value="variance">% vs LW Day</SelectItem>
                          <SelectItem value="wtd_variance">% vs LW WTD</SelectItem>
                          <SelectItem value="yoy">% vs LY</SelectItem>
                          <SelectItem value="new_unit">New Units</SelectItem>
                          <SelectItem value="missing_manager">Missing Mgr</SelectItem>
                          <SelectItem value="dt_time">DT Time</SelectItem>
                          <SelectItem value="xscore">Exc Score</SelectItem>
                          <SelectItem value="google_reviews">Google Rating</SelectItem>
                          <SelectItem value="osat">OSAT</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {sortedRestaurants.map((restaurant, index) => (
                    <LeaderboardCard
                      key={restaurant.restaurantId}
                      restaurant={{...restaurant, rank: index + 1}}
                      hourlyData={hourlyByRestaurant?.[restaurant.restaurantId]}
                      crewSummary={crewSummary?.[restaurant.restaurantId]}
                      hourlyCrewData={hourlyCrewByRestaurant?.[restaurant.restaurantId]}
                      checkAverage={checkAverageByRestaurant?.[restaurant.restaurantId]}
                      consistencyScore={consistencyByRestaurant?.[restaurant.restaurantId]}
                      demandCurveHours={demandCurvesByRestaurant?.[restaurant.restaurantId]}
                      isToday={isToday}
                      yoyData={yoyBulkData?.data?.[restaurant.restaurantId]}
                      weeklyData={weeklySalesData?.restaurants?.[restaurant.restaurantId]}
                    />
                  ))}
                </div>

                {leaderboardData.restaurants.length === 0 && (
                  <div className="rounded-xl border border-border/50 p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      No sales data available yet for today.
                    </p>
                  </div>
                )}
            </div>
          </>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 mt-6">
        <div className="container mx-auto px-4 sm:px-6 py-3">
          <p className="text-center text-xs text-muted-foreground">
            Sales data synced every 5 minutes
          </p>
        </div>
      </footer>
    </div>
  );
}
