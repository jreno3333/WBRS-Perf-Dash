import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

import { NavBar } from "@/components/nav-bar";
import { Link } from "wouter";
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Calendar,
  Building2,
  MapPin,
  Globe,
  Target,
  DollarSign,
  Users,
  Clock,
  ThumbsUp,
  Minus,
  Sun,
  Cloud,
  CloudRain,
  CloudSnow,
  CloudLightning,
  CloudFog,
  CloudDrizzle,
  GraduationCap,
  Sparkles,
  ClipboardList,
  Copy,
  Check,
  Printer,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface DaypartGrade {
  id: string;
  label: string;
  shortLabel: string;
  score: number;
  gradeLabel: string;
  sales: number;
  salesVariance: number;
  osatPercent?: number;
  osatResponses: number;
  speedAttainment?: number;
  staffingDiff: number;
  hoursWithData: number;
}

interface DailyGrade {
  date: string;
  grade: number;
  gradeLabel: string;
  baseGrade?: number;
  totalSales: number;
  salesVariance: number;
  avgSpeed?: number;
  staffingDiff: number;
  osatPercent?: number;
  osatResponses?: number;
  transactionVariance?: number;
  avgXp?: number;
  weather?: { highTemp: number; lowTemp: number; condition: string } | null;
  bonuses?: { id: string; label: string; points: number }[];
  bonusPoints?: number;
  daypartGrades?: DaypartGrade[];
  bLaneHours?: number;
}

interface WeekendDaySummary {
  day: string;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgSpeed?: number;
  avgStaffingDiff: number;
  avgOsat?: number;
  totalOsatResponses: number;
  dayCount: number;
  avgAttachScore?: number;
  avgCategoriesAtTarget?: number;
}

interface WeekendData {
  weekendGrade: number;
  weekendGradeLabel: string;
  weekendTotalSales: number;
  weekendAvgSalesVariance: number;
  weekendAvgSpeed?: number;
  weekendAvgStaffingDiff: number;
  weekendAvgOsat?: number;
  weekendTotalOsatResponses: number;
  weekendDayCount: number;
  overallGradeDelta: number;
  overallSalesVarianceDelta: number;
  overallSpeedDelta?: number;
  overallOsatDelta?: number;
  weekendAvgAttachScore?: number;
  weekendAvgCategoriesAtTarget?: number;
  perDay: WeekendDaySummary[];
}

interface WeekendRollup {
  restaurantCount: number;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgSpeed?: number;
  avgOsat?: number;
  avgStaffingDiff: number;
  avgAttachScore?: number;
  avgCategoriesAtTarget?: number;
}

interface RestaurantHistory {
  restaurantId: string;
  restaurantName: string;
  state: string;
  marketId?: string;
  marketName?: string;
  dailyGrades: DailyGrade[];
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgSpeed?: number;
  avgStaffingDiff: number;
  avgOsat?: number;
  totalOsatResponses: number;
  avgXp?: number;
  gradeImprovement: number;
  weekend?: WeekendData | null;
}

interface StateSummary {
  state: string;
  restaurantCount: number;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgOsat?: number;
  avgImprovement: number;
}

interface MarketSummary {
  market: string;
  restaurantCount: number;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgSalesVariance: number;
  avgOsat?: number;
  avgImprovement: number;
}

interface PerformanceHistoryData {
  dateRange: string[];
  restaurants: RestaurantHistory[];
  stateSummaries: StateSummary[];
  marketSummaries: MarketSummary[];
  companySummary: {
    restaurantCount: number;
    avgGrade: number;
    avgGradeLabel: string;
    totalSales: number;
    avgSalesVariance: number;
    avgOsat?: number;
    avgImprovement: number;
  };
  weekendSummary?: {
    company: WeekendRollup | null;
    states: (WeekendRollup & { state: string })[];
    markets: (WeekendRollup & { market: string })[];
    weekendDates?: string[];
  };
}

function getGradeColor(label: string): string {
  if (label.startsWith("A")) return "text-green-600 dark:text-green-400";
  if (label.startsWith("B")) return "text-blue-600 dark:text-blue-400";
  if (label.startsWith("C")) return "text-yellow-600 dark:text-yellow-400";
  if (label.startsWith("D")) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function getGradeBgColor(label: string): string {
  if (label.startsWith("A")) return "bg-green-100 dark:bg-green-900/30";
  if (label.startsWith("B")) return "bg-blue-100 dark:bg-blue-900/30";
  if (label.startsWith("C")) return "bg-yellow-100 dark:bg-yellow-900/30";
  if (label.startsWith("D")) return "bg-orange-100 dark:bg-orange-900/30";
  return "bg-red-100 dark:bg-red-900/30";
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function TrendIndicator({ value }: { value: number }) {
  if (value > 0) return <TrendingUp className="w-4 h-4 text-green-600" />;
  if (value < 0) return <TrendingDown className="w-4 h-4 text-red-600" />;
  return <Minus className="w-4 h-4 text-muted-foreground" />;
}

function WeatherIcon({ condition, className = "w-3 h-3" }: { condition: string; className?: string }) {
  switch (condition.toLowerCase()) {
    case "clear": return <Sun className={className} />;
    case "partly cloudy": return <Cloud className={className} />;
    case "foggy": return <CloudFog className={className} />;
    case "rain": return <CloudRain className={className} />;
    case "showers": return <CloudDrizzle className={className} />;
    case "snow": return <CloudSnow className={className} />;
    case "thunderstorm": return <CloudLightning className={className} />;
    default: return <Sun className={className} />;
  }
}

interface LeaderRanking {
  name: string;
  position: string;
  grade: string;
  avgGradeScore: number;
  hoursWorked: number;
  avgHourlySales: number | null;
  avgSpeed: number | null;
  osatPercent: number | null;
  surveyCount: number;
  companyRankDisplay?: string | null;
}

interface AttachmentData {
  restaurantName: string;
  totalOrders: number;
  checkAverage: number;
  categories: Record<string, { attachRate: number; estimatedUnits: number; benchmark: number; vsTarget: number }>;
  overallAttachScore: number;
}

interface AnniversaryData {
  employeeId: string;
  name: string;
  position: string;
  restaurantId: string | null;
  restaurantName: string;
  hireDate: string;
  anniversaryDate: string;
  yearsCompleted: number;
  daysUntil: number;
}

interface AgendaExtras {
  attachment?: AttachmentData | null;
  anniversaries?: AnniversaryData[];
}

function generateRMMAgenda(restaurant: RestaurantHistory, dateRange: string[], leaders: LeaderRanking[] = [], extras: AgendaExtras = {}): string {
  const grades = restaurant.dailyGrades;
  const startDate = dateRange.length > 0 ? formatDate(dateRange[0]) : "N/A";
  const endDate = dateRange.length > 0 ? formatDate(dateRange[dateRange.length - 1]) : "N/A";

  // Performance overview
  const avgGradeNum = restaurant.avgGrade;
  const avgLabel = restaurant.avgGradeLabel;
  const totalSales = formatCurrency(restaurant.totalSales);
  const avgVariance = restaurant.avgSalesVariance;

  // Find best and worst days
  const sortedByGrade = [...grades].sort((a, b) => b.grade - a.grade);
  const bestDays = sortedByGrade.filter(d => d.gradeLabel.startsWith("A") || d.gradeLabel.startsWith("B"));
  const weakDays = sortedByGrade.filter(d => d.gradeLabel.startsWith("D") || d.gradeLabel.startsWith("F"));
  const cDays = sortedByGrade.filter(d => d.gradeLabel.startsWith("C"));

  // Leader shout-outs: A-grade days and bonus days
  const shoutOuts: string[] = [];
  grades.forEach(day => {
    const dayLabel = formatDate(day.date);
    if (day.gradeLabel.startsWith("A")) {
      shoutOuts.push(`${dayLabel}: Achieved ${day.gradeLabel} grade (score: ${day.grade.toFixed(0)})`);
    }
    if (day.bonuses && day.bonuses.length > 0) {
      day.bonuses.forEach(b => {
        shoutOuts.push(`${dayLabel}: ${b.label} (+${b.points} bonus pts)`);
      });
    }
  });

  // Opportunity days (worst performing)
  const opportunityDays: string[] = [];
  [...grades]
    .sort((a, b) => a.grade - b.grade)
    .slice(0, 3)
    .forEach(day => {
      const dayLabel = formatDate(day.date);
      const issues: string[] = [];
      if (day.salesVariance < 0) issues.push(`sales ${day.salesVariance.toFixed(1)}%`);
      if (day.osatPercent !== undefined && day.osatPercent < 80) issues.push(`OSAT ${day.osatPercent.toFixed(0)}%`);
      if (day.avgSpeed !== undefined && day.avgSpeed < 50) issues.push(`speed ${Math.round(day.avgSpeed)}%`);
      if (day.staffingDiff < -2) issues.push(`understaffed by ${Math.abs(day.staffingDiff).toFixed(0)}`);
      opportunityDays.push(`${dayLabel} (${day.gradeLabel}): ${issues.length > 0 ? issues.join(", ") : "below avg performance"}`);
    });

  // Customer service analysis
  const osatDays = grades.filter(d => d.osatPercent !== undefined);
  const avgOsat = restaurant.avgOsat;
  const lowOsatDays = osatDays.filter(d => d.osatPercent! < 80);
  const highOsatDays = osatDays.filter(d => d.osatPercent! >= 90);

  // Speed analysis
  const speedDays = grades.filter(d => d.avgSpeed !== undefined);
  const lowSpeedDays = speedDays.filter(d => d.avgSpeed! < 50);

  // Staffing analysis
  const understaffedDays = grades.filter(d => d.staffingDiff < -2);

  // Compute sales badge from peak hourly rate across dayparts
  const RATE_TIERS = [
    { threshold: 2300, label: "LEGENDARY", emoji: "🏆" },
    { threshold: 2000, label: "ULTRA", emoji: "💎" },
    { threshold: 1500, label: "ELITE", emoji: "🔥" },
    { threshold: 1000, label: "PRO", emoji: "⭐" },
    { threshold: 750, label: "CONTENDER", emoji: "💪" },
  ];

  // Estimate peak hourly rate from daypart data or daily totals
  let peakHourlySales = 0;
  let peakDaypartLabel = "";
  let peakDay = "";
  grades.forEach(day => {
    if (day.daypartGrades) {
      day.daypartGrades.forEach(dp => {
        if (dp.hoursWithData > 0) {
          const hourlyRate = dp.sales / dp.hoursWithData;
          if (hourlyRate > peakHourlySales) {
            peakHourlySales = hourlyRate;
            peakDaypartLabel = dp.label;
            peakDay = day.date;
          }
        }
      });
    }
  });
  const salesBadge = RATE_TIERS.find(t => peakHourlySales >= t.threshold);

  // Build the agenda
  let agenda = "";
  agenda += "═══════════════════════════════════════════\n";
  agenda += "   RESTAURANT MANAGER MEETING (RMM) AGENDA\n";
  agenda += "═══════════════════════════════════════════\n\n";
  agenda += `Restaurant: ${restaurant.restaurantName}\n`;
  agenda += `Location: ${restaurant.state}${restaurant.marketName ? ` — ${restaurant.marketName}` : ""}\n`;
  agenda += `Review Period: ${startDate} – ${endDate}\n`;
  agenda += `Generated: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}\n`;
  if (salesBadge) {
    agenda += `Sales Badge: ${salesBadge.emoji} ${salesBadge.label} (${formatCurrency(peakHourlySales)}/hr peak — ${peakDaypartLabel}, ${formatDate(peakDay)})\n`;
  }
  agenda += "\n";

  // Section 1: Performance Summary
  agenda += "───────────────────────────────────────────\n";
  agenda += "1. PERFORMANCE SUMMARY (Last 8 Days)\n";
  agenda += "───────────────────────────────────────────\n\n";
  agenda += `  Overall Grade:        ${avgLabel} (${avgGradeNum.toFixed(1)})\n`;
  agenda += `  Total Sales:          ${totalSales}\n`;
  agenda += `  Avg Sales Variance:   ${avgVariance >= 0 ? "+" : ""}${avgVariance.toFixed(1)}%\n`;
  if (restaurant.avgSpeed !== undefined) {
    agenda += `  Speed Attainment:     ${Math.round(restaurant.avgSpeed)}%\n`;
  }
  if (avgOsat !== undefined) {
    agenda += `  OSAT:                 ${avgOsat.toFixed(0)}% (${restaurant.totalOsatResponses} responses)\n`;
  }
  if (restaurant.avgXp !== undefined) {
    agenda += `  Crew Avg XP:          ${restaurant.avgXp.toFixed(0)}\n`;
  }
  agenda += `  Trend:                ${restaurant.gradeImprovement > 0 ? "↑ Improving" : restaurant.gradeImprovement < 0 ? "↓ Declining" : "→ Stable"} (${restaurant.gradeImprovement > 0 ? "+" : ""}${restaurant.gradeImprovement} days)\n`;
  if (salesBadge) {
    agenda += `  Sales Badge:          ${salesBadge.emoji} ${salesBadge.label}\n`;
  }
  agenda += "\n";

  agenda += "  Daily Breakdown:\n";
  grades.forEach(day => {
    const dayLabel = formatDate(day.date);
    const bonus = day.bonusPoints && day.bonusPoints > 0 ? ` ★+${day.bonusPoints}` : "";
    agenda += `    ${dayLabel.padEnd(18)} ${day.gradeLabel.padEnd(4)} (${day.grade.toFixed(0).padStart(3)})  Sales: ${formatCurrency(day.totalSales).padStart(8)}  Var: ${(day.salesVariance >= 0 ? "+" : "") + day.salesVariance.toFixed(1) + "%"}${bonus}\n`;
  });
  agenda += "\n";

  // Section 2: Daypart Performance Breakdown
  agenda += "───────────────────────────────────────────\n";
  agenda += "2. DAYPART PERFORMANCE BREAKDOWN\n";
  agenda += "───────────────────────────────────────────\n\n";

  // Aggregate daypart data across all days in the period
  const daypartIds = ['earlybird', 'breakfast', 'lunch', 'snack', 'evening', 'evening_snack'];
  const daypartLabels: Record<string, string> = {
    earlybird: 'Earlybird (12a-6a)', breakfast: 'Breakfast (6a-11a)',
    lunch: 'Lunch (11a-3p)', snack: 'Snack (3p-5p)',
    evening: 'Evening (5p-8p)', evening_snack: 'Eve Snack (8p-12a)',
  };

  // Collect all daypart grades across all days
  const daypartAgg: Record<string, { scores: number[]; sales: number; lastWeekSales: number; osatPcts: { pct: number; resp: number }[]; speeds: number[]; staffDiffs: number[]; dayDetails: { date: string; grade: string; score: number; sales: number }[] }> = {};
  daypartIds.forEach(id => {
    daypartAgg[id] = { scores: [], sales: 0, lastWeekSales: 0, osatPcts: [], speeds: [], staffDiffs: [], dayDetails: [] };
  });

  grades.forEach(day => {
    if (!day.daypartGrades) return;
    day.daypartGrades.forEach(dp => {
      const agg = daypartAgg[dp.id];
      if (!agg) return;
      agg.scores.push(dp.score);
      agg.sales += dp.sales;
      if (dp.osatPercent !== undefined) agg.osatPcts.push({ pct: dp.osatPercent, resp: dp.osatResponses });
      if (dp.speedAttainment !== undefined) agg.speeds.push(dp.speedAttainment);
      agg.staffDiffs.push(dp.staffingDiff);
      agg.dayDetails.push({ date: day.date, grade: dp.gradeLabel, score: dp.score, sales: dp.sales });
    });
  });

  // Helper to get grade label from score
  const scoreToGrade = (s: number) => {
    if (s >= 97) return 'A+'; if (s >= 93) return 'A'; if (s >= 90) return 'A-';
    if (s >= 87) return 'B+'; if (s >= 83) return 'B'; if (s >= 80) return 'B-';
    if (s >= 77) return 'C+'; if (s >= 73) return 'C'; if (s >= 70) return 'C-';
    if (s >= 67) return 'D+'; if (s >= 63) return 'D'; if (s >= 60) return 'D-';
    return 'F';
  };

  // Summary table
  agenda += "  Daypart Summary (Period Avg):\n";
  agenda += "  ┌─────────────────────┬───────┬──────────┬──────────┬───────┐\n";
  agenda += "  │ Daypart             │ Grade │ Sales    │ Variance │ OSAT  │\n";
  agenda += "  ├─────────────────────┼───────┼──────────┼──────────┼───────┤\n";

  const activeDayparts: { id: string; label: string; avgScore: number; avgGrade: string }[] = [];
  daypartIds.forEach(id => {
    const agg = daypartAgg[id];
    if (agg.scores.length === 0) return;
    const avgScore = agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length;
    const avgGrade = scoreToGrade(avgScore);
    const totalSalesDP = agg.sales;
    const avgSalesVar = agg.dayDetails.length > 0 ? agg.scores.length : 0; // just for display
    // Compute actual sales variance from daypart aggregates across days
    let dpSalesVarDisplay = 0;
    const daysWithVar = grades.filter(g => g.daypartGrades?.some(dp => dp.id === id));
    const dpVars = daysWithVar.map(g => g.daypartGrades!.find(dp => dp.id === id)!.salesVariance).filter(v => v !== 0);
    if (dpVars.length > 0) dpSalesVarDisplay = dpVars.reduce((a, b) => a + b, 0) / dpVars.length;

    const totalOsatResp = agg.osatPcts.reduce((s, o) => s + o.resp, 0);
    const avgOsat = totalOsatResp > 0
      ? agg.osatPcts.reduce((s, o) => s + (o.pct / 100) * o.resp, 0) / totalOsatResp * 100
      : undefined;

    const label = daypartLabels[id] || id;
    const gradeStr = avgGrade.padEnd(3);
    const salesStr = formatCurrency(totalSalesDP).padStart(8);
    const varStr = ((dpSalesVarDisplay >= 0 ? "+" : "") + dpSalesVarDisplay.toFixed(1) + "%").padStart(8);
    const osatStr = avgOsat !== undefined ? (avgOsat.toFixed(0) + "%").padStart(5) : "  N/A";

    agenda += `  │ ${label.padEnd(19)} │ ${gradeStr}   │ ${salesStr} │ ${varStr} │ ${osatStr} │\n`;
    activeDayparts.push({ id, label, avgScore, avgGrade });
  });
  agenda += "  └─────────────────────┴───────┴──────────┴──────────┴───────┘\n\n";

  // Identify strongest and weakest dayparts
  if (activeDayparts.length > 1) {
    const sorted = [...activeDayparts].sort((a, b) => b.avgScore - a.avgScore);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];
    agenda += `  ★ Strongest Daypart:  ${strongest.label} (${strongest.avgGrade})\n`;
    agenda += `  ⚠ Weakest Daypart:   ${weakest.label} (${weakest.avgGrade})\n\n`;
  }

  // Per-daypart daily breakdown (useful for shift leaders)
  agenda += "  Daily Daypart Detail:\n";
  activeDayparts.forEach(dp => {
    const agg = daypartAgg[dp.id];
    agenda += `\n    ${dp.label}:\n`;
    agg.dayDetails.forEach(d => {
      const dayLabel = formatDate(d.date);
      agenda += `      ${dayLabel.padEnd(18)} ${d.grade.padEnd(4)} (${d.score.toFixed(0).padStart(3)})  Sales: ${formatCurrency(d.sales).padStart(7)}\n`;
    });
  });
  agenda += "\n";

  // Section 3: Leader Rankings
  agenda += "───────────────────────────────────────────\n";
  agenda += "3. LEADER RANKINGS (Same Period)\n";
  agenda += "───────────────────────────────────────────\n\n";

  if (leaders.length > 0) {
    agenda += "  ┌────┬─────────────────────────┬───────┬───────┬────────┬──────┬───────┐\n";
    agenda += "  │ #  │ Name                    │ Grade │ Hrs   │ $/HR   │ SOS  │ OSAT  │\n";
    agenda += "  ├────┼─────────────────────────┼───────┼───────┼────────┼──────┼───────┤\n";
    leaders.forEach((l, i) => {
      const rank = String(i + 1).padStart(2);
      const name = l.name.length > 23 ? l.name.slice(0, 22) + "…" : l.name.padEnd(23);
      const grade = l.grade.padEnd(3);
      const hrs = l.hoursWorked.toFixed(0).padStart(5);
      const sales = l.avgHourlySales != null ? ("$" + l.avgHourlySales.toFixed(0)).padStart(6) : "   N/A";
      const speed = l.avgSpeed != null ? (l.avgSpeed.toFixed(0) + "%").padStart(4) : " N/A";
      const osat = l.osatPercent != null ? (l.osatPercent.toFixed(0) + "%").padStart(4) : " N/A";
      const coRank = l.companyRankDisplay ? ` (Co #${l.companyRankDisplay})` : "";
      agenda += `  │ ${rank} │ ${name} │ ${grade}   │ ${hrs} │ ${sales} │ ${speed} │ ${osat}  │${coRank}\n`;
    });
    agenda += "  └────┴─────────────────────────┴───────┴───────┴────────┴──────┴───────┘\n\n";

    // Best and worst leaders
    const sortedLeaders = [...leaders].sort((a, b) => b.avgGradeScore - a.avgGradeScore);
    if (sortedLeaders.length > 1) {
      const top = sortedLeaders[0];
      const bottom = sortedLeaders[sortedLeaders.length - 1];
      agenda += `  ★ Top Leader:     ${top.name} — ${top.grade} (${top.avgGradeScore.toFixed(0)})\n`;
      if (bottom.avgGradeScore < 80) {
        agenda += `  ⚠ Needs Coaching: ${bottom.name} — ${bottom.grade} (${bottom.avgGradeScore.toFixed(0)})\n`;
      }
      agenda += "\n";
    }
  } else {
    agenda += "  No leader ranking data available for this period.\n\n";
  }

  // Section 4: Leader Shout-Outs
  agenda += "───────────────────────────────────────────\n";
  agenda += "4. LEADER SHOUT-OUTS & WINS\n";
  agenda += "───────────────────────────────────────────\n\n";
  if (shoutOuts.length > 0) {
    shoutOuts.forEach(s => {
      agenda += `  ★ ${s}\n`;
    });
  } else {
    agenda += "  No A-grade days or bonuses this period.\n";
    if (bestDays.length > 0) {
      agenda += `  Best performance: ${formatDate(bestDays[0].date)} with ${bestDays[0].gradeLabel} (${bestDays[0].grade.toFixed(0)})\n`;
    }
  }
  agenda += "\n";

  // Section 5: Opportunity Day Parts
  agenda += "───────────────────────────────────────────\n";
  agenda += "5. OPPORTUNITY AREAS & WEAK DAYS\n";
  agenda += "───────────────────────────────────────────\n\n";
  if (opportunityDays.length > 0) {
    agenda += "  Lowest Performing Days:\n";
    opportunityDays.forEach(d => {
      agenda += `  ⚠ ${d}\n`;
    });
  }
  if (weakDays.length > 0) {
    agenda += `\n  D/F Grade Days: ${weakDays.length} of ${grades.length} days\n`;
  }
  if (cDays.length > 0) {
    agenda += `  C Grade Days:   ${cDays.length} of ${grades.length} days\n`;
  }
  agenda += "\n";

  // Section 6: Customer Service
  agenda += "───────────────────────────────────────────\n";
  agenda += "6. CUSTOMER SERVICE (OSAT)\n";
  agenda += "───────────────────────────────────────────\n\n";
  if (avgOsat !== undefined) {
    agenda += `  Average OSAT:    ${avgOsat.toFixed(0)}% (${restaurant.totalOsatResponses} total responses)\n`;
    agenda += `  Target:          85%+\n`;
    agenda += `  Status:          ${avgOsat >= 85 ? "✓ Meeting target" : avgOsat >= 80 ? "⚠ Close to target — push for improvement" : "✗ Below target — needs immediate focus"}\n\n`;
    if (highOsatDays.length > 0) {
      agenda += `  High OSAT Days (90%+): ${highOsatDays.length}\n`;
      highOsatDays.forEach(d => {
        agenda += `    ✓ ${formatDate(d.date)}: ${d.osatPercent!.toFixed(0)}% (${d.osatResponses || 0} responses)\n`;
      });
    }
    if (lowOsatDays.length > 0) {
      agenda += `  Low OSAT Days (<80%): ${lowOsatDays.length}\n`;
      lowOsatDays.forEach(d => {
        agenda += `    ✗ ${formatDate(d.date)}: ${d.osatPercent!.toFixed(0)}% (${d.osatResponses || 0} responses)\n`;
      });
    }
  } else {
    agenda += "  No OSAT data available for this period.\n";
  }
  agenda += "\n";

  // Section 7: Speed of Service & B-Lane
  agenda += "───────────────────────────────────────────\n";
  agenda += "7. SPEED OF SERVICE & B-LANE\n";
  agenda += "───────────────────────────────────────────\n\n";
  if (restaurant.avgSpeed !== undefined) {
    agenda += `  Avg Speed Attainment: ${Math.round(restaurant.avgSpeed)}%\n`;
    agenda += `  Target:               70%+\n`;
    agenda += `  Status:               ${restaurant.avgSpeed >= 70 ? "✓ Meeting target" : restaurant.avgSpeed >= 50 ? "⚠ Needs improvement" : "✗ Critical — below 50%"}\n`;
    if (lowSpeedDays.length > 0) {
      agenda += `\n  Low Speed Days (<50%):\n`;
      lowSpeedDays.forEach(d => {
        agenda += `    ✗ ${formatDate(d.date)}: ${Math.round(d.avgSpeed!)}%\n`;
      });
    }
  } else {
    agenda += "  No speed data available for this period.\n";
  }

  // B-Lane (OOT/dt3) hours
  const bLaneDays = grades.filter(d => d.bLaneHours && d.bLaneHours > 0);
  const totalBLaneHours = bLaneDays.reduce((sum, d) => sum + (d.bLaneHours || 0), 0);
  if (totalBLaneHours > 0) {
    agenda += `\n  B-Lane (Outside Lane) Activity:\n`;
    agenda += `  Total B-Lane Hours:   ${totalBLaneHours} hrs across ${bLaneDays.length} day(s)\n`;
    bLaneDays.forEach(d => {
      agenda += `    ${formatDate(d.date).padEnd(18)} ${d.bLaneHours} hr(s) with B-lane active\n`;
    });
    agenda += "  Note: Speed grading is excluded during B-lane hours\n";
  }
  agenda += "\n";

  // Section 8: Staffing
  agenda += "───────────────────────────────────────────\n";
  agenda += "8. STAFFING & CREW\n";
  agenda += "───────────────────────────────────────────\n\n";
  agenda += `  Avg Staffing Diff:  ${restaurant.avgStaffingDiff >= 0 ? "+" : ""}${restaurant.avgStaffingDiff.toFixed(1)}\n`;
  if (restaurant.avgXp !== undefined) {
    agenda += `  Crew Avg XP:        ${restaurant.avgXp.toFixed(0)} / 100\n`;
    agenda += `  XP Status:          ${restaurant.avgXp >= 75 ? "✓ Experienced crew" : restaurant.avgXp >= 50 ? "⚠ Moderate experience" : "✗ Inexperienced — consider mentorship"}\n`;
  }
  if (understaffedDays.length > 0) {
    agenda += `\n  Understaffed Days (diff < -2): ${understaffedDays.length}\n`;
    understaffedDays.forEach(d => {
      agenda += `    ⚠ ${formatDate(d.date)}: ${d.staffingDiff.toFixed(1)} staff difference\n`;
    });
  }
  agenda += "\n";

  // Section 9: Attachment Rate / Upsell Metrics
  const { attachment, anniversaries } = extras;
  agenda += "───────────────────────────────────────────\n";
  agenda += "9. ATTACHMENT RATE & UPSELL METRICS\n";
  agenda += "───────────────────────────────────────────\n\n";

  if (attachment && attachment.totalOrders > 0) {
    agenda += `  Total Orders Analyzed:  ${attachment.totalOrders.toLocaleString()}\n`;
    agenda += `  Check Average:          ${formatCurrency(attachment.checkAverage)}\n`;
    agenda += `  Overall Attach Score:   ${attachment.overallAttachScore.toFixed(0)}%\n\n`;

    const categoryLabels: Record<string, string> = {
      cheese: 'Cheese', bacon: 'Bacon', jalapenos: 'Jalapeños',
      dipping_sauces: 'Dipping Sauces', desserts: 'Desserts', whatasize: 'Whatasize',
    };
    const benchmarks: Record<string, number> = {
      cheese: 30, bacon: 20, jalapenos: 15, dipping_sauces: 35, desserts: 20, whatasize: 30,
    };

    agenda += "  ┌──────────────────┬──────────┬──────────┬──────────┐\n";
    agenda += "  │ Category         │ Actual   │ Target   │ vs Tgt   │\n";
    agenda += "  ├──────────────────┼──────────┼──────────┼──────────┤\n";
    for (const [key, cat] of Object.entries(attachment.categories)) {
      const label = (categoryLabels[key] || key).padEnd(16);
      const actual = (cat.attachRate.toFixed(1) + "%").padStart(7);
      const target = (benchmarks[key] !== undefined ? benchmarks[key] + "%" : "N/A").padStart(7);
      const vs = cat.vsTarget >= 0 ? ("+" + cat.vsTarget.toFixed(1) + "%").padStart(8) : (cat.vsTarget.toFixed(1) + "%").padStart(8);
      agenda += `  │ ${label} │ ${actual}  │ ${target}  │ ${vs} │\n`;
    }
    agenda += "  └──────────────────┴──────────┴──────────┴──────────┘\n\n";

    // Highlight categories below target
    const belowTarget = Object.entries(attachment.categories).filter(([, cat]) => cat.vsTarget < -5);
    if (belowTarget.length > 0) {
      agenda += "  ⚠ Below Target:\n";
      belowTarget.forEach(([key, cat]) => {
        agenda += `    • ${categoryLabels[key] || key}: ${cat.attachRate.toFixed(1)}% (${cat.vsTarget.toFixed(1)}% vs target)\n`;
      });
      agenda += "\n";
    }
    const aboveTarget = Object.entries(attachment.categories).filter(([, cat]) => cat.vsTarget > 5);
    if (aboveTarget.length > 0) {
      agenda += "  ★ Above Target:\n";
      aboveTarget.forEach(([key, cat]) => {
        agenda += `    • ${categoryLabels[key] || key}: ${cat.attachRate.toFixed(1)}% (+${cat.vsTarget.toFixed(1)}% vs target)\n`;
      });
      agenda += "\n";
    }
  } else {
    agenda += "  No attachment rate data available (requires POS integration).\n\n";
  }

  // Section 10: Upcoming Team Anniversaries
  agenda += "───────────────────────────────────────────\n";
  agenda += "10. UPCOMING TEAM ANNIVERSARIES (Next 7 Days)\n";
  agenda += "───────────────────────────────────────────\n\n";

  if (anniversaries && anniversaries.length > 0) {
    anniversaries.forEach(a => {
      const annivDate = new Date(a.anniversaryDate + "T12:00:00Z");
      const dateLabel = annivDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const yearsLabel = a.yearsCompleted === 1 ? "1 year" : `${a.yearsCompleted} years`;
      const daysLabel = a.daysUntil === 0 ? "TODAY" : a.daysUntil === 1 ? "Tomorrow" : `in ${a.daysUntil} days`;
      agenda += `  🎂 ${a.name} (${a.position}) — ${yearsLabel} on ${dateLabel} (${daysLabel})\n`;
    });
    agenda += "\n  → Consider recognition: card, announcement, or small celebration\n";
  } else {
    agenda += "  No upcoming team anniversaries in the next 7 days.\n";
  }
  agenda += "\n";

  // Section 11: Action Items
  agenda += "═══════════════════════════════════════════\n";
  agenda += "11. ACTION ITEMS (Next 7 Days)\n";
  agenda += "═══════════════════════════════════════════\n\n";

  let actionNum = 1;

  // Grade-based actions
  if (avgGradeNum < 70) {
    agenda += `  ${actionNum}. [ ] CRITICAL: Overall grade below C — schedule daily check-ins with management team\n`;
    actionNum++;
  } else if (avgGradeNum < 80) {
    agenda += `  ${actionNum}. [ ] Focus on moving from ${avgLabel} to B-range — identify top 2 areas for quick improvement\n`;
    actionNum++;
  }

  // OSAT actions
  if (avgOsat !== undefined && avgOsat < 85) {
    agenda += `  ${actionNum}. [ ] Improve OSAT from ${avgOsat.toFixed(0)}% toward 85% target — review customer feedback and coach team on service standards\n`;
    actionNum++;
  }

  // Speed actions
  if (restaurant.avgSpeed !== undefined && restaurant.avgSpeed < 70) {
    agenda += `  ${actionNum}. [ ] Improve speed attainment from ${Math.round(restaurant.avgSpeed)}% — review drive-thru processes and positioning\n`;
    actionNum++;
  }

  // Staffing actions
  if (understaffedDays.length >= 2) {
    agenda += `  ${actionNum}. [ ] Address recurring understaffing (${understaffedDays.length} days below target) — review upcoming schedule and adjust\n`;
    actionNum++;
  }

  // Sales actions
  if (avgVariance < -3) {
    agenda += `  ${actionNum}. [ ] Sales trending ${avgVariance.toFixed(1)}% below last week — implement suggestive selling initiatives\n`;
    actionNum++;
  }

  // XP actions
  if (restaurant.avgXp !== undefined && restaurant.avgXp < 50) {
    agenda += `  ${actionNum}. [ ] Low crew experience (XP: ${restaurant.avgXp.toFixed(0)}) — assign mentors and prioritize training\n`;
    actionNum++;
  }

  // Trend actions
  if (restaurant.gradeImprovement < -1) {
    agenda += `  ${actionNum}. [ ] Declining trend (${restaurant.gradeImprovement} days) — identify root causes and develop recovery plan\n`;
    actionNum++;
  }

  // Weak day actions
  if (weakDays.length > 0) {
    const weakDayNames = weakDays.map(d => {
      const name = formatDate(d.date).split(",")[0];
      return name;
    }).join(", ");
    agenda += `  ${actionNum}. [ ] Focus on historically weak days (${weakDayNames}) — ensure strongest team members are scheduled\n`;
    actionNum++;
  }

  // Weakest daypart action
  if (activeDayparts.length > 1) {
    const sortedDp = [...activeDayparts].sort((a, b) => a.avgScore - b.avgScore);
    const weakestDp = sortedDp[0];
    if (weakestDp.avgScore < 80) {
      agenda += `  ${actionNum}. [ ] Improve weakest daypart: ${weakestDp.label} (${weakestDp.avgGrade}) — review shift coverage, prep, and positioning for this daypart\n`;
      actionNum++;
    }
  }

  // Attachment rate actions
  if (attachment && attachment.totalOrders > 0) {
    const belowTargetCats = Object.entries(attachment.categories).filter(([, cat]) => cat.vsTarget < -5);
    if (belowTargetCats.length > 0) {
      const catNames = belowTargetCats.map(([key]) => {
        const labels: Record<string, string> = { cheese: 'Cheese', bacon: 'Bacon', jalapenos: 'Jalapeños', dipping_sauces: 'Dipping Sauces', desserts: 'Desserts', whatasize: 'Whatasize' };
        return labels[key] || key;
      }).join(", ");
      agenda += `  ${actionNum}. [ ] Improve upsell/attachment for: ${catNames} — coach suggestive selling during pre-shift\n`;
      actionNum++;
    }
  }

  // Anniversary recognition
  if (anniversaries && anniversaries.length > 0) {
    const names = anniversaries.map(a => a.name).join(", ");
    agenda += `  ${actionNum}. [ ] Celebrate upcoming anniversary(s): ${names}\n`;
    actionNum++;
  }

  // Always add a follow-up item
  agenda += `  ${actionNum}. [ ] Review progress at next RMM and update action items\n`;
  actionNum++;

  // Shout-out continuation
  if (shoutOuts.length > 0) {
    agenda += `  ${actionNum}. [ ] Recognize team for ${shoutOuts.length} achievement(s) — share wins in pre-shift meetings\n`;
  }

  agenda += "\n───────────────────────────────────────────\n";
  agenda += "  Notes / Additional Discussion:\n\n\n\n";
  agenda += "───────────────────────────────────────────\n";
  agenda += "  Next Meeting Date: ___________________\n\n";

  return agenda;
}

function RMMAgendaDialog({ restaurant, dateRange, open, onOpenChange }: {
  restaurant: RestaurantHistory;
  dateRange: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  // Fetch leader data for this restaurant over the same period
  const endDate = dateRange.length > 0 ? dateRange[dateRange.length - 1] : undefined;
  const numDays = dateRange.length || 7;
  const { data: leaderData } = useQuery({
    queryKey: ["/api/leaders", endDate, numDays],
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(numDays) });
      if (endDate) params.set("date", endDate);
      const res = await fetch(`/api/leaders?${params}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: open,
  });

  // Fetch attachment rates for the most recent day in range
  const { data: attachmentData } = useQuery({
    queryKey: ["/api/pos/attachment-rates", endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (endDate) params.set("date", endDate);
      const res = await fetch(`/api/pos/attachment-rates?${params}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: open,
  });

  // Fetch upcoming employee anniversaries (next 7 days)
  const { data: anniversaryData } = useQuery({
    queryKey: ["/api/analytics/anniversaries", 7],
    queryFn: async () => {
      const res = await fetch("/api/analytics/anniversaries?days=7");
      if (!res.ok) return null;
      return res.json();
    },
    enabled: open,
  });

  // Extract leaders for this specific restaurant
  const storeLeaders: LeaderRanking[] = useMemo(() => {
    if (!leaderData?.storeEntries) return [];
    const storeEntry = leaderData.storeEntries.find(
      (s: { restaurantId: string }) => s.restaurantId === restaurant.restaurantId
    );
    return storeEntry?.leaders || [];
  }, [leaderData, restaurant.restaurantId]);

  // Extract attachment rates for this restaurant
  const storeAttachment = useMemo(() => {
    if (!attachmentData?.restaurants) return null;
    return attachmentData.restaurants[restaurant.restaurantId] || null;
  }, [attachmentData, restaurant.restaurantId]);

  // Extract anniversaries for this restaurant
  const storeAnniversaries = useMemo(() => {
    if (!anniversaryData?.anniversaries) return [];
    return anniversaryData.anniversaries.filter(
      (a: { restaurantId: string | null }) => a.restaurantId === restaurant.restaurantId
    );
  }, [anniversaryData, restaurant.restaurantId]);

  const agenda = useMemo(() => generateRMMAgenda(restaurant, dateRange, storeLeaders, {
    attachment: storeAttachment,
    anniversaries: storeAnniversaries,
  }), [restaurant, dateRange, storeLeaders, storeAttachment, storeAnniversaries]);

  const handleCopySelection = useCallback(async () => {
    const selection = window.getSelection()?.toString();
    if (selection && selection.trim()) {
      await navigator.clipboard.writeText(selection);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(agenda);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [agenda]);

  const handlePrint = useCallback(() => {
    const printWindow = window.open("", "_blank");
    if (printWindow) {
      printWindow.document.write(`
        <html>
          <head>
            <title>RMM Agenda — ${restaurant.restaurantName}</title>
            <style>
              body { font-family: "Courier New", monospace; font-size: 12px; padding: 20px; white-space: pre-wrap; line-height: 1.4; }
              @media print { body { padding: 0; } }
            </style>
          </head>
          <body>${agenda.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</body>
        </html>
      `);
      printWindow.document.close();
      printWindow.print();
    }
  }, [agenda, restaurant.restaurantName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            RMM Agenda — {restaurant.restaurantName}
          </DialogTitle>
          <DialogDescription>
            Restaurant Manager Meeting agenda based on the last {dateRange.length} days of performance data. Select text to copy specific sections.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 mb-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
            {copied ? "Copied!" : "Copy All"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopySelection}>
            <Copy className="w-4 h-4 mr-1" />
            Copy Selection
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrint}>
            <Printer className="w-4 h-4 mr-1" />
            Print
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto border rounded-md select-text cursor-text">
          <pre className="p-4 text-xs leading-relaxed whitespace-pre-wrap font-mono select-text">{agenda}</pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GradeTimeline({ grades }: { grades: DailyGrade[] }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {grades.map((grade, idx) => {
        const formatted = formatDate(grade.date);
        const dayName = formatted.split(",")[0];
        const datePart = formatted.split(",")[1]?.trim() || "";
        const hasBonuses = grade.bonuses && grade.bonuses.length > 0;

        const gradeCell = (
          <div
            key={idx}
            className={`flex flex-col items-center p-1.5 rounded ${getGradeBgColor(grade.gradeLabel)} min-w-[50px] relative`}
            title={`${formatted}: ${grade.gradeLabel} (${grade.grade.toFixed(0)})${hasBonuses ? ` | +${grade.bonusPoints} bonus` : ""}${grade.weather ? ` | ${grade.weather.condition} ${Math.round(grade.weather.highTemp)}°/${Math.round(grade.weather.lowTemp)}°` : ""}${grade.avgXp !== undefined ? ` | XP: ${Math.round(grade.avgXp)}` : ""}`}
          >
            <span className="text-[10px] text-muted-foreground">{dayName}</span>
            <div className="flex items-center gap-0.5">
              <span className={`text-sm font-bold ${getGradeColor(grade.gradeLabel)}`}>{grade.gradeLabel}</span>
              {hasBonuses && (
                <Sparkles className="w-2.5 h-2.5 text-amber-500" />
              )}
            </div>
            <span className="text-[9px] text-muted-foreground">{datePart}</span>
            {(grade.weather || grade.avgXp !== undefined) && (
              <div className="flex items-center gap-1 mt-0.5">
                {grade.weather && (
                  <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                    <WeatherIcon condition={grade.weather.condition} className="w-2.5 h-2.5" />
                    {Math.round(grade.weather.highTemp)}°
                  </span>
                )}
                {grade.avgXp !== undefined && (
                  <span className={`flex items-center gap-0.5 text-[9px] ${grade.avgXp >= 75 ? "text-green-600" : grade.avgXp >= 50 ? "text-amber-600" : "text-red-500"}`}>
                    <GraduationCap className="w-2.5 h-2.5" />
                    {Math.round(grade.avgXp)}
                  </span>
                )}
              </div>
            )}
          </div>
        );

        if (hasBonuses) {
          return (
            <Popover key={idx}>
              <PopoverTrigger asChild>
                <span
                  className="inline-flex cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {gradeCell}
                </span>
              </PopoverTrigger>
              <PopoverContent side="top" className="w-auto max-w-[280px] p-2 text-xs">
                <div className="font-medium flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-amber-500" />
                  Bonus Points Earned
                </div>
                <div className="space-y-0.5 mt-1">
                  {grade.bonuses!.map((b) => (
                    <div key={b.id} className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{b.label}</span>
                      <span className="text-yellow-500 font-semibold">+{b.points}</span>
                    </div>
                  ))}
                </div>
                {grade.baseGrade !== undefined && (
                  <div className="text-muted-foreground border-t mt-1 pt-1">
                    Base: {grade.baseGrade.toFixed(0)} → Final: {grade.grade.toFixed(0)}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          );
        }

        return gradeCell;
      })}
    </div>
  );
}

function DeltaBadge({ value, suffix = "", invert = false }: { value: number; suffix?: string; invert?: boolean }) {
  const isPositive = invert ? value < 0 : value > 0;
  const isNegative = invert ? value > 0 : value < 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${isPositive ? "text-green-600" : isNegative ? "text-red-600" : "text-muted-foreground"}`}>
      {value > 0 ? <TrendingUp className="w-2.5 h-2.5" /> : value < 0 ? <TrendingDown className="w-2.5 h-2.5" /> : null}
      {value > 0 ? "+" : ""}{value}{suffix}
    </span>
  );
}

function WeekendDayCard({ day }: { day: WeekendDaySummary }) {
  return (
    <div className="p-3 rounded-lg border bg-card" data-testid={`card-weekend-day-${day.day.toLowerCase()}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold">{day.day}</span>
        <span className="text-[10px] text-muted-foreground">{day.dayCount} day{day.dayCount !== 1 ? "s" : ""}</span>
      </div>
      <div className={`text-2xl font-bold mb-2 ${getGradeColor(day.avgGradeLabel)}`}>
        {day.avgGradeLabel}
        <span className="text-xs font-normal text-muted-foreground ml-1">({day.avgGrade.toFixed(0)})</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div>
          <span className="text-muted-foreground">Sales</span>
          <div className="font-medium">{formatCurrency(day.totalSales)}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Variance</span>
          <div className={`font-medium ${day.avgSalesVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
            {day.avgSalesVariance >= 0 ? "+" : ""}{day.avgSalesVariance.toFixed(1)}%
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Speed</span>
          <div className={`font-medium ${day.avgSpeed !== undefined ? (day.avgSpeed >= 70 ? "text-green-600" : day.avgSpeed >= 50 ? "text-yellow-600" : "text-red-600") : ""}`}>
            {day.avgSpeed !== undefined ? `${day.avgSpeed}%` : "N/A"}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">OSAT</span>
          <div className={`font-medium ${day.avgOsat !== undefined ? (day.avgOsat >= 85 ? "text-green-600" : day.avgOsat >= 80 ? "text-yellow-600" : "text-red-600") : ""}`}>
            {day.avgOsat !== undefined ? `${day.avgOsat}%` : "N/A"}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Staff Diff</span>
          <div className="font-medium">
            {day.avgStaffingDiff >= 0 ? "+" : ""}{day.avgStaffingDiff}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Upsell</span>
          <div className={`font-medium ${day.avgAttachScore !== undefined ? (day.avgAttachScore >= 90 ? "text-green-600" : day.avgAttachScore >= 70 ? "text-yellow-600" : "text-red-600") : ""}`}>
            {day.avgAttachScore !== undefined ? `${day.avgAttachScore}%` : "N/A"}
          </div>
        </div>
      </div>
    </div>
  );
}

function WeekendScorecardSection({ weekend, restaurant }: { weekend: WeekendData; restaurant: RestaurantHistory }) {
  return (
    <div className="space-y-3 pt-2" data-testid={`section-weekend-scorecard-${restaurant.restaurantId}`}>
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4 text-orange-500" />
        <h4 className="text-sm font-semibold">Weekend Scorecard</h4>
        <Badge variant="secondary" className="text-[10px]">{weekend.weekendDayCount} days</Badge>
      </div>

      <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
        <div>
          <div className={`text-2xl font-bold ${getGradeColor(weekend.weekendGradeLabel)}`}>
            {weekend.weekendGradeLabel}
          </div>
          <div className="text-[10px] text-muted-foreground">Weekend Avg ({weekend.weekendGrade.toFixed(0)})</div>
        </div>
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <span className="text-muted-foreground">vs Overall</span>
            <div className="font-medium"><DeltaBadge value={weekend.overallGradeDelta} suffix=" pts" /></div>
          </div>
          <div>
            <span className="text-muted-foreground">Sales Var Δ</span>
            <div className="font-medium"><DeltaBadge value={weekend.overallSalesVarianceDelta} suffix="%" /></div>
          </div>
          {weekend.overallSpeedDelta !== undefined && (
            <div>
              <span className="text-muted-foreground">Speed Δ</span>
              <div className="font-medium"><DeltaBadge value={weekend.overallSpeedDelta} suffix="%" /></div>
            </div>
          )}
          {weekend.overallOsatDelta !== undefined && (
            <div>
              <span className="text-muted-foreground">OSAT Δ</span>
              <div className="font-medium"><DeltaBadge value={weekend.overallOsatDelta} suffix="%" /></div>
            </div>
          )}
          {weekend.weekendAvgAttachScore !== undefined && (
            <div>
              <span className="text-muted-foreground">Upsell</span>
              <div className={`font-medium ${weekend.weekendAvgAttachScore >= 90 ? "text-green-600" : weekend.weekendAvgAttachScore >= 70 ? "text-yellow-600" : "text-red-600"}`}>
                {weekend.weekendAvgAttachScore}%
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {weekend.perDay.map(day => (
          <WeekendDayCard key={day.day} day={day} />
        ))}
      </div>
    </div>
  );
}

function RestaurantCard({ restaurant, dateRange }: { restaurant: RestaurantHistory; dateRange: string[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [rmmOpen, setRmmOpen] = useState(false);

  return (
    <Card className="mb-3">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover-elevate py-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className={`text-2xl font-bold ${getGradeColor(restaurant.avgGradeLabel)}`}>
                  {restaurant.avgGradeLabel}
                </div>
                <div>
                  <h3 className="font-semibold" data-testid={`text-restaurant-name-${restaurant.restaurantId}`}>
                    {restaurant.restaurantName}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{restaurant.state}</span>
                    {restaurant.marketName && (
                      <>
                        <span>•</span>
                        <span>{restaurant.marketName}</span>
                      </>
                    )}
                  </div>
                </div>
                {restaurant.weekend && (
                  <div className={`flex flex-col items-center px-2 py-1 rounded-md border ${getGradeBgColor(restaurant.weekend.weekendGradeLabel)}`} data-testid={`badge-weekend-grade-${restaurant.restaurantId}`}>
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Wknd</span>
                    <span className={`text-sm font-bold ${getGradeColor(restaurant.weekend.weekendGradeLabel)}`}>{restaurant.weekend.weekendGradeLabel}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-right">
                  <div className="text-sm font-medium">{formatCurrency(restaurant.totalSales)}</div>
                  <div className="text-xs text-muted-foreground">Total Sales</div>
                </div>
                <div className="text-right">
                  <div className={`text-sm font-medium ${restaurant.avgSalesVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {restaurant.avgSalesVariance >= 0 ? "+" : ""}{restaurant.avgSalesVariance.toFixed(1)}%
                  </div>
                  <div className="text-xs text-muted-foreground">Avg Variance</div>
                </div>
                {restaurant.avgOsat !== undefined && (
                  <div className="text-right">
                    <div className={`text-sm font-medium ${restaurant.avgOsat >= 85 ? "text-green-600" : restaurant.avgOsat >= 80 ? "text-yellow-600" : "text-red-600"}`}>
                      {restaurant.avgOsat.toFixed(0)}%
                    </div>
                    <div className="text-xs text-muted-foreground">OSAT</div>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <TrendIndicator value={restaurant.gradeImprovement} />
                  <span className={`text-xs font-medium ${restaurant.gradeImprovement > 0 ? "text-green-600" : restaurant.gradeImprovement < 0 ? "text-red-600" : "text-muted-foreground"}`}>
                    {restaurant.gradeImprovement !== 0
                      ? `${restaurant.gradeImprovement > 0 ? "+" : ""}${restaurant.gradeImprovement}`
                      : "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">Trend</span>
                </div>
                {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Daily Grade History</h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRmmOpen(true);
                  }}
                >
                  <ClipboardList className="w-4 h-4 mr-1.5" />
                  RMM Agenda
                </Button>
              </div>
              <GradeTimeline grades={restaurant.dailyGrades} />

              <RMMAgendaDialog
                restaurant={restaurant}
                dateRange={dateRange}
                open={rmmOpen}
                onOpenChange={setRmmOpen}
              />

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Target className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Avg Grade</span>
                  </div>
                  <div className={`text-lg font-bold ${getGradeColor(restaurant.avgGradeLabel)}`}>
                    {restaurant.avgGrade.toFixed(1)} ({restaurant.avgGradeLabel})
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Total Sales</span>
                  </div>
                  <div className="text-lg font-bold">{formatCurrency(restaurant.totalSales)}</div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Speed Att.</span>
                  </div>
                  <div className={`text-lg font-bold ${restaurant.avgSpeed !== undefined ? (restaurant.avgSpeed >= 70 ? "text-green-600" : restaurant.avgSpeed >= 50 ? "text-yellow-600" : "text-red-600") : ""}`}>
                    {restaurant.avgSpeed !== undefined ? `${Math.round(restaurant.avgSpeed)}%` : "N/A"}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <ThumbsUp className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">OSAT</span>
                  </div>
                  <div className="text-lg font-bold">
                    {restaurant.avgOsat !== undefined ? `${restaurant.avgOsat.toFixed(0)}%` : "N/A"}
                    {restaurant.totalOsatResponses > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">({restaurant.totalOsatResponses})</span>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Avg XP</span>
                  </div>
                  <div className={`text-lg font-bold ${restaurant.avgXp !== undefined ? (restaurant.avgXp >= 85 ? "text-green-600" : restaurant.avgXp >= 70 ? "text-yellow-600" : restaurant.avgXp >= 50 ? "text-orange-600" : "text-red-600") : ""}`}>
                    {restaurant.avgXp !== undefined ? `${restaurant.avgXp.toFixed(0)}` : "N/A"}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Trend Days</span>
                  </div>
                  <div className={`text-lg font-bold ${restaurant.gradeImprovement > 0 ? "text-green-600" : restaurant.gradeImprovement < 0 ? "text-red-600" : ""}`}>
                    {restaurant.gradeImprovement !== 0
                      ? `${restaurant.gradeImprovement > 0 ? "+" : ""}${restaurant.gradeImprovement}`
                      : "—"}
                    <span className="text-xs text-muted-foreground ml-1">
                      {restaurant.gradeImprovement !== 0
                        ? `day${Math.abs(restaurant.gradeImprovement) !== 1 ? "s" : ""}`
                        : ""}
                    </span>
                  </div>
                </div>
              </div>

              {restaurant.weekend && (
                <WeekendScorecardSection weekend={restaurant.weekend} restaurant={restaurant} />
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function WeekendRollupCard({ title, icon: Icon, rollup }: { title: string; icon: typeof Globe; rollup: WeekendRollup }) {
  return (
    <Card data-testid={`card-weekend-rollup-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-orange-500" />
            <CardTitle className="text-sm">{title}</CardTitle>
          </div>
          <Badge variant="secondary" className="text-[10px]">{rollup.restaurantCount} units</Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={`text-2xl font-bold ${getGradeColor(rollup.avgGradeLabel)}`}>{rollup.avgGradeLabel}</div>
            <div className="text-[10px] text-muted-foreground">Avg Grade ({rollup.avgGrade.toFixed(0)})</div>
          </div>
          <div>
            <div className="text-base font-semibold">{formatCurrency(rollup.totalSales)}</div>
            <div className="text-[10px] text-muted-foreground">Wknd Sales</div>
          </div>
          <div>
            <div className={`text-sm font-semibold ${rollup.avgSalesVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
              {rollup.avgSalesVariance >= 0 ? "+" : ""}{rollup.avgSalesVariance}%
            </div>
            <div className="text-[10px] text-muted-foreground">Avg Variance</div>
          </div>
          {rollup.avgOsat !== undefined && (
            <div>
              <div className={`text-sm font-semibold ${rollup.avgOsat >= 85 ? "text-green-600" : rollup.avgOsat >= 80 ? "text-yellow-600" : "text-red-600"}`}>
                {rollup.avgOsat}%
              </div>
              <div className="text-[10px] text-muted-foreground">OSAT</div>
            </div>
          )}
          {rollup.avgAttachScore !== undefined && (
            <div>
              <div className={`text-sm font-semibold ${rollup.avgAttachScore >= 90 ? "text-green-600" : rollup.avgAttachScore >= 70 ? "text-yellow-600" : "text-red-600"}`}>
                {rollup.avgAttachScore}%
              </div>
              <div className="text-[10px] text-muted-foreground">Upsell</div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryCard({ 
  title, 
  icon: Icon, 
  avgGrade, 
  avgGradeLabel, 
  totalSales, 
  avgVariance, 
  avgOsat, 
  avgImprovement,
  count 
}: { 
  title: string;
  icon: typeof Globe;
  avgGrade: number;
  avgGradeLabel: string;
  totalSales: number;
  avgVariance: number;
  avgOsat?: number;
  avgImprovement: number;
  count: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          <Badge variant="secondary">{count} units</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className={`text-3xl font-bold ${getGradeColor(avgGradeLabel)}`}>{avgGradeLabel}</div>
            <div className="text-xs text-muted-foreground">Avg Grade ({avgGrade.toFixed(0)})</div>
          </div>
          <div>
            <div className="text-lg font-semibold">{formatCurrency(totalSales)}</div>
            <div className="text-xs text-muted-foreground">Total Sales</div>
          </div>
          <div>
            <div className={`text-lg font-semibold ${avgVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
              {avgVariance >= 0 ? "+" : ""}{avgVariance.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">Avg Variance</div>
          </div>
          <div>
            <div className="flex items-center gap-1">
              <TrendIndicator value={avgImprovement} />
              <span className={`text-lg font-semibold ${avgImprovement > 0 ? "text-green-600" : avgImprovement < 0 ? "text-red-600" : ""}`}>
                {avgImprovement !== 0
                  ? `${avgImprovement > 0 ? "+" : ""}${avgImprovement.toFixed(1)}`
                  : "—"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">Avg Trend Days</div>
          </div>
        </div>
        {avgOsat !== undefined && (
          <div className="mt-3 pt-3 border-t">
            <div className="flex items-center gap-2">
              <ThumbsUp className="w-4 h-4 text-green-500" />
              <span className={`font-semibold ${avgOsat >= 85 ? "text-green-600" : avgOsat >= 80 ? "text-yellow-600" : "text-red-600"}`}>
                {avgOsat.toFixed(0)}% OSAT
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function PerformanceHistoryPage() {
  const [dateRange, setDateRange] = useState("8");
  const [selectedState, setSelectedState] = useState<string>("all");
  const [selectedMarket, setSelectedMarket] = useState<string>("all");

  const { data, isLoading, error } = useQuery<PerformanceHistoryData>({
    queryKey: ["/api/performance-history", dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/performance-history?days=${dateRange}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch performance history");
      return res.json();
    },
  });

  const filteredRestaurants = useMemo(() => {
    if (!data) return [];
    let restaurants = data.restaurants;

    if (selectedState !== "all") {
      restaurants = restaurants.filter((r) => r.state === selectedState);
    }
    if (selectedMarket !== "all") {
      restaurants = restaurants.filter((r) => r.marketName === selectedMarket);
    }

    return restaurants;
  }, [data, selectedState, selectedMarket]);

  const states = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.restaurants.map((r) => r.state))).sort();
  }, [data]);

  const markets = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.restaurants.map((r) => r.marketName).filter(Boolean))).sort() as string[];
  }, [data]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-6 w-6 text-primary" />
              <div>
                <h1 className="text-xl font-bold">Performance History</h1>
                <p className="text-sm text-muted-foreground">
                  Grade trends and performance insights
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Select value={dateRange} onValueChange={setDateRange}>
                <SelectTrigger className="w-[140px]" data-testid="select-date-range">
                  <Calendar className="w-4 h-4 mr-2" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="8">Last 8 Days</SelectItem>
                  <SelectItem value="14">Last 14 Days</SelectItem>
                  <SelectItem value="30">Last 30 Days</SelectItem>
                </SelectContent>
              </Select>

              <Select value={selectedState} onValueChange={setSelectedState}>
                <SelectTrigger className="w-[130px]" data-testid="select-state">
                  <MapPin className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All States</SelectItem>
                  {states.map((state) => (
                    <SelectItem key={state} value={state}>{state}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {markets.length > 0 && (
                <Select value={selectedMarket} onValueChange={setSelectedMarket}>
                  <SelectTrigger className="w-[130px]" data-testid="select-market">
                    <Building2 className="w-4 h-4 mr-2" />
                    <SelectValue placeholder="Market" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Markets</SelectItem>
                    {markets.map((market) => (
                      <SelectItem key={market} value={market}>{market}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <NavBar />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        )}

        {error && (
          <Card className="border-destructive">
            <CardContent className="p-6 text-center text-destructive">
              Failed to load performance history. Please try again.
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SummaryCard
                title="Company Overall"
                icon={Globe}
                avgGrade={data.companySummary.avgGrade}
                avgGradeLabel={data.companySummary.avgGradeLabel}
                totalSales={data.companySummary.totalSales}
                avgVariance={data.companySummary.avgSalesVariance}
                avgOsat={data.companySummary.avgOsat}
                avgImprovement={data.companySummary.avgImprovement}
                count={data.companySummary.restaurantCount}
              />

              {data.stateSummaries.map((state) => (
                <SummaryCard
                  key={state.state}
                  title={state.state}
                  icon={MapPin}
                  avgGrade={state.avgGrade}
                  avgGradeLabel={state.avgGradeLabel}
                  totalSales={state.totalSales}
                  avgVariance={state.avgSalesVariance}
                  avgOsat={state.avgOsat}
                  avgImprovement={state.avgImprovement}
                  count={state.restaurantCount}
                />
              ))}
            </div>

            {data.marketSummaries.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Markets</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {data.marketSummaries.map((market) => (
                    <SummaryCard
                      key={market.market}
                      title={market.market}
                      icon={Building2}
                      avgGrade={market.avgGrade}
                      avgGradeLabel={market.avgGradeLabel}
                      totalSales={market.totalSales}
                      avgVariance={market.avgSalesVariance}
                      avgOsat={market.avgOsat}
                      avgImprovement={market.avgImprovement}
                      count={market.restaurantCount}
                    />
                  ))}
                </div>
              </div>
            )}

            {data.weekendSummary?.company && (
              <div data-testid="section-weekend-summary">
                <div className="flex items-center gap-2 mb-3">
                  <Calendar className="w-5 h-5 text-orange-500" />
                  <h2 className="text-lg font-semibold">Weekend Scorecard</h2>
                  <span className="text-xs text-muted-foreground">
                    {data.weekendSummary.weekendDates && data.weekendSummary.weekendDates.length > 0
                      ? `(${data.weekendSummary.weekendDates.map(d => formatDate(d)).join(", ")})`
                      : "(Fri / Sat / Sun)"}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  <WeekendRollupCard
                    title="Company Weekend"
                    icon={Globe}
                    rollup={data.weekendSummary.company}
                  />
                  {data.weekendSummary.states.map((s) => (
                    <WeekendRollupCard
                      key={s.state}
                      title={`${s.state} Wknd`}
                      icon={MapPin}
                      rollup={s}
                    />
                  ))}
                  {data.weekendSummary.markets.map((m) => (
                    <WeekendRollupCard
                      key={m.market}
                      title={`${m.market} Wknd`}
                      icon={Building2}
                      rollup={m}
                    />
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">
                  Restaurant Performance ({filteredRestaurants.length})
                </h2>
                <div className="text-sm text-muted-foreground">
                  {data.dateRange.length} days: {formatDate(data.dateRange[0])} - {formatDate(data.dateRange[data.dateRange.length - 1])}
                </div>
              </div>

              {filteredRestaurants.length === 0 ? (
                <Card>
                  <CardContent className="p-8 text-center text-muted-foreground">
                    No restaurants match the selected filters.
                  </CardContent>
                </Card>
              ) : (
                <div>
                  {filteredRestaurants.map((restaurant) => (
                    <RestaurantCard key={restaurant.restaurantId} restaurant={restaurant} dateRange={data.dateRange} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
