import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NavBar } from "@/components/nav-bar";
import { Link } from "wouter";
import {
  Brain,
  DollarSign,
  Star,
  UtensilsCrossed,
  Smartphone,
  Megaphone,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Trophy,
  BarChart3,
  Hash,
  Calendar,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Search,
  SendHorizontal,
  Sparkles,
  X,
  MessageSquare,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface HighSalesRestaurant {
  restaurant: string;
  hoursOver2k: number;
  avgSalesPerHour: number;
  peakSales: number;
  peakHour: number;
  peakDate: string;
}

interface OsatLeader {
  rank: number;
  restaurant: string;
  avgOsat: number;
  totalResponses: number;
  totalFiveStar: number;
  daysWithData: number;
}

interface DineInChange {
  restaurant: string;
  currentPct: number;
  previousPct: number;
  change: number;
}

interface AppPercentage {
  restaurant: string;
  percentage: number;
  orders: number;
  totalOrders: number;
}

interface OOTData {
  restaurant: string;
  totalOrders: number;
  hoursUsed: number;
  daysUsed: number;
  ranOOT: boolean;
}

interface AttachmentTrend {
  thisWeek: { orders: number; avgCheck: number; totalSales: number };
  lastWeek: { orders: number; avgCheck: number; totalSales: number };
  checkAvgChange: number;
  orderCountChange: number;
}

interface AnalysisData {
  dateRange: { start: string; end: string; days: number };
  previousPeriod: { start: string; end: string };
  insights: {
    highSalesHours: { totalHours: number; byRestaurant: HighSalesRestaurant[] };
    osatLeaders: OsatLeader[];
    dineInChange: DineInChange[];
    appPercentages: AppPercentage[];
    outsideOrderTakers: OOTData[];
    attachmentTrend: AttachmentTrend;
  };
}

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${parseInt(month)}/${parseInt(day)}`;
}

function ChangeIndicator({ value, suffix = "%" }: { value: number; suffix?: string }) {
  if (value > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-green-500 font-semibold">
        <ArrowUpRight className="w-3.5 h-3.5" />
        +{value}{suffix}
      </span>
    );
  }
  if (value < 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-500 font-semibold">
        <ArrowDownRight className="w-3.5 h-3.5" />
        {value}{suffix}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-muted-foreground font-semibold">
      <Minus className="w-3.5 h-3.5" />
      0{suffix}
    </span>
  );
}

// Insight card component
function InsightCard({
  icon: Icon,
  title,
  question,
  children,
  defaultOpen = false,
  accentColor = "text-primary",
  bgColor = "bg-primary/10",
}: {
  icon: any;
  title: string;
  question: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  accentColor?: string;
  bgColor?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="overflow-hidden">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${bgColor}`}>
                  <Icon className={`w-5 h-5 ${accentColor}`} />
                </div>
                <div>
                  <CardTitle className="text-base">{title}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-0.5">{question}</p>
                </div>
              </div>
              {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// ---- Dynamic Query Types ----
interface QueryColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
}

interface QueryResultData {
  title: string;
  summary: string;
  columns: QueryColumn[];
  rows: Record<string, any>[];
  highlight?: { label: string; value: string; detail?: string };
}

interface DynamicQueryResponse {
  matched: boolean;
  question: string;
  templateId?: string;
  dateRange?: { start: string; end: string; days: number };
  result?: QueryResultData;
  suggestion?: string;
  availableTopics?: string[];
}

const SUGGESTED_QUESTIONS = [
  "What are the top selling items?",
  "Show product mix change week over week",
  "What are the attachment/upsell rates?",
  "Show order channel mix breakdown",
  "What is the app order percentage?",
  "What are the 3PD delivery percentages?",
  "Which unit has the highest OSAT score?",
  "Show me labor percent by unit",
  "What is the drive-thru speed ranking?",
  "Show check average by unit",
  "Which units ran outside order takers?",
  "Show me dine-in percentage by unit",
  "Show product category breakdown",
  "What are the daily sales by unit?",
  "Hours over $3000",
  "Show sales by hour",
];

// Dynamic query result display
function DynamicQueryResult({ data, onClear }: { data: DynamicQueryResponse; onClear: () => void }) {
  if (!data.matched) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <MessageSquare className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-semibold">No exact match found</span>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{data.suggestion}</p>
              {data.availableTopics && (
                <div className="flex flex-wrap gap-1.5">
                  {data.availableTopics.map((t, i) => (
                    <Badge key={i} variant="outline" className="text-xs">{t}</Badge>
                  ))}
                </div>
              )}
            </div>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onClear}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const result = data.result!;
  return (
    <Card className="border-primary/30 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Sparkles className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{result.title}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {data.dateRange && `${formatDate(data.dateRange.start)} – ${formatDate(data.dateRange.end)} (${data.dateRange.days}d)`}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={onClear}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-sm text-muted-foreground">{result.summary}</p>

        {result.highlight && (
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{result.highlight.label}</p>
                  <p className="font-semibold">{result.highlight.value}</p>
                </div>
                {result.highlight.detail && (
                  <span className="text-lg font-bold text-primary">{result.highlight.detail}</span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {result.rows.length > 0 ? (
          <div className="rounded-lg border overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50">
                  {result.columns.map((col) => (
                    <th
                      key={col.key}
                      className={`px-3 py-2 font-medium whitespace-nowrap ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-t hover:bg-muted/30">
                    {result.columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-3 py-2 whitespace-nowrap ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"} ${col.key === "unit" || col.key === "restaurant" ? "font-medium" : ""}`}
                      >
                        {row[col.key] ?? "-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No data found for this query.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AiAnalysisPage() {
  const [days, setDays] = useState("7");
  const [question, setQuestion] = useState("");
  const [queryResults, setQueryResults] = useState<DynamicQueryResponse[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const queryMutation = useMutation({
    mutationFn: async (q: string) => {
      const res = await fetch("/api/ai-analysis/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, days: parseInt(days) }),
      });
      if (!res.ok) throw new Error("Query failed");
      return res.json() as Promise<DynamicQueryResponse>;
    },
    onSuccess: (data) => {
      setQueryResults((prev) => [data, ...prev]);
      setQuestion("");
    },
  });

  const handleSubmit = useCallback((q?: string) => {
    const text = (q || question).trim();
    if (!text || queryMutation.isPending) return;
    queryMutation.mutate(text);
  }, [question, queryMutation]);

  const removeResult = useCallback((index: number) => {
    setQueryResults((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const { data, isLoading, error } = useQuery<AnalysisData>({
    queryKey: ["/api/ai-analysis", days],
    queryFn: async () => {
      const res = await fetch(`/api/ai-analysis?days=${days}`);
      if (!res.ok) throw new Error("Failed to load analysis");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 p-2 rounded-lg">
                <Brain className="w-6 h-6 text-primary" />
              </div>
              <div>
                <Link href="/" className="text-xs text-muted-foreground hover:text-primary transition-colors">
                  MWB Dashboard
                </Link>
                <h1 className="text-lg font-bold leading-tight">AI Sales Analysis</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 Days</SelectItem>
                  <SelectItem value="14">Last 14 Days</SelectItem>
                  <SelectItem value="30">Last 30 Days</SelectItem>
                  <SelectItem value="60">Last 60 Days</SelectItem>
                </SelectContent>
              </Select>
              <NavBar />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-4">
        {error ? (
          <Card className="border-destructive">
            <CardContent className="p-6">
              <div className="flex items-center gap-3 text-destructive">
                <AlertCircle className="w-5 h-5" />
                <p>Failed to load analysis data. Please try again.</p>
              </div>
            </CardContent>
          </Card>
        ) : isLoading || !data ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Running AI analysis on your data...</p>
          </div>
        ) : (
          <>
            {/* Ask a Question */}
            <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-primary/10">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Brain className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold text-primary">Ask a Question About Your Data</span>
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      ref={inputRef}
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
                      placeholder="e.g. What is the check average by unit? Hours over $3000?"
                      className="pl-9 pr-4"
                      disabled={queryMutation.isPending}
                    />
                  </div>
                  <Button
                    onClick={() => handleSubmit()}
                    disabled={!question.trim() || queryMutation.isPending}
                    size="default"
                  >
                    {queryMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <SendHorizontal className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTED_QUESTIONS.slice(0, 8).map((sq) => (
                    <button
                      key={sq}
                      onClick={() => { setQuestion(sq); handleSubmit(sq); }}
                      disabled={queryMutation.isPending}
                      className="text-xs px-2 py-1 rounded-full border border-border/50 bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {sq}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Dynamic Query Results */}
            {queryMutation.isPending && (
              <Card className="border-primary/20">
                <CardContent className="p-4 flex items-center gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">Analyzing your question...</span>
                </CardContent>
              </Card>
            )}
            {queryMutation.isError && (
              <Card className="border-destructive">
                <CardContent className="p-4 flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-destructive" />
                  <span className="text-sm text-destructive">Query failed. Try rephrasing your question.</span>
                </CardContent>
              </Card>
            )}
            {queryResults.map((qr, i) => (
              <DynamicQueryResult key={`${qr.question}-${i}`} data={qr} onClear={() => removeResult(i)} />
            ))}

            {/* Summary Banner */}
            <Card className="bg-muted/30 border-muted">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <BarChart3 className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold text-primary">Default Insights</span>
                  <span className="text-xs text-muted-foreground">
                    ({formatDate(data.dateRange.start)} – {formatDate(data.dateRange.end)}, {data.dateRange.days} days)
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pre-built analysis cards below. Use the search above for custom queries.
                </p>
              </CardContent>
            </Card>

            {/* 1. Hours with Sales Over $2,000 */}
            <InsightCard
              icon={DollarSign}
              title="High Sales Hours"
              question="How many hours of sales did we have over $2,000?"
              defaultOpen={true}
              accentColor="text-green-600"
              bgColor="bg-green-500/10"
            >
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    {data.insights.highSalesHours.totalHours}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    total hours across all units exceeded $2,000 in sales
                  </span>
                </div>

                {data.insights.highSalesHours.byRestaurant.length > 0 ? (
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50">
                          <th className="text-left px-3 py-2 font-medium">Unit</th>
                          <th className="text-center px-3 py-2 font-medium">Hours &gt;$2K</th>
                          <th className="text-right px-3 py-2 font-medium">Avg/Hour</th>
                          <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Peak</th>
                          <th className="text-right px-3 py-2 font-medium hidden md:table-cell">Peak Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.insights.highSalesHours.byRestaurant.map((r, i) => (
                          <tr key={i} className="border-t hover:bg-muted/30">
                            <td className="px-3 py-2 font-medium">{r.restaurant}</td>
                            <td className="px-3 py-2 text-center">
                              <Badge variant="outline">{r.hoursOver2k}</Badge>
                            </td>
                            <td className="px-3 py-2 text-right text-green-600 font-semibold">
                              {formatCurrency(r.avgSalesPerHour)}
                            </td>
                            <td className="px-3 py-2 text-right hidden sm:table-cell font-semibold">
                              {formatCurrency(r.peakSales)}
                            </td>
                            <td className="px-3 py-2 text-right hidden md:table-cell text-muted-foreground">
                              {formatDate(r.peakDate)} @ {formatHour(r.peakHour)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No hours exceeded $2,000 in sales during this period.</p>
                )}
              </div>
            </InsightCard>

            {/* 2. Highest OSAT Score */}
            <InsightCard
              icon={Star}
              title="OSAT Leaders"
              question="Who had the highest OSAT score?"
              defaultOpen={true}
              accentColor="text-amber-500"
              bgColor="bg-amber-500/10"
            >
              <div className="space-y-4">
                {data.insights.osatLeaders.length > 0 ? (
                  <>
                    {/* Top 3 podium */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {data.insights.osatLeaders.slice(0, 3).map((leader) => (
                        <Card key={leader.rank} className={`${leader.rank === 1 ? "border-amber-500/50 bg-amber-500/5" : "border-muted"}`}>
                          <CardContent className="p-3 text-center">
                            <div className="flex items-center justify-center gap-1 mb-1">
                              {leader.rank === 1 && <Trophy className="w-4 h-4 text-amber-500" />}
                              <span className="text-xs text-muted-foreground font-medium">#{leader.rank}</span>
                            </div>
                            <p className="font-semibold text-sm truncate">{leader.restaurant}</p>
                            <p className={`text-2xl font-bold ${leader.avgOsat >= 85 ? "text-green-500" : leader.avgOsat >= 80 ? "text-amber-500" : "text-red-500"}`}>
                              {leader.avgOsat}%
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {leader.totalFiveStar}/{leader.totalResponses} responses
                            </p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>

                    {/* Full table */}
                    {data.insights.osatLeaders.length > 3 && (
                      <div className="rounded-lg border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-muted/50">
                              <th className="text-center px-3 py-2 font-medium w-12">#</th>
                              <th className="text-left px-3 py-2 font-medium">Unit</th>
                              <th className="text-right px-3 py-2 font-medium">OSAT %</th>
                              <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Responses</th>
                              <th className="text-right px-3 py-2 font-medium hidden md:table-cell">Days</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.insights.osatLeaders.slice(3).map((leader) => (
                              <tr key={leader.rank} className="border-t hover:bg-muted/30">
                                <td className="px-3 py-2 text-center text-muted-foreground">{leader.rank}</td>
                                <td className="px-3 py-2 font-medium">{leader.restaurant}</td>
                                <td className={`px-3 py-2 text-right font-semibold ${leader.avgOsat >= 85 ? "text-green-500" : leader.avgOsat >= 80 ? "text-amber-500" : "text-red-500"}`}>
                                  {leader.avgOsat}%
                                </td>
                                <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">
                                  {leader.totalResponses}
                                </td>
                                <td className="px-3 py-2 text-right hidden md:table-cell text-muted-foreground">
                                  {leader.daysWithData}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No OSAT data available for this period.</p>
                )}
              </div>
            </InsightCard>

            {/* 3. Dine-In Percentage Change */}
            <InsightCard
              icon={UtensilsCrossed}
              title="Dine-In % Change"
              question="Which unit had the highest increase in dine-in percentage?"
              accentColor="text-blue-500"
              bgColor="bg-blue-500/10"
            >
              <div className="space-y-4">
                {data.insights.dineInChange.length > 0 ? (
                  <>
                    {/* Highlight top gainer */}
                    {data.insights.dineInChange[0] && data.insights.dineInChange[0].change > 0 && (
                      <Card className="border-blue-500/30 bg-blue-500/5">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xs text-muted-foreground">Biggest Increase</p>
                              <p className="font-semibold">{data.insights.dineInChange[0].restaurant}</p>
                            </div>
                            <div className="text-right">
                              <ChangeIndicator value={data.insights.dineInChange[0].change} suffix=" pp" />
                              <p className="text-xs text-muted-foreground">
                                {data.insights.dineInChange[0].previousPct}% &rarr; {data.insights.dineInChange[0].currentPct}%
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/50">
                            <th className="text-left px-3 py-2 font-medium">Unit</th>
                            <th className="text-right px-3 py-2 font-medium">Current</th>
                            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Previous</th>
                            <th className="text-right px-3 py-2 font-medium">Change</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.insights.dineInChange.map((r, i) => (
                            <tr key={i} className="border-t hover:bg-muted/30">
                              <td className="px-3 py-2 font-medium">{r.restaurant}</td>
                              <td className="px-3 py-2 text-right">{r.currentPct}%</td>
                              <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">{r.previousPct}%</td>
                              <td className="px-3 py-2 text-right">
                                <ChangeIndicator value={r.change} suffix=" pp" />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No dine-in order data available for this period.</p>
                )}
              </div>
            </InsightCard>

            {/* 4. App Order Percentage */}
            <InsightCard
              icon={Smartphone}
              title="App Order Percentage"
              question="What is each unit's app order percentage?"
              accentColor="text-violet-500"
              bgColor="bg-violet-500/10"
            >
              <div className="space-y-4">
                {data.insights.appPercentages.length > 0 ? (
                  <>
                    {/* Top app unit highlight */}
                    {data.insights.appPercentages[0] && (
                      <Card className="border-violet-500/30 bg-violet-500/5">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xs text-muted-foreground">Highest App %</p>
                              <p className="font-semibold">{data.insights.appPercentages[0].restaurant}</p>
                            </div>
                            <div className="text-right">
                              <span className="text-2xl font-bold text-violet-500">{data.insights.appPercentages[0].percentage}%</span>
                              <p className="text-xs text-muted-foreground">
                                {data.insights.appPercentages[0].orders.toLocaleString()} app orders
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/50">
                            <th className="text-left px-3 py-2 font-medium">Unit</th>
                            <th className="text-right px-3 py-2 font-medium">App %</th>
                            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">App Orders</th>
                            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Total Orders</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.insights.appPercentages.map((r, i) => (
                            <tr key={i} className="border-t hover:bg-muted/30">
                              <td className="px-3 py-2 font-medium">{r.restaurant}</td>
                              <td className="px-3 py-2 text-right font-semibold text-violet-500">{r.percentage}%</td>
                              <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">
                                {r.orders.toLocaleString()}
                              </td>
                              <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">
                                {r.totalOrders.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No app order data available for this period.</p>
                )}
              </div>
            </InsightCard>

            {/* 5. Outside Order Takers */}
            <InsightCard
              icon={Megaphone}
              title="Outside Order Takers (OOT)"
              question="Which units ran outside order takers?"
              accentColor="text-orange-500"
              bgColor="bg-orange-500/10"
            >
              <div className="space-y-4">
                {data.insights.outsideOrderTakers.length > 0 ? (
                  <>
                    <div className="flex items-center gap-3 flex-wrap">
                      <Badge variant="secondary" className="text-base px-3 py-1">
                        {data.insights.outsideOrderTakers.filter((r) => r.ranOOT).length}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        units ran outside order takers (DT3 lane) during this period
                      </span>
                    </div>

                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/50">
                            <th className="text-left px-3 py-2 font-medium">Unit</th>
                            <th className="text-center px-3 py-2 font-medium">OOT Active</th>
                            <th className="text-right px-3 py-2 font-medium">OOT Orders</th>
                            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Hours</th>
                            <th className="text-right px-3 py-2 font-medium hidden md:table-cell">Days</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.insights.outsideOrderTakers.map((r, i) => (
                            <tr key={i} className={`border-t hover:bg-muted/30 ${!r.ranOOT ? "opacity-50" : ""}`}>
                              <td className="px-3 py-2 font-medium">{r.restaurant}</td>
                              <td className="px-3 py-2 text-center">
                                {r.ranOOT ? (
                                  <Badge className="bg-orange-500/20 text-orange-600 hover:bg-orange-500/30 border-0">Yes</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-muted-foreground">No</Badge>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold">
                                {r.totalOrders > 0 ? r.totalOrders.toLocaleString() : "-"}
                              </td>
                              <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">
                                {r.hoursUsed > 0 ? r.hoursUsed : "-"}
                              </td>
                              <td className="px-3 py-2 text-right hidden md:table-cell text-muted-foreground">
                                {r.daysUsed > 0 ? r.daysUsed : "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No outside order taker data available.</p>
                )}
              </div>
            </InsightCard>

            {/* 6. Week-over-Week Sales Trend */}
            <InsightCard
              icon={TrendingUp}
              title="Week-over-Week Trend"
              question="What are the top selling trends growing week over week?"
              accentColor="text-emerald-500"
              bgColor="bg-emerald-500/10"
            >
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-muted-foreground mb-1">This Week</p>
                      <p className="text-xl font-bold">{formatCurrency(data.insights.attachmentTrend.thisWeek.totalSales)}</p>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-muted-foreground">{data.insights.attachmentTrend.thisWeek.orders.toLocaleString()} orders</span>
                        <span className="text-xs text-muted-foreground">Avg: {formatCurrency(data.insights.attachmentTrend.thisWeek.avgCheck)}</span>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-muted-foreground mb-1">Last Week</p>
                      <p className="text-xl font-bold">{formatCurrency(data.insights.attachmentTrend.lastWeek.totalSales)}</p>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-muted-foreground">{data.insights.attachmentTrend.lastWeek.orders.toLocaleString()} orders</span>
                        <span className="text-xs text-muted-foreground">Avg: {formatCurrency(data.insights.attachmentTrend.lastWeek.avgCheck)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Card className="border-muted">
                    <CardContent className="p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Check Avg Change</p>
                      <div className="text-lg">
                        <ChangeIndicator value={data.insights.attachmentTrend.checkAvgChange} />
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-muted">
                    <CardContent className="p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Order Count Change</p>
                      <div className="text-lg">
                        <ChangeIndicator value={data.insights.attachmentTrend.orderCountChange} />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </InsightCard>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 mt-6">
        <div className="container mx-auto px-4 py-3 text-center text-xs text-muted-foreground">
          AI Analysis uses real-time data from your POS, OSAT surveys, and sales reports.
        </div>
      </footer>
    </div>
  );
}
