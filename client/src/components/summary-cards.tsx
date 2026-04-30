import { memo, useMemo } from "react";
import { Info, TrendingUp, TrendingDown, Receipt, Gauge } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { formatCurrency, computeExecutionScore, scoreToGradeLabel, getGradeColor, getGradeBgColor, GRADE_WEIGHTS, computeDailyBonuses, BONUS_CAP, countAttachmentCategoriesAtTarget } from "@/lib/grading";
import { useGradingConfig } from "@/hooks/use-grading-config";
import type { GradingConfigData } from "@shared/schema";

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

interface SummaryCardsProps {
  restaurants: RestaurantSales[];
  lastUpdated: string;
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  yoyData?: Record<string, { priorNetSales: number; priorGuestCount: number; priorDate: string }>;
  weeklySalesData?: WeeklySalesData;
  checkAverageByRestaurant?: Record<string, CheckAverageData>;
  checkAvgTrendByRestaurant?: Record<string, CheckAvgTrendData>;
  attachmentRatesByRestaurant?: Record<string, { categories: Record<string, { attachRate: number }> }>;
  helperRewardsByRestaurant?: Record<string, number>;
}

function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean,
  osatPercent: number | undefined,
  hasValidStaffing: boolean,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
  cfg?: GradingConfigData,
  feedbackSpeedPercent?: number,
  feedbackSpeedResponses?: number,
): { grade: string; color: string; score: number; hasGrade: boolean; components: { name: string; score: number; weight: number }[] } {
  const score = computeExecutionScore(salesVariancePct, speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, osatPercent, transactionVariancePct, hasComparableTransactions, cfg, feedbackSpeedPercent, feedbackSpeedResponses);
  if (score === 0) {
    return { grade: '-', color: 'text-muted-foreground', score: 0, hasGrade: false, components: [] };
  }
  const grade = scoreToGradeLabel(score);
  return { grade, color: getGradeColor(grade), score, hasGrade: true, components: [] };
}

export const SummaryCards = memo(function SummaryCards({ restaurants, lastUpdated, hourlyByRestaurant, yoyData, weeklySalesData, checkAverageByRestaurant, checkAvgTrendByRestaurant, attachmentRatesByRestaurant, helperRewardsByRestaurant }: SummaryCardsProps) {
  const gradingCfg = useGradingConfig();
  // formatCurrency is imported from @/lib/grading (module-level singleton)

  const activeRestaurants = useMemo(() => restaurants.filter(r => r.status !== "training"), [restaurants]);
  
  // Include all active restaurants in forecast/projected totals (no 14-day exclusion).
  // New units without prior-week data contribute their actual sales to projections.
  const forecastEligible = activeRestaurants;

  const sssRestaurants = activeRestaurants.filter(r => {
    if (!r.openDate) return true;
    const openDate = new Date(r.openDate);
    const now = new Date();
    const monthsOpen = (now.getFullYear() - openDate.getFullYear()) * 12 + (now.getMonth() - openDate.getMonth());
    return monthsOpen > 24;
  });
  
  // Calculate OSAT totals from restaurant-level daily data (not hourly)
  // This ensures we count all surveys regardless of whether there's hourly sales data
  const dailyOsatTotals = activeRestaurants.reduce((acc, r) => {
    const osat = r.osat;
    if (osat && osat.totalResponses > 0) {
      acc.totalResponses += osat.totalResponses;
      acc.fiveStarCount += osat.fiveStarCount;
      acc.restaurantsWithOsat++;
    }
    return acc;
  }, { totalResponses: 0, fiveStarCount: 0, restaurantsWithOsat: 0 });
  const dailyOsatPercent = dailyOsatTotals.totalResponses > 0 
    ? (dailyOsatTotals.fiveStarCount / dailyOsatTotals.totalResponses) * 100 
    : 0;

  // Aggregate customer-feedback Speed using 5-star top-box methodology (matches OSAT).
  const dailyFeedbackSpeed = activeRestaurants.reduce(
    (acc, r) => {
      const fs = r.feedbackSpeed;
      if (fs && fs.responses > 0) {
        acc.fiveStar += fs.fiveStarCount;
        acc.responses += fs.responses;
      }
      return acc;
    },
    { fiveStar: 0, responses: 0 }
  );
  const dailyFeedbackSpeedPct = dailyFeedbackSpeed.responses > 0
    ? (dailyFeedbackSpeed.fiveStar / dailyFeedbackSpeed.responses) * 100
    : null;
  
  const totalTodaySales = activeRestaurants.reduce((sum, r) => sum + r.actualSales, 0);
  const totalLastWeekSales = forecastEligible.reduce((sum, r) => sum + r.actualLastWeekSales, 0);
  const totalForecastSales = forecastEligible.reduce((sum, r) => sum + r.forecastSales, 0);
  
  const totalLastWeekFullDay = forecastEligible.reduce((sum, r) => {
    return sum + (r.lastWeekFullDay ?? ((r.actualLastWeekSales || 0) + Math.max(0, (r.forecastSales || 0) - (r.actualSales || 0))));
  }, 0);
  const aheadOfPaceCount = forecastEligible.filter((r) => r.isAheadOfPace).length;
  
  // Calculate variance vs last week
  const lwVariance = totalLastWeekSales > 0 
    ? ((totalTodaySales / totalLastWeekSales) - 1) * 100 
    : 0;
  const lwDollarDiff = totalTodaySales - totalLastWeekSales;

  let weeklyCurrentTotal = 0;
  let weeklyPriorTotal = 0;
  let weeklyEowForecast = 0;
  let weeklyPriorWeekFull = 0;
  if (weeklySalesData?.restaurants) {
    for (const r of forecastEligible) {
      const wk = weeklySalesData.restaurants[r.restaurantId];
      if (wk) {
        weeklyCurrentTotal += wk.currentWeek;
        weeklyPriorTotal += wk.priorWeek;
        weeklyEowForecast += wk.eowForecast;
        weeklyPriorWeekFull += wk.priorWeekFull;
      }
    }
  }
  const weeklyVariance = weeklyPriorTotal > 0
    ? ((weeklyCurrentTotal / weeklyPriorTotal) - 1) * 100
    : 0;
  const weeklyDollarDiff = weeklyCurrentTotal - weeklyPriorTotal;
  const eowVariance = weeklyPriorWeekFull > 0
    ? ((weeklyEowForecast / weeklyPriorWeekFull) - 1) * 100
    : 0;

  // Memoize the O(n×24) grade computation — only reruns when hourly data or config changes
  const {
    scoresByHour,
    staffingProperPct,
    speedGreenPct,
    osatGoodPct,
    gradeCounts,
    dfHourCount,
    overallXScore,
    overallGrade,
    gradeColor,
    gradedHourCount,
  } = useMemo(() => {
    const allHourlyScores: number[] = [];
    const restaurantGrades: Record<string, string> = {};
    const restaurantAdjustedScores: number[] = [];
    const scoresByHour: Record<number, number[]> = {};

    let staffingProperCount = 0;
    let staffingOverCount = 0;
    let staffingUnderCount = 0;
    let speedGreenCount = 0;
    let speedYellowCount = 0;
    let speedRedCount = 0;
    let totalSpeedHours = 0;
    let totalStaffingHours = 0;
    let osatGoodCount = 0;
    let osatCautionCount = 0;
    let osatPoorCount = 0;
    let totalOsatHours = 0;
    let totalOsatResponses = 0;

    if (hourlyByRestaurant) {
      for (const [restaurantId, hours] of Object.entries(hourlyByRestaurant)) {
        const restaurant = activeRestaurants.find(r => r.restaurantId === restaurantId);
        if (!restaurant) continue;

        const localGradeCutoff = restaurant.localCurrentHour ?? restaurant.normalizedHour;

        const restaurantHourlyScores: number[] = [];
        let restTotalSales = 0;
        let restTotalLWSales = 0;
        let restTotalTxn = 0;
        let restTotalLWTxn = 0;
        let restOsatWeightedSum = 0;
        let restOsatResponses = 0;
        let restLastYearDailySales: number | undefined;
        for (const hour of hours) {
          if (hour.hour > localGradeCutoff) continue;
          if (!hour.todaySales || hour.todaySales === 0) continue;

          const hasComparableSales = hour.lastWeekSales > 0;
          const salesVariancePct = hasComparableSales
            ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100
            : 0;
          const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
          const positions = hour.positionBreakdown || {};
          const operatorHrs = positions['_operatorScheduled'] || 0;
          const rawEmployeeCount = Number(hour.employeeCount) || 0;
          const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
          const staffingDiff = actualStaff - staffing.total;
          const hasValidStaffing = rawEmployeeCount >= 1;

          if (hasValidStaffing) {
            totalStaffingHours++;
            if (Math.abs(staffingDiff) <= 1) {
              staffingProperCount++;
            } else if (staffingDiff > 1) {
              staffingOverCount++;
            } else {
              staffingUnderCount++;
            }
          }

          const speedAtt = hour.speedAttainment;
          if (speedAtt !== undefined && speedAtt >= 0) {
            totalSpeedHours++;
            if (speedAtt >= 70) {
              speedGreenCount++;
            } else if (speedAtt >= 50) {
              speedYellowCount++;
            } else {
              speedRedCount++;
            }
          }

          if (hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0) {
            totalOsatHours++;
            totalOsatResponses += hour.osatResponses;
            if (hour.osatPercent >= 85) {
              osatGoodCount++;
            } else if (hour.osatPercent >= 80) {
              osatCautionCount++;
            } else {
              osatPoorCount++;
            }
          }

          const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
          const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
          const fs = restaurant?.feedbackSpeed;
          const gradeScore = hour.gradeScore !== undefined && hour.gradeHasGrade
            ? hour.gradeScore
            : getExecutionGrade(salesVariancePct, hour.ootActive ? undefined : speedAtt, staffingDiff, hasComparableSales, hour.osatPercent, hasValidStaffing, txnVar, hasCompTxn, gradingCfg, fs?.responses ? fs.topBoxPercent : undefined, fs?.responses).score;
          const gradeInfo = { hasGrade: gradeScore > 0, score: gradeScore };
          if (gradeInfo.hasGrade) {
            if (gradeInfo.score > 0) {
              allHourlyScores.push(gradeInfo.score);
              restaurantHourlyScores.push(gradeInfo.score);
              if (!scoresByHour[hour.hour]) scoresByHour[hour.hour] = [];
              scoresByHour[hour.hour].push(gradeInfo.score);
            }
          }

          restTotalSales += hour.todaySales;
          restTotalLWSales += hour.lastWeekSales;
          restTotalTxn += (hour.transactionCount ?? 0);
          restTotalLWTxn += (hour.lastWeekTransactionCount ?? 0);
          if (hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0) {
            restOsatWeightedSum += hour.osatPercent * hour.osatResponses;
            restOsatResponses += hour.osatResponses;
          }
          if (hour.lastYearDailySales !== undefined && hour.lastYearDailySales > 0) {
            restLastYearDailySales = hour.lastYearDailySales;
          }
        }

        if (restaurantHourlyScores.length > 0) {
          const baseScore = restaurantHourlyScores.reduce((a, b) => a + b, 0) / restaurantHourlyScores.length;

          const dailySalesVar = restTotalLWSales > 0 ? ((restTotalSales - restTotalLWSales) / restTotalLWSales) * 100 : undefined;
          const dailyTxnVar = restTotalLWTxn > 0 ? ((restTotalTxn - restTotalLWTxn) / restTotalLWTxn) * 100 : undefined;
          const dailyOsatPct = restOsatResponses > 0 ? restOsatWeightedSum / restOsatResponses : undefined;
          const dailyYoyVar = restLastYearDailySales && restLastYearDailySales > 0
            ? ((restTotalSales - restLastYearDailySales) / restLastYearDailySales) * 100
            : undefined;

          const attachData = attachmentRatesByRestaurant?.[restaurantId];
          const attachCatsAtTarget = attachData ? countAttachmentCategoriesAtTarget(attachData.categories) : undefined;
          const bonusResult = computeDailyBonuses({
            dailyOsatPercent: dailyOsatPct,
            dailySurveyCount: restOsatResponses,
            dailySalesVariancePct: dailySalesVar,
            dailyTransactionVariancePct: dailyTxnVar,
            dailyYoySalesVariancePct: dailyYoyVar,
            attachmentCategoriesAtTarget: attachCatsAtTarget,
            hourlyScores: restaurantHourlyScores,
            helperRewardPoints: helperRewardsByRestaurant?.[restaurantId],
          });

          const adjustedScore = Math.min(baseScore + bonusResult.cappedBonus, 100);
          restaurantGrades[restaurantId] = scoreToGradeLabel(adjustedScore);
          restaurantAdjustedScores.push(adjustedScore);
        }
      }
    }

    const staffingProperPct = totalStaffingHours > 0 ? Math.round((staffingProperCount / totalStaffingHours) * 100) : 0;
    const speedGreenPct = totalSpeedHours > 0 ? Math.round((speedGreenCount / totalSpeedHours) * 100) : 0;
    const osatGoodPct = totalOsatHours > 0 ? Math.round((osatGoodCount / totalOsatHours) * 100) : 0;

    const gradeCounts = { 'A': 0, 'B': 0, 'C': 0, 'D': 0, 'F': 0 };
    Object.values(restaurantGrades).forEach(grade => {
      const family = grade.startsWith('A') ? 'A' : grade.startsWith('B') ? 'B' : grade.startsWith('C') ? 'C' : grade.startsWith('D') ? 'D' : 'F';
      gradeCounts[family as keyof typeof gradeCounts]++;
    });

    const dfHourCount = allHourlyScores.filter(s => s < 60).length;

    const overallXScore = restaurantAdjustedScores.length > 0
      ? restaurantAdjustedScores.reduce((a, b) => a + b, 0) / restaurantAdjustedScores.length
      : (allHourlyScores.length > 0 ? allHourlyScores.reduce((a, b) => a + b, 0) / allHourlyScores.length : 0);
    const overallGrade = scoreToGradeLabel(overallXScore);
    const gradeColor = getGradeColor(overallGrade);

    return { scoresByHour, staffingProperPct, speedGreenPct, osatGoodPct, gradeCounts, dfHourCount, overallXScore, overallGrade, gradeColor, gradedHourCount: allHourlyScores.length };
  }, [hourlyByRestaurant, activeRestaurants, gradingCfg, attachmentRatesByRestaurant, helperRewardsByRestaurant]);

  // Calculate projected daily: sum of all restaurant forecast sales
  // Each restaurant's forecastSales = actual + LW remaining hours (same methodology)
  // This gives us the total projected daily sales using consistent logic
  // Determine if day is complete by checking the normalized hour (23 = end of day)
  const maxNormalizedHour = activeRestaurants.length > 0 
    ? Math.max(...activeRestaurants.map(r => r.normalizedHour ?? -1))
    : -1;
  const isDayComplete = maxNormalizedHour >= 23;
  
  const projectedData = {
    projected: totalForecastSales,
    actualSoFar: totalTodaySales,
    remainingForecast: Math.max(0, totalForecastSales - totalTodaySales),
    isDayComplete
  };

  // Grade background color for the large display
  const gradeBgColor = getGradeBgColor(overallGrade);

  // Calculate company-wide check average and 7-day trend
  let companyCheckAvg = 0;
  let companyTotalOrders = 0;
  let companyTotalSales = 0;
  if (checkAverageByRestaurant) {
    for (const r of activeRestaurants) {
      const ca = checkAverageByRestaurant[r.restaurantId];
      if (ca) {
        companyTotalOrders += ca.totalOrders;
        companyTotalSales += ca.totalSales;
      }
    }
    companyCheckAvg = companyTotalOrders > 0 ? companyTotalSales / companyTotalOrders : 0;
  }

  // Calculate company-wide 7-day trend with daily breakdown
  let companyAvg7d = 0;
  let companyTrend: 'up' | 'down' | 'flat' = 'flat';
  let companyDailyAvgs: { date: string; avg: number }[] = [];
  if (checkAvgTrendByRestaurant) {
    const dailyMap: Record<string, { orders: number; sales: number }> = {};
    for (const r of activeRestaurants) {
      const trend = checkAvgTrendByRestaurant[r.restaurantId];
      if (trend) {
        for (const d of trend.daily) {
          if (!dailyMap[d.date]) dailyMap[d.date] = { orders: 0, sales: 0 };
          dailyMap[d.date].orders += d.orders;
          dailyMap[d.date].sales += d.sales;
        }
      }
    }
    companyDailyAvgs = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, avg: d.orders > 0 ? d.sales / d.orders : 0 }));

    let total7dOrders = 0;
    let total7dSales = 0;
    for (const d of Object.values(dailyMap)) {
      total7dOrders += d.orders;
      total7dSales += d.sales;
    }
    companyAvg7d = total7dOrders > 0 ? total7dSales / total7dOrders : 0;
    // Simple trend: compare company today vs 7d avg (2% threshold)
    if (companyCheckAvg > 0 && companyAvg7d > 0) {
      const pctChange = ((companyCheckAvg - companyAvg7d) / companyAvg7d) * 100;
      if (pctChange > 2) companyTrend = 'up';
      else if (pctChange < -2) companyTrend = 'down';
    }
  }

  // Calculate 3-hour execution trend
  const hoursWithScores = Object.keys(scoresByHour)
    .map(h => parseInt(h))
    .filter(h => scoresByHour[h].length > 0)
    .sort((a, b) => b - a); // Sort descending (most recent first)
  
  const last4Hours = hoursWithScores.slice(0, 4);
  const hourlyAvgScores = last4Hours.map(h => ({
    hour: h,
    avgScore: scoresByHour[h].reduce((a, b) => a + b, 0) / scoresByHour[h].length,
    grade: scoreToGradeLabel(scoresByHour[h].reduce((a, b) => a + b, 0) / scoresByHour[h].length)
  })).reverse(); // Reverse so oldest is first for trend display
  
  // Determine trend direction (compare first hour to last hour in the 3-hour window)
  let executionTrend: 'up' | 'down' | 'flat' | null = null;
  if (hourlyAvgScores.length >= 2) {
    const firstScore = hourlyAvgScores[0].avgScore;
    const lastScore = hourlyAvgScores[hourlyAvgScores.length - 1].avgScore;
    if (lastScore > firstScore + 2) executionTrend = 'up';
    else if (lastScore < firstScore - 2) executionTrend = 'down';
    else executionTrend = 'flat';
  }

  // Calculate 3-hour sales trend (company-wide hourly totals)
  const salesByHour: Record<number, { today: number; lastWeek: number }> = {};
  if (hourlyByRestaurant) {
    for (const [restaurantId, hours] of Object.entries(hourlyByRestaurant)) {
      const restaurant = activeRestaurants.find(r => r.restaurantId === restaurantId);
      if (!restaurant) continue;
      const localGradeCutoff = restaurant.localCurrentHour ?? restaurant.normalizedHour;
      
      for (const hour of hours) {
        if (hour.hour > localGradeCutoff) continue;
        if (!hour.todaySales || hour.todaySales === 0) continue;
        
        if (!salesByHour[hour.hour]) salesByHour[hour.hour] = { today: 0, lastWeek: 0 };
        salesByHour[hour.hour].today += hour.todaySales;
        salesByHour[hour.hour].lastWeek += hour.lastWeekSales;
      }
    }
  }
  
  const hoursWithSales = Object.keys(salesByHour)
    .map(h => parseInt(h))
    .filter(h => salesByHour[h].today > 0)
    .sort((a, b) => b - a);
  
  const last4SalesHours = hoursWithSales.slice(0, 4);
  const hourlySales = last4SalesHours.map(h => ({
    hour: h,
    today: salesByHour[h].today,
    lastWeek: salesByHour[h].lastWeek,
    diff: salesByHour[h].today - salesByHour[h].lastWeek
  })).reverse();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
      {/* Execution Score */}
      <div data-testid="card-summary-execution" className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Execution</p>
              <Popover>
                <PopoverTrigger asChild>
                  <Info className="w-3 h-3 text-muted-foreground/50 cursor-help" />
                </PopoverTrigger>
                <PopoverContent side="top" className="w-auto max-w-[200px] p-2 text-xs">
                  Overall grade based on sales vs LW, drive-thru speed, and staffing levels
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-2xl font-bold ${gradeColor}`} data-testid="text-execution-grade">
                {overallGrade}
              </span>
              <span className="text-xs text-muted-foreground">
                {gradedHourCount} hrs
              </span>
            </div>
            {dailyOsatTotals.totalResponses > 0 && (
              <p className={`text-xs mt-1 ${dailyOsatPercent >= 85 ? 'text-green-500' : dailyOsatPercent >= 80 ? 'text-yellow-500' : 'text-red-500'}`}>
                OSAT {Math.round(dailyOsatPercent)}%
                <span className="text-muted-foreground ml-1">({dailyOsatTotals.totalResponses})</span>
              </p>
            )}
            {dailyFeedbackSpeedPct !== null && (() => {
              const fsPct = dailyFeedbackSpeedPct;
              const colorCls = fsPct >= 90 ? 'text-green-500' : fsPct >= 80 ? 'text-amber-500' : 'text-red-500';
              return (
                <p
                  className={`text-xs mt-0.5 flex items-center gap-1 ${colorCls}`}
                  data-testid="text-execution-feedback-speed"
                >
                  <Gauge className="w-3 h-3" />
                  OSAT Speed {fsPct.toFixed(0)}%
                  <span className="text-muted-foreground ml-1">({dailyFeedbackSpeed.responses})</span>
                </p>
              );
            })()}
            {companyCheckAvg > 0 && (
              <div className="mt-1.5 pt-1.5 border-t border-border/30">
                <div className="flex items-center gap-1">
                  <Receipt className="w-3 h-3 text-teal-600 dark:text-teal-400" />
                  <span className="text-xs font-medium text-teal-600 dark:text-teal-400">
                    ${companyCheckAvg.toFixed(2)}
                  </span>
                  {companyTrend !== 'flat' && (
                    companyTrend === 'up'
                      ? <TrendingUp className="w-3 h-3 text-green-500" />
                      : <TrendingDown className="w-3 h-3 text-red-500" />
                  )}
                  {companyAvg7d > 0 && (
                    <span className="text-[10px] text-muted-foreground">7d: ${companyAvg7d.toFixed(2)}</span>
                  )}
                </div>
                {companyDailyAvgs.length >= 2 && (() => {
                  const avgs = companyDailyAvgs.map(d => d.avg).filter(a => a > 0);
                  if (avgs.length < 2) return null;
                  const min = Math.min(...avgs);
                  const max = Math.max(...avgs);
                  const range = max - min || 1;
                  const w = 100;
                  const h = 24;
                  const padding = 2;
                  const points = companyDailyAvgs
                    .filter(d => d.avg > 0)
                    .map((d, i, arr) => {
                      const x = padding + (i / (arr.length - 1)) * (w - padding * 2);
                      const y = h - padding - ((d.avg - min) / range) * (h - padding * 2);
                      return `${x},${y}`;
                    })
                    .join(' ');
                  const trendColor = companyTrend === 'up' ? '#22c55e' : companyTrend === 'down' ? '#ef4444' : '#6b7280';
                  return (
                    <div className="flex items-center gap-1.5 mt-1">
                      <svg width={w} height={h} className="shrink-0">
                        <polyline
                          points={points}
                          fill="none"
                          stroke={trendColor}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {companyDailyAvgs.filter(d => d.avg > 0).map((d, i, arr) => {
                          const x = padding + (i / (arr.length - 1)) * (w - padding * 2);
                          const y = h - padding - ((d.avg - min) / range) * (h - padding * 2);
                          return <circle key={d.date} cx={x} cy={y} r="1.5" fill={trendColor} />;
                        })}
                      </svg>
                      <div className="flex gap-0.5">
                        {companyDailyAvgs.filter(d => d.avg > 0).map(d => (
                          <div key={d.date} className="text-center">
                            <div className="text-[7px] text-muted-foreground leading-none">{new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' })}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1 justify-end max-w-[120px]">
            {gradeCounts['A'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-500">
                A:{gradeCounts['A']}
              </span>
            )}
            {gradeCounts['B'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-500">
                B:{gradeCounts['B']}
              </span>
            )}
            {gradeCounts['C'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-yellow-500/10 text-yellow-500">
                C:{gradeCounts['C']}
              </span>
            )}
            {gradeCounts['D'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-orange-500/10 text-orange-500">
                D:{gradeCounts['D']}
              </span>
            )}
            {gradeCounts['F'] > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-500/10 text-red-500">
                F:{gradeCounts['F']}
              </span>
            )}
            {dfHourCount > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 border border-red-500/30 cursor-help">
                    D/F Hrs <span className="font-bold">{dfHourCount}</span>
                  </span>
                </PopoverTrigger>
                <PopoverContent side="bottom" className="w-auto max-w-[220px] p-2 text-xs">
                  <p className="font-semibold text-red-500">{dfHourCount} hourly D/F grades today</p>
                  <p className="text-muted-foreground mt-1">Hours scoring below 55 across all restaurants — indicating poor execution (low sales vs LW, slow drive-thru, or staffing gaps).</p>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>

      {/* Total Sales Today */}
      <div data-testid="card-summary-sales" className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Sales</p>
        <div className="flex items-baseline gap-2 mt-1">
          <p className="text-2xl font-bold tabular-nums" data-testid="text-total-sales">
            {formatCurrency(totalTodaySales)}
          </p>
          <span className={`text-xs font-medium ${lwVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
            {lwVariance >= 0 ? "+" : ""}{lwVariance.toFixed(1)}%
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          vs LW {lwDollarDiff >= 0 ? "+" : ""}{formatCurrency(lwDollarDiff)}
        </p>
        {weeklySalesData && weeklyCurrentTotal > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40 space-y-0.5">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">WTD</span>
              <span className="font-semibold tabular-nums" data-testid="text-weekly-sales-total">
                {formatCurrency(weeklyCurrentTotal)}
              </span>
              {weeklyPriorTotal > 0 && (
                <span className={`font-medium ${weeklyVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {weeklyVariance >= 0 ? "+" : ""}{Math.round(weeklyVariance)}%
                </span>
              )}
            </div>
            {weeklyEowForecast > weeklyCurrentTotal && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">EOW</span>
                <span className="font-semibold tabular-nums text-primary" data-testid="text-eow-forecast-total">
                  {formatCurrency(weeklyEowForecast)}
                </span>
                {weeklyPriorWeekFull > 0 && (
                  <span className={`font-medium ${eowVariance >= 0 ? "text-green-500" : "text-red-500"}`} title={`vs prior full week ${formatCurrency(weeklyPriorWeekFull)}`}>
                    vs LW full {eowVariance >= 0 ? "+" : ""}{Math.round(eowVariance)}%
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Projected Daily Sales */}
      <div data-testid="card-summary-projected" className="rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Projected</p>
          <Popover>
            <PopoverTrigger asChild>
              <Info className="w-3 h-3 text-muted-foreground/50 cursor-help" />
            </PopoverTrigger>
            <PopoverContent side="top" className="w-auto max-w-[220px] p-2 text-xs">
              Today's sales plus remaining hours from last week
            </PopoverContent>
          </Popover>
        </div>
        {projectedData.isDayComplete ? (
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-2xl font-bold tabular-nums" data-testid="text-projected-daily">
              {formatCurrency(projectedData.actualSoFar)}
            </p>
            <span className={`text-xs font-medium ${totalLastWeekFullDay > 0 && projectedData.actualSoFar >= totalLastWeekFullDay ? "text-green-500" : "text-red-500"}`}>
              vs LW
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="text-2xl font-bold tabular-nums" data-testid="text-projected-daily">
                {formatCurrency(projectedData.projected)}
              </p>
              <span className={`text-xs font-medium ${totalLastWeekFullDay > 0 && projectedData.projected >= totalLastWeekFullDay ? "text-green-500" : "text-red-500"}`}>
                vs LW
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              {formatCurrency(projectedData.actualSoFar)} actual + {formatCurrency(projectedData.remainingForecast)} remaining
            </p>
          </>
        )}
        {yoyData && (() => {
          const sssWithYoY = sssRestaurants.filter(r => yoyData[r.restaurantId]?.priorNetSales > 0);
          const yoyTotalPrior = sssWithYoY.reduce((sum, r) => sum + (yoyData[r.restaurantId]?.priorNetSales || 0), 0);
          if (yoyTotalPrior > 0 && sssWithYoY.length > 0) {
            const projectedSSSTotal = sssWithYoY.reduce((sum, r) => sum + r.forecastSales, 0);
            const projectedYoYVariance = ((projectedSSSTotal - yoyTotalPrior) / yoyTotalPrior) * 100;
            const projYoYDiff = projectedSSSTotal - yoyTotalPrior;
            return (
              <p className={`text-xs font-medium mt-1.5 tabular-nums ${projectedYoYVariance >= 0 ? "text-blue-500" : "text-orange-500"}`} data-testid="text-yoy-projected-summary">
                Comp Store YoY {projectedYoYVariance >= 0 ? "+" : ""}{Math.round(projectedYoYVariance)}%
                <span className="text-muted-foreground ml-1">({projYoYDiff >= 0 ? "+" : ""}{formatCurrency(projYoYDiff)})</span>
                <span className="text-muted-foreground ml-1">({sssWithYoY.length} stores)</span>
              </p>
            );
          }
          return null;
        })()}
      </div>
    </div>
  );
});
