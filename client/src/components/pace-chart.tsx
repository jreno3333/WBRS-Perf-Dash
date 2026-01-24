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
  currentHour?: number | null;
}

export function PaceChart({ data, restaurantName, currentHour }: PaceChartProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Show all 24 hours individually, filling in zeros for missing hours
  const getHourLabel = (h: number) => 
    h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`;
  
  // Create map of existing data
  const dataMap = new Map<number, HourlySalesData>();
  data.forEach(item => dataMap.set(item.hour, item));
  
  // Generate all 24 hours (0-23)
  const processedData: HourlySalesData[] = [];
  for (let h = 0; h < 24; h++) {
    const existing = dataMap.get(h);
    if (existing) {
      processedData.push(existing);
    } else {
      processedData.push({
        hour: h,
        todaySales: 0,
        lastWeekSales: 0,
        forecastSales: 0,
        employeeCount: 0,
        projectedLabor: 0,
        actualLabor: 0,
        label: getHourLabel(h),
      } as HourlySalesData);
    }
  }

  // Use server-provided current hour to determine in-progress indicator
  let inProgressLabel: string | null = null;
  let inProgressSales = 0;
  
  if (currentHour !== null && currentHour !== undefined) {
    const hourLabel = getHourLabel(currentHour);
    const matchingHour = processedData.find(d => d.hour === currentHour);
    if (matchingHour) {
      inProgressLabel = matchingHour.label;
      inProgressSales = matchingHour.todaySales;
    } else {
      inProgressLabel = hourLabel;
      inProgressSales = 0;
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
