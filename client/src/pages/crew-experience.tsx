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
import { Link } from "wouter";
import { ArrowLeft, Users, ChevronUp, ChevronDown, RefreshCw, CalendarIcon, Award, Trophy, Star, UserPlus, Briefcase, TrendingUp } from "lucide-react";
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
}

interface PerformanceResponse {
  dateRange: { start: string; end: string };
  byStore: Record<string, LeaderPerformance[]>;
  companyRankings: LeaderPerformance[];
}

interface ApplicantsByWeek {
  weekStart: string;
  weekLabel: string;
  total: number;
  byLevel: Record<string, number>;
  byStatus: Record<string, number>;
}

interface ApplicantsByUnit {
  restaurantId: string;
  restaurantName: string;
  total: number;
  byLevel: Record<string, number>;
  hired: number;
}

interface ApplicantsSummary {
  totalApplicants: number;
  thisWeek: number;
  hired: number;
  inProgress: number;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
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

function getCategoryLabel(category: string): string {
  switch (category) {
    case 'trainee': return "T";
    case 'developing': return "D";
    case 'experienced': return "E";
    case 'veteran': return "V";
    default: return "?";
  }
}

export default function CrewExperiencePage() {
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [expandedRestaurants, setExpandedRestaurants] = useState<Set<string>>(new Set());
  const [isSyncing, setIsSyncing] = useState(false);
  const [performanceDays, setPerformanceDays] = useState<number>(7);
  
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  
  const { data, isLoading, refetch } = useQuery<CrewExperienceResponse>({
    queryKey: ["/api/crew/experience", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/experience?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch crew data");
      return res.json();
    },
  });
  
  const { data: performanceData, isLoading: performanceLoading } = useQuery<PerformanceResponse>({
    queryKey: ["/api/people/performance", dateStr, performanceDays],
    queryFn: async () => {
      const res = await fetch(`/api/people/performance?date=${dateStr}&days=${performanceDays}`);
      if (!res.ok) throw new Error("Failed to fetch performance data");
      return res.json();
    },
  });
  
  const { data: applicantsByWeek, isLoading: applicantsWeekLoading, refetch: refetchApplicants } = useQuery<ApplicantsByWeek[]>({
    queryKey: ["/api/workstream/by-week"],
    queryFn: async () => {
      const res = await fetch("/api/workstream/by-week?weeks=8");
      if (!res.ok) throw new Error("Failed to fetch applicants by week");
      return res.json();
    },
  });
  
  const { data: applicantsByUnit, isLoading: applicantsUnitLoading } = useQuery<ApplicantsByUnit[]>({
    queryKey: ["/api/workstream/by-unit"],
    queryFn: async () => {
      const res = await fetch("/api/workstream/by-unit");
      if (!res.ok) throw new Error("Failed to fetch applicants by unit");
      return res.json();
    },
  });
  
  const { data: applicantsSummary } = useQuery<ApplicantsSummary>({
    queryKey: ["/api/workstream/summary"],
    queryFn: async () => {
      const res = await fetch("/api/workstream/summary");
      if (!res.ok) throw new Error("Failed to fetch applicants summary");
      return res.json();
    },
  });
  
  const [isSyncingApplicants, setIsSyncingApplicants] = useState(false);
  
  const handleApplicantSync = async () => {
    setIsSyncingApplicants(true);
    try {
      await fetch("/api/workstream/sync", { method: "POST" });
      await refetchApplicants();
    } catch (e) {
      console.error("Applicant sync failed:", e);
    } finally {
      setIsSyncingApplicants(false);
    }
  };
  
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
  
  const storesWithData = data?.restaurants.filter(r => r.hourly.length > 0) || [];
  
  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
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
          <TabsList className="grid w-full max-w-lg grid-cols-3">
            <TabsTrigger value="performance" data-testid="tab-performance">
              <Trophy className="w-4 h-4 mr-2" />
              Leader Rankings
            </TabsTrigger>
            <TabsTrigger value="applicants" data-testid="tab-applicants">
              <UserPlus className="w-4 h-4 mr-2" />
              Applicants
            </TabsTrigger>
            <TabsTrigger value="tenure" data-testid="tab-tenure">
              <Users className="w-4 h-4 mr-2" />
              Hourly Tenure
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="performance" className="mt-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-muted-foreground">
                  Top managers and shift supervisors ranked by execution score
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
                    <p className="text-muted-foreground">No manager/supervisor performance data yet.</p>
                    <p className="text-sm text-muted-foreground mt-2">
                      Click sync to load data from 7shifts time punches.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                  <Card className="flex flex-col">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Trophy className="w-5 h-5 text-yellow-500" />
                        Company Top Performers
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1">
                      <div className="space-y-2">
                        {performanceData.companyRankings.slice(0, 10).map((leader, index) => (
                          <div 
                            key={leader.employeeId}
                            className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
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
                              <Badge className={`text-xs ${
                                leader.grade.startsWith('A') ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                leader.grade === 'B' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                                leader.grade === 'C' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                              } border-0`}>
                                {leader.grade}
                              </Badge>
                              <span className="text-xs text-muted-foreground">{leader.hoursWorked}h</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card className="flex flex-col">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Star className="w-5 h-5 text-primary" />
                        Top by Store
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-hidden">
                      <div className="space-y-3 h-full overflow-y-auto">
                        {Object.entries(performanceData.byStore).map(([storeId, leaders]) => {
                          const topLeader = leaders[0];
                          if (!topLeader) return null;
                          const unitNum = topLeader.restaurantName.match(/\d+/)?.[0] || storeId;
                          return (
                            <div key={storeId} className="p-2 rounded-lg bg-muted/50">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-medium text-muted-foreground">Unit #{unitNum}</span>
                                <span className="text-xs text-muted-foreground">{leaders.length} leaders</span>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>
                                  <div className="font-medium text-sm">{topLeader.name}</div>
                                  <div className="text-xs text-muted-foreground">{topLeader.position}</div>
                                </div>
                                <Badge className={`text-xs ${
                                  topLeader.grade.startsWith('A') ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                  topLeader.grade === 'B' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                                  topLeader.grade === 'C' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                                  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                } border-0`}>
                                  {topLeader.grade}
                                </Badge>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          </TabsContent>
          
          <TabsContent value="applicants" className="mt-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-muted-foreground">
                  Applicant tracking from Workstream by week and unit
                </p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleApplicantSync}
                  disabled={isSyncingApplicants}
                  data-testid="button-sync-applicants"
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${isSyncingApplicants ? 'animate-spin' : ''}`} />
                  Sync from Workstream
                </Button>
              </div>
              
              {applicantsSummary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2">
                        <UserPlus className="w-5 h-5 text-primary" />
                        <div>
                          <div className="text-2xl font-bold">{applicantsSummary.totalApplicants}</div>
                          <div className="text-xs text-muted-foreground">Total Applicants</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-blue-500" />
                        <div>
                          <div className="text-2xl font-bold">{applicantsSummary.thisWeek}</div>
                          <div className="text-xs text-muted-foreground">This Week</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2">
                        <Briefcase className="w-5 h-5 text-green-500" />
                        <div>
                          <div className="text-2xl font-bold">{applicantsSummary.hired}</div>
                          <div className="text-xs text-muted-foreground">Hired</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2">
                        <Users className="w-5 h-5 text-amber-500" />
                        <div>
                          <div className="text-2xl font-bold">{applicantsSummary.inProgress}</div>
                          <div className="text-xs text-muted-foreground">In Progress</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-primary" />
                      Applicants by Week
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {applicantsWeekLoading ? (
                      <div className="space-y-2">
                        {[1, 2, 3].map(i => (
                          <div key={i} className="h-10 bg-muted rounded animate-pulse" />
                        ))}
                      </div>
                    ) : !applicantsByWeek?.length ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <UserPlus className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p>No applicant data yet</p>
                        <p className="text-sm">Click "Sync from Workstream" to load data</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {applicantsByWeek.map((week) => (
                          <div key={week.weekStart} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                            <div>
                              <div className="font-medium text-sm">{week.weekLabel}</div>
                              <div className="flex gap-2 mt-1">
                                {Object.entries(week.byLevel).map(([level, count]) => (
                                  <Badge key={level} variant="outline" className="text-xs">
                                    {level === 'team_member' ? 'TM' : level === 'shift_supervisor' ? 'SS' : level === 'manager' ? 'MGR' : level.toUpperCase()}: {count}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-xl font-bold">{week.total}</div>
                              <div className="text-xs text-muted-foreground">applicants</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Briefcase className="w-5 h-5 text-primary" />
                      Applicants by Unit (Last 90 Days)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {applicantsUnitLoading ? (
                      <div className="space-y-2">
                        {[1, 2, 3].map(i => (
                          <div key={i} className="h-10 bg-muted rounded animate-pulse" />
                        ))}
                      </div>
                    ) : !applicantsByUnit?.length ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Briefcase className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p>No applicant data yet</p>
                        <p className="text-sm">Click "Sync from Workstream" to load data</p>
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {applicantsByUnit.map((unit) => {
                          const unitNum = unit.restaurantName.match(/\d+/)?.[0] || unit.restaurantId;
                          const hireRate = unit.total > 0 ? Math.round((unit.hired / unit.total) * 100) : 0;
                          return (
                            <div key={unit.restaurantId} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                              <div>
                                <div className="font-medium text-sm">Unit #{unitNum}</div>
                                <div className="flex gap-2 mt-1">
                                  {Object.entries(unit.byLevel).map(([level, count]) => (
                                    <Badge key={level} variant="outline" className="text-xs">
                                      {level === 'team_member' ? 'TM' : level === 'shift_supervisor' ? 'SS' : level === 'manager' ? 'MGR' : level.toUpperCase()}: {count}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-xl font-bold">{unit.total}</div>
                                <div className="text-xs text-muted-foreground">
                                  {unit.hired} hired ({hireRate}%)
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
              
              {applicantsSummary && Object.keys(applicantsSummary.bySource || {}).length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">Applicants by Source</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(applicantsSummary.bySource)
                        .sort((a, b) => b[1] - a[1])
                        .map(([source, count]) => (
                          <Badge key={source} variant="secondary" className="text-sm">
                            {source || 'Unknown'}: {count}
                          </Badge>
                        ))}
                    </div>
                  </CardContent>
                </Card>
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
                
                <div className="ml-auto flex gap-2">
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
    </div>
  );
}
