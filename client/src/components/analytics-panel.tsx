import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Calendar, TrendingUp, TrendingDown, BarChart3, Users, AlertTriangle, Clock, Activity, ShoppingBag, UserCheck } from "lucide-react";
import { useState } from "react";
import { formatCurrency } from "@/lib/grading";

interface CheckAverageData {
  totalOrders: number;
  totalSales: number;
  checkAverage: number;
  hourly: Record<number, { orders: number; sales: number; avg: number }>;
}

interface AnalyticsPanelProps {
  dateStr: string;
  isToday: boolean;
  checkAverageByRestaurant?: Record<string, CheckAverageData>;
}

interface AnniversaryData {
  employeeId: string;
  name: string;
  position: string;
  restaurantName: string;
  yearsCompleted: number;
  daysUntil: number;
  anniversaryDate: string;
}

interface WeeklyForecastData {
  weekStart: string;
  weekEnd: string;
  actualTotal: number;
  forecastTotal: number;
  lastWeekTotal: number;
  variancePercent: number;
  daily: {
    date: string;
    dayName: string;
    actual: number;
    lastWeek: number;
    forecast: number;
    source: "actual" | "partial" | "projected";
    lastWeekAtThisPoint?: number;
  }[];
}

interface ConsistencyData {
  companyAvgConsistency: number;
  restaurants: {
    restaurantId: string;
    restaurantName: string;
    consistencyScore: number;
    avgGrade: number;
    avgGradeLabel: string;
    gradeStdDev: number;
    dfCount: number;
    dfPercent: number;
    totalGradedHours: number;
    daysAnalyzed: number;
  }[];
}

interface ComplianceData {
  period: { start: string; end: string; days: number };
  restaurants: {
    restaurantId: string;
    restaurantName: string;
    compliancePercent: number;
    actualHoursDeployed: number;
    callInRate: number;
    underHours: number;
    totalHours: number;
  }[];
}

interface SuppressedData {
  date: string;
  companyTotalSuppressed: number;
  companyTotalSales: number;
  companyLostPercent: number;
  restaurants: {
    restaurantId: string;
    restaurantName: string;
    estimatedLostSales: number;
    understaffedHours: number;
    slowDtHours: number;
    totalRestaurantSales: number;
    lostPercent: number;
  }[];
}

const formatCompactCurrency = (amount: number) => {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(amount / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `$${Math.round(amount)}`;
};

function getConsistencyColor(score: number): string {
  if (score >= 75) return "text-green-600 dark:text-green-400";
  if (score >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function getComplianceColor(pct: number): string {
  if (pct >= 90 && pct <= 110) return "text-green-600 dark:text-green-400";
  if (pct >= 75) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

interface OperatorScheduleData {
  weekStart: string;
  weekEnd: string;
  dayLabels: { date: string; dayName: string; isToday: boolean }[];
  restaurants: {
    restaurantId: string;
    restaurantName: string;
    scheduledDays: number;
    totalHours: number;
    days: {
      date: string;
      dayName: string;
      hours: number[];
      startHour: number | null;
      endHour: number | null;
    }[];
  }[];
}

interface AttachmentRateData {
  date: string;
  source?: "pos_detail" | "modeled";
  categoryLabels: Record<string, string>;
  benchmarks: Record<string, { min: number; max: number; benchmark: number }>;
  restaurants: Record<string, {
    restaurantName: string;
    totalOrders: number;
    checkAverage: number;
    categories: Record<string, { attachRate: number; estimatedUnits: number; benchmark: number; vsTarget: number }>;
    overallAttachScore: number;
  }>;
}

export function AnalyticsPanel({ dateStr, isToday, checkAverageByRestaurant }: AnalyticsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAllConsistency, setShowAllConsistency] = useState(false);
  const [showAllCompliance, setShowAllCompliance] = useState(false);
  const [showAllSuppressed, setShowAllSuppressed] = useState(false);
  const [showAllAttachments, setShowAllAttachments] = useState(false);
  const [showAllOperatorSchedule, setShowAllOperatorSchedule] = useState(false);

  // Badge data loads eagerly (shown in collapsed header)
  const { data: anniversaries } = useQuery<{ count: number; anniversaries: AnniversaryData[] }>({
    queryKey: ["/api/analytics/anniversaries"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/anniversaries?days=30");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });

  const { data: consistency } = useQuery<ConsistencyData>({
    queryKey: ["/api/analytics/consistency"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/consistency?days=14");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });

  const { data: compliance } = useQuery<ComplianceData>({
    queryKey: ["/api/analytics/schedule-compliance"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/schedule-compliance?days=7");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });

  const { data: suppressed } = useQuery<SuppressedData>({
    queryKey: ["/api/analytics/suppressed-sales", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/suppressed-sales?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: isToday ? 5 * 60 * 1000 : Infinity,
  });

  // Expensive panel data — only fetch once panel is expanded
  const { data: weeklyForecast } = useQuery<WeeklyForecastData>({
    queryKey: ["/api/analytics/weekly-forecast", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/weekly-forecast?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: expanded,
    staleTime: isToday ? 5 * 60 * 1000 : Infinity,
  });

  // Operator schedule for upcoming week
  const { data: operatorSchedule } = useQuery<OperatorScheduleData>({
    queryKey: ["/api/analytics/operator-schedule"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/operator-schedule");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: expanded,
    staleTime: 10 * 60 * 1000,
  });

  // Attachment rates (add-on upsell analysis)
  const { data: attachmentRates } = useQuery<AttachmentRateData>({
    queryKey: ["/api/pos/attachment-rates", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pos/attachment-rates?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: expanded,
    staleTime: isToday ? 5 * 60 * 1000 : Infinity,
  });

  const upcomingAnniversaries = anniversaries?.anniversaries?.filter(a => a.daysUntil <= 7) || [];
  const hasSuppressed = suppressed && suppressed.companyTotalSuppressed > 0;
  const avgCompliance = compliance?.restaurants.length
    ? Math.round(compliance.restaurants.reduce((sum, r) => sum + r.compliancePercent, 0) / compliance.restaurants.length)
    : null;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm font-semibold">Sandbox</CardTitle>

                {/* Quick summary badges — collapsed header shows consistency, schedule, suppressed */}
                {consistency && (
                  <BadgeWithTooltip
                    variant="outline"
                    className={`text-xs ${getConsistencyColor(consistency.companyAvgConsistency)}`}
                    tooltipContent={
                      <div className="space-y-1.5">
                        <div className={`font-semibold ${getConsistencyColor(consistency.companyAvgConsistency)}`}>
                          Company Consistency: {consistency.companyAvgConsistency}/100
                        </div>
                        <div className="text-muted-foreground leading-snug">
                          Measures 14-day hourly grade stability across all units. Lower variance and fewer D/F hours = higher score. Below 50 needs attention.
                        </div>
                        {consistency.restaurants.length > 0 && (
                          <div className="border-t border-border/50 pt-1 space-y-0.5">
                            <div className="font-medium text-[10px] text-muted-foreground">Lowest scoring units:</div>
                            {[...consistency.restaurants]
                              .sort((a, b) => a.consistencyScore - b.consistencyScore)
                              .slice(0, 3)
                              .map(r => (
                                <div key={r.restaurantId} className="flex justify-between gap-3">
                                  <span className="truncate">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                                  <span className={`font-semibold flex-shrink-0 ${getConsistencyColor(r.consistencyScore)}`}>
                                    {r.consistencyScore} · {r.dfPercent}% D/F
                                  </span>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    }
                    side="bottom"
                  >
                    CST: {consistency.companyAvgConsistency}
                  </BadgeWithTooltip>
                )}
                {avgCompliance !== null && (
                  <BadgeWithTooltip
                    variant="outline"
                    className={`text-xs ${getComplianceColor(avgCompliance)}`}
                    tooltipTitle={`Schedule Compliance: ${avgCompliance}%`}
                    tooltipDetail="7-day avg of actual vs. scheduled hours across all units. 90-110% is on target; below 90% = understaffed, above 110% = overstaffed."
                  >
                    <Clock className="w-3 h-3" />
                    SCH: {avgCompliance}%
                  </BadgeWithTooltip>
                )}
                {hasSuppressed && (
                  <BadgeWithTooltip
                    className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0"
                    tooltipContent={
                      <div className="space-y-1.5">
                        <div className="font-semibold text-red-600 dark:text-red-400">
                          {formatCurrency(suppressed!.companyTotalSuppressed)} Est. Lost Sales ({suppressed!.companyLostPercent}% of sales)
                        </div>
                        <div className="text-muted-foreground leading-snug">
                          Revenue left on the table when units are understaffed (actual labor 25%+ below scheduled) or drive-thru averages exceed 7 min during hours with $200+ in sales. Calculated as a % of last week's hourly sales.
                        </div>
                        {suppressed!.restaurants.length > 0 && (
                          <div className="border-t border-border/50 pt-1 space-y-0.5">
                            <div className="font-medium text-[10px] text-muted-foreground">Top contributors:</div>
                            {suppressed!.restaurants.slice(0, 3).map(r => (
                              <div key={r.restaurantId} className="flex justify-between gap-3">
                                <span className="truncate">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                                <span className="font-semibold text-red-600 dark:text-red-400 flex-shrink-0">{formatCurrency(r.estimatedLostSales)} ({r.lostPercent}%)</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    }
                    side="bottom"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {formatCurrency(suppressed!.companyTotalSuppressed)} · {suppressed!.companyLostPercent}%
                  </BadgeWithTooltip>
                )}
                {upcomingAnniversaries.length > 0 && (
                  <Badge variant="outline" className="text-xs text-purple-600 border-purple-300">
                    <Calendar className="w-3 h-3 mr-1" />
                    {upcomingAnniversaries.length} anniversary{upcomingAnniversaries.length !== 1 ? "ies" : ""} this week
                  </Badge>
                )}
              </div>
              {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">

            {/* Weekly Forecast */}
            {weeklyForecast && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  <BarChart3 className="w-3 h-3" /> WEEKLY FORECAST
                </h4>
                <p className="text-[10px] text-muted-foreground mb-2">Sat-Fri business week. Green = actual, amber = partial day, gray = projected from last week.</p>
                <div className="grid grid-cols-7 gap-1">
                  {weeklyForecast.daily.map(day => (
                    <div
                      key={day.date}
                      className={`text-center p-1.5 rounded text-xs ${
                        day.source === "actual" ? "bg-green-50 dark:bg-green-900/20" :
                        day.source === "partial" ? "bg-amber-50 dark:bg-amber-900/20" :
                        "bg-muted/30"
                      }`}
                    >
                      <div className="font-medium text-[10px] text-muted-foreground">{day.dayName.slice(0, 3)}</div>
                      <div className="font-semibold">{formatCompactCurrency(day.forecast)}</div>
                      {day.lastWeek > 0 && (() => {
                        // For the partial (current) day, use progress-matched LW sales
                        // so the % matches the Summary card's apples-to-apples comparison.
                        const compareLW = (day.source === "partial" && day.lastWeekAtThisPoint != null && day.lastWeekAtThisPoint > 0)
                          ? day.lastWeekAtThisPoint
                          : day.lastWeek;
                        const compareValue = day.source === "partial" ? day.actual : day.forecast;
                        const pct = ((compareValue - compareLW) / compareLW * 100);
                        return (
                          <div className={`text-[10px] ${pct >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(0)}%
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                  <span>Week Total: {formatCompactCurrency(weeklyForecast.forecastTotal)}</span>
                  <span className={weeklyForecast.variancePercent >= 0 ? "text-green-600" : "text-red-600"}>
                    vs LW: {weeklyForecast.variancePercent >= 0 ? "+" : ""}{weeklyForecast.variancePercent.toFixed(1)}%
                  </span>
                </div>
              </div>
            )}

            {/* Consistency + Schedule Compliance side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Consistency Metric */}
              {consistency && consistency.restaurants.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                    <Activity className="w-3 h-3" /> CONSISTENCY (14-DAY)
                  </h4>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    Score 0-100: how stable are hourly execution grades? 60% weight on low grade variance + 40% on low D/F rate. Green 75+, amber 50-74, red &lt;50.
                  </p>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 px-0.5">
                      <span>Restaurant</span>
                      <div className="flex items-center gap-2">
                        <span className="w-8 text-center">Score</span>
                        <span className="w-6 text-center">Avg</span>
                        <span className="w-14 text-right">D/F hrs</span>
                      </div>
                    </div>
                    {(showAllConsistency ? consistency.restaurants : consistency.restaurants.slice(0, 5)).map(r => (
                      <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                        <span className="truncate mr-2">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                        <div className="flex items-center gap-2">
                          <span className={`font-bold w-8 text-center ${getConsistencyColor(r.consistencyScore)}`}>
                            {r.consistencyScore}
                          </span>
                          <span className="text-muted-foreground text-[10px] w-6 text-center">
                            {r.avgGradeLabel}
                          </span>
                          <span className={`text-[10px] w-14 text-right ${r.dfPercent > 5 ? 'text-red-500' : r.dfPercent > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                            {r.dfPercent > 0 ? `${r.dfPercent}%` : '—'}
                          </span>
                        </div>
                      </div>
                    ))}
                    {consistency.restaurants.length > 5 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowAllConsistency(!showAllConsistency); }}
                        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline w-full text-center mt-1"
                      >
                        {showAllConsistency ? 'Show less' : `Show all ${consistency.restaurants.length} restaurants`}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Schedule Compliance */}
              {compliance && compliance.restaurants.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> SCHEDULE COMPLIANCE (7-DAY)
                  </h4>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    Labor hours deployed vs scheduled. 90-110% is on target (green). "No-shows" = time slots where attendance was 25%+ below schedule.
                  </p>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 px-0.5">
                      <span>Restaurant</span>
                      <div className="flex items-center gap-2">
                        <span className="w-12 text-center">Staff Fill</span>
                        <span className="w-12 text-center">Hrs</span>
                        <span className="w-16 text-right">No-shows</span>
                      </div>
                    </div>
                    {(showAllCompliance ? compliance.restaurants : compliance.restaurants.slice(0, 5)).map(r => (
                      <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                        <span className="truncate mr-2">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                        <div className="flex items-center gap-2">
                          <span className={`font-bold w-12 text-center ${getComplianceColor(r.compliancePercent)}`}>
                            {r.compliancePercent}%
                          </span>
                          <span className="text-muted-foreground text-[10px] w-12 text-center">
                            {r.actualHoursDeployed?.toLocaleString() ?? '—'}
                          </span>
                          {r.callInRate > 0 ? (
                            <span className="text-red-500 text-[10px] w-16 text-right" title={`${r.callInRate}% of time slots had attendance 25%+ below schedule`}>
                              {r.callInRate}% of hrs
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-[10px] w-16 text-right">—</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {compliance.restaurants.length > 5 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowAllCompliance(!showAllCompliance); }}
                        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline w-full text-center mt-1"
                      >
                        {showAllCompliance ? 'Show less' : `Show all ${compliance.restaurants.length} restaurants`}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Operator Schedule (Upcoming Week) */}
            {operatorSchedule && operatorSchedule.restaurants.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  <UserCheck className="w-3 h-3" /> OPERATOR SCHEDULE (UPCOMING WEEK)
                </h4>
                <p className="text-[10px] text-muted-foreground mb-2">
                  Shows when the operator is scheduled at each unit for the next 7 days. Hours shown in local time. Units with gaps appear first.
                </p>
                <div className="space-y-1">
                  {/* Day header row */}
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 px-0.5">
                    <span className="w-[100px]">Unit</span>
                    <div className="flex items-center gap-0.5 flex-1 justify-end">
                      {operatorSchedule.dayLabels.map(d => (
                        <span
                          key={d.date}
                          className={`w-[72px] text-center ${d.isToday ? 'font-bold text-foreground' : ''}`}
                        >
                          {d.dayName} {d.date.slice(5).replace('-', '/')}
                        </span>
                      ))}
                    </div>
                  </div>
                  {(showAllOperatorSchedule ? operatorSchedule.restaurants : operatorSchedule.restaurants.slice(0, 5)).map(r => (
                    <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                      <span className="truncate w-[100px] mr-1" title={r.restaurantName}>
                        {r.restaurantName.replace(/^\d+\s*-\s*/, '')}
                      </span>
                      <div className="flex items-center gap-0.5 flex-1 justify-end">
                        {r.days.map(d => {
                          const isToday = operatorSchedule.dayLabels.find(dl => dl.date === d.date)?.isToday;
                          if (d.hours.length === 0) {
                            return (
                              <span
                                key={d.date}
                                className={`w-[72px] text-center text-[10px] text-muted-foreground ${isToday ? 'bg-muted/50 rounded' : ''}`}
                              >
                                —
                              </span>
                            );
                          }
                          const formatHour = (h: number) => {
                            if (h === 0) return '12a';
                            if (h < 12) return `${h}a`;
                            if (h === 12) return '12p';
                            return `${h - 12}p`;
                          };
                          return (
                            <span
                              key={d.date}
                              className={`w-[72px] text-center text-[10px] font-medium text-green-600 dark:text-green-400 ${isToday ? 'bg-green-50 dark:bg-green-900/20 rounded' : ''}`}
                              title={`${d.hours.length}h: ${d.hours.map(formatHour).join(', ')}`}
                            >
                              {formatHour(d.startHour!)}-{formatHour(d.endHour! + 1)}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {operatorSchedule.restaurants.length > 5 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowAllOperatorSchedule(!showAllOperatorSchedule); }}
                      className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline w-full text-center mt-1"
                    >
                      {showAllOperatorSchedule ? 'Show less' : `Show all ${operatorSchedule.restaurants.length} units`}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Suppressed Sales */}
            {hasSuppressed && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> SUPPRESSED SALES — {formatCurrency(suppressed!.companyTotalSuppressed)} est. lost ({suppressed!.companyLostPercent}% of {formatCurrency(suppressed!.companyTotalSales)} sales)
                </h4>
                <p className="text-[10px] text-muted-foreground mb-2">
                  Estimated revenue lost when a unit is understaffed (actual labor 25%+ below scheduled) or drive-thru avg exceeds 7 min. Calculated as a % of last week's hourly sales.
                </p>
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 px-0.5">
                    <span>Restaurant</span>
                    <div className="flex items-center gap-2">
                      <span className="w-16 text-center">Est. Lost</span>
                      <span className="w-28 text-right">Cause</span>
                    </div>
                  </div>
                  {(showAllSuppressed ? suppressed!.restaurants : suppressed!.restaurants.slice(0, 5)).map(r => (
                    <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                      <span className="truncate mr-2">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-red-600 w-16 text-center">{formatCurrency(r.estimatedLostSales)} <span className="font-normal text-[10px]">({r.lostPercent}%)</span></span>
                        <span className="text-muted-foreground text-[10px] w-28 text-right">
                          {r.understaffedHours > 0 && `${r.understaffedHours}h understaffed`}
                          {r.understaffedHours > 0 && r.slowDtHours > 0 && " + "}
                          {r.slowDtHours > 0 && `${r.slowDtHours}h slow DT`}
                        </span>
                      </div>
                    </div>
                  ))}
                  {suppressed!.restaurants.length > 5 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowAllSuppressed(!showAllSuppressed); }}
                      className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline w-full text-center mt-1"
                    >
                      {showAllSuppressed ? 'Show less' : `Show all ${suppressed!.restaurants.length} restaurants`}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Attachment Rates (Upsell Analysis) */}
            {attachmentRates && Object.keys(attachmentRates.restaurants).length > 0 && (() => {
              const restaurants = Object.entries(attachmentRates.restaurants)
                .map(([id, data]) => ({ id, ...data }))
                .sort((a, b) => b.overallAttachScore - a.overallAttachScore);

              // Company averages per category
              const categoryAvgs: Record<string, { totalRate: number; count: number }> = {};
              for (const r of restaurants) {
                for (const [cat, data] of Object.entries(r.categories)) {
                  if (!categoryAvgs[cat]) categoryAvgs[cat] = { totalRate: 0, count: 0 };
                  categoryAvgs[cat].totalRate += data.attachRate;
                  categoryAvgs[cat].count++;
                }
              }

              const categories = Object.keys(attachmentRates.categoryLabels);
              const companyAvgScore = restaurants.length > 0
                ? Math.round(restaurants.reduce((s, r) => s + r.overallAttachScore, 0) / restaurants.length)
                : 0;

              return (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                    <ShoppingBag className="w-3 h-3" /> ATTACHMENT RATES (UPSELL ANALYSIS)
                    {attachmentRates?.source === "pos_detail" && (
                      <Badge variant="outline" className="text-[9px] text-green-600 border-green-300 ml-1 py-0 px-1">LIVE POS</Badge>
                    )}
                  </h4>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    {attachmentRates?.source === "pos_detail"
                      ? "Real add-on rates from POS order items. % of orders containing cheese, bacon, jalapeños, dipping sauces, or desserts. Score 100 = at benchmark."
                      : "Estimated add-on attachment rates per order. Score 100 = at benchmark."}
                  </p>

                  {/* Company-wide category averages */}
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 mb-3">
                    {categories.map(cat => {
                      const label = attachmentRates.categoryLabels[cat];
                      const avg = categoryAvgs[cat]
                        ? Math.round((categoryAvgs[cat].totalRate / categoryAvgs[cat].count) * 10) / 10
                        : 0;
                      const benchmark = attachmentRates.benchmarks[cat]?.benchmark || 0;
                      const vsTarget = avg - benchmark;
                      return (
                        <div key={cat} className="text-center p-1.5 rounded bg-muted/30">
                          <div className="text-[9px] font-medium text-muted-foreground truncate">{label}</div>
                          <div className={`text-sm font-bold ${vsTarget >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                            {avg.toFixed(1)}%
                          </div>
                          <div className="text-[8px] text-muted-foreground">target: {benchmark}%</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Per-restaurant breakdown */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 px-0.5">
                      <span>Restaurant</span>
                      <div className="flex items-center gap-1">
                        {categories.map(cat => (
                          <span key={cat} className="w-10 text-center truncate">{attachmentRates.categoryLabels[cat].slice(0, 5)}</span>
                        ))}
                        <span className="w-10 text-center">Score</span>
                      </div>
                    </div>
                    {(showAllAttachments ? restaurants : restaurants.slice(0, 5)).map(r => {
                      const displayName = (r.restaurantName || r.id).replace(/^\d+\s*-\s*/, '');
                      const catsAtTarget = categories.filter(cat => r.categories[cat]?.vsTarget >= 0).length;
                      return (
                        <div key={r.id} className="flex items-center justify-between text-xs">
                          <span className="flex items-center mr-2 max-w-[140px]">
                            <span className="truncate" title={r.restaurantName || r.id}>
                              {displayName}
                            </span>
                            {catsAtTarget >= 4 && (
                              <BadgeWithTooltip
                                tooltipTitle="The Closer"
                                tooltipDetail={`Hit ${catsAtTarget}/6 attachment rate targets today. Earned +${catsAtTarget} bonus points. The Closer badge is awarded when a unit meets or exceeds the target on 4 or more of the 6 upsell categories (cheese, bacon, jalapeños, dipping sauces, desserts, whatasize) — proving the team is closing the sale on every order.`}
                              >
                                <Badge variant="outline" className="text-[8px] ml-1 py-0 px-1 text-amber-600 border-amber-400 cursor-pointer shrink-0">
                                  🎯
                                </Badge>
                              </BadgeWithTooltip>
                            )}
                          </span>
                          <div className="flex items-center gap-1">
                            {categories.map(cat => {
                              const data = r.categories[cat];
                              if (!data) return <span key={cat} className="w-10 text-center text-muted-foreground">--</span>;
                              return (
                                <span
                                  key={cat}
                                  className={`w-10 text-center text-[10px] font-medium ${
                                    data.vsTarget >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'
                                  }`}
                                >
                                  {data.attachRate.toFixed(0)}%
                                </span>
                              );
                            })}
                            <span className={`w-10 text-center font-bold ${
                              r.overallAttachScore >= 100 ? 'text-green-600 dark:text-green-400' :
                              r.overallAttachScore >= 80 ? 'text-amber-600 dark:text-amber-400' :
                              'text-red-500'
                            }`}>
                              {r.overallAttachScore}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {restaurants.length > 5 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowAllAttachments(!showAllAttachments); }}
                        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline w-full text-center mt-1"
                      >
                        {showAllAttachments ? 'Show less' : `Show all ${restaurants.length} restaurants`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Anniversaries */}
            {anniversaries && anniversaries.count > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> UPCOMING ANNIVERSARIES ({anniversaries.count})
                </h4>
                <div className="space-y-1">
                  {anniversaries.anniversaries.slice(0, 8).map(a => (
                    <div key={a.employeeId} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 truncate mr-2">
                        <span className="font-medium">{a.name}</span>
                        <span className="text-muted-foreground text-[10px]">{a.position}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge variant="outline" className="text-[10px] text-purple-600 border-purple-300">
                          {a.yearsCompleted}yr
                        </Badge>
                        <span className="text-muted-foreground text-[10px]">
                          {a.daysUntil === 0 ? "Today!" : a.daysUntil === 1 ? "Tomorrow" : `${a.daysUntil}d`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
