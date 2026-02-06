import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { ArrowLeft, Calendar, Clock, AlertTriangle, ChevronDown, ChevronUp, Grid3X3, CalendarDays } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DailySummary } from "@/components/daily-summary";
import { format, subDays, addDays, parseISO, isValid, startOfDay, endOfDay, eachDayOfInterval } from "date-fns";
import type { LeaderboardData, HourlySalesData, MarketWithRestaurants } from "@shared/schema";

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
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [heatmapCollapsed, setHeatmapCollapsed] = useState(true);
  
  // Date selection state
  const todayStr = getCentralDateStr();
  const [startDate, setStartDate] = useState<string>(todayStr);
  const [endDate, setEndDate] = useState<string>(todayStr);
  const [isDateRangeMode, setIsDateRangeMode] = useState(false);
  
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
  
  // Use the selected date for API queries
  const dateStr = startDate;
  
  // Auto-refresh every 5 minutes (300000ms) for all-day monitoring
  const REFRESH_INTERVAL = 5 * 60 * 1000;
  
  const { data, isLoading } = useQuery<HeatmapData>({
    queryKey: ['/api/hourly-heatmap'],
    refetchInterval: REFRESH_INTERVAL,
  });
  
  // Fetch leaderboard data for DailySummary
  const { data: leaderboardData } = useQuery<LeaderboardData>({
    queryKey: ['/api/leaderboard', dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch leaderboard");
      return res.json();
    },
    refetchInterval: REFRESH_INTERVAL,
  });
  
  // Fetch hourly sales data for DailySummary
  const { data: hourlyData } = useQuery<Record<string, HourlySalesData[]>>({
    queryKey: ['/api/hourly-by-restaurant', dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/hourly-by-restaurant?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch hourly data");
      return res.json();
    },
    refetchInterval: REFRESH_INTERVAL,
  });
  
  // Fetch markets for DailySummary
  const { data: markets } = useQuery<MarketWithRestaurants[]>({
    queryKey: ['/api/markets'],
    refetchInterval: REFRESH_INTERVAL,
  });
  
  // Fetch crew summary for DailySummary
  const { data: crewSummaryResponse } = useQuery<{ date: string; summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> }>({
    queryKey: ['/api/crew/summary', dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/summary?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch crew summary");
      return res.json();
    },
    refetchInterval: REFRESH_INTERVAL,
  });
  const crewSummary = crewSummaryResponse?.summary;
  
  const toggleDate = (dateStr: string) => {
    setSelectedDates(prev => 
      prev.includes(dateStr) 
        ? prev.filter(d => d !== dateStr)
        : [...prev, dateStr]
    );
  };
  
  const selectAllDates = () => {
    if (data) {
      setSelectedDates(data.dateRange);
    }
  };
  
  const clearDates = () => {
    setSelectedDates([]);
  };
  
  // activeDates for heatmap - use date picker range if not default, otherwise use selectedDates or all
  const activeDates = useMemo(() => {
    if (!data) return [];
    // If date picker has a custom selection (not just today), use the analysisDateRange
    // Filter to only include dates that exist in the heatmap data
    const availableDates = new Set(data.dateRange);
    const filteredAnalysisRange = analysisDateRange.filter(d => availableDates.has(d));
    if (filteredAnalysisRange.length > 0) {
      return filteredAnalysisRange;
    }
    return selectedDates.length > 0 ? selectedDates : data.dateRange;
  }, [data, selectedDates, analysisDateRange]);
  
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
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <h1 className="text-xl font-bold">MWB Dashboard</h1>
          </div>
          
          {/* Date Selection Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Label htmlFor="start-date" className="text-sm text-muted-foreground whitespace-nowrap">
                <CalendarDays className="w-4 h-4 inline mr-1" />
                {isDateRangeMode ? "From:" : "Date:"}
              </Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                max={todayStr}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className="w-36 h-8 text-sm"
                data-testid="input-start-date"
              />
            </div>
            
            {isDateRangeMode && (
              <div className="flex items-center gap-2">
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStartDate(todayStr);
                  setEndDate(todayStr);
                }}
                data-testid="button-reset-date"
              >
                Today
              </Button>
            )}
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
                {/* Date selector */}
                <div className="flex items-center justify-between flex-wrap gap-2 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Select Days</span>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={selectAllDates} data-testid="button-select-all">
                      All
                    </Button>
                    <Button variant="outline" size="sm" onClick={clearDates} data-testid="button-clear-dates">
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {data.dateRange.map(dateStr => (
                    <Button
                      key={dateStr}
                      variant={selectedDates.includes(dateStr) ? "default" : "outline"}
                      size="sm"
                      onClick={() => toggleDate(dateStr)}
                      data-testid={`button-date-${dateStr}`}
                    >
                      {formatDate(dateStr)}
                    </Button>
                  ))}
                </div>
                
                {/* Legend */}
                <div className="flex items-center gap-2 text-xs border-t pt-3">
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
