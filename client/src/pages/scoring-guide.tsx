import { useQuery } from "@tanstack/react-query";
import { NavBar } from "@/components/nav-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BONUS_DEFINITIONS, BONUS_CAP, scoreToGradeLabel, getGradeColor } from "@/lib/grading";
import { BookOpen, Star, TrendingUp, Users, Timer, Award, Sparkles, ArrowLeft, MessageSquare } from "lucide-react";
import { Link } from "wouter";
import type { GradingConfigData, ScoringTier } from "@shared/schema";
import { DEFAULT_GRADING_CONFIG } from "@shared/schema";

const gradeScale = [
  { label: "A+", min: 97, max: 100, color: "bg-green-500" },
  { label: "A",  min: 93, max: 96,  color: "bg-green-500" },
  { label: "A-", min: 90, max: 92,  color: "bg-green-500" },
  { label: "B+", min: 87, max: 89,  color: "bg-blue-500" },
  { label: "B",  min: 83, max: 86,  color: "bg-blue-500" },
  { label: "B-", min: 80, max: 82,  color: "bg-blue-500" },
  { label: "C+", min: 77, max: 79,  color: "bg-yellow-500" },
  { label: "C",  min: 73, max: 76,  color: "bg-yellow-500" },
  { label: "C-", min: 70, max: 72,  color: "bg-yellow-500" },
  { label: "D+", min: 67, max: 69,  color: "bg-orange-500" },
  { label: "D",  min: 63, max: 66,  color: "bg-orange-500" },
  { label: "D-", min: 60, max: 62,  color: "bg-orange-500" },
  { label: "F",  min: 0,  max: 59,  color: "bg-red-500" },
];

function getScoreColor(score: number): string {
  if (score >= 90) return "text-green-500";
  if (score >= 70) return "text-green-500";
  if (score >= 50) return "text-yellow-500";
  return "text-red-500";
}

/** Build display rows from tiers + fallback for the scoring tables */
function buildVarianceTierRows(tiers: ScoringTier[], fallbackScore: number): { range: string; score: number; color: string }[] {
  const rows: { range: string; score: number; color: string }[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const prevThreshold = i === 0 ? undefined : tiers[i - 1].threshold;
    let range: string;
    if (i === 0) {
      range = `${tier.threshold >= 0 ? "+" : ""}${tier.threshold}% or more`;
    } else {
      range = `${tier.threshold >= 0 ? "+" : ""}${tier.threshold}% to ${prevThreshold! >= 0 ? "+" : ""}${prevThreshold}%`;
    }
    rows.push({ range, score: tier.points, color: tier.points >= 90 ? "text-green-500" : tier.points >= 70 ? "text-yellow-500" : tier.points >= 50 ? "text-orange-500" : "text-red-500" });
  }
  const lowestThreshold = tiers.length > 0 ? tiers[tiers.length - 1].threshold : 0;
  rows.push({ range: `Below ${lowestThreshold >= 0 ? "+" : ""}${lowestThreshold}%`, score: fallbackScore, color: "text-red-500" });
  return rows;
}

function buildPercentTierRows(tiers: ScoringTier[], fallbackScore: number): { range: string; score: number; color: string }[] {
  const rows: { range: string; score: number; color: string }[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const prevThreshold = i === 0 ? undefined : tiers[i - 1].threshold;
    let range: string;
    if (i === 0) {
      range = `${tier.threshold}% or higher`;
    } else {
      range = `${tier.threshold}% to ${prevThreshold! - 1}%`;
    }
    rows.push({ range, score: tier.points, color: tier.points >= 90 ? "text-green-500" : tier.points >= 70 ? "text-yellow-500" : tier.points >= 50 ? "text-orange-500" : "text-red-500" });
  }
  const lowestThreshold = tiers.length > 0 ? tiers[tiers.length - 1].threshold : 0;
  rows.push({ range: `Below ${lowestThreshold}%`, score: fallbackScore, color: "text-red-500" });
  return rows;
}

function buildSpeedTierRows(tiers: ScoringTier[], fallbackScore: number): { range: string; score: number; color: string }[] {
  const rows: { range: string; score: number; color: string }[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const prevThreshold = i === 0 ? undefined : tiers[i - 1].threshold;
    let range: string;
    if (i === 0) {
      range = `${tier.threshold}%+ attainment`;
    } else {
      range = `${tier.threshold}% to ${prevThreshold}%`;
    }
    rows.push({ range, score: tier.points, color: tier.points >= 90 ? "text-green-500" : tier.points >= 70 ? "text-yellow-500" : "text-red-500" });
  }
  const lowestThreshold = tiers.length > 0 ? tiers[tiers.length - 1].threshold : 0;
  rows.push({ range: `Below ${lowestThreshold}%`, score: fallbackScore, color: "text-red-500" });
  return rows;
}

function ScoringTable({ title, icon: Icon, weight, rows }: {
  title: string;
  icon: typeof Star;
  weight: number;
  rows: { range: string; score: number; color: string }[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Icon className="w-4 h-4" />
            {title}
          </span>
          <Badge variant="outline" className="text-xs">{weight}% weight</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1 text-muted-foreground font-medium">Performance</th>
              <th className="text-right py-1 text-muted-foreground font-medium">Points</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="py-1.5">{row.range}</td>
                <td className={`py-1.5 text-right font-semibold ${row.color}`}>{row.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export default function ScoringGuidePage() {
  const { data: config } = useQuery<GradingConfigData>({
    queryKey: ["/api/grading-config"],
  });

  const cfg = config || DEFAULT_GRADING_CONFIG;
  const w = cfg.weights;

  // Build dynamic scoring tables from config
  const salesTable = buildVarianceTierRows(cfg.salesTiers, 40);
  const txnTable = buildVarianceTierRows(cfg.transactionTiers, 40);
  const osatTable = buildPercentTierRows(cfg.osatTiers, 40);
  const speedTable = buildSpeedTierRows(cfg.speedTiers, 40);
  const feedbackSpeedTable = buildPercentTierRows(cfg.feedbackSpeedTiers, 40);
  const staffingTable = [
    { range: `Within +/-${cfg.staffingTolerance} of target`, score: cfg.staffingInToleranceScore, color: "text-green-500" },
    { range: `More than ${cfg.staffingTolerance} over/under`, score: cfg.staffingOutToleranceScore, color: "text-orange-500" },
  ];

  // Example calculation using dynamic weights
  const exSales = 90; // 0-5% above LW
  const exTxn = 95; // 5-10% above LW
  const exOsat = 100; // 90%+
  const exSpeed = 70; // 50-70%
  const exStaffing = cfg.staffingInToleranceScore; // within tolerance
  const exFs = 100; // 90%+ customer feedback 5-star top-box
  const exBase = (exSales * w.sales + exTxn * w.transactions + exOsat * w.osat + exSpeed * w.speed + exStaffing * w.staffing + exFs * w.feedbackSpeed) / 100;
  const exBonus = 4; // sales growth + consistency
  const exFinal = Math.min(exBase + exBonus, 100);
  const exGrade = scoreToGradeLabel(exFinal);

  const guestFacingPct = w.sales + w.transactions + w.osat;
  const operationalPct = w.speed + w.staffing;

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Link href="/">
              <button className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <BookOpen className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">Execution Score Guide</h1>
          </div>
          <NavBar />
        </div>

        {/* Overview */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How Your Execution Score Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Each operating hour is scored on <strong>6 components</strong>, weighted to emphasize guest-facing metrics.
              Your <strong>daily score</strong> is the average of all hourly scores, plus any <strong>bonus points</strong> earned for exceptional daily performance.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {[
                { name: "Sales", weight: w.sales, icon: "💰" },
                { name: "Transactions", weight: w.transactions, icon: "🧾" },
                { name: "OSAT", weight: w.osat, icon: "⭐" },
                { name: "Speed (HME)", weight: w.speed, icon: "⏱️" },
                { name: "OSAT Speed", weight: w.feedbackSpeed ?? 0, icon: "⏲️" },
                { name: "Staffing", weight: w.staffing, icon: "👥" },
              ].map(c => (
                <div key={c.name} className="text-center p-3 rounded-lg border">
                  <div className="text-lg">{c.icon}</div>
                  <div className="font-semibold text-xs mt-1">{c.name}</div>
                  <div className="text-lg font-bold text-primary">{c.weight}%</div>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Guest-facing metrics (Sales + Transactions + OSAT + OSAT Speed) = <strong>{guestFacingPct + (w.feedbackSpeed ?? 0)}%</strong> of your score.
              Operational metrics (Speed + Staffing) = <strong>{operationalPct}%</strong>.
            </p>
          </CardContent>
        </Card>

        {/* Component Scoring Tables */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ScoringTable title="Sales vs. Last Week" icon={TrendingUp} weight={w.sales} rows={salesTable} />
          <ScoringTable title="Transactions vs. Last Week" icon={TrendingUp} weight={w.transactions} rows={txnTable} />
          <ScoringTable title="OSAT (Guest Satisfaction)" icon={Star} weight={w.osat} rows={osatTable} />
          <ScoringTable title="Drive-Thru Speed" icon={Timer} weight={w.speed} rows={speedTable} />
          <ScoringTable title="OSAT Speed" icon={MessageSquare} weight={w.feedbackSpeed ?? 0} rows={feedbackSpeedTable} />
        </div>
        <ScoringTable title="Staffing vs. Labor Model" icon={Users} weight={w.staffing} rows={staffingTable} />

        <Card className="border-none bg-muted/30">
          <CardContent className="pt-4 text-xs text-muted-foreground space-y-2">
            <p>
              <strong>OSAT Speed (Qualtrics):</strong> 5★ top-box % of guest-survey responses to the
              "Speed of Service" question. Most stores use the <em>DT Speed of Service</em> question; store 1682
              (no drive-thru) uses the generic <em>Speed of Service</em> question instead. The same daily value
              is applied to every hour of that day. When a store has zero responses for the day, the component is
              skipped and weights are renormalized across the remaining components.
            </p>
          </CardContent>
        </Card>

        <Card className="border-none bg-muted/30">
          <CardContent className="pt-4 text-xs text-muted-foreground space-y-2">
            <p>
              <strong>Note on Speed:</strong> Speed is measured via HME timer attainment (% of cars under 6 minutes).
              It carries a {w.speed}% weight to account for operational variability.
            </p>
            <p>
              <strong>OOT / Outside Lane (DT#3) Exception:</strong> When the outside drive-thru lane is active during an hour
              (detected via DT#3 orders), speed is <strong>automatically excluded</strong> from that hour's grade.
              Ad-hoc lane configuration changes make HME timing unreliable, so it would be unfair to grade on it.
              The remaining components redistribute proportionally to fill the 100% weight.
              Speed data still appears in the dashboard for visibility — it just won't count toward your score.
            </p>
          </CardContent>
        </Card>

        <Card className="border-none bg-muted/30">
          <CardContent className="pt-4 text-xs text-muted-foreground">
            <strong>Staffing exception:</strong> If your sales are 20%+ above last week (a sales surge), understaffing is forgiven — you won't be penalized for being short-handed when demand exceeds expectations.
          </CardContent>
        </Card>

        {/* Bonus Points */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-yellow-500" />
              Daily Bonus Points
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Bonus points reward exceptional daily performance. They're added to your base score (the average of your hourly scores) at the end of the day, capped at <strong>+{BONUS_CAP} points</strong> maximum.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 text-muted-foreground font-medium">Bonus</th>
                  <th className="text-center py-2 text-muted-foreground font-medium">Points</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">How to Earn</th>
                </tr>
              </thead>
              <tbody>
                {BONUS_DEFINITIONS.map(b => (
                  <tr key={b.id} className="border-b border-border/50">
                    <td className="py-2 font-medium">{b.label}</td>
                    <td className="py-2 text-center">
                      <Badge variant="outline" className="text-xs font-bold text-yellow-600">+{b.points}</Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">{b.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Perfect OSAT and High-Volume OSAT are mutually exclusive — you earn whichever applies, not both.
            </p>
            <p className="text-xs text-muted-foreground">
              <strong>YoY Growth</strong> is available only for units with uploaded historical sales data for the same date last year. Any positive growth above last year earns the bonus.
            </p>
            <p className="text-xs text-muted-foreground">
              <strong>The Closer</strong> rewards upsell execution. Each of the 6 attachment categories (cheese, bacon, jalapeños, dipping sauces, shakes & malts, whatasize) earns +1 point when the unit hits or exceeds the category target for the day. You must hit at least 4 of 6 targets to qualify. Points scale with performance: 4/6 = +4, 5/6 = +5, 6/6 = +6.
            </p>
          </CardContent>
        </Card>

        {/* Grade Scale */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="w-4 h-4" />
              Grade Scale
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
              {gradeScale.map(g => (
                <div key={g.label} className="text-center">
                  <div className={`text-lg font-bold ${getGradeColor(g.label)}`}>{g.label}</div>
                  <div className="text-[10px] text-muted-foreground">{g.min}-{g.max}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Worked Example */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Example Calculation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              A store with a good day: sales +3% vs LW, transactions +7%, OSAT at 92%, speed attainment 55%, staffing on target.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-1">Component</th>
                  <th className="text-center py-1">Weight</th>
                  <th className="text-center py-1">Score</th>
                  <th className="text-right py-1">Weighted</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50">
                  <td className="py-1">Sales (+3%)</td>
                  <td className="py-1 text-center">{w.sales}%</td>
                  <td className="py-1 text-center">{exSales}</td>
                  <td className="py-1 text-right">{(exSales * w.sales / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">Transactions (+7%)</td>
                  <td className="py-1 text-center">{w.transactions}%</td>
                  <td className="py-1 text-center">{exTxn}</td>
                  <td className="py-1 text-right">{(exTxn * w.transactions / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">OSAT (92%)</td>
                  <td className="py-1 text-center">{w.osat}%</td>
                  <td className="py-1 text-center">{exOsat}</td>
                  <td className="py-1 text-right">{(exOsat * w.osat / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">Speed (55%)</td>
                  <td className="py-1 text-center">{w.speed}%</td>
                  <td className="py-1 text-center">{exSpeed}</td>
                  <td className="py-1 text-right">{(exSpeed * w.speed / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">Staffing (on target)</td>
                  <td className="py-1 text-center">{w.staffing}%</td>
                  <td className="py-1 text-center">{exStaffing}</td>
                  <td className="py-1 text-right">{(exStaffing * w.staffing / 100).toFixed(1)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="border-t-2">
                  <td className="py-1 font-semibold" colSpan={3}>Base Score</td>
                  <td className="py-1 text-right font-bold">{exBase.toFixed(1)}</td>
                </tr>
                <tr>
                  <td className="py-1 text-yellow-600" colSpan={3}>
                    Bonus: Sales Growth (+2) + Consistency (+2)
                  </td>
                  <td className="py-1 text-right font-bold text-yellow-600">+{exBonus}</td>
                </tr>
                <tr className="border-t">
                  <td className="py-1 font-bold" colSpan={3}>Final Score</td>
                  <td className="py-1 text-right">
                    <span className={`font-bold text-lg ${getGradeColor(exGrade)}`}>{exFinal.toFixed(1)} ({exGrade})</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center text-xs text-muted-foreground py-4">
          Scores update throughout the day. Daily grades and bonuses finalize at end of business.
        </div>
      </div>
    </div>
  );
}
