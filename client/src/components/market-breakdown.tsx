import { useState, memo } from "react";
// Card/Badge imports removed - using plain divs
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { TrendingUp, TrendingDown, MapPin, GraduationCap, ThumbsUp, Timer, ChevronDown, ChevronUp } from "lucide-react";
import type { RestaurantSales, HourlySalesData, MarketWithRestaurants } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { formatCurrency, computeExecutionScore, scoreToGradeLabel } from "@/lib/grading";

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

interface MarketBreakdownProps {
  restaurants: RestaurantSales[];
  markets: MarketWithRestaurants[];
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  crewSummary?: Record<string, CrewSummary>;
  weeklySalesData?: WeeklySalesData;
}

const scoreToGrade = scoreToGradeLabel;

function getExecutionGradeScore(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean = true,
  osatPercent: number | undefined = undefined,
  hasValidStaffing: boolean = true
): number {
  return computeExecutionScore(salesVariancePct, speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, osatPercent);
}

function calculateMarketXScore(restaurantIds: string[], hourlyByRestaurant?: Record<string, HourlySalesData[]>): { grade: string; hoursGraded: number } {
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
        const score = getExecutionGradeScore(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, hour.osatPercent, hasValidStaffing);
        if (score > 0) allScores.push(score);
      }
    }
  }
  const avgScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  return { grade: scoreToGrade(avgScore), hoursGraded: allScores.length };
}

function calculateMarketCrewScore(restaurantIds: string[], crewSummary?: Record<string, CrewSummary>): { avgScore: number; avgTenureMonths: number; count: number } {
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

function formatTenure(months: number): string {
  if (months < 1) return "< 1 month";
  if (months < 12) return `${Math.round(months)} mo`;
  const years = Math.floor(months / 12);
  const remainingMonths = Math.round(months % 12);
  if (remainingMonths === 0) return `${years} yr`;
  return `${years}y ${remainingMonths}m`;
}

// Calculate aggregate OSAT for a group of restaurants
function calculateMarketOsat(marketRestaurants: RestaurantSales[]): { osatPercent: number | undefined; totalResponses: number } {
  let totalResponses = 0;
  let weightedSum = 0;
  
  for (const r of marketRestaurants) {
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

function calculateMarketSpeed(marketRestaurants: RestaurantSales[]): { speedAttainment: number | undefined; totalCars: number; carsUnder6Min: number; storesWithData: number } {
  let totalCars = 0;
  let totalUnder6 = 0;
  let storesWithData = 0;

  for (const r of marketRestaurants) {
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

export const MarketBreakdown = memo(function MarketBreakdown({ restaurants, markets, hourlyByRestaurant, crewSummary, weeklySalesData }: MarketBreakdownProps) {
  const activeRestaurants = restaurants.filter(r => r.status !== "training");

  const marketStats = markets.map(market => {
    const marketRestaurantIds = market.restaurantIds || [];
    const marketRestaurants = activeRestaurants.filter(r => marketRestaurantIds.includes(r.restaurantId));
    
    const todaySales = marketRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
    const lastWeekSales = marketRestaurants.reduce((sum, r) => sum + r.actualLastWeekSales, 0);
    const aheadCount = marketRestaurants.filter(r => r.actualSales >= r.actualLastWeekSales).length;
    const variance = lastWeekSales > 0 ? ((todaySales / lastWeekSales) - 1) * 100 : 0;
    
    const xScore = calculateMarketXScore(marketRestaurantIds, hourlyByRestaurant);
    const crewScore = calculateMarketCrewScore(marketRestaurantIds, crewSummary);
    const osat = calculateMarketOsat(marketRestaurants);
    const speed = calculateMarketSpeed(marketRestaurants);
    
    let weeklyCurrent = 0, weeklyPrior = 0, weeklyEowForecast = 0, weeklyPriorFull = 0;
    if (weeklySalesData?.restaurants) {
      for (const r of marketRestaurants) {
        const wk = weeklySalesData.restaurants[r.restaurantId];
        if (wk) {
          weeklyCurrent += wk.currentWeek;
          weeklyPrior += wk.priorWeek;
          weeklyEowForecast += wk.eowForecast;
          weeklyPriorFull += wk.priorWeekFull;
        }
      }
    }
    const weeklyVariance = weeklyPrior > 0 ? ((weeklyCurrent / weeklyPrior) - 1) * 100 : 0;
    const weeklyEowVariance = weeklyPriorFull > 0 ? ((weeklyEowForecast / weeklyPriorFull) - 1) * 100 : 0;

    return {
      id: market.id,
      name: market.name,
      color: market.color || "#6366f1",
      todaySales,
      lastWeekSales,
      variance,
      aheadCount,
      totalCount: marketRestaurants.length,
      isAhead: variance >= 0,
      xScore,
      crewScore,
      osat,
      speed,
      weekly: { current: weeklyCurrent, prior: weeklyPrior, variance: weeklyVariance, eowForecast: weeklyEowForecast, priorFull: weeklyPriorFull, eowVariance: weeklyEowVariance },
    };
  }).filter(m => m.totalCount > 0);

  const getGradeBadgeColor = (grade: string) => {
    if (grade.startsWith('A')) return 'text-green-500 bg-green-500/20 border-green-500/50';
    if (grade.startsWith('B')) return 'text-blue-500 bg-blue-500/20 border-blue-500/50';
    if (grade.startsWith('C')) return 'text-yellow-500 bg-yellow-500/20 border-yellow-500/50';
    if (grade === 'D') return 'text-orange-500 bg-orange-500/20 border-orange-500/50';
    return 'text-red-500 bg-red-500/20 border-red-500/50';
  };

  const getCrewScoreColor = (score: number) => {
    if (score >= 75) return 'bg-green-500/10 text-green-500';
    if (score >= 50) return 'bg-amber-500/10 text-amber-500';
    return 'bg-red-500/10 text-red-500';
  };

  const [isExpanded, setIsExpanded] = useState(false);

  if (marketStats.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/20 transition-colors rounded-t-xl"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"><span className="sm:hidden">Mrkts</span><span className="hidden sm:inline">Markets</span></span>
          {!isExpanded && marketStats.map(market => (
            <span key={market.id} className="text-xs text-muted-foreground">
              {market.name}: <span className={`font-medium ${market.isAhead ? "text-green-500" : "text-red-500"}`}>{market.isAhead ? "+" : ""}{market.variance.toFixed(0)}%</span>
              {market.xScore.hoursGraded > 0 && (
                <span className={`ml-1 font-bold ${getGradeBadgeColor(market.xScore.grade).split(' ').filter(c => c.startsWith('text-')).join(' ')}`}>
                  {market.xScore.grade}
                </span>
              )}
            </span>
          ))}
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {isExpanded && (
        <div className="px-4 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {marketStats.map((market) => (
              <div key={market.id} className="rounded-lg border border-border/40 p-4" data-testid={`card-market-${market.id}`}>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: market.color }}
                      />
                      <span className="font-medium text-sm truncate">{market.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {market.totalCount} stores
                      </span>
                    </div>
              <span className={`text-xs font-medium shrink-0 ${market.isAhead ? "text-green-500" : "text-red-500"}`}>
                {market.isAhead ? "+" : ""}{market.variance.toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xl font-semibold tabular-nums">{formatCurrency(market.todaySales)}</div>
                <div className="text-xs text-muted-foreground truncate">
                  vs {formatCurrency(market.lastWeekSales)} last week
                </div>
                {weeklySalesData && market.weekly.current > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">WTD:</span>
                      <span className="text-xs font-semibold">{formatCurrency(market.weekly.current)}</span>
                      {market.weekly.prior > 0 && (
                        <span className={`text-xs font-medium flex items-center gap-0.5 ${market.weekly.variance >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {market.weekly.variance >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          vs LW {market.weekly.variance >= 0 ? "+" : ""}{Math.round(market.weekly.variance)}%
                        </span>
                      )}
                    </div>
                    {market.weekly.eowForecast > market.weekly.current && (
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">EOW:</span>
                        <span className="text-xs font-semibold text-primary">{formatCurrency(market.weekly.eowForecast)}</span>
                        {market.weekly.priorFull > 0 && (
                          <span className={`text-xs font-medium flex items-center gap-0.5 ${market.weekly.eowVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
                            {market.weekly.eowVariance >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            vs LW {market.weekly.eowVariance >= 0 ? "+" : ""}{Math.round(market.weekly.eowVariance)}%
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-semibold">
                  {market.aheadCount}/{market.totalCount}
                </div>
                <div className="text-xs text-muted-foreground">ahead of LW</div>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap justify-end">
              {market.speed.speedAttainment !== undefined && (
                <BadgeWithTooltip
                  className={`${getSpeedColor(market.speed.speedAttainment)} border-0 gap-1`}
                  data-testid={`badge-speed-market-${market.id}`}
                  tooltipContent={
                    <div>
                      <div className="font-medium">Speed Attainment</div>
                      <div className="text-muted-foreground">{market.speed.carsUnder6Min}/{market.speed.totalCars} cars under 6 min</div>
                      <div className="text-muted-foreground">{market.speed.storesWithData} stores reporting</div>
                    </div>
                  }
                >
                  <Timer className="w-3 h-3" />
                  <span className="font-medium">{market.speed.speedAttainment}%</span>
                </BadgeWithTooltip>
              )}
              {market.osat.osatPercent !== undefined && (
                <BadgeWithTooltip
                  className={`${getOsatColor(market.osat.osatPercent)} border-0 gap-1`}
                  data-testid={`badge-osat-market-${market.id}`}
                  tooltipTitle="Customer Satisfaction"
                  tooltipDetail={`${market.osat.totalResponses} responses`}
                >
                  <ThumbsUp className="w-3 h-3" />
                  <span className="font-medium">{market.osat.osatPercent.toFixed(0)}%</span>
                </BadgeWithTooltip>
              )}
              {market.crewScore.count > 0 && (
                <BadgeWithTooltip
                  className={`${getCrewScoreColor(market.crewScore.avgScore)} border-0 gap-1`}
                  data-testid={`badge-crew-market-${market.id}`}
                  tooltipTitle="Crew Experience"
                  tooltipDetail={`Avg tenure: ${formatTenure(market.crewScore.avgTenureMonths)}`}
                >
                  <GraduationCap className="w-3 h-3" />
                  <span className="font-medium">{market.crewScore.avgScore}</span>
                </BadgeWithTooltip>
              )}
              {market.xScore.hoursGraded > 0 && (
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center border shrink-0 ${getGradeBadgeColor(market.xScore.grade)}`}>
                  <span className="text-lg font-bold">{market.xScore.grade}</span>
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
