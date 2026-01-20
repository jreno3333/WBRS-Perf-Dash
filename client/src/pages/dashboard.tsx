import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { RefreshCw, Trophy, BarChart3, AlertCircle, CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LeaderboardCard } from "@/components/leaderboard-card";
import { PaceChart } from "@/components/pace-chart";
import { SummaryCards } from "@/components/summary-cards";
import { LeaderboardSkeleton } from "@/components/leaderboard-skeleton";
import { StateBreakdown } from "@/components/state-breakdown";
import { format } from "date-fns";
import type { LeaderboardData, HourlySalesData } from "@shared/schema";

export default function Dashboard() {
  const [selectedRestaurant, setSelectedRestaurant] = useState<string>("all");
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [sortBy, setSortBy] = useState<"sales" | "variance">("sales");

  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const isToday = format(new Date(), "yyyy-MM-dd") === dateStr;

  const { data: leaderboardData, isLoading, error, refetch, isFetching } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: isToday ? 2 * 60 * 1000 : false,
  });

  const { data: paceData } = useQuery<HourlySalesData[]>({
    queryKey: ["/api/pace", selectedRestaurant, dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pace/${selectedRestaurant}?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedRestaurant,
  });

  // Always fetch aggregate pace data for the summary cards (independent of sidebar selection)
  const { data: aggregatePaceData } = useQuery<HourlySalesData[]>({
    queryKey: ["/api/pace", "all", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pace/all?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: hourlyByRestaurant } = useQuery<Record<string, HourlySalesData[]>>({
    queryKey: ["/api/hourly-by-restaurant", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-by-restaurant?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  useEffect(() => {
    if (leaderboardData?.lastUpdated) {
      setLastRefresh(new Date(leaderboardData.lastUpdated));
    }
  }, [leaderboardData]);

  const handleRefresh = () => {
    refetch();
  };

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

  // Sort restaurants based on selected criteria
  const sortedRestaurants = leaderboardData?.restaurants
    ? [...leaderboardData.restaurants].sort((a, b) => {
        if (sortBy === "sales") {
          return b.todaySales - a.todaySales;
        } else {
          // Sort by % variance vs last week
          const aVariance = a.lastWeekSales > 0 ? ((a.todaySales / a.lastWeekSales) - 1) * 100 : 0;
          const bVariance = b.lastWeekSales > 0 ? ((b.todaySales / b.lastWeekSales) - 1) * 100 : 0;
          return bVariance - aVariance;
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
                <h1 className="text-xl font-bold">MWB Sales Leaderboard</h1>
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
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleRefresh}
                disabled={isFetching}
                data-testid="button-refresh"
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
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
            {/* Summary Cards */}
            <SummaryCards 
              restaurants={leaderboardData.restaurants} 
              lastUpdated={leaderboardData.lastUpdated}
              paceData={aggregatePaceData}
            />

            {/* State Breakdown */}
            <StateBreakdown restaurants={leaderboardData.restaurants} />

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
                    <div className="flex rounded-md border">
                      <Button
                        variant={sortBy === "sales" ? "secondary" : "ghost"}
                        size="sm"
                        className="rounded-r-none text-xs h-7"
                        onClick={() => setSortBy("sales")}
                        data-testid="button-sort-sales"
                      >
                        Total Sales
                      </Button>
                      <Button
                        variant={sortBy === "variance" ? "secondary" : "ghost"}
                        size="sm"
                        className="rounded-l-none text-xs h-7"
                        onClick={() => setSortBy("variance")}
                        data-testid="button-sort-variance"
                      >
                        % vs LW
                      </Button>
                    </div>
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

                {/* Time Zone Info */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      Timezone Normalization
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p className="text-muted-foreground">
                      Sales are compared at equivalent local hours to ensure fair comparison between Eastern and Central time restaurants.
                    </p>
                    <div className="flex items-center gap-4 text-xs">
                      <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-blue-500" />
                        <span>Eastern Time</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-orange-500" />
                        <span>Central Time</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="border-t mt-8">
        <div className="container mx-auto px-4 py-4">
          <p className="text-center text-sm text-muted-foreground">
            Sales data updated hourly from 7shifts
          </p>
        </div>
      </footer>
    </div>
  );
}
