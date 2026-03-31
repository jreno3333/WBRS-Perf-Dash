import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Calendar, BarChart3, AlertTriangle, Activity, ShoppingBag } from "lucide-react";
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
  const [showAllSuppressed, setShowAllSuppressed] = useState(false);
  const [showAllAttachments, setShowAllAttachments] = useState(false);

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

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm font-semibold">Sandbox</CardTitle>

                {attachmentRates && Object.keys(attachmentRates.restaurants).length > 0 && (() => {
                  const rList = Object.values(attachmentRates.restaurants);
                  const companyAvgUpsell = rList.length > 0
                    ? Math.round(rList.reduce((s, r) => s + r.overallAttachScore, 0) / rList.length)
                    : 0;
                  const upsellColor = companyAvgUpsell >= 90 ? "text-green-600 dark:text-green-400" : companyAvgUpsell >= 70 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400";
                  return (
                    <BadgeWithTooltip
                      variant="outline"
                      className={`text-xs ${upsellColor}`}
                      tooltipTitle={`Upsell Score: ${companyAvgUpsell}`}
                      tooltipDetail="Company avg composite upsell score based on attachment rates across all categories. 90+ green, 70-89 yellow, below 70 red."
                      side="bottom"
                    >
                      Upsell: {companyAvgUpsell}
                    </BadgeWithTooltip>
                  );
                })()}
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
                  <BarChart3 className="w-3 h-3" /> WEEKLY PROJECTED
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
                      ? "Real add-on rates from POS order items. % of orders containing cheese, bacon, jalapeños, dipping sauces, shakes & malts, or whatasize. Score 100 = at benchmark."
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
                          <span key={cat} className="w-12 text-center truncate">{attachmentRates.categoryLabels[cat].slice(0, 5)}</span>
                        ))}
                        <span className="w-10 text-center">Score</span>
                      </div>
                    </div>
                    {(showAllAttachments ? restaurants : restaurants.slice(0, 5)).map(r => {
                      const displayName = (r.restaurantName || r.id).replace(/^\d+\s*-\s*/, '');
                      const catsAtTarget = categories.filter(cat => {
                        const d = r.categories[cat];
                        return d && d.attachRate >= d.benchmark;
                      }).length;
                      return (
                        <div key={r.id} className="flex items-center justify-between text-xs">
                          {catsAtTarget >= 4 ? (
                            <Popover>
                              <PopoverTrigger asChild>
                                <span
                                  className="mr-2 max-w-[140px] truncate font-bold text-amber-600 dark:text-amber-400 cursor-pointer"
                                  title={r.restaurantName || r.id}
                                  data-testid={`text-attach-restaurant-${r.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  onPointerDown={(e) => e.stopPropagation()}
                                >
                                  {displayName}
                                </span>
                              </PopoverTrigger>
                              <PopoverContent side="top" className="w-auto max-w-[280px] p-2 text-xs">
                                <div className="font-medium">The Closer</div>
                                <div className="text-muted-foreground">{`Hit ${catsAtTarget}/6 attachment rate targets today. Earned +${catsAtTarget} bonus points. The Closer badge is awarded when a unit meets or exceeds the target on 4 or more of the 6 upsell categories (cheese, bacon, jalapeños, dipping sauces, shakes & malts, whatasize) — proving the team is closing the sale on every order.`}</div>
                              </PopoverContent>
                            </Popover>
                          ) : (
                            <span className="mr-2 max-w-[140px] truncate" title={r.restaurantName || r.id} data-testid={`text-attach-restaurant-${r.id}`}>
                              {displayName}
                            </span>
                          )}
                          <div className="flex items-center gap-1">
                            {categories.map(cat => {
                              const data = r.categories[cat];
                              if (!data) return <span key={cat} className="w-12 text-center text-muted-foreground">--</span>;
                              return (
                                <span
                                  key={cat}
                                  className={`w-12 text-center text-[10px] font-medium ${
                                    data.attachRate >= data.benchmark ? 'text-green-600 dark:text-green-400' : 'text-red-500'
                                  }`}
                                >
                                  {data.attachRate.toFixed(1)}%
                                </span>
                              );
                            })}
                            <span className={`w-10 text-center font-bold ${
                              r.overallAttachScore >= 90 ? 'text-green-600 dark:text-green-400' :
                              r.overallAttachScore >= 70 ? 'text-yellow-600 dark:text-yellow-400' :
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
