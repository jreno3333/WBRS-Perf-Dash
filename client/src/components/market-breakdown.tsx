import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, GraduationCap, ThumbsUp, Timer } from "lucide-react";
import type { RestaurantSales, HourlySalesData, MarketWithRestaurants } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

interface CrewSummary {
  avgScore: number;
  avgCrewCount: number;
  avgTenureMonths: number;
}

interface MarketBreakdownProps {
  restaurants: RestaurantSales[];
  markets: MarketWithRestaurants[];
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  crewSummary?: Record<string, CrewSummary>;
}

const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 };

const scoreToGrade = (score: number): string => {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  return 'F';
};

function getExecutionGradeScore(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean = true,
  osatPercent: number | undefined = undefined,
  hasValidStaffing: boolean = true
): number {
  const components: { score: number; weight: number }[] = [];

  if (hasComparableSales) {
    components.push({ score: salesVariancePct >= -5 ? 100 : 50, weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ score: 100, weight: GRADE_WEIGHTS.sales });
  }

  if (speedAttainment !== undefined && speedAttainment >= 0) {
    let speedScore = 100;
    if (speedAttainment < 50) speedScore = 40;
    else if (speedAttainment < 70) speedScore = 70;
    components.push({ score: speedScore, weight: GRADE_WEIGHTS.speed });
  }

  if (osatPercent !== undefined && osatPercent > 0) {
    let osatScore = 100;
    if (osatPercent < 80) osatScore = 40;
    else if (osatPercent < 85) osatScore = 70;
    components.push({ score: osatScore, weight: GRADE_WEIGHTS.osat });
  }

  if (hasValidStaffing) {
    let staffingScore = 100;
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    if (staffingDiff > 1) staffingScore = 60;
    else if (staffingDiff < -1 && !isSalesSurge) staffingScore = 60;
    components.push({ score: staffingScore, weight: GRADE_WEIGHTS.staffing });
  }

  if (components.length === 0) return 0;
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  return components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;
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
  if (percent >= 85) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (percent >= 80) return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
}

function getSpeedColor(attainment: number): string {
  if (attainment >= 70) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (attainment >= 50) return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
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

export function MarketBreakdown({ restaurants, markets, hourlyByRestaurant, crewSummary }: MarketBreakdownProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

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
    };
  }).filter(m => m.totalCount > 0);

  const getGradeBadgeColor = (grade: string) => {
    if (grade.startsWith('A')) return 'text-green-600 dark:text-green-400 bg-green-500/20 border-green-500/50';
    if (grade.startsWith('B')) return 'text-blue-600 dark:text-blue-400 bg-blue-500/20 border-blue-500/50';
    if (grade.startsWith('C')) return 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/20 border-yellow-500/50';
    if (grade === 'D') return 'text-orange-600 dark:text-orange-400 bg-orange-500/20 border-orange-500/50';
    return 'text-red-600 dark:text-red-400 bg-red-500/20 border-red-500/50';
  };

  const getCrewScoreColor = (score: number) => {
    if (score >= 75) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    if (score >= 50) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  };

  if (marketStats.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {marketStats.map((market) => (
        <Card key={market.id} data-testid={`card-market-${market.id}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div 
                  className="w-3 h-3 rounded-full shrink-0" 
                  style={{ backgroundColor: market.color }}
                />
                <span className="font-semibold">{market.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {market.totalCount} stores
                </Badge>
              </div>
              {market.isAhead ? (
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">
                  <TrendingUp className="w-3.5 h-3.5 mr-1" />
                  +{market.variance.toFixed(1)}%
                </Badge>
              ) : (
                <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0">
                  <TrendingDown className="w-3.5 h-3.5 mr-1" />
                  {market.variance.toFixed(1)}%
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold">{formatCurrency(market.todaySales)}</div>
                <div className="text-xs text-muted-foreground">
                  vs {formatCurrency(market.lastWeekSales)} last week
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-lg font-semibold">
                    {market.aheadCount}/{market.totalCount}
                  </div>
                  <div className="text-xs text-muted-foreground">ahead of LW</div>
                </div>
                {market.speed.speedAttainment !== undefined && (
                  <div className="relative group">
                    <Badge 
                      className={`${getSpeedColor(market.speed.speedAttainment)} border-0 gap-1 cursor-help`}
                      data-testid={`badge-speed-market-${market.id}`}
                    >
                      <Timer className="w-3 h-3" />
                      <span className="font-medium">{market.speed.speedAttainment}%</span>
                    </Badge>
                    <div className="absolute -top-14 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Speed Attainment</div>
                      <div className="text-muted-foreground">{market.speed.carsUnder6Min}/{market.speed.totalCars} cars under 6 min</div>
                      <div className="text-muted-foreground">{market.speed.storesWithData} stores reporting</div>
                    </div>
                  </div>
                )}
                {market.osat.osatPercent !== undefined && (
                  <div className="relative group">
                    <Badge 
                      className={`${getOsatColor(market.osat.osatPercent)} border-0 gap-1 cursor-help`}
                      data-testid={`badge-osat-market-${market.id}`}
                    >
                      <ThumbsUp className="w-3 h-3" />
                      <span className="font-medium">{market.osat.osatPercent.toFixed(0)}%</span>
                    </Badge>
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Customer Satisfaction</div>
                      <div className="text-muted-foreground">{market.osat.totalResponses} responses</div>
                    </div>
                  </div>
                )}
                {market.crewScore.count > 0 && (
                  <div className="relative group">
                    <Badge 
                      className={`${getCrewScoreColor(market.crewScore.avgScore)} border-0 gap-1 cursor-help`}
                      data-testid={`badge-crew-market-${market.id}`}
                    >
                      <GraduationCap className="w-3 h-3" />
                      <span className="font-medium">{market.crewScore.avgScore}</span>
                    </Badge>
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Crew Experience</div>
                      <div className="text-muted-foreground">Avg tenure: {formatTenure(market.crewScore.avgTenureMonths)}</div>
                    </div>
                  </div>
                )}
                {market.xScore.hoursGraded > 0 && (
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${getGradeBadgeColor(market.xScore.grade)}`}>
                    <span className="text-lg font-bold">{market.xScore.grade}</span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
