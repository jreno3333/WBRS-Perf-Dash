import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Link } from "wouter";
import { Users, ChevronUp, ChevronDown, RefreshCw, CalendarIcon, Award, Trophy, Star, Search, ArrowRight, CheckCircle, AlertTriangle, X, ArrowUpDown } from "lucide-react";
import { NavBar } from "@/components/nav-bar";
import { format } from "date-fns";

interface CrewMember {
  name: string;
  tenureMonths: number;
  category: 'trainee' | 'developing' | 'experienced' | 'veteran';
}

interface HourlyCrewData {
  hour: number;
  label: string;
  crewCount: number;
  avgTenure: string;
  score: number;
  mix: string;
  team: CrewMember[];
}

interface RestaurantCrewData {
  restaurantId: string;
  restaurantName: string;
  employeeCount: number;
  avgTenure: string;
  avgScore: number;
  hourly: HourlyCrewData[];
}

interface CrewExperienceResponse {
  date: string;
  restaurants: RestaurantCrewData[];
}

interface LeaderPerformance {
  employeeId: string;
  name: string;
  position: string;
  restaurantId: string;
  restaurantName: string;
  hoursWorked: number;
  avgGradeScore: number;
  grade: string;
  avgTransactionsPerHour: number | null;
}

interface PerformanceResponse {
  dateRange: { start: string; end: string };
  byStore: Record<string, LeaderPerformance[]>;
  companyRankings: LeaderPerformance[];
  companyAvgHourlyVolume: number | null;
  requirements?: { minHours: number; minSurveys: number };
}

interface DayFeedback {
  wentWell: string[];
  needsImprovement: string[];
}

interface DailyDetail {
  date: string;
  restaurantId: string;
  restaurantName: string;
  hoursWorked: number;
  gradeScore: number;
  gradeLabel: string;
  avgSalesVariance: number;
  totalSales: number;
  avgSpeed?: number;
  avgStaffingDiff: number;
  osatPercent?: number;
  osatResponses?: number;
  avgHourlyVolume?: number;
  feedback: DayFeedback;
}

interface LeaderDetailResponse {
  leader: {
    employeeId: string;
    name: string;
    position: string;
    totalHours: number;
    avgGradeScore: number;
    gradeLabel: string;
  };
  dateRange: { start: string; end: string };
  dailyDetails: DailyDetail[];
}


function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [year, month, day] = centralStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function getScoreColor(score: number): string {
  if (score >= 85) return "bg-green-500";
  if (score >= 70) return "bg-yellow-500";
  if (score >= 50) return "bg-orange-500";
  return "bg-red-500";
}

function getCategoryColor(category: string): string {
  switch (category) {
    case 'trainee': return "bg-red-500";
    case 'developing': return "bg-orange-400";
    case 'experienced': return "bg-green-500";
    case 'veteran': return "bg-blue-500";
    default: return "bg-gray-500";
  }
}

function getGradeColor(grade: string): string {
  if (grade.startsWith('A')) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (grade.startsWith('B')) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
  if (grade.startsWith('C')) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
}

function formatSpeed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getVolumeLabel(avgVolume: number | null, companyAvg: number | null): { label: string; color: string } | null {
  if (avgVolume === null || companyAvg === null || companyAvg === 0) return null;
  const ratio = avgVolume / companyAvg;
  if (ratio >= 1.25) return { label: 'High', color: 'text-green-600 dark:text-green-400' };
  if (ratio >= 0.75) return { label: 'Med', color: 'text-blue-600 dark:text-blue-400' };
  return { label: 'Low', color: 'text-muted-foreground' };
}

function formatDollars(amount: number): string {
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`;
  return `$${Math.round(amount)}`;
}

export default function CrewExperiencePage() {
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [expandedRestaurants, setExpandedRestaurants] = useState<Set<string>>(new Set());
  const [isSyncing, setIsSyncing] = useState(false);
  const [performanceDays, setPerformanceDays] = useState<number>(30);
  const [searchQuery, setSearchQuery] = useState("");
  const [restaurantFilter, setRestaurantFilter] = useState<string>("all");
  const [selectedLeader, setSelectedLeader] = useState<LeaderPerformance | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [tenureSort, setTenureSort] = useState<"experience" | "employees">("experience");
  
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  
  const { data, isLoading, refetch } = useQuery<CrewExperienceResponse>({
    queryKey: ["/api/crew/experience", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/experience?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch crew data");
      return res.json();
    },
  });
  
  const queryParams = new URLSearchParams({ date: dateStr, days: String(performanceDays) });
  if (searchQuery.trim()) queryParams.set("search", searchQuery.trim());
  if (restaurantFilter !== "all") queryParams.set("restaurantId", restaurantFilter);
  
  const { data: performanceData, isLoading: performanceLoading } = useQuery<PerformanceResponse>({
    queryKey: ["/api/people/performance", dateStr, performanceDays, searchQuery, restaurantFilter],
    queryFn: async () => {
      const res = await fetch(`/api/people/performance?${queryParams.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch performance data");
      return res.json();
    },
  });

  const { data: leaderDetail, isLoading: leaderDetailLoading } = useQuery<LeaderDetailResponse>({
    queryKey: ["/api/people/leader-detail", selectedLeader?.employeeId, dateStr, performanceDays],
    queryFn: async () => {
      const res = await fetch(`/api/people/leader-detail?employeeId=${selectedLeader!.employeeId}&date=${dateStr}&days=${performanceDays}`);
      if (!res.ok) throw new Error("Failed to fetch leader detail");
      return res.json();
    },
    enabled: !!selectedLeader,
  });
  
  const toggleRestaurant = (id: string) => {
    setExpandedRestaurants(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  
  const expandAll = () => {
    if (data) {
      setExpandedRestaurants(new Set(data.restaurants.map(r => r.restaurantId)));
    }
  };
  
  const collapseAll = () => {
    setExpandedRestaurants(new Set());
  };
  
  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await fetch("/api/crew/sync-employees", { method: "POST" });
      await fetch("/api/crew/sync", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr }),
      });
      await refetch();
    } catch (e) {
      console.error("Sync failed:", e);
    } finally {
      setIsSyncing(false);
    }
  };
  
  const formatDisplayDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  
  const storesWithData = (data?.restaurants.filter(r => r.hourly.length > 0) || []).sort((a, b) => {
    if (tenureSort === "employees") return b.employeeCount - a.employeeCount;
    return b.avgScore - a.avgScore;
  });
  
  const allRestaurantOptions: { id: string; name: string }[] = [];
  if (performanceData?.byStore) {
    for (const [storeId, leaders] of Object.entries(performanceData.byStore)) {
      if (leaders.length > 0) {
        allRestaurantOptions.push({ id: storeId, name: leaders[0].restaurantName });
      }
    }
  }
  allRestaurantOptions.sort((a, b) => a.name.localeCompare(b.name));
  
  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">People Tenure & Performance</h1>
            <Badge variant="outline">{storesWithData.length} stores</Badge>
          </div>
          
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" data-testid="button-date-picker">
                  <CalendarIcon className="w-4 h-4 mr-2" />
                  {formatDisplayDate(selectedDate)}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  disabled={(date) => date > getCentralDate()}
                />
              </PopoverContent>
            </Popover>
            
            <NavBar />
            <Button 
              variant="outline" 
              size="icon" 
              onClick={handleSync}
              disabled={isSyncing}
              data-testid="button-sync"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        
        <Tabs defaultValue="performance" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="performance" data-testid="tab-performance">
              <Trophy className="w-4 h-4 mr-2" />
              Leader Rankings
            </TabsTrigger>
            <TabsTrigger value="tenure" data-testid="tab-tenure">
              <Users className="w-4 h-4 mr-2" />
              Experience Level
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="performance" className="mt-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-muted-foreground">
                  Top managers and shift supervisors ranked by execution score
                  {performanceData?.requirements 
                    ? ` (min ${performanceData.requirements.minHours} hrs + ${performanceData.requirements.minSurveys} surveys)`
                    : ''}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Period:</span>
                  <Select 
                    value={String(performanceDays)} 
                    onValueChange={(v) => setPerformanceDays(Number(v))}
                  >
                    <SelectTrigger className="w-[140px]" data-testid="select-performance-days">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">Last 7 days</SelectItem>
                      <SelectItem value="14">Last 14 days</SelectItem>
                      <SelectItem value="30">Last 30 days</SelectItem>
                      <SelectItem value="60">Last 60 days</SelectItem>
                      <SelectItem value="90">Last 90 days</SelectItem>
                      <SelectItem value="180">Last 180 days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-sm">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                    data-testid="input-leader-search"
                  />
                </div>
                <Select value={restaurantFilter} onValueChange={setRestaurantFilter}>
                  <SelectTrigger className="w-[200px]" data-testid="select-restaurant-filter">
                    <SelectValue placeholder="All Restaurants" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Restaurants</SelectItem>
                    {allRestaurantOptions.map(r => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name.replace(/^\d+\s*-\s*/, 'Unit ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(searchQuery || restaurantFilter !== "all") && (
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={() => { setSearchQuery(""); setRestaurantFilter("all"); }}
                    data-testid="button-clear-filters"
                  >
                    <X className="w-4 h-4 mr-1" />
                    Clear
                  </Button>
                )}
              </div>

              {performanceData?.dateRange && (
                <p className="text-xs text-muted-foreground">
                  Showing data from {performanceData.dateRange.start} to {performanceData.dateRange.end}
                </p>
              )}
              
              {performanceLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="animate-pulse">
                      <div className="h-20 bg-muted rounded-lg" />
                    </div>
                  ))}
                </div>
              ) : !performanceData?.companyRankings?.length ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <Award className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      {searchQuery || restaurantFilter !== "all" 
                        ? "No leaders match your search criteria."
                        : "No manager/supervisor performance data yet."}
                    </p>
                    {!searchQuery && restaurantFilter === "all" && (
                      <p className="text-sm text-muted-foreground mt-2">
                        Click sync to load data from 7shifts time punches.
                      </p>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-6">
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <Trophy className="w-5 h-5 text-yellow-500" />
                          {restaurantFilter !== "all" ? "Store Leaderboard" : "Overall Leaderboard"}
                        </CardTitle>
                        <span className="text-sm text-muted-foreground">{performanceData.companyRankings.length} leaders</span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {performanceData.companyRankings.map((leader, index) => (
                          <div 
                            key={leader.employeeId}
                            className="flex items-center justify-between p-2 rounded-lg bg-muted/50 cursor-pointer hover-elevate"
                            onClick={() => { setSelectedLeader(leader); setExpandedDay(null); }}
                            data-testid={`leader-rank-${index + 1}`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                                index === 0 ? 'bg-yellow-500 text-yellow-950' :
                                index === 1 ? 'bg-gray-300 text-gray-800' :
                                index === 2 ? 'bg-amber-600 text-amber-950' :
                                'bg-muted-foreground/20 text-muted-foreground'
                              }`}>
                                {index + 1}
                              </div>
                              <div>
                                <div className="font-medium text-sm">{leader.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {leader.position} • {leader.restaurantName.replace(/^\d+\s*-\s*/, '')}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge className={`text-xs ${getGradeColor(leader.grade)} border-0`}>
                                {leader.grade}
                              </Badge>
                              {leader.avgTransactionsPerHour !== null && (() => {
                                const vol = getVolumeLabel(leader.avgTransactionsPerHour, performanceData.companyAvgHourlyVolume);
                                return vol ? (
                                  <span className={`text-xs font-medium ${vol.color}`} data-testid={`volume-label-${index}`}>
                                    {formatDollars(leader.avgTransactionsPerHour)}/hr
                                  </span>
                                ) : null;
                              })()}
                              <span className="text-xs text-muted-foreground">{leader.hoursWorked}h</span>
                              <ArrowRight className="w-3 h-3 text-muted-foreground" />
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                  
                  {restaurantFilter === "all" && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <Star className="w-5 h-5 text-primary" />
                          Rankings by Store
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {Object.entries(performanceData.byStore).map(([storeId, leaders]) => {
                            const topLeader = leaders[0];
                            if (!topLeader) return null;
                            const unitNum = topLeader.restaurantName.match(/\d+/)?.[0] || storeId;
                            return (
                              <div 
                                key={storeId} 
                                className="p-3 rounded-lg bg-muted/50"
                                data-testid={`store-top-${storeId}`}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-sm font-semibold">Unit #{unitNum}</span>
                                  <span className="text-xs text-muted-foreground">{leaders.length} leaders</span>
                                </div>
                                <div className="space-y-1.5">
                                  {leaders.map((leader, idx) => (
                                    <div 
                                      key={leader.employeeId}
                                      className="flex items-center justify-between cursor-pointer hover-elevate rounded-md p-1.5"
                                      onClick={() => { setSelectedLeader(leader); setExpandedDay(null); }}
                                      data-testid={`store-leader-${storeId}-${idx}`}
                                    >
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs text-muted-foreground w-4">{idx + 1}.</span>
                                        <div>
                                          <div className="text-sm font-medium">{leader.name}</div>
                                          <div className="text-xs text-muted-foreground">{leader.position} • {leader.hoursWorked}h</div>
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <Badge className={`text-xs ${getGradeColor(leader.grade)} border-0`}>
                                          {leader.grade}
                                        </Badge>
                                        {leader.avgTransactionsPerHour !== null && (() => {
                                          const vol = getVolumeLabel(leader.avgTransactionsPerHour, performanceData.companyAvgHourlyVolume);
                                          return vol ? (
                                            <span className={`text-xs ${vol.color}`}>
                                              {formatDollars(leader.avgTransactionsPerHour)}/hr
                                            </span>
                                          ) : null;
                                        })()}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
          
          <TabsContent value="tenure" className="mt-4">
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Employee tenure breakdown by hour - identify inexperienced shifts
              </p>
              
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-red-500" />
                  <span className="text-xs text-muted-foreground">Trainee (&lt;90 days)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-orange-400" />
                  <span className="text-xs text-muted-foreground">Developing (90d-1yr)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-green-500" />
                  <span className="text-xs text-muted-foreground">Experienced (1-2yr)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-blue-500" />
                  <span className="text-xs text-muted-foreground">Veteran (2yr+)</span>
                </div>
                
                <div className="ml-auto flex items-center gap-2">
                  <Select value={tenureSort} onValueChange={(v) => setTenureSort(v as "experience" | "employees")}>
                    <SelectTrigger className="w-[170px]" data-testid="select-tenure-sort">
                      <ArrowUpDown className="w-3 h-3 mr-1" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="experience">Sort by Experience</SelectItem>
                      <SelectItem value="employees">Sort by Headcount</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={expandAll}>
                    Expand All
                  </Button>
                  <Button variant="outline" size="sm" onClick={collapseAll}>
                    Collapse All
                  </Button>
                </div>
              </div>
              
              {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse">
                <div className="h-16 bg-muted rounded-lg" />
              </div>
            ))}
          </div>
        ) : storesWithData.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No crew data available for this date.</p>
              <p className="text-sm text-muted-foreground mt-2">
                Click the sync button to load employee data from 7shifts.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {storesWithData.map(restaurant => (
              <Collapsible
                key={restaurant.restaurantId}
                open={expandedRestaurants.has(restaurant.restaurantId)}
                onOpenChange={() => toggleRestaurant(restaurant.restaurantId)}
              >
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover-elevate py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <CardTitle className="text-base">
                            Unit #{restaurant.restaurantName.match(/\d+/)?.[0] || restaurant.restaurantName}
                          </CardTitle>
                          <span className="text-sm text-muted-foreground">
                            {restaurant.employeeCount || '-'} employees
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Avg: {restaurant.avgTenure}
                          </span>
                          {restaurant.avgScore > 0 && (
                            <Badge 
                              className={`${getScoreColor(restaurant.avgScore)} text-white text-xs`}
                            >
                              {restaurant.avgScore}
                            </Badge>
                          )}
                        </div>
                        {expandedRestaurants.has(restaurant.restaurantId) ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  
                  <CollapsibleContent>
                    <CardContent className="pt-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="text-left py-2 px-2 w-16">Hour</th>
                              <th className="text-center py-2 px-2 w-16">Crew</th>
                              <th className="text-left py-2 px-2 w-24">Avg Tenure</th>
                              <th className="text-center py-2 px-2 w-16">Score</th>
                              <th className="text-center py-2 px-2 w-20">Mix</th>
                              <th className="text-left py-2 px-2">Team</th>
                            </tr>
                          </thead>
                          <tbody>
                            {restaurant.hourly.map(hour => (
                              <tr key={hour.hour} className="border-b border-border/50">
                                <td className="py-2 px-2 font-medium">{hour.label}</td>
                                <td className="py-2 px-2 text-center">{hour.crewCount}</td>
                                <td className="py-2 px-2">{hour.avgTenure}</td>
                                <td className="py-2 px-2 text-center">
                                  <Badge 
                                    className={`${getScoreColor(hour.score)} text-white text-xs min-w-[2.5rem]`}
                                  >
                                    {hour.score}
                                  </Badge>
                                </td>
                                <td className="py-2 px-2 text-center">
                                  <span className="text-xs font-mono">{hour.mix}</span>
                                </td>
                                <td className="py-2 px-2">
                                  <div className="flex flex-wrap gap-1">
                                    {hour.team.map((member, idx) => (
                                      <span
                                        key={idx}
                                        className={`${getCategoryColor(member.category)} text-white text-xs px-2 py-0.5 rounded-md font-medium`}
                                      >
                                        {member.name}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))}
          </div>
        )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Sheet open={!!selectedLeader} onOpenChange={(open) => { if (!open) setSelectedLeader(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto" data-testid="leader-detail-sheet">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {selectedLeader?.name}
            </SheetTitle>
            {selectedLeader && (
              <p className="text-sm text-muted-foreground">
                {selectedLeader.position} • {selectedLeader.restaurantName.replace(/^\d+\s*-\s*/, '')}
              </p>
            )}
          </SheetHeader>

          {leaderDetailLoading ? (
            <div className="mt-6 space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="animate-pulse">
                  <div className="h-16 bg-muted rounded-lg" />
                </div>
              ))}
            </div>
          ) : leaderDetail ? (
            <div className="mt-6 space-y-6">
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-center">
                  <Badge className={`text-lg px-3 py-1 ${getGradeColor(leaderDetail.leader.gradeLabel)} border-0`}>
                    {leaderDetail.leader.gradeLabel}
                  </Badge>
                  <span className="text-xs text-muted-foreground mt-1">Overall</span>
                </div>
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground">Total Hours</div>
                    <div className="font-semibold">{leaderDetail.leader.totalHours}h</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg Score</div>
                    <div className="font-semibold">{leaderDetail.leader.avgGradeScore}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Days Worked</div>
                    <div className="font-semibold">{leaderDetail.dailyDetails.length}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg Volume/Hr</div>
                    {selectedLeader?.avgTransactionsPerHour !== null && selectedLeader?.avgTransactionsPerHour !== undefined ? (() => {
                      const vol = getVolumeLabel(selectedLeader.avgTransactionsPerHour, performanceData?.companyAvgHourlyVolume ?? null);
                      return (
                        <div className="font-semibold flex items-center gap-1">
                          {formatDollars(selectedLeader.avgTransactionsPerHour)}
                          {vol && <span className={`text-xs font-normal ${vol.color}`}>{vol.label}</span>}
                        </div>
                      );
                    })() : <div className="font-semibold text-muted-foreground">-</div>}
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-3">Daily Performance</h3>
                <div className="space-y-2">
                  {leaderDetail.dailyDetails.map((day) => {
                    const isExpanded = expandedDay === day.date;
                    const dayOfWeek = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
                    const displayDate = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return (
                      <div key={day.date}>
                        <div
                          className="flex items-center justify-between p-3 rounded-lg bg-muted/50 cursor-pointer hover-elevate"
                          onClick={() => setExpandedDay(isExpanded ? null : day.date)}
                          data-testid={`day-detail-${day.date}`}
                        >
                          <div className="flex items-center gap-3">
                            <Badge className={`text-xs ${getGradeColor(day.gradeLabel)} border-0 min-w-[2rem] justify-center`}>
                              {day.gradeLabel}
                            </Badge>
                            <div>
                              <div className="text-sm font-medium">{dayOfWeek}, {displayDate}</div>
                              <div className="text-xs text-muted-foreground">
                                {day.hoursWorked}h • ${day.totalSales.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                {day.avgHourlyVolume !== undefined && day.avgHourlyVolume > 0 && (() => {
                                  const vol = getVolumeLabel(day.avgHourlyVolume, performanceData?.companyAvgHourlyVolume ?? null);
                                  return vol ? (
                                    <span className={`ml-1 ${vol.color}`}> {formatDollars(day.avgHourlyVolume)}/hr {vol.label}</span>
                                  ) : null;
                                })()}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {day.avgSalesVariance !== 0 && (
                              <span className={`text-xs ${day.avgSalesVariance >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                {day.avgSalesVariance >= 0 ? '+' : ''}{day.avgSalesVariance.toFixed(1)}%
                              </span>
                            )}
                            {day.avgSpeed !== undefined && (
                              <span className={`text-xs ${day.avgSpeed <= 300 ? 'text-green-600 dark:text-green-400' : day.avgSpeed <= 420 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                                {formatSpeed(day.avgSpeed)}
                              </span>
                            )}
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="mt-2 ml-2 mr-2 space-y-3">
                            <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-muted/30">
                              <div>
                                <div className="text-xs text-muted-foreground">Sales Variance</div>
                                <div className={`text-sm font-medium ${day.avgSalesVariance >= -5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                  {day.avgSalesVariance >= 0 ? '+' : ''}{day.avgSalesVariance.toFixed(1)}%
                                </div>
                              </div>
                              {day.avgSpeed !== undefined && (
                                <div>
                                  <div className="text-xs text-muted-foreground">Avg Speed</div>
                                  <div className={`text-sm font-medium ${day.avgSpeed <= 300 ? 'text-green-600 dark:text-green-400' : day.avgSpeed <= 420 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                                    {formatSpeed(day.avgSpeed)}
                                  </div>
                                </div>
                              )}
                              <div>
                                <div className="text-xs text-muted-foreground">Staffing Diff</div>
                                <div className={`text-sm font-medium ${Math.abs(day.avgStaffingDiff) <= 1 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                  {day.avgStaffingDiff >= 0 ? '+' : ''}{day.avgStaffingDiff.toFixed(1)}
                                </div>
                              </div>
                              {day.osatPercent !== undefined && day.osatResponses !== undefined && day.osatResponses > 0 && (
                                <div>
                                  <div className="text-xs text-muted-foreground">OSAT</div>
                                  <div className={`text-sm font-medium ${day.osatPercent >= 85 ? 'text-green-600 dark:text-green-400' : day.osatPercent >= 80 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                                    {day.osatPercent.toFixed(0)}% ({day.osatResponses})
                                  </div>
                                </div>
                              )}
                            </div>

                            {day.feedback.wentWell.length > 0 && (
                              <div className="p-3 rounded-lg border border-green-200 dark:border-green-800/50 bg-green-50/50 dark:bg-green-900/10">
                                <div className="flex items-center gap-2 mb-2">
                                  <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                                  <span className="text-sm font-medium text-green-700 dark:text-green-400">What went well</span>
                                </div>
                                <ul className="space-y-1">
                                  {day.feedback.wentWell.map((item, i) => (
                                    <li key={i} className="text-sm text-green-700 dark:text-green-300 pl-6">
                                      {item}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {day.feedback.needsImprovement.length > 0 && (
                              <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10">
                                <div className="flex items-center gap-2 mb-2">
                                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                  <span className="text-sm font-medium text-amber-700 dark:text-amber-400">Needs improvement</span>
                                </div>
                                <ul className="space-y-1">
                                  {day.feedback.needsImprovement.map((item, i) => (
                                    <li key={i} className="text-sm text-amber-700 dark:text-amber-300 pl-6">
                                      {item}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {leaderDetail.dailyDetails.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No daily performance data available for this period.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
