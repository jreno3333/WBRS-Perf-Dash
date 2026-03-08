import { useState, memo } from "react";
// Card imports removed - using plain divs for cleaner styling
// Badge import removed - using inline styles
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { TrendingUp, TrendingDown, MapPin, GraduationCap, ThumbsUp, Timer, ChevronDown, ChevronUp, Receipt } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { formatCurrency, computeExecutionScore, scoreToGradeLabel } from "@/lib/grading";
import { useGradingConfig } from "@/hooks/use-grading-config";
import type { GradingConfigData } from "@shared/schema";

interface CrewSummary {
  avgScore: number;
  avgCrewCount: number;
  avgTenureMonths: number;
}

interface WeeklySalesData {
  currentWeekStart: string;
  currentWeekEnd: string;
  priorWeekStart: string;
  priorWeekEnd: string;
  daysInCurrentWeek: number;
  daysInPriorWeek: number;
  restaurants: Record<string, { currentWeek: number; priorWeek: number; eowForecast: number; priorWeekFull: number; daysInCurrentWeek: number }>;
}

interface CheckAverageData {
  totalOrders: number;
  totalSales: number;
  checkAverage: number;
  hourly: Record<number, { orders: number; sales: number; avg: number }>;
}

interface CheckAvgTrendData {
  daily: { date: string; orders: number; sales: number; avg: number }[];
  avg7d: number;
  trend: 'up' | 'down' | 'flat';
}

interface StateBreakdownProps {
  restaurants: RestaurantSales[];
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  crewSummary?: Record<string, CrewSummary>;
  weeklySalesData?: WeeklySalesData;
  checkAverageByRestaurant?: Record<string, CheckAverageData>;
  checkAvgTrendByRestaurant?: Record<string, CheckAvgTrendData>;
}

const scoreToGrade = scoreToGradeLabel;

function getExecutionGradeScore(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean = true,
  osatPercent: number | undefined = undefined,
  hasValidStaffing: boolean = true,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
  cfg?: GradingConfigData,
): number {
  return computeExecutionScore(salesVariancePct, speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, osatPercent, transactionVariancePct, hasComparableTransactions, cfg);
}

function calculateStateXScore(restaurantIds: string[], hourlyByRestaurant?: Record<string, HourlySalesData[]>, cfg?: GradingConfigData): { grade: string; hoursGraded: number } {
  const allScores: number[] = [];
  if (hourlyByRestaurant) {
    for (const restaurantId of restaurantIds) {
      const hours = hourlyByRestaurant[restaurantId];
      if (!hours) continue;
      for (const hour of hours) {
        if (!hour.todaySales && !hour.lastWeekSales) continue;
        const hasComparableSales = hour.lastWeekSales > 0;
        const salesVariancePct = hasComparableSales 
          ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
          : 0;
        const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
        const positions = hour.positionBreakdown || {};
        const operatorHrs = positions['_operatorScheduled'] || 0;
        const actualStaff = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHrs);
        const staffingDiff = actualStaff - staffing.total;
        const hasValidStaffing = (Number(hour.employeeCount) || 0) >= 1;
        const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
        const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
        const score = getExecutionGradeScore(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hour.osatPercent, hasValidStaffing, txnVar, hasCompTxn, cfg);
        if (score > 0) allScores.push(score);
      }
    }
  }
  const avgScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  return { grade: scoreToGrade(avgScore), hoursGraded: allScores.length };
}

const TENNESSEE_STORES = [
  "1680 - Powell",
  "1681 - Turkey Creek", 
  "1682 - Cumberland Avenue",
  "1679 - East Ridge",
  "1605 - Shallowford Village",
  "1729 - Sevierville"
];

function calculateStateCrewScore(restaurantIds: string[], crewSummary?: Record<string, CrewSummary>): { avgScore: number; avgTenureMonths: number; count: number } {
  if (!crewSummary) return { avgScore: 0, avgTenureMonths: 0, count: 0 };
  
  let totalScore = 0;
  let totalTenure = 0;
  let count = 0;
  
  for (const id of restaurantIds) {
    const crew = crewSummary[id];
    if (crew && crew.avgScore > 0) {
      totalScore += crew.avgScore;
      totalTenure += crew.avgTenureMonths;
      count++;
    }
  }
  
  return { 
    avgScore: count > 0 ? Math.round(totalScore / count) : 0,
    avgTenureMonths: count > 0 ? Math.round(totalTenure / count * 10) / 10 : 0,
    count 
  };
}

// Format tenure months for display
function formatTenure(months: number): string {
  if (months < 1) return "< 1 month";
  if (months < 12) return `${Math.round(months)} mo`;
  const years = Math.floor(months / 12);
  const remainingMonths = Math.round(months % 12);
  if (remainingMonths === 0) return `${years} yr`;
  return `${years}y ${remainingMonths}m`;
}

// Calculate aggregate OSAT for a group of restaurants
function calculateStateOsat(restaurants: RestaurantSales[]): { osatPercent: number | undefined; totalResponses: number } {
  let totalResponses = 0;
  let weightedSum = 0;
  
  for (const r of restaurants) {
    if (r.osat && r.osat.totalResponses > 0) {
      totalResponses += r.osat.totalResponses;
      weightedSum += r.osat.osatPercent * r.osat.totalResponses;
    }
  }
  
  return {
    osatPercent: totalResponses > 0 ? weightedSum / totalResponses : undefined,
    totalResponses
  };
}

function getOsatColor(percent: number): string {
  if (percent >= 85) return 'bg-green-500/10 text-green-500';
  if (percent >= 80) return 'bg-yellow-500/10 text-yellow-500';
  return 'bg-red-500/10 text-red-500';
}

function getSpeedColor(attainment: number): string {
  if (attainment >= 70) return 'bg-green-500/10 text-green-500';
  if (attainment >= 50) return 'bg-yellow-500/10 text-yellow-500';
  return 'bg-red-500/10 text-red-500';
}

function calculateStateCheckAvg(
  restaurantIds: string[],
  checkAverageByRestaurant?: Record<string, CheckAverageData>,
  checkAvgTrendByRestaurant?: Record<string, CheckAvgTrendData>
): { checkAvg: number; totalOrders: number; avg7d: number; trend: 'up' | 'down' | 'flat'; daily: { date: string; avg: number }[] } {
  let totalOrders = 0;
  let totalSales = 0;
  if (checkAverageByRestaurant) {
    for (const id of restaurantIds) {
      const ca = checkAverageByRestaurant[id];
      if (ca) {
        totalOrders += ca.totalOrders;
        totalSales += ca.totalSales;
      }
    }
  }
  const checkAvg = totalOrders > 0 ? totalSales / totalOrders : 0;

  const dailyMap: Record<string, { orders: number; sales: number }> = {};
  if (checkAvgTrendByRestaurant) {
    for (const id of restaurantIds) {
      const trend = checkAvgTrendByRestaurant[id];
      if (trend) {
        for (const d of trend.daily) {
          if (!dailyMap[d.date]) dailyMap[d.date] = { orders: 0, sales: 0 };
          dailyMap[d.date].orders += d.orders;
          dailyMap[d.date].sales += d.sales;
        }
      }
    }
  }
  const daily = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, avg: d.orders > 0 ? d.sales / d.orders : 0 }));

  let total7dOrders = 0;
  let total7dSales = 0;
  for (const d of Object.values(dailyMap)) {
    total7dOrders += d.orders;
    total7dSales += d.sales;
  }
  const avg7d = total7dOrders > 0 ? total7dSales / total7dOrders : 0;

  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (checkAvg > 0 && avg7d > 0) {
    const pctChange = ((checkAvg - avg7d) / avg7d) * 100;
    if (pctChange > 2) trend = 'up';
    else if (pctChange < -2) trend = 'down';
  }

  return { checkAvg, totalOrders, avg7d, trend, daily };
}

function calculateStateSpeed(stateRestaurants: RestaurantSales[]): { speedAttainment: number | undefined; totalCars: number; carsUnder6Min: number; storesWithData: number } {
  let totalCars = 0;
  let totalUnder6 = 0;
  let storesWithData = 0;

  for (const r of stateRestaurants) {
    const dt = (r as any).driveThru;
    if (dt && dt.carCount > 0) {
      totalCars += dt.carCount;
      totalUnder6 += dt.carsUnder6Min || 0;
      storesWithData++;
    }
  }

  return {
    speedAttainment: totalCars > 0 ? Math.round((totalUnder6 / totalCars) * 100) : undefined,
    totalCars,
    carsUnder6Min: totalUnder6,
    storesWithData,
  };
}

export const StateBreakdown = memo(function StateBreakdown({ restaurants, hourlyByRestaurant, crewSummary, weeklySalesData, checkAverageByRestaurant, checkAvgTrendByRestaurant }: StateBreakdownProps) {
  const gradingCfg = useGradingConfig();
  // formatCurrency is imported from @/lib/grading (module-level singleton)

  // Exclude training units from state breakdowns
  const activeRestaurants = restaurants.filter(r => r.status !== "training");
  const tennesseeRestaurants = activeRestaurants.filter(r => 
    TENNESSEE_STORES.some(name => r.restaurantName.includes(name.split(" - ")[1]))
  );
  const alabamaRestaurants = activeRestaurants.filter(r => 
    !TENNESSEE_STORES.some(name => r.restaurantName.includes(name.split(" - ")[1]))
  );

  // Use actualSales and actualLastWeekSales (all available hours) for display to match 7shifts
  const alabamaTodaySales = alabamaRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const alabamaLastWeekSales = alabamaRestaurants.reduce((sum, r) => sum + r.actualLastWeekSales, 0);
  const alabamaAheadCount = alabamaRestaurants.filter(r => r.actualSales >= r.actualLastWeekSales).length;
  const alabamaVariance = alabamaLastWeekSales > 0 
    ? ((alabamaTodaySales / alabamaLastWeekSales) - 1) * 100 
    : 0;

  const tennesseeTodaySales = tennesseeRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const tennesseeLastWeekSales = tennesseeRestaurants.reduce((sum, r) => sum + r.actualLastWeekSales, 0);
  const tennesseeAheadCount = tennesseeRestaurants.filter(r => r.actualSales >= r.actualLastWeekSales).length;
  const tennesseeVariance = tennesseeLastWeekSales > 0 
    ? ((tennesseeTodaySales / tennesseeLastWeekSales) - 1) * 100 
    : 0;

  // Calculate X-Scores for each state
  const alabamaXScore = calculateStateXScore(
    alabamaRestaurants.map(r => r.restaurantId),
    hourlyByRestaurant,
    gradingCfg
  );
  const tennesseeXScore = calculateStateXScore(
    tennesseeRestaurants.map(r => r.restaurantId),
    hourlyByRestaurant,
    gradingCfg
  );
  
  // Calculate crew scores for each state
  const alabamaCrewScore = calculateStateCrewScore(
    alabamaRestaurants.map(r => r.restaurantId),
    crewSummary
  );
  const tennesseeCrewScore = calculateStateCrewScore(
    tennesseeRestaurants.map(r => r.restaurantId),
    crewSummary
  );
  
  // Calculate OSAT for each state
  const alabamaOsat = calculateStateOsat(alabamaRestaurants);
  const tennesseeOsat = calculateStateOsat(tennesseeRestaurants);

  // Calculate speed attainment for each state
  const alabamaSpeed = calculateStateSpeed(alabamaRestaurants);
  const tennesseeSpeed = calculateStateSpeed(tennesseeRestaurants);

  // Calculate check average for each state
  const alabamaCheckAvg = calculateStateCheckAvg(
    alabamaRestaurants.map(r => r.restaurantId),
    checkAverageByRestaurant, checkAvgTrendByRestaurant
  );
  const tennesseeCheckAvg = calculateStateCheckAvg(
    tennesseeRestaurants.map(r => r.restaurantId),
    checkAverageByRestaurant, checkAvgTrendByRestaurant
  );

  const getGradeBadgeColor = (grade: string) => {
    if (grade.startsWith('A')) return 'text-green-500 bg-green-500/10 border-green-500/30';
    if (grade.startsWith('B')) return 'text-blue-500 bg-blue-500/10 border-blue-500/30';
    if (grade.startsWith('C')) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30';
    if (grade.startsWith('D')) return 'text-orange-500 bg-orange-500/10 border-orange-500/30';
    return 'text-red-500 bg-red-500/10 border-red-500/30';
  };

  const getCrewScoreColor = (score: number) => {
    if (score >= 75) return 'bg-green-500/10 text-green-500';
    if (score >= 50) return 'bg-amber-500/10 text-amber-500';
    return 'bg-red-500/10 text-red-500';
  };

  // Calculate weekly sales by state
  const calcWeekly = (stateRestaurants: RestaurantSales[]) => {
    let current = 0, prior = 0, eowForecast = 0, priorFull = 0;
    if (weeklySalesData?.restaurants) {
      for (const r of stateRestaurants) {
        const wk = weeklySalesData.restaurants[r.restaurantId];
        if (wk) {
          current += wk.currentWeek;
          prior += wk.priorWeek;
          eowForecast += wk.eowForecast;
          priorFull += wk.priorWeekFull;
        }
      }
    }
    return {
      current, prior, eowForecast, priorFull,
      variance: prior > 0 ? ((current / prior) - 1) * 100 : 0,
      eowVariance: priorFull > 0 ? ((eowForecast / priorFull) - 1) * 100 : 0,
    };
  };
  const alabamaWeekly = calcWeekly(alabamaRestaurants);
  const tennesseeWeekly = calcWeekly(tennesseeRestaurants);

  const states = [
    {
      name: "Alabama",
      abbr: "AL",
      todaySales: alabamaTodaySales,
      lastWeekSales: alabamaLastWeekSales,
      variance: alabamaVariance,
      aheadCount: alabamaAheadCount,
      totalCount: alabamaRestaurants.length,
      isAhead: alabamaVariance >= 0,
      xScore: alabamaXScore,
      crewScore: alabamaCrewScore,
      osat: alabamaOsat,
      speed: alabamaSpeed,
      weekly: alabamaWeekly,
      checkAvg: alabamaCheckAvg,
    },
    {
      name: "Tennessee",
      abbr: "TN",
      todaySales: tennesseeTodaySales,
      lastWeekSales: tennesseeLastWeekSales,
      variance: tennesseeVariance,
      aheadCount: tennesseeAheadCount,
      totalCount: tennesseeRestaurants.length,
      isAhead: tennesseeVariance >= 0,
      xScore: tennesseeXScore,
      crewScore: tennesseeCrewScore,
      osat: tennesseeOsat,
      speed: tennesseeSpeed,
      weekly: tennesseeWeekly,
      checkAvg: tennesseeCheckAvg,
    },
  ];

  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border/50 bg-card">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/20 transition-colors rounded-t-xl"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">States</span>
          {!isExpanded && states.map(state => (
            <span key={state.abbr} className="text-xs text-muted-foreground">
              {state.abbr}: <span className={`font-medium ${state.isAhead ? "text-green-500" : "text-red-500"}`}>{state.isAhead ? "+" : ""}{state.variance.toFixed(0)}%</span>
              {state.xScore.hoursGraded > 0 && (
                <span className={`ml-1 font-bold ${getGradeBadgeColor(state.xScore.grade).split(' ').filter(c => c.startsWith('text-')).join(' ')}`}>
                  {state.xScore.grade}
                </span>
              )}
            </span>
          ))}
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {isExpanded && (
        <div className="px-4 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {states.map((state) => (
              <div key={state.abbr} className="rounded-lg border border-border/40 p-4" data-testid={`card-state-${state.abbr.toLowerCase()}`}>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm truncate">{state.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {state.totalCount} stores
                      </span>
                    </div>
                    <span className={`text-xs font-medium shrink-0 ${state.isAhead ? "text-green-500" : "text-red-500"}`}>
                      {state.isAhead ? "+" : ""}{state.variance.toFixed(1)}%
                    </span>
                  </div>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xl font-semibold tabular-nums">{formatCurrency(state.todaySales)}</div>
                <div className="text-xs text-muted-foreground truncate">
                  vs {formatCurrency(state.lastWeekSales)} last week
                </div>
                {weeklySalesData && state.weekly.current > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">WTD:</span>
                      <span className="text-xs font-semibold">{formatCurrency(state.weekly.current)}</span>
                      {state.weekly.prior > 0 && (
                        <span className={`text-xs font-medium flex items-center gap-0.5 ${state.weekly.variance >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {state.weekly.variance >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          vs LW {state.weekly.variance >= 0 ? "+" : ""}{Math.round(state.weekly.variance)}%
                        </span>
                      )}
                    </div>
                    {state.weekly.eowForecast > state.weekly.current && (
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">EOW:</span>
                        <span className="text-xs font-semibold text-primary">{formatCurrency(state.weekly.eowForecast)}</span>
                        {state.weekly.priorFull > 0 && (
                          <span className={`text-xs font-medium flex items-center gap-0.5 ${state.weekly.eowVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
                            {state.weekly.eowVariance >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            vs LW {state.weekly.eowVariance >= 0 ? "+" : ""}{Math.round(state.weekly.eowVariance)}%
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-semibold">
                  {state.aheadCount}/{state.totalCount}
                </div>
                <div className="text-xs text-muted-foreground">ahead of LW</div>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap justify-end">
              {state.speed.speedAttainment !== undefined && (
                <BadgeWithTooltip
                  className={`${getSpeedColor(state.speed.speedAttainment)} border-0 gap-1`}
                  data-testid={`badge-speed-state-${state.abbr.toLowerCase()}`}
                  tooltipContent={
                    <div>
                      <div className="font-medium">Speed Attainment</div>
                      <div className="text-muted-foreground">{state.speed.carsUnder6Min}/{state.speed.totalCars} cars under 6 min</div>
                      <div className="text-muted-foreground">{state.speed.storesWithData} stores reporting</div>
                    </div>
                  }
                >
                  <Timer className="w-3 h-3" />
                  <span className="font-medium">{state.speed.speedAttainment}%</span>
                </BadgeWithTooltip>
              )}
              {state.osat.osatPercent !== undefined && (
                <BadgeWithTooltip
                  className={`${getOsatColor(state.osat.osatPercent)} border-0 gap-1`}
                  data-testid={`badge-osat-state-${state.abbr.toLowerCase()}`}
                  tooltipTitle="Customer Satisfaction"
                  tooltipDetail={`${state.osat.totalResponses} responses`}
                >
                  <ThumbsUp className="w-3 h-3" />
                  <span className="font-medium">{state.osat.osatPercent.toFixed(0)}%</span>
                </BadgeWithTooltip>
              )}
              {state.crewScore.count > 0 && (
                <BadgeWithTooltip
                  className={`${getCrewScoreColor(state.crewScore.avgScore)} border-0 gap-1`}
                  data-testid={`badge-crew-state-${state.abbr.toLowerCase()}`}
                  tooltipTitle="Crew Experience"
                  tooltipDetail={`Avg tenure: ${formatTenure(state.crewScore.avgTenureMonths)}`}
                >
                  <GraduationCap className="w-3 h-3" />
                  <span className="font-medium">{state.crewScore.avgScore}</span>
                </BadgeWithTooltip>
              )}
              {state.checkAvg.checkAvg > 0 && (
                <BadgeWithTooltip
                  className="bg-teal-500/10 text-teal-600 dark:text-teal-400 border-0 gap-1"
                  data-testid={`badge-checkavg-state-${state.abbr.toLowerCase()}`}
                  tooltipContent={
                    <div>
                      <div className="font-medium">Check Average</div>
                      <div className="text-muted-foreground">{state.checkAvg.totalOrders} orders today</div>
                      {state.checkAvg.avg7d > 0 && (
                        <div className="mt-1 pt-1 border-t border-border/50">
                          <div className="font-medium text-[10px] mb-0.5">7-Day Avg: ${state.checkAvg.avg7d.toFixed(2)}</div>
                          <div className="flex gap-1 flex-wrap">
                            {state.checkAvg.daily.map(d => (
                              <div key={d.date} className="text-center">
                                <div className="text-[8px] text-muted-foreground">{new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' })}</div>
                                <div className="text-[9px] font-medium">${d.avg.toFixed(0)}</div>
                              </div>
                            ))}
                          </div>
                          <div className={`text-[10px] mt-0.5 font-medium ${state.checkAvg.trend === 'up' ? 'text-green-600' : state.checkAvg.trend === 'down' ? 'text-red-500' : 'text-muted-foreground'}`}>
                            {state.checkAvg.trend === 'up' ? 'Trending Up' : state.checkAvg.trend === 'down' ? 'Trending Down' : 'Stable'}
                          </div>
                        </div>
                      )}
                    </div>
                  }
                >
                  <Receipt className="w-3 h-3" />
                  <span className="font-medium">${state.checkAvg.checkAvg.toFixed(2)}</span>
                  {state.checkAvg.trend !== 'flat' && (
                    state.checkAvg.trend === 'up'
                      ? <TrendingUp className="w-2.5 h-2.5 text-green-500" />
                      : <TrendingDown className="w-2.5 h-2.5 text-red-500" />
                  )}
                </BadgeWithTooltip>
              )}
              {state.xScore.hoursGraded > 0 && (
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center border shrink-0 ${getGradeBadgeColor(state.xScore.grade)}`}>
                  <span className="text-lg font-bold">{state.xScore.grade}</span>
                </div>
              )}
            </div>
          </div>
      ))}
          </div>
        </div>
      )}
    </div>
  );
});
