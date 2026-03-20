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
  ReferenceLine
} from "recharts";
import type { HourlySalesData } from "@shared/schema";
import { formatCurrency } from "@/lib/grading";

interface PaceChartProps {
  data: HourlySalesData[];
  restaurantName: string;
}

export function PaceChart({ data, restaurantName }: PaceChartProps) {
  // formatCurrency is imported from @/lib/grading (module-level singleton)

  // Show all 24 hours individually, filling in zeros for missing hours
  const getHourLabel = (h: number) => 
    h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`;
  
  // Create map of existing data
  const dataMap = new Map<number, HourlySalesData>();
  data.forEach(item => dataMap.set(item.hour, item));
  
  // Generate all 24 hours (0-23)
  // Note: Backend already returns cumulative values for "all restaurants" view
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
                name="Projected"
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
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
