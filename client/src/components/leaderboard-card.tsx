import { useState, memo, useMemo } from "react";
import { Link } from "wouter";
// Card/CardContent imports removed - using plain divs
import { Badge } from "@/components/ui/badge";
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { TrendingUp, TrendingDown, Clock, MapPin, Car, Smartphone, Utensils, ShoppingBag, AlertTriangle, Ban, ChevronDown, ChevronUp, Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle, Droplets, Wind, Star, GraduationCap, ThumbsUp, Receipt, MessageSquare, Send, X, StickyNote, Sparkles, Trophy, Flame, Diamond, Zap, Target, Gauge } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { DAYPARTS, getDaypart, gradeToScore as dpGradeToScore, scoreToGrade as dpScoreToGrade, getGradeColor as dpGetGradeColor } from "@/lib/dayparts";
import {
  computeExecutionScore,
  scoreToGradeLabel,
  getGradeColor as sharedGetGradeColor,
  gradeToMidpoint,
  formatCurrency,
  computeDailyBonuses,
  countAttachmentCategoriesAtTarget,
} from "@/lib/grading";
import { useGradingConfig } from "@/hooks/use-grading-config";
import type { GradingConfigData } from "@shared/schema";

const REVENUE_PORT_CONFIG = {
  dine_in: { label: "Dine In", icon: Utensils, color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Indoor dining available", disabledDesc: "No indoor dining" },
  drive_thru: { label: "Drive Thru", icon: Car, color: "bg-amber-500/10 text-amber-600 dark:text-amber-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Drive-thru window service", disabledDesc: "No drive-thru" },
  app: { label: "APP", icon: Smartphone, color: "bg-blue-500/10 text-blue-500", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Mobile app ordering", disabledDesc: "No app ordering" },
  "3pd": { label: "3PD", icon: ShoppingBag, color: "bg-purple-500/10 text-purple-500", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Third-party delivery (DoorDash, UberEats, etc.)", disabledDesc: "No third-party delivery" },
} as const;

const ALL_REVENUE_PORTS = ["dine_in", "drive_thru", "app", "3pd"] as const;

// Hourly Rate Badge Tiers
const HOURLY_RATE_TIERS = [
  { threshold: 2300, label: "LEGENDARY", icon: Trophy, color: "bg-gradient-to-r from-yellow-500/20 to-amber-500/20 text-yellow-500 dark:text-yellow-400 border-yellow-500/30", pulseClass: "animate-pulse" },
  { threshold: 2000, label: "ULTRA", icon: Diamond, color: "bg-purple-500/15 text-purple-500 dark:text-purple-400 border-purple-500/30", pulseClass: "" },
  { threshold: 1500, label: "ELITE", icon: Flame, color: "bg-orange-500/15 text-orange-500 dark:text-orange-400 border-orange-500/30", pulseClass: "" },
  { threshold: 1000, label: "PRO", icon: Zap, color: "bg-blue-500/15 text-blue-500 dark:text-blue-400 border-blue-500/30", pulseClass: "" },
  { threshold: 750, label: "CONTENDER", icon: Star, color: "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400 border-emerald-500/30", pulseClass: "" },
] as const;

function getHourlyRateTier(peakHourlySales: number) {
  return HOURLY_RATE_TIERS.find(t => peakHourlySales >= t.threshold) || null;
}

function WeatherIcon({ condition }: { condition: string }) {
  const iconClass = "w-3.5 h-3.5";
  switch (condition.toLowerCase()) {
    case "clear":
      return <Sun className={iconClass} />;
    case "partly cloudy":
      return <Cloud className={iconClass} />;
    case "foggy":
      return <CloudFog className={iconClass} />;
    case "rain":
      return <CloudRain className={iconClass} />;
    case "showers":
      return <CloudDrizzle className={iconClass} />;
    case "snow":
      return <CloudSnow className={iconClass} />;
    case "thunderstorm":
      return <CloudLightning className={iconClass} />;
    default:
      return <Sun className={iconClass} />;
  }
}

// Execution Grade — delegates to shared grading module
function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales = true,
  hasValidStaffing = true,
  osatPercent: number | undefined = undefined,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
  cfg?: GradingConfigData,
  feedbackSpeedPercent?: number,
  feedbackSpeedResponses?: number,
): { grade: string; color: string; score: number; hasGrade: boolean } {
  const score = computeExecutionScore(salesVariancePct, speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, osatPercent, transactionVariancePct, hasComparableTransactions, cfg, feedbackSpeedPercent, feedbackSpeedResponses);
  if (score === 0) return { grade: '-', color: 'text-muted-foreground', score: 0, hasGrade: false };
  const grade = scoreToGradeLabel(score);
  return { grade, color: sharedGetGradeColor(grade), score, hasGrade: true };
}

const getGradeColor = sharedGetGradeColor;
const gradeToScore = gradeToMidpoint;

function scoreToGrade(score: number): { grade: string; color: string } {
  const grade = scoreToGradeLabel(score);
  return { grade, color: getGradeColor(grade) };
}

// Pure formatting helpers — defined at module level so they are stable references
// and never cause memoization breaks in child components that receive them as props.
function formatPercentage(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${Math.round(value)}%`;
}

function formatSignedCurrency(amount: number): string {
  const sign = amount >= 0 ? "+" : "";
  return `${sign}${formatCurrency(amount)}`;
}

interface CrewSummary {
  avgScore: number;
  avgCrewCount: number;
  avgTenureMonths: number;
}

interface HourlyCrewData {
  hour: number;
  crewCount: number;
  experienceScore: number;
  tenureMix: { trainee: number; developing: number; experienced: number; veteran: number };
}

interface YoYData {
  priorNetSales: number;
  priorGuestCount: number;
  priorDate: string;
}

interface WeeklyRestaurantData {
  currentWeek: number;
  priorWeek: number;
  eowForecast: number;
  priorWeekFull: number;
  daysInCurrentWeek: number;
  wtdLaborCost?: number;
}

interface CheckAverageData {
  totalOrders: number;
  totalSales: number;
  checkAverage: number;
  hourly: Record<number, { orders: number; sales: number; avg: number }>;
}

interface DemandCurveHour {
  hour: number;
  quarters: { label: string; orders: number; sales: number }[];
  totalOrders: number;
  totalSales: number;
  loadProfile: string;
}

interface CheckAvgTrendData {
  daily: { date: string; orders: number; sales: number; avg: number }[];
  avg7d: number;
  trend: 'up' | 'down' | 'flat';
}

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

interface LeaderboardCardProps {
  restaurant: RestaurantSales;
  hourlyData?: HourlySalesData[];
  crewSummary?: CrewSummary;
  hourlyCrewData?: HourlyCrewData[];
  checkAverage?: CheckAverageData;
  checkAvgTrend?: CheckAvgTrendData;
  consistencyScore?: number;
  demandCurveHours?: DemandCurveHour[];
  destinationsByHour?: Record<number, Record<string, number>>;
  isToday?: boolean;
  yoyData?: YoYData;
  weeklyData?: WeeklyRestaurantData;
  notes?: RestaurantNote[];
  dateStr?: string;
  onNoteAdded?: () => void;
  attachmentCategories?: Record<string, { attachRate: number }>;
  overallAttachScore?: number;
  helperRewardPoints?: number;
  planQtd?: PlanQtdData;
  planQtdRange?: { quarterStart: string; throughDate: string };
}

interface PlanQtdData {
  plannedSales: number;
  actualSales: number;
}

function formatTenure(months: number): string {
  if (months < 1) return '<1mo';
  const years = Math.floor(months / 12);
  const remainingMonths = Math.round(months % 12);
  if (years === 0) return `${remainingMonths}mo`;
  if (remainingMonths === 0) return `${years}yr`;
  return `${years}yr ${remainingMonths}mo`;
}

// Memoize to prevent re-rendering all restaurant cards when the parent
// dashboard re-renders due to unrelated state changes (sort, market filter, etc.).
// Notes section component for adding/viewing notes on ranking cards
function NotesSection({ restaurantId, dateStr, notes, onNoteAdded }: {
  restaurantId: string;
  dateStr: string;
  notes?: RestaurantNote[];
  onNoteAdded?: () => void;
}) {
  const [showAddNote, setShowAddNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteHour, setNoteHour] = useState<string>('');
  const [noteCategory, setNoteCategory] = useState('general');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Optimistic: track locally-saved notes so they appear immediately
  const [pendingNotes, setPendingNotes] = useState<RestaurantNote[]>([]);

  // Merge server notes with optimistic pending notes (de-dup by id)
  const serverIds = new Set((notes || []).map(n => n.id));
  const displayNotes = [
    ...(notes || []),
    ...pendingNotes.filter(n => !serverIds.has(n.id)),
  ];

  const handleSubmit = async () => {
    if (!noteText.trim() || !dateStr) return;
    setSaveError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          restaurantId,
          date: dateStr,
          hour: noteHour ? parseInt(noteHour) : null,
          note: noteText.trim(),
          category: noteCategory,
        }),
      });
      if (response.ok) {
        const savedNote = await response.json();
        // Add to local pending notes for immediate display
        setPendingNotes(prev => [savedNote, ...prev]);
        setNoteText('');
        setNoteHour('');
        setNoteCategory('general');
        setShowAddNote(false);
        // Refetch from server to sync
        onNoteAdded?.();
      } else {
        const err = await response.json().catch(() => null);
        setSaveError(err?.error || 'Failed to save note');
      }
    } catch (e: any) {
      console.error('Failed to add note:', e);
      setSaveError(`Save failed: ${e?.message || 'network error'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    // Optimistically remove from pending
    setPendingNotes(prev => prev.filter(n => n.id !== noteId));
    try {
      await fetch(`/api/notes/${noteId}`, { method: 'DELETE', credentials: 'include' });
      onNoteAdded?.();
    } catch (e) {
      console.error('Failed to delete note:', e);
    }
  };

  const categoryColors: Record<string, string> = {
    general: 'text-blue-600 dark:text-blue-400',
    staffing: 'text-amber-600 dark:text-amber-400',
    equipment: 'text-red-600 dark:text-red-400',
    'events/large orders': 'text-sky-600 dark:text-sky-400',
    shop: 'text-purple-600 dark:text-purple-400',
    hospitality: 'text-teal-600 dark:text-teal-400',
    product: 'text-orange-600 dark:text-orange-400',
    wins: 'text-green-600 dark:text-green-400',
  };

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <StickyNote className="w-3 h-3" />
          <span className="font-medium">Notes</span>
          {displayNotes.length > 0 && (
            <span className="text-[10px] bg-muted px-1 rounded">{displayNotes.length}</span>
          )}
        </div>
        <button
          onClick={() => { setShowAddNote(!showAddNote); setSaveError(null); }}
          className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
        >
          {showAddNote ? <X className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
          {showAddNote ? 'Cancel' : 'Add Note'}
        </button>
      </div>

      {/* Add Note Form */}
      {showAddNote && (
        <div className="bg-muted/30 rounded-lg p-2 mb-2 space-y-1.5">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note about what happened..."
            className="w-full text-xs bg-background border border-border rounded p-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={2}
          />
          {saveError && (
            <div className="text-[10px] text-red-500 bg-red-50 dark:bg-red-950/30 px-2 py-1 rounded">
              {saveError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <select
              value={noteHour}
              onChange={(e) => setNoteHour(e.target.value)}
              className="text-[10px] bg-background border border-border rounded px-1 py-0.5"
            >
              <option value="">All Day</option>
              {Array.from({ length: 18 }, (_, i) => i + 6).map(h => (
                <option key={h} value={h}>{h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`}</option>
              ))}
            </select>
            <select
              value={noteCategory}
              onChange={(e) => setNoteCategory(e.target.value)}
              className="text-[10px] bg-background border border-border rounded px-1 py-0.5"
            >
              <option value="general">General</option>
              <option value="staffing">Staffing</option>
              <option value="equipment">Equipment</option>
              <option value="events/large orders">Events/Large Orders</option>
              <option value="shop">Shop</option>
              <option value="hospitality">Hospitality</option>
              <option value="product">Product</option>
              <option value="wins">Wins</option>
            </select>
            <button
              onClick={handleSubmit}
              disabled={!noteText.trim() || isSubmitting}
              className="ml-auto flex items-center gap-0.5 text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="w-2.5 h-2.5" />
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Existing Notes */}
      {displayNotes.length > 0 && (
        <div className="space-y-1">
          {displayNotes.map(note => (
            <div key={note.id} className="flex items-start gap-1.5 text-[10px] group">
              <div className={`flex-shrink-0 mt-0.5 ${categoryColors[note.category] || categoryColors.general}`}>
                <StickyNote className="w-2.5 h-2.5" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-foreground">{note.note}</span>
                <span className="text-muted-foreground ml-1">
                  {note.author && `${note.author.split('@')[0]} · `}
                  {note.hour !== null && `${note.hour === 0 ? '12am' : note.hour < 12 ? `${note.hour}am` : note.hour === 12 ? '12pm' : `${note.hour - 12}pm`} · `}
                  {note.category !== 'general' && `${note.category} · `}
                  {note.createdAt ? new Date(note.createdAt + (String(note.createdAt).match(/[Z+-]/) ? '' : 'Z')).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'just now'}
                </span>
              </div>
              <button
                onClick={() => handleDelete(note.id)}
                className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-opacity"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ExpandedCardContentProps {
  restaurant: RestaurantSales;
  activeHours: HourlySalesData[];
  localGradeCutoff: number;
  normalizedCutoff: number;
  maxSales: number;
  daypartGrades: { id: string; label: string; shortLabel: string; startHour: number; endHour: number; color: string; bgColor: string; grade: string | null; score: number }[];
  demandCurveMap: Map<number, DemandCurveHour>;
  destinationsByHour?: Record<number, Record<string, number>>;
  hourlyData?: HourlySalesData[];
  hourlyCrewData?: HourlyCrewData[];
  checkAverage?: CheckAverageData;
  checkAvgTrend?: CheckAvgTrendData;
  overallAttachScore?: number;
  weeklyData?: WeeklyRestaurantData;
  gradingCfg?: GradingConfigData;
}

const ExpandedCardContent = memo(function ExpandedCardContent({
  restaurant,
  activeHours,
  localGradeCutoff,
  normalizedCutoff,
  maxSales,
  daypartGrades,
  demandCurveMap,
  destinationsByHour,
  hourlyData,
  hourlyCrewData,
  checkAverage,
  checkAvgTrend,
  overallAttachScore,
  weeklyData,
  gradingCfg,
}: ExpandedCardContentProps) {
  const [hoveredHourIndex, setHoveredHourIndex] = useState<number | null>(null);

  const getTooltipAlign = (hourIndex: number) => {
    const total = activeHours.length;
    if (hourIndex <= 1) return 'left-0';
    if (hourIndex >= total - 2) return 'right-0';
    return 'left-1/2 -translate-x-1/2';
  };

  return (
    <>
      {(checkAverage || overallAttachScore !== undefined) && (
        <div className="mt-2 pt-2 border-t border-border/30 flex flex-wrap items-center gap-1.5">
          {checkAverage && checkAverage.totalOrders > 0 && (
            <BadgeWithTooltip
              className="flex-shrink-0 text-xs px-1.5 gap-1 bg-teal-500/10 text-teal-600 dark:text-teal-400 border-0"
              data-testid={`badge-check-avg-${restaurant.restaurantId}`}
              tooltipContent={
                <div>
                  <div className="font-medium">Check Average</div>
                  <div className="text-muted-foreground">{checkAverage.totalOrders} orders today</div>
                  <div className="text-muted-foreground">Total: ${checkAverage.totalSales.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
                  {checkAvgTrend && (
                    <div className="mt-1 pt-1 border-t border-border/50">
                      <div className="font-medium text-[10px] mb-0.5">7-Day Rolling Avg: ${checkAvgTrend.avg7d.toFixed(2)}</div>
                      <div className="flex gap-1 flex-wrap">
                        {checkAvgTrend.daily.map(d => (
                          <div key={d.date} className="text-center">
                            <div className="text-[8px] text-muted-foreground">{new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' })}</div>
                            <div className="text-[9px] font-medium">${d.avg.toFixed(0)}</div>
                          </div>
                        ))}
                      </div>
                      <div className={`text-[10px] mt-0.5 font-medium ${checkAvgTrend.trend === 'up' ? 'text-green-600' : checkAvgTrend.trend === 'down' ? 'text-red-500' : 'text-muted-foreground'}`}>
                        {checkAvgTrend.trend === 'up' ? 'Trending Up' : checkAvgTrend.trend === 'down' ? 'Trending Down' : 'Stable'}
                      </div>
                    </div>
                  )}
                </div>
              }
            >
              <Receipt className="w-3 h-3" />
              <span className="font-medium">${checkAverage.checkAverage.toFixed(2)}</span>
              {checkAvgTrend && checkAvgTrend.trend !== 'flat' && (
                checkAvgTrend.trend === 'up'
                  ? <TrendingUp className="w-2.5 h-2.5 text-green-500" />
                  : <TrendingDown className="w-2.5 h-2.5 text-red-500" />
              )}
            </BadgeWithTooltip>
          )}
          {overallAttachScore !== undefined && (
            <BadgeWithTooltip
              className={`flex-shrink-0 text-xs px-1.5 gap-1 border-0 ${
                overallAttachScore >= 90
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                  : overallAttachScore >= 70
                    ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                    : 'bg-red-500/10 text-red-500'
              }`}
              data-testid={`badge-upsell-${restaurant.restaurantId}`}
              tooltipTitle="Upsell Score"
              tooltipDetail="Composite score based on attachment rates across all upsell categories (cheese, bacon, jalapeños, dipping sauces, shakes & malts, whatasize). 90+ is green (at target), 70-89 is yellow, below 70 is red."
            >
              <Target className="w-3 h-3" />
              <span className="font-medium">{overallAttachScore}</span>
            </BadgeWithTooltip>
          )}
        </div>
      )}

      {activeHours.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/30">
          <div className="flex justify-between text-xs text-muted-foreground mb-2">
            <span>Hourly Sales</span>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-sm bg-green-500" />
                Above
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-sm bg-red-500" />
                Below
              </span>
              {activeHours.some(h => h.speedAttainment !== undefined) && (
                <span className="flex items-center gap-1">
                  <div className="w-3 h-0.5 bg-cyan-500" />
                  SOS
                </span>
              )}
              {activeHours.some(h => h.osatResponses && h.osatResponses > 0) && (
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  OSAT
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-0.5 mb-0.5">
            {activeHours.map((hour) => {
              const isCompleted = hour.hour <= localGradeCutoff;
              const hasSales = hour.todaySales && hour.todaySales > 0;
              let gradeInfo: { grade: string; color: string; score: number; hasGrade: boolean };
              if (hour.gradeScore !== undefined && hour.gradeHasGrade) {
                const g = scoreToGradeLabel(hour.gradeScore);
                gradeInfo = { grade: g, color: getGradeColor(g), score: hour.gradeScore, hasGrade: true };
              } else {
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
                const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
                const fs = restaurant.feedbackSpeed;
                gradeInfo = getExecutionGrade(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, txnVar, hasCompTxn, gradingCfg, fs?.responses ? fs.topBoxPercent : undefined, fs?.responses);
              }
              return (
                <div key={`grade-${hour.hour}`} className="flex-1 text-center">
                  {isCompleted && hasSales ? (
                    <span className={`text-[10px] font-bold ${gradeInfo.color}`}>{gradeInfo.grade}</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">-</span>
                  )}
                </div>
              );
            })}
          </div>
          {activeHours.some(h => {
            const dest = destinationsByHour?.[h.hour];
            return dest && (dest['dt3'] || 0) >= 1;
          }) && (
            <div className="flex gap-0.5 mb-0.5">
              {activeHours.map((hour) => {
                const isCompleted = hour.hour <= localGradeCutoff;
                const dt3Count = isCompleted ? (destinationsByHour?.[hour.hour]?.['dt3'] || 0) : 0;
                const isActive = dt3Count >= 1;
                return (
                  <div key={`oot-${hour.hour}`} className="flex-1 text-center">
                    {isActive ? (
                      <span className="text-[9px] font-bold text-violet-500">OOT</span>
                    ) : (
                      <span className="text-[9px]">&nbsp;</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div
            className="relative flex items-end gap-0.5 h-12"
            data-testid={`hourly-chart-${restaurant.restaurantId}`}
            onMouseLeave={() => setHoveredHourIndex(null)}
          >
            {activeHours.map((hour, hourIndex) => {
              const isCompleted = hour.hour <= localGradeCutoff;
              const hasComparableSales = hour.lastWeekSales > 0;
              const salesVariancePct = hasComparableSales
                ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100
                : 0;
              const displayValue = hour.todaySales > 0 ? hour.todaySales : hour.lastWeekSales;
              const barHeightPx = Math.max(4, (displayValue / maxSales) * 48);
              let gradeInfo: { grade: string; color: string; score: number; hasGrade: boolean };
              if (hour.gradeScore !== undefined && hour.gradeHasGrade) {
                const g = scoreToGradeLabel(hour.gradeScore);
                gradeInfo = { grade: g, color: getGradeColor(g), score: hour.gradeScore, hasGrade: true };
              } else {
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                const positions = hour.positionBreakdown || {};
                const operatorHrs = positions['_operatorScheduled'] || 0;
                const rawEmployeeCount = Number(hour.employeeCount) || 0;
                const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
                const staffingDiff = actualStaff - staffing.total;
                const hasValidStaffing = rawEmployeeCount >= 1;
                const hasCompTxn = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
                const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
                const fs = restaurant.feedbackSpeed;
                gradeInfo = getExecutionGrade(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, txnVar, hasCompTxn, gradingCfg, fs?.responses ? fs.topBoxPercent : undefined, fs?.responses);
              }
              const isHovered = hoveredHourIndex === hourIndex;

              return (
                <div
                  key={hour.hour}
                  className="flex-1 flex items-end relative h-full cursor-pointer"
                  onMouseEnter={() => setHoveredHourIndex(hourIndex)}
                  onMouseLeave={() => setHoveredHourIndex(null)}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    setHoveredHourIndex(hoveredHourIndex === hourIndex ? null : hourIndex);
                  }}
                >
                  {(() => {
                    const barColor = salesVariancePct >= -5
                      ? "bg-green-500 dark:bg-green-400"
                      : "bg-red-500 dark:bg-red-400";
                    const dcHour = demandCurveMap.get(hour.hour);
                    if (dcHour && dcHour.quarters.length === 4 && dcHour.totalOrders > 0) {
                      const maxQ = Math.max(...dcHour.quarters.map(q => q.orders), 1);
                      return (
                        <div
                          className="w-full flex items-end gap-px"
                          style={{ height: `${barHeightPx}px` }}
                        >
                          {dcHour.quarters.map((q, qi) => (
                            <div
                              key={qi}
                              className={`flex-1 rounded-t-[1px] ${barColor}`}
                              style={{
                                height: `${Math.max(2, (q.orders / maxQ) * barHeightPx)}px`,
                                opacity: q.orders > 0 ? 1 : 0.3
                              }}
                            />
                          ))}
                        </div>
                      );
                    }
                    return (
                      <div
                        className={`w-full rounded-t-sm transition-all ${barColor}`}
                        style={{ height: `${barHeightPx}px` }}
                      />
                    );
                  })()}
                  <div className={`absolute bottom-full mb-1 ${getTooltipAlign(hourIndex)} bg-popover border shadow-md rounded px-2 py-1 text-xs pointer-events-none whitespace-nowrap z-10 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{hour.label}</span>
                      {isCompleted && hour.todaySales > 0 && <span className={gradeInfo.color}>{gradeInfo.grade}</span>}
                      {!isCompleted && <span className="text-muted-foreground">pending</span>}
                      <span className={salesVariancePct >= -5 ? "text-green-500" : "text-red-500"}>
                        ${hour.todaySales.toLocaleString()}
                      </span>
                      <span className="text-muted-foreground">LW ${hour.lastWeekSales.toLocaleString()}</span>
                      {isCompleted && hour.speedAttainment !== undefined && (
                        <span className={
                          hour.speedAttainment < 50 ? "text-red-500" :
                          hour.speedAttainment < 70 ? "text-yellow-500" :
                          "text-green-500"
                        }>
                          {hour.speedAttainment}%
                        </span>
                      )}
                      {isCompleted && (() => {
                        const destHour = destinationsByHour?.[hour.hour];
                        if (!destHour) return null;
                        const dt3Count = destHour['dt3'] || 0;
                        if (dt3Count === 0) return null;
                        const isActive = dt3Count >= 1;
                        return (
                          <span className={isActive ? "text-violet-500 font-medium" : "text-muted-foreground"}>
                            OOT:{dt3Count}
                          </span>
                        );
                      })()}
                      {isCompleted && hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0 && (
                        <span className={
                          hour.osatPercent >= 85 ? "text-green-500" :
                          hour.osatPercent >= 80 ? "text-amber-600 dark:text-amber-400" :
                          "text-red-500"
                        }>
                          OSAT {Math.round(hour.osatPercent)}% ({hour.osatResponses})
                        </span>
                      )}
                      {isCompleted && (() => {
                        const hourCA = checkAverage?.hourly?.[hour.hour];
                        if (!hourCA || hourCA.orders === 0) return null;
                        return <span className="text-teal-600 dark:text-teal-400">${hourCA.avg.toFixed(2)} ({hourCA.orders})</span>;
                      })()}
                    </div>
                    {isCompleted && (() => {
                      const dcHour = demandCurveMap.get(hour.hour);
                      if (!dcHour || dcHour.quarters.every(q => q.orders === 0)) return null;
                      const h12 = hour.hour === 0 ? 12 : hour.hour > 12 ? hour.hour - 12 : hour.hour;
                      const ampm = hour.hour < 12 ? 'am' : 'pm';
                      return (
                        <div className="flex gap-2 mt-0.5 text-[10px] text-muted-foreground border-t border-border/50 pt-0.5">
                          {dcHour.quarters.map((q, qi) => {
                            const min = qi * 15;
                            return (
                              <span key={qi} className={q.orders > 0 ? "text-foreground" : ""}>
                                {h12}:{min.toString().padStart(2, '0')}{ampm} <span className="font-medium">{q.orders}</span>
                              </span>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
            {activeHours.some(h => h.speedAttainment !== undefined) && (
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <polyline
                  fill="none"
                  stroke="rgb(6, 182, 212)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  points={activeHours
                    .map((hour, idx) => {
                      const att = hour.speedAttainment;
                      if (att === undefined) return null;
                      const x = ((idx + 0.5) / activeHours.length) * 100;
                      const y = (1 - att / 100) * 100;
                      return `${x},${y}`;
                    })
                    .filter(Boolean)
                    .join(' ')}
                />
              </svg>
            )}
            {activeHours.some(h => h.osatResponses && h.osatResponses > 0) && (
              <div className="absolute inset-0 w-full h-full pointer-events-none flex">
                {activeHours.map((hour, idx) => {
                  const hasOsat = hour.osatResponses && hour.osatResponses > 0;
                  const osatPct = hour.osatPercent || 0;
                  const fillColor = osatPct >= 85 ? "bg-green-500" : osatPct >= 80 ? "bg-yellow-500" : "bg-red-500";
                  const borderColor = osatPct >= 85 ? "border-green-700" : osatPct >= 80 ? "border-yellow-700" : "border-red-700";
                  return (
                    <div key={`osat-${hour.hour}`} className="flex-1 flex justify-center">
                      {hasOsat && (
                        <div
                          className={`w-3 h-3 rounded-full ${fillColor} border-2 ${borderColor} mt-1`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{activeHours[0]?.label || ""}</span>
            <span>{(() => {
              const lastHour = activeHours[activeHours.length - 1]?.hour;
              if (lastHour === undefined) return "";
              const nextHour = (lastHour + 1) % 24;
              return nextHour === 0 ? "12am" : nextHour < 12 ? `${nextHour}am` : nextHour === 12 ? "12pm" : `${nextHour - 12}pm`;
            })()}</span>
          </div>
          <div className="flex mt-0.5">
            {DAYPARTS.map(dp => {
              const spanHours = dp.endHour - dp.startHour + 1;
              const widthPercent = (spanHours / 24) * 100;
              const dpGrade = daypartGrades.find(dg => dg.id === dp.id);
              let dpSales = 0;
              let dpLastWeekSales = 0;
              if (hourlyData) {
                for (let h = dp.startHour; h <= dp.endHour; h++) {
                  const hourData = hourlyData.find(hd => hd.hour === h);
                  if (hourData) {
                    dpSales += hourData.todaySales || 0;
                    dpLastWeekSales += hourData.lastWeekSales || 0;
                  }
                }
              }
              const dpVariance = dpLastWeekSales > 0
                ? ((dpSales - dpLastWeekSales) / dpLastWeekSales) * 100
                : 0;
              return (
                <div key={dp.id} style={{ width: `${widthPercent}%` }} className="text-center px-px">
                  <div className={`h-1 rounded-sm ${dp.bgColor}`} style={{ opacity: dpGrade?.grade ? 1 : 0.3 }} />
                  <div className="text-[8px] leading-tight mt-px flex items-center justify-center gap-0.5">
                    <span className={`font-medium ${dp.color}`}>{dp.shortLabel}</span>
                    {dpGrade?.grade && (
                      <span className={`font-bold ${dpGetGradeColor(dpGrade.grade)}`}>{dpGrade.grade}</span>
                    )}
                  </div>
                  {dpSales > 0 && (
                    <div className="text-[7px] leading-none font-medium">
                      <span className="text-muted-foreground">${Math.round(dpSales).toLocaleString()}</span>
                      {dpLastWeekSales > 0 && (
                        <span className={`ml-0.5 ${dpVariance >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {dpVariance >= 0 ? "+" : ""}{Math.round(dpVariance)}%
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex justify-between text-xs text-muted-foreground mb-2">
              <span>Labor Hours Deployed</span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-green-500" />
                  Right-sized
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-red-500" />
                  Overstaffed
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-sm bg-yellow-500" />
                  Understaffed
                </span>
                <span className="flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-orange-500" />
                  No Mgr
                </span>
              </div>
            </div>
            <div
              className="flex items-end gap-0.5 h-10"
              data-testid={`staffing-chart-${restaurant.restaurantId}`}
              onMouseLeave={() => setHoveredHourIndex(null)}
            >
              {activeHours.map((hour, hourIndex) => {
                const positions = hour.positionBreakdown || {};
                const operatorHours = positions['_operatorScheduled'] || 0;
                const laborHours = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHours);
                const sales = hour.todaySales || 0;
                const staffingDetails = getStaffingBreakdown(hour.hour, sales);
                const recommendedHours = staffingDetails.total;
                const staffingDiff = laborHours - recommendedHours;
                const isRightSized = Math.abs(staffingDiff) <= 1;
                const isOverstaffed = staffingDiff > 1;
                const isUnderstaffed = staffingDiff < -1;
                const hasNoData = laborHours === 0 && sales === 0 && operatorHours === 0;
                const maxDisplayHours = 15;
                const displayHours = Math.min(laborHours, maxDisplayHours);
                const barHeightPx = hasNoData ? 0 : Math.max(3, (displayHours / maxDisplayHours) * 40);
                const targetDisplayHours = Math.min(recommendedHours, maxDisplayHours);
                const targetLineHeightPx = (targetDisplayHours / maxDisplayHours) * 40;
                const barColor = isRightSized
                  ? "bg-green-500 dark:bg-green-400"
                  : isOverstaffed
                    ? "bg-red-500 dark:bg-red-400"
                    : "bg-yellow-500 dark:bg-yellow-400";
                const positionKeys = Object.keys(positions).map(k => k.toLowerCase());
                const hasManager = positionKeys.some(p => p.includes("manager"));
                const hasShiftSupervisor = positionKeys.some(p => p.includes("shift supervisor") || p.includes("supervisor"));
                const hasOperatorScheduled = positions['_operatorScheduled'] === 1;
                const missingLeadership = !hasManager && !hasShiftSupervisor && !hasOperatorScheduled && laborHours > 0;
                const isHovered = hoveredHourIndex === hourIndex;

                return (
                  <div
                    key={`staff-${hour.hour}`}
                    className="flex-1 flex items-end relative h-full cursor-pointer"
                    onMouseEnter={() => setHoveredHourIndex(hourIndex)}
                    onMouseLeave={() => setHoveredHourIndex(null)}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      setHoveredHourIndex(hoveredHourIndex === hourIndex ? null : hourIndex);
                    }}
                  >
                    {hasNoData ? (
                      <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-sm" />
                    ) : (
                      <>
                        {(() => {
                          const qb = hour.quarterBreakdown;
                          if (qb && (qb.q0 > 0 || qb.q1 > 0 || qb.q2 > 0 || qb.q3 > 0)) {
                            const maxQ = Math.max(qb.q0, qb.q1, qb.q2, qb.q3, 0.01);
                            return (
                              <div
                                className="w-full flex items-end gap-px"
                                style={{ height: `${barHeightPx}px` }}
                              >
                                {[qb.q0, qb.q1, qb.q2, qb.q3].map((qVal, qi) => (
                                  <div
                                    key={qi}
                                    className={`flex-1 rounded-t-[1px] ${barColor}`}
                                    style={{
                                      height: `${Math.max(1, (qVal / maxQ) * barHeightPx)}px`,
                                      opacity: qVal > 0 ? 1 : 0.3
                                    }}
                                  />
                                ))}
                              </div>
                            );
                          }
                          return (
                            <div
                              className={`w-full rounded-t-sm transition-all ${barColor}`}
                              style={{ height: `${barHeightPx}px` }}
                            />
                          );
                        })()}
                        <div
                          className="absolute w-full border-t-2 border-slate-800 dark:border-slate-200 pointer-events-none"
                          style={{ bottom: `${targetLineHeightPx}px` }}
                        />
                        {missingLeadership && (
                          <div className="absolute -top-1 left-1/2 -translate-x-1/2">
                            <AlertTriangle className="w-3 h-3 text-orange-500 animate-pulse" />
                          </div>
                        )}
                      </>
                    )}
                    <div className={`absolute bottom-full mb-1 ${getTooltipAlign(hourIndex)} bg-popover border shadow-md rounded px-2 py-1 text-xs pointer-events-none z-10 whitespace-nowrap transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{hour.label}</span>
                          {missingLeadership && (
                            <span className="text-orange-500 flex items-center gap-0.5">
                              <AlertTriangle className="w-3 h-3" />
                            </span>
                          )}
                          <span className={isRightSized ? "text-green-600" : isOverstaffed ? "text-red-600" : "text-yellow-600"}>
                            {laborHours.toFixed(1)}h/{recommendedHours}h
                          </span>
                          {(() => {
                            const crewHour = hourlyCrewData?.find(c => c.hour === hour.hour);
                            if (!crewHour || crewHour.experienceScore === 0) return null;
                            const score = crewHour.experienceScore;
                            const color = score >= 75 ? "text-green-600" : score >= 50 ? "text-amber-600" : "text-red-600";
                            const { trainee = 0, developing = 0, experienced = 0, veteran = 0 } = crewHour.tenureMix || {};
                            const parts: string[] = [];
                            if (veteran > 0) parts.push(`${veteran}V`);
                            if (experienced > 0) parts.push(`${experienced}E`);
                            if (developing > 0) parts.push(`${developing}D`);
                            if (trainee > 0) parts.push(`${trainee}T`);
                            return (
                              <span className={color}>
                                XP:{score} {parts.length > 0 && <span className="opacity-75">{parts.join('/')}</span>}
                              </span>
                            );
                          })()}
                        </div>
                        {(() => {
                          const leaders = hour.leaders || [];
                          if (leaders.length > 0) {
                            return (
                              <div className="text-muted-foreground text-[10px]">
                                {leaders.map((l, i) => (
                                  <span key={i}>
                                    {i > 0 && ', '}
                                    <span className="font-medium">{l.firstName}</span>
                                    <span className="opacity-70"> ({l.position.includes('Manager') ? 'MGR' : l.position.includes('Supervisor') ? 'SS' : 'OP'})</span>
                                  </span>
                                ))}
                              </div>
                            );
                          }
                          const posKeys = Object.keys(positions)
                            .filter(k => !k.startsWith('_') && positions[k] > 0);
                          if (posKeys.length === 0) return null;
                          return (
                            <div className="text-muted-foreground text-[10px]">
                              {posKeys.slice(0, 5).join(', ')}{posKeys.length > 5 ? '...' : ''}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {(() => {
              const totals = activeHours.reduce((acc, hour) => {
                const positions = hour.positionBreakdown || {};
                const operatorHrs = positions['_operatorScheduled'] || 0;
                const laborHrs = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHrs);
                const sales = hour.todaySales || 0;
                const hasData = laborHrs > 0 || sales > 0 || operatorHrs > 0;
                if (hasData) {
                  const staffingDetails = getStaffingBreakdown(hour.hour, sales);
                  acc.totalDeployed += laborHrs;
                  acc.totalTarget += staffingDetails.total;
                  acc.hoursWithData++;
                }
                acc.totalLaborDollars += (hour.actualLabor || 0);
                return acc;
              }, { totalDeployed: 0, totalTarget: 0, hoursWithData: 0, totalLaborDollars: 0 });

              const staffingDiff = totals.totalDeployed - totals.totalTarget;
              const isOverstaffed = staffingDiff > 0;
              const isUnderstaffed = staffingDiff < 0;
              if (totals.hoursWithData === 0) return null;

              const dayLaborPct = restaurant.actualSales > 0
                ? (totals.totalLaborDollars / restaurant.actualSales) * 100
                : 0;
              const wtdLaborPct = weeklyData && weeklyData.currentWeek > 0 && weeklyData.wtdLaborCost
                ? (weeklyData.wtdLaborCost / weeklyData.currentWeek) * 100
                : 0;
              const overrideTarget = restaurant.laborTarget || 25;
              // Prefer the sales-plan target for the day/week. Fall back to
              // the per-unit override (or 25%) when no plan row exists.
              const dayTarget = restaurant.dayPlanLaborPct ?? overrideTarget;
              const wtdTarget = restaurant.wtdPlanLaborPct ?? overrideTarget;
              const dayTargetSource = restaurant.dayPlanLaborPct != null ? 'plan' : 'default';
              const wtdTargetSource = restaurant.wtdPlanLaborPct != null ? 'plan' : 'default';
              const dayTargetLabel = `${dayTargetSource === 'plan' ? 'Plan' : 'Default'} target ${dayTarget.toFixed(1)}%`;
              const wtdTargetLabel = `${wtdTargetSource === 'plan' ? 'Plan' : 'Default'} target ${wtdTarget.toFixed(1)}%`;
              const dayTargetInline = `${dayTarget.toFixed(1)}%`;
              const wtdTargetInline = `${wtdTarget.toFixed(1)}%`;

              return (
                <div className="mt-2 flex justify-between items-center text-xs">
                  <span className="text-muted-foreground">
                    Day Total: {totals.totalDeployed.toFixed(1)} labor hrs / {totals.totalTarget} target
                  </span>
                  <div className="flex items-center gap-3">
                    {totals.totalLaborDollars > 0 && (
                      <span className="text-muted-foreground">
                        LC%{' '}
                        <span
                          className={`font-medium ${dayLaborPct <= dayTarget ? "text-green-500" : "text-red-500"}`}
                          title={dayTargetLabel}
                          data-testid={`text-lc-day-${restaurant.restaurantId}`}
                        >
                          Day {dayLaborPct.toFixed(1)}%
                        </span>
                        <span
                          className="text-muted-foreground"
                          data-testid={`text-lc-day-target-${restaurant.restaurantId}`}
                        >
                          {' / '}{dayTargetInline} target
                        </span>
                        {wtdLaborPct > 0 && (
                          <>
                            {' '}
                            <span
                              className={`font-medium ${wtdLaborPct <= wtdTarget ? "text-green-500" : "text-red-500"}`}
                              title={wtdTargetLabel}
                              data-testid={`text-lc-wtd-${restaurant.restaurantId}`}
                            >
                              WTD {wtdLaborPct.toFixed(1)}%
                            </span>
                            <span
                              className="text-muted-foreground"
                              data-testid={`text-lc-wtd-target-${restaurant.restaurantId}`}
                            >
                              {' / '}{wtdTargetInline} target
                            </span>
                          </>
                        )}
                      </span>
                    )}
                    <span className={`font-medium ${
                      isOverstaffed ? "text-red-500" :
                      isUnderstaffed ? "text-yellow-500" :
                      "text-green-500"
                    }`} data-testid={`staffing-total-${restaurant.restaurantId}`}>
                      {isOverstaffed ? `+${staffingDiff.toFixed(1)} overstaffed` :
                       isUnderstaffed ? `${staffingDiff.toFixed(1)} understaffed` :
                       "Right-sized"}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </>
  );
});

export const LeaderboardCard = memo(function LeaderboardCard({ restaurant, hourlyData, crewSummary, hourlyCrewData, checkAverage, checkAvgTrend, consistencyScore, demandCurveHours, destinationsByHour, isToday = true, yoyData, weeklyData, notes, dateStr, onNoteAdded, attachmentCategories, overallAttachScore, helperRewardPoints, planQtd, planQtdRange }: LeaderboardCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const gradingCfg = useGradingConfig();

  // formatCurrency, formatPercentage, formatSignedCurrency are module-level (stable references)

  const displayLastWeek = restaurant.actualLastWeekSales ?? restaurant.lastWeekSales;
  const comparisonSales = restaurant.completedSales ?? restaurant.actualSales;
  const paceVariance = displayLastWeek > 0 
    ? ((comparisonSales / displayLastWeek) - 1) * 100 
    : 0;
  // Apples-to-apples: compare today's COMPLETED-hour sales to LW's COMPLETED-hour sales
  // (both windows end at restaurantCompletedHour = local current hour - 1). Using
  // `actualSales` here would include today's in-progress hour while LW excludes it,
  // which artificially inflates variance (especially for Eastern-tz stores whose
  // in-progress hour is typically a higher-volume one in Central-clock snapshots).
  const displayDayVariance = displayLastWeek > 0
    ? ((comparisonSales / displayLastWeek) - 1) * 100
    : 0;


  // Pre-compute values for the sales grid
  const isDayComplete = restaurant.normalizedHour >= 23;
  const lwFullDay = restaurant.lastWeekFullDay ?? (displayLastWeek + Math.max(0, restaurant.forecastSales - restaurant.actualSales));
  const dayForecastVar = lwFullDay > 0
    ? ((restaurant.forecastSales / lwFullDay) - 1) * 100
    : 0;

  // YoY: only for SSS restaurants (>24 months open)
  const isSSS = !restaurant.openDate || (() => {
    const open = new Date(restaurant.openDate);
    const now = new Date();
    return ((now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth())) > 24;
  })();
  const yoyPrior = yoyData?.priorNetSales ?? 0;
  const showYoY = yoyPrior > 0 && isSSS;
  // Current column: compare partial-day actual vs estimated LY sales at same point in the day.
  // Use last week's demand curve to estimate what fraction of LY's day would be complete by now:
  // progressRatio = displayLastWeek (LW partial) / lwFullDay (LW estimated full day)
  const lwProgressRatio = lwFullDay > 0 ? displayLastWeek / lwFullDay : (restaurant.normalizedHour + 1) / 24;
  const yoyPriorPartial = yoyPrior * lwProgressRatio;
  const currentYoYVar = showYoY && yoyPriorPartial > 0
    ? ((restaurant.actualSales / yoyPriorPartial) - 1) * 100 : 0;
  const projYoYVar = showYoY
    ? (((isDayComplete ? restaurant.actualSales : restaurant.forecastSales) / yoyPrior) - 1) * 100
    : 0;
  const currentYoYDollar = showYoY ? restaurant.actualSales - yoyPriorPartial : 0;
  const projYoYDollar = showYoY
    ? (isDayComplete ? restaurant.actualSales : restaurant.forecastSales) - yoyPrior
    : 0;

  // Weekly variances
  const wkVar = weeklyData && weeklyData.priorWeek > 0
    ? ((weeklyData.currentWeek / weeklyData.priorWeek) - 1) * 100
    : 0;
  const eowVar = weeklyData && weeklyData.priorWeekFull > 0
    ? ((weeklyData.eowForecast / weeklyData.priorWeekFull) - 1) * 100
    : 0;
  const showEow = !!(weeklyData && weeklyData.eowForecast > weeklyData.currentWeek);

  // QTD vs Plan variance (quarter-to-date through the previous full day)
  const planQtdVar = planQtd && planQtd.plannedSales > 0
    ? ((planQtd.actualSales / planQtd.plannedSales) - 1) * 100
    : 0;
  const planQtdDollar = planQtd
    ? planQtd.actualSales - planQtd.plannedSales
    : 0;
  const showPlanQtd = !!(planQtd && planQtd.plannedSales > 0);
  const planQtdRangeLabel = planQtdRange
    ? (() => {
        const fmt = (iso: string) =>
          new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        return `${fmt(planQtdRange.quarterStart)} – ${fmt(planQtdRange.throughDate)}`;
      })()
    : "";

  // Show all 24 hours individually (no Early Bird combining since we have full POS data)
  // Generate all 24 hours, filling in zeros for missing hours
  // Use localCurrentHour for grade display (restaurant's own timezone)
  // Fall back to normalizedHour if not available (for backward compatibility)
  const localGradeCutoff = restaurant.localCurrentHour ?? restaurant.normalizedHour;
  const normalizedCutoff = restaurant.normalizedHour;

  // Memoize the 24-hour array so it is only rebuilt when hourlyData changes
  const allHours = useMemo(() => {
    const map = new Map<number, HourlySalesData>();
    (hourlyData || []).forEach(item => map.set(item.hour, item));
    const hours: HourlySalesData[] = [];
    for (let h = 0; h < 24; h++) {
      const existing = map.get(h);
      hours.push(existing ?? ({
        hour: h,
        todaySales: 0,
        lastWeekSales: 0,
        forecastSales: 0,
        employeeCount: 0,
        projectedLabor: 0,
        actualLabor: 0,
        label: h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`,
      } as HourlySalesData));
    }
    return hours;
  }, [hourlyData]);

  const activeHours = allHours;

  // Memoize peak/max values used for bar chart scaling
  const { peakHourData, hourlyRateTier, maxSales } = useMemo(() => {
    const peak = allHours.reduce<{ sales: number; hour: number }>(
      (best, h) => (h.todaySales > best.sales ? { sales: h.todaySales, hour: h.hour } : best),
      { sales: 0, hour: 0 }
    );
    return {
      peakHourData: peak,
      hourlyRateTier: getHourlyRateTier(peak.sales),
      maxSales: Math.max(...allHours.map(h => Math.max(h.todaySales, h.lastWeekSales, h.forecastSales)), 1),
    };
  }, [allHours]);
  
  // Memoize the full grade computation — O(n×24) work only re-runs when hourly data or config changes
  const { gradedHours, hourlyGradeScores, overallScore, overallGrade, dailyBonusResult } = useMemo(() => {
    const gradedHours = allHours
      .filter(hour => hour.hour <= localGradeCutoff)
      .filter(hour => hour.todaySales && hour.todaySales > 0);

    const hourlyGradeScores = gradedHours
      .map(hour => {
        // Use server-pre-computed grade if available; fall back to client-side computation
        if (hour.gradeScore !== undefined && hour.gradeHasGrade) return hour.gradeScore;
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
        const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
        const fs = restaurant.feedbackSpeed;
        const gradeInfo = getExecutionGrade(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, txnVar, hasCompTxn, gradingCfg, fs?.responses ? fs.topBoxPercent : undefined, fs?.responses);
        return gradeInfo.hasGrade ? gradeInfo.score : 0;
      }).filter(score => score > 0);

    let overallScore = 0;
    let dailyBonusResult: ReturnType<typeof computeDailyBonuses> | null = null;
    if (hourlyGradeScores.length > 0) {
      const baseScore = hourlyGradeScores.reduce((a, b) => a + b, 0) / hourlyGradeScores.length;

      const dailyTotalSales = gradedHours.reduce((s, h) => s + h.todaySales, 0);
      const dailyTotalLWSales = gradedHours.reduce((s, h) => s + h.lastWeekSales, 0);
      const dailySalesVar = dailyTotalLWSales > 0 ? ((dailyTotalSales - dailyTotalLWSales) / dailyTotalLWSales) * 100 : undefined;
      const dailyTotalTxn = gradedHours.reduce((s, h) => s + (h.transactionCount || 0), 0);
      const dailyTotalLWTxn = gradedHours.reduce((s, h) => s + (h.lastWeekTransactionCount || 0), 0);
      const dailyTxnVar = dailyTotalLWTxn > 0 ? ((dailyTotalTxn - dailyTotalLWTxn) / dailyTotalLWTxn) * 100 : undefined;
      const osatHoursForBonus = gradedHours.filter(h => h.osatPercent !== undefined && (h.osatResponses ?? 0) > 0);
      const dailyOsatResponses = osatHoursForBonus.reduce((s, h) => s + (h.osatResponses ?? 0), 0);
      const dailyOsatPct = dailyOsatResponses > 0 ? osatHoursForBonus.reduce((s, h) => s + (h.osatPercent ?? 0) * (h.osatResponses ?? 0), 0) / dailyOsatResponses : undefined;

      const yoyPriorSales = yoyData?.priorNetSales ?? 0;
      const dailyYoySalesVar = yoyPriorSales > 0 && isSSS
        ? ((dailyTotalSales - yoyPriorSales) / yoyPriorSales) * 100
        : undefined;

      const attachCatsAtTarget = attachmentCategories ? countAttachmentCategoriesAtTarget(attachmentCategories) : undefined;
      dailyBonusResult = computeDailyBonuses({
        dailyOsatPercent: dailyOsatPct,
        dailySurveyCount: dailyOsatResponses,
        dailySalesVariancePct: dailySalesVar,
        dailyTransactionVariancePct: dailyTxnVar,
        dailyYoySalesVariancePct: dailyYoySalesVar,
        attachmentCategoriesAtTarget: attachCatsAtTarget,
        hourlyScores: hourlyGradeScores,
        helperRewardPoints,
      });

      overallScore = Math.min(baseScore + dailyBonusResult.cappedBonus, 100);
    }
    const overallGrade = hourlyGradeScores.length > 0 ? scoreToGrade(overallScore) : null;

    return { gradedHours, hourlyGradeScores, overallScore, overallGrade, dailyBonusResult };
  }, [allHours, localGradeCutoff, gradingCfg, yoyData, isSSS, attachmentCategories, helperRewardPoints, restaurant.feedbackSpeed?.topBoxPercent, restaurant.feedbackSpeed?.responses]);

  // Memoize daypart grades — depends on the same inputs as overall grade
  const daypartGrades = useMemo(() => DAYPARTS.map(dp => {
    const dpScores = allHours
      .filter(hour => hour.hour >= dp.startHour && hour.hour <= dp.endHour)
      .filter(hour => hour.hour <= localGradeCutoff)
      .filter(hour => hour.todaySales && hour.todaySales > 0)
      .map(hour => {
        // Use server-pre-computed grade if available; fall back to client-side computation
        if (hour.gradeScore !== undefined && hour.gradeHasGrade) return hour.gradeScore;
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
        const txnVar = hasCompTxn ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100 : undefined;
        const fs = restaurant.feedbackSpeed;
        const gradeInfo = getExecutionGrade(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, txnVar, hasCompTxn, gradingCfg, fs?.responses ? fs.topBoxPercent : undefined, fs?.responses);
        return gradeInfo.hasGrade ? gradeInfo.score : 0;
      }).filter(s => s > 0);

    if (dpScores.length === 0) return { ...dp, grade: null, score: 0 };
    const avg = dpScores.reduce((a, b) => a + b, 0) / dpScores.length;
    const gradeResult = scoreToGrade(avg);
    return { ...dp, grade: gradeResult.grade, score: avg };
  }).filter(dp => dp.grade !== null), [allHours, localGradeCutoff, gradingCfg, restaurant.feedbackSpeed?.topBoxPercent, restaurant.feedbackSpeed?.responses]);

  // Memoize demand curve lookup map
  const demandCurveMap = useMemo(() => {
    const map = new Map<number, DemandCurveHour>();
    if (demandCurveHours) demandCurveHours.forEach(h => map.set(h.hour, h));
    return map;
  }, [demandCurveHours]);

  // No in-progress hour needed since we only show completed hours now

  return (
    <div
      className="rounded-xl border border-border/50 bg-card transition-colors hover:border-border"
      data-testid={`card-restaurant-${restaurant.restaurantId}`}
    >
      <div className="p-2.5 sm:p-3">
        <div className="flex items-start sm:items-center gap-2 sm:gap-3">
          {/* Rank badge */}
          <div className="flex-shrink-0 mt-0.5 sm:mt-0">
            {restaurant.status === "training" ? (
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold text-muted-foreground bg-muted/50"
                data-testid={`text-rank-${restaurant.restaurantId}`}
              >
                --
              </div>
            ) : (
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold ${
                  restaurant.rank === 1
                    ? "bg-yellow-500/15 text-yellow-500"
                    : restaurant.rank === 2
                      ? "bg-muted text-foreground/70"
                      : restaurant.rank === 3
                        ? "bg-orange-500/15 text-orange-500"
                        : "bg-muted/50 text-muted-foreground"
                }`}
                data-testid={`text-rank-${restaurant.restaurantId}`}
              >
                #{restaurant.rank}
              </div>
            )}
          </div>

          {/* Content: stacks vertically on mobile, horizontal on desktop */}
          <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-start sm:gap-3">
            {/* Name + badges section */}
            <div className="flex-1 min-w-0">
              {/* Store name + status badge */}
              <div className="flex items-center gap-1.5 mb-0.5">
                <h3
                  className="font-medium text-sm truncate"
                  data-testid={`text-restaurant-name-${restaurant.restaurantId}`}
                >
                  {restaurant.restaurantName}
                </h3>
                {restaurant.status === "training" && (
                  <Badge variant="secondary" className="flex-shrink-0 text-xs" data-testid={`badge-training-${restaurant.restaurantId}`}>
                    Training - Opens {restaurant.openDate ? new Date(restaurant.openDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBD'}
                  </Badge>
                )}
                {restaurant.status === "new" && (
                  <Badge className="bg-blue-500 hover:bg-blue-600 flex-shrink-0 text-xs text-white" data-testid={`badge-new-unit-${restaurant.restaurantId}`}>
                    NU {restaurant.daysOpen && restaurant.daysOpen >= 7 ? `${Math.floor(restaurant.daysOpen / 7)}w` : `<1w`}
                  </Badge>
                )}
              </div>
              {/* Metric badges row */}
              <div className="flex items-center gap-1 flex-wrap">
                {/* Overall Execution Grade + Daypart Grades */}
                {overallGrade && (
                  <BadgeWithTooltip
                    variant="outline"
                    className={`flex-shrink-0 text-xs font-bold ${overallGrade.color} border-current`}
                    data-testid={`badge-grade-${restaurant.restaurantId}`}
                    tooltipContent={
                      <>
                        {daypartGrades.length > 0 ? (
                          <div>
                            <div className="font-medium mb-1">Daypart Grades</div>
                            <div className="flex flex-col gap-0.5">
                              {daypartGrades.map(dp => {
                                // Compute daypart sales and variance for tooltip
                                let dpSales = 0, dpLWSales = 0;
                                if (hourlyData) {
                                  for (let h = dp.startHour; h <= dp.endHour; h++) {
                                    const hd = hourlyData.find(x => x.hour === h);
                                    if (hd) { dpSales += hd.todaySales || 0; dpLWSales += hd.lastWeekSales || 0; }
                                  }
                                }
                                const dpVar = dpLWSales > 0 ? ((dpSales - dpLWSales) / dpLWSales) * 100 : 0;
                                return (
                                  <div key={dp.id} className="flex items-center justify-between gap-3">
                                    <span className="text-muted-foreground">{dp.label}</span>
                                    <div className="flex items-center gap-2">
                                      <span className={`font-bold ${dpGetGradeColor(dp.grade!)}`}>{dp.grade}</span>
                                      {dpSales > 0 && (
                                        <span className="text-[10px]">
                                          ${Math.round(dpSales).toLocaleString()}
                                          {dpLWSales > 0 && (
                                            <span className={`ml-1 ${dpVar >= 0 ? "text-green-500" : "text-red-500"}`}>
                                              {dpVar >= 0 ? "+" : ""}{Math.round(dpVar)}%
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div>Overall execution grade based on sales, transactions, OSAT, speed, and staffing</div>
                        )}
                        <div className="mt-1.5 pt-1.5 border-t"><Link href="/scoring" className="text-blue-500 hover:underline text-[10px]">How is this calculated?</Link></div>
                      </>
                    }
                  >
                    EXC: {overallGrade.grade}
                  </BadgeWithTooltip>
                )}
                {/* Bonus Points Badge — shows when bonus was earned */}
                {dailyBonusResult && dailyBonusResult.cappedBonus > 0 && (
                  <BadgeWithTooltip
                    className="flex-shrink-0 text-xs px-1.5 gap-0.5 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-0"
                    tooltipContent={
                      <div className="space-y-1">
                        <div className="font-semibold">Bonus Points Earned</div>
                        {dailyBonusResult.bonuses.map(b => (
                          <div key={b.id} className="flex justify-between gap-4">
                            <span>{b.label}</span>
                            <span className="text-yellow-500 font-semibold">+{b.points}</span>
                          </div>
                        ))}
                        {dailyBonusResult.totalBonus > 8 && (
                          <div className="text-muted-foreground border-t pt-1 mt-1">Capped at +8 (earned {dailyBonusResult.totalBonus})</div>
                        )}
                      </div>
                    }
                  >
                    <Sparkles className="w-3 h-3" />
                    <span className="font-semibold">+{dailyBonusResult.cappedBonus}</span>
                  </BadgeWithTooltip>
                )}
                {/* Google Reviews Badge */}
                {restaurant.googleReviews && (
                  <BadgeWithTooltip
                    className={`flex-shrink-0 text-xs px-1.5 gap-1 ${
                      restaurant.googleReviews.rating >= 4.5
                        ? "bg-green-500/10 text-green-500"
                        : restaurant.googleReviews.rating >= 4.0
                          ? "bg-blue-500/10 text-blue-500"
                          : restaurant.googleReviews.rating >= 3.5
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "bg-red-500/10 text-red-500"
                    } border-0`}
                    data-testid={`badge-reviews-${restaurant.restaurantId}`}
                    tooltipTitle="Google Reviews"
                    tooltipDetail={`${restaurant.googleReviews.reviewCount.toLocaleString()} total reviews`}
                  >
                    <Star className="w-3 h-3" />
                    <span className="font-medium">
                      {restaurant.googleReviews.rating.toFixed(1)}
                      {(restaurant.googleReviews.newReviewsToday || 0) > 0 && (
                        <span className="ml-1 text-muted-foreground">+{restaurant.googleReviews.newReviewsToday}</span>
                      )}
                    </span>
                  </BadgeWithTooltip>
                )}
                {/* OSAT Badge */}
                {restaurant.osat && restaurant.osat.totalResponses > 0 && (
                  <BadgeWithTooltip
                    className={`flex-shrink-0 text-xs px-1.5 gap-1 ${
                      restaurant.osat.osatPercent >= 85
                        ? "bg-green-500/10 text-green-500"
                        : restaurant.osat.osatPercent >= 80
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : "bg-red-500/10 text-red-500"
                    } border-0`}
                    data-testid={`badge-osat-${restaurant.restaurantId}`}
                    tooltipTitle="Customer Satisfaction (OSAT)"
                    tooltipDetail={`${restaurant.osat.fiveStarCount} of ${restaurant.osat.totalResponses} responses = 5 stars`}
                  >
                    <ThumbsUp className="w-3 h-3" />
                    <span className="font-medium">{restaurant.osat.osatPercent.toFixed(0)}%</span>
                  </BadgeWithTooltip>
                )}
                {/* Customer-feedback Speed of Service Badge (Qualtrics survey) */}
                {restaurant.feedbackSpeed && (() => {
                  const fs = restaurant.feedbackSpeed;
                  const isGeneric = fs.source === 'generic';
                  const sourceLabel = isGeneric ? 'Speed of Service (in-store)' : 'DT Speed of Service';
                  const questionLabel = isGeneric ? 'generic Speed of Service question' : 'DT Speed of Service question';
                  const hasData = fs.responses > 0;

                  if (!hasData) {
                    return (
                      <BadgeWithTooltip
                        className="bg-muted text-muted-foreground border-0 flex-shrink-0 text-xs px-1.5 gap-1"
                        data-testid={`badge-feedback-speed-${restaurant.restaurantId}`}
                        tooltipContent={
                          <div>
                            <div className="font-medium">{sourceLabel}</div>
                            <div className="text-muted-foreground">No survey responses today</div>
                            <div className="text-muted-foreground">Source: {questionLabel}</div>
                          </div>
                        }
                      >
                        <Gauge className="w-3 h-3" />
                        <span>—</span>
                      </BadgeWithTooltip>
                    );
                  }

                  // 5-star top-box %: matches OSAT and the Qualtrics dashboard exactly.
                  // Only responses that gave 5★ count; skipped questions are already excluded from `responses`.
                  const pct = fs.topBoxPercent;
                  const ratingColor = pct >= 90
                    ? "bg-green-500/10 text-green-500"
                    : pct >= 80
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "bg-red-500/10 text-red-500";
                  const isRed = pct < 80;

                  return (
                    <BadgeWithTooltip
                      className={`${ratingColor} border-0 flex-shrink-0 text-xs px-1.5 gap-1 ${isRed ? 'animate-pulse' : ''}`}
                      data-testid={`badge-feedback-speed-${restaurant.restaurantId}`}
                      tooltipContent={
                        <div>
                          <div className="font-medium">{sourceLabel}</div>
                          <div className="text-muted-foreground">
                            Guest score: {pct.toFixed(1)}% ({fs.fiveStarCount} of {fs.responses} gave 5★)
                          </div>
                          <div className="text-muted-foreground">
                            <span className="block text-[10px]">
                              (skipped questions are not counted)
                            </span>
                          </div>
                          <div className="text-muted-foreground">Source: {questionLabel}</div>
                        </div>
                      }
                    >
                      <Gauge className="w-3 h-3" />
                      <span>{pct.toFixed(0)}%</span>
                    </BadgeWithTooltip>
                  );
                })()}
                {/* Drive-Thru SOS Badge */}
                {restaurant.driveThru && (() => {
                  const carCount = restaurant.driveThru.carCount || 0;
                  const carsUnder6 = restaurant.driveThru.carsUnder6Min ?? 0;
                  const attainment = carCount > 0 ? Math.round((carsUnder6 / carCount) * 100) : 0;
                  const attColor = attainment >= 70
                    ? "bg-green-500/10 text-green-500"
                    : attainment >= 50
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "bg-red-500/10 text-red-500";

                  const isRed = attainment < 50;
                  const avgTime = restaurant.driveThru.avgTotalTime;
                  const timeStr = `${Math.floor(avgTime / 60)}:${(avgTime % 60).toString().padStart(2, '0')}`;
                  return (
                    <BadgeWithTooltip
                      className={`${attColor} border-0 flex-shrink-0 text-xs px-1.5 gap-1 ${isRed ? 'animate-pulse' : ''}`}
                      data-testid={`badge-sos-${restaurant.restaurantId}`}
                      tooltipContent={
                        <div>
                          <div className="font-medium">Drive-Thru Speed</div>
                          <div className="text-muted-foreground">
                            Attainment: {attainment}% under 6 min
                          </div>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Clock className="w-3 h-3" />
                            Avg total: {timeStr}
                          </div>
                          <div className="text-muted-foreground">
                            Cars today: {carCount} ({carsUnder6} under 6 min)
                          </div>
                        </div>
                      }
                    >
                      <Car className="w-3 h-3" />
                      <span>{attainment}%</span>
                    </BadgeWithTooltip>
                  );
                })()}
                {attachmentCategories?.banana_pudding && attachmentCategories.banana_pudding.attachRate >= 5 && (
                  <BadgeWithTooltip
                    className="flex-shrink-0 text-xs px-1.5 gap-1 border-0 bg-yellow-400/20 text-yellow-700 dark:text-yellow-300"
                    data-testid={`badge-banana-${restaurant.restaurantId}`}
                    tooltipTitle="Gone Bananas! 🍌"
                    tooltipDetail={`Banana Pudding Shake attach rate: ${attachmentCategories.banana_pudding.attachRate.toFixed(1)}% (target: 5%). This unit is crushing the LTO!`}
                  >
                    <span className="font-medium">🍌 {attachmentCategories.banana_pudding.attachRate.toFixed(1)}%</span>
                  </BadgeWithTooltip>
                )}
                {attachmentCategories?.kids_meal && attachmentCategories.kids_meal.attachRate >= 5 && (
                  <BadgeWithTooltip
                    className="flex-shrink-0 text-xs px-1.5 gap-1 border-0 bg-pink-400/20 text-pink-700 dark:text-pink-300"
                    data-testid={`badge-kids-meal-${restaurant.restaurantId}`}
                    tooltipTitle="Kids Meal Crown 🧒"
                    tooltipDetail={`Kids Meal attach rate: ${attachmentCategories.kids_meal.attachRate.toFixed(1)}% (target: 5 per 100 transactions). This unit is winning with families!`}
                  >
                    <span className="font-medium">🧒 {attachmentCategories.kids_meal.attachRate.toFixed(1)}%</span>
                  </BadgeWithTooltip>
                )}
                {restaurant.osat && restaurant.osat.totalResponses > 3 && (
                  <BadgeWithTooltip
                    className="flex-shrink-0 text-xs px-1.5 gap-1 border-0 bg-blue-500/15 text-blue-700 dark:text-blue-300"
                    data-testid={`badge-guest-voice-${restaurant.restaurantId}`}
                    tooltipTitle="Guest Voice 🗣️"
                    tooltipDetail={`${restaurant.osat.totalResponses} guest surveys received today (bonus unlocks at 4+). +2 bonus points applied to today's grade.`}
                  >
                    <span className="font-medium">🗣️ {restaurant.osat.totalResponses}</span>
                  </BadgeWithTooltip>
                )}
                {/* Revenue Port Badges */}
                {restaurant.revenuePorts && restaurant.revenuePorts.length > 0 && (
                  <div className="hidden sm:flex items-center gap-1">
                    {restaurant.revenuePorts.filter(p => !(p === "drive_thru" && restaurant.driveThru)).map(port => {
                      const config = REVENUE_PORT_CONFIG[port as keyof typeof REVENUE_PORT_CONFIG];
                      if (!config) return null;
                      const Icon = config.icon;
                      return (
                        <BadgeWithTooltip
                          key={port}
                          className={`${config.color} border-0 flex-shrink-0 text-xs px-1.5`}
                          data-testid={`badge-port-${port}-${restaurant.restaurantId}`}
                          tooltipTitle={config.label}
                          tooltipDetail={config.description}
                        >
                          <Icon className="w-3 h-3" />
                        </BadgeWithTooltip>
                      );
                    })}
                  </div>
                )}
                {/* Notes Count Badge — click to preview */}
                {notes && notes.length > 0 && (
                  <BadgeWithTooltip
                    variant="outline"
                    className="flex-shrink-0 text-xs gap-0.5 text-muted-foreground border-muted-foreground/30"
                    side="bottom"
                    tooltipContent={
                      <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                        <div className="font-medium text-foreground flex items-center gap-1">
                          <StickyNote className="w-3 h-3" />
                          {notes.length} Note{notes.length !== 1 ? 's' : ''}
                        </div>
                        {notes.map(note => (
                          <div key={note.id} className="text-[11px] leading-snug">
                            <span className="text-foreground">{note.note}</span>
                            <span className="text-muted-foreground ml-1">
                              {note.author && `${note.author.split('@')[0]} · `}
                              {note.hour !== null && `${note.hour === 0 ? '12am' : note.hour < 12 ? `${note.hour}am` : note.hour === 12 ? '12pm' : `${note.hour - 12}pm`} · `}
                              {note.category !== 'general' && `${note.category} · `}
                              {note.createdAt ? new Date(note.createdAt + (String(note.createdAt).match(/[Z+-]/) ? '' : 'Z')).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    }
                  >
                    <StickyNote className="w-2.5 h-2.5" />
                    {notes.length}
                  </BadgeWithTooltip>
                )}
                {/* Hourly Rate Achievement Badge */}
                {hourlyRateTier && (() => {
                  const TierIcon = hourlyRateTier.icon;
                  const peakHourLabel = peakHourData.hour === 0 ? '12am' : peakHourData.hour === 12 ? '12pm' : peakHourData.hour > 12 ? `${peakHourData.hour - 12}pm` : `${peakHourData.hour}am`;
                  return (
                    <BadgeWithTooltip
                      className={`flex-shrink-0 text-xs px-1.5 gap-1 border ${hourlyRateTier.color} ${hourlyRateTier.pulseClass} font-bold`}
                      data-testid={`badge-rate-tier-${restaurant.restaurantId}`}
                      tooltipContent={
                        <div>
                          <div className="font-bold text-sm">{hourlyRateTier.label}</div>
                          <div className="text-muted-foreground">Peak hour: ${peakHourData.sales.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/hr at {peakHourLabel}</div>
                          <div className="text-[10px] text-muted-foreground mt-1 border-t border-border/50 pt-1">
                            $750 Contender · $1,000 Pro · $1,500 Elite · $2,000 Ultra · $2,300 Legendary
                          </div>
                        </div>
                      }
                    >
                      <TierIcon className="w-3 h-3" />
                      <span>{hourlyRateTier.label}</span>
                    </BadgeWithTooltip>
                  );
                })()}
              </div>
            </div>

            {/* Sales table */}
            <div className="flex-shrink-0 mt-1.5 sm:mt-0">
              <table className="tabular-nums text-right" style={{ borderSpacing: 0 }}>
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-muted-foreground">
                    <th className="font-normal" />
                    <th className="font-normal pb-0.5 text-right">Current</th>
                    <th className="font-normal pb-0.5 text-right pl-1">LW</th>
                    <th className="font-normal pb-0.5" />
                    <th className="font-normal pb-0.5 text-right pl-2" colSpan={2}>Projected</th>
                  </tr>
                </thead>
                <tbody className="text-[11px]">
                  {/* DAY row */}
                  <tr>
                    <td className="text-left text-[10px] text-muted-foreground font-medium pr-1.5 pt-0.5">DAY</td>
                    <td className="font-semibold text-xs pl-1 pt-0.5" data-testid={`text-sales-${restaurant.restaurantId}`}>
                      {formatCurrency(restaurant.actualSales)}
                    </td>
                    <td className="text-muted-foreground pl-1 pt-0.5">{formatCurrency(displayLastWeek)}</td>
                    <td
                      className={`font-medium pl-1 pt-0.5 ${displayDayVariance >= 0 ? "text-green-500" : "text-red-500"}`}
                      data-testid={`badge-pace-${restaurant.restaurantId}`}
                    >
                      {formatPercentage(displayDayVariance)}
                    </td>
                    <td className={`pl-2 pt-0.5 ${!isDayComplete ? "font-semibold" : "text-muted-foreground"}`}>
                      {!isDayComplete ? formatCurrency(restaurant.forecastSales) : "—"}
                    </td>
                    <td className={`font-medium pl-1 pt-0.5 ${!isDayComplete ? (dayForecastVar >= 0 ? "text-green-500" : "text-red-500") : ""}`}>
                      {!isDayComplete ? formatPercentage(dayForecastVar) : ""}
                    </td>
                  </tr>
                  {/* WEEK row */}
                  {weeklyData && weeklyData.currentWeek > 0 && (
                    <tr>
                      <td className="text-left text-[10px] text-muted-foreground font-medium pr-1.5 pt-0.5">WTD</td>
                      <td className="font-semibold pl-1 pt-0.5" data-testid={`text-weekly-${restaurant.restaurantId}`}>
                        {formatCurrency(weeklyData.currentWeek)}
                      </td>
                      <td className="text-muted-foreground pl-1 pt-0.5">
                        {weeklyData.priorWeek > 0 ? formatCurrency(weeklyData.priorWeek) : ""}
                      </td>
                      <td className={`font-medium pl-1 pt-0.5 ${wkVar >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {weeklyData.priorWeek > 0 ? formatPercentage(wkVar) : ""}
                      </td>
                      <td
                        className={`pl-2 pt-0.5 ${showEow ? "font-semibold" : "text-muted-foreground"}`}
                        data-testid={`text-eow-${restaurant.restaurantId}`}
                      >
                        {showEow ? formatCurrency(weeklyData.eowForecast) : "—"}
                      </td>
                      <td
                        className={`font-medium pl-1 pt-0.5 ${showEow && weeklyData.priorWeekFull > 0 ? (eowVar >= 0 ? "text-green-500" : "text-red-500") : ""}`}
                        title={showEow && weeklyData.priorWeekFull > 0 ? `vs prior full week ${formatCurrency(weeklyData.priorWeekFull)}` : undefined}
                      >
                        {showEow && weeklyData.priorWeekFull > 0 ? formatPercentage(eowVar) : ""}
                      </td>
                    </tr>
                  )}
                  {/* YoY row */}
                  {showYoY && (
                    <>
                      <tr>
                        <td className="text-left text-[10px] text-muted-foreground font-medium pr-1.5 pt-0.5 whitespace-nowrap">DAY YoY</td>
                        <td
                          className={`font-medium pl-1 pt-0.5 ${currentYoYVar >= 0 ? "text-blue-500" : "text-orange-500"}`}
                          data-testid={`badge-yoy-${restaurant.restaurantId}`}
                        >
                          {formatSignedCurrency(currentYoYDollar)}
                        </td>
                        <td />
                        <td className={`font-medium pl-1 pt-0.5 ${currentYoYVar >= 0 ? "text-blue-500" : "text-orange-500"}`}>
                          {formatPercentage(currentYoYVar)}
                        </td>
                        <td className={`font-medium pl-2 pt-0.5 ${!isDayComplete ? (projYoYVar >= 0 ? "text-blue-500" : "text-orange-500") : ""}`}>
                          {!isDayComplete ? formatSignedCurrency(projYoYDollar) : ""}
                        </td>
                        <td className={`font-medium pl-1 pt-0.5 ${!isDayComplete ? (projYoYVar >= 0 ? "text-blue-500" : "text-orange-500") : ""}`}>
                          {!isDayComplete ? formatPercentage(projYoYVar) : ""}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-left text-[10px] text-muted-foreground font-medium pr-1.5 whitespace-nowrap">LY</td>
                        <td className="text-muted-foreground pl-1">{formatCurrency(yoyPrior)}</td>
                        <td />
                        <td />
                        <td />
                        <td />
                      </tr>
                    </>
                  )}
                  {/* QTD vs Plan row */}
                  {showPlanQtd && (
                    <tr title={`${planQtdRangeLabel} · ${planQtdDollar >= 0 ? "+" : ""}${formatCurrency(planQtdDollar)} vs plan`}>
                      <td className="text-left text-[10px] text-muted-foreground font-medium pr-1.5 pt-0.5 whitespace-nowrap">QTD</td>
                      <td
                        className="font-semibold pl-1 pt-0.5"
                        data-testid={`text-plan-qtd-actual-${restaurant.restaurantId}`}
                      >
                        {formatCurrency(planQtd!.actualSales)}
                      </td>
                      <td
                        className="text-muted-foreground pl-1 pt-0.5"
                        data-testid={`text-plan-qtd-plan-${restaurant.restaurantId}`}
                      >
                        {formatCurrency(planQtd!.plannedSales)}
                      </td>
                      <td
                        className={`font-medium pl-1 pt-0.5 ${planQtdVar >= 0 ? "text-green-500" : "text-red-500"}`}
                        data-testid={`badge-plan-qtd-var-${restaurant.restaurantId}`}
                      >
                        {formatPercentage(planQtdVar)}
                      </td>
                      <td
                        className="pl-2 pt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground text-left whitespace-nowrap"
                        colSpan={2}
                      >
                        ← Plan
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Expand/collapse chevron */}
          <div
            className="flex-shrink-0 mt-0.5 sm:mt-0 text-muted-foreground cursor-pointer p-1.5 -m-1.5 rounded-lg hover:bg-muted/50 transition-colors"
            onClick={() => setIsExpanded(!isExpanded)}
            data-testid={`toggle-expand-${restaurant.restaurantId}`}
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" data-testid={`chevron-collapse-${restaurant.restaurantId}`} />
            ) : (
              <ChevronDown className="w-4 h-4" data-testid={`chevron-expand-${restaurant.restaurantId}`} />
            )}
          </div>
        </div>

        {isExpanded && (
          <ExpandedCardContent
            restaurant={restaurant}
            activeHours={activeHours}
            localGradeCutoff={localGradeCutoff}
            normalizedCutoff={normalizedCutoff}
            maxSales={maxSales}
            daypartGrades={daypartGrades}
            demandCurveMap={demandCurveMap}
            destinationsByHour={destinationsByHour}
            hourlyData={hourlyData}
            hourlyCrewData={hourlyCrewData}
            checkAverage={checkAverage}
            checkAvgTrend={checkAvgTrend}
            overallAttachScore={overallAttachScore}
            weeklyData={weeklyData}
            gradingCfg={gradingCfg}
          />
        )}


        {isExpanded && activeHours.length === 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Progress vs. last week</span>
              <span>{restaurant.pacePercentage.toFixed(0)}% of day</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  displayDayVariance >= 0 ? "bg-green-500" : "bg-red-500"
                }`}
                style={{
                  width: `${Math.min(100, (restaurant.actualSales / Math.max(displayLastWeek, 1)) * 100)}%`
                }}
                data-testid={`progress-${restaurant.restaurantId}`}
              />
            </div>
          </div>
        )}

        {/* Notes Section */}
        {isExpanded && (
          <NotesSection
            restaurantId={restaurant.restaurantId}
            dateStr={dateStr || ''}
            notes={notes}
            onNoteAdded={onNoteAdded}
          />
        )}
      </div>
    </div>
  );
});
