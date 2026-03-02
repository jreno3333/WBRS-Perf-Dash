import { NavBar } from "@/components/nav-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GRADE_WEIGHTS, BONUS_DEFINITIONS, BONUS_CAP, scoreToGradeLabel, getGradeColor } from "@/lib/grading";
import { BookOpen, Star, TrendingUp, Users, Timer, Award, Sparkles, ArrowLeft } from "lucide-react";
import { Link } from "wouter";

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

const salesTable = [
  { range: "+10% or more", score: 100, color: "text-green-500" },
  { range: "+5% to +10%", score: 95, color: "text-green-500" },
  { range: "0% to +5%", score: 90, color: "text-green-500" },
  { range: "-5% to 0%", score: 80, color: "text-blue-500" },
  { range: "-10% to -5%", score: 60, color: "text-orange-500" },
  { range: "Below -10%", score: 40, color: "text-red-500" },
];

const osatTable = [
  { range: "90% or higher", score: 100, color: "text-green-500" },
  { range: "85% to 89%", score: 90, color: "text-green-500" },
  { range: "80% to 84%", score: 70, color: "text-yellow-500" },
  { range: "75% to 79%", score: 50, color: "text-orange-500" },
  { range: "Below 75%", score: 40, color: "text-red-500" },
];

const speedTable = [
  { range: "70%+ attainment", score: 100, color: "text-green-500" },
  { range: "50% to 70%", score: 70, color: "text-yellow-500" },
  { range: "Below 50%", score: 40, color: "text-red-500" },
];

const staffingTable = [
  { range: "Within +/-1 of target", score: 100, color: "text-green-500" },
  { range: "More than 1 over/under", score: 60, color: "text-orange-500" },
];

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
  // Example calculation
  const exSales = 90; // 0-5% above LW
  const exTxn = 95; // 5-10% above LW
  const exOsat = 100; // 90%+
  const exSpeed = 70; // 50-70%
  const exStaffing = 100; // within 1
  const exBase = (exSales * GRADE_WEIGHTS.sales + exTxn * GRADE_WEIGHTS.transactions + exOsat * GRADE_WEIGHTS.osat + exSpeed * GRADE_WEIGHTS.speed + exStaffing * GRADE_WEIGHTS.staffing) / 100;
  const exBonus = 4; // sales growth + consistency
  const exFinal = Math.min(exBase + exBonus, 100);
  const exGrade = scoreToGradeLabel(exFinal);

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
              Each operating hour is scored on <strong>5 components</strong>, weighted to emphasize guest-facing metrics.
              Your <strong>daily score</strong> is the average of all hourly scores, plus any <strong>bonus points</strong> earned for exceptional daily performance.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { name: "Sales", weight: GRADE_WEIGHTS.sales, icon: "💰" },
                { name: "Transactions", weight: GRADE_WEIGHTS.transactions, icon: "🧾" },
                { name: "OSAT", weight: GRADE_WEIGHTS.osat, icon: "⭐" },
                { name: "Speed", weight: GRADE_WEIGHTS.speed, icon: "⏱️" },
                { name: "Staffing", weight: GRADE_WEIGHTS.staffing, icon: "👥" },
              ].map(c => (
                <div key={c.name} className="text-center p-3 rounded-lg border">
                  <div className="text-lg">{c.icon}</div>
                  <div className="font-semibold text-xs mt-1">{c.name}</div>
                  <div className="text-lg font-bold text-primary">{c.weight}%</div>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Guest-facing metrics (Sales + Transactions + OSAT) = <strong>75%</strong> of your score.
              Operational metrics (Speed + Staffing) = <strong>25%</strong>.
            </p>
          </CardContent>
        </Card>

        {/* Component Scoring Tables */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ScoringTable title="Sales vs. Last Week" icon={TrendingUp} weight={GRADE_WEIGHTS.sales} rows={salesTable} />
          <ScoringTable title="Transactions vs. Last Week" icon={TrendingUp} weight={GRADE_WEIGHTS.transactions} rows={salesTable} />
          <ScoringTable title="OSAT (Guest Satisfaction)" icon={Star} weight={GRADE_WEIGHTS.osat} rows={osatTable} />
          <ScoringTable title="Drive-Thru Speed" icon={Timer} weight={GRADE_WEIGHTS.speed} rows={speedTable} />
        </div>
        <ScoringTable title="Staffing vs. Labor Model" icon={Users} weight={GRADE_WEIGHTS.staffing} rows={staffingTable} />

        <Card className="border-none bg-muted/30">
          <CardContent className="pt-4 text-xs text-muted-foreground">
            <strong>Note on Speed:</strong> Speed is measured via HME timer attainment (% of cars under 6 minutes).
            Lane configuration changes can temporarily affect this metric. It carries a reduced weight (15%) to account for these operational exceptions.
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
                  <td className="py-1 text-center">{GRADE_WEIGHTS.sales}%</td>
                  <td className="py-1 text-center">{exSales}</td>
                  <td className="py-1 text-right">{(exSales * GRADE_WEIGHTS.sales / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">Transactions (+7%)</td>
                  <td className="py-1 text-center">{GRADE_WEIGHTS.transactions}%</td>
                  <td className="py-1 text-center">{exTxn}</td>
                  <td className="py-1 text-right">{(exTxn * GRADE_WEIGHTS.transactions / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">OSAT (92%)</td>
                  <td className="py-1 text-center">{GRADE_WEIGHTS.osat}%</td>
                  <td className="py-1 text-center">{exOsat}</td>
                  <td className="py-1 text-right">{(exOsat * GRADE_WEIGHTS.osat / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">Speed (55%)</td>
                  <td className="py-1 text-center">{GRADE_WEIGHTS.speed}%</td>
                  <td className="py-1 text-center">{exSpeed}</td>
                  <td className="py-1 text-right">{(exSpeed * GRADE_WEIGHTS.speed / 100).toFixed(1)}</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-1">Staffing (on target)</td>
                  <td className="py-1 text-center">{GRADE_WEIGHTS.staffing}%</td>
                  <td className="py-1 text-center">{exStaffing}</td>
                  <td className="py-1 text-right">{(exStaffing * GRADE_WEIGHTS.staffing / 100).toFixed(1)}</td>
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
