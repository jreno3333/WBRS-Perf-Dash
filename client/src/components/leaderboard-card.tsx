import { useState, memo } from "react";
// Card/CardContent imports removed - using plain divs
import { Badge } from "@/components/ui/badge";
import { BadgeWithTooltip } from "@/components/ui/badge-tooltip";
import { TrendingUp, TrendingDown, Clock, MapPin, Car, Smartphone, Utensils, ShoppingBag, AlertTriangle, Ban, ChevronDown, ChevronUp, Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle, Droplets, Wind, Star, GraduationCap, ThumbsUp, Receipt, MessageSquare, Send, X, StickyNote } from "lucide-react";
import type { RestaurantSales, HourlySalesData } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { DAYPARTS, getDaypart, gradeToScore as dpGradeToScore, scoreToGrade as dpScoreToGrade, getGradeColor as dpGetGradeColor } from "@/lib/dayparts";
import {
  computeExecutionScore,
  scoreToGradeLabel,
  getGradeColor as sharedGetGradeColor,
  gradeToMidpoint,
  formatCurrency,
} from "@/lib/grading";

const REVENUE_PORT_CONFIG = {
  dine_in: { label: "Dine In", icon: Utensils, color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Indoor dining available", disabledDesc: "No indoor dining" },
  drive_thru: { label: "Drive Thru", icon: Car, color: "bg-amber-500/10 text-amber-600 dark:text-amber-400", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Drive-thru window service", disabledDesc: "No drive-thru" },
  app: { label: "APP", icon: Smartphone, color: "bg-blue-500/10 text-blue-500", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Mobile app ordering", disabledDesc: "No app ordering" },
  "3pd": { label: "3PD", icon: ShoppingBag, color: "bg-purple-500/10 text-purple-500", disabledColor: "bg-gray-100 text-gray-400 dark:bg-gray-800/30 dark:text-gray-500", description: "Third-party delivery (DoorDash, UberEats, etc.)", disabledDesc: "No third-party delivery" },
} as const;

const ALL_REVENUE_PORTS = ["dine_in", "drive_thru", "app", "3pd"] as const;

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
  _isFirstWeek = false,
  hasValidStaffing = true,
  osatPercent: number | undefined = undefined
): { grade: string; color: string; hasGrade: boolean } {
  const score = computeExecutionScore(salesVariancePct, speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, osatPercent);
  if (score === 0) return { grade: '-', color: 'text-muted-foreground', hasGrade: false };
  const grade = scoreToGradeLabel(score);
  return { grade, color: sharedGetGradeColor(grade), hasGrade: true };
}

const getGradeColor = sharedGetGradeColor;
const gradeToScore = gradeToMidpoint;

function scoreToGrade(score: number): { grade: string; color: string } {
  const grade = scoreToGradeLabel(score);
  return { grade, color: getGradeColor(grade) };
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

export const LeaderboardCard = memo(function LeaderboardCard({ restaurant, hourlyData, crewSummary, hourlyCrewData, checkAverage, checkAvgTrend, consistencyScore, demandCurveHours, destinationsByHour, isToday = true, yoyData, weeklyData, notes, dateStr, onNoteAdded }: LeaderboardCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoveredHourIndex, setHoveredHourIndex] = useState<number | null>(null);
  
  // formatCurrency is imported from @/lib/grading (module-level singleton)

  const formatPercentage = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${Math.round(value)}%`;
  };

  const formatSignedCurrency = (amount: number) => {
    const sign = amount >= 0 ? "+" : "";
    return `${sign}${formatCurrency(amount)}`;
  };

  // Display variance uses actual local-timezone sales for accurate store-level comparison
  const displayLastWeek = restaurant.actualLastWeekSales ?? restaurant.lastWeekSales;
  const paceVariance = displayLastWeek > 0 
    ? ((restaurant.actualSales / displayLastWeek) - 1) * 100 
    : 0;
  
  // Check if restaurant is in first week (no historical data expected)
  const isFirstWeek = (restaurant.daysOpen !== undefined && restaurant.daysOpen < 7);

  // Pre-compute values for the sales grid
  const isDayComplete = restaurant.normalizedHour >= 23;
  const lwFullDay = restaurant.lastWeekFullDay ?? (displayLastWeek + Math.max(0, restaurant.forecastSales - restaurant.actualSales));
  const dayForecastVar = lwFullDay > 0
    ? ((restaurant.forecastSales / lwFullDay) - 1) * 100
    : 0;

  // YoY: only for SSS restaurants (>18 months open)
  const isSSS = !restaurant.openDate || (() => {
    const open = new Date(restaurant.openDate);
    const now = new Date();
    return ((now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth())) > 18;
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

  // Show all 24 hours individually (no Early Bird combining since we have full POS data)
  // Generate all 24 hours, filling in zeros for missing hours
  // Use localCurrentHour for grade display (restaurant's own timezone)
  // Fall back to normalizedHour if not available (for backward compatibility)
  const localGradeCutoff = (restaurant as any).localCurrentHour ?? restaurant.normalizedHour;
  const normalizedCutoff = restaurant.normalizedHour;
  
  // Create a map of existing hourly data
  const hourlyDataMap = new Map<number, HourlySalesData>();
  (hourlyData || []).forEach(item => {
    hourlyDataMap.set(item.hour, item);
  });
  
  // Generate all 24 hours (0-23)
  const allHours: HourlySalesData[] = [];
  for (let h = 0; h < 24; h++) {
    const existing = hourlyDataMap.get(h);
    if (existing) {
      allHours.push(existing);
    } else {
      // Create placeholder for missing hour
      allHours.push({
        hour: h,
        todaySales: 0,
        lastWeekSales: 0,
        forecastSales: 0,
        employeeCount: 0,
        projectedLabor: 0,
        actualLabor: 0,
        label: h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`,
      } as HourlySalesData);
    }
  }
  
  const activeHours = allHours;

  // Compute tooltip alignment so edge-of-chart tooltips don't overflow
  const getTooltipAlign = (hourIndex: number) => {
    const total = activeHours.length;
    if (hourIndex <= 1) return 'left-0';
    if (hourIndex >= total - 2) return 'right-0';
    return 'left-1/2 -translate-x-1/2';
  };
  const maxSales = Math.max(
    ...activeHours.map(h => Math.max(h.todaySales, h.lastWeekSales, h.forecastSales)),
    1
  );
  
  // Calculate overall execution grade from completed hourly grades only (using restaurant's local hour)
  // Only grade hours that have actual sales - no sales = no grade
  const hourlyGradeScores = activeHours
    .filter(hour => hour.hour <= localGradeCutoff) // Only completed hours for this restaurant
    .filter(hour => hour.todaySales && hour.todaySales > 0) // No sales = no grade
    .map(hour => {
      const hasComparableSales = hour.lastWeekSales > 0; // Only compare if LW had sales
      const salesVariancePct = hasComparableSales 
        ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100 
        : 0;
      const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
      // Exclude operator from labor hours (not production/non-production)
      const positions = hour.positionBreakdown || {};
      const operatorHrs = positions['_operatorScheduled'] || 0;
      const rawEmployeeCount = Number(hour.employeeCount) || 0;
      const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
      const staffingDiff = actualStaff - staffing.total;
      // Exclude staffing from grade when employee count is near-zero (indicates missing/incomplete data)
      const hasValidStaffing = rawEmployeeCount >= 1;
      const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
      return gradeInfo.hasGrade ? gradeToScore(gradeInfo.grade) : 0;
    }).filter(score => score > 0);
  
  // Overall grade is the straight average of hourly execution grades
  // (OSAT is already factored into each hourly grade when available)
  let overallScore = 0;
  if (hourlyGradeScores.length > 0) {
    overallScore = hourlyGradeScores.reduce((a, b) => a + b, 0) / hourlyGradeScores.length;
  }
  const overallGrade = hourlyGradeScores.length > 0 ? scoreToGrade(overallScore) : null;

  // Calculate daypart grades from completed hourly grades
  const daypartGrades = DAYPARTS.map(dp => {
    const dpScores = activeHours
      .filter(hour => hour.hour >= dp.startHour && hour.hour <= dp.endHour)
      .filter(hour => hour.hour <= localGradeCutoff)
      .filter(hour => hour.todaySales && hour.todaySales > 0)
      .map(hour => {
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
        const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
        return gradeInfo.hasGrade ? gradeToScore(gradeInfo.grade) : 0;
      }).filter(s => s > 0);

    if (dpScores.length === 0) return { ...dp, grade: null, score: 0 };
    const avg = dpScores.reduce((a, b) => a + b, 0) / dpScores.length;
    const gradeResult = scoreToGrade(avg);
    return { ...dp, grade: gradeResult.grade, score: avg };
  }).filter(dp => dp.grade !== null);

  // Build demand curve lookup for 15-min interval display
  const demandCurveMap = new Map<number, DemandCurveHour>();
  if (demandCurveHours) {
    demandCurveHours.forEach(h => demandCurveMap.set(h.hour, h));
  }

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
          <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-3">
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
                    NU {restaurant.daysOpen && restaurant.daysOpen >= 7 ? `${Math.floor(restaurant.daysOpen / 7)}w${restaurant.daysOpen % 7}d` : `${restaurant.daysOpen || 0}d`}
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
                      daypartGrades.length > 0 ? (
                        <div>
                          <div className="font-medium mb-1">Daypart Grades</div>
                          <div className="flex flex-col gap-0.5">
                            {daypartGrades.map(dp => {
                              // Compute daypart check average for tooltip
                              let dpCA: number | null = null;
                              if (checkAverage?.hourly) {
                                let dpOrders = 0, dpSales = 0;
                                for (let h = dp.startHour; h <= dp.endHour; h++) {
                                  const hCA = checkAverage.hourly[h];
                                  if (hCA) { dpOrders += hCA.orders; dpSales += hCA.sales; }
                                }
                                if (dpOrders > 0) dpCA = dpSales / dpOrders;
                              }
                              return (
                                <div key={dp.id} className="flex items-center justify-between gap-3">
                                  <span className="text-muted-foreground">{dp.label}</span>
                                  <div className="flex items-center gap-2">
                                    <span className={`font-bold ${dpGetGradeColor(dp.grade!)}`}>{dp.grade}</span>
                                    {dpCA !== null && (
                                      <span className="text-teal-500 text-[10px]">${dpCA.toFixed(2)}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div>Overall execution grade based on sales, speed, OSAT, and staffing</div>
                      )
                    }
                  >
                    EXC: {overallGrade.grade}
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
                {/* Drive-Thru SOS Badge */}
                {restaurant.driveThru && (() => {
                  const carCount = restaurant.driveThru.carCount || 0;
                  const carsUnder6 = (restaurant.driveThru as any).carsUnder6Min || 0;
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
                {/* Check Average Badge with 7-day trend */}
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
                    <th className="font-normal pb-0.5 text-right pl-2" colSpan={2}>Forecast</th>
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
                      className={`font-medium pl-1 pt-0.5 ${paceVariance >= 0 ? "text-green-500" : "text-red-500"}`}
                      data-testid={`badge-pace-${restaurant.restaurantId}`}
                    >
                      {formatPercentage(paceVariance)}
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
                      <td className={`font-medium pl-1 pt-0.5 ${showEow && weeklyData.priorWeekFull > 0 ? (eowVar >= 0 ? "text-green-500" : "text-red-500") : ""}`}>
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

        {isExpanded && activeHours.length > 0 && (
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
                {activeHours.some(h => (h as any).speedAttainment !== undefined) && (
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
            {/* Execution Grades Row - only show grades for completed hours (using restaurant's local hour) */}
            <div className="flex gap-0.5 mb-0.5">
              {activeHours.map((hour) => {
                const isCompleted = hour.hour <= localGradeCutoff;
                const hasComparableSales = hour.lastWeekSales > 0;
                const salesVariancePct = hasComparableSales
                  ? ((hour.todaySales - hour.lastWeekSales) / hour.lastWeekSales) * 100
                  : 0;
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                // Exclude operator from labor hours (not production/non-production)
                const positions = hour.positionBreakdown || {};
                const operatorHrs = positions['_operatorScheduled'] || 0;
                const rawEmployeeCount = Number(hour.employeeCount) || 0;
                const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
                const staffingDiff = actualStaff - staffing.total;
                // Exclude staffing from grade when employee count is near-zero (indicates missing/incomplete data)
                const hasValidStaffing = rawEmployeeCount >= 1;
                const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);

                // No sales = no grade displayed
                const hasSales = hour.todaySales && hour.todaySales > 0;

                return (
                  <div
                    key={`grade-${hour.hour}`}
                    className="flex-1 text-center"
                  >
                    {isCompleted && hasSales ? (
                      <span className={`text-[10px] font-bold ${gradeInfo.color}`}>
                        {gradeInfo.grade}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">-</span>
                    )}
                  </div>
                );
              })}
            </div>
            {/* OOT (Outside Order Taker) row — visible under grades when dt3 >= 1 for any hour */}
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
                const staffing = getStaffingBreakdown(hour.hour, hour.todaySales);
                // Exclude operator from labor hours (not production/non-production)
                const positions = hour.positionBreakdown || {};
                const operatorHrs = positions['_operatorScheduled'] || 0;
                const rawEmployeeCount = Number(hour.employeeCount) || 0;
                const actualStaff = Math.max(0, rawEmployeeCount - operatorHrs);
                const staffingDiff = actualStaff - staffing.total;
                // Exclude staffing from grade when employee count is near-zero (indicates missing/incomplete data)
                const hasValidStaffing = rawEmployeeCount >= 1;
                const gradeInfo = getExecutionGrade(salesVariancePct, (hour as any).speedAttainment, staffingDiff, hasComparableSales, isFirstWeek, hasValidStaffing, hour.osatPercent);
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
                        {isCompleted && (hour as any).speedAttainment !== undefined && (
                          <span className={
                            (hour as any).speedAttainment < 50 ? "text-red-500" :
                            (hour as any).speedAttainment < 70 ? "text-yellow-500" :
                            "text-green-500"
                          }>
                            {(hour as any).speedAttainment}%
                          </span>
                        )}
                        {/* OOT (Outside Order Taker) indicator — dt3 order count */}
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
                      {/* 15-minute interval breakdown */}
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
              {/* SOS Line Overlay - speed attainment */}
              {activeHours.some(h => (h as any).speedAttainment !== undefined) && (
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
                        const att = (hour as any).speedAttainment;
                        if (att === undefined) return null;
                        const x = ((idx + 0.5) / activeHours.length) * 100;
                        // Scale: 0-100% attainment maps to chart height (higher = better = higher on chart)
                        const y = (1 - att / 100) * 100;
                        return `${x},${y}`;
                      })
                      .filter(Boolean)
                      .join(' ')}
                  />
                </svg>
              )}
              {/* OSAT Dots Overlay - colored dots on hours with survey responses */}
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
            {/* Daypart brackets with grades + check average */}
            <div className="flex mt-0.5">
              {DAYPARTS.map(dp => {
                const spanHours = dp.endHour - dp.startHour + 1;
                const widthPercent = (spanHours / 24) * 100;
                const dpGrade = daypartGrades.find(dg => dg.id === dp.id);
                // Calculate daypart check average from hourly data
                let dpCheckAvg: number | null = null;
                if (checkAverage?.hourly) {
                  let dpOrders = 0;
                  let dpSales = 0;
                  for (let h = dp.startHour; h <= dp.endHour; h++) {
                    const hourCA = checkAverage.hourly[h];
                    if (hourCA) {
                      dpOrders += hourCA.orders;
                      dpSales += hourCA.sales;
                    }
                  }
                  if (dpOrders > 0) dpCheckAvg = dpSales / dpOrders;
                }
                return (
                  <div key={dp.id} style={{ width: `${widthPercent}%` }} className="text-center px-px">
                    <div className={`h-1 rounded-sm ${dp.bgColor}`} style={{ opacity: dpGrade?.grade ? 1 : 0.3 }} />
                    <div className="text-[8px] leading-tight mt-px flex items-center justify-center gap-0.5">
                      <span className={`font-medium ${dp.color}`}>{dp.shortLabel}</span>
                      {dpGrade?.grade && (
                        <span className={`font-bold ${dpGetGradeColor(dpGrade.grade)}`}>{dpGrade.grade}</span>
                      )}
                    </div>
                    {dpCheckAvg !== null && (
                      <div className="text-[7px] leading-none text-teal-600 dark:text-teal-400 font-medium">
                        ${dpCheckAvg.toFixed(0)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Staffing Chart - Labor Hours Deployed vs Recommended */}
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
                  // Exclude _operatorScheduled from labor hours (they are neither production nor non-production)
                  const positions = hour.positionBreakdown || {};
                  const operatorHours = positions['_operatorScheduled'] || 0;
                  const laborHours = Math.max(0, (Number(hour.employeeCount) || 0) - operatorHours);
                  const sales = hour.todaySales || 0;
                  
                  // Labor deployment model: Non-production + Production staff
                  // Uses different ramp-up charts for breakfast (6am-11am) vs non-breakfast
                  const staffingDetails = getStaffingBreakdown(hour.hour, sales);
                  const recommendedHours = staffingDetails.total;
                  
                  // Staffing status: Green ±1 hr, Red >1 over, Yellow >1 under
                  const staffingDiff = laborHours - recommendedHours;
                  const isRightSized = Math.abs(staffingDiff) <= 1;
                  const isOverstaffed = staffingDiff > 1;
                  const isUnderstaffed = staffingDiff < -1;
                  
                  const hasNoData = laborHours === 0 && sales === 0 && operatorHours === 0;
                  
                  // Bar height based on labor hours (cap at 15 for display)
                  const maxDisplayHours = 15;
                  const displayHours = Math.min(laborHours, maxDisplayHours);
                  const barHeightPx = hasNoData ? 0 : Math.max(3, (displayHours / maxDisplayHours) * 40);
                  
                  // Target line position (cap at same max for consistency)
                  const targetDisplayHours = Math.min(recommendedHours, maxDisplayHours);
                  const targetLineHeightPx = (targetDisplayHours / maxDisplayHours) * 40;
                  
                  // Bar color: green (right-sized), red (>2 over), yellow (>2 under)
                  const barColor = isRightSized 
                    ? "bg-green-500 dark:bg-green-400" 
                    : isOverstaffed 
                      ? "bg-red-500 dark:bg-red-400" 
                      : "bg-yellow-500 dark:bg-yellow-400";
                  
                  // Check for missing manager/shift supervisor
                  // Operators don't punch in but are considered leaders if scheduled
                  const positionKeys = Object.keys(positions).map(k => k.toLowerCase());
                  const hasManager = positionKeys.some(p => p.includes("manager"));
                  const hasShiftSupervisor = positionKeys.some(p => p.includes("shift supervisor") || p.includes("supervisor"));
                  const hasOperatorScheduled = positions['_operatorScheduled'] === 1;
                  // Also check leaders array from crew data — it reliably identifies managers/supervisors
                  const hasLeadersFromCrewData = (hour.leaders || []).length > 0;
                  const missingLeadership = !hasManager && !hasShiftSupervisor && !hasOperatorScheduled && !hasLeadersFromCrewData && laborHours > 0;
                  
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
                          {/* Staffing bar — split into 15-min sub-bars when quarter data is available */}
                          {(() => {
                            const qb = hour.quarterBreakdown;
                            if (qb && (qb.q0 > 0 || qb.q1 > 0 || qb.q2 > 0 || qb.q3 > 0)) {
                              const maxQ = Math.max(qb.q0, qb.q1, qb.q2, qb.q3, 0.01);
                              // Each quarter's max possible is 0.25h per person; scale relative to total bar height
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
                          {/* Target line showing recommended staffing level */}
                          <div
                            className="absolute w-full border-t-2 border-slate-800 dark:border-slate-200 pointer-events-none"
                            style={{ bottom: `${targetLineHeightPx}px` }}
                          />
                          {/* Hazard indicator for missing manager/supervisor */}
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
                            {/* Crew experience score + tenure mix breakdown */}
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
                          {/* Leaders list - show managers, shift supervisors, operators by name */}
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
                            // Fallback to position breakdown if no leaders data
                            const posKeys = Object.keys(positions)
                              .filter(k => !k.startsWith('_') && positions[k] > 0);
                            if (posKeys.length === 0) return null;
                            return (
                              <div className="text-muted-foreground text-[10px]">
                                {posKeys.slice(0, 5).join(', ')}{posKeys.length > 5 ? '...' : ''}
                              </div>
                            );
                          })()}
                          {/* 15-min quarter labor breakdown */}
                          {(() => {
                            const qb = hour.quarterBreakdown;
                            if (!qb || (qb.q0 === 0 && qb.q1 === 0 && qb.q2 === 0 && qb.q3 === 0)) return null;
                            const h12 = hour.hour === 0 ? 12 : hour.hour > 12 ? hour.hour - 12 : hour.hour;
                            const ampm = hour.hour < 12 ? 'am' : 'pm';
                            return (
                              <div className="flex gap-2 text-[10px] text-muted-foreground border-t border-border/50 pt-0.5">
                                {[qb.q0, qb.q1, qb.q2, qb.q3].map((qVal, qi) => {
                                  const min = qi * 15;
                                  return (
                                    <span key={qi} className={qVal > 0 ? "text-foreground" : ""}>
                                      {h12}:{min.toString().padStart(2, '0')}{ampm} <span className="font-medium">{qVal.toFixed(1)}h</span>
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Total Staffing Summary for the Day */}
              {(() => {
                const totals = activeHours.reduce((acc, hour) => {
                  // Exclude operator from labor hours calculation
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
                  return acc;
                }, { totalDeployed: 0, totalTarget: 0, hoursWithData: 0 });
                
                const staffingDiff = totals.totalDeployed - totals.totalTarget;
                const isOverstaffed = staffingDiff > 0;
                const isUnderstaffed = staffingDiff < 0;
                
                if (totals.hoursWithData === 0) return null;
                
                return (
                  <div className="mt-2 flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">
                      Day Total: {totals.totalDeployed.toFixed(1)} labor hrs / {totals.totalTarget} target
                    </span>
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
                );
              })()}
            </div>
          </div>
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
                  paceVariance >= 0 ? "bg-green-500" : "bg-red-500"
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
