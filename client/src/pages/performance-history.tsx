import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ThemeToggle } from "@/components/theme-toggle";
import { Link } from "wouter";
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  ArrowLeft,
  Calendar,
  Building2,
  MapPin,
  Globe,
  Target,
  DollarSign,
  Users,
  Clock,
  ThumbsUp,
  Minus,
} from "lucide-react";

interface DailyGrade {
  date: string;
  grade: number;
  gradeLabel: string;
  totalSales: number;
  salesVariance: number;
  avgSpeed?: number;
  staffingDiff: number;
  osatPercent?: number;
  osatResponses?: number;
  avgXp?: number;
}

interface RestaurantHistory {
  restaurantId: string;
  restaurantName: string;
  state: string;
  marketId?: string;
  marketName?: string;
  dailyGrades: DailyGrade[];
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgSpeed?: number;
  avgStaffingDiff: number;
  avgOsat?: number;
  totalOsatResponses: number;
  avgXp?: number;
  gradeImprovement: number;
}

interface StateSummary {
  state: string;
  restaurantCount: number;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgOsat?: number;
  avgImprovement: number;
}

interface MarketSummary {
  market: string;
  restaurantCount: number;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgOsat?: number;
  avgImprovement: number;
}

interface PerformanceHistoryData {
  dateRange: string[];
  restaurants: RestaurantHistory[];
  stateSummaries: StateSummary[];
  marketSummaries: MarketSummary[];
  companySummary: {
    restaurantCount: number;
    avgGrade: number;
    avgGradeLabel: string;
    totalSales: number;
    avgSalesVariance: number;
    avgOsat?: number;
    avgImprovement: number;
  };
}

function getGradeColor(label: string): string {
  if (label.startsWith("A")) return "text-green-600 dark:text-green-400";
  if (label.startsWith("B")) return "text-blue-600 dark:text-blue-400";
  if (label.startsWith("C")) return "text-yellow-600 dark:text-yellow-400";
  if (label.startsWith("D")) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function getGradeBgColor(label: string): string {
  if (label.startsWith("A")) return "bg-green-100 dark:bg-green-900/30";
  if (label.startsWith("B")) return "bg-blue-100 dark:bg-blue-900/30";
  if (label.startsWith("C")) return "bg-yellow-100 dark:bg-yellow-900/30";
  if (label.startsWith("D")) return "bg-orange-100 dark:bg-orange-900/30";
  return "bg-red-100 dark:bg-red-900/30";
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function TrendIndicator({ value }: { value: number }) {
  if (value > 2) return <TrendingUp className="w-4 h-4 text-green-600" />;
  if (value < -2) return <TrendingDown className="w-4 h-4 text-red-600" />;
  return <Minus className="w-4 h-4 text-muted-foreground" />;
}

function GradeTimeline({ grades }: { grades: DailyGrade[] }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {grades.map((grade, idx) => (
        <div
          key={idx}
          className={`flex flex-col items-center p-1.5 rounded ${getGradeBgColor(grade.gradeLabel)} min-w-[50px]`}
          title={`${formatDate(grade.date)}: ${grade.gradeLabel} (${grade.grade.toFixed(0)})`}
        >
          <span className="text-[10px] text-muted-foreground">{formatDate(grade.date).split(",")[0]}</span>
          <span className={`text-sm font-bold ${getGradeColor(grade.gradeLabel)}`}>{grade.gradeLabel}</span>
        </div>
      ))}
    </div>
  );
}

function RestaurantCard({ restaurant }: { restaurant: RestaurantHistory }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Card className="mb-3">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate py-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className={`text-2xl font-bold ${getGradeColor(restaurant.avgGradeLabel)}`}>
                  {restaurant.avgGradeLabel}
                </div>
                <div>
                  <h3 className="font-semibold" data-testid={`text-restaurant-name-${restaurant.restaurantId}`}>
                    {restaurant.restaurantName}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{restaurant.state}</span>
                    {restaurant.marketName && (
                      <>
                        <span>•</span>
                        <span>{restaurant.marketName}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-right">
                  <div className="text-sm font-medium">{formatCurrency(restaurant.totalSales)}</div>
                  <div className="text-xs text-muted-foreground">Total Sales</div>
                </div>
                <div className="text-right">
                  <div className={`text-sm font-medium ${restaurant.avgSalesVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {restaurant.avgSalesVariance >= 0 ? "+" : ""}{restaurant.avgSalesVariance.toFixed(1)}%
                  </div>
                  <div className="text-xs text-muted-foreground">Avg Variance</div>
                </div>
                {restaurant.avgOsat !== undefined && (
                  <div className="text-right">
                    <div className={`text-sm font-medium ${restaurant.avgOsat >= 85 ? "text-green-600" : restaurant.avgOsat >= 80 ? "text-yellow-600" : "text-red-600"}`}>
                      {restaurant.avgOsat.toFixed(0)}%
                    </div>
                    <div className="text-xs text-muted-foreground">OSAT</div>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <TrendIndicator value={restaurant.gradeImprovement} />
                  <span className="text-xs text-muted-foreground">Trend</span>
                </div>
                {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium mb-2">Daily Grade History</h4>
                <GradeTimeline grades={restaurant.dailyGrades} />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Target className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Avg Grade</span>
                  </div>
                  <div className={`text-lg font-bold ${getGradeColor(restaurant.avgGradeLabel)}`}>
                    {restaurant.avgGrade.toFixed(1)} ({restaurant.avgGradeLabel})
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Total Sales</span>
                  </div>
                  <div className="text-lg font-bold">{formatCurrency(restaurant.totalSales)}</div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Avg Speed</span>
                  </div>
                  <div className={`text-lg font-bold ${restaurant.avgSpeed !== undefined ? (restaurant.avgSpeed <= 300 ? "text-green-600" : restaurant.avgSpeed <= 420 ? "text-yellow-600" : "text-red-600") : ""}`}>
                    {restaurant.avgSpeed !== undefined ? `${(restaurant.avgSpeed / 60).toFixed(1)} min` : "N/A"}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <ThumbsUp className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">OSAT</span>
                  </div>
                  <div className="text-lg font-bold">
                    {restaurant.avgOsat !== undefined ? `${restaurant.avgOsat.toFixed(0)}%` : "N/A"}
                    {restaurant.totalOsatResponses > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">({restaurant.totalOsatResponses})</span>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Avg XP</span>
                  </div>
                  <div className={`text-lg font-bold ${restaurant.avgXp !== undefined ? (restaurant.avgXp >= 85 ? "text-green-600" : restaurant.avgXp >= 70 ? "text-yellow-600" : restaurant.avgXp >= 50 ? "text-orange-600" : "text-red-600") : ""}`}>
                    {restaurant.avgXp !== undefined ? `${restaurant.avgXp.toFixed(0)}` : "N/A"}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Grade Trend</span>
                  </div>
                  <div className={`text-lg font-bold ${restaurant.gradeImprovement > 0 ? "text-green-600" : restaurant.gradeImprovement < 0 ? "text-red-600" : ""}`}>
                    {restaurant.gradeImprovement > 0 ? "+" : ""}{restaurant.gradeImprovement.toFixed(1)}
                    <span className="text-xs text-muted-foreground ml-1">
                      {restaurant.dailyGrades.length >= 2 ? "(vs first half)" : ""}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function SummaryCard({ 
  title, 
  icon: Icon, 
  avgGrade, 
  avgGradeLabel, 
  totalSales, 
  avgVariance, 
  avgOsat, 
  avgImprovement,
  count 
}: { 
  title: string;
  icon: typeof Globe;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgVariance: number;
  avgOsat?: number;
  avgImprovement: number;
  count: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          <Badge variant="secondary">{count} units</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className={`text-3xl font-bold ${getGradeColor(avgGradeLabel)}`}>{avgGradeLabel}</div>
            <div className="text-xs text-muted-foreground">Avg Grade ({avgGrade.toFixed(0)})</div>
          </div>
          <div>
            <div className="text-lg font-semibold">{formatCurrency(totalSales)}</div>
            <div className="text-xs text-muted-foreground">Total Sales</div>
          </div>
          <div>
            <div className={`text-lg font-semibold ${avgVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
              {avgVariance >= 0 ? "+" : ""}{avgVariance.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">Avg Variance</div>
          </div>
          <div>
            <div className="flex items-center gap-1">
              <TrendIndicator value={avgImprovement} />
              <span className={`text-lg font-semibold ${avgImprovement > 0 ? "text-green-600" : avgImprovement < 0 ? "text-red-600" : ""}`}>
                {avgImprovement > 0 ? "+" : ""}{avgImprovement.toFixed(1)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">Grade Trend</div>
          </div>
        </div>
        {avgOsat !== undefined && (
          <div className="mt-3 pt-3 border-t">
            <div className="flex items-center gap-2">
              <ThumbsUp className="w-4 h-4 text-purple-500" />
              <span className={`font-semibold ${avgOsat >= 85 ? "text-green-600" : avgOsat >= 80 ? "text-yellow-600" : "text-red-600"}`}>
                {avgOsat.toFixed(0)}% OSAT
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function PerformanceHistoryPage() {
  const [dateRange, setDateRange] = useState("7");
  const [selectedState, setSelectedState] = useState<string>("all");
  const [selectedMarket, setSelectedMarket] = useState<string>("all");

  const { data, isLoading, error } = useQuery<PerformanceHistoryData>({
    queryKey: ["/api/performance-history", dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/performance-history?days=${dateRange}`);
      if (!res.ok) throw new Error("Failed to fetch performance history");
      return res.json();
    },
  });

  const filteredRestaurants = useMemo(() => {
    if (!data) return [];
    let restaurants = data.restaurants;

    if (selectedState !== "all") {
      restaurants = restaurants.filter((r) => r.state === selectedState);
    }
    if (selectedMarket !== "all") {
      restaurants = restaurants.filter((r) => r.marketName === selectedMarket);
    }

    return restaurants;
  }, [data, selectedState, selectedMarket]);

  const states = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.restaurants.map((r) => r.state))).sort();
  }, [data]);

  const markets = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.restaurants.map((r) => r.marketName).filter(Boolean))).sort() as string[];
  }, [data]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Link href="/">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <div>
                <h1 className="text-xl font-bold">Performance History</h1>
                <p className="text-sm text-muted-foreground">
                  Grade trends and performance insights
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Select value={dateRange} onValueChange={setDateRange}>
                <SelectTrigger className="w-[140px]" data-testid="select-date-range">
                  <Calendar className="w-4 h-4 mr-2" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 Days</SelectItem>
                  <SelectItem value="14">Last 14 Days</SelectItem>
                  <SelectItem value="30">Last 30 Days</SelectItem>
                </SelectContent>
              </Select>

              <Select value={selectedState} onValueChange={setSelectedState}>
                <SelectTrigger className="w-[130px]" data-testid="select-state">
                  <MapPin className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All States</SelectItem>
                  {states.map((state) => (
                    <SelectItem key={state} value={state}>{state}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {markets.length > 0 && (
                <Select value={selectedMarket} onValueChange={setSelectedMarket}>
                  <SelectTrigger className="w-[130px]" data-testid="select-market">
                    <Building2 className="w-4 h-4 mr-2" />
                    <SelectValue placeholder="Market" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Markets</SelectItem>
                    {markets.map((market) => (
                      <SelectItem key={market} value={market}>{market}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        )}

        {error && (
          <Card className="border-destructive">
            <CardContent className="p-6 text-center text-destructive">
              Failed to load performance history. Please try again.
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SummaryCard
                title="Company Overall"
                icon={Globe}
                avgGrade={data.companySummary.avgGrade}
                avgGradeLabel={data.companySummary.avgGradeLabel}
                totalSales={data.companySummary.totalSales}
                avgVariance={data.companySummary.avgSalesVariance}
                avgOsat={data.companySummary.avgOsat}
                avgImprovement={data.companySummary.avgImprovement}
                count={data.companySummary.restaurantCount}
              />

              {data.stateSummaries.map((state) => (
                <SummaryCard
                  key={state.state}
                  title={state.state}
                  icon={MapPin}
                  avgGrade={state.avgGrade}
                  avgGradeLabel={state.avgGradeLabel}
                  totalSales={state.totalSales}
                  avgVariance={state.avgSalesVariance}
                  avgOsat={state.avgOsat}
                  avgImprovement={state.avgImprovement}
                  count={state.restaurantCount}
                />
              ))}
            </div>

            {data.marketSummaries.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Markets</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {data.marketSummaries.map((market) => (
                    <SummaryCard
                      key={market.market}
                      title={market.market}
                      icon={Building2}
                      avgGrade={market.avgGrade}
                      avgGradeLabel={market.avgGradeLabel}
                      totalSales={market.totalSales}
                      avgVariance={market.avgSalesVariance}
                      avgOsat={market.avgOsat}
                      avgImprovement={market.avgImprovement}
                      count={market.restaurantCount}
                    />
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">
                  Restaurant Performance ({filteredRestaurants.length})
                </h2>
                <div className="text-sm text-muted-foreground">
                  {data.dateRange.length} days: {formatDate(data.dateRange[0])} - {formatDate(data.dateRange[data.dateRange.length - 1])}
                </div>
              </div>

              {filteredRestaurants.length === 0 ? (
                <Card>
                  <CardContent className="p-8 text-center text-muted-foreground">
                    No restaurants match the selected filters.
                  </CardContent>
                </Card>
              ) : (
                <div>
                  {filteredRestaurants.map((restaurant) => (
                    <RestaurantCard key={restaurant.restaurantId} restaurant={restaurant} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
