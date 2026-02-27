import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NavBar } from "@/components/nav-bar";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Mail,
  ThumbsDown,
  ThumbsUp,
  MessageSquare,
  BarChart3,
  Plus,
  Settings,
  Home,
  Loader2,
  ShieldAlert,
  CheckCircle,
  XCircle,
  Clock,
  Building2,
} from "lucide-react";
import type { ComplaintDashboardData, ComplaintIndexData, EmailAlert, Restaurant } from "@shared/schema";

// ─── Helpers ────────────────────────────────────────────────────────────────

function getIndexColor(score: number): string {
  if (score >= 90) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 75) return "text-green-600 dark:text-green-400";
  if (score >= 60) return "text-yellow-600 dark:text-yellow-400";
  if (score >= 40) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function getIndexBg(score: number): string {
  if (score >= 90) return "bg-emerald-50 dark:bg-emerald-950/30";
  if (score >= 75) return "bg-green-50 dark:bg-green-950/30";
  if (score >= 60) return "bg-yellow-50 dark:bg-yellow-950/30";
  if (score >= 40) return "bg-orange-50 dark:bg-orange-950/30";
  return "bg-red-50 dark:bg-red-950/30";
}

function getIndexLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 60) return "Needs Improvement";
  if (score >= 40) return "Concerning";
  return "Critical";
}

function getSentimentBadge(sentiment: string) {
  switch (sentiment) {
    case "positive":
      return <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"><ThumbsUp className="w-3 h-3 mr-1" />Positive</Badge>;
    case "negative":
      return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"><ThumbsDown className="w-3 h-3 mr-1" />Negative</Badge>;
    default:
      return <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300"><Minus className="w-3 h-3 mr-1" />Neutral</Badge>;
  }
}

function getSeverityBadge(severity: number) {
  switch (severity) {
    case 3:
      return <Badge variant="destructive"><ShieldAlert className="w-3 h-3 mr-1" />High</Badge>;
    case 2:
      return <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"><AlertTriangle className="w-3 h-3 mr-1" />Medium</Badge>;
    default:
      return <Badge variant="secondary">Low</Badge>;
  }
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    food_quality: "Food Quality",
    service: "Service",
    order_accuracy: "Order Accuracy",
    cleanliness: "Cleanliness",
    wait_time: "Wait Time",
    staff: "Staff",
    general: "General",
  };
  return labels[category] || category;
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ─── Summary Cards ──────────────────────────────────────────────────────────

function SummaryCards({ data }: { data: ComplaintDashboardData }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Mail className="w-3.5 h-3.5" />
            Total Alerts
          </div>
          <div className="text-2xl font-bold">{data.totalAlerts}</div>
          <div className="text-xs text-muted-foreground">
            {data.periodStart} to {data.periodEnd}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <BarChart3 className="w-3.5 h-3.5" />
            Avg Performance Index
          </div>
          <div className={`text-2xl font-bold ${getIndexColor(data.avgPerformanceIndex)}`}>
            {data.avgPerformanceIndex}
          </div>
          <div className="text-xs text-muted-foreground">{getIndexLabel(data.avgPerformanceIndex)}</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <ThumbsDown className="w-3.5 h-3.5" />
            Complaints / 500 Txns
          </div>
          <div className="text-2xl font-bold">{data.avgComplaintsPer500}</div>
          <div className="text-xs text-muted-foreground">Lower is better</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Building2 className="w-3.5 h-3.5" />
            Stores Tracked
          </div>
          <div className="text-2xl font-bold">{data.restaurants.length}</div>
          <div className="text-xs text-muted-foreground">
            {data.restaurants.filter((r) => r.negativeCount > 0).length} with complaints
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Restaurant Performance Table ───────────────────────────────────────────

function PerformanceTable({ restaurants }: { restaurants: ComplaintIndexData[] }) {
  const [sortBy, setSortBy] = useState<"index" | "complaints" | "name">("complaints");

  const sorted = useMemo(() => {
    return [...restaurants].sort((a, b) => {
      if (sortBy === "index") return a.performanceIndex - b.performanceIndex;
      if (sortBy === "complaints") return b.negativeCount - a.negativeCount;
      return a.restaurantName.localeCompare(b.restaurantName);
    });
  }, [restaurants, sortBy]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Complaint Performance Index by Store</CardTitle>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="complaints">Most Complaints</SelectItem>
              <SelectItem value="index">Lowest Index</SelectItem>
              <SelectItem value="name">Store Name</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <CardDescription>
          Performance index: 100 = no complaints, lower = more complaints per transaction. Baseline: 2 complaints per 500 transactions = 60.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {sorted.map((r) => (
            <div
              key={r.restaurantId}
              className={`flex items-center gap-3 p-3 rounded-lg border ${getIndexBg(r.performanceIndex)}`}
            >
              {/* Score circle */}
              <div
                className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm border-2 ${
                  r.performanceIndex >= 75
                    ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/50"
                    : r.performanceIndex >= 60
                    ? "border-yellow-400 bg-yellow-50 dark:bg-yellow-950/50"
                    : "border-red-400 bg-red-50 dark:bg-red-950/50"
                } ${getIndexColor(r.performanceIndex)}`}
              >
                {r.performanceIndex.toFixed(0)}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{r.restaurantName}</div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                  <span className="text-red-600 dark:text-red-400">{r.negativeCount} complaints</span>
                  <span className="text-emerald-600 dark:text-emerald-400">{r.positiveCount} praise</span>
                  <span>{r.complaintsPer500}/500 txns</span>
                </div>
              </div>

              {/* Category breakdown */}
              <div className="hidden md:flex items-center gap-1.5 flex-shrink-0">
                {Object.entries(r.categoryBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 3)
                  .map(([cat, count]) => (
                    <Badge key={cat} variant="outline" className="text-[10px] py-0">
                      {getCategoryLabel(cat)} ({count})
                    </Badge>
                  ))}
              </div>

              {/* Trend */}
              <div className="flex-shrink-0">
                {r.trend === "improving" ? (
                  <TrendingUp className="w-4 h-4 text-emerald-500" />
                ) : r.trend === "declining" ? (
                  <TrendingDown className="w-4 h-4 text-red-500" />
                ) : (
                  <Minus className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
            </div>
          ))}

          {sorted.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Mail className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No complaint data yet</p>
              <p className="text-xs mt-1">
                Set up Zapier to forward emails to the webhook, or add alerts manually below.
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Recent Alerts Feed ─────────────────────────────────────────────────────

function AlertsFeed({ alerts }: { alerts: EmailAlert[] }) {
  if (alerts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No alerts yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent Alerts</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {alerts.map((alert) => (
            <div key={alert.id} className="flex gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
              <div className="flex-shrink-0 mt-0.5">
                {alert.sentiment === "negative" ? (
                  <XCircle className="w-4 h-4 text-red-500" />
                ) : alert.sentiment === "positive" ? (
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Minus className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm truncate">{alert.subject}</span>
                  {getSentimentBadge(alert.sentiment)}
                  {alert.severity && alert.severity >= 2 && getSeverityBadge(alert.severity)}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                  {alert.restaurantName && (
                    <span className="flex items-center gap-1">
                      <Building2 className="w-3 h-3" />
                      {alert.restaurantName}
                    </span>
                  )}
                  <Badge variant="outline" className="text-[10px] py-0">
                    {getCategoryLabel(alert.category || "general")}
                  </Badge>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDate(alert.receivedAt as any)}
                  </span>
                </div>
                {alert.bodyText && (
                  <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{alert.bodyText}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Manual Alert Form ──────────────────────────────────────────────────────

function ManualAlertForm({ restaurants }: { restaurants: Restaurant[] }) {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [restaurantId, setRestaurantId] = useState("");
  const [sentiment, setSentiment] = useState("");

  const mutation = useMutation({
    mutationFn: async (data: Record<string, string>) => {
      const res = await fetch("/api/email-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to submit alert");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Alert added", description: "The alert has been classified and saved." });
      setSubject("");
      setBodyText("");
      setRestaurantId("");
      setSentiment("");
      queryClient.invalidateQueries({ queryKey: ["/api/complaint-index"] });
      queryClient.invalidateQueries({ queryKey: ["/api/email-alerts"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to submit alert", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add Alert Manually
        </CardTitle>
        <CardDescription>
          Enter an email complaint or praise manually. The system will auto-classify it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Subject *</Label>
            <Input
              placeholder="e.g., Complaint about cold food at Store #1237"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs">Description</Label>
            <Textarea
              placeholder="Paste the email body or describe the complaint..."
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={3}
              className="text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Store (optional)</Label>
              <Select value={restaurantId} onValueChange={setRestaurantId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Auto-detect" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  {restaurants.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Sentiment (optional)</Label>
              <Select value={sentiment} onValueChange={setSentiment}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Auto-classify" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-classify</SelectItem>
                  <SelectItem value="negative">Complaint</SelectItem>
                  <SelectItem value="positive">Praise</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            onClick={() =>
              mutation.mutate({
                subject,
                bodyText,
                restaurantId: restaurantId && restaurantId !== "auto" ? restaurantId : "",
                sentiment: sentiment && sentiment !== "auto" ? sentiment : "",
              })
            }
            disabled={!subject.trim() || mutation.isPending}
            size="sm"
          >
            {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
            Add Alert
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Setup Guide ────────────────────────────────────────────────────────────

function ZapierSetupGuide() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings className="w-4 h-4" />
          Zapier Integration Setup
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 text-sm">
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="font-medium mb-2">How it works:</p>
            <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground text-xs">
              <li><strong>Outlook</strong> &mdash; Set up a rule to forward complaint/praise emails to a dedicated Gmail address</li>
              <li><strong>Gmail</strong> &mdash; Receives the forwarded emails (acts as the collection inbox)</li>
              <li><strong>Zapier</strong> &mdash; Watches the Gmail inbox for new emails and sends them to the webhook</li>
              <li><strong>Dashboard</strong> &mdash; Auto-classifies sentiment, matches to store, and calculates the performance index</li>
            </ol>
          </div>

          <div className="p-3 rounded-lg border">
            <p className="font-medium text-xs mb-1.5">Zapier Webhook URL:</p>
            <code className="text-xs bg-muted px-2 py-1 rounded block break-all">
              POST {window.location.origin}/api/zapier/email-alerts
            </code>
          </div>

          <div className="p-3 rounded-lg border">
            <p className="font-medium text-xs mb-1.5">Zapier JSON body format:</p>
            <pre className="text-[11px] bg-muted p-2 rounded overflow-x-auto">{`{
  "subject": "{{subject}}",
  "body_text": "{{body_plain}}",
  "from": "{{from_email}}",
  "date": "{{date}}",
  "zapier_id": "{{id}}"
}`}</pre>
          </div>

          <div className="p-3 rounded-lg border">
            <p className="font-medium text-xs mb-1.5">Optional: Webhook secret header</p>
            <p className="text-xs text-muted-foreground">
              Set <code className="bg-muted px-1 rounded">EMAIL_ALERT_WEBHOOK_SECRET</code> as an env variable, then include in Zapier:
            </p>
            <code className="text-xs bg-muted px-2 py-1 rounded block mt-1">
              Header: x-webhook-secret: your_secret_here
            </code>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Category Breakdown Chart ───────────────────────────────────────────────

function CategoryBreakdown({ restaurants }: { restaurants: ComplaintIndexData[] }) {
  const totals = useMemo(() => {
    const cats: Record<string, number> = {};
    for (const r of restaurants) {
      for (const [cat, count] of Object.entries(r.categoryBreakdown)) {
        cats[cat] = (cats[cat] || 0) + count;
      }
    }
    return Object.entries(cats).sort(([, a], [, b]) => b - a);
  }, [restaurants]);

  const maxCount = totals.length > 0 ? totals[0][1] : 1;

  if (totals.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Complaint Categories</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {totals.map(([cat, count]) => (
            <div key={cat} className="flex items-center gap-3">
              <span className="text-xs w-28 text-muted-foreground truncate">{getCategoryLabel(cat)}</span>
              <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden">
                <div
                  className="h-full bg-red-400 dark:bg-red-600 rounded-full transition-all"
                  style={{ width: `${(count / maxCount) * 100}%` }}
                />
              </div>
              <span className="text-xs font-medium w-8 text-right">{count}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function ComplaintsPage() {
  const [days, setDays] = useState("30");

  const { data: indexData, isLoading } = useQuery<ComplaintDashboardData>({
    queryKey: ["/api/complaint-index", days],
    queryFn: async () => {
      const res = await fetch(`/api/complaint-index?days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: restaurants } = useQuery<Restaurant[]>({
    queryKey: ["/api/restaurants"],
    queryFn: async () => {
      const res = await fetch("/api/restaurants", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="h-7 px-2">
                <Home className="w-3.5 h-3.5" />
              </Button>
            </Link>
            <h1 className="text-sm font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-orange-500" />
              Complaint Performance Index
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-[120px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <NavBar />
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-3 py-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : indexData ? (
          <>
            <SummaryCards data={indexData} />

            <Tabs defaultValue="performance" className="space-y-4">
              <TabsList>
                <TabsTrigger value="performance" className="text-xs">
                  <BarChart3 className="w-3.5 h-3.5 mr-1" />
                  Performance
                </TabsTrigger>
                <TabsTrigger value="feed" className="text-xs">
                  <MessageSquare className="w-3.5 h-3.5 mr-1" />
                  Alert Feed
                </TabsTrigger>
                <TabsTrigger value="add" className="text-xs">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add Alert
                </TabsTrigger>
                <TabsTrigger value="setup" className="text-xs">
                  <Settings className="w-3.5 h-3.5 mr-1" />
                  Setup
                </TabsTrigger>
              </TabsList>

              <TabsContent value="performance" className="space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2">
                    <PerformanceTable restaurants={indexData.restaurants} />
                  </div>
                  <div>
                    <CategoryBreakdown restaurants={indexData.restaurants} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="feed">
                <AlertsFeed alerts={indexData.recentAlerts} />
              </TabsContent>

              <TabsContent value="add">
                <ManualAlertForm restaurants={restaurants || []} />
              </TabsContent>

              <TabsContent value="setup">
                <ZapierSetupGuide />
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <div className="text-center py-20 text-muted-foreground">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>Failed to load complaint data</p>
          </div>
        )}
      </main>
    </div>
  );
}
