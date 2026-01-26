import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowLeft, Calendar, Clock, AlertTriangle } from "lucide-react";

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
  
  if (intensity < 0.2) return "bg-green-100 dark:bg-green-900/30";
  if (intensity < 0.4) return "bg-green-300 dark:bg-green-800/50";
  if (intensity < 0.6) return "bg-yellow-300 dark:bg-yellow-700/60";
  if (intensity < 0.8) return "bg-orange-400 dark:bg-orange-600/70";
  return "bg-red-500 dark:bg-red-500/80";
}

export default function HeatmapPage() {
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  
  const { data, isLoading } = useQuery<HeatmapData>({
    queryKey: ['/api/hourly-heatmap'],
  });
  
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
  
  const activeDates = useMemo(() => {
    if (!data) return [];
    return selectedDates.length > 0 ? selectedDates : data.dateRange;
  }, [data, selectedDates]);
  
  const stats = useMemo(() => {
    if (!data) return { totalZeroHours: 0, totalHours: 0 };
    
    let totalZeroHours = 0;
    let totalHours = 0;
    
    for (const restaurant of data.restaurants) {
      for (const dateStr of activeDates) {
        const dayData = data.heatmapData[restaurant.id]?.[dateStr];
        if (dayData) {
          for (let hour = 0; hour < 24; hour++) {
            totalHours++;
            if (dayData[hour] === 0) totalZeroHours++;
          }
        }
      }
    }
    
    return { totalZeroHours, totalHours };
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
            <h1 className="text-xl font-bold">Hourly Sales Heatmap</h1>
          </div>
          
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <AlertTriangle className="w-3 h-3" />
              {stats.totalZeroHours} zero-sales hours
            </Badge>
          </div>
        </div>
        
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Select Days
              </CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={selectAllDates} data-testid="button-select-all">
                  All
                </Button>
                <Button variant="outline" size="sm" onClick={clearDates} data-testid="button-clear-dates">
                  Clear
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-wrap gap-2">
              {data.dateRange.map(dateStr => (
                <Button
                  key={dateStr}
                  variant={selectedDates.includes(dateStr) || selectedDates.length === 0 ? "default" : "outline"}
                  size="sm"
                  onClick={() => toggleDate(dateStr)}
                  className={selectedDates.length === 0 ? "opacity-70" : ""}
                  data-testid={`button-date-${dateStr}`}
                >
                  {formatDate(dateStr)}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Sales by Hour
            </CardTitle>
            <div className="flex items-center gap-2 text-xs mt-2">
              <span className="text-muted-foreground">Volume:</span>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-gray-200 dark:bg-gray-700" />
                <span className="text-muted-foreground">$0</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-green-300 dark:bg-green-800/50" />
                <span className="text-muted-foreground">Low</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-yellow-300 dark:bg-yellow-700/60" />
                <span className="text-muted-foreground">Med</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-red-500 dark:bg-red-500/80" />
                <span className="text-muted-foreground">High</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
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
              </thead>
              <tbody>
                {data.restaurants.map(restaurant => (
                  activeDates.map((dateStr, dateIdx) => {
                    const dayData = data.heatmapData[restaurant.id]?.[dateStr];
                    const zeroCount = dayData 
                      ? Object.values(dayData).filter(v => v === 0).length 
                      : 24;
                    
                    return (
                      <tr key={`${restaurant.id}-${dateStr}`} className="border-t border-border/50">
                        {dateIdx === 0 && (
                          <td 
                            className="p-1 font-medium sticky left-0 bg-background z-10"
                            rowSpan={activeDates.length}
                          >
                            <div className="truncate max-w-[120px]" title={restaurant.name}>
                              {restaurant.name}
                            </div>
                          </td>
                        )}
                        <td className="p-1 text-muted-foreground whitespace-nowrap">
                          {formatDate(dateStr)}
                          {zeroCount > 12 && (
                            <span title={`${zeroCount} hours with $0 sales`}>
                              <AlertTriangle className="inline-block ml-1 w-3 h-3 text-yellow-600 dark:text-yellow-400" />
                            </span>
                          )}
                        </td>
                        {Array.from({ length: 24 }, (_, hour) => {
                          const sales = dayData?.[hour] ?? 0;
                          return (
                            <td key={hour} className="p-0.5">
                              <div 
                                className={`w-6 h-6 rounded ${getHeatColor(sales, data.maxSales)} flex items-center justify-center cursor-help`}
                                title={`${restaurant.name} - ${formatDate(dateStr)} ${formatHour(hour)}: $${sales.toLocaleString()}`}
                              >
                                {sales === 0 && (
                                  <span className="text-[8px] text-muted-foreground">-</span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
