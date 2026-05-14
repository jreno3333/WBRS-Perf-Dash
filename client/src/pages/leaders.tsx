import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Users, AlertCircle, CalendarIcon, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { NavBar } from "@/components/nav-bar";
import { format } from "date-fns";

function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const [year, month, day] = centralStr.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function getGradeColor(grade: string): string {
  if (grade.startsWith("A")) return "text-green-500";
  if (grade.startsWith("B")) return "text-blue-500";
  if (grade.startsWith("C")) return "text-amber-500";
  return "text-red-500";
}

function getSpeedColor(attainment: number): string {
  if (attainment >= 70) return "text-green-500";
  if (attainment >= 50) return "text-amber-500";
  return "text-red-500";
}

function getOsatColor(pct: number): string {
  if (pct >= 85) return "text-green-500";
  if (pct >= 80) return "text-amber-500";
  return "text-red-500";
}

function formatSpeed(attainment: number): string {
  return `${Math.round(attainment)}%`;
}

function formatTenure(hours: number): string {
  const weeks = Math.floor(hours / 40);
  if (weeks >= 52) {
    const years = Math.floor(weeks / 52);
    const remainingMonths = Math.floor((weeks % 52) / 4);
    return remainingMonths > 0 ? `${years}y${remainingMonths}m` : `${years}y`;
  }
  if (weeks >= 4) {
    const months = Math.floor(weeks / 4);
    const remainingWeeks = weeks % 4;
    return remainingWeeks > 0 ? `${months}m${remainingWeeks}w` : `${months}m`;
  }
  return `${weeks}w`;
}

interface LeaderData {
  employeeId: string;
  name: string;
  position: string;
  restaurantId: string;
  restaurantName: string;
  hoursWorked: number;
  avgGradeScore: number;
  grade: string;
  avgHourlySales: number | null;
  avgSpeed: number | null;
  osatPercent: number | null;
  surveyCount: number;
  companyRank: number;
  totalLeaders: number;
  companyRankDisplay?: string | null;
}

interface StoreEntry {
  restaurantId: string;
  restaurantName: string;
  leaders: LeaderData[];
}

interface LeadersResponse {
  top10: LeaderData[];
  storeEntries: StoreEntry[];
  periodStart: string;
  periodEnd: string;
  totalEligible: number;
  minHoursTop10: number;
  minHoursRequired: number;
}

export default function LeadersPage() {
  const centralToday = getCentralDate();
  const yesterday = new Date(centralToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const [selectedDate, setSelectedDate] = useState<Date>(yesterday);
  const [days, setDays] = useState<string>("7");
  const [positionFilter, setPositionFilter] = useState<string>("all");

  const dateStr = format(selectedDate, "yyyy-MM-dd");

  const { data, isLoading, error } = useQuery<LeadersResponse>({
    queryKey: ["/api/leaders", dateStr, days, positionFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ date: dateStr, days });
      if (positionFilter !== "all") params.set("position", positionFilter);
      const res = await fetch(`/api/leaders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  // Bulk training summary for every leader id displayed on this page.
  interface TrainingSummary {
    percentComplete: number;
    totalCourses: number;
    completedCourses: number;
    overdueCourses: number;
    outstandingCourses: { externalCourseId: string; title: string; category: string | null; percentComplete: number; status: string | null; dueDate: string | null }[];
    certifications: { key: string; name: string; earnedAt: string | null }[];
  }
  type LeaderRow = { employeeId: string; position?: string | null };
  const isShiftPlusPosition = (position: string | null | undefined): boolean => {
    const p = (position || "").toLowerCase();
    return p.includes("manager") || p.includes("supervisor");
  };
  const allEmployeeIds = (() => {
    const ids = new Set<string>();
    if (data) {
      data.top10.forEach((l) => l.employeeId && ids.add(l.employeeId));
      data.storeEntries.forEach((s) => s.leaders.forEach((l) => l.employeeId && ids.add(l.employeeId)));
    }
    return Array.from(ids);
  })();
  const idsKey = allEmployeeIds.join(",");
  const { data: trainingBulk } = useQuery<{ summaries: Record<string, TrainingSummary> }>({
    queryKey: ["/api/training/employees-bulk", idsKey],
    queryFn: async () => {
      const res = await fetch("/api/training/employees-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ employeeIds: allEmployeeIds }),
      });
      if (!res.ok) throw new Error("Failed to fetch training");
      return res.json();
    },
    enabled: allEmployeeIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const trainingByEmployee = trainingBulk?.summaries || {};

  function trainingColor(pct: number): string {
    if (pct >= 90) return "text-green-500";
    if (pct >= 70) return "text-amber-500";
    return "text-red-500";
  }
  function renderTrainingCell(leader: LeaderRow, _compact: boolean) {
    const t = trainingByEmployee[leader.employeeId];
    if (!t || t.totalCourses === 0) {
      return <span className="text-muted-foreground">--</span>;
    }
    const pct = t.percentComplete;
    const certs = t.certifications || [];
    const eligibleFiveStar = isShiftPlusPosition(leader.position);
    const has5Star = eligibleFiveStar && certs.some((c) => c.key === "5_star_floor_management");
    const tipId = `tooltip-training-${leader.employeeId}`;
    const visibleCerts = certs.filter(
      (c) => c.key !== "5_star_floor_management" || eligibleFiveStar,
    );
    const certsLine = visibleCerts.length > 0
      ? `\nCerts: ${visibleCerts.map((c) => c.name).join(', ')}`
      : '';
    const fiveStarSuffix = eligibleFiveStar && !has5Star ? ' · 5-Star Floor Mgmt: not earned' : '';
    return (
      <span
        className={`${trainingColor(pct)} font-medium inline-flex items-center gap-0.5`}
        title={`${pct.toFixed(0)}% complete · ${t.completedCourses}/${t.totalCourses} courses${t.overdueCourses > 0 ? ` · ${t.overdueCourses} overdue` : ''}${fiveStarSuffix}${certsLine}${t.outstandingCourses.length > 0 ? `\nOutstanding: ${t.outstandingCourses.slice(0, 5).map((c) => `${c.title} (${c.percentComplete.toFixed(0)}%)`).join(', ')}` : ''}`}
        data-testid={tipId}
      >
        {pct.toFixed(0)}%
        {t.overdueCourses > 0 && <span className="text-red-500 font-bold">!</span>}
        {has5Star && <span className="text-purple-500" title="5-Star Floor Mgmt">★</span>}
      </span>
    );
  }

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

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatPeriodDate = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 p-2 rounded-lg">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Leader Rankings</h1>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={goToPreviousDay}>
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-sm text-muted-foreground hover:text-foreground">
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
                    disabled={format(selectedDate, "yyyy-MM-dd") === format(centralToday, "yyyy-MM-dd")}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Position:</span>
                <Select value={positionFilter} onValueChange={setPositionFilter}>
                  <SelectTrigger className="w-[130px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Positions</SelectItem>
                    <SelectItem value="manager">Managers</SelectItem>
                    <SelectItem value="ss">Shift Supervisors</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Period:</span>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger className="w-[100px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <NavBar />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-4">
        {error ? (
          <Card className="border-destructive">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 text-destructive">
                <AlertCircle className="w-5 h-5" />
                <div>
                  <p className="font-medium">Unable to load leader rankings</p>
                  <p className="text-sm text-muted-foreground">Please try again later.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            {data.periodStart && data.periodEnd && (
              <p className="text-sm text-muted-foreground text-center">
                {days}-day rolling period: {formatPeriodDate(data.periodStart)} - {formatPeriodDate(data.periodEnd)}
              </p>
            )}

            {/* Top 10 Leaders */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-base font-semibold">Top 10 Leaders - Company Wide</h2>
                  <span className="text-xs text-muted-foreground">
                    {data.totalEligible} eligible (min {data.minHoursTop10} hrs + surveys)
                  </span>
                </div>

                {/* Header row */}
                <div className="flex items-center py-1.5 border-b-2 border-border text-[10px] text-muted-foreground font-semibold">
                  <span className="w-6">#</span>
                  <span className="flex-1">LEADER</span>
                  <span className="w-9 text-center">GRD</span>
                  <span className="w-12 text-right">TNR</span>
                  <span className="w-12 text-right">$/HR</span>
                  <span className="w-11 text-right">SOS</span>
                  <span className="w-11 text-right">OSAT</span>
                  <span className="w-8 text-right">SRV</span>
                  <span className="w-12 text-right">TRN</span>
                </div>

                {data.top10.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No leaders meet the minimum requirements yet.
                  </p>
                ) : (
                  data.top10.map((leader, i) => (
                    <div
                      key={leader.employeeId || leader.name}
                      className={`flex items-center py-2 ${i < data.top10.length - 1 ? "border-b border-border/50" : ""}`}
                    >
                      <span className={`w-6 text-sm font-bold ${i < 3 ? "text-green-500" : "text-muted-foreground"}`}>
                        {leader.companyRank}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{leader.name}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {leader.restaurantName} &middot; {leader.position}
                        </div>
                      </div>
                      <span className={`w-9 text-center text-sm font-bold ${getGradeColor(leader.grade)}`}>
                        {leader.grade}
                      </span>
                      <span className="w-12 text-right text-xs text-muted-foreground">
                        {formatTenure(leader.hoursWorked)}
                      </span>
                      <span className="w-12 text-right text-xs text-muted-foreground">
                        {leader.avgHourlySales !== null ? `$${leader.avgHourlySales}` : "--"}
                      </span>
                      <span className={`w-11 text-right text-xs ${leader.avgSpeed !== null ? getSpeedColor(leader.avgSpeed) : "text-muted-foreground"}`}>
                        {leader.avgSpeed !== null ? formatSpeed(leader.avgSpeed) : "--"}
                      </span>
                      <span className={`w-11 text-right text-xs font-medium ${leader.osatPercent !== null ? getOsatColor(leader.osatPercent) : "text-muted-foreground"}`}>
                        {leader.osatPercent !== null ? `${leader.osatPercent}%` : "--"}
                      </span>
                      <span className="w-8 text-right text-[11px] text-muted-foreground">
                        {leader.surveyCount || "--"}
                      </span>
                      <span className="w-12 text-right text-xs">
                        {renderTrainingCell(leader, false)}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Per-Store Leaders */}
            {data.storeEntries.map((store) => (
              <Card key={store.restaurantId}>
                <CardContent className="p-4">
                  <Link href={`/dashboard-view?date=${dateStr}&unit=${store.restaurantId}`}>
                    <h3 className="text-sm font-semibold mb-2 hover:underline cursor-pointer decoration-dashed underline-offset-4">
                      {store.restaurantName}
                    </h3>
                  </Link>

                  <div className="flex items-center py-1 border-b border-border text-[9px] text-muted-foreground font-semibold">
                    <span className="w-5">#</span>
                    <span className="flex-1">LEADER</span>
                    <span className="w-8 text-center">GRD</span>
                    <span className="w-10 text-right">TNR</span>
                    <span className="w-10 text-right">$/HR</span>
                    <span className="w-10 text-right">SOS</span>
                    <span className="w-10 text-right">OSAT</span>
                    <span className="w-7 text-right">SRV</span>
                    <span className="w-10 text-right">TRN</span>
                    <span className="w-10 text-right">CO.#</span>
                  </div>

                  {store.leaders.map((leader, i) => (
                    <div
                      key={leader.employeeId || leader.name}
                      className={`flex items-center py-1.5 ${i < store.leaders.length - 1 ? "border-b border-border/30" : ""}`}
                    >
                      <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                      <div className="flex-1 min-w-0 flex items-center gap-1">
                        <span className="text-xs truncate">{leader.name}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">{leader.position}</span>
                      </div>
                      <span className={`w-8 text-center text-xs font-semibold ${getGradeColor(leader.grade)}`}>
                        {leader.grade}
                      </span>
                      <span className="w-10 text-right text-[11px] text-muted-foreground">
                        {formatTenure(leader.hoursWorked)}
                      </span>
                      <span className="w-10 text-right text-[11px] text-muted-foreground">
                        {leader.avgHourlySales !== null ? `$${leader.avgHourlySales}` : "--"}
                      </span>
                      <span className={`w-10 text-right text-[11px] ${leader.avgSpeed !== null ? getSpeedColor(leader.avgSpeed) : "text-muted-foreground"}`}>
                        {leader.avgSpeed !== null ? formatSpeed(leader.avgSpeed) : "--"}
                      </span>
                      <span className={`w-10 text-right text-[11px] font-medium ${leader.osatPercent !== null ? getOsatColor(leader.osatPercent) : "text-muted-foreground"}`}>
                        {leader.osatPercent !== null ? `${leader.osatPercent}%` : "--"}
                      </span>
                      <span className="w-7 text-right text-[10px] text-muted-foreground">
                        {leader.surveyCount || "--"}
                      </span>
                      <span className="w-10 text-right text-[10px]">
                        {renderTrainingCell(leader, true)}
                      </span>
                      <span className="w-10 text-right text-[10px] text-muted-foreground">
                        {leader.companyRankDisplay || "--"}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}

            {data.storeEntries.length === 0 && data.top10.length === 0 && (
              <Card>
                <CardContent className="p-8 text-center">
                  <Users className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground">No leader data available for this period.</p>
                </CardContent>
              </Card>
            )}

            <p className="text-xs text-muted-foreground text-center pb-4">
              Top 10 requires min {data.minHoursTop10} hrs + surveys &middot; Per-store min {data.minHoursRequired} hrs
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
