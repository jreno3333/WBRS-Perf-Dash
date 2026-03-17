import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  Users,
  Clock,
  Target,
  ThumbsUp,
  FileText,
  Building2,
  MapPin,
  Globe,
  MessageSquare,
  AlertCircle,
  ArrowUpDown,
  Sun,
  Cloud,
  CloudRain,
  CloudSnow,
  CloudLightning,
  CloudFog,
  CloudDrizzle,
  GraduationCap,
  Sparkles,
  Trophy,
  Flame,
  Diamond,
  Zap,
  Star,
} from "lucide-react";
import type { LeaderboardData, HourlySalesData, MarketWithRestaurants, GradingConfigData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { formatCurrency, GRADE_WEIGHTS, computeExecutionScore, scoreToGradeLabel, getGradeColor, gradeToMidpoint, computeDailyBonuses, BONUS_CAP, countAttachmentCategoriesAtTarget } from "@/lib/grading";
import type { DailyBonusResult } from "@/lib/grading";
import { useGradingConfig } from "@/hooks/use-grading-config";
import { DAYPARTS } from "@/lib/dayparts";
import { UnitReportDialog } from "@/components/unit-report-dialog";

interface RestaurantNote {
  id: string;
  restaurantId: string;
  date: string;
  hour: number | null;
  note: string;
  author: string | null;
  category: string;
  createdAt: string;
}

interface DailySummaryProps {
  restaurants: LeaderboardData["restaurants"];
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  markets?: MarketWithRestaurants[];
  crewSummary?: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }>;
  isCollapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  selectedDate?: string;
  dateRange?: string[];
  expandUnitId?: string | null;
  onUnitExpanded?: () => void;
  notesByRestaurant?: Record<string, RestaurantNote[]>;
  attachmentRatesByRestaurant?: Record<string, { categories: Record<string, { attachRate: number }> }>;
  helperRewardsByRestaurant?: Record<string, number>;
}

// Tennessee stores are identified by name pattern
const TENNESSEE_STORES = [
  "1680 - Powell",
  "1681 - Turkey Creek", 
  "1682 - Cumberland Avenue",
  "1679 - East Ridge",
  "1605 - Shallowford Village",
  "1729 - Sevierville"
];

function getStateFromRestaurant(restaurantName: string): string {
  return TENNESSEE_STORES.some(store => restaurantName.includes(store.split(" - ")[1])) ? "Tennessee" : "Alabama";
}

interface HourlyLeader {
  firstName: string;
  position: string;
}

interface CategoryIssue {
  category: string;
  lowCount: number;
  totalCount: number;
  avgRating: number;
}

interface UnitInsight {
  restaurantId: string;
  restaurantName: string;
  state: string;
  marketId?: string;
  marketName?: string;
  totalSales: number;
  salesVariance: number;
  avgGrade: number;
  gradeLabel: string;
  gradeColor: string;
  leaders: string[];
  strengths: string[];
  concerns: string[];
  staffingIssues: { hour: number; type: "over" | "under"; diff: number; leaders: HourlyLeader[] }[];
  speedIssues: { hour: number; avgTime: number; leaders: HourlyLeader[] }[];
  osatIssues: { hour: number; osatPercent: number; responses: number; leaders: HourlyLeader[] }[];
  salesOutliers: { hour: number; variance: number; type: "above" | "below"; leaders: HourlyLeader[] }[];
  recommendation: string;
  osatPercent?: number;
  osatResponses?: number;
  surveyHours?: { hour: number; percent: number; responses: number; leaders: HourlyLeader[] }[];
  categoryIssues?: CategoryIssue[];
  weather?: {
    temp: number;
    highTemp?: number;
    lowTemp?: number;
    condition: string;
    humidity: number;
    windSpeed: number;
  } | null;
  crewScore?: number;
  crewTenureMonths?: number;
  crewAvgCount?: number;
  daypartGrades?: { id: string; label: string; shortLabel: string; grade: string; score: number; color: string }[];
  bonusResult?: DailyBonusResult;
  peakHourlySales?: number;
  peakHour?: number;
  hourlyRateTier?: { label: string; threshold: number; color: string } | null;
}

// getGradeLabel / GRADE_WEIGHTS imported from @/lib/grading

function analyzeUnit(
  restaurant: LeaderboardData["restaurants"][0],
  hourlyData: HourlySalesData[] | undefined,
  attachmentCategories?: Record<string, { attachRate: number }>,
  gradingCfg?: GradingConfigData,
  helperRewardPoints?: number,
): UnitInsight {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const staffingIssues: UnitInsight["staffingIssues"] = [];
  const speedIssues: UnitInsight["speedIssues"] = [];
  const osatIssues: UnitInsight["osatIssues"] = [];
  const salesOutliers: UnitInsight["salesOutliers"] = [];
  const surveyHours: UnitInsight["surveyHours"] = [];
  
  const totalSales = restaurant.actualSales || 0;
  const lastWeekSales = restaurant.lastWeekSales || 0;
  const salesVariance = lastWeekSales > 0 
    ? ((totalSales - lastWeekSales) / lastWeekSales) * 100 
    : 0;
  const state = getStateFromRestaurant(restaurant.restaurantName);
  
  // Analyze hourly data
  const hourlyScores: number[] = [];
  let understaffedHours = 0;
  let overstaffedHours = 0;
  let slowSpeedHours = 0;
  let aboveExpectationHours = 0;
  let belowExpectationHours = 0;
  let lowOsatHours = 0;
  let totalOsatResponses = 0;
  let osatSum = 0;
  let osatHoursWithData = 0;
  
  if (hourlyData && hourlyData.length > 0) {
    const completedHours = hourlyData.filter(h => h.todaySales > 0);
    
    for (const hour of completedHours) {
      const hasComparableSales = hour.lastWeekSales > 0;
      const hourVariance = hasComparableSales 
        ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
        : 0;
      
      // Staffing analysis - only count if we have valid staffing data (employee count >= 1)
      const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
      const positions = hour.positionBreakdown || {};
      const operatorHrs = positions['_operatorScheduled'] || 0;
      const rawEmployeeCount = Number(hour.employeeCount) || 0;
      const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
      const staffingDiff = actualStaff - staffing.total;
      const hasValidStaffing = rawEmployeeCount >= 1;
      
      // Extract leaders for this hour
      const hourLeaders: HourlyLeader[] = (hour.leaders as HourlyLeader[]) || [];
      
      // Only flag staffing issues if we have valid staffing data
      // SALES SURGE EXCEPTION: Don't count as understaffed if sales are 20%+ above last week
      // (recognizes unexpected rushes that couldn't have been anticipated)
      if (hasValidStaffing) {
        const isSalesSurge = hourVariance >= 20 || !hasComparableSales;
        
        if (staffingDiff > 1) {
          overstaffedHours++;
          staffingIssues.push({ hour: hour.hour, type: "over", diff: staffingDiff, leaders: hourLeaders });
        } else if (staffingDiff < -1 && !isSalesSurge) {
          understaffedHours++;
          staffingIssues.push({ hour: hour.hour, type: "under", diff: Math.abs(staffingDiff), leaders: hourLeaders });
        }
      }
      
      // Speed analysis - uses attainment (% of cars under 6 min)
      const hourSpeedAtt = hour.speedAttainment;
      const hasValidSpeed = hourSpeedAtt !== undefined && hourSpeedAtt >= 0;
      if (hasValidSpeed && hourSpeedAtt < 50) { // < 50% attainment
        slowSpeedHours++;
        speedIssues.push({ hour: hour.hour, avgTime: hourSpeedAtt, leaders: hourLeaders });
      }
      
      // OSAT analysis - only include if we have customer satisfaction data
      const hasValidOsat = hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0;
      if (hasValidOsat) {
        osatHoursWithData++;
        totalOsatResponses += hour.osatResponses!;
        osatSum += hour.osatPercent! * hour.osatResponses!;
        surveyHours!.push({ hour: hour.hour, percent: hour.osatPercent!, responses: hour.osatResponses!, leaders: hourLeaders });
        if (hour.osatPercent! < 80) { // Below 80% is poor
          lowOsatHours++;
          osatIssues.push({ hour: hour.hour, osatPercent: hour.osatPercent!, responses: hour.osatResponses!, leaders: hourLeaders });
        }
      }
      
      // Sales variance analysis
      if (hasComparableSales) {
        if (hourVariance >= 20) {
          aboveExpectationHours++;
          salesOutliers.push({ hour: hour.hour, variance: hourVariance, type: "above", leaders: hourLeaders });
        } else if (hourVariance <= -20) {
          belowExpectationHours++;
          salesOutliers.push({ hour: hour.hour, variance: hourVariance, type: "below", leaders: hourLeaders });
        }
      }
      
      // Calculate hourly grade score using shared scoring module
      const hasComparableTransactions = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
      const txnVariancePct = hasComparableTransactions
        ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100
        : undefined;
      const score = computeExecutionScore(hourVariance, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, txnVariancePct, hasComparableTransactions, gradingCfg);
      if (score > 0) {
        hourlyScores.push(score);
      }
    }
  }
  
  const baseScore = hourlyScores.length > 0
    ? hourlyScores.reduce((a, b) => a + b, 0) / hourlyScores.length
    : 0;

  // Compute daily bonuses
  const validHours = hourlyData ? hourlyData.filter(h => h.todaySales > 0) : [];
  const dailyTotalSales = validHours.reduce((s, h) => s + h.todaySales, 0);
  const dailyTotalLWSales = validHours.reduce((s, h) => s + h.lastWeekSales, 0);
  const dailySalesVar = dailyTotalLWSales > 0 ? ((dailyTotalSales - dailyTotalLWSales) / dailyTotalLWSales) * 100 : undefined;
  const dailyTotalTxn = validHours.reduce((s, h) => s + (h.transactionCount || 0), 0);
  const dailyTotalLWTxn = validHours.reduce((s, h) => s + (h.lastWeekTransactionCount || 0), 0);
  const dailyTxnVar = dailyTotalLWTxn > 0 ? ((dailyTotalTxn - dailyTotalLWTxn) / dailyTotalLWTxn) * 100 : undefined;
  const osatHoursForBonus = validHours.filter(h => h.osatPercent !== undefined && (h.osatResponses ?? 0) > 0);
  const dailyOsatResponses = osatHoursForBonus.reduce((s, h) => s + (h.osatResponses ?? 0), 0);
  const dailyOsatPct = dailyOsatResponses > 0 ? osatHoursForBonus.reduce((s, h) => s + (h.osatPercent ?? 0) * (h.osatResponses ?? 0), 0) / dailyOsatResponses : undefined;

  // YoY variance from historical_daily_sales (daily-level, same value on every hour record)
  const lastYearDaily = validHours[0]?.lastYearDailySales;
  const dailyYoySalesVar = lastYearDaily && lastYearDaily > 0
    ? ((dailyTotalSales - lastYearDaily) / lastYearDaily) * 100
    : undefined;

  const attachCatsAtTarget = attachmentCategories ? countAttachmentCategoriesAtTarget(attachmentCategories) : undefined;
  const bonusResult = computeDailyBonuses({
    dailyOsatPercent: dailyOsatPct,
    dailySurveyCount: dailyOsatResponses,
    dailySalesVariancePct: dailySalesVar,
    dailyTransactionVariancePct: dailyTxnVar,
    dailyYoySalesVariancePct: dailyYoySalesVar,
    attachmentCategoriesAtTarget: attachCatsAtTarget,
    hourlyScores: hourlyScores,
    helperRewardPoints,
  });

  // Apply bonus to get final daily grade (base avg + capped bonus, max 100)
  const avgGrade = baseScore > 0 ? Math.min(baseScore + bonusResult.cappedBonus, 100) : 0;
  const gradeLabel = scoreToGradeLabel(avgGrade);
  const gradeColor = getGradeColor(gradeLabel);

  // Generate strengths
  if (salesVariance >= 5) {
    strengths.push(`Sales up ${salesVariance.toFixed(1)}% vs last week`);
  }
  if (aboveExpectationHours >= 2) {
    strengths.push(`${aboveExpectationHours} hours with sales 20%+ above expectations`);
  }
  // Only show good speed if there's drive-thru data AND no slow hours
  const hasDriveThruData = hourlyData?.some(h => h.speedAttainment !== undefined);
  if (slowSpeedHours === 0 && hasDriveThruData) {
    strengths.push("Drive-thru speed attainment above 50% every hour");
  }
  if (understaffedHours === 0 && overstaffedHours === 0 && staffingIssues.length === 0) {
    strengths.push("Properly staffed throughout the day");
  }
  // Calculate weighted OSAT average
  const avgOsatPercent = totalOsatResponses > 0 ? osatSum / totalOsatResponses : undefined;
  if (osatHoursWithData > 0 && lowOsatHours === 0 && avgOsatPercent && avgOsatPercent >= 85) {
    strengths.push(`Strong customer satisfaction (${avgOsatPercent.toFixed(0)}% OSAT, ${totalOsatResponses} responses)`);
  }
  
  // Generate concerns
  if (salesVariance <= -10) {
    concerns.push(`Sales down ${Math.abs(salesVariance).toFixed(1)}% vs last week`);
  }
  if (understaffedHours >= 2) {
    const hours = staffingIssues.filter(s => s.type === "under").map(s => formatHour(s.hour)).join(", ");
    concerns.push(`Understaffed ${understaffedHours} hours (${hours})`);
  }
  if (overstaffedHours >= 2) {
    const hours = staffingIssues.filter(s => s.type === "over").map(s => formatHour(s.hour)).join(", ");
    concerns.push(`Overstaffed ${overstaffedHours} hours (${hours})`);
  }
  // Flag speed issues even if just 1 hour has slow SOS
  if (slowSpeedHours >= 1) {
    const worstSpeed = speedIssues.sort((a, b) => a.avgTime - b.avgTime)[0];
    const worstFormatted = worstSpeed ? `${Math.round(worstSpeed.avgTime)}%` : "";
    if (slowSpeedHours === 1) {
      concerns.push(`Low speed attainment at ${formatHour(worstSpeed?.hour || 0)} (${worstFormatted})`);
    } else {
      concerns.push(`Speed attainment below 50% for ${slowSpeedHours} hours (worst: ${worstFormatted})`);
    }
  }
  if (belowExpectationHours >= 2) {
    concerns.push(`${belowExpectationHours} hours with sales 20%+ below expectations`);
  }
  // Flag OSAT issues
  if (lowOsatHours >= 1 && osatIssues.length > 0) {
    const worstOsat = osatIssues.sort((a, b) => a.osatPercent - b.osatPercent)[0];
    if (lowOsatHours === 1) {
      concerns.push(`Low customer satisfaction at ${formatHour(worstOsat.hour)} (${worstOsat.osatPercent.toFixed(0)}% OSAT)`);
    } else {
      concerns.push(`Low OSAT for ${lowOsatHours} hours (worst: ${worstOsat.osatPercent.toFixed(0)}% at ${formatHour(worstOsat.hour)})`);
    }
  }
  
  // Generate recommendation
  let recommendation = "";
  if (understaffedHours > overstaffedHours && understaffedHours >= 2) {
    const peakUnder = staffingIssues.filter(s => s.type === "under").sort((a, b) => b.diff - a.diff)[0];
    recommendation = `Review staffing during ${formatHour(peakUnder?.hour || 12)} - consistently understaffed. Consider adjusting schedule.`;
  } else if (overstaffedHours > understaffedHours && overstaffedHours >= 2) {
    const peakOver = staffingIssues.filter(s => s.type === "over").sort((a, b) => b.diff - a.diff)[0];
    recommendation = `Review staffing during ${formatHour(peakOver?.hour || 14)} - labor running high. Optimize scheduling.`;
  } else if (slowSpeedHours >= 2) {
    recommendation = "Focus on drive-thru efficiency. Consider cross-training and positioning adjustments.";
  } else if (lowOsatHours >= 2) {
    recommendation = "Customer satisfaction needs attention. Review order accuracy, service speed, and team friendliness.";
  } else if (salesVariance <= -10) {
    recommendation = "Sales trending down. Review local marketing, check for competitor activity, and ensure full menu availability.";
  } else if (strengths.length > concerns.length) {
    recommendation = "Strong performance today. Maintain current operations and recognize the team.";
  } else {
    recommendation = "Balanced day. Continue monitoring key metrics and address any emerging patterns.";
  }
  
  // Extract leaders from position breakdown
  const leaders: string[] = [];
  if (hourlyData) {
    for (const hour of hourlyData) {
      const positions = hour.positionBreakdown || {};
      for (const [key, value] of Object.entries(positions)) {
        if (key.includes("Manager") || key.includes("Supervisor")) {
          if (typeof value === "string" && !leaders.includes(value)) {
            leaders.push(value);
          }
        }
      }
    }
  }
  
  // Calculate daypart grades from hourly data
  const daypartGrades: UnitInsight["daypartGrades"] = [];
  if (hourlyData && hourlyData.length > 0) {
    const completedHours = hourlyData.filter(h => h.todaySales > 0);
    for (const dp of DAYPARTS) {
      const dpHours = completedHours.filter(h => h.hour >= dp.startHour && h.hour <= dp.endHour);
      const dpScores = dpHours.map(hour => {
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
        const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
        const txnVar = hasCompTxn
          ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100
          : undefined;
        const score = computeExecutionScore(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, txnVar, hasCompTxn, gradingCfg);
        return score > 0 ? gradeToMidpoint(scoreToGradeLabel(score)) : 0;
      }).filter(s => s > 0);

      if (dpScores.length > 0) {
        const avg = dpScores.reduce((a, b) => a + b, 0) / dpScores.length;
        const grade = scoreToGradeLabel(avg);
        daypartGrades.push({
          id: dp.id,
          label: dp.label,
          shortLabel: dp.shortLabel,
          grade,
          score: avg,
          color: getGradeColor(grade),
        });
      }
    }
  }

  // Compute peak hourly sales for rate badge
  const RATE_TIERS = [
    { threshold: 2300, label: "LEGENDARY", color: "text-yellow-500 border-yellow-500/30 bg-yellow-500/10" },
    { threshold: 2000, label: "ULTRA", color: "text-purple-500 border-purple-500/30 bg-purple-500/10" },
    { threshold: 1500, label: "ELITE", color: "text-orange-500 border-orange-500/30 bg-orange-500/10" },
    { threshold: 1000, label: "PRO", color: "text-blue-500 border-blue-500/30 bg-blue-500/10" },
    { threshold: 750, label: "CONTENDER", color: "text-emerald-500 border-emerald-500/30 bg-emerald-500/10" },
  ];
  let peakHourlySales = 0;
  let peakHour = 0;
  if (hourlyData) {
    for (const h of hourlyData) {
      if (h.todaySales > peakHourlySales) {
        peakHourlySales = h.todaySales;
        peakHour = h.hour;
      }
    }
  }
  const rateTier = RATE_TIERS.find(t => peakHourlySales >= t.threshold) || null;

  // Add peak hour achievement to strengths
  if (rateTier) {
    strengths.unshift(`${rateTier.label} hour: $${peakHourlySales.toLocaleString(undefined, { maximumFractionDigits: 0 })}/hr at ${formatHour(peakHour)}`);
  }

  return {
    restaurantId: restaurant.restaurantId,
    restaurantName: restaurant.restaurantName,
    state,
    marketId: undefined,
    marketName: undefined,
    totalSales,
    salesVariance,
    avgGrade,
    gradeLabel,
    gradeColor,
    leaders,
    strengths,
    concerns,
    staffingIssues,
    speedIssues,
    osatIssues,
    salesOutliers,
    recommendation,
    osatPercent: avgOsatPercent,
    osatResponses: totalOsatResponses > 0 ? totalOsatResponses : undefined,
    surveyHours: surveyHours.length > 0 ? surveyHours : undefined,
    weather: restaurant.weather,
    daypartGrades: daypartGrades.length > 0 ? daypartGrades : undefined,
    bonusResult,
    peakHourlySales: peakHourlySales > 0 ? peakHourlySales : undefined,
    peakHour: peakHourlySales > 0 ? peakHour : undefined,
    hourlyRateTier: rateTier,
  };
}

function formatHour(hour: number): string {
  if (hour === 0) return "12AM";
  if (hour === 12) return "12PM";
  if (hour < 12) return `${hour}AM`;
  return `${hour - 12}PM`;
}

function WeatherIcon({ condition }: { condition: string }) {
  const iconClass = "w-3.5 h-3.5";
  switch (condition.toLowerCase()) {
    case "clear": return <Sun className={iconClass} />;
    case "partly cloudy": return <Cloud className={iconClass} />;
    case "foggy": return <CloudFog className={iconClass} />;
    case "rain": return <CloudRain className={iconClass} />;
    case "showers": return <CloudDrizzle className={iconClass} />;
    case "snow": return <CloudSnow className={iconClass} />;
    case "thunderstorm": return <CloudLightning className={iconClass} />;
    default: return <Sun className={iconClass} />;
  }
}

function formatTenure(months: number): string {
  if (months < 1) return '<1mo';
  const years = Math.floor(months / 12);
  const remainingMonths = Math.round(months % 12);
  if (years === 0) return `${remainingMonths}mo`;
  if (remainingMonths === 0) return `${years}yr`;
  return `${years}yr ${remainingMonths}mo`;
}

// formatCurrency is imported from @/lib/grading (module-level singleton)

interface AggregatedSummary {
  name: string;
  unitCount: number;
  totalSales: number;
  avgVariance: number;
  avgGrade: number;
  gradeLabel: string;
  gradeColor: string;
  understaffedUnits: number;
  overstaffedUnits: number;
  slowSpeedUnits: number;
  lowOsatUnits: number;
  unitsAboveExpectation: number;
  unitsBelowExpectation: number;
  topStrength: string;
  topConcern: string;
  recommendation: string;
  avgOsatPercent?: number;
  totalOsatResponses?: number;
  avgSpeedAttainment?: number;
  totalDTCars?: number;
  dtStoresReporting?: number;
}

function aggregateInsights(insights: UnitInsight[], name: string, groupRestaurants?: RestaurantSales[]): AggregatedSummary {
  const unitCount = insights.length;
  const totalSales = insights.reduce((sum, i) => sum + i.totalSales, 0);
  const avgVariance = insights.reduce((sum, i) => sum + i.salesVariance, 0) / unitCount;
  const avgGrade = insights.reduce((sum, i) => sum + i.avgGrade, 0) / unitCount;
  const gradeLabel = scoreToGradeLabel(avgGrade);
  const gradeColor = getGradeColor(gradeLabel);
  
  const understaffedUnits = insights.filter(i => i.staffingIssues.filter(s => s.type === "under").length >= 2).length;
  const overstaffedUnits = insights.filter(i => i.staffingIssues.filter(s => s.type === "over").length >= 2).length;
  const slowSpeedUnits = insights.filter(i => i.speedIssues.length >= 2).length;
  const lowOsatUnits = insights.filter(i => i.osatIssues && i.osatIssues.length >= 1).length;
  const unitsAboveExpectation = insights.filter(i => i.salesVariance >= 5).length;
  const unitsBelowExpectation = insights.filter(i => i.salesVariance <= -5).length;
  
  // Calculate aggregate OSAT metrics (weighted by responses)
  const unitsWithOsat = insights.filter(i => i.osatResponses && i.osatResponses > 0);
  const totalOsatResponses = unitsWithOsat.reduce((sum, i) => sum + (i.osatResponses || 0), 0);
  const avgOsatPercent = totalOsatResponses > 0
    ? unitsWithOsat.reduce((sum, i) => sum + ((i.osatPercent || 0) * (i.osatResponses || 0)), 0) / totalOsatResponses
    : undefined;

  // Calculate aggregate speed attainment from restaurant driveThru data
  let avgSpeedAttainment: number | undefined;
  let totalDTCars: number | undefined;
  let dtStoresReporting: number | undefined;
  if (groupRestaurants) {
    let totalCars = 0;
    let totalUnder6 = 0;
    let storesWithData = 0;
    for (const r of groupRestaurants) {
      const dt = r.driveThru;
      if (dt && dt.carCount > 0) {
        totalCars += dt.carCount;
        totalUnder6 += dt.carsUnder6Min || 0;
        storesWithData++;
      }
    }
    if (totalCars > 0) {
      avgSpeedAttainment = Math.round((totalUnder6 / totalCars) * 100);
      totalDTCars = totalCars;
      dtStoresReporting = storesWithData;
    }
  }
  
  // Find most common strength and concern
  const allStrengths = insights.flatMap(i => i.strengths);
  const allConcerns = insights.flatMap(i => i.concerns);
  
  const topStrength = allStrengths.length > 0 
    ? `${unitsAboveExpectation} units above last week's sales` 
    : "Performance consistent across units";
  const topConcern = allConcerns.length > 0 
    ? (understaffedUnits > overstaffedUnits 
        ? `${understaffedUnits} units showing understaffing patterns`
        : overstaffedUnits > 0 
          ? `${overstaffedUnits} units showing overstaffing patterns`
          : lowOsatUnits > 0
            ? `${lowOsatUnits} units with low customer satisfaction`
            : `${unitsBelowExpectation} units below last week's sales`)
    : "No major concerns identified";
  
  let recommendation = "";
  if (understaffedUnits >= unitCount * 0.3) {
    recommendation = "Multiple units showing understaffing. Review region-wide scheduling practices.";
  } else if (overstaffedUnits >= unitCount * 0.3) {
    recommendation = "Multiple units showing high labor. Audit scheduling compliance across the group.";
  } else if (lowOsatUnits >= unitCount * 0.3) {
    recommendation = "Customer satisfaction needs attention across multiple units. Review service standards.";
  } else if (unitsBelowExpectation >= unitCount * 0.4) {
    recommendation = "Sales trending down across multiple units. Consider marketing push or operational review.";
  } else if (unitsAboveExpectation >= unitCount * 0.5) {
    recommendation = "Strong regional performance. Share best practices and recognize high performers.";
  } else {
    recommendation = "Mixed performance. Focus on underperforming units while maintaining standards.";
  }
  
  return {
    name,
    unitCount,
    totalSales,
    avgVariance,
    avgGrade,
    gradeLabel,
    gradeColor,
    understaffedUnits,
    overstaffedUnits,
    slowSpeedUnits,
    lowOsatUnits,
    unitsAboveExpectation,
    unitsBelowExpectation,
    topStrength,
    topConcern,
    recommendation,
    avgOsatPercent,
    totalOsatResponses: totalOsatResponses > 0 ? totalOsatResponses : undefined,
    avgSpeedAttainment,
    totalDTCars,
    dtStoresReporting,
  };
}

function UnitSummaryCard({ insight, defaultOpen = false, onExpanded, notesByRestaurant, selectedDate, rank, sortBy }: { insight: UnitInsight; defaultOpen?: boolean; onExpanded?: () => void; notesByRestaurant?: Record<string, RestaurantNote[]>; selectedDate?: string; rank?: number; sortBy?: "grade" | "sales" | "name" }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (defaultOpen) {
      setIsOpen(true);
      setTimeout(() => {
        scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        onExpanded?.();
      }, 300);
    }
  }, [defaultOpen]);
  
  return (
    <div ref={scrollRef}>
    <Card className="hover-elevate" data-testid={`summary-unit-${insight.restaurantId}`}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-2">
            <div className="space-y-1">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
                  {rank !== undefined && (
                    <span className="text-xs font-bold text-muted-foreground tabular-nums w-5 text-right flex-shrink-0">#{rank}</span>
                  )}
                  <CardTitle className="text-base">{insight.restaurantName}</CardTitle>
                  <Badge variant="outline" className="text-xs">{insight.state}</Badge>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge className={`${insight.gradeColor} bg-transparent border cursor-help`}>
                        {insight.gradeLabel}{insight.avgGrade > 0 && <span className="ml-1 opacity-60 text-[10px]">{insight.avgGrade.toFixed(1)}</span>}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <span className="text-xs">Execution Score: {insight.avgGrade.toFixed(1)}</span>
                    </TooltipContent>
                  </Tooltip>
                  {insight.bonusResult && insight.bonusResult.cappedBonus > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-0.5 text-yellow-500 text-xs font-semibold ml-1 cursor-help">
                          <Sparkles className="w-3 h-3" />+{insight.bonusResult.cappedBonus}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <div className="text-xs space-y-1">
                          <div className="font-semibold">Bonus Points Earned</div>
                          {insight.bonusResult.bonuses.map(b => (
                            <div key={b.id} className="flex justify-between gap-4">
                              <span>{b.label}</span>
                              <span className="text-yellow-500 font-semibold">+{b.points}</span>
                            </div>
                          ))}
                          {insight.bonusResult.totalBonus > BONUS_CAP && (
                            <div className="text-muted-foreground border-t pt-1">Capped at +{BONUS_CAP} (earned {insight.bonusResult.totalBonus})</div>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {insight.osatPercent !== undefined && insight.osatResponses && insight.osatResponses > 0 && (
                    <Badge
                      variant="outline"
                      className={`text-xs ${insight.osatPercent >= 85 ? "text-green-600 border-green-300" : insight.osatPercent >= 80 ? "text-yellow-600 border-yellow-300" : "text-red-600 border-red-300"}`}
                    >
                      <ThumbsUp className="w-3 h-3 mr-1" />
                      OSAT {insight.osatPercent.toFixed(0)}% ({insight.osatResponses})
                    </Badge>
                  )}
                  {insight.weather && (
                    <Badge variant="secondary" className="text-xs gap-1">
                      <WeatherIcon condition={insight.weather.condition} />
                      {insight.weather.highTemp !== undefined ? (
                        <span>{Math.round(insight.weather.highTemp)}°/{Math.round(insight.weather.lowTemp ?? 0)}°</span>
                      ) : (
                        <span>{Math.round(insight.weather.temp)}°F</span>
                      )}
                    </Badge>
                  )}
                  {insight.crewScore !== undefined && insight.crewScore > 0 && (
                    <Badge
                      variant="secondary"
                      className={`text-xs gap-1 border-0 ${
                        insight.crewScore >= 75
                          ? "bg-green-500/10 text-green-500"
                          : insight.crewScore >= 50
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "bg-red-500/10 text-red-500"
                      }`}
                    >
                      <GraduationCap className="w-3 h-3" />
                      <span className="font-medium">{insight.crewScore}</span>
                      {insight.crewTenureMonths !== undefined && (
                        <span className="text-[10px] text-muted-foreground ml-0.5">({formatTenure(insight.crewTenureMonths)})</span>
                      )}
                    </Badge>
                  )}
                  {insight.hourlyRateTier && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className={`text-xs gap-1 font-bold ${insight.hourlyRateTier.color} ${insight.hourlyRateTier.label === "LEGENDARY" ? "animate-pulse" : ""}`}
                        >
                          {insight.hourlyRateTier.label === "LEGENDARY" ? <Trophy className="w-3 h-3" /> :
                           insight.hourlyRateTier.label === "ULTRA" ? <Diamond className="w-3 h-3" /> :
                           insight.hourlyRateTier.label === "ELITE" ? <Flame className="w-3 h-3" /> :
                           insight.hourlyRateTier.label === "PRO" ? <Zap className="w-3 h-3" /> :
                           <Star className="w-3 h-3" />}
                          {insight.hourlyRateTier.label}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <div className="text-xs">
                          <div className="font-bold">{insight.hourlyRateTier.label} Achievement</div>
                          <div>Peak: ${insight.peakHourlySales?.toLocaleString(undefined, { maximumFractionDigits: 0 })}/hr at {insight.peakHour !== undefined ? formatHour(insight.peakHour) : ''}</div>
                          <div className="text-muted-foreground mt-1">$750 Contender · $1K Pro · $1.5K Elite · $2K Ultra · $2.3K Legendary</div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm font-medium">{formatCurrency(insight.totalSales)}</span>
                  <span className={`text-sm ${insight.salesVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {insight.salesVariance >= 0 ? "+" : ""}{insight.salesVariance.toFixed(1)}%
                  </span>
                  {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </div>
              {/* Daypart grades and OSAT category issues */}
              {(
                (insight.daypartGrades && insight.daypartGrades.length > 0) ||
                (insight.categoryIssues && insight.categoryIssues.length > 0)
              ) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {insight.daypartGrades?.map(dp => (
                    <Badge
                      key={dp.id}
                      variant="outline"
                      className={`text-[10px] px-1.5 py-0 ${dp.color} border-current/30`}
                    >
                      {dp.shortLabel}: {dp.grade}
                    </Badge>
                  ))}
                  {insight.categoryIssues?.slice(0, 3).map((issue, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 text-red-600 dark:text-red-400 border-red-300 dark:border-red-700"
                    >
                      {issue.category}: {issue.avgRating.toFixed(1)}★
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-3">
            {insight.strengths.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-green-600">
                  <CheckCircle className="w-4 h-4" />
                  What went well
                </div>
                <ul className="text-sm text-muted-foreground pl-5 space-y-0.5">
                  {insight.strengths.map((s, i) => (
                    <li key={i}>• {s}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {insight.concerns.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-amber-600">
                  <AlertTriangle className="w-4 h-4" />
                  Areas of concern
                </div>
                <ul className="text-sm text-muted-foreground pl-5 space-y-0.5">
                  {insight.concerns.map((c, i) => (
                    <li key={i}>• {c}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {insight.salesOutliers.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-blue-600">
                  <Target className="w-4 h-4" />
                  Hourly sales outliers
                </div>
                <div className="space-y-1 pl-5">
                  {insight.salesOutliers.slice(0, 5).map((o, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Badge 
                        variant="secondary" 
                        className={`text-xs ${o.type === "above" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}
                      >
                        {formatHour(o.hour)}: {o.type === "above" ? "+" : ""}{o.variance.toFixed(0)}%
                      </Badge>
                      {o.leaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {o.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {insight.speedIssues.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-red-600">
                  <Clock className="w-4 h-4" />
                  Low speed attainment (&lt;50%)
                </div>
                <div className="space-y-1 pl-5">
                  {insight.speedIssues.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Badge 
                        variant="secondary" 
                        className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                      >
                        {formatHour(s.hour)}: {Math.round(s.avgTime)}% attainment
                      </Badge>
                      {s.leaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {s.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {insight.surveyHours && insight.surveyHours.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
                  <ThumbsUp className="w-4 h-4" />
                  Surveys received ({insight.osatResponses} total)
                </div>
                <div className="space-y-1 pl-5">
                  {insight.surveyHours.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Badge 
                        variant="secondary" 
                        className={`text-xs ${s.percent >= 85 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : s.percent >= 80 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}
                      >
                        {formatHour(s.hour)}: {s.percent.toFixed(0)}% ({s.responses})
                      </Badge>
                      {s.leaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {s.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {insight.osatIssues && insight.osatIssues.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-red-600">
                  <ThumbsUp className="w-4 h-4" />
                  Customer satisfaction issues (&lt;80% OSAT)
                </div>
                <div className="space-y-1 pl-5">
                  {insight.osatIssues.map((o, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Badge 
                        variant="secondary" 
                        className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                      >
                        {formatHour(o.hour)}: {o.osatPercent.toFixed(0)}% ({o.responses} responses)
                      </Badge>
                      {o.leaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {o.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {insight.categoryIssues && insight.categoryIssues.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-red-600">
                  <AlertCircle className="w-4 h-4" />
                  Survey issue areas (rated &lt;3/5)
                </div>
                <div className="flex flex-wrap gap-1 pl-5">
                  {insight.categoryIssues.map((issue, i) => (
                    <Badge 
                      key={i}
                      variant="secondary" 
                      className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                    >
                      {issue.category}: {issue.avgRating.toFixed(1)}/5 ({issue.lowCount}/{issue.totalCount} low)
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            
            {insight.staffingIssues.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-sm font-medium text-amber-600">
                  <Users className="w-4 h-4" />
                  Staffing variances
                </div>
                <div className="space-y-1 pl-5">
                  {insight.staffingIssues.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Badge 
                        variant="secondary" 
                        className={`text-xs ${s.type === "over" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"}`}
                      >
                        {formatHour(s.hour)}: {s.type === "over" ? "+" : "-"}{s.diff.toFixed(0)} {s.type === "over" ? "over" : "under"}
                      </Badge>
                      {s.leaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {s.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Manager Notes */}
            {notesByRestaurant?.[insight.restaurantId] && notesByRestaurant[insight.restaurantId].length > 0 && (
              <div className="pt-2 border-t">
                <div className="flex items-start gap-2">
                  <MessageSquare className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">Manager Notes</span>
                    <div className="space-y-1 mt-1">
                      {notesByRestaurant[insight.restaurantId].map(note => (
                        <div key={note.id} className="text-sm text-muted-foreground">
                          <span className="text-foreground">{note.note}</span>
                          {note.hour !== null && (
                            <span className="ml-1 text-xs text-amber-500">
                              ({note.hour === 0 ? '12am' : note.hour < 12 ? `${note.hour}am` : note.hour === 12 ? '12pm' : `${note.hour - 12}pm`})
                            </span>
                          )}
                          {note.category !== 'general' && (
                            <span className="ml-1 text-xs text-muted-foreground/70">[{note.category}]</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Unit Report Button */}
            {selectedDate && (
              <div className="pt-2 border-t flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setReportDialogOpen(true);
                  }}
                >
                  <FileText className="w-3.5 h-3.5" />
                  Report
                </Button>
              </div>
            )}

            {/* Unit Report Dialog */}
            {selectedDate && (
              <UnitReportDialog
                open={reportDialogOpen}
                onOpenChange={setReportDialogOpen}
                restaurantId={insight.restaurantId}
                restaurantName={insight.restaurantName}
                date={selectedDate}
              />
            )}

          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
    </div>
  );
}

function AggregatedSummaryCard({ summary, icon }: { summary: AggregatedSummary; icon: React.ReactNode }) {
  return (
    <Card data-testid={`summary-aggregate-${summary.name.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{summary.name}</CardTitle>
            <Badge variant="outline" className="text-xs">{summary.unitCount} units</Badge>
          </div>
          <Badge className={`${summary.gradeColor} bg-transparent border`}>
            {summary.gradeLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="text-center p-2 rounded bg-muted/50">
            <div className="text-lg font-semibold">{formatCurrency(summary.totalSales)}</div>
            <div className="text-xs text-muted-foreground">Total Sales</div>
          </div>
          <div className="text-center p-2 rounded bg-muted/50">
            <div className={`text-lg font-semibold ${summary.avgVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
              {summary.avgVariance >= 0 ? "+" : ""}{summary.avgVariance.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">Avg vs LW</div>
          </div>
          <div className="text-center p-2 rounded bg-muted/50">
            <div className="text-lg font-semibold text-green-600">{summary.unitsAboveExpectation}</div>
            <div className="text-xs text-muted-foreground">Units Up</div>
          </div>
          <div className="text-center p-2 rounded bg-muted/50">
            <div className="text-lg font-semibold text-red-600">{summary.unitsBelowExpectation}</div>
            <div className="text-xs text-muted-foreground">Units Down</div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="flex items-start gap-2 p-2 rounded bg-green-50 dark:bg-green-950/30">
            <TrendingUp className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
            <span>{summary.topStrength}</span>
          </div>
          <div className="flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/30">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <span>{summary.topConcern}</span>
          </div>
        </div>
        
        <div className="flex items-start gap-2 pt-2 border-t">
          <FileText className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p className="text-sm">{summary.recommendation}</p>
        </div>
        
        {(summary.understaffedUnits > 0 || summary.overstaffedUnits > 0 || summary.slowSpeedUnits > 0 || summary.lowOsatUnits > 0 || summary.avgOsatPercent !== undefined || summary.avgSpeedAttainment !== undefined) && (
          <div className="flex flex-wrap gap-2 pt-2">
            {summary.avgSpeedAttainment !== undefined && (
              <Badge 
                variant="secondary" 
                className={`text-xs ${summary.avgSpeedAttainment >= 70 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : summary.avgSpeedAttainment >= 50 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}
              >
                <Clock className="w-3 h-3 mr-1" />
                Speed {summary.avgSpeedAttainment}% ({summary.dtStoresReporting} stores)
              </Badge>
            )}
            {summary.avgOsatPercent !== undefined && summary.totalOsatResponses && summary.totalOsatResponses > 0 && (
              <Badge 
                variant="secondary" 
                className={`text-xs ${summary.avgOsatPercent >= 85 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : summary.avgOsatPercent >= 80 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}
              >
                <ThumbsUp className="w-3 h-3 mr-1" />
                OSAT {summary.avgOsatPercent.toFixed(0)}% ({summary.totalOsatResponses})
              </Badge>
            )}
            {summary.understaffedUnits > 0 && (
              <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                <Users className="w-3 h-3 mr-1" />
                {summary.understaffedUnits} understaffed
              </Badge>
            )}
            {summary.overstaffedUnits > 0 && (
              <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                <Users className="w-3 h-3 mr-1" />
                {summary.overstaffedUnits} overstaffed
              </Badge>
            )}
            {summary.slowSpeedUnits > 0 && (
              <Badge variant="secondary" className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                <Clock className="w-3 h-3 mr-1" />
                {summary.slowSpeedUnits} slow DT
              </Badge>
            )}
            {summary.lowOsatUnits > 0 && (
              <Badge variant="secondary" className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                <ThumbsUp className="w-3 h-3 mr-1" />
                {summary.lowOsatUnits} low OSAT
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DailySummary({
  restaurants,
  hourlyByRestaurant,
  markets,
  crewSummary,
  isCollapsed = false,
  onCollapseChange,
  selectedDate,
  dateRange,
  expandUnitId,
  onUnitExpanded,
  notesByRestaurant,
  attachmentRatesByRestaurant,
  helperRewardsByRestaurant,
}: DailySummaryProps) {
  // Fetch category issues for all dates in range
  const gradingCfg = useGradingConfig();
  const datesToFetch = dateRange && dateRange.length > 0 ? dateRange : (selectedDate ? [selectedDate] : []);

  type CategoryIssueRow = {
    restaurantId: string;
    date: string;
    hour: number;
    orderAccuracy: number | null;
    foodQuality: number | null;
    menuOptions: number | null;
    value: number | null;
    easeOfOrdering: number | null;
    employeeFriendliness: number | null;
    speedOfService: number | null;
    cleanliness: number | null;
    driveThruWaitTime: number | null;
    overallRating: number | null;
  };
  
  const categoryIssueQueries = useQueries({
    queries: datesToFetch.map(date => ({
      queryKey: ['/api/osat/category-issues/all', date],
      queryFn: async () => {
        const res = await fetch(`/api/osat/category-issues/all?date=${date}`);
        if (!res.ok) throw new Error("Failed to fetch category issues");
        return res.json() as Promise<{ date: string; issuesByRestaurant: Record<string, CategoryIssueRow[]> }>;
      },
      enabled: !!date,
    })),
  });
  
  const categoryIssuesData = useMemo(() => {
    const allData = categoryIssueQueries.filter(q => q.data).map(q => q.data!);
    if (allData.length === 0) return null;
    if (allData.length === 1) return allData[0];
    
    const merged: Record<string, CategoryIssueRow[]> = {};
    for (const dayData of allData) {
      for (const [restaurantId, issues] of Object.entries(dayData.issuesByRestaurant)) {
        if (!merged[restaurantId]) {
          merged[restaurantId] = [];
        }
        merged[restaurantId].push(...issues);
      }
    }
    return { date: allData[0].date, issuesByRestaurant: merged };
  }, [categoryIssueQueries]);
  
  // Process category issues into a usable format per restaurant
  const categoryIssuesByRestaurant = useMemo(() => {
    if (!categoryIssuesData?.issuesByRestaurant) return {};
    
    const result: Record<string, CategoryIssue[]> = {};
    const categoryNames: Record<string, string> = {
      orderAccuracy: 'Order Accuracy',
      foodQuality: 'Food Quality',
      menuOptions: 'Menu Options',
      value: 'Value',
      easeOfOrdering: 'Ease of Ordering',
      employeeFriendliness: 'Employee Friendliness',
      speedOfService: 'Speed of Service',
      cleanliness: 'Cleanliness',
      driveThruWaitTime: 'Drive-Thru Wait Time',
    };
    
    for (const [restaurantId, issues] of Object.entries(categoryIssuesData.issuesByRestaurant)) {
      const categoryIssues: CategoryIssue[] = [];
      
      for (const [key, label] of Object.entries(categoryNames)) {
        const ratings = issues
          .map(i => (i as any)[key])
          .filter((r: number | null | undefined): r is number => r !== null && r !== undefined);
        
        if (ratings.length > 0) {
          const lowCount = ratings.filter(r => r < 3).length;
          const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
          
          if (lowCount > 0 || avgRating < 3) {
            categoryIssues.push({
              category: label,
              lowCount,
              totalCount: ratings.length,
              avgRating: Math.round(avgRating * 10) / 10,
            });
          }
        }
      }
      
      // Sort by most issues first
      categoryIssues.sort((a, b) => b.lowCount - a.lowCount || a.avgRating - b.avgRating);
      
      if (categoryIssues.length > 0) {
        result[restaurantId] = categoryIssues;
      }
    }
    
    return result;
  }, [categoryIssuesData]);
  
  // Format date for display
  const formatDateDisplay = (dateStr: string) => {
    try {
      const date = new Date(dateStr + "T12:00:00Z");
      return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };
  
  const dateDisplayText = useMemo(() => {
    if (!selectedDate) return "";
    if (dateRange && dateRange.length > 1) {
      return `${formatDateDisplay(dateRange[0])} - ${formatDateDisplay(dateRange[dateRange.length - 1])}`;
    }
    return formatDateDisplay(selectedDate);
  }, [selectedDate, dateRange]);
  const [activeTab, setActiveTab] = useState("units");
  const [unitSort, setUnitSort] = useState<"grade" | "sales" | "name">("grade");
  const [aggregateSort, setAggregateSort] = useState<"grade" | "sales">("grade");

  // Analyze all units (exclude training units)
  const unitInsights = useMemo(() => {
    const activeRestaurants = restaurants.filter(r => r.status !== "training");
    return activeRestaurants.map(r => {
      const insight = analyzeUnit(r, hourlyByRestaurant?.[r.restaurantId], attachmentRatesByRestaurant?.[r.restaurantId]?.categories, gradingCfg, helperRewardsByRestaurant?.[r.restaurantId]);
      // Add market info if available
      if (markets) {
        const market = markets.find(m => m.restaurantIds?.includes(r.restaurantId));
        if (market) {
          insight.marketId = market.id;
          insight.marketName = market.name;
        }
      }
      // Add category issues if available
      if (categoryIssuesByRestaurant[r.restaurantId]) {
        insight.categoryIssues = categoryIssuesByRestaurant[r.restaurantId];
      }
      // Add crew experience data if available
      if (crewSummary?.[r.restaurantId]) {
        const crew = crewSummary[r.restaurantId];
        insight.crewScore = crew.avgScore;
        insight.crewTenureMonths = crew.avgTenureMonths;
        insight.crewAvgCount = crew.avgCrewCount;
      }
      return insight;
    });
  }, [restaurants, hourlyByRestaurant, markets, categoryIssuesByRestaurant, crewSummary, gradingCfg, attachmentRatesByRestaurant]);
  
  // Sort unit insights based on selected sort
  const sortedUnitInsights = useMemo(() => {
    const sorted = [...unitInsights];
    // Helper to safely get numeric value (guards against NaN/undefined)
    const safeNum = (v: number | undefined | null): number => (v != null && !isNaN(v) ? v : 0);
    switch (unitSort) {
      case "grade":
        return sorted.sort((a, b) => {
          const aGrade = safeNum(a.avgGrade);
          const bGrade = safeNum(b.avgGrade);
          // Push no-data units (grade 0) to bottom
          if (aGrade === 0 && bGrade === 0) return (a.restaurantName || "").localeCompare(b.restaurantName || "");
          if (aGrade === 0) return 1;
          if (bGrade === 0) return -1;
          // Primary: descending by numeric execution score
          const gradeDiff = bGrade - aGrade;
          if (gradeDiff !== 0) return gradeDiff;
          // Tiebreaker: descending by sales
          const salesDiff = safeNum(b.totalSales) - safeNum(a.totalSales);
          if (salesDiff !== 0) return salesDiff;
          // Final tiebreaker: alphabetical by name
          return (a.restaurantName || "").localeCompare(b.restaurantName || "");
        });
      case "sales":
        return sorted.sort((a, b) => {
          const diff = safeNum(b.totalSales) - safeNum(a.totalSales);
          if (diff !== 0) return diff;
          return (a.restaurantName || "").localeCompare(b.restaurantName || "");
        });
      case "name":
        return sorted.sort((a, b) => (a.restaurantName || "").localeCompare(b.restaurantName || ""));
      default:
        return sorted;
    }
  }, [unitInsights, unitSort]);

  // Aggregate by state
  const stateSummaries = useMemo(() => {
    const byState = new Map<string, UnitInsight[]>();
    for (const insight of unitInsights) {
      const state = insight.state || "Unknown";
      if (!byState.has(state)) byState.set(state, []);
      byState.get(state)!.push(insight);
    }
    const summaries = Array.from(byState.entries()).map(([state, insights]) => {
      const stateRestaurantIds = new Set(insights.map(i => i.restaurantId));
      const stateRestaurants = restaurants.filter(r => stateRestaurantIds.has(r.restaurantId));
      return aggregateInsights(insights, state, stateRestaurants);
    });
    if (aggregateSort === "grade") {
      return summaries.sort((a, b) => {
        const gDiff = (b.avgGrade || 0) - (a.avgGrade || 0);
        if (gDiff !== 0) return gDiff;
        return (b.totalSales || 0) - (a.totalSales || 0);
      });
    }
    return summaries.sort((a, b) => {
      const sDiff = (b.totalSales || 0) - (a.totalSales || 0);
      if (sDiff !== 0) return sDiff;
      return (b.avgGrade || 0) - (a.avgGrade || 0);
    });
  }, [unitInsights, restaurants, aggregateSort]);

  // Aggregate by market
  const marketSummaries = useMemo(() => {
    if (!markets || markets.length === 0) return [];
    const byMarket = new Map<string, UnitInsight[]>();
    for (const insight of unitInsights) {
      if (insight.marketId && insight.marketName) {
        if (!byMarket.has(insight.marketId)) byMarket.set(insight.marketId, []);
        byMarket.get(insight.marketId)!.push(insight);
      }
    }
    const summaries = Array.from(byMarket.entries()).map(([marketId, insights]) => {
      const market = markets.find(m => m.id === marketId);
      const marketRestaurantIds = new Set(insights.map(i => i.restaurantId));
      const marketRestaurants = restaurants.filter(r => marketRestaurantIds.has(r.restaurantId));
      return aggregateInsights(insights, market?.name || "Unknown Market", marketRestaurants);
    });
    if (aggregateSort === "grade") {
      return summaries.sort((a, b) => {
        const gDiff = (b.avgGrade || 0) - (a.avgGrade || 0);
        if (gDiff !== 0) return gDiff;
        return (b.totalSales || 0) - (a.totalSales || 0);
      });
    }
    return summaries.sort((a, b) => {
      const sDiff = (b.totalSales || 0) - (a.totalSales || 0);
      if (sDiff !== 0) return sDiff;
      return (b.avgGrade || 0) - (a.avgGrade || 0);
    });
  }, [unitInsights, markets, restaurants, aggregateSort]);
  
  // Company-wide summary
  const companySummary = useMemo(() => {
    return aggregateInsights(unitInsights, "Company Overview", restaurants);
  }, [unitInsights, restaurants]);
  
  if (restaurants.length === 0) return null;
  
  return (
    <Collapsible open={!isCollapsed} onOpenChange={(open) => onCollapseChange?.(!open)}>
      <Card data-testid="daily-summary-section">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  Daily Performance Summary
                </CardTitle>
                {dateDisplayText && (
                  <Badge variant="outline" className="text-xs font-normal">
                    {dateDisplayText}
                  </Badge>
                )}
              </div>
              <Button variant="ghost" size="sm" type="button">
                {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
              </Button>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-4 mb-4">
                <TabsTrigger value="units" className="text-xs sm:text-sm" data-testid="tab-units">
                  <Building2 className="w-4 h-4 mr-1 hidden sm:inline" />
                  By Unit
                </TabsTrigger>
                <TabsTrigger value="markets" className="text-xs sm:text-sm" data-testid="tab-markets" disabled={!markets || markets.length === 0}>
                  <MapPin className="w-4 h-4 mr-1 hidden sm:inline" />
                  By Market
                </TabsTrigger>
                <TabsTrigger value="states" className="text-xs sm:text-sm" data-testid="tab-states">
                  <Globe className="w-4 h-4 mr-1 hidden sm:inline" />
                  By State
                </TabsTrigger>
                <TabsTrigger value="company" className="text-xs sm:text-sm" data-testid="tab-company">
                  <Target className="w-4 h-4 mr-1 hidden sm:inline" />
                  Company
                </TabsTrigger>
              </TabsList>
              
              <TabsContent value="units" className="space-y-3">
                <div className="flex items-center gap-1.5 text-xs flex-wrap">
                  <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Sort:</span>
                  {(["grade", "sales", "name"] as const).map(opt => (
                    <Button
                      key={opt}
                      variant={unitSort === opt ? "secondary" : "ghost"}
                      size="sm"
                      className={`h-6 px-2 text-xs ${unitSort === opt ? "font-semibold" : ""}`}
                      onClick={() => setUnitSort(opt)}
                    >
                      {opt === "grade" ? "Execution" : opt === "sales" ? "Sales" : "Name"}
                      {unitSort === opt && (
                        <ChevronDown className="w-3 h-3 ml-0.5" />
                      )}
                    </Button>
                  ))}
                  <span className="text-muted-foreground ml-1">({sortedUnitInsights.length} units)</span>
                </div>
                {sortedUnitInsights.map((insight, idx) => (
                  <UnitSummaryCard key={insight.restaurantId} insight={insight} defaultOpen={expandUnitId === insight.restaurantId} onExpanded={onUnitExpanded} notesByRestaurant={notesByRestaurant} selectedDate={selectedDate} rank={idx + 1} sortBy={unitSort} />
                ))}
              </TabsContent>
              
              <TabsContent value="markets" className="space-y-3">
                {marketSummaries.length > 0 ? (
                  <>
                    <div className="flex items-center gap-1.5 text-xs">
                      <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">Sort:</span>
                      {(["grade", "sales"] as const).map(opt => (
                        <Button
                          key={opt}
                          variant={aggregateSort === opt ? "secondary" : "ghost"}
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => setAggregateSort(opt)}
                        >
                          {opt === "grade" ? "Execution" : "Sales"}
                        </Button>
                      ))}
                    </div>
                    {marketSummaries.map(summary => (
                      <AggregatedSummaryCard
                        key={summary.name}
                        summary={summary}
                        icon={<MapPin className="w-5 h-5 text-indigo-500" />}
                      />
                    ))}
                  </>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <MapPin className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p>No markets configured. Create markets in Settings to see market-level summaries.</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="states" className="space-y-3">
                <div className="flex items-center gap-1.5 text-xs">
                  <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Sort:</span>
                  {(["grade", "sales"] as const).map(opt => (
                    <Button
                      key={opt}
                      variant={aggregateSort === opt ? "secondary" : "ghost"}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setAggregateSort(opt)}
                    >
                      {opt === "grade" ? "Execution" : "Sales"}
                    </Button>
                  ))}
                </div>
                {stateSummaries.map(summary => (
                  <AggregatedSummaryCard
                    key={summary.name}
                    summary={summary}
                    icon={<Globe className="w-5 h-5 text-blue-500" />}
                  />
                ))}
              </TabsContent>
              
              <TabsContent value="company">
                <AggregatedSummaryCard 
                  summary={companySummary} 
                  icon={<Target className="w-5 h-5 text-green-500" />}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
