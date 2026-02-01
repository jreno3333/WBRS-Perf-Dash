import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  FileText,
  Building2,
  MapPin,
  Globe
} from "lucide-react";
import type { LeaderboardData, HourlySalesData, MarketWithRestaurants } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";

interface DailySummaryProps {
  restaurants: LeaderboardData["restaurants"];
  hourlyByRestaurant?: Record<string, HourlySalesData[]>;
  markets?: MarketWithRestaurants[];
  crewSummary?: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }>;
  isCollapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  selectedDate?: string;
  dateRange?: string[];
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
  salesOutliers: { hour: number; variance: number; type: "above" | "below"; leaders: HourlyLeader[] }[];
  recommendation: string;
}

function getGradeLabel(score: number): { label: string; color: string } {
  if (score >= 95) return { label: "A+", color: "text-green-600" };
  if (score >= 90) return { label: "A", color: "text-green-600" };
  if (score >= 85) return { label: "A-", color: "text-green-500" };
  if (score >= 80) return { label: "B+", color: "text-blue-600" };
  if (score >= 75) return { label: "B", color: "text-blue-500" };
  if (score >= 70) return { label: "B-", color: "text-blue-400" };
  if (score >= 65) return { label: "C+", color: "text-yellow-600" };
  if (score >= 60) return { label: "C", color: "text-yellow-500" };
  if (score >= 55) return { label: "C-", color: "text-yellow-400" };
  if (score >= 50) return { label: "D", color: "text-orange-500" };
  return { label: "F", color: "text-red-500" };
}

function analyzeUnit(
  restaurant: LeaderboardData["restaurants"][0],
  hourlyData: HourlySalesData[] | undefined
): UnitInsight {
  const strengths: string[] = [];
  const concerns: string[] = [];
  const staffingIssues: UnitInsight["staffingIssues"] = [];
  const speedIssues: UnitInsight["speedIssues"] = [];
  const salesOutliers: UnitInsight["salesOutliers"] = [];
  
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
      if (hasValidStaffing) {
        if (staffingDiff > 1) {
          overstaffedHours++;
          staffingIssues.push({ hour: hour.hour, type: "over", diff: staffingDiff, leaders: hourLeaders });
        } else if (staffingDiff < -1) {
          understaffedHours++;
          staffingIssues.push({ hour: hour.hour, type: "under", diff: Math.abs(staffingDiff), leaders: hourLeaders });
        }
      }
      
      // Speed analysis - only include if we have valid drive-thru data (avgServiceTime > 0)
      const hasValidSpeed = hour.avgServiceTime !== undefined && hour.avgServiceTime > 0;
      if (hasValidSpeed && hour.avgServiceTime! > 420) { // > 7 min
        slowSpeedHours++;
        speedIssues.push({ hour: hour.hour, avgTime: hour.avgServiceTime!, leaders: hourLeaders });
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
      
      // Calculate hourly grade score - aligned with leaderboard-card logic
      let score = 0;
      let components = 0;
      
      // Sales component - only if we have comparable data
      if (hasComparableSales) {
        score += hourVariance >= -5 ? 100 : 50;
        components++;
      }
      
      // Speed component - only if we have valid drive-thru data
      if (hasValidSpeed) {
        if (hour.avgServiceTime! <= 300) score += 100;
        else if (hour.avgServiceTime! <= 420) score += 70;
        else score += 40;
        components++;
      }
      
      // Staffing component - only if we have valid staffing data
      if (hasValidStaffing) {
        if (Math.abs(staffingDiff) <= 1) score += 100;
        else score += 60;
        components++;
      }
      
      if (components > 0) {
        hourlyScores.push(score / components);
      }
    }
  }
  
  const avgGrade = hourlyScores.length > 0 
    ? hourlyScores.reduce((a, b) => a + b, 0) / hourlyScores.length 
    : 0;
  const { label: gradeLabel, color: gradeColor } = getGradeLabel(avgGrade);
  
  // Generate strengths
  if (salesVariance >= 5) {
    strengths.push(`Sales up ${salesVariance.toFixed(1)}% vs last week`);
  }
  if (aboveExpectationHours >= 2) {
    strengths.push(`${aboveExpectationHours} hours with sales 20%+ above expectations`);
  }
  // Only show good speed if there's drive-thru data AND no slow hours
  const hasDriveThruData = hourlyData?.some(h => h.avgServiceTime && h.avgServiceTime > 0);
  if (slowSpeedHours === 0 && hasDriveThruData) {
    strengths.push("Drive-thru speed consistently under 7 minutes");
  }
  if (understaffedHours === 0 && overstaffedHours === 0 && staffingIssues.length === 0) {
    strengths.push("Properly staffed throughout the day");
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
    const worstSpeed = speedIssues.sort((a, b) => b.avgTime - a.avgTime)[0];
    const worstTimeFormatted = worstSpeed 
      ? `${Math.floor(worstSpeed.avgTime / 60)}:${String(Math.round(worstSpeed.avgTime % 60)).padStart(2, '0')}`
      : "";
    if (slowSpeedHours === 1) {
      concerns.push(`Drive-thru slow at ${formatHour(worstSpeed?.hour || 0)} (${worstTimeFormatted} avg)`);
    } else {
      concerns.push(`Drive-thru over 7 min for ${slowSpeedHours} hours (worst: ${worstTimeFormatted})`);
    }
  }
  if (belowExpectationHours >= 2) {
    concerns.push(`${belowExpectationHours} hours with sales 20%+ below expectations`);
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
    salesOutliers,
    recommendation,
  };
}

function formatHour(hour: number): string {
  if (hour === 0) return "12AM";
  if (hour === 12) return "12PM";
  if (hour < 12) return `${hour}AM`;
  return `${hour - 12}PM`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(amount);
}

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
  unitsAboveExpectation: number;
  unitsBelowExpectation: number;
  topStrength: string;
  topConcern: string;
  recommendation: string;
}

function aggregateInsights(insights: UnitInsight[], name: string): AggregatedSummary {
  const unitCount = insights.length;
  const totalSales = insights.reduce((sum, i) => sum + i.totalSales, 0);
  const avgVariance = insights.reduce((sum, i) => sum + i.salesVariance, 0) / unitCount;
  const avgGrade = insights.reduce((sum, i) => sum + i.avgGrade, 0) / unitCount;
  const { label: gradeLabel, color: gradeColor } = getGradeLabel(avgGrade);
  
  const understaffedUnits = insights.filter(i => i.staffingIssues.filter(s => s.type === "under").length >= 2).length;
  const overstaffedUnits = insights.filter(i => i.staffingIssues.filter(s => s.type === "over").length >= 2).length;
  const slowSpeedUnits = insights.filter(i => i.speedIssues.length >= 2).length;
  const unitsAboveExpectation = insights.filter(i => i.salesVariance >= 5).length;
  const unitsBelowExpectation = insights.filter(i => i.salesVariance <= -5).length;
  
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
          : `${unitsBelowExpectation} units below last week's sales`)
    : "No major concerns identified";
  
  let recommendation = "";
  if (understaffedUnits >= unitCount * 0.3) {
    recommendation = "Multiple units showing understaffing. Review region-wide scheduling practices.";
  } else if (overstaffedUnits >= unitCount * 0.3) {
    recommendation = "Multiple units showing high labor. Audit scheduling compliance across the group.";
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
    unitsAboveExpectation,
    unitsBelowExpectation,
    topStrength,
    topConcern,
    recommendation,
  };
}

function UnitSummaryCard({ insight }: { insight: UnitInsight }) {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <Card className="hover-elevate" data-testid={`summary-unit-${insight.restaurantId}`}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3">
                <CardTitle className="text-base">{insight.restaurantName}</CardTitle>
                <Badge variant="outline" className="text-xs">{insight.state}</Badge>
                <Badge className={`${insight.gradeColor} bg-transparent border`}>
                  {insight.gradeLabel}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{formatCurrency(insight.totalSales)}</span>
                <span className={`text-sm ${insight.salesVariance >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {insight.salesVariance >= 0 ? "+" : ""}{insight.salesVariance.toFixed(1)}%
                </span>
                {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
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
                          Leader: {o.leaders.map(l => l.firstName).join(", ")}
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
                  Drive-thru speed issues (&gt;7 min)
                </div>
                <div className="space-y-1 pl-5">
                  {insight.speedIssues.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Badge 
                        variant="secondary" 
                        className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                      >
                        {formatHour(s.hour)}: {Math.floor(s.avgTime / 60)}:{String(Math.round(s.avgTime % 60)).padStart(2, '0')} avg
                      </Badge>
                      {s.leaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          Leader: {s.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
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
                          Leader: {s.leaders.map(l => l.firstName).join(", ")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <div className="pt-2 border-t">
              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <p className="text-sm">{insight.recommendation}</p>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
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
        
        {(summary.understaffedUnits > 0 || summary.overstaffedUnits > 0 || summary.slowSpeedUnits > 0) && (
          <div className="flex flex-wrap gap-2 pt-2">
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
  dateRange
}: DailySummaryProps) {
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
  
  // Analyze all units (exclude training units)
  const unitInsights = useMemo(() => {
    const activeRestaurants = restaurants.filter(r => r.status !== "training");
    return activeRestaurants.map(r => {
      const insight = analyzeUnit(r, hourlyByRestaurant?.[r.restaurantId]);
      // Add market info if available
      if (markets) {
        const market = markets.find(m => m.restaurantIds?.includes(r.restaurantId));
        if (market) {
          insight.marketId = market.id;
          insight.marketName = market.name;
        }
      }
      return insight;
    });
  }, [restaurants, hourlyByRestaurant, markets]);
  
  // Aggregate by state
  const stateSummaries = useMemo(() => {
    const byState = new Map<string, UnitInsight[]>();
    for (const insight of unitInsights) {
      const state = insight.state || "Unknown";
      if (!byState.has(state)) byState.set(state, []);
      byState.get(state)!.push(insight);
    }
    return Array.from(byState.entries()).map(([state, insights]) => 
      aggregateInsights(insights, state)
    ).sort((a, b) => b.totalSales - a.totalSales);
  }, [unitInsights]);
  
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
    return Array.from(byMarket.entries()).map(([marketId, insights]) => {
      const market = markets.find(m => m.id === marketId);
      return aggregateInsights(insights, market?.name || "Unknown Market");
    }).sort((a, b) => b.totalSales - a.totalSales);
  }, [unitInsights, markets]);
  
  // Company-wide summary
  const companySummary = useMemo(() => {
    return aggregateInsights(unitInsights, "Company Overview");
  }, [unitInsights]);
  
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
                {unitInsights.map(insight => (
                  <UnitSummaryCard key={insight.restaurantId} insight={insight} />
                ))}
              </TabsContent>
              
              <TabsContent value="markets" className="space-y-3">
                {marketSummaries.length > 0 ? (
                  marketSummaries.map(summary => (
                    <AggregatedSummaryCard 
                      key={summary.name} 
                      summary={summary} 
                      icon={<MapPin className="w-5 h-5 text-indigo-500" />}
                    />
                  ))
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <MapPin className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p>No markets configured. Create markets in Settings to see market-level summaries.</p>
                  </div>
                )}
              </TabsContent>
              
              <TabsContent value="states" className="space-y-3">
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
