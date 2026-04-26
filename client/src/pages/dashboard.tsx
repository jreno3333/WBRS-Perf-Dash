import { APP_VERSION } from "@/lib/version";
import { useState, useMemo, useCallback, useRef } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { AlertCircle, ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { NavBar } from "@/components/nav-bar";
import { LeaderboardCard } from "@/components/leaderboard-card";
import { SummaryCards } from "@/components/summary-cards";
import { LeaderboardSkeleton } from "@/components/leaderboard-skeleton";
import { StateBreakdown } from "@/components/state-breakdown";
import { MarketBreakdown } from "@/components/market-breakdown";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { BannerTicker } from "@/components/banner-ticker";
import { PollCard } from "@/components/poll-card";
import { format } from "date-fns";
import type { LeaderboardData, HourlySalesData, MarketWithRestaurants } from "@shared/schema";
import { getStaffingBreakdown } from "@/lib/labor-model";
import { computeExecutionScore, formatCurrency } from "@/lib/grading";
import { useGradingConfig } from "@/hooks/use-grading-config";

// Get current date in Central timezone (business day)
function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [year, month, day] = centralStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function calculateXScore(hourlyData: HourlySalesData[] | undefined, localCutoff?: number, restaurant?: { daysOpen?: number; feedbackSpeed?: { topBoxPercent: number; responses: number } | null }, cfg?: import("@shared/schema").GradingConfigData): number {
  if (!hourlyData || hourlyData.length === 0) return -1;

  const cutoff = localCutoff ?? 23;
  const completedHours = hourlyData.filter(hour => hour.hour <= cutoff);

  const scores = completedHours
    .filter(hour => hour.todaySales > 0)
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
      const hasComparableTransactions = (hour.lastWeekTransactionCount ?? 0) > 0 && (hour.transactionCount ?? 0) > 0;
      const transactionVariancePct = hasComparableTransactions
        ? ((hour.transactionCount! - hour.lastWeekTransactionCount!) / hour.lastWeekTransactionCount!) * 100
        : undefined;
      const fs = restaurant?.feedbackSpeed;
      const rawScore = computeExecutionScore(salesVariancePct, hour.ootActive ? undefined : hour.speedAttainment, staffingDiff, hasComparableSales, hasValidStaffing, hour.osatPercent, transactionVariancePct, hasComparableTransactions, cfg, fs?.responses ? fs.topBoxPercent : undefined, fs?.responses);
      return rawScore > 0 ? rawScore : 0;
    }).filter(s => s > 0);
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : -1;
}

export default function Dashboard() {
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [selectedMarket, setSelectedMarket] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"sales" | "variance" | "wtd_variance" | "yoy" | "banana_pudding" | "missing_manager" | "dt_time" | "xscore" | "google_reviews" | "osat" | "osat_time" | "check_avg">("sales");
  const gradingCfg = useGradingConfig();

  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const centralToday = getCentralDate();
  const isToday = format(centralToday, "yyyy-MM-dd") === dateStr;

  // Auto-refresh every 5 minutes for live sales data when viewing today
  const refetchInterval = isToday ? 5 * 60 * 1000 : false;
  // Slower refresh (15 min) for data that changes less frequently (crew, trends, check avg)
  const slowRefetchInterval = isToday ? 15 * 60 * 1000 : false;

  const secondaryStaleTime = isToday ? 4 * 60 * 1000 : Infinity;
  const slowStaleTime = isToday ? 14 * 60 * 1000 : Infinity;

  const { data: leaderboardData, isLoading, error } = useQuery<LeaderboardData>({
    queryKey: ["/api/leaderboard", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return await res.json();
    },
    refetchInterval,
  });

  const { data: hourlyByRestaurant } = useQuery<Record<string, HourlySalesData[]>>({
    queryKey: ["/api/hourly-by-restaurant", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-by-restaurant?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval,
    staleTime: secondaryStaleTime,
  });

  const { data: crewSummaryResponse } = useQuery<{ date: string; summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> }>({
    queryKey: ["/api/crew/summary", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/summary?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval: slowRefetchInterval,
    staleTime: slowStaleTime,
  });
  const crewSummary = crewSummaryResponse?.summary;

  // Fetch hourly crew experience data for all restaurants
  interface HourlyCrewData {
    hour: number;
    crewCount: number;
    experienceScore: number;
    tenureMix: { trainee: number; developing: number; experienced: number; veteran: number };
  }
  const { data: hourlyCrewResponse } = useQuery<{ date: string; data: Record<string, HourlyCrewData[]> }>({
    queryKey: ["/api/crew/experience", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/experience?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval: slowRefetchInterval,
    staleTime: slowStaleTime,
  });
  const hourlyCrewByRestaurant = hourlyCrewResponse?.data;

  // Fetch check average data from POS
  interface CheckAverageData {
    totalOrders: number;
    totalSales: number;
    checkAverage: number;
    hourly: Record<number, { orders: number; sales: number; avg: number }>;
  }
  const { data: checkAverageResponse } = useQuery<{ date: string; restaurants: Record<string, CheckAverageData> }>({
    queryKey: ["/api/pos/check-average", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pos/check-average?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval,
    staleTime: secondaryStaleTime,
  });
  const checkAverageByRestaurant = checkAverageResponse?.restaurants;

  // Fetch 7-day rolling check average trend
  interface CheckAverageTrendData {
    daily: { date: string; orders: number; sales: number; avg: number }[];
    avg7d: number;
    trend: 'up' | 'down' | 'flat';
  }
  const { data: checkAvgTrendResponse } = useQuery<{ date: string; days: number; restaurants: Record<string, CheckAverageTrendData> }>({
    queryKey: ["/api/pos/check-average-trend", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pos/check-average-trend?date=${dateStr}&days=7`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval: slowRefetchInterval,
    staleTime: slowStaleTime,
  });
  const checkAvgTrendByRestaurant = checkAvgTrendResponse?.restaurants;

  // Fetch notes for the selected date
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
  const { data: notesResponse, refetch: refetchNotes } = useQuery<{ date: string; notes: RestaurantNote[] }>({
    queryKey: ["/api/notes", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/notes?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    staleTime: secondaryStaleTime,
  });
  const notesByRestaurant = useMemo(() => {
    const map: Record<string, RestaurantNote[]> = {};
    if (notesResponse?.notes) {
      for (const note of notesResponse.notes) {
        if (!map[note.restaurantId]) map[note.restaurantId] = [];
        map[note.restaurantId].push(note);
      }
    }
    return map;
  }, [notesResponse?.notes]);

  // Fetch destination breakdown (dt1/dt2/dt3/in/app) by restaurant/hour
  const { data: destinationResponse } = useQuery<{
    date: string;
    restaurants: Record<string, Record<number, Record<string, number>>>;
  }>({
    queryKey: ["/api/pos/destinations", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pos/destinations?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval,
    staleTime: secondaryStaleTime,
  });
  const destinationsByRestaurant = destinationResponse?.restaurants;

  // Fetch attachment rates for The Closer bonus
  const { data: attachmentRatesResponse } = useQuery<{
    restaurants: Record<string, { categories: Record<string, { attachRate: number; vsTarget: number }>; overallAttachScore?: number }>;
  }>({
    queryKey: ["/api/pos/attachment-rates", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/pos/attachment-rates?date=${dateStr}`);
      if (!res.ok) return { restaurants: {} };
      return res.json();
    },

    refetchInterval,
    staleTime: secondaryStaleTime,
  });

  // Fetch helper rewards for the selected date
  const { data: helperRewardsData } = useQuery<{ restaurantId: string; points: number }[]>({
    queryKey: ["/api/helper-rewards", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/helper-rewards?date=${dateStr}`);
      if (!res.ok) return [];
      return res.json();
    },

    staleTime: secondaryStaleTime,
  });

  const helperRewardsByRestaurant = useMemo(() => {
    if (!helperRewardsData) return undefined;
    const map: Record<string, number> = {};
    for (const hr of helperRewardsData) {
      map[hr.restaurantId] = hr.points;
    }
    return map;
  }, [helperRewardsData]);

  const { data: markets } = useQuery<MarketWithRestaurants[]>({
    queryKey: ["/api/markets"],
    staleTime: Infinity,
  });

  const { data: holidayData } = useQuery<{
    todayHoliday: { name: string; date: string; dayOfWeek: string } | null;
    lastWeekHoliday: { name: string; date: string; dayOfWeek: string; isLastWeekComparisonDay?: boolean } | null;
    upcomingHolidays: { name: string; date: string; dayOfWeek: string }[];
    comparison: {
      thisYear: { name: string; date: string; dayOfWeek: string } | null;
      lastYear: { name: string; date: string; dayOfWeek: string } | null;
    };
  }>({
    queryKey: ["/api/holidays", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/holidays?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: Infinity,
  });

  // Fetch holiday sales comparison (3-way: today vs holiday vs normal baseline)
  interface HolidaySalesComparison {
    applicable: boolean;
    scenario?: 'today_is_holiday' | 'comparing_to_holiday';
    holidayName?: string;
    dates?: { today: string; lastWeek: string; normalBaseline: string | null };
    sales?: {
      today: number;
      lastWeek: number;
      lastWeekFullDay: number;
      normalBaseline: number | null;
      normalBaselineProgress: number | null;
      forecast: number;
    };
    variance?: { vsLastWeek: number | null; vsNormal: number | null; holidayVsNormal: number | null; forecastVsNormal: number | null };
    isToday?: boolean;
  }
  const { data: holidaySalesComparison } = useQuery<HolidaySalesComparison>({
    queryKey: ["/api/holiday-sales-comparison", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/holiday-sales-comparison?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval,
    staleTime: secondaryStaleTime,
  });

  // Fetch weekly sales data (Sat-Fri business week)
  interface WeeklySalesData {
    currentWeekStart: string;
    currentWeekEnd: string;
    priorWeekStart: string;
    priorWeekEnd: string;
    daysInCurrentWeek: number;
    daysInPriorWeek: number;
    restaurants: Record<string, { currentWeek: number; priorWeek: number; eowForecast: number; priorWeekFull: number; daysInCurrentWeek: number; wtdLaborCost?: number }>;
  }
  const { data: weeklySalesData } = useQuery<WeeklySalesData>({
    queryKey: ["/api/weekly-sales", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/weekly-sales?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval: slowRefetchInterval,
    staleTime: slowStaleTime,
  });

  interface TwoWeekTrendData {
    trailingStart: string;
    trailingEnd: string;
    priorStart: string;
    priorEnd: string;
    restaurants: Record<string, { trailing: number; prior: number }>;
  }
  const { data: twoWeekTrendData } = useQuery<TwoWeekTrendData>({
    queryKey: ["/api/two-week-trend", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/two-week-trend?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    refetchInterval: slowRefetchInterval,
    staleTime: slowStaleTime,
  });

  const { data: consistencyData } = useQuery<{
    companyAvgConsistency: number;
    restaurants: { restaurantId: string; consistencyScore: number }[];
  }>({
    queryKey: ["/api/analytics/consistency"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/consistency?days=14");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    staleTime: secondaryStaleTime,
  });
  const consistencyByRestaurant = useMemo(
    () => consistencyData?.restaurants?.reduce((acc, r) => {
      acc[r.restaurantId] = r.consistencyScore;
      return acc;
    }, {} as Record<string, number>),
    [consistencyData?.restaurants]
  );

  // Fetch demand curves (15-min intervals) for all restaurants
  interface DemandCurveHour {
    hour: number;
    quarters: { label: string; orders: number; sales: number }[];
    totalOrders: number;
    totalSales: number;
    loadProfile: string;
  }
  const { data: demandCurvesData } = useQuery<{
    restaurants: { restaurantId: string; hours: DemandCurveHour[] }[];
  }>({
    queryKey: ["/api/analytics/demand-curves", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/demand-curves?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },

    staleTime: secondaryStaleTime,
  });
  const demandCurvesByRestaurant = useMemo(
    () => demandCurvesData?.restaurants?.reduce((acc, r) => {
      acc[r.restaurantId] = r.hours;
      return acc;
    }, {} as Record<string, DemandCurveHour[]>),
    [demandCurvesData?.restaurants]
  );

  const { data: yoyBulkData } = useQuery<{
    priorDate: string;
    data: Record<string, { priorNetSales: number; priorGuestCount: number; priorDate: string }>;
  }>({
    queryKey: ["/api/historical-sales/yoy-bulk", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/historical-sales/yoy-bulk?date=${dateStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch YoY data");
      return res.json();
    },

    staleTime: secondaryStaleTime,
  });

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const goToPreviousDay = () => {
    const prev = new Date(selectedDate);
    prev.setDate(prev.getDate() - 1);
    setSelectedDate(prev);
  };

  const goToNextDay = () => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 1);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (next <= today) {
      setSelectedDate(next);
    }
  };

  const goToToday = () => {
    setSelectedDate(getCentralDate());
  };

  // Pre-compute missing manager status for all restaurants once when hourly data changes,
  // rather than re-computing per restaurant during every sort/filter pass.
  const missingManagerSet = useMemo(() => {
    const set = new Set<string>();
    if (!hourlyByRestaurant) return set;
    for (const [restaurantId, hours] of Object.entries(hourlyByRestaurant)) {
      const isMissing = hours.some((hour: HourlySalesData) => {
        const laborHours = Number(hour.employeeCount) || 0;
        if (laborHours === 0) return false;
        const positions = hour.positionBreakdown || {};
        const positionKeys = Object.keys(positions).map(k => k.toLowerCase());
        const hasManager = positionKeys.some(p => p.includes("manager"));
        const hasShiftSupervisor = positionKeys.some(p => p.includes("shift supervisor") || p.includes("supervisor"));
        const hasOperatorScheduled = positions['_operatorScheduled'] === 1;
        return !hasManager && !hasShiftSupervisor && !hasOperatorScheduled;
      });
      if (isMissing) set.add(restaurantId);
    }
    return set;
  }, [hourlyByRestaurant]);

  const hasMissingManager = useCallback(
    (restaurantId: string) => missingManagerSet.has(restaurantId),
    [missingManagerSet]
  );

  // Get selected market restaurant IDs for filtering
  const selectedMarketRestaurantIds = selectedMarket !== "all" && markets
    ? markets.find(m => m.id === selectedMarket)?.restaurantIds || []
    : null;

  // Pre-compute X-Scores once (instead of O(n log n) times in the sort comparator)
  const xScoreMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!leaderboardData?.restaurants || !hourlyByRestaurant) return map;
    for (const r of leaderboardData.restaurants) {
      const localCutoff = r.localCurrentHour ?? r.normalizedHour;
      map.set(r.restaurantId, calculateXScore(hourlyByRestaurant[r.restaurantId], localCutoff, r, gradingCfg));
    }
    return map;
  }, [leaderboardData?.restaurants, hourlyByRestaurant, gradingCfg]);

  // Memoize filtered + sorted restaurants to avoid re-computing the full
  // filter/sort pipeline on every render (e.g. when unrelated state changes).
  const sortedRestaurants = useMemo(() => {
    if (!leaderboardData?.restaurants) return [];

    // Pre-compute sort keys once (O(n)) so the comparator does O(1) Map lookups
    // instead of repeated nested property chains on every comparison.
    const wtdVarMap = new Map<string, number>();
    if (weeklySalesData?.restaurants) {
      for (const [id, wk] of Object.entries(weeklySalesData.restaurants)) {
        wtdVarMap.set(id, wk.priorWeek > 0 ? ((wk.currentWeek / wk.priorWeek) - 1) * 100 : -999);
      }
    }
    const bpMap = new Map<string, number>();
    if (attachmentRatesResponse?.restaurants) {
      for (const [id, r] of Object.entries(attachmentRatesResponse.restaurants)) {
        bpMap.set(id, r.categories?.banana_pudding?.attachRate ?? -1);
      }
    }
    const checkAvgMap = new Map<string, number>();
    if (checkAverageByRestaurant) {
      for (const [id, ca] of Object.entries(checkAverageByRestaurant)) {
        checkAvgMap.set(id, ca.checkAverage ?? 0);
      }
    }

    return [...leaderboardData.restaurants]
      // First, apply market filter
      .filter((r) => {
        if (selectedMarketRestaurantIds) {
          return selectedMarketRestaurantIds.includes(r.restaurantId);
        }
        return true;
      })
      // Then, apply sort-based filters
      .filter((r) => {
        switch (sortBy) {
          case "missing_manager":
            return hasMissingManager(r.restaurantId);
          case "dt_time":
            return r.driveThru != null;
          case "google_reviews":
            return r.googleReviews != null;
          case "osat":
            return r.osat != null && r.osat.totalResponses > 0;
          case "osat_time":
            return r.feedbackSpeed != null && r.feedbackSpeed.responses > 0;
          case "yoy":
            return yoyBulkData?.data?.[r.restaurantId] != null;
          default:
            return true;
        }
      })
      // Then sort — all per-restaurant lookups are O(1) Map.get()
      .sort((a, b) => {
        if (a.status === "training" && b.status !== "training") return 1;
        if (a.status !== "training" && b.status === "training") return -1;

        switch (sortBy) {
          case "sales":
            return b.actualSales - a.actualSales;
          case "variance": {
            const aLastWeek = a.actualLastWeekSales ?? a.lastWeekSales;
            const bLastWeek = b.actualLastWeekSales ?? b.lastWeekSales;
            const aCompleted = a.completedSales ?? a.actualSales;
            const bCompleted = b.completedSales ?? b.actualSales;
            const aVariance = aLastWeek > 0 ? ((aCompleted / aLastWeek) - 1) * 100 : 0;
            const bVariance = bLastWeek > 0 ? ((bCompleted / bLastWeek) - 1) * 100 : 0;
            return bVariance - aVariance;
          }
          case "wtd_variance":
            return (wtdVarMap.get(b.restaurantId) ?? -999) - (wtdVarMap.get(a.restaurantId) ?? -999);
          case "dt_time": {
            const aAtt = a.driveThru ? ((a.driveThru.carsUnder6Min ?? 0) / (a.driveThru.carCount || 1)) * 100 : -1;
            const bAtt = b.driveThru ? ((b.driveThru.carsUnder6Min ?? 0) / (b.driveThru.carCount || 1)) * 100 : -1;
            return bAtt - aAtt;
          }
          case "xscore":
            return (xScoreMap.get(b.restaurantId) ?? -1) - (xScoreMap.get(a.restaurantId) ?? -1);
          case "google_reviews":
            return (b.googleReviews?.rating ?? 0) - (a.googleReviews?.rating ?? 0);
          case "osat":
            return (b.osat?.osatPercent ?? 0) - (a.osat?.osatPercent ?? 0);
          case "osat_time": {
            const aFS = a.feedbackSpeed && a.feedbackSpeed.responses > 0 ? a.feedbackSpeed.topBoxPercent : -1;
            const bFS = b.feedbackSpeed && b.feedbackSpeed.responses > 0 ? b.feedbackSpeed.topBoxPercent : -1;
            return bFS - aFS;
          }
          case "check_avg":
            return (checkAvgMap.get(b.restaurantId) ?? 0) - (checkAvgMap.get(a.restaurantId) ?? 0);
          case "banana_pudding":
            return (bpMap.get(b.restaurantId) ?? -1) - (bpMap.get(a.restaurantId) ?? -1);
          case "yoy": {
            const aYoy = yoyBulkData?.data?.[a.restaurantId];
            const bYoy = yoyBulkData?.data?.[b.restaurantId];
            const aProjected = a.normalizedHour < 23 ? a.forecastSales : a.actualSales;
            const bProjected = b.normalizedHour < 23 ? b.forecastSales : b.actualSales;
            const aYoyVar = aYoy ? ((aProjected / aYoy.priorNetSales) - 1) * 100 : -999;
            const bYoyVar = bYoy ? ((bProjected / bYoy.priorNetSales) - 1) * 100 : -999;
            return bYoyVar - aYoyVar;
          }
          default:
            return b.actualSales - a.actualSales;
        }
      })
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }, [leaderboardData?.restaurants, selectedMarketRestaurantIds, sortBy, hasMissingManager, yoyBulkData?.data, weeklySalesData?.restaurants, hourlyByRestaurant, xScoreMap, checkAverageByRestaurant, attachmentRatesResponse]);

  // Virtual scrolling: only mount cards that are near the viewport.
  // With 100+ units this cuts initial mount cost from O(n) to O(viewport/cardHeight).
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useWindowVirtualizer({
    count: sortedRestaurants.length,
    estimateSize: () => 108, // ~100px card + 8px gap (pb-2)
    overscan: 5,             // render 5 extra items above/below for smooth scroll
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="container mx-auto px-3 sm:px-6">
          <div className="flex items-center justify-between h-12 sm:h-14 gap-2">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 shrink">
              <h1 className="text-sm sm:text-base font-semibold tracking-tight whitespace-nowrap shrink-0">
                MWB Performance
                <span className="hidden sm:inline text-[10px] font-normal text-muted-foreground ml-1.5 align-top">beta v{APP_VERSION}</span>
                {isToday && (
                  <span className="inline-flex items-center gap-1 ml-1.5 sm:ml-2 text-[10px] sm:text-xs font-medium text-green-500 align-middle">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  </span>
                )}
              </h1>
              <div className="hidden sm:flex items-center gap-0.5 text-sm">
                <button
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                  onClick={goToPreviousDay}
                  data-testid="button-prev-day"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                      data-testid="button-date-picker"
                    >
                      {formatDate(selectedDate)}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={selectedDate}
                      onSelect={(date) => date && setSelectedDate(date)}
                      disabled={(date) => date > new Date()}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                <button
                  className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
                  onClick={goToNextDay}
                  disabled={isToday}
                  data-testid="button-next-day"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                {!isToday && (
                  <button
                    className="ml-1 px-2 py-0.5 rounded-md text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                    onClick={goToToday}
                    data-testid="button-go-today"
                  >
                    Today
                  </button>
                )}
              </div>
            </div>

            <NavBar />
          </div>
          {/* Mobile date nav */}
          <div className="sm:hidden flex items-center justify-center gap-1 pb-2 -mt-1">
            <button
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
              onClick={goToPreviousDay}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button className="px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground">
                  {formatDate(selectedDate)}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="center">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  disabled={(date) => date > new Date()}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <button
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
              onClick={goToNextDay}
              disabled={isToday}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            {!isToday && (
              <button
                className="ml-1 px-2 py-0.5 rounded-md text-xs font-medium text-primary"
                onClick={goToToday}
              >
                Today
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-3 sm:px-6 py-4 sm:py-5 space-y-4 sm:space-y-5">
        {/* Banner Ticker */}
        <BannerTicker />

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-3 text-destructive">
              <AlertCircle className="w-4 h-4" />
              <div>
                <p className="text-sm font-medium">Unable to load sales data</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Please check your database connection and try again.
                </p>
              </div>
            </div>
          </div>
        ) : isLoading ? (
          <LeaderboardSkeleton />
        ) : leaderboardData ? (
          <>
            {/* Holiday Context Banner */}
            {(holidayData?.todayHoliday || holidayData?.lastWeekHoliday || (holidayData?.comparison?.thisYear && holidayData?.comparison?.lastYear)) && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <CalendarDays className="w-4 h-4 text-amber-500 shrink-0" />
                  <div className="flex items-center gap-2 flex-wrap">
                    {holidayData?.todayHoliday && (
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        Today: {holidayData.todayHoliday.name}
                      </span>
                    )}
                    {holidayData?.lastWeekHoliday && (
                      <span className="text-muted-foreground text-xs">
                        {holidayData.lastWeekHoliday.isLastWeekComparisonDay
                          ? `Comparing to: ${holidayData.lastWeekHoliday.name}`
                          : `${holidayData.lastWeekHoliday.name} was ${holidayData.lastWeekHoliday.dayOfWeek}`}
                      </span>
                    )}
                    {holidayData?.comparison?.thisYear && holidayData?.comparison?.lastYear && (
                      <span className="text-xs text-muted-foreground">
                        {holidayData.comparison.thisYear.name}: {holidayData.comparison.thisYear.dayOfWeek} this year vs {holidayData.comparison.lastYear.dayOfWeek} last year
                      </span>
                    )}
                  </div>
                </div>

                {/* Holiday Sales Comparison — 3-way breakdown */}
                {holidaySalesComparison?.applicable && holidaySalesComparison.sales && (() => {
                  const fmt = formatCurrency;
                  const s = holidaySalesComparison.sales;
                  const v = holidaySalesComparison.variance!;
                  const d = holidaySalesComparison.dates!;
                  const hasForecast = holidaySalesComparison.isToday && s.forecast > s.today;
                  return (
                    <div className="border-t border-amber-500/15 px-3 py-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
                        {holidaySalesComparison.scenario === 'today_is_holiday'
                          ? 'Holiday Impact — Today vs Prior Normal Day'
                          : 'Holiday Impact — Comparing to Holiday-Inflated Week'}
                      </p>
                      <div className="grid grid-cols-3 gap-3 text-xs">
                        {/* Normal baseline column — full-day total */}
                        {s.normalBaseline != null && d.normalBaseline && (
                          <div>
                            <p className="text-muted-foreground mb-0.5">
                              Normal {new Date(d.normalBaseline + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                            </p>
                            <p className="font-semibold tabular-nums">
                              {fmt(s.normalBaseline)}
                            </p>
                          </div>
                        )}

                        {/* Holiday (last week) column — full-day total */}
                        <div>
                          <p className="text-muted-foreground mb-0.5">
                            <span className="text-amber-500 font-medium">{holidaySalesComparison.holidayName}</span>{' '}
                            {new Date(d.lastWeek + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </p>
                          <p className="font-semibold tabular-nums">
                            {fmt(s.lastWeekFullDay)}
                          </p>
                          {v.holidayVsNormal != null && (
                            <p className={`text-[10px] mt-0.5 ${v.holidayVsNormal >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                              {v.holidayVsNormal >= 0 ? '+' : ''}{v.holidayVsNormal.toFixed(1)}% vs normal
                            </p>
                          )}
                        </div>

                        {/* Today / Projected column */}
                        <div>
                          <p className="text-muted-foreground mb-0.5">
                            Today {hasForecast ? '(Proj)' : ''}
                          </p>
                          <p className="font-semibold tabular-nums">
                            {fmt(hasForecast ? s.forecast : s.today)}
                          </p>
                          <div className="flex flex-col gap-0.5 mt-0.5">
                            {v.vsLastWeek != null && (
                              <p className={`text-[10px] ${v.vsLastWeek >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                vs Holiday: {v.vsLastWeek >= 0 ? '+' : ''}{v.vsLastWeek.toFixed(1)}%
                              </p>
                            )}
                            {v.vsNormal != null && (
                              <p className={`text-[10px] font-medium ${v.vsNormal >= 0 ? 'text-blue-500' : 'text-orange-500'}`}>
                                vs Normal: {v.vsNormal >= 0 ? '+' : ''}{v.vsNormal.toFixed(1)}%
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Insight message — shown when today looks down vs holiday but is on track vs normal */}
                      {holidaySalesComparison.scenario === 'comparing_to_holiday' && v.vsLastWeek != null && v.vsLastWeek < 0 && v.vsNormal != null && v.vsNormal >= -5 && d.normalBaseline && (
                        <p className="text-[11px] text-blue-500 mt-2 pt-1.5 border-t border-amber-500/10">
                          Today appears down vs LW because {holidaySalesComparison.holidayName} inflated last week's sales. Compared to a normal {new Date(d.normalBaseline + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })}, performance is {v.vsNormal >= 0 ? 'on track' : 'within range'}.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Summary Cards */}
            <SummaryCards
              restaurants={leaderboardData.restaurants}
              lastUpdated={leaderboardData.lastUpdated}
              hourlyByRestaurant={hourlyByRestaurant}
              yoyData={yoyBulkData?.data}
              weeklySalesData={weeklySalesData}
              checkAverageByRestaurant={checkAverageByRestaurant}
              checkAvgTrendByRestaurant={checkAvgTrendByRestaurant}
              attachmentRatesByRestaurant={attachmentRatesResponse?.restaurants}
              helperRewardsByRestaurant={helperRewardsByRestaurant}
            />

            {/* Quick Poll */}
            <PollCard />

            {/* State Breakdown */}
            <StateBreakdown restaurants={leaderboardData.restaurants} hourlyByRestaurant={hourlyByRestaurant} crewSummary={crewSummary} weeklySalesData={weeklySalesData} checkAverageByRestaurant={checkAverageByRestaurant} checkAvgTrendByRestaurant={checkAvgTrendByRestaurant} />

            {/* Market Breakdown - Only shown if markets exist */}
            {markets && markets.length > 0 && (
              <MarketBreakdown
                restaurants={leaderboardData.restaurants}
                markets={markets}
                hourlyByRestaurant={hourlyByRestaurant}
                crewSummary={crewSummary}
                weeklySalesData={weeklySalesData}
                checkAverageByRestaurant={checkAverageByRestaurant}
                checkAvgTrendByRestaurant={checkAvgTrendByRestaurant}
              />
            )}

            {/* Analytics Panel */}
            <AnalyticsPanel dateStr={dateStr} isToday={isToday} checkAverageByRestaurant={checkAverageByRestaurant} />

            {/* Restaurant Rankings */}
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-xs sm:text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                    Rankings
                    {selectedMarket !== "all" && markets && (
                      <span className="text-xs font-normal normal-case text-primary">
                        {markets.find(m => m.id === selectedMarket)?.name || "Market"}
                      </span>
                    )}
                  </h2>
                  <div className="flex items-center gap-2 sm:gap-3">
                    {markets && markets.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground hidden sm:inline">Market:</span>
                        <Select value={selectedMarket} onValueChange={setSelectedMarket}>
                          <SelectTrigger className="w-[110px] sm:w-[130px] h-7 text-xs" data-testid="select-market">
                            <SelectValue placeholder="All Markets" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Markets</SelectItem>
                            {markets.map((market) => (
                              <SelectItem key={market.id} value={market.id}>
                                <span className="flex items-center gap-2">
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: market.color || "#6366f1" }}
                                  />
                                  {market.name}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground hidden sm:inline">Sort:</span>
                      <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                        <SelectTrigger className="w-[110px] sm:w-[130px] h-7 text-xs" data-testid="select-sort">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sales">Total Sales</SelectItem>
                          <SelectItem value="variance">% vs LW Day</SelectItem>
                          <SelectItem value="wtd_variance">% vs LW WTD</SelectItem>
                          <SelectItem value="yoy">% vs LY</SelectItem>
                          <SelectItem value="banana_pudding">🍌 BP Shake</SelectItem>
                          <SelectItem value="missing_manager">Missing Mgr</SelectItem>
                          <SelectItem value="dt_time">DT Time</SelectItem>
                          <SelectItem value="xscore">Exc Score</SelectItem>
                          <SelectItem value="google_reviews">Google Rating</SelectItem>
                          <SelectItem value="osat">OSAT</SelectItem>
                          <SelectItem value="osat_time">OSAT Time</SelectItem>
                          <SelectItem value="check_avg">Check Avg</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* Virtualised card list — only mounts cards near the viewport */}
                <div
                  ref={listRef}
                  style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
                >
                  {virtualizer.getVirtualItems().map((virtualItem) => {
                    const restaurant = sortedRestaurants[virtualItem.index];
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
                          paddingBottom: "8px",
                        }}
                      >
                        <LeaderboardCard
                          restaurant={restaurant}
                          hourlyData={hourlyByRestaurant?.[restaurant.restaurantId]}
                          crewSummary={crewSummary?.[restaurant.restaurantId]}
                          hourlyCrewData={hourlyCrewByRestaurant?.[restaurant.restaurantId]}
                          checkAverage={checkAverageByRestaurant?.[restaurant.restaurantId]}
                          checkAvgTrend={checkAvgTrendByRestaurant?.[restaurant.restaurantId]}
                          consistencyScore={consistencyByRestaurant?.[restaurant.restaurantId]}
                          demandCurveHours={demandCurvesByRestaurant?.[restaurant.restaurantId]}
                          destinationsByHour={destinationsByRestaurant?.[restaurant.restaurantId]}
                          isToday={isToday}
                          yoyData={yoyBulkData?.data?.[restaurant.restaurantId]}
                          weeklyData={weeklySalesData?.restaurants?.[restaurant.restaurantId]}
                          notes={notesByRestaurant[restaurant.restaurantId]}
                          dateStr={dateStr}
                          onNoteAdded={refetchNotes}
                          attachmentCategories={attachmentRatesResponse?.restaurants?.[restaurant.restaurantId]?.categories}
                          overallAttachScore={attachmentRatesResponse?.restaurants?.[restaurant.restaurantId]?.overallAttachScore}
                          helperRewardPoints={helperRewardsByRestaurant?.[restaurant.restaurantId]}
                          twoWeekTrend={twoWeekTrendData?.restaurants?.[restaurant.restaurantId]}
                        />
                      </div>
                    );
                  })}
                </div>

                {leaderboardData.restaurants.length === 0 && (
                  <div className="rounded-xl border border-border/50 p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      No sales data available yet for today.
                    </p>
                  </div>
                )}
            </div>
          </>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 mt-6">
        <div className="container mx-auto px-4 sm:px-6 py-3">
          <p className="text-center text-xs text-muted-foreground">
            Sales data synced every 5 minutes
          </p>
        </div>
      </footer>
    </div>
  );
}
