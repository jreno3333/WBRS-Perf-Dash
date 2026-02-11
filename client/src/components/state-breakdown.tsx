import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, MapPin, GraduationCap, ThumbsUp, Timer } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

interface CrewSummary {
  avgScore: number;
  avgCrewCount: number;
  avgTenureMonths: number;
}

interface StateBreakdownProps {
  restaurants: RestaurantSales[];
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  crewSummary?: Record<string, CrewSummary>;
}

// Grade scoring for X-Score calculation
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

// Sales within -5% still counts as "UP" for grading purposes
function getExecutionGrade(salesVariancePct: number, speedAttainment: number | undefined, staffingDiff: number): string {
  const speed = speedAttainment === undefined ? 'GREEN' : speedAttainment >= 70 ? 'GREEN' : speedAttainment >= 50 ? 'YELLOW' : 'RED';
  const staffing = staffingDiff > 1 ? 'OVER' : staffingDiff < -1 ? 'UNDER' : 'PROPER';
  // Allow 5% variance to still count as "UP"
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

function calculateStateXScore(restaurantIds: string[], hourlyByRestaurant?: Record<string, HourlySalesData[]>): { grade: string; hoursGraded: number } {
  const allScores: number[] = [];
  if (hourlyByRestaurant) {
    for (const restaurantId of restaurantIds) {
      const hours = hourlyByRestaurant[restaurantId];
      if (!hours) continue;
      for (const hour of hours) {
        // Include all hours with sales data
        if (!hour.todaySales && !hour.lastWeekSales) continue;
        const hasComparableSales = hour.lastWeekSales > 0;
        const salesVariancePct = hasComparableSales 
          ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
          : 0;
        const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
        // Exclude operator from labor hours (matching leaderboard card logic)
        const positions = hour.positionBreakdown || {};
        const operatorHrs = positions['_operatorScheduled'] || 0;
        const actualStaff = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHrs);
        const staffingDiff = actualStaff - staffing.total;
        const grade = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff);
        const score = gradeToScore(grade);
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
  if (percent >= 85) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (percent >= 80) return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
}

function getSpeedColor(attainment: number): string {
  if (attainment >= 70) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (attainment >= 50) return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
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

export function StateBreakdown({ restaurants, hourlyByRestaurant, crewSummary }: StateBreakdownProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

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
    hourlyByRestaurant
  );
  const tennesseeXScore = calculateStateXScore(
    tennesseeRestaurants.map(r => r.restaurantId),
    hourlyByRestaurant
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
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {states.map((state) => (
        <Card key={state.abbr} data-testid={`card-state-${state.abbr.toLowerCase()}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground" />
                <span className="font-semibold">{state.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {state.totalCount} stores
                </Badge>
              </div>
              {state.isAhead ? (
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">
                  <TrendingUp className="w-3.5 h-3.5 mr-1" />
                  +{state.variance.toFixed(1)}%
                </Badge>
              ) : (
                <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0">
                  <TrendingDown className="w-3.5 h-3.5 mr-1" />
                  {state.variance.toFixed(1)}%
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold">{formatCurrency(state.todaySales)}</div>
                <div className="text-xs text-muted-foreground">
                  vs {formatCurrency(state.lastWeekSales)} last week
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-lg font-semibold">
                    {state.aheadCount}/{state.totalCount}
                  </div>
                  <div className="text-xs text-muted-foreground">ahead of LW</div>
                </div>
                {state.speed.speedAttainment !== undefined && (
                  <div className="relative group">
                    <Badge 
                      className={`${getSpeedColor(state.speed.speedAttainment)} border-0 gap-1 cursor-help`}
                      data-testid={`badge-speed-state-${state.abbr.toLowerCase()}`}
                    >
                      <Timer className="w-3 h-3" />
                      <span className="font-medium">{state.speed.speedAttainment}%</span>
                    </Badge>
                    <div className="absolute -top-14 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Speed Attainment</div>
                      <div className="text-muted-foreground">{state.speed.carsUnder6Min}/{state.speed.totalCars} cars under 6 min</div>
                      <div className="text-muted-foreground">{state.speed.storesWithData} stores reporting</div>
                    </div>
                  </div>
                )}
                {state.osat.osatPercent !== undefined && (
                  <div className="relative group">
                    <Badge 
                      className={`${getOsatColor(state.osat.osatPercent)} border-0 gap-1 cursor-help`}
                      data-testid={`badge-osat-state-${state.abbr.toLowerCase()}`}
                    >
                      <ThumbsUp className="w-3 h-3" />
                      <span className="font-medium">{state.osat.osatPercent.toFixed(0)}%</span>
                    </Badge>
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Customer Satisfaction</div>
                      <div className="text-muted-foreground">{state.osat.totalResponses} responses</div>
                    </div>
                  </div>
                )}
                {state.crewScore.count > 0 && (
                  <div className="relative group">
                    <Badge 
                      className={`${getCrewScoreColor(state.crewScore.avgScore)} border-0 gap-1 cursor-help`}
                      data-testid={`badge-crew-state-${state.abbr.toLowerCase()}`}
                    >
                      <GraduationCap className="w-3 h-3" />
                      <span className="font-medium">{state.crewScore.avgScore}</span>
                    </Badge>
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover border shadow-md rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-20">
                      <div className="font-medium">Crew Experience</div>
                      <div className="text-muted-foreground">Avg tenure: {formatTenure(state.crewScore.avgTenureMonths)}</div>
                    </div>
                  </div>
                )}
                {state.xScore.hoursGraded > 0 && (
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${getGradeColor(state.xScore.grade)}`}>
                    <span className="text-lg font-bold">{state.xScore.grade}</span>
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
