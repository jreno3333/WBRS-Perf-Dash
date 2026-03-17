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
import { scoreToGradeLabel, getGradeColor } from "@/lib/grading";
import { Link } from "wouter";
import {
  BarChart3,
  DollarSign,
  Hash,
  Receipt,
  Star,
  Globe,
  Timer,
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
  googleRating: MetricPair;
  speedAttainment: MetricPair;
  staffing: { compliancePct: number; managerCoveragePct: number };
  channelMix: { drive_thru: number; dine_in: number; app: number; delivery_3pd: number };
  prevChannelMix: { drive_thru: number; dine_in: number; app: number; delivery_3pd: number };
  attachmentScore: number | null;
  attachmentCategories: Record<string, { rate: number; benchmark: number; vsTarget: number }> | null;
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
  if (metric === "osat" || metric === "speedAttainment") return formatPct(val);
  if (metric === "googleRating") return formatRating(val);
  if (metric === "transactions") return formatNumber(val);
  return val.toFixed(1);
}

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
  const total = mix.drive_thru + mix.dine_in + mix.app + mix.delivery_3pd;
  if (total === 0) return <div className="text-[10px] text-muted-foreground">No data</div>;

  const segments = [
    { key: "drive_thru", val: mix.drive_thru },
    { key: "dine_in", val: mix.dine_in },
    { key: "app", val: mix.app },
    { key: "delivery_3pd", val: mix.delivery_3pd },
  ];

  return (
    <div className="flex rounded overflow-hidden" style={{ height }}>
      {segments.map((s) => {
        const pct = (s.val / total) * 100;
        if (pct < 0.5) return null;
        return (
          <div
            key={s.key}
            title={`${CHANNEL_LABELS[s.key]}: ${pct.toFixed(1)}%`}
            style={{ width: `${pct}%`, backgroundColor: CHANNEL_COLORS[s.key] }}
            className="transition-all"
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance badge
// ---------------------------------------------------------------------------

function ComplianceBadge({ pct }: { pct: number }) {
  const color =
    pct >= 90 ? "text-green-500" : pct >= 80 ? "text-amber-500" : "text-red-500";
  return <span className={`text-xs font-medium ${color}`}>{pct.toFixed(0)}%</span>;
}

// ---------------------------------------------------------------------------
// Attach score badge — uses same A-F grade color scale as rankings page
// ---------------------------------------------------------------------------

function AttachBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">--</span>;
  const grade = scoreToGradeLabel(score);
  const color = getGradeColor(grade);
  return <span className={`text-xs font-medium ${color}`}>{score.toFixed(0)}%</span>;
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
  | "googleRating"
  | "speedAttainment"
  | "staffing"
  | "attach"
  | "yoy";

const NO_DATA = -Infinity;

function getSortValue(r: Restaurant, col: SortCol): number | string {
  switch (col) {
    case "name":
      return r.name.toLowerCase();
    case "sales":
      return r.sales.current || NO_DATA;
    case "transactions":
      return r.transactions.current || NO_DATA;
    case "checkAverage":
      return r.checkAverage.current || NO_DATA;
    case "osat":
      return r.osat.current || NO_DATA;
    case "googleRating":
      return r.googleRating.current || NO_DATA;
    case "speedAttainment":
      return r.speedAttainment.current || NO_DATA;
    case "staffing":
      return r.staffing.compliancePct;
    case "attach":
      return r.attachmentScore ?? NO_DATA;
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

  // KPI card config
  const kpiConfig = [
    { key: "sales" as const, label: "Total Sales", icon: DollarSign, format: formatCurrency },
    { key: "transactions" as const, label: "Transactions", icon: Hash, format: formatNumber },
    { key: "checkAverage" as const, label: "Check Average", icon: Receipt, format: formatCurrency },
    { key: "osat" as const, label: "OSAT Score", icon: Star, format: formatPct },
    { key: "googleRating" as const, label: "Google Rating", icon: Globe, format: formatRating },
    { key: "speedAttainment" as const, label: "Speed of Service", icon: Timer, format: formatPct },
  ];

  // Column header helper
  function SortHeader({ col, label }: { col: SortCol; label: string }) {
    const active = sortColumn === col;
    return (
      <button
        onClick={() => toggleSort(col)}
        className={`flex items-center gap-0.5 text-[10px] uppercase tracking-wider font-semibold hover:text-foreground transition-colors ${
          active ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {label}
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
                2. COMPANY-WIDE PULSE
            ================================================================ */}
            <section>
              <h2 className="text-sm font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                Company-Wide Pulse
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
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

            {/* ================================================================
                3. ATTENTION REQUIRED
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
                  <CardContent className="px-4 pb-3 pt-0">
                    <CollapsibleList
                      items={filteredAlerts}
                      limit={5}
                      renderItem={(a, i) => {
                        const r = restaurantMap.get(a.restaurantId);
                        return (
                          <div
                            key={`${a.restaurantId}-${a.metric}-${i}`}
                            className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs"
                          >
                            <SeverityBadge severity={a.severity} />
                            <span className="font-medium truncate max-w-[140px]">
                              {a.restaurant}
                            </span>
                            <MarketBadge name={r?.marketName ?? null} />
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
                        );
                      }}
                    />
                  </CardContent>
                </Card>
              </section>
            )}

            {/* ================================================================
                4. OUTPERFORMERS
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
                  <CardContent className="px-4 pb-3 pt-0">
                    <CollapsibleList
                      items={filteredOutperformers}
                      limit={5}
                      renderItem={(o, i) => {
                        const r = restaurantMap.get(o.restaurantId);
                        return (
                          <div
                            key={`${o.restaurantId}-${o.metric}-${i}`}
                            className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs"
                          >
                            <span className="font-medium truncate max-w-[140px]">
                              {o.restaurant}
                            </span>
                            <MarketBadge name={r?.marketName ?? null} />
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
                        );
                      }}
                    />
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
                          <SortHeader col="googleRating" label="Google" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="speedAttainment" label="Speed" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="staffing" label="Staff%" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="attach" label="Attach" />
                        </th>
                        <th className="text-right py-2 px-2">
                          <SortHeader col="yoy" label="YoY" />
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
                                  <TrendArrow value={r.googleRating.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <TrendArrow value={r.speedAttainment.pctChange} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <ComplianceBadge pct={r.staffing.compliancePct} />
                                </td>
                                <td className="text-right py-1.5 px-2">
                                  <AttachBadge score={r.attachmentScore} />
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
                                  <td colSpan={11} className="bg-muted/20 px-6 py-3">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
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
                                            <span className="text-muted-foreground">Mgr Coverage</span>
                                            <span>{r.staffing.managerCoveragePct.toFixed(0)}%</span>
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

                                      {/* Attachment categories */}
                                      <div>
                                        <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
                                          Attachment Rates
                                        </div>
                                        {r.attachmentCategories ? (
                                          <div className="space-y-1">
                                            {Object.entries(r.attachmentCategories).map(
                                              ([cat, vals]) => (
                                                <div key={cat} className="flex justify-between">
                                                  <span className="text-muted-foreground truncate max-w-[100px]">
                                                    {cat}
                                                  </span>
                                                  <span>
                                                    {vals.rate.toFixed(1)}%{" "}
                                                    <span
                                                      className={
                                                        vals.vsTarget >= 0
                                                          ? "text-green-500"
                                                          : "text-red-500"
                                                      }
                                                    >
                                                      ({vals.vsTarget > 0 ? "+" : ""}
                                                      {vals.vsTarget.toFixed(1)}% vs target)
                                                    </span>
                                                  </span>
                                                </div>
                                              )
                                            )}
                                          </div>
                                        ) : (
                                          <span className="text-muted-foreground">No data</span>
                                        )}
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
                          <td colSpan={10} className="text-center py-8 text-muted-foreground">
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
          </>
        )}
      </div>
    </div>
  );
}
