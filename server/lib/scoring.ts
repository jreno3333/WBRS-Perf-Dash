/**
 * Shared Execution Scoring Module — Single Source of Truth
 *
 * Graduated scoring with 5 weighted components + daily bonus points.
 * Used by: grading.ts (client), daily-report, push-report, leader-detail,
 *          performance-history, arena-engine, leaderboard, leaders routes.
 *
 * WEIGHTS: Configurable via grading_config table (defaults below).
 */

import type { GradingConfigData, ScoringTier } from "@shared/schema";
import { DEFAULT_GRADING_CONFIG } from "@shared/schema";

// ──────────────────────────────────────────
// Weights & Constants (defaults — overridden by DB config)
// ──────────────────────────────────────────

export const GRADE_WEIGHTS = {
  sales: 30,
  transactions: 15,
  osat: 30,
  speed: 15,
  staffing: 10,
} as const;

export const BONUS_CAP = 15;

export const BONUS_DEFINITIONS = [
  { id: "perfectOsat", label: "Perfect OSAT", points: 3, description: "100% OSAT with 5+ surveys for the day" },
  { id: "highVolumeOsat", label: "High-Volume OSAT", points: 2, description: "85%+ OSAT with 10+ surveys for the day" },
  { id: "salesGrowth", label: "Sales Growth (WoW)", points: 2, description: "Daily sales 5%+ above same day last week" },
  { id: "transactionGrowth", label: "Txn Growth (WoW)", points: 2, description: "Transaction count 5%+ above same day last week" },
  { id: "recoveryKicker", label: "Recovery", points: 2, description: "Had 2+ hours graded C or below, but daily avg still B- or better" },
  { id: "consistency", label: "Consistency", points: 2, description: "No hour graded below B for the entire day" },
  { id: "yoyGrowth", label: "Sales Growth (YoY)", points: 2, description: "Daily sales above same day last year (any amount)" },
  { id: "theCloser", label: "The Closer", points: 4, description: "Hit 4+ of 6 attachment rate targets for the day (+1 pt per category at target)" },
] as const;

export type BonusId = typeof BONUS_DEFINITIONS[number]["id"];

export interface BonusResult {
  id: BonusId;
  label: string;
  points: number;
  description: string;
}

// ──────────────────────────────────────────
// Attachment rate benchmarks (for The Closer bonus)
// ──────────────────────────────────────────

export const ATTACHMENT_BENCHMARKS: Record<string, number> = {
  cheese: 30,
  bacon: 15,
  jalapenos: 10,
  dipping_sauces: 30,
  desserts: 20,
  whatasize: 15,
};

/** Count how many of the 6 attachment categories are at or above their benchmark */
export function countAttachmentCategoriesAtTarget(
  categories: Record<string, { attachRate: number }>,
): number {
  let count = 0;
  for (const [cat, benchmark] of Object.entries(ATTACHMENT_BENCHMARKS)) {
    if (categories[cat] && categories[cat].attachRate >= benchmark) {
      count++;
    }
  }
  return count;
}

// ──────────────────────────────────────────
// Score → Grade conversions
// ──────────────────────────────────────────

export function scoreToGradeLabel(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

export function gradeToMidpoint(grade: string): number {
  const scores: Record<string, number> = {
    "A+": 98, A: 95, "A-": 91, "B+": 88, B: 85, "B-": 81,
    "C+": 78, C: 75, "C-": 71, "D+": 68, D: 65, "D-": 61, F: 30,
  };
  return scores[grade] ?? 0;
}

// ──────────────────────────────────────────
// Grade colors (hex for emails, tailwind for client)
// ──────────────────────────────────────────

export function getGradeColorHex(grade: string): string {
  if (grade.startsWith("A")) return "#16a34a";
  if (grade.startsWith("B")) return "#2563eb";
  if (grade.startsWith("C")) return "#d97706";
  if (grade.startsWith("D")) return "#dc2626";
  return "#dc2626";
}

export function getGradeColorTw(grade: string): string {
  if (grade.startsWith("A")) return "text-green-500";
  if (grade.startsWith("B")) return "text-blue-500";
  if (grade.startsWith("C")) return "text-yellow-500";
  if (grade.startsWith("D")) return "text-orange-500";
  return "text-red-500";
}

export function getGradeBgColorTw(grade: string): string {
  if (grade.startsWith("A")) return "bg-green-500/10 border-green-500/30";
  if (grade.startsWith("B")) return "bg-blue-500/10 border-blue-500/30";
  if (grade.startsWith("C")) return "bg-yellow-500/10 border-yellow-500/30";
  if (grade.startsWith("D")) return "bg-orange-500/10 border-orange-500/30";
  return "bg-red-500/10 border-red-500/30";
}

export function getGradeBadgeColorTw(grade: string): string {
  if (grade.startsWith("A")) return "text-green-500 bg-green-500/10 border-green-500/30";
  if (grade.startsWith("B")) return "text-blue-500 bg-blue-500/10 border-blue-500/30";
  if (grade.startsWith("C")) return "text-yellow-500 bg-yellow-500/10 border-yellow-500/30";
  if (grade.startsWith("D")) return "text-orange-500 bg-orange-500/10 border-orange-500/30";
  return "text-red-500 bg-red-500/10 border-red-500/30";
}

// ──────────────────────────────────────────
// Graduated component scoring
// ──────────────────────────────────────────

/** Generic tier scorer: tiers must be sorted descending by threshold. Falls back to fallbackScore. */
function scoreTiers(value: number, tiers: ScoringTier[], fallbackScore: number): number {
  for (const tier of tiers) {
    if (value >= tier.threshold) return tier.points;
  }
  return fallbackScore;
}

/** Sales variance % → 0-100 score (graduated) */
export function scoreSalesVariance(variancePct: number, tiers?: ScoringTier[]): number {
  return scoreTiers(variancePct, tiers || DEFAULT_GRADING_CONFIG.salesTiers, 40);
}

/** Transaction variance % → 0-100 score (graduated, same curve as sales) */
export function scoreTransactionVariance(variancePct: number, tiers?: ScoringTier[]): number {
  return scoreTiers(variancePct, tiers || DEFAULT_GRADING_CONFIG.transactionTiers, 40);
}

/** OSAT % → 0-100 score (graduated) */
export function scoreOsat(osatPct: number, tiers?: ScoringTier[]): number {
  return scoreTiers(osatPct, tiers || DEFAULT_GRADING_CONFIG.osatTiers, 40);
}

/** Speed attainment % → 0-100 score */
export function scoreSpeed(attainmentPct: number, tiers?: ScoringTier[]): number {
  return scoreTiers(attainmentPct, tiers || DEFAULT_GRADING_CONFIG.speedTiers, 40);
}

/** Staffing diff → 0-100 score */
export function scoreStaffing(staffingDiff: number, isSalesSurge: boolean, tolerance?: number, inScore?: number, outScore?: number): number {
  const tol = tolerance ?? DEFAULT_GRADING_CONFIG.staffingTolerance;
  const good = inScore ?? DEFAULT_GRADING_CONFIG.staffingInToleranceScore;
  const bad = outScore ?? DEFAULT_GRADING_CONFIG.staffingOutToleranceScore;
  if (staffingDiff > tol) return bad; // overstaffed
  if (staffingDiff < -tol && !isSalesSurge) return bad; // understaffed (no surge excuse)
  return good;
}

// ──────────────────────────────────────────
// Hourly execution score (weighted components)
// ──────────────────────────────────────────

interface GradeComponent {
  score: number;
  weight: number;
}

export interface HourlyScoreInput {
  salesVariancePct: number;
  hasComparableSales: boolean;
  transactionVariancePct?: number;
  hasComparableTransactions?: boolean;
  osatPercent?: number;
  osatResponses?: number;
  speedAttainment?: number;
  staffingDiff: number;
  hasValidStaffing: boolean;
}

export interface HourlyScoreResult {
  score: number;
  grade: string;
  hasGrade: boolean;
  components: { name: string; score: number; weight: number }[];
}

export function computeHourlyScore(input: HourlyScoreInput, cfg?: GradingConfigData): HourlyScoreResult {
  const c = cfg || DEFAULT_GRADING_CONFIG;
  const w = c.weights;
  const components: { name: string; score: number; weight: number }[] = [];

  // Sales
  if (input.hasComparableSales) {
    components.push({ name: "sales", score: scoreSalesVariance(input.salesVariancePct, c.salesTiers), weight: w.sales });
  } else {
    components.push({ name: "sales", score: 90, weight: w.sales }); // benefit of the doubt
  }

  // Transactions
  if (input.hasComparableTransactions && input.transactionVariancePct !== undefined) {
    components.push({ name: "transactions", score: scoreTransactionVariance(input.transactionVariancePct, c.transactionTiers), weight: w.transactions });
  }

  // OSAT
  if (input.osatPercent !== undefined && input.osatPercent > 0 && (input.osatResponses === undefined || input.osatResponses > 0)) {
    components.push({ name: "osat", score: scoreOsat(input.osatPercent, c.osatTiers), weight: w.osat });
  }

  // Speed
  if (input.speedAttainment !== undefined && input.speedAttainment >= 0) {
    components.push({ name: "speed", score: scoreSpeed(input.speedAttainment, c.speedTiers), weight: w.speed });
  }

  // Staffing
  if (input.hasValidStaffing) {
    const isSurge = input.salesVariancePct >= 20 || !input.hasComparableSales;
    components.push({ name: "staffing", score: scoreStaffing(input.staffingDiff, isSurge, c.staffingTolerance, c.staffingInToleranceScore, c.staffingOutToleranceScore), weight: w.staffing });
  }

  if (components.length === 0) {
    return { score: 0, grade: "-", hasGrade: false, components: [] };
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;
  const grade = scoreToGradeLabel(score);

  return { score, grade, hasGrade: true, components };
}

// ──────────────────────────────────────────
// Daily bonus points
// ──────────────────────────────────────────

export interface DailyBonusInput {
  /** Daily total OSAT % */
  dailyOsatPercent?: number;
  /** Total survey count for the day */
  dailySurveyCount?: number;
  /** Daily sales variance % vs last week */
  dailySalesVariancePct?: number;
  /** Daily transaction variance % vs last week */
  dailyTransactionVariancePct?: number;
  /** Daily sales variance % vs same day last year (YoY) */
  dailyYoySalesVariancePct?: number;
  /** Number of attachment rate categories at or above target (0-6) */
  attachmentCategoriesAtTarget?: number;
  /** Array of hourly grade scores for the day */
  hourlyScores: number[];
}

export interface DailyBonusResult {
  bonuses: BonusResult[];
  totalBonus: number;
  cappedBonus: number;
}

export function computeDailyBonuses(input: DailyBonusInput): DailyBonusResult {
  const bonuses: BonusResult[] = [];

  // Perfect OSAT: 100% with ≥5 surveys
  if (input.dailyOsatPercent !== undefined && input.dailyOsatPercent >= 100 && (input.dailySurveyCount ?? 0) >= 5) {
    bonuses.push({ ...BONUS_DEFINITIONS[0] });
  }
  // High-volume OSAT: ≥85% with ≥10 surveys (not additive with perfect — only if not already perfect)
  else if (input.dailyOsatPercent !== undefined && input.dailyOsatPercent >= 85 && (input.dailySurveyCount ?? 0) >= 10) {
    bonuses.push({ ...BONUS_DEFINITIONS[1] });
  }

  // Sales growth: ≥+5% vs last week
  if (input.dailySalesVariancePct !== undefined && input.dailySalesVariancePct >= 5) {
    bonuses.push({ ...BONUS_DEFINITIONS[2] });
  }

  // Transaction growth: ≥+5% vs last week
  if (input.dailyTransactionVariancePct !== undefined && input.dailyTransactionVariancePct >= 5) {
    bonuses.push({ ...BONUS_DEFINITIONS[3] });
  }

  // YoY sales growth: above last year by any amount
  if (input.dailyYoySalesVariancePct !== undefined && input.dailyYoySalesVariancePct > 0) {
    bonuses.push({ ...BONUS_DEFINITIONS[5] });
  }

  // Consistency: no hour below B (83)
  if (input.hourlyScores.length >= 4 && input.hourlyScores.every(s => s >= 83)) {
    bonuses.push({ ...BONUS_DEFINITIONS[4] });
  }

  // The Closer: 1 bonus point per attachment category at target, requires 4+/6
  if (input.attachmentCategoriesAtTarget !== undefined && input.attachmentCategoriesAtTarget >= 4) {
    bonuses.push({ ...BONUS_DEFINITIONS[6], points: input.attachmentCategoriesAtTarget });
  }

  const totalBonus = bonuses.reduce((sum, b) => sum + b.points, 0);
  const cappedBonus = Math.min(totalBonus, BONUS_CAP);

  return { bonuses, totalBonus, cappedBonus };
}

// ──────────────────────────────────────────
// Daily execution score (hourly avg + bonus)
// ──────────────────────────────────────────

export interface DailyScoreResult {
  baseScore: number;
  bonusResult: DailyBonusResult;
  finalScore: number;
  grade: string;
  hasGrade: boolean;
}

export function computeDailyScore(
  hourlyScores: number[],
  bonusInput: DailyBonusInput,
): DailyScoreResult {
  if (hourlyScores.length === 0) {
    return {
      baseScore: 0,
      bonusResult: { bonuses: [], totalBonus: 0, cappedBonus: 0 },
      finalScore: 0,
      grade: "-",
      hasGrade: false,
    };
  }

  const baseScore = hourlyScores.reduce((a, b) => a + b, 0) / hourlyScores.length;
  const bonusResult = computeDailyBonuses(bonusInput);
  const finalScore = Math.min(baseScore + bonusResult.cappedBonus, 100);
  const grade = scoreToGradeLabel(finalScore);

  return { baseScore, bonusResult, finalScore, grade, hasGrade: true };
}

// ──────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatPercentage(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${Math.round(value)}%`;
}

export function formatSignedCurrency(amount: number): string {
  const sign = amount >= 0 ? "+" : "";
  return `${sign}${formatCurrency(amount)}`;
}
