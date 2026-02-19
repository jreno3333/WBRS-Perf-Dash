import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Calendar, TrendingUp, TrendingDown, BarChart3, Users, AlertTriangle, Clock, Activity } from "lucide-react";
import { useState } from "react";

interface AnalyticsPanelProps {
  dateStr: string;
  isToday: boolean;
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
    callInRate: number;
    underHours: number;
    totalHours: number;
  }[];
}

interface SuppressedData {
  companyTotalSuppressed: number;
  restaurants: {
    restaurantId: string;
    restaurantName: string;
    estimatedLostSales: number;
    understaffedHours: number;
    slowDtHours: number;
  }[];
}

interface DemandCurveHour {
  hour: number;
  quarters: { label: string; orders: number; sales: number }[];
  totalOrders: number;
  totalSales: number;
  loadProfile: string;
}

interface DemandCurveData {
  restaurants: {
    restaurantId: string;
    restaurantName: string;
    hours: DemandCurveHour[];
  }[];
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);

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

export function AnalyticsPanel({ dateStr, isToday }: AnalyticsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const { data: anniversaries } = useQuery<{ count: number; anniversaries: AnniversaryData[] }>({
    queryKey: ["/api/analytics/anniversaries"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/anniversaries?days=30");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: weeklyForecast } = useQuery<WeeklyForecastData>({
    queryKey: ["/api/analytics/weekly-forecast", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/weekly-forecast?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: consistency } = useQuery<ConsistencyData>({
    queryKey: ["/api/analytics/consistency"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/consistency?days=14");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: compliance } = useQuery<ComplianceData>({
    queryKey: ["/api/analytics/schedule-compliance"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/schedule-compliance?days=7");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: suppressed } = useQuery<SuppressedData>({
    queryKey: ["/api/analytics/suppressed-sales", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/suppressed-sales?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: isToday,
  });

  const { data: demandCurves } = useQuery<DemandCurveData>({
    queryKey: ["/api/analytics/demand-curves", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/demand-curves?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const upcomingAnniversaries = anniversaries?.anniversaries?.filter(a => a.daysUntil <= 7) || [];
  const hasSuppressed = suppressed && suppressed.companyTotalSuppressed > 0;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm font-semibold">Analytics</CardTitle>

                {/* Quick summary badges */}
                {weeklyForecast && (
                  <BadgeWithTooltip
                    variant="outline"
                    className={`text-xs ${weeklyForecast.variancePercent >= 0 ? "text-green-600 border-green-300" : "text-red-600 border-red-300"}`}
                    tooltipTitle="Weekly Sales Forecast (Sat-Fri)"
                    tooltipDetail={`Projected week total: ${formatCurrency(weeklyForecast.forecastTotal)} vs last week: ${formatCurrency(weeklyForecast.lastWeekTotal)}. Based on actual days completed + LW remaining days.`}
                  >
                    WK {weeklyForecast.variancePercent >= 0 ? "+" : ""}{weeklyForecast.variancePercent.toFixed(1)}%
                  </BadgeWithTooltip>
                )}
                {consistency && (
                  <BadgeWithTooltip
                    variant="outline"
                    className={`text-xs ${getConsistencyColor(consistency.companyAvgConsistency)}`}
                    tooltipTitle="Company Consistency Score (0-100)"
                    tooltipDetail="Average consistency across all units. Measures 14-day hourly grade stability — lower variance and fewer D/F hours = higher score."
                  >
                    CST: {consistency.companyAvgConsistency}
                  </BadgeWithTooltip>
                )}
                {hasSuppressed && (
                  <BadgeWithTooltip
                    className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0"
                    tooltipTitle="Estimated Suppressed Sales"
                    tooltipDetail={`Est. ${formatCurrency(suppressed!.companyTotalSuppressed)} in lost revenue today due to understaffing or slow drive-thru service times.`}
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {formatCurrency(suppressed!.companyTotalSuppressed)}
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
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                  <BarChart3 className="w-3 h-3" /> WEEKLY FORECAST
                </h4>
                <div className="grid grid-cols-6 gap-1">
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
                      <div className="font-semibold">{formatCurrency(day.forecast)}</div>
                      {day.lastWeek > 0 && (
                        <div className={`text-[10px] ${day.forecast >= day.lastWeek ? "text-green-600" : "text-red-600"}`}>
                          {day.forecast >= day.lastWeek ? "+" : ""}{((day.forecast - day.lastWeek) / day.lastWeek * 100).toFixed(0)}%
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                  <span>Week Total: {formatCurrency(weeklyForecast.forecastTotal)}</span>
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
                  <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                    <Activity className="w-3 h-3" /> CONSISTENCY (14-DAY)
                  </h4>
                  <div className="space-y-1">
                    {consistency.restaurants.slice(0, 5).map(r => (
                      <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                        <span className="truncate mr-2">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                        <div className="flex items-center gap-2">
                          <span className={`font-bold ${getConsistencyColor(r.consistencyScore)}`}>
                            {r.consistencyScore}
                          </span>
                          <span className="text-muted-foreground text-[10px]">
                            {r.avgGradeLabel}
                          </span>
                          {r.dfPercent > 0 && (
                            <span className="text-red-500 text-[10px] w-14 text-right">
                              {r.dfPercent}% D/F
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    {consistency.restaurants.length > 5 && (
                      <div className="text-[10px] text-muted-foreground text-center">
                        +{consistency.restaurants.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Schedule Compliance */}
              {compliance && compliance.restaurants.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> SCHEDULE COMPLIANCE (7-DAY)
                  </h4>
                  <div className="space-y-1">
                    {compliance.restaurants.slice(0, 5).map(r => (
                      <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                        <span className="truncate mr-2">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                        <div className="flex items-center gap-2">
                          <span className={`font-bold ${getComplianceColor(r.compliancePercent)}`}>
                            {r.compliancePercent}%
                          </span>
                          {r.callInRate > 0 && (
                            <span className="text-red-500 text-[10px]">
                              {r.callInRate}% gap
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Suppressed Sales */}
            {hasSuppressed && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> SUPPRESSED SALES
                </h4>
                <div className="space-y-1">
                  {suppressed!.restaurants.slice(0, 5).map(r => (
                    <div key={r.restaurantId} className="flex items-center justify-between text-xs">
                      <span className="truncate mr-2">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-red-600">{formatCurrency(r.estimatedLostSales)}</span>
                        <span className="text-muted-foreground text-[10px]">
                          {r.understaffedHours > 0 && `${r.understaffedHours}h under`}
                          {r.understaffedHours > 0 && r.slowDtHours > 0 && " + "}
                          {r.slowDtHours > 0 && `${r.slowDtHours}h slow DT`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Demand Curves Summary */}
            {demandCurves && demandCurves.restaurants.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                  <BarChart3 className="w-3 h-3" /> DEMAND CURVES
                </h4>
                <div className="space-y-2">
                  {demandCurves.restaurants.slice(0, 3).map(r => {
                    const peakHours = r.hours
                      .filter(h => h.totalOrders > 0)
                      .sort((a, b) => b.totalOrders - a.totalOrders)
                      .slice(0, 3);
                    if (peakHours.length === 0) return null;

                    return (
                      <div key={r.restaurantId}>
                        <div className="text-xs font-medium mb-1">{r.restaurantName.replace(/^\d+\s*-\s*/, '')}</div>
                        <div className="flex gap-1">
                          {r.hours.filter(h => h.hour >= 6 && h.hour <= 22 && h.totalOrders > 0).map(h => {
                            const maxOrders = Math.max(...r.hours.map(x => x.totalOrders), 1);
                            const barHeight = Math.max(2, (h.totalOrders / maxOrders) * 24);
                            const loadColor = h.loadProfile === "front-loaded" ? "bg-blue-400" :
                              h.loadProfile === "back-loaded" ? "bg-orange-400" : "bg-green-400";

                            return (
                              <div key={h.hour} className="flex-1 flex flex-col items-center">
                                <div className="flex items-end h-6 w-full gap-px">
                                  {h.quarters.map((q, qi) => {
                                    const qHeight = h.totalOrders > 0 ? Math.max(1, (q.orders / h.totalOrders) * barHeight) : 0;
                                    return (
                                      <div
                                        key={qi}
                                        className={`flex-1 ${loadColor} rounded-t-[1px] opacity-${qi < 2 ? '90' : '60'}`}
                                        style={{ height: `${qHeight}px` }}
                                      />
                                    );
                                  })}
                                </div>
                                <span className="text-[8px] text-muted-foreground">{h.hour > 12 ? h.hour - 12 : h.hour}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex gap-3 mt-0.5">
                          <span className="text-[9px] text-muted-foreground flex items-center gap-1"><div className="w-2 h-2 bg-blue-400 rounded-sm" /> Front</span>
                          <span className="text-[9px] text-muted-foreground flex items-center gap-1"><div className="w-2 h-2 bg-green-400 rounded-sm" /> Balanced</span>
                          <span className="text-[9px] text-muted-foreground flex items-center gap-1"><div className="w-2 h-2 bg-orange-400 rounded-sm" /> Back</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
