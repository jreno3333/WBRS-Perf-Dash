import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Trophy, BarChart3, AlertCircle, CalendarIcon, ChevronLeft, ChevronRight, Settings, MapPin, CalendarDays } from "lucide-react";
import { Link } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import { LeaderboardCard } from "@/components/leaderboard-card";
import { PaceChart } from "@/components/pace-chart";
import { SummaryCards } from "@/components/summary-cards";
import { LeaderboardSkeleton } from "@/components/leaderboard-skeleton";
import { StateBreakdown } from "@/components/state-breakdown";
import { format } from "date-fns";
import type { LeaderboardData, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

// Get current date in Central timezone (business day)
function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [year, month, day] = centralStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

// X-Score calculation helpers (same as leaderboard-card)
// Sales within -5% still counts as "UP" for grading purposes
function getExecutionGrade(salesVariancePct: number, speedSeconds: number | undefined, staffingDiff: number): number {
  let speed: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
  if (speedSeconds !== undefined) {
    if (speedSeconds > 420) speed = 'RED';
    else if (speedSeconds > 300) speed = 'YELLOW';
  }
  let staffing: 'PROPER' | 'UNDER' | 'OVER' = 'PROPER';
  if (staffingDiff > 1) staffing = 'OVER';
  else if (staffingDiff < -1) staffing = 'UNDER';
  
  // Allow 5% variance to still count as "UP"
  const salesStatus = salesVariancePct >= -5 ? 'UP' : 'DOWN';
  
  const scores: Record<string, number> = {
    'UP-GREEN-PROPER': 100, 'UP-GREEN-UNDER': 90, 'UP-GREEN-OVER': 90,
    'UP-YELLOW-PROPER': 90, 'UP-YELLOW-UNDER': 80, 'UP-YELLOW-OVER': 80,
    'UP-RED-PROPER': 80, 'UP-RED-UNDER': 70, 'UP-RED-OVER': 70,
    'DOWN-GREEN-PROPER': 80, 'DOWN-GREEN-UNDER': 70, 'DOWN-GREEN-OVER': 70,
    'DOWN-YELLOW-PROPER': 70, 'DOWN-YELLOW-UNDER': 60, 'DOWN-YELLOW-OVER': 60,
    'DOWN-RED-PROPER': 60, 'DOWN-RED-UNDER': 50, 'DOWN-RED-OVER': 50,
  };
  return scores[`${salesStatus}-${speed}-${staffing}`] ?? 0;
}

function calculateXScore(hourlyData: HourlySalesData[] | undefined, localCutoff?: number): number {
  if (!hourlyData || hourlyData.length === 0) return -1; // No data = -1 to sort to bottom
  
  // Filter to completed hours only (matching leaderboard-card logic)
  const cutoff = localCutoff ?? 23;
  const completedHours = hourlyData.filter(hour => hour.hour <= cutoff);
  
  const scores = completedHours
    .filter(hour => hour.todaySales > 0 || hour.lastWeekSales > 0)
    .map(hour => {
      const hasComparableSales = hour.lastWeekSales > 0;
      const salesVariancePct = hasComparableSales 
        ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
        : 0;
      const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
      const actualStaff = Number(hour.employeeCount) || 0;
      const staffingDiff = actualStaff - staffing.total;
      return getExecutionGrade(salesVariancePct, hour.avgServiceTime, staffingDiff);
    }).filter(s => s > 0);
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : -1;
}

export default function Dashboard() {
  const [selectedRestaurant, setSelectedRestaurant] = useState<string>("all");
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [sortBy, setSortBy] = useState<"sales" | "variance" | "new_unit" | "alabama" | "tennessee" | "overstaffed" | "understaffed" | "missing_manager" | "dt_time" | "xscore">("sales");

  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const centralToday = getCentralDate();
  const isToday = format(centralToday, "yyyy-MM-dd") === dateStr;

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
    refetchInterval: isToday ? 60 * 1000 : false, // Refresh every 1 minute for real-time updates
  });

  const { data: paceResponse } = useQuery<{ data: HourlySalesData[]; currentHour: number | null; isToday: boolean }>({
    queryKey: ["/api/pace", selectedRestaurant, dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pace/${selectedRestaurant}?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedRestaurant,
  });
  const paceData = paceResponse?.data;

  // Always fetch aggregate pace data for the summary cards (independent of sidebar selection)
  const { data: aggregatePaceResponse } = useQuery<{ data: HourlySalesData[]; currentHour: number | null; isToday: boolean }>({
    queryKey: ["/api/pace", "all", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pace/all?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });
  const aggregatePaceData = aggregatePaceResponse?.data;

  const { data: hourlyByRestaurant } = useQuery<Record<string, HourlySalesData[]>>({
    queryKey: ["/api/hourly-by-restaurant", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-by-restaurant?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  // Fetch holiday data
  const { data: holidayData } = useQuery<{
    todayHoliday: { name: string; date: string; dayOfWeek: string } | null;
    lastWeekHoliday: { name: string; date: string; dayOfWeek: string } | null;
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

  const getSelectedRestaurantName = () => {
    if (selectedRestaurant === "all") return "All Restaurants";
    const restaurant = leaderboardData?.restaurants.find(r => r.restaurantId === selectedRestaurant);
    return restaurant?.restaurantName || "Selected Restaurant";
  };

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

  // Filter and sort restaurants based on selected criteria
  const sortedRestaurants = leaderboardData?.restaurants
    ? [...leaderboardData.restaurants]
        // First, apply filters
        .filter((r) => {
          switch (sortBy) {
            case "alabama":
              // Only Alabama (Central timezone) stores
              return r.timezone?.includes("Chicago");
            case "tennessee":
              // Only Tennessee (Eastern timezone) stores
              return r.timezone?.includes("New_York");
            case "new_unit":
              // Only new units
              return r.status === "new";
            case "overstaffed":
              // Only overstaffed units (missing labor target)
              return !r.willHitLaborTarget;
            case "understaffed":
              // Only understaffed units (very low labor %)
              return (r.projectedLaborPercent || 0) < 15;
            case "missing_manager":
              // Only units missing manager
              return hasMissingManager(r.restaurantId);
            case "dt_time":
              // Only units with drive-thru data
              return r.driveThru != null;
            default:
              return true; // No filter for sales/variance
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
            case "overstaffed":
              // Sort by projected labor % descending (highest labor % first)
              return (b.projectedLaborPercent || 0) - (a.projectedLaborPercent || 0);
            case "understaffed":
              // Sort by projected labor % ascending (lowest labor % first)
              return (a.projectedLaborPercent || 0) - (b.projectedLaborPercent || 0);
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
              <Link href="/map">
                <Button variant="ghost" size="icon" data-testid="link-map">
                  <MapPin className="h-5 w-5" />
                </Button>
              </Link>
              <Link href="/settings">
                <Button variant="ghost" size="icon" data-testid="link-settings">
                  <Settings className="h-5 w-5" />
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
                        Last Week: {holidayData.lastWeekHoliday.name} ({holidayData.lastWeekHoliday.dayOfWeek})
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
            <StateBreakdown restaurants={leaderboardData.restaurants} hourlyByRestaurant={hourlyByRestaurant} />

            {/* Main Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Leaderboard Column */}
              <div className="lg:col-span-2 space-y-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-yellow-500" />
                    Restaurant Rankings
                  </h2>
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
                        <SelectItem value="alabama">Alabama</SelectItem>
                        <SelectItem value="tennessee">Tennessee</SelectItem>
                        <SelectItem value="overstaffed">Overstaffed</SelectItem>
                        <SelectItem value="understaffed">Understaffed</SelectItem>
                        <SelectItem value="missing_manager">Missing Mgr</SelectItem>
                        <SelectItem value="dt_time">DT Time</SelectItem>
                        <SelectItem value="xscore">Exc Score</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-3">
                  {sortedRestaurants.map((restaurant, index) => (
                    <LeaderboardCard 
                      key={restaurant.restaurantId} 
                      restaurant={{...restaurant, rank: index + 1}}
                      hourlyData={hourlyByRestaurant?.[restaurant.restaurantId]}
                    />
                  ))}
                </div>

                {leaderboardData.restaurants.length === 0 && (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <BarChart3 className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                      <p className="text-muted-foreground">
                        No sales data available yet for today.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Pace Chart Column */}
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-blue-500" />
                    Pace Comparison
                  </h2>
                </div>

                <Select 
                  value={selectedRestaurant} 
                  onValueChange={setSelectedRestaurant}
                >
                  <SelectTrigger data-testid="select-restaurant">
                    <SelectValue placeholder="Select restaurant" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Restaurants</SelectItem>
                    {leaderboardData.restaurants.map((restaurant) => (
                      <SelectItem 
                        key={restaurant.restaurantId} 
                        value={restaurant.restaurantId}
                      >
                        {restaurant.restaurantName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Time Zone Info - Above chart */}
                <p className="text-xs text-muted-foreground">
                  Rankings compare sales at equivalent local hours for fair comparison between EST and CST restaurants.
                </p>

                {paceData && paceData.length > 0 ? (
                  <PaceChart 
                    data={paceData} 
                    restaurantName={getSelectedRestaurantName()}
                  />
                ) : (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <BarChart3 className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                      <p className="text-sm text-muted-foreground">
                        Select a restaurant to view hourly pace
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
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
