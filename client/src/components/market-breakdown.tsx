import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, MapPin, GraduationCap } from "lucide-react";
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

const gradeToScore = (grade: string): number => {
  const scores: Record<string, number> = { 'A+': 100, 'A': 90, 'B': 80, 'C': 70, 'D': 60, 'F': 50 };
  return scores[grade] || 0;
};

const scoreToGrade = (score: number): string => {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 75) return 'B';
  if (score >= 65) return 'C';
  if (score >= 55) return 'D';
  return 'F';
};

function getExecutionGrade(salesVariancePct: number, avgServiceTime: number | undefined, staffingDiff: number): string {
  const speed = !avgServiceTime ? 'GREEN' : avgServiceTime <= 300 ? 'GREEN' : avgServiceTime <= 420 ? 'YELLOW' : 'RED';
  const staffing = staffingDiff > 1 ? 'OVER' : staffingDiff < -1 ? 'UNDER' : 'PROPER';
  const salesStatus = salesVariancePct >= -5 ? 'UP' : 'DOWN';
  const scores: Record<string, string> = {
    'UP-GREEN-PROPER': 'A+', 'UP-GREEN-UNDER': 'A', 'UP-GREEN-OVER': 'B',
    'UP-YELLOW-PROPER': 'A', 'UP-YELLOW-UNDER': 'B', 'UP-YELLOW-OVER': 'C',
    'UP-RED-PROPER': 'B', 'UP-RED-UNDER': 'C', 'UP-RED-OVER': 'D',
    'DOWN-GREEN-PROPER': 'B', 'DOWN-GREEN-UNDER': 'C', 'DOWN-GREEN-OVER': 'D',
    'DOWN-YELLOW-PROPER': 'C', 'DOWN-YELLOW-UNDER': 'D', 'DOWN-YELLOW-OVER': 'F',
    'DOWN-RED-PROPER': 'D', 'DOWN-RED-UNDER': 'F', 'DOWN-RED-OVER': 'F',
  };
  return scores[`${salesStatus}-${speed}-${staffing}`] ?? 'C';
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
        const grade = getExecutionGrade(salesVariancePct, hour.avgServiceTime, staffingDiff);
        const score = gradeToScore(grade);
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
    const aheadCount = marketRestaurants.filter(r => r.isAheadOfPace).length;
    const variance = lastWeekSales > 0 ? ((todaySales / lastWeekSales) - 1) * 100 : 0;
    
    const xScore = calculateMarketXScore(marketRestaurantIds, hourlyByRestaurant);
    const crewScore = calculateMarketCrewScore(marketRestaurantIds, crewSummary);
    
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
    };
  }).filter(m => m.totalCount > 0);

  const getGradeColor = (grade: string) => {
    if (grade === 'A+' || grade === 'A') return 'text-green-600 dark:text-green-400 bg-green-500/20 border-green-500/50';
    if (grade === 'B') return 'text-blue-600 dark:text-blue-400 bg-blue-500/20 border-blue-500/50';
    if (grade === 'C') return 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/20 border-yellow-500/50';
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
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${getGradeColor(market.xScore.grade)}`}>
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
