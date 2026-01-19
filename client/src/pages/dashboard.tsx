import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, Trophy, BarChart3, AlertCircle } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LeaderboardCard } from "@/components/leaderboard-card";
import { PaceChart } from "@/components/pace-chart";
import { SummaryCards } from "@/components/summary-cards";
import { LeaderboardSkeleton } from "@/components/leaderboard-skeleton";
import type { LeaderboardData, HourlySalesData } from "@shared/schema";

export default function Dashboard() {
  const [selectedRestaurant, setSelectedRestaurant] = useState<string>("all");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const { data: leaderboardData, isLoading, error, refetch, isFetching } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard"],
    refetchInterval: 15 * 60 * 1000, // 15 minutes
  });

  const { data: paceData } = useQuery<HourlySalesData[]>({
    queryKey: ["/api/pace", selectedRestaurant],
    enabled: !!selectedRestaurant,
  });

  useEffect(() => {
    if (leaderboardData?.lastUpdated) {
      setLastRefresh(new Date(leaderboardData.lastUpdated));
    }
  }, [leaderboardData]);

  const handleRefresh = () => {
    refetch();
    setLastRefresh(new Date());
  };

  const getSelectedRestaurantName = () => {
    if (selectedRestaurant === "all") return "All Restaurants";
    const restaurant = leaderboardData?.restaurants.find(r => r.restaurantId === selectedRestaurant);
    return restaurant?.restaurantName || "Selected Restaurant";
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

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
                <h1 className="text-xl font-bold">Sales Leaderboard</h1>
                <p className="text-sm text-muted-foreground">
                  {leaderboardData?.currentDate ? formatDate(leaderboardData.currentDate) : "Today"}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="hidden sm:flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Live
              </Badge>
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
            />

            {/* Main Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Leaderboard Column */}
              <div className="lg:col-span-2 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-yellow-500" />
                    Restaurant Rankings
                  </h2>
                  <Badge variant="outline" className="text-xs">
                    Timezone-normalized
                  </Badge>
                </div>

                <div className="space-y-3">
                  {leaderboardData.restaurants.map((restaurant) => (
                    <LeaderboardCard 
                      key={restaurant.restaurantId} 
                      restaurant={restaurant} 
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
            Data refreshes automatically every 15 minutes
          </p>
        </div>
      </footer>
    </div>
  );
}
