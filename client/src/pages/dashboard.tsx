import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Trophy, AlertCircle, CalendarIcon, ChevronLeft, ChevronRight, MapPin, CalendarDays, Grid3X3, Users, TrendingUp } from "lucide-react";
import { Link } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import { LeaderboardCard } from "@/components/leaderboard-card";
import { SummaryCards } from "@/components/summary-cards";
import { LeaderboardSkeleton } from "@/components/leaderboard-skeleton";
import { StateBreakdown } from "@/components/state-breakdown";
import { MarketBreakdown } from "@/components/market-breakdown";
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

// X-Score calculation helpers (matches leaderboard-card component-based approach)
// Returns numeric score for sorting (higher = better)
function getExecutionGrade(salesVariancePct: number, speedSeconds: number | undefined, staffingDiff: number, hasComparableSales: boolean = true): number {
  const components: number[] = [];
  
  // Sales component (only if we have comparable data)
  if (hasComparableSales) {
    // Within -5% to +infinity = 100, Below -5% = 50
    const salesScore = salesVariancePct >= -5 ? 100 : 50;
    components.push(salesScore);
  }
  
  // Speed component (only if we have drive-thru data)
  if (speedSeconds !== undefined) {
    // GREEN (<5min) = 100, YELLOW (5-7min) = 70, RED (>7min) = 40
    let speedScore = 100;
    if (speedSeconds > 420) speedScore = 40;
    else if (speedSeconds > 300) speedScore = 70;
    components.push(speedScore);
  }
  
  // Staffing component (always included)
  // PROPER = 100, UNDER = 60, OVER = 60
  let staffingScore = 100;
  if (staffingDiff > 1) staffingScore = 60; // OVER
  else if (staffingDiff < -1) staffingScore = 60; // UNDER
  components.push(staffingScore);
  
  // Return average of all available components
  if (components.length === 0) return 0;
  return components.reduce((a, b) => a + b, 0) / components.length;
}

function calculateXScore(hourlyData: HourlySalesData[] | undefined, localCutoff?: number): number {
  if (!hourlyData || hourlyData.length === 0) return -1; // No data = -1 to sort to bottom
  
  // Filter to completed hours only (matching leaderboard-card logic)
  const cutoff = localCutoff ?? 23;
  const completedHours = hourlyData.filter(hour => hour.hour <= cutoff);
  
  const scores = completedHours
    .filter(hour => hour.todaySales > 0) // Only hours with sales
    .map(hour => {
      const hasComparableSales = hour.lastWeekSales > 0;
      const salesVariancePct = hasComparableSales 
        ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
        : 0;
      const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
      // Exclude operator hours from labor count (same as leaderboard-card)
      const positions = hour.positionBreakdown || {};
      const operatorHrs = positions['_operatorScheduled'] || 0;
      const actualStaff = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHrs);
      const staffingDiff = actualStaff - staffing.total;
      return getExecutionGrade(salesVariancePct, hour.avgServiceTime, staffingDiff, hasComparableSales);
    }).filter(s => s > 0);
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : -1;
}

export default function Dashboard() {
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [selectedMarket, setSelectedMarket] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"sales" | "variance" | "new_unit" | "missing_manager" | "dt_time" | "xscore" | "google_reviews" | "osat">("sales");

  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const centralToday = getCentralDate();
  const isToday = format(centralToday, "yyyy-MM-dd") === dateStr;

  // Auto-refresh every 5 minutes when viewing today's data
  const refetchInterval = isToday ? 5 * 60 * 1000 : false;

  const { data: leaderboardData, isLoading, error } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      // Debug: log driveThru data presence
      const withDT = data.restaurants?.filter((r: any) => r.driveThru)?.length || 0;
      console.log(`[Dashboard] Loaded ${data.restaurants?.length || 0} restaurants, ${withDT} with driveThru data`);
      return data;
    },
    refetchInterval,
  });

  const { data: hourlyByRestaurant } = useQuery<Record<string, HourlySalesData[]>>({
    queryKey: ["/api/hourly-by-restaurant", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-by-restaurant?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval,
  });

  // Fetch crew summary data for all restaurants
  const { data: crewSummaryResponse } = useQuery<{ date: string; summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> }>({
    queryKey: ["/api/crew/summary", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/summary?date=${dateStr}`);
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
      const res = await fetch(`/api/crew/experience?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval,
  });
  const hourlyCrewByRestaurant = hourlyCrewResponse?.data;

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
      const res = await fetch(`/api/holidays?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
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
    setSelectedDate(new Date());
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
            case "variance":
              // Sort by week-over-week variance using normalized sales
              const aVariance = a.lastWeekSales > 0 ? ((a.todaySales / a.lastWeekSales) - 1) * 100 : 0;
              const bVariance = b.lastWeekSales > 0 ? ((b.todaySales / b.lastWeekSales) - 1) * 100 : 0;
              return bVariance - aVariance;
            case "dt_time":
              // Sort by drive-thru service time ascending (fastest first)
              const aTime = a.driveThru?.avgServiceTime ?? Infinity;
              const bTime = b.driveThru?.avgServiceTime ?? Infinity;
              return aTime - bTime;
            case "xscore":
              // Sort by X-Score descending (highest first)
              // Use each restaurant's localCurrentHour for consistent scoring with display
              const aLocalCutoff = (a as any).localCurrentHour ?? a.normalizedHour;
              const bLocalCutoff = (b as any).localCurrentHour ?? b.normalizedHour;
              const aScore = calculateXScore(hourlyByRestaurant?.[a.restaurantId], aLocalCutoff);
              const bScore = calculateXScore(hourlyByRestaurant?.[b.restaurantId], bLocalCutoff);
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
            default:
              // Default sort by actualSales (total sales so far today)
              return b.actualSales - a.actualSales;
          }
        })
    : [];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 p-2 rounded-lg">
                <Trophy className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold">MWB Executive</h1>
                <div className="flex items-center gap-2">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-6 w-6"
                    onClick={goToPreviousDay}
                    data-testid="button-prev-day"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="text-sm text-muted-foreground hover:text-foreground"
                        data-testid="button-date-picker"
                      >
                        <CalendarIcon className="w-4 h-4 mr-2" />
                        {formatDate(selectedDate)}
                      </Button>
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
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-6 w-6"
                    onClick={goToNextDay}
                    disabled={isToday}
                    data-testid="button-next-day"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                  {!isToday && (
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={goToToday}
                      data-testid="button-go-today"
                    >
                      Today
                    </Button>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {isToday && (
                <Badge variant="secondary" className="hidden sm:flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  Live
                </Badge>
              )}
              <Link href="/dashboard-view">
                <Button variant="ghost" size="icon" data-testid="link-dashboard-view" title="Daily Performance">
                  <Grid3X3 className="h-5 w-5" />
                </Button>
              </Link>
              <Link href="/history">
                <Button variant="ghost" size="icon" data-testid="link-history" title="Performance Trends">
                  <TrendingUp className="h-5 w-5" />
                </Button>
              </Link>
              <Link href="/crew">
                <Button variant="ghost" size="icon" data-testid="link-crew" title="People">
                  <Users className="h-5 w-5" />
                </Button>
              </Link>
              <Link href="/map">
                <Button variant="ghost" size="icon" data-testid="link-map" title="Map">
                  <MapPin className="h-5 w-5" />
                </Button>
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6">
        {error ? (
          <Card className="border-destructive">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 text-destructive">
                <AlertCircle className="w-5 h-5" />
                <div>
                  <p className="font-medium">Unable to load sales data</p>
                  <p className="text-sm text-muted-foreground">
                    Please check your database connection and try again.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <LeaderboardSkeleton />
        ) : leaderboardData ? (
          <>
            {/* Holiday Context Banner */}
            {(holidayData?.todayHoliday || holidayData?.lastWeekHoliday || (holidayData?.comparison?.thisYear && holidayData?.comparison?.lastYear)) && (
              <Card className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900">
                <CardContent className="p-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <CalendarDays className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    {holidayData?.todayHoliday && (
                      <Badge className="bg-amber-500 text-white">
                        Today: {holidayData.todayHoliday.name} ({holidayData.todayHoliday.dayOfWeek})
                      </Badge>
                    )}
                    {holidayData?.lastWeekHoliday && (
                      <Badge variant="outline" className="border-blue-500 text-blue-700 dark:text-blue-300">
                        {holidayData.lastWeekHoliday.isLastWeekComparisonDay 
                          ? `Comparing to: ${holidayData.lastWeekHoliday.name} (${holidayData.lastWeekHoliday.dayOfWeek})`
                          : `${holidayData.lastWeekHoliday.name} was ${holidayData.lastWeekHoliday.dayOfWeek}`}
                      </Badge>
                    )}
                    {holidayData?.comparison?.thisYear && holidayData?.comparison?.lastYear && (
                      <span className="text-sm text-amber-800 dark:text-amber-200">
                        {holidayData.comparison.thisYear.name}: {holidayData.comparison.thisYear.dayOfWeek} this year vs {holidayData.comparison.lastYear.dayOfWeek} last year
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Summary Cards */}
            <SummaryCards 
              restaurants={leaderboardData.restaurants} 
              lastUpdated={leaderboardData.lastUpdated}
              hourlyByRestaurant={hourlyByRestaurant}
            />

            {/* State Breakdown */}
            <StateBreakdown restaurants={leaderboardData.restaurants} hourlyByRestaurant={hourlyByRestaurant} crewSummary={crewSummary} />

            {/* Market Breakdown - Only shown if markets exist */}
            {markets && markets.length > 0 && (
              <MarketBreakdown 
                restaurants={leaderboardData.restaurants} 
                markets={markets}
                hourlyByRestaurant={hourlyByRestaurant} 
                crewSummary={crewSummary} 
              />
            )}

            {/* Restaurant Rankings */}
            <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-yellow-500" />
                    Restaurant Rankings
                    {selectedMarket !== "all" && markets && (
                      <Badge variant="secondary" className="text-xs font-normal">
                        {markets.find(m => m.id === selectedMarket)?.name || "Market"}
                      </Badge>
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
                      <span className="text-xs text-muted-foreground">Sort by:</span>
                      <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                        <SelectTrigger className="w-[140px] h-7 text-xs" data-testid="select-sort">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sales">Total Sales</SelectItem>
                          <SelectItem value="variance">% vs LW</SelectItem>
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

                <div className="space-y-3">
                  {sortedRestaurants.map((restaurant, index) => (
                    <LeaderboardCard 
                      key={restaurant.restaurantId} 
                      restaurant={{...restaurant, rank: index + 1}}
                      hourlyData={hourlyByRestaurant?.[restaurant.restaurantId]}
                      crewSummary={crewSummary?.[restaurant.restaurantId]}
                      hourlyCrewData={hourlyCrewByRestaurant?.[restaurant.restaurantId]}
                    />
                  ))}
                </div>

                {leaderboardData.restaurants.length === 0 && (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <Trophy className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                      <p className="text-muted-foreground">
                        No sales data available yet for today.
                      </p>
                    </CardContent>
                  </Card>
                )}
            </div>
          </>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="border-t mt-8">
        <div className="container mx-auto px-4 py-4">
          <p className="text-center text-sm text-muted-foreground">
            Sales data synced every 5 minutes
          </p>
        </div>
      </footer>
    </div>
  );
}
