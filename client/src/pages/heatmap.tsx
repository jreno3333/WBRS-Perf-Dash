import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { AlertTriangle, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Grid3X3, CalendarDays } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DailySummary } from "@/components/daily-summary";
import { NavBar } from "@/components/nav-bar";
import { format, parseISO, isValid, eachDayOfInterval } from "date-fns";
import type { LeaderboardData, HourlySalesData, MarketWithRestaurants, RestaurantSales } from "@shared/schema";

interface HeatmapData {
  restaurants: { id: string; name: string }[];
  dateRange: string[];
  heatmapData: Record<string, Record<string, Record<number, number>>>;
  maxSales: number;
}

function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getHeatColor(sales: number, maxSales: number): string {
  if (sales === 0) return "bg-gray-200 dark:bg-gray-700";
  
  const intensity = Math.min(sales / maxSales, 1);
  
  // Reversed: low sales = red (bad), high sales = green (good)
  // More gradient steps for better distinction
  if (intensity < 0.1) return "bg-red-600 dark:bg-red-600/80";
  if (intensity < 0.2) return "bg-red-500 dark:bg-red-500/70";
  if (intensity < 0.3) return "bg-orange-500 dark:bg-orange-500/70";
  if (intensity < 0.4) return "bg-orange-400 dark:bg-orange-400/60";
  if (intensity < 0.5) return "bg-yellow-500 dark:bg-yellow-500/60";
  if (intensity < 0.6) return "bg-yellow-400 dark:bg-yellow-400/50";
  if (intensity < 0.7) return "bg-lime-400 dark:bg-lime-500/50";
  if (intensity < 0.8) return "bg-green-400 dark:bg-green-500/60";
  if (intensity < 0.9) return "bg-green-500 dark:bg-green-500/70";
  return "bg-green-600 dark:bg-green-600/80";
}

// Get current date in Central timezone (business day)
function getCentralDateStr(): string {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

export default function HeatmapPage() {
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [heatmapCollapsed, setHeatmapCollapsed] = useState(true);
  
  // Read URL params for deep linking from email reports
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const urlDate = urlParams.get('date');
  const urlUnit = urlParams.get('unit');
  const [expandUnitId, setExpandUnitId] = useState<string | null>(urlUnit);
  
  // Date selection state
  const todayStr = getCentralDateStr();
  const [startDate, setStartDate] = useState<string>(urlDate || todayStr);
  const [endDate, setEndDate] = useState<string>(urlDate || todayStr);
  const [isDateRangeMode, setIsDateRangeMode] = useState(false);
  
  // When coming from email link, ensure summary is expanded
  useEffect(() => {
    if (urlUnit) {
      setSummaryCollapsed(false);
    }
  }, []);
  
  // Auto-adjust endDate if startDate changes to be after endDate
  const handleStartDateChange = (newStartDate: string) => {
    if (!newStartDate) return;
    setStartDate(newStartDate);
    if (isDateRangeMode && newStartDate > endDate) {
      setEndDate(newStartDate);
    }
  };

  const handleEndDateChange = (newEndDate: string) => {
    if (!newEndDate) return;
    setEndDate(newEndDate);
  };

  const goToPreviousDay = () => {
    const prev = new Date(startDate + "T12:00:00");
    prev.setDate(prev.getDate() - 1);
    const prevStr = format(prev, "yyyy-MM-dd");
    setStartDate(prevStr);
    if (!isDateRangeMode) setEndDate(prevStr);
  };

  const goToNextDay = () => {
    const next = new Date(startDate + "T12:00:00");
    next.setDate(next.getDate() + 1);
    const nextStr = format(next, "yyyy-MM-dd");
    if (nextStr <= todayStr) {
      setStartDate(nextStr);
      if (!isDateRangeMode) setEndDate(nextStr);
    }
  };

  const goToToday = () => {
    setStartDate(todayStr);
    setEndDate(todayStr);
  };
  
  // Compute the active analysis date or date range
  const analysisDateRange = useMemo(() => {
    if (!isDateRangeMode) {
      return [startDate];
    }
    
    try {
      const start = parseISO(startDate);
      const end = parseISO(endDate);
      if (!isValid(start) || !isValid(end) || start > end) {
        return [startDate];
      }
      return eachDayOfInterval({ start, end }).map(d => format(d, 'yyyy-MM-dd'));
    } catch {
      return [startDate];
    }
  }, [startDate, endDate, isDateRangeMode]);
  
  // Auto-refresh every 5 minutes (300000ms) for all-day monitoring
  const REFRESH_INTERVAL = 5 * 60 * 1000;
  
  const heatmapStartDate = isDateRangeMode ? startDate : startDate;
  const heatmapEndDate = isDateRangeMode ? endDate : startDate;

  const { data, isLoading } = useQuery<HeatmapData>({
    queryKey: ['/api/hourly-heatmap', heatmapStartDate, heatmapEndDate],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-heatmap?startDate=${heatmapStartDate}&endDate=${heatmapEndDate}`);
      if (!res.ok) throw new Error("Failed to fetch heatmap data");
      return res.json();
    },
    refetchInterval: REFRESH_INTERVAL,
  });
  
  // Fetch leaderboard data for ALL days in range
  const leaderboardQueries = useQueries({
    queries: analysisDateRange.map(date => ({
      queryKey: ['/api/leaderboard', date],
      queryFn: async () => {
        const res = await fetch(`/api/leaderboard?date=${date}`);
        if (!res.ok) throw new Error("Failed to fetch leaderboard");
        return res.json() as Promise<LeaderboardData>;
      },
      refetchInterval: REFRESH_INTERVAL,
    })),
  });

  // Fetch hourly sales data for ALL days in range
  const hourlyQueries = useQueries({
    queries: analysisDateRange.map(date => ({
      queryKey: ['/api/hourly-by-restaurant', date],
      queryFn: async () => {
        const res = await fetch(`/api/hourly-by-restaurant?date=${date}`);
        if (!res.ok) throw new Error("Failed to fetch hourly data");
        return res.json() as Promise<Record<string, HourlySalesData[]>>;
      },
      refetchInterval: REFRESH_INTERVAL,
    })),
  });

  // Fetch crew summary for ALL days in range
  const crewQueries = useQueries({
    queries: analysisDateRange.map(date => ({
      queryKey: ['/api/crew/summary', date],
      queryFn: async () => {
        const res = await fetch(`/api/crew/summary?date=${date}`);
        if (!res.ok) throw new Error("Failed to fetch crew summary");
        return res.json() as Promise<{ date: string; summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> }>;
      },
      refetchInterval: REFRESH_INTERVAL,
    })),
  });

  // Fetch markets (not date-dependent)
  const { data: markets } = useQuery<MarketWithRestaurants[]>({
    queryKey: ['/api/markets'],
    refetchInterval: REFRESH_INTERVAL,
  });

  // Aggregate leaderboard data across all days in range
  const leaderboardData = useMemo<LeaderboardData | undefined>(() => {
    const allData = leaderboardQueries
      .filter(q => q.data)
      .map(q => q.data!);
    
    if (allData.length === 0) return undefined;
    if (allData.length === 1) return allData[0];
    
    const restaurantMap = new Map<string, RestaurantSales>();
    const restaurantDayCount = new Map<string, number>();
    
    for (const dayData of allData) {
      for (const r of dayData.restaurants) {
        const existing = restaurantMap.get(r.restaurantId);
        const count = (restaurantDayCount.get(r.restaurantId) || 0) + 1;
        restaurantDayCount.set(r.restaurantId, count);
        
        if (!existing) {
          restaurantMap.set(r.restaurantId, { ...r });
        } else {
          existing.actualSales += r.actualSales;
          existing.todaySales += r.todaySales;
          existing.lastWeekSales += r.lastWeekSales;
          existing.actualLastWeekSales += r.actualLastWeekSales;
          existing.forecastSales += r.forecastSales;
          if (r.driveThru && existing.driveThru) {
            existing.driveThru = {
              carCount: existing.driveThru.carCount + r.driveThru.carCount,
              avgTotalTime: ((existing.driveThru.avgTotalTime * (count - 1)) + r.driveThru.avgTotalTime) / count,
              avgServiceTime: ((existing.driveThru.avgServiceTime * (count - 1)) + r.driveThru.avgServiceTime) / count,
            };
          } else if (r.driveThru) {
            existing.driveThru = { ...r.driveThru };
          }
          if (r.osat && existing.osat) {
            existing.osat = {
              totalResponses: existing.osat.totalResponses + r.osat.totalResponses,
              fiveStarCount: existing.osat.fiveStarCount + r.osat.fiveStarCount,
              osatPercent: ((existing.osat.fiveStarCount + r.osat.fiveStarCount) / (existing.osat.totalResponses + r.osat.totalResponses)) * 100,
            };
          } else if (r.osat) {
            existing.osat = { ...r.osat };
          }
        }
      }
    }
    
    const restaurants = Array.from(restaurantMap.values()).map(r => {
      r.pacePercentage = r.actualLastWeekSales > 0 ? (r.actualSales / r.actualLastWeekSales) * 100 : 0;
      r.isAheadOfPace = r.pacePercentage >= 100;
      return r;
    });
    
    return {
      ...allData[0],
      restaurants,
    };
  }, [leaderboardQueries]);

  // Aggregate hourly data across all days (merge/concatenate hourly records)
  const hourlyData = useMemo<Record<string, HourlySalesData[]> | undefined>(() => {
    const allData = hourlyQueries
      .filter(q => q.data)
      .map(q => q.data!);
    
    if (allData.length === 0) return undefined;
    if (allData.length === 1) return allData[0];
    
    const merged: Record<string, HourlySalesData[]> = {};
    
    for (const dayData of allData) {
      for (const [restaurantId, hours] of Object.entries(dayData)) {
        if (!merged[restaurantId]) {
          merged[restaurantId] = [];
        }
        for (const hour of hours) {
          const existing = merged[restaurantId].find(h => h.hour === hour.hour);
          if (existing) {
            existing.todaySales += hour.todaySales;
            existing.lastWeekSales += hour.lastWeekSales;
            existing.forecastSales += hour.forecastSales;
            if (hour.osatPercent !== undefined && hour.osatResponses !== undefined && hour.osatResponses > 0) {
              const existingResponses = existing.osatResponses || 0;
              const existingOsat = existing.osatPercent || 0;
              const totalResponses = existingResponses + hour.osatResponses;
              existing.osatPercent = ((existingOsat * existingResponses) + (hour.osatPercent * hour.osatResponses)) / totalResponses;
              existing.osatResponses = totalResponses;
            }
          } else {
            merged[restaurantId].push({ ...hour });
          }
        }
      }
    }
    
    return merged;
  }, [hourlyQueries]);

  // Aggregate crew summary across days (average)
  const crewSummary = useMemo<Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> | undefined>(() => {
    const allData = crewQueries
      .filter(q => q.data?.summary)
      .map(q => q.data!.summary);
    
    if (allData.length === 0) return undefined;
    if (allData.length === 1) return allData[0];
    
    const merged: Record<string, { totalScore: number; totalCrewCount: number; totalTenure: number; count: number }> = {};
    
    for (const daySummary of allData) {
      for (const [restaurantId, data] of Object.entries(daySummary)) {
        if (!merged[restaurantId]) {
          merged[restaurantId] = { totalScore: 0, totalCrewCount: 0, totalTenure: 0, count: 0 };
        }
        merged[restaurantId].totalScore += data.avgScore;
        merged[restaurantId].totalCrewCount += data.avgCrewCount;
        merged[restaurantId].totalTenure += data.avgTenureMonths;
        merged[restaurantId].count++;
      }
    }
    
    const result: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> = {};
    for (const [id, data] of Object.entries(merged)) {
      result[id] = {
        avgScore: data.totalScore / data.count,
        avgCrewCount: data.totalCrewCount / data.count,
        avgTenureMonths: data.totalTenure / data.count,
      };
    }
    return result;
  }, [crewQueries]);

  // Use first date in range for single-date dependent queries
  const dateStr = startDate;
  
  const activeDates = useMemo(() => {
    if (!data) return [];
    return data.dateRange;
  }, [data]);
  
  const stats = useMemo(() => {
    if (!data) return { totalZeroHours: 0, totalHours: 0 };
    
    // Get current date/hour in Central timezone to exclude future hours
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const currentHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
    
    let totalZeroHours = 0;
    let totalHours = 0;
    
    for (const restaurant of data.restaurants) {
      for (const dateStr of activeDates) {
        const dayData = data.heatmapData[restaurant.id]?.[dateStr];
        if (dayData) {
          // Determine max hour to count for this date
          const maxHour = dateStr === todayStr ? currentHour : 23;
          
          for (let hour = 0; hour <= maxHour; hour++) {
            totalHours++;
            if (dayData[hour] === 0) totalZeroHours++;
          }
        }
      }
    }
    
    return { totalZeroHours, totalHours };
  }, [data, activeDates]);
  
  // Calculate open stores per hour (stores with sales > 0 for each hour across active dates)
  const openStoresPerHour = useMemo(() => {
    if (!data) return Array(24).fill(0);
    
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const currentHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
    
    const counts = Array(24).fill(0);
    
    for (let hour = 0; hour < 24; hour++) {
      let openCount = 0;
      for (const restaurant of data.restaurants) {
        for (const dateStr of activeDates) {
          const dayData = data.heatmapData[restaurant.id]?.[dateStr];
          if (dayData) {
            // For today, skip future hours
            if (dateStr === todayStr && hour > currentHour) continue;
            // Count if store had sales > 0 for this hour
            if (dayData[hour] && dayData[hour] > 0) {
              openCount++;
            }
          }
        }
      }
      counts[hour] = openCount;
    }
    
    return counts;
  }, [data, activeDates]);
  
  // Calculate max sales based on currently visible/selected dates for dynamic color scaling
  const visibleMaxSales = useMemo(() => {
    if (!data) return 0;
    
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const currentHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
    
    let maxSales = 0;
    
    for (const restaurant of data.restaurants) {
      for (const dateStr of activeDates) {
        const dayData = data.heatmapData[restaurant.id]?.[dateStr];
        if (dayData) {
          // Only count hours that have passed (not future hours)
          const maxHour = dateStr === todayStr ? currentHour : 23;
          
          for (let hour = 0; hour <= maxHour; hour++) {
            const sales = dayData[hour] ?? 0;
            if (sales > maxSales) maxSales = sales;
          }
        }
      }
    }
    
    return maxSales;
  }, [data, activeDates]);
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-7xl mx-auto">
          <div className="animate-pulse space-y-4">
            <div className="h-8 w-48 bg-muted rounded" />
            <div className="h-64 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }
  
  if (!data) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-7xl mx-auto text-center py-12">
          <p className="text-muted-foreground">No data available</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Grid3X3 className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">Daily Performance</h1>
          </div>
          
          {/* Date Navigation + Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {!isDateRangeMode && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={goToPreviousDay} data-testid="button-prev-day">
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <div className="flex items-center gap-1">
                  <CalendarDays className="w-4 h-4 text-muted-foreground" />
                  <Input
                    type="date"
                    value={startDate}
                    max={todayStr}
                    onChange={(e) => handleStartDateChange(e.target.value)}
                    className="w-36 h-8 text-sm"
                    data-testid="input-start-date"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={goToNextDay}
                  disabled={startDate >= todayStr}
                  data-testid="button-next-day"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}

            {isDateRangeMode && (
              <div className="flex items-center gap-2">
                <Label htmlFor="start-date-range" className="text-sm text-muted-foreground whitespace-nowrap">
                  <CalendarDays className="w-4 h-4 inline mr-1" />From:
                </Label>
                <Input
                  id="start-date-range"
                  type="date"
                  value={startDate}
                  max={todayStr}
                  onChange={(e) => handleStartDateChange(e.target.value)}
                  className="w-36 h-8 text-sm"
                />
                <Label htmlFor="end-date" className="text-sm text-muted-foreground">To:</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  min={startDate}
                  max={todayStr}
                  onChange={(e) => handleEndDateChange(e.target.value)}
                  className="w-36 h-8 text-sm"
                  data-testid="input-end-date"
                />
              </div>
            )}

            <Button
              variant={isDateRangeMode ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setIsDateRangeMode(!isDateRangeMode);
                if (!isDateRangeMode) {
                  setEndDate(startDate);
                }
              }}
              data-testid="button-toggle-range"
            >
              {isDateRangeMode ? "Single Day" : "Date Range"}
            </Button>

            {startDate !== todayStr && (
              <Button variant="ghost" size="sm" onClick={goToToday} data-testid="button-reset-date">
                Today
              </Button>
            )}
            <NavBar />
          </div>
        </div>
        
        {/* Date Range Display */}
        {isDateRangeMode && analysisDateRange.length > 1 && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              Analyzing {analysisDateRange.length} days: {format(parseISO(analysisDateRange[0]), 'MMM d')} - {format(parseISO(analysisDateRange[analysisDateRange.length - 1]), 'MMM d')}
            </Badge>
          </div>
        )}
        
        {/* Daily Performance Summary - First */}
        {leaderboardData && (
          <DailySummary 
            restaurants={leaderboardData.restaurants}
            hourlyByRestaurant={hourlyData}
            markets={markets}
            crewSummary={crewSummary}
            isCollapsed={summaryCollapsed}
            onCollapseChange={setSummaryCollapsed}
            selectedDate={startDate}
            dateRange={analysisDateRange}
            expandUnitId={expandUnitId}
            onUnitExpanded={() => setExpandUnitId(null)}
          />
        )}
        
        {/* Hourly Sales Heatmap - Collapsible */}
        <Collapsible open={!heatmapCollapsed} onOpenChange={(open) => setHeatmapCollapsed(!open)}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Grid3X3 className="w-4 h-4 text-blue-500" />
                    Hourly Sales Heatmap
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      {stats.totalZeroHours} zero-sales hours
                    </Badge>
                    <Button variant="ghost" size="sm" type="button">
                      {heatmapCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="pt-0 space-y-4">
                {/* Legend */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Volume:</span>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-gray-200 dark:bg-gray-700" />
                    <span className="text-muted-foreground">$0</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-red-500 dark:bg-red-500/70" />
                    <span className="text-muted-foreground">Low</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-yellow-400 dark:bg-yellow-400/50" />
                    <span className="text-muted-foreground">Med</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-4 h-4 rounded bg-green-500 dark:bg-green-500/70" />
                    <span className="text-muted-foreground">High</span>
                  </div>
                </div>
                
                {/* Heatmap Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className="text-left p-1 sticky left-0 bg-background z-10 min-w-[120px]">Store</th>
                        <th className="text-left p-1 min-w-[60px]">Date</th>
                        {Array.from({ length: 24 }, (_, i) => (
                          <th key={i} className="p-1 text-center min-w-[28px]">
                            {formatHour(i)}
                          </th>
                        ))}
                      </tr>
                      <tr className="border-b border-border bg-muted/30">
                        <td className="p-1 sticky left-0 bg-muted/30 z-10 text-muted-foreground text-[10px]">Open</td>
                        <td className="p-1 text-muted-foreground text-[10px]">stores</td>
                        {openStoresPerHour.map((count, hour) => (
                          <td key={hour} className="p-1 text-center text-[10px] text-muted-foreground font-medium">
                            {count > 0 ? count : '-'}
                          </td>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.restaurants.map(restaurant => {
                        const restaurantDates = activeDates.filter(dateStr => 
                          data.heatmapData[restaurant.id]?.[dateStr] !== undefined
                        );
                        
                        if (restaurantDates.length === 0) return null;
                        
                        return restaurantDates.map((dateStr, dateIdx) => {
                          const dayData = data.heatmapData[restaurant.id]?.[dateStr];
                          
                          const now = new Date();
                          const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
                          const currentHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
                          const isToday = dateStr === todayStr;
                          
                          const zeroCount = dayData 
                            ? Object.entries(dayData).filter(([hourStr, v]) => {
                                const hour = parseInt(hourStr);
                                if (isToday && hour > currentHour) return false;
                                return v === 0;
                              }).length 
                            : 0;
                          
                          return (
                            <tr key={`${restaurant.id}-${dateStr}`} className="border-t border-border/50">
                              {dateIdx === 0 && (
                                <td 
                                  className="p-1 font-medium sticky left-0 bg-background z-10"
                                  rowSpan={restaurantDates.length}
                                >
                                  <div className="truncate max-w-[120px]" title={restaurant.name}>
                                    {restaurant.name}
                                  </div>
                                </td>
                              )}
                              <td className="p-1 text-muted-foreground whitespace-nowrap">
                                {formatDate(dateStr)}
                                {zeroCount > 4 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <AlertTriangle className="inline-block ml-1 w-3 h-3 text-yellow-600 dark:text-yellow-400 cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="text-xs">
                                      {zeroCount} hours with $0 sales
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </td>
                              {Array.from({ length: 24 }, (_, hour) => {
                                const sales = dayData?.[hour] ?? 0;
                                
                                const now = new Date();
                                const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
                                const currentHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
                                const isFutureHour = dateStr === todayStr && hour > currentHour;
                                
                                if (isFutureHour) {
                                  return (
                                    <td key={hour} className="p-0.5">
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <div className="w-6 h-6 rounded bg-muted/30 flex items-center justify-center cursor-help border border-dashed border-muted-foreground/20">
                                            <span className="text-[7px] text-muted-foreground/50">N/A</span>
                                          </div>
                                        </TooltipTrigger>
                                        <TooltipContent side="top" className="text-xs">
                                          <div className="font-medium">{restaurant.name}</div>
                                          <div>{formatDate(dateStr)} at {formatHour(hour)}</div>
                                          <div className="text-muted-foreground">Future hour - not yet available</div>
                                        </TooltipContent>
                                      </Tooltip>
                                    </td>
                                  );
                                }
                                
                                return (
                                  <td key={hour} className="p-0.5">
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <div 
                                          className={`w-6 h-6 rounded ${getHeatColor(sales, visibleMaxSales)} flex items-center justify-center cursor-pointer`}
                                        >
                                          {sales === 0 && (
                                            <span className="text-[8px] text-muted-foreground">-</span>
                                          )}
                                        </div>
                                      </TooltipTrigger>
                                      <TooltipContent side="top" className="text-xs">
                                        <div className="font-medium">{restaurant.name}</div>
                                        <div>{formatDate(dateStr)} at {formatHour(hour)}</div>
                                        <div className="font-bold text-green-600 dark:text-green-400">${sales.toLocaleString()}</div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        });
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>
    </div>
  );
}
