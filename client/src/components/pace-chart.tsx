import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart,
  ReferenceLine,
  ReferenceDot
} from "recharts";
import type { HourlySalesData } from "@shared/schema";

interface PaceChartProps {
  data: HourlySalesData[];
  restaurantName: string;
}

export function PaceChart({ data, restaurantName }: PaceChartProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Combine 5am and 6am into "Early Bird" and filter out hours 0-4
  const processedData = data.reduce((acc: HourlySalesData[], item) => {
    // Skip hours 0-4 (no sales)
    if (item.hour < 5) return acc;
    
    // Combine 5am and 6am into "Early Bird"
    if (item.hour === 5) {
      const hour6 = data.find(d => d.hour === 6);
      acc.push({
        hour: 5,
        label: "Early Bird",
        todaySales: item.todaySales + (hour6?.todaySales || 0),
        lastWeekSales: item.lastWeekSales + (hour6?.lastWeekSales || 0),
        forecastSales: item.forecastSales + (hour6?.forecastSales || 0),
      });
      return acc;
    }
    
    // Skip 6am since it's combined with 5am
    if (item.hour === 6) return acc;
    
    // Keep all other hours as-is
    acc.push(item);
    return acc;
  }, []);

  // Find the current in-progress hour by looking at where todaySales stops increasing
  // The in-progress hour is the LAST hour where cumulative sales increased (before plateau)
  let inProgressLabel: string | null = null;
  let inProgressSales = 0;
  
  // Find the last hour where sales increased compared to the NEXT hour (or equals next)
  // This means we scan forward and find where cumulative growth stops
  for (let i = 0; i < processedData.length; i++) {
    const current = processedData[i];
    const next = i < processedData.length - 1 ? processedData[i + 1] : null;
    
    // If this hour has sales and the next hour doesn't add more (plateau starts)
    // OR this is the last hour with any sales increase
    if (current.todaySales > 0) {
      if (!next || next.todaySales <= current.todaySales) {
        // This is where growth stops - mark as in-progress
        inProgressLabel = current.label;
        inProgressSales = current.todaySales;
        break;
      }
    }
  }

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-card border border-border rounded-md shadow-lg p-3">
          <p className="font-medium text-sm mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center gap-2 text-sm">
              <div 
                className="w-2.5 h-2.5 rounded-full" 
                style={{ backgroundColor: entry.color }} 
              />
              <span className="text-muted-foreground">{entry.name}:</span>
              <span className="font-medium">{formatCurrency(entry.value)}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="h-full" data-testid="card-pace-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span>Daily Overview</span>
            {inProgressLabel && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300" data-testid="badge-in-progress">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                {inProgressLabel} In Progress
              </span>
            )}
          </div>
          <span className="text-sm font-normal text-muted-foreground">
            {restaurantName}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={processedData}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="todayGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(24, 91%, 53%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(24, 91%, 53%)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="lastWeekGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(221, 83%, 53%)" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="hsl(221, 83%, 53%)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="forecastGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid 
                strokeDasharray="3 3" 
                vertical={false}
                stroke="hsl(var(--border))"
              />
              <XAxis 
                dataKey="label" 
                axisLine={false}
                tickLine={false}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                dy={10}
              />
              <YAxis 
                axisLine={false}
                tickLine={false}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
                width={50}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend 
                verticalAlign="top"
                height={36}
                iconType="circle"
                iconSize={8}
                formatter={(value) => (
                  <span className="text-sm text-foreground">{value}</span>
                )}
              />
              <Area
                type="monotone"
                dataKey="forecastSales"
                name="Forecast"
                stroke="hsl(142, 71%, 45%)"
                strokeWidth={2}
                fill="url(#forecastGradient)"
                strokeDasharray="3 3"
              />
              <Area
                type="monotone"
                dataKey="lastWeekSales"
                name="Last Week"
                stroke="hsl(221, 83%, 53%)"
                strokeWidth={2}
                fill="url(#lastWeekGradient)"
                strokeDasharray="5 5"
              />
              <Area
                type="monotone"
                dataKey="todaySales"
                name="Today"
                stroke="hsl(24, 91%, 53%)"
                strokeWidth={2.5}
                fill="url(#todayGradient)"
              />
              {inProgressLabel && (
                <ReferenceDot
                  x={inProgressLabel}
                  y={inProgressSales}
                  r={6}
                  fill="hsl(24, 91%, 53%)"
                  stroke="white"
                  strokeWidth={2}
                  isFront={true}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
