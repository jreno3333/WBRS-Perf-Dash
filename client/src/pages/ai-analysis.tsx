import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { NavBar } from "@/components/nav-bar";
import { Link } from "wouter";
import {
  BarChart3,
  DollarSign,
  Hash,
  Receipt,
  Star,
  Globe,
  Timer,
  Gauge,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  AlertTriangle,
  Trophy,
  Zap,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  Users,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from "recharts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricPair {
  current: number;
  previous: number;
  pctChange: number;
}

interface Restaurant {
  id: string;
  name: string;
  marketId: string | null;
  marketName: string | null;
  sales: MetricPair;
  transactions: MetricPair;
  checkAverage: MetricPair;
  osat: MetricPair & { responses: number };
  osatSpeed: MetricPair & { responses: number };
  googleRating: MetricPair;
  speedAttainment: MetricPair;
  labor: { actualHours: number; modelHours: number; variance: number; variancePct: number };
  channelMix: { drive_thru: number; dine_in: number; app: number; delivery_3pd: number };
  prevChannelMix: { drive_thru: number; dine_in: number; app: number; delivery_3pd: number };
  yoySales: { lastYear: number; pctChange: number } | null;
}

interface Alert {
  restaurantId: string;
  restaurant: string;
  metric: string;
  metricLabel: string;
  current: number;
  previous: number;
  pctChange: number;
  severity: "high" | "medium" | "low";
}

interface Outperformer {
  restaurantId: string;
  restaurant: string;
  metric: string;
  metricLabel: string;
  current: number;
  previous: number;
  pctChange: number;
}

interface Anomaly {
  restaurantId: string;
  restaurant: string;
  date: string;
  metric: string;
  metricLabel: string;
  value: number;
  avgValue: number;
  direction: "spike" | "drop";
  deviationPct: number;
}

interface MarketRollup {
  marketId: string;
  marketName: string;
  restaurantCount: number;
  sales: MetricPair;
  transactions: MetricPair;
  checkAverage: MetricPair;
  osat: MetricPair;
  osatSpeed: MetricPair;
  googleRating: MetricPair;
  speedAttainment: MetricPair;
}

interface ExecSummary {
  dateRange: { start: string; end: string; days: number };
  previousPeriod: { start: string; end: string };
  companyPulse: {
    sales: MetricPair;
    transactions: MetricPair;
    checkAverage: MetricPair;
    osat: MetricPair;
    osatSpeed: MetricPair;
    googleRating: MetricPair;
    speedAttainment: MetricPair;
  };
  restaurants: Restaurant[];
  alerts: Alert[];
  outperformers: Outperformer[];
  anomalies: Anomaly[];
  marketRollups: MarketRollup[];
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatCurrency(val: number): string {
  return "$" + val.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function formatPct(val: number): string {
  return val.toFixed(1) + "%";
}
function formatRating(val: number): string {
  return val.toFixed(1);
}
function formatNumber(val: number): string {
  return val.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function formatChange(val: number): string {
  const sign = val > 0 ? "+" : "";
  return sign + val.toFixed(1) + "%";
}

function formatMetricValue(metric: string, val: number): string {
  if (metric === "sales" || metric === "checkAverage") return formatCurrency(val);
  if (metric === "osat" || metric === "osatSpeed" || metric === "speedAttainment") return formatPct(val);
  if (metric === "googleRating") return formatRating(val);
  if (metric === "transactions") return formatNumber(val);
  return val.toFixed(1);
}

// Group an alert/outperformer metric into a high-level family for section headers.
function metricGroup(metric: string): "feedback" | "speed" | "sales" | "labor" {
  if (metric === "osat" || metric === "googleRating") return "feedback";
  if (metric === "osatSpeed" || metric === "speedAttainment") return "speed";
  if (metric === "sales" || metric === "checkAverage" || metric === "transactions") return "sales";
  if (metric === "laborVariance") return "labor";
  return "sales";
}

const METRIC_GROUP_ORDER: Array<"feedback" | "speed" | "sales" | "labor"> = [
  "feedback",
  "speed",
  "sales",
  "labor",
];

const METRIC_GROUP_LABELS: Record<string, string> = {
  feedback: "Guest Feedback",
  speed: "Speed",
  sales: "Sales",
  labor: "Labor",
};

// ---------------------------------------------------------------------------
// TrendArrow
// ---------------------------------------------------------------------------

function TrendArrow({
  value,
  inverse = false,
  showValue = true,
  size = "sm",
}: {
  value: number;
  inverse?: boolean;
  showValue?: boolean;
  size?: "xs" | "sm";
}) {
  const isPositive = inverse ? value < 0 : value > 0;
  const isNegative = inverse ? value > 0 : value < 0;
  const iconSize = size === "xs" ? 10 : 12;
  const textClass = size === "xs" ? "text-[10px]" : "text-xs";

  if (Math.abs(value) < 0.05) {
    return (
      <span className={`inline-flex items-center gap-0.5 text-muted-foreground ${textClass}`}>
        <Minus size={iconSize} />
        {showValue && <span>0.0%</span>}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-0.5 font-medium ${textClass} ${
        isPositive ? "text-green-500" : isNegative ? "text-red-500" : "text-muted-foreground"
      }`}
    >
      {value > 0 ? <ArrowUpRight size={iconSize} /> : <ArrowDownRight size={iconSize} />}
      {showValue && <span>{formatChange(value)}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: "high" | "medium" | "low" }) {
  const colors = {
    high: "bg-red-500/15 text-red-500 border-red-500/30",
    medium: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    low: "bg-yellow-500/15 text-yellow-600 border-yellow-500/30",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${colors[severity]}`}>
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Market badge
// ---------------------------------------------------------------------------

function MarketBadge({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <Badge variant="outline" className="text-[10px] px-1 py-0 ml-1 font-normal">
      {name}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Collapsible list section
// ---------------------------------------------------------------------------

function CollapsibleList<T>({
  items,
  limit,
  renderItem,
}: {
  items: T[];
  limit: number;
  renderItem: (item: T, idx: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const visible = items.slice(0, limit);
  const rest = items.slice(limit);

  return (
    <div>
      {visible.map((item, i) => renderItem(item, i))}
      {rest.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleContent>
            {rest.map((item, i) => renderItem(item, limit + i))}
          </CollapsibleContent>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full mt-1 text-xs h-7">
              {open ? (
                <>
                  <ChevronUp className="mr-1 h-3 w-3" /> Show less
                </>
              ) : (
                <>
                  <ChevronDown className="mr-1 h-3 w-3" /> Show {rest.length} more
                </>
              )}
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded ${className}`} />;
}

function SkeletonCards() {
  return (
    <div className="space-y-6 p-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel bar (mini horizontal stacked bar)
// ---------------------------------------------------------------------------

const CHANNEL_COLORS: Record<string, string> = {
  drive_thru: "#3b82f6",
  dine_in: "#10b981",
  app: "#8b5cf6",
  delivery_3pd: "#f59e0b",
};

const CHANNEL_LABELS: Record<string, string> = {
  drive_thru: "Drive-Thru",
  dine_in: "Dine-In",
  app: "App",
  delivery_3pd: "Delivery/3PD",
};

function ChannelBar({
  mix,
  height = 16,
}: {
  mix: { drive_thru: number; dine_in: number; app: number; delivery_3pd: number };
  height?: number;
}) {
  const [showPct, setShowPct] = useState(false);
  const total = mix.drive_thru + mix.dine_in + mix.app + mix.delivery_3pd;
  if (total === 0) return <div className="text-[10px] text-muted-foreground">No data</div>;

  const segments = [
    { key: "drive_thru", val: mix.drive_thru },
    { key: "dine_in", val: mix.dine_in },
    { key: "app", val: mix.app },
    { key: "delivery_3pd", val: mix.delivery_3pd },
  ];

  return (
    <div onClick={(e) => { e.stopPropagation(); setShowPct((v) => !v); }} className="cursor-pointer">
      <div className="flex rounded overflow-hidden" style={{ height: showPct ? 20 : height }}>
        {segments.map((s) => {
          const pct = (s.val / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={s.key}
              title={`${CHANNEL_LABELS[s.key]}: ${pct.toFixed(1)}%`}
              style={{ width: `${pct}%`, backgroundColor: CHANNEL_COLORS[s.key] }}
              className="transition-all flex items-center justify-center overflow-hidden"
            >
              {showPct && pct >= 15 && (
                <span className="text-[9px] font-bold text-white drop-shadow-sm leading-none">
                  {pct.toFixed(0)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
      {showPct && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
          {segments.map((s) => {
            const pct = (s.val / total) * 100;
            if (pct < 0.5) return null;
            return (
              <div key={s.key} className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHANNEL_COLORS[s.key] }} />
                <span className="text-[9px] text-muted-foreground">{CHANNEL_LABELS[s.key]}</span>
                <span className="text-[9px] font-medium">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance badge
// ---------------------------------------------------------------------------

function LaborBadge({ labor }: { labor: Restaurant["labor"] }) {
  if (labor.modelHours <= 0) return <span className="text-xs text-muted-foreground">--</span>;
  const pct = labor.variancePct;
  const color = pct <= 0 ? "text-green-500" : pct <= 10 ? "text-amber-500" : "text-red-500";
  return (
    <span className={`text-xs font-medium ${color}`} title={`${labor.actualHours.toFixed(0)}h / ${labor.modelHours.toFixed(0)}h model`}>
      {pct > 0 ? "+" : ""}{pct.toFixed(0)}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

type SortCol =
  | "name"
  | "sales"
  | "transactions"
  | "checkAverage"
  | "osat"
  | "osatSpeed"
  | "googleRating"
  | "speedAttainment"
  | "labor"
  | "yoy";

const NO_DATA = -Infinity;

function getSortValue(r: Restaurant, col: SortCol): number | string {
  switch (col) {
    case "name":
      return r.name.toLowerCase();
    case "sales":
      return r.sales.previous > 0 ? r.sales.pctChange : NO_DATA;
    case "transactions":
      return r.transactions.previous > 0 ? r.transactions.pctChange : NO_DATA;
    case "checkAverage":
      return r.checkAverage.previous > 0 ? r.checkAverage.pctChange : NO_DATA;
    case "osat":
      return r.osat.previous > 0 ? r.osat.pctChange : NO_DATA;
    case "osatSpeed":
      return r.osatSpeed.previous > 0 ? r.osatSpeed.pctChange : NO_DATA;
    case "googleRating":
      return r.googleRating.previous > 0 ? r.googleRating.pctChange : NO_DATA;
    case "speedAttainment":
      return r.speedAttainment.previous > 0 ? r.speedAttainment.pctChange : NO_DATA;
    case "labor":
      return r.labor.modelHours > 0 ? r.labor.variancePct : NO_DATA;
    case "yoy":
      return r.yoySales?.pctChange ?? NO_DATA;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ExecutiveSummary() {
  const [days, setDays] = useState<number>(7);
  const [marketFilter, setMarketFilter] = useState<string | null>(null);
  const [sortColumn, setSortColumn] = useState<SortCol>("sales");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery<ExecSummary>({
    queryKey: ["/api/executive-summary", days],
    queryFn: async () => {
      const res = await fetch(`/api/executive-summary?days=${days}`);
      if (!res.ok) throw new Error("Failed to fetch executive summary");
      return res.json();
    },
  });

  // Filtered restaurants
  const filteredRestaurants = useMemo(() => {
    if (!data) return [];
    let list = data.restaurants;
    if (marketFilter) {
      list = list.filter((r) => r.marketId === marketFilter);
    }
    const sorted = [...list].sort((a, b) => {
      const va = getSortValue(a, sortColumn);
      const vb = getSortValue(b, sortColumn);
      if (typeof va === "string" && typeof vb === "string") {
        return sortDirection === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      const na = va as number;
      const nb = vb as number;
      if (na === NO_DATA && nb === NO_DATA) return 0;
      if (na === NO_DATA) return 1;
      if (nb === NO_DATA) return -1;
      return sortDirection === "asc" ? na - nb : nb - na;
    });
    return sorted;
  }, [data, marketFilter, sortColumn, sortDirection]);

  // Filtered alerts/outperformers
  const filteredAlerts = useMemo(() => {
    if (!data) return [];
    let a = data.alerts;
    if (marketFilter) {
      const ids = new Set(data.restaurants.filter((r) => r.marketId === marketFilter).map((r) => r.id));
      a = a.filter((x) => ids.has(x.restaurantId));
    }
    const sev = { high: 0, medium: 1, low: 2 };
    return [...a].sort((x, y) => sev[x.severity] - sev[y.severity]);
  }, [data, marketFilter]);

  const filteredOutperformers = useMemo(() => {
    if (!data) return [];
    let o = data.outperformers;
    if (marketFilter) {
      const ids = new Set(data.restaurants.filter((r) => r.marketId === marketFilter).map((r) => r.id));
      o = o.filter((x) => ids.has(x.restaurantId));
    }
    return [...o].sort((a, b) => b.pctChange - a.pctChange);
  }, [data, marketFilter]);

  const filteredAnomalies = useMemo(() => {
    if (!data) return [];
    let a = data.anomalies;
    if (marketFilter) {
      const ids = new Set(data.restaurants.filter((r) => r.marketId === marketFilter).map((r) => r.id));
      a = a.filter((x) => ids.has(x.restaurantId));
    }
    return [...a].sort((x, y) => Math.abs(y.deviationPct) - Math.abs(x.deviationPct));
  }, [data, marketFilter]);

  // Aggregate channel mix
  const aggregateChannelMix = useMemo(() => {
    const restaurants = filteredRestaurants.length > 0 ? filteredRestaurants : data?.restaurants ?? [];
    const curr = { drive_thru: 0, dine_in: 0, app: 0, delivery_3pd: 0 };
    const prev = { drive_thru: 0, dine_in: 0, app: 0, delivery_3pd: 0 };
    for (const r of restaurants) {
      curr.drive_thru += r.channelMix.drive_thru;
      curr.dine_in += r.channelMix.dine_in;
      curr.app += r.channelMix.app;
      curr.delivery_3pd += r.channelMix.delivery_3pd;
      prev.drive_thru += r.prevChannelMix.drive_thru;
      prev.dine_in += r.prevChannelMix.dine_in;
      prev.app += r.prevChannelMix.app;
      prev.delivery_3pd += r.prevChannelMix.delivery_3pd;
    }
    const n = restaurants.length || 1;
    const currTotal = curr.drive_thru + curr.dine_in + curr.app + curr.delivery_3pd || 1;
    const prevTotal = prev.drive_thru + prev.dine_in + prev.app + prev.delivery_3pd || 1;
    return {
      current: {
        drive_thru: (curr.drive_thru / currTotal) * 100,
        dine_in: (curr.dine_in / currTotal) * 100,
        app: (curr.app / currTotal) * 100,
        delivery_3pd: (curr.delivery_3pd / currTotal) * 100,
      },
      previous: {
        drive_thru: (prev.drive_thru / prevTotal) * 100,
        dine_in: (prev.dine_in / prevTotal) * 100,
        app: (prev.app / prevTotal) * 100,
        delivery_3pd: (prev.delivery_3pd / prevTotal) * 100,
      },
    };
  }, [filteredRestaurants, data]);

  function toggleSort(col: SortCol) {
    if (sortColumn === col) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDirection("desc");
    }
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleMarket(id: string) {
    setExpandedMarkets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Restaurant lookup by id
  const restaurantMap = useMemo(() => {
    const map = new Map<string, Restaurant>();
    data?.restaurants.forEach((r) => map.set(r.id, r));
    return map;
  }, [data]);

  const selectedMarketRollup = useMemo(() => {
    if (!data || !marketFilter) return null;
    return data.marketRollups.find((m) => m.marketId === marketFilter) ?? null;
  }, [data, marketFilter]);

  // KPI card config
  const kpiConfig = [
    { key: "sales" as const, label: "Total Sales", icon: DollarSign, format: formatCurrency },
    { key: "transactions" as const, label: "Transactions", icon: Hash, format: formatNumber },
    { key: "checkAverage" as const, label: "Check Average", icon: Receipt, format: formatCurrency },
    { key: "osat" as const, label: "OSAT Score", icon: Star, format: formatPct },
    { key: "osatSpeed" as const, label: "OSAT Speed", icon: Gauge, format: formatPct },
    { key: "googleRating" as const, label: "Google Rating", icon: Globe, format: formatRating },
    { key: "speedAttainment" as const, label: "Speed of Service", icon: Timer, format: formatPct },
  ];

  // Column header helper
  function SortHeader({ col, label, tooltip }: { col: SortCol; label: string; tooltip?: string }) {
    const active = sortColumn === col;
    return (
      <button
        onClick={() => toggleSort(col)}
        title={tooltip}
        className={`flex items-center gap-0.5 text-[10px] uppercase tracking-wider font-semibold hover:text-foreground transition-colors ${
          active ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {label}
        {tooltip && <Info size={8} className="opacity-40 ml-0.5" />}
        {active ? (
          sortDirection === "asc" ? (
            <ArrowUpRight size={10} />
          ) : (
            <ArrowDownRight size={10} />
          )
        ) : (
          <ArrowUpDown size={10} className="opacity-40" />
        )}
      </button>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar />
      <div className="max-w-[1400px] mx-auto px-3 py-4 space-y-4">
        {/* ================================================================
            1. HEADER
        ================================================================ */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Executive Summary
            </h1>
            {data && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {data.dateRange.start} &mdash; {data.dateRange.end} &middot; vs prior{" "}
                {data.dateRange.days}d ({data.previousPeriod.start} &ndash;{" "}
                {data.previousPeriod.end})
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Period toggle */}
            <Tabs
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
            >
              <TabsList className="h-8">
                {[7, 14, 30, 90].map((d) => (
                  <TabsTrigger key={d} value={String(d)} className="text-xs px-2.5 h-6">
                    {d}d
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {/* Market filter */}
            <Select
              value={marketFilter ?? "__all__"}
              onValueChange={(v) => setMarketFilter(v === "__all__" ? null : v)}
            >
              <SelectTrigger className="h-8 text-xs w-[160px]">
                <SelectValue placeholder="All Markets" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Markets</SelectItem>
                {data?.marketRollups.map((m) => (
                  <SelectItem key={m.marketId} value={m.marketId}>
                    {m.marketName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading && <SkeletonCards />}

        {data && (
          <>
            {/* ================================================================
                2. PULSE — Company-Wide + Market (when filtered)
            ================================================================ */}
            {selectedMarketRollup ? (
              <section className="space-y-1" data-testid="pulse-comparison">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                      {selectedMarketRollup.marketName} Pulse
                      <span className="ml-1.5 text-[10px] font-normal normal-case opacity-60">
                        ({selectedMarketRollup.restaurantCount} units)
                      </span>
                    </h2>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {kpiConfig.map(({ key, label, icon: Icon, format }) => {
                        const mkt = selectedMarketRollup[key];
                        const co = data.companyPulse[key];
                        const diff = key === "sales" || key === "transactions"
                          ? null
                          : mkt.current - co.current;
                        return (
                          <Card key={key} className="relative overflow-hidden border-primary/30">
                            <CardContent className="p-3">
                              <div className="flex items-center justify-between mb-1">
                                <Icon className="h-4 w-4 text-muted-foreground" />
                                <TrendArrow value={mkt.pctChange} size="xs" />
                              </div>
                              <div className="text-lg font-bold leading-tight">
                                {format(mkt.current)}
                              </div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {label}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                prev: {format(mkt.previous)}
                              </div>
                              {diff !== null && (
                                <div className={`text-[10px] mt-0.5 ${diff > 0 ? "text-emerald-400" : diff < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                                  vs co: {diff > 0 ? "+" : ""}{diff.toFixed(1)}{key === "osat" || key === "osatSpeed" || key === "speedAttainment" ? "pp" : key === "checkAverage" ? "" : key === "googleRating" ? "" : ""}
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider opacity-60">
                      Company-Wide Pulse
                    </h2>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {kpiConfig.map(({ key, label, icon: Icon, format }) => {
                        const m = data.companyPulse[key];
                        return (
                          <Card key={key} className="relative overflow-hidden opacity-70">
                            <CardContent className="p-3">
                              <div className="flex items-center justify-between mb-1">
                                <Icon className="h-4 w-4 text-muted-foreground" />
                                <TrendArrow value={m.pctChange} size="xs" />
                              </div>
                              <div className="text-lg font-bold leading-tight">
                                {format(m.current)}
                              </div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {label}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                prev: {format(m.previous)}
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <section>
                <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                  Company-Wide Pulse
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                  {kpiConfig.map(({ key, label, icon: Icon, format }) => {
                    const m = data.companyPulse[key];
                    return (
                      <Card key={key} className="relative overflow-hidden">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between mb-1">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <TrendArrow value={m.pctChange} size="xs" />
                          </div>
                          <div className="text-lg font-bold leading-tight">
                            {format(m.current)}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {label}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            prev: {format(m.previous)}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ================================================================
                3. ATTENTION REQUIRED — grouped by metric family
            ================================================================ */}
            {filteredAlerts.length > 0 && (
              <section>
                <Card className="border-red-500/30">
                  <CardHeader className="py-2 px-4">
                    <CardTitle className="text-sm flex items-center gap-2 text-red-500">
                      <AlertTriangle className="h-4 w-4" />
                      Attention Required &mdash; Declining Trends
                      <Badge variant="destructive" className="ml-auto text-[10px] h-5">
                        {filteredAlerts.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3 pt-0 space-y-3">
                    {METRIC_GROUP_ORDER.map((groupKey) => {
                      const groupItems = filteredAlerts.filter((a) => metricGroup(a.metric) === groupKey);
                      if (groupItems.length === 0) return null;
                      return (
                        <div key={groupKey} data-testid={`alerts-group-${groupKey}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              {METRIC_GROUP_LABELS[groupKey]}
                            </span>
                            <span className="text-[10px] text-muted-foreground/70">
                              ({groupItems.length})
                            </span>
                            <div className="flex-1 h-px bg-border/50" />
                          </div>
                          <CollapsibleList
                            items={groupItems}
                            limit={5}
                            renderItem={(a, i) => (
                              <div
                                key={`${a.restaurantId}-${a.metric}-${i}`}
                                className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs"
                                data-testid={`alert-row-${a.restaurantId}-${a.metric}`}
                              >
                                <SeverityBadge severity={a.severity} />
                                <span className="font-medium truncate max-w-[180px]">
                                  {a.restaurant}
                                </span>
                                <span className="text-muted-foreground">{a.metricLabel}</span>
                                <span className="ml-auto tabular-nums text-muted-foreground">
                                  {formatMetricValue(a.metric, a.previous)}
                                </span>
                                <span className="text-muted-foreground">&rarr;</span>
                                <span className="tabular-nums font-medium">
                                  {formatMetricValue(a.metric, a.current)}
                                </span>
                                <span className="text-red-500 font-medium tabular-nums min-w-[50px] text-right">
                                  {formatChange(a.pctChange)}
                                </span>
                              </div>
                            )}
                          />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </section>
            )}

            {/* ================================================================
                4. OUTPERFORMERS — grouped by metric family
            ================================================================ */}
            {filteredOutperformers.length > 0 && (
              <section>
                <Card className="border-green-500/30">
                  <CardHeader className="py-2 px-4">
                    <CardTitle className="text-sm flex items-center gap-2 text-green-500">
                      <Trophy className="h-4 w-4" />
                      Outperformers &mdash; Rising Stars
                      <Badge className="ml-auto text-[10px] h-5 bg-green-500/15 text-green-500 border-green-500/30">
                        {filteredOutperformers.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3 pt-0 space-y-3">
                    {METRIC_GROUP_ORDER.map((groupKey) => {
                      const groupItems = filteredOutperformers.filter((o) => metricGroup(o.metric) === groupKey);
                      if (groupItems.length === 0) return null;
                      return (
                        <div key={groupKey} data-testid={`outperformers-group-${groupKey}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              {METRIC_GROUP_LABELS[groupKey]}
                            </span>
                            <span className="text-[10px] text-muted-foreground/70">
                              ({groupItems.length})
                            </span>
                            <div className="flex-1 h-px bg-border/50" />
                          </div>
                          <CollapsibleList
                            items={groupItems}
                            limit={5}
                            renderItem={(o, i) => (
                              <div
                                key={`${o.restaurantId}-${o.metric}-${i}`}
                                className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs"
                                data-testid={`outperformer-row-${o.restaurantId}-${o.metric}`}
                              >
                                <span className="font-medium truncate max-w-[180px]">
                                  {o.restaurant}
                                </span>
                                <span className="text-muted-foreground">{o.metricLabel}</span>
                                <span className="ml-auto tabular-nums text-muted-foreground">
                                  {formatMetricValue(o.metric, o.previous)}
                                </span>
                                <span className="text-muted-foreground">&rarr;</span>
                                <span className="tabular-nums font-medium">
                                  {formatMetricValue(o.metric, o.current)}
                                </span>
                                <span className="text-green-500 font-medium tabular-nums min-w-[50px] text-right">
                                  {formatChange(o.pctChange)}
                                </span>
                              </div>
                            )}
                          />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </section>
            )}

            {/* ================================================================
                5. NOTABLE DAYS (ANOMALIES)
            ================================================================ */}
            {filteredAnomalies.length > 0 && (
              <section>
                <Card className="border-amber-500/30">
                  <CardHeader className="py-2 px-4">
                    <CardTitle className="text-sm flex items-center gap-2 text-amber-500">
                      <Zap className="h-4 w-4" />
                      Notable Days &mdash; Anomalies
                      <Badge className="ml-auto text-[10px] h-5 bg-amber-500/15 text-amber-500 border-amber-500/30">
                        {filteredAnomalies.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3 pt-0">
                    <CollapsibleList
                      items={filteredAnomalies}
                      limit={5}
                      renderItem={(a, i) => (
                        <div
                          key={`${a.restaurantId}-${a.date}-${a.metric}-${i}`}
                          className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs"
                        >
                          <span className="font-medium truncate max-w-[120px]">
                            {a.restaurant}
                          </span>
                          <span className="text-muted-foreground">{a.date}</span>
                          <span className="text-muted-foreground">{a.metricLabel}</span>
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1 py-0 ${
                              a.direction === "spike"
                                ? "border-green-500/40 text-green-500"
                                : "border-red-500/40 text-red-500"
                            }`}
                          >
                            {a.direction === "spike" ? "Spike" : "Drop"}
                          </Badge>
                          <span className="ml-auto tabular-nums">
                            {formatMetricValue(a.metric, a.value)}
                          </span>
                          <span className="text-muted-foreground text-[10px]">
                            avg {formatMetricValue(a.metric, a.avgValue)}
                          </span>
                          <span
                            className={`font-medium tabular-nums min-w-[50px] text-right ${
                              a.direction === "spike" ? "text-green-500" : "text-red-500"
                            }`}
                          >
                            {a.deviationPct > 0 ? "+" : ""}
                            {a.deviationPct.toFixed(1)}%
                          </span>
                        </div>
                      )}
                    />
                  </CardContent>
                </Card>
              </section>
            )}

            {/* ================================================================
                6. RESTAURANT TREND TABLE
            ================================================================ */}
            <section>
              <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                Restaurant Performance
              </h2>
              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-3 sticky left-0 bg-card z-10">
                          <SortHeader col="name" label="Restaurant" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="sales" label="Sales" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="transactions" label="Txn" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="checkAverage" label="Check" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="osat" label="OSAT" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="osatSpeed" label="OSAT Spd" tooltip="OSAT Speed: 5-star top-box % on the speed-of-service question (drive-thru, or generic for store 1682)." />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="googleRating" label="Google" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="speedAttainment" label="Speed" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="labor" label="Labor" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="yoy" label="YoY" tooltip="Year-over-Year: compares sales from the selected period to the same days of the week one year ago. A negative % means lower sales than last year." />
                        </th>
                        <th className="w-6" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRestaurants.map((r) => {
                        const isExpanded = expandedRows.has(r.id);
                        return (
                          <Collapsible key={r.id} open={isExpanded} asChild>
                            <>
                              <tr
                                className="border-b border-border/40 hover:bg-muted/30 cursor-pointer transition-colors"
                                onClick={() => toggleRow(r.id)}
                              >
                                <td className="py-1.5 px-3 sticky left-0 bg-card z-10">
                                  <div className="flex items-center gap-1">
                                    <ChevronRight
                                      className={`h-3 w-3 transition-transform ${
                                        isExpanded ? "rotate-90" : ""
                                      }`}
                                    />
                                    <span className="font-medium truncate max-w-[130px]">
                                      {r.name}
                                    </span>
                                    <MarketBadge name={r.marketName} />
                                  </div>
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.sales.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.transactions.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.checkAverage.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.osat.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.osatSpeed.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.googleRating.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.speedAttainment.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <LaborBadge labor={r.labor} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  {r.yoySales ? (
                                    <TrendArrow value={r.yoySales.pctChange} />
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="w-6" />
                              </tr>
                              <CollapsibleContent asChild>
                                <tr>
                                  <td colSpan={11} className="bg-muted/20 p-0">
                                    <div className="sticky left-0 w-screen max-w-full px-4 py-3">
                                    <div className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wider">{r.name}</div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                      {/* Raw metric values */}
                                      <div>
                                        <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
                                          Metric Details
                                        </div>
                                        <div className="space-y-1">
                                          {(
                                            [
                                              ["Sales", r.sales, formatCurrency],
                                              ["Transactions", r.transactions, formatNumber],
                                              ["Check Avg", r.checkAverage, formatCurrency],
                                              ["OSAT", r.osat, formatPct],
                                              ["OSAT Speed", r.osatSpeed, formatPct],
                                              ["Google", r.googleRating, formatRating],
                                              ["Speed", r.speedAttainment, formatPct],
                                            ] as [string, MetricPair, (v: number) => string][]
                                          ).map(([label, metric, fmt]) => (
                                            <div key={label} className="flex justify-between">
                                              <span className="text-muted-foreground">{label}</span>
                                              <span>
                                                {fmt(metric.current)}{" "}
                                                <span className="text-muted-foreground">
                                                  (prev: {fmt(metric.previous)})
                                                </span>
                                              </span>
                                            </div>
                                          ))}
                                          <div className="flex justify-between">
                                            <span className="text-muted-foreground">Labor</span>
                                            <span>
                                              {r.labor.actualHours.toFixed(1)}h / {r.labor.modelHours.toFixed(1)}h model{" "}
                                              <span className={r.labor.variance <= 0 ? "text-green-500" : "text-red-500"}>
                                                ({r.labor.variance > 0 ? "+" : ""}{r.labor.variance.toFixed(1)}h)
                                              </span>
                                            </span>
                                          </div>
                                          {r.yoySales && (
                                            <div className="flex justify-between">
                                              <span className="text-muted-foreground">YoY Sales</span>
                                              <span>
                                                {formatCurrency(r.sales.current)}{" "}
                                                <span className="text-muted-foreground">
                                                  (LY: {formatCurrency(r.yoySales.lastYear)})
                                                </span>{" "}
                                                <span className={r.yoySales.pctChange >= 0 ? "text-green-500" : "text-red-500"}>
                                                  {r.yoySales.pctChange > 0 ? "+" : ""}{r.yoySales.pctChange.toFixed(1)}%
                                                </span>
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                      </div>

                                      {/* Channel Mix */}
                                      <div>
                                        <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
                                          Channel Mix (Current vs Previous)
                                        </div>
                                        <div className="space-y-1.5">
                                          <div className="text-[10px] text-muted-foreground">Current</div>
                                          <ChannelBar mix={r.channelMix} />
                                          <div className="text-[10px] text-muted-foreground">Previous</div>
                                          <ChannelBar mix={r.prevChannelMix} />
                                          <div className="flex gap-3 mt-1 flex-wrap">
                                            {Object.entries(CHANNEL_LABELS).map(([k, label]) => (
                                              <div key={k} className="flex items-center gap-1">
                                                <div
                                                  className="w-2 h-2 rounded-sm"
                                                  style={{ backgroundColor: CHANNEL_COLORS[k] }}
                                                />
                                                <span className="text-[10px] text-muted-foreground">
                                                  {label}
                                                </span>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>

                                    </div>
                                    </div>
                                  </td>
                                </tr>
                              </CollapsibleContent>
                            </>
                          </Collapsible>
                        );
                      })}
                      {filteredRestaurants.length === 0 && (
                        <tr>
                          <td colSpan={11} className="text-center py-8 text-muted-foreground">
                            No restaurants found for selected filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>

            {/* ================================================================
                7. MARKET ROLLUPS
            ================================================================ */}
            {data.marketRollups.length > 0 && !marketFilter && (
              <section>
                <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                  Market Rollups
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {data.marketRollups.map((m) => {
                    const isExpanded = expandedMarkets.has(m.marketId);
                    const marketRestaurants = data.restaurants.filter(
                      (r) => r.marketId === m.marketId
                    );
                    return (
                      <Card key={m.marketId}>
                        <Collapsible
                          open={isExpanded}
                          onOpenChange={() => toggleMarket(m.marketId)}
                        >
                          <CollapsibleTrigger asChild>
                            <CardHeader className="py-2 px-3 cursor-pointer hover:bg-muted/30 transition-colors">
                              <CardTitle className="text-sm flex items-center justify-between">
                                <span className="flex items-center gap-1.5">
                                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                  {m.marketName}
                                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                    {m.restaurantCount}
                                  </Badge>
                                </span>
                                <ChevronDown
                                  className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                                    isExpanded ? "rotate-180" : ""
                                  }`}
                                />
                              </CardTitle>
                            </CardHeader>
                          </CollapsibleTrigger>
                          <CardContent className="px-3 pb-3 pt-0">
                            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
                              {kpiConfig.map(({ key, label, format }) => {
                                const metric = m[key];
                                return (
                                  <div key={key}>
                                    <div className="text-[10px] text-muted-foreground">
                                      {label}
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs font-medium">
                                        {format(metric.current)}
                                      </span>
                                      <TrendArrow
                                        value={metric.pctChange}
                                        size="xs"
                                        showValue={false}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            <CollapsibleContent>
                              <div className="mt-3 pt-2 border-t border-border/50 space-y-1">
                                <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">
                                  Restaurants
                                </div>
                                {marketRestaurants.map((r) => (
                                  <div
                                    key={r.id}
                                    className="flex items-center justify-between text-xs py-0.5"
                                  >
                                    <span className="truncate max-w-[120px]">{r.name}</span>
                                    <div className="flex items-center gap-2">
                                      <span className="tabular-nums text-muted-foreground">
                                        {formatCurrency(r.sales.current)}
                                      </span>
                                      <TrendArrow
                                        value={r.sales.pctChange}
                                        size="xs"
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </CollapsibleContent>
                          </CardContent>
                        </Collapsible>
                      </Card>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ================================================================
                8. CHANNEL PERFORMANCE SUMMARY
            ================================================================ */}
            <section>
              <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                Channel Performance
              </h2>
              <Card>
                <CardContent className="p-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Bar chart */}
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">
                        Channel Mix — Current Period
                      </div>
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart
                          data={Object.entries(CHANNEL_LABELS).map(([k, label]) => ({
                            name: label,
                            current: aggregateChannelMix.current[k as keyof typeof aggregateChannelMix.current],
                            previous: aggregateChannelMix.previous[k as keyof typeof aggregateChannelMix.previous],
                            color: CHANNEL_COLORS[k],
                          }))}
                          layout="vertical"
                          margin={{ left: 70, right: 10, top: 5, bottom: 5 }}
                        >
                          <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} />
                          <YAxis
                            type="category"
                            dataKey="name"
                            tick={{ fontSize: 10 }}
                            width={65}
                          />
                          <RechartsTooltip
                            formatter={(val: number) => `${val.toFixed(1)}%`}
                            contentStyle={{
                              fontSize: 11,
                              backgroundColor: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: 6,
                            }}
                          />
                          <Bar dataKey="current" radius={[0, 4, 4, 0]} barSize={16}>
                            {Object.keys(CHANNEL_LABELS).map((k) => (
                              <Cell key={k} fill={CHANNEL_COLORS[k]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Shift table */}
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">
                        Period-over-Period Shift
                      </div>
                      <div className="space-y-2">
                        {Object.entries(CHANNEL_LABELS).map(([k, label]) => {
                          const curr =
                            aggregateChannelMix.current[
                              k as keyof typeof aggregateChannelMix.current
                            ];
                          const prev =
                            aggregateChannelMix.previous[
                              k as keyof typeof aggregateChannelMix.previous
                            ];
                          const shift = curr - prev;
                          return (
                            <div key={k} className="flex items-center gap-2 text-xs">
                              <div
                                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                                style={{ backgroundColor: CHANNEL_COLORS[k] }}
                              />
                              <span className="w-24 truncate">{label}</span>
                              <span className="tabular-nums font-medium w-12 text-right">
                                {curr.toFixed(1)}%
                              </span>
                              <span className="text-muted-foreground text-[10px] w-12 text-right">
                                was {prev.toFixed(1)}%
                              </span>
                              <span
                                className={`tabular-nums font-medium w-14 text-right ${
                                  Math.abs(shift) < 0.1
                                    ? "text-muted-foreground"
                                    : shift > 0
                                    ? "text-green-500"
                                    : "text-red-500"
                                }`}
                              >
                                {shift > 0 ? "+" : ""}
                                {shift.toFixed(1)}pp
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </section>

            {/* ================================================================
                9. SURVEY CAPTURE & OSAT BY DAY/DAYPART (anti-gaming)
            ================================================================ */}
            <SurveyCaptureSection days={days} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Survey Capture & OSAT by day/daypart
// ---------------------------------------------------------------------------

type SurveyCaptureBucket = {
  responses: number;
  transactions: number;
  surveysPer1000: number | null;
  osatPct: number | null;
};

type SurveyCaptureResp = {
  dateRange: { start: string; end: string; days: number };
  thresholds: { healthyMin: number; warningMin: number };
  company: SurveyCaptureBucket;
  byDayOfWeek: (SurveyCaptureBucket & { dow: number; label: string })[];
  byDaypart: (SurveyCaptureBucket & {
    id: string;
    label: string;
    shortLabel: string;
    startHour: number;
    endHour: number;
  })[];
  byRestaurant: (SurveyCaptureBucket & {
    id: string;
    name: string;
    unitNumber: string | null;
    marketId: string | null;
    marketName: string | null;
  })[];
};

function captureColor(rate: number | null, healthyMin: number, warningMin: number): string {
  if (rate === null) return "text-muted-foreground";
  if (rate >= healthyMin) return "text-green-600 dark:text-green-400";
  if (rate >= warningMin) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function captureBg(rate: number | null, healthyMin: number, warningMin: number): string {
  if (rate === null) return "bg-muted/30";
  if (rate >= healthyMin) return "bg-green-500/10";
  if (rate >= warningMin) return "bg-amber-500/10";
  return "bg-red-500/15";
}

function fmtRate(rate: number | null): string {
  if (rate === null) return "—";
  return rate.toFixed(2);
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1)}%`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function SurveyCaptureSection({ days }: { days: number }) {
  const { data, isLoading } = useQuery<SurveyCaptureResp>({
    queryKey: ["/api/executive-summary/survey-capture", days],
    queryFn: async () => {
      const res = await fetch(`/api/executive-summary/survey-capture?days=${days}`);
      if (!res.ok) throw new Error("Failed to fetch survey capture");
      return res.json();
    },
  });

  const [sortKey, setSortKey] = useState<"capture" | "osat" | "txns" | "name">("capture");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sortedRestaurants = useMemo(() => {
    if (!data) return [];
    const arr = [...data.byRestaurant];
    arr.sort((a, b) => {
      const get = (r: typeof arr[0]) => {
        if (sortKey === "name") return r.name.toLowerCase();
        if (sortKey === "txns") return r.transactions;
        if (sortKey === "osat") return r.osatPct ?? -1;
        return r.surveysPer1000 ?? -1;
      };
      const va = get(a);
      const vb = get(b);
      if (typeof va === "string" && typeof vb === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === "asc"
        ? (va as number) - (vb as number)
        : (vb as number) - (va as number);
    });
    return arr;
  }, [data, sortKey, sortDir]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : key === "capture" ? "asc" : "desc");
    }
  }

  if (isLoading || !data) {
    return (
      <section data-testid="section-survey-capture">
        <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
          Survey Capture & OSAT by Day / Daypart
        </h2>
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground">
            Loading survey capture analysis…
          </CardContent>
        </Card>
      </section>
    );
  }

  const { company, byDayOfWeek, byDaypart, thresholds } = data;
  const flagged = sortedRestaurants.filter(
    (r) => r.surveysPer1000 !== null && r.surveysPer1000 < thresholds.warningMin && r.transactions >= 200,
  );

  return (
    <section data-testid="section-survey-capture">
      <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
        Survey Capture & OSAT by Day / Daypart
      </h2>

      {/* Company-level summary */}
      <Card className="mb-3">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Info className="h-3 w-3" />
                Detects units that may not be asking guests to take the survey.
                Industry-healthy capture is ≥{thresholds.healthyMin} surveys per 1,000 transactions.
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-md border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Surveys / 1,000 Txns
              </div>
              <div
                className={`text-2xl font-semibold tabular-nums ${captureColor(company.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                data-testid="text-company-capture-rate"
              >
                {fmtRate(company.surveysPer1000)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                OSAT (5-star %)
              </div>
              <div className="text-2xl font-semibold tabular-nums" data-testid="text-company-osat">
                {fmtPct(company.osatPct)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Surveys
              </div>
              <div className="text-2xl font-semibold tabular-nums" data-testid="text-company-responses">
                {fmtInt(company.responses)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Transactions
              </div>
              <div className="text-2xl font-semibold tabular-nums" data-testid="text-company-txns">
                {fmtInt(company.transactions)}
              </div>
            </div>
          </div>

          {flagged.length > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs">
              <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-red-600 dark:text-red-400">
                  {flagged.length} unit{flagged.length === 1 ? "" : "s"} below {thresholds.warningMin}/1,000
                </span>
                <span className="text-muted-foreground"> — possible survey-ask gaming. Review highlighted rows below.</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Day of Week + Daypart grids */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        {/* Day of Week */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm">By Day of Week</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left py-1.5 px-2 font-medium">Day</th>
                    <th className="text-right py-1.5 px-2 font-medium">Txns</th>
                    <th className="text-right py-1.5 px-2 font-medium">Surveys</th>
                    <th className="text-right py-1.5 px-2 font-medium">/1k</th>
                    <th className="text-right py-1.5 px-2 font-medium">OSAT</th>
                  </tr>
                </thead>
                <tbody>
                  {byDayOfWeek.map((d) => (
                    <tr
                      key={d.dow}
                      className={`border-b last:border-0 ${captureBg(d.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                      data-testid={`row-dow-${d.dow}`}
                    >
                      <td className="py-1.5 px-2 font-medium">{d.label}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(d.transactions)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(d.responses)}</td>
                      <td
                        className={`py-1.5 px-2 text-right tabular-nums font-semibold ${captureColor(d.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                      >
                        {fmtRate(d.surveysPer1000)}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtPct(d.osatPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Daypart */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm">By Daypart</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left py-1.5 px-2 font-medium">Daypart</th>
                    <th className="text-right py-1.5 px-2 font-medium">Txns</th>
                    <th className="text-right py-1.5 px-2 font-medium">Surveys</th>
                    <th className="text-right py-1.5 px-2 font-medium">/1k</th>
                    <th className="text-right py-1.5 px-2 font-medium">OSAT</th>
                  </tr>
                </thead>
                <tbody>
                  {byDaypart.map((dp) => (
                    <tr
                      key={dp.id}
                      className={`border-b last:border-0 ${captureBg(dp.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                      data-testid={`row-daypart-${dp.id}`}
                    >
                      <td className="py-1.5 px-2">
                        <div className="font-medium">{dp.label}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {dp.startHour}–{dp.endHour + 1}h
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(dp.transactions)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(dp.responses)}</td>
                      <td
                        className={`py-1.5 px-2 text-right tabular-nums font-semibold ${captureColor(dp.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                      >
                        {fmtRate(dp.surveysPer1000)}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtPct(dp.osatPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-restaurant breakdown */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>By Restaurant</span>
            <span className="text-[10px] font-normal text-muted-foreground">
              Sorted by capture rate (lowest first) — gaming risk at top
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left py-1.5 px-2 font-medium">
                    <button
                      onClick={() => toggleSort("name")}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      data-testid="button-sort-name"
                    >
                      Unit <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="text-left py-1.5 px-2 font-medium">Market</th>
                  <th className="text-right py-1.5 px-2 font-medium">
                    <button
                      onClick={() => toggleSort("txns")}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      data-testid="button-sort-txns"
                    >
                      Txns <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="text-right py-1.5 px-2 font-medium">Surveys</th>
                  <th className="text-right py-1.5 px-2 font-medium">
                    <button
                      onClick={() => toggleSort("capture")}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      data-testid="button-sort-capture"
                    >
                      /1,000 <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="text-right py-1.5 px-2 font-medium">
                    <button
                      onClick={() => toggleSort("osat")}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      data-testid="button-sort-osat"
                    >
                      OSAT <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRestaurants.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b last:border-0 ${captureBg(r.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                    data-testid={`row-survey-capture-${r.id}`}
                  >
                    <td className="py-1.5 px-2">
                      <div className="font-medium">
                        {r.unitNumber ? `#${r.unitNumber} ` : ""}
                        {r.name}
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-muted-foreground">{r.marketName ?? "—"}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(r.transactions)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(r.responses)}</td>
                    <td
                      className={`py-1.5 px-2 text-right tabular-nums font-semibold ${captureColor(r.surveysPer1000, thresholds.healthyMin, thresholds.warningMin)}`}
                    >
                      {fmtRate(r.surveysPer1000)}
                      {r.surveysPer1000 !== null &&
                        r.surveysPer1000 < thresholds.warningMin &&
                        r.transactions >= 200 && (
                          <Badge variant="destructive" className="ml-1.5 text-[9px] py-0 px-1.5 h-4">
                            LOW
                          </Badge>
                        )}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmtPct(r.osatPct)}</td>
                  </tr>
                ))}
                {sortedRestaurants.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      No data in selected window
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
