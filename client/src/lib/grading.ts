/**
 * Shared Execution Grade Utilities (Client-Side)
 *
 * Mirrors the server-side scoring module (server/lib/scoring.ts).
 * Graduated scoring with 5 weighted components + daily bonus points.
 *
 * WEIGHTS: Sales 30%, Transactions 15%, OSAT 30%, Speed 15%, Staffing 10%
 */

export const GRADE_WEIGHTS = { sales: 30, transactions: 15, osat: 30, speed: 15, staffing: 10 } as const;

export const BONUS_CAP = 10;

export const BONUS_DEFINITIONS = [
  { id: "perfectOsat", label: "Perfect OSAT", points: 3, description: "100% OSAT with 5+ surveys for the day" },
  { id: "highVolumeOsat", label: "High-Volume OSAT", points: 2, description: "85%+ OSAT with 10+ surveys for the day" },
  { id: "salesGrowth", label: "Sales Growth", points: 2, description: "Daily sales 5%+ above same day last week" },
  { id: "transactionGrowth", label: "Transaction Growth", points: 2, description: "Transaction count 5%+ above same day last week" },
  { id: "recoveryKicker", label: "Recovery", points: 3, description: "Had 2+ hours graded C or below, but daily avg still B- or better" },
  { id: "consistency", label: "Consistency", points: 2, description: "No hour graded below B for the entire day" },
  { id: "yoyGrowth", label: "YoY Growth", points: 2, description: "Daily sales above same day last year (any amount)" },
  { id: "theCloser", label: "The Closer", points: 4, description: "Hit 4+ of 6 attachment rate targets for the day (+1 pt per category at target)" },
] as const;

export type BonusId = typeof BONUS_DEFINITIONS[number]["id"];

export interface BonusResult {
  id: BonusId;
  label: string;
  points: number;
  description: string;
}

export interface DailyBonusResult {
  bonuses: BonusResult[];
  totalBonus: number;
  cappedBonus: number;
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
// Score <-> Grade conversions
// ──────────────────────────────────────────

export function scoreToGradeLabel(score: number): string {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}

/** Midpoint numeric value for a given letter grade (for averaging). */
export function gradeToMidpoint(grade: string): number {
  const scores: Record<string, number> = {
    'A+': 98, 'A': 95, 'A-': 91, 'B+': 88, 'B': 85, 'B-': 81,
    'C+': 78, 'C': 75, 'C-': 71, 'D+': 68, 'D': 65, 'D-': 61, 'F': 30,
  };
  return scores[grade] ?? 0;
}

// ──────────────────────────────────────────
// Grade colors
// ──────────────────────────────────────────

export function getGradeColor(grade: string): string {
  if (grade.startsWith('A')) return 'text-green-500';
  if (grade.startsWith('B')) return 'text-blue-500';
  if (grade.startsWith('C')) return 'text-yellow-500';
  if (grade.startsWith('D')) return 'text-orange-500';
  return 'text-red-500';
}

export function getGradeBgColor(grade: string): string {
  if (grade.startsWith('A')) return 'bg-green-500/10 border-green-500/30';
  if (grade.startsWith('B')) return 'bg-blue-500/10 border-blue-500/30';
  if (grade.startsWith('C')) return 'bg-yellow-500/10 border-yellow-500/30';
  if (grade.startsWith('D')) return 'bg-orange-500/10 border-orange-500/30';
  return 'bg-red-500/10 border-red-500/30';
}

export function getGradeBadgeColor(grade: string): string {
  if (grade.startsWith('A')) return 'text-green-500 bg-green-500/10 border-green-500/30';
  if (grade.startsWith('B')) return 'text-blue-500 bg-blue-500/10 border-blue-500/30';
  if (grade.startsWith('C')) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30';
  if (grade.startsWith('D')) return 'text-orange-500 bg-orange-500/10 border-orange-500/30';
  return 'text-red-500 bg-red-500/10 border-red-500/30';
}

// ──────────────────────────────────────────
// Graduated component scoring
// ──────────────────────────────────────────

/** Sales variance % → 0-100 score (graduated) */
export function scoreSalesVariance(variancePct: number): number {
  if (variancePct >= 10) return 100;
  if (variancePct >= 5) return 95;
  if (variancePct >= 0) return 90;
  if (variancePct >= -5) return 80;
  if (variancePct >= -10) return 60;
  return 40;
}

/** Transaction variance % → 0-100 score (graduated) */
export function scoreTransactionVariance(variancePct: number): number {
  if (variancePct >= 10) return 100;
  if (variancePct >= 5) return 95;
  if (variancePct >= 0) return 90;
  if (variancePct >= -5) return 80;
  if (variancePct >= -10) return 60;
  return 40;
}

/** OSAT % → 0-100 score (graduated) */
export function scoreOsat(osatPct: number): number {
  if (osatPct >= 90) return 100;
  if (osatPct >= 85) return 90;
  if (osatPct >= 80) return 70;
  if (osatPct >= 75) return 50;
  return 40;
}

/** Speed attainment % → 0-100 score */
export function scoreSpeed(attainmentPct: number): number {
  if (attainmentPct >= 70) return 100;
  if (attainmentPct >= 50) return 70;
  return 40;
}

/** Staffing diff → 0-100 score */
export function scoreStaffing(staffingDiff: number, isSalesSurge: boolean): number {
  if (staffingDiff > 1) return 60;
  if (staffingDiff < -1 && !isSalesSurge) return 60;
  return 100;
}

// ──────────────────────────────────────────
// Weighted execution grade calculation
// ──────────────────────────────────────────

/**
 * Compute the weighted execution grade score (0-100 numeric).
 * Returns 0 when no components are available.
 */
export function computeExecutionScore(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales: boolean,
  hasValidStaffing: boolean,
  osatPercent: number | undefined,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
): number {
  const components: { score: number; weight: number }[] = [];

  // Sales (30%)
  if (hasComparableSales) {
    components.push({ score: scoreSalesVariance(salesVariancePct), weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ score: 90, weight: GRADE_WEIGHTS.sales });
  }

  // Transactions (15%)
  if (hasComparableTransactions && transactionVariancePct !== undefined) {
    components.push({ score: scoreTransactionVariance(transactionVariancePct), weight: GRADE_WEIGHTS.transactions });
  }

  // OSAT (30%)
  if (osatPercent !== undefined && osatPercent > 0) {
    components.push({ score: scoreOsat(osatPercent), weight: GRADE_WEIGHTS.osat });
  }

  // Speed (15%)
  if (speedAttainment !== undefined && speedAttainment >= 0) {
    components.push({ score: scoreSpeed(speedAttainment), weight: GRADE_WEIGHTS.speed });
  }

  // Staffing (10%)
  if (hasValidStaffing) {
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    components.push({ score: scoreStaffing(staffingDiff, isSalesSurge), weight: GRADE_WEIGHTS.staffing });
  }

  if (components.length === 0) return 0;
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  return components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;
}

/**
 * Full execution grade result (label + color + hasGrade flag).
 */
export function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales = true,
  hasValidStaffing = true,
  osatPercent: number | undefined = undefined,
  transactionVariancePct?: number,
  hasComparableTransactions?: boolean,
): { grade: string; color: string; score: number; hasGrade: boolean } {
  const score = computeExecutionScore(
    salesVariancePct, speedAttainment, staffingDiff,
    hasComparableSales, hasValidStaffing, osatPercent,
    transactionVariancePct, hasComparableTransactions,
  );
  if (score === 0) {
    return { grade: '-', color: 'text-muted-foreground', score: 0, hasGrade: false };
  }
  const grade = scoreToGradeLabel(score);
  return { grade, color: getGradeColor(grade), score, hasGrade: true };
}

// ──────────────────────────────────────────
// Daily bonus points
// ──────────────────────────────────────────

export interface DailyBonusInput {
  dailyOsatPercent?: number;
  dailySurveyCount?: number;
  dailySalesVariancePct?: number;
  dailyTransactionVariancePct?: number;
  dailyYoySalesVariancePct?: number;
  /** Number of attachment rate categories at or above target (0-6) */
  attachmentCategoriesAtTarget?: number;
  hourlyScores: number[];
}

export function computeDailyBonuses(input: DailyBonusInput): DailyBonusResult {
  const bonuses: BonusResult[] = [];

  // Perfect OSAT: 100% with ≥5 surveys
  if (input.dailyOsatPercent !== undefined && input.dailyOsatPercent >= 100 && (input.dailySurveyCount ?? 0) >= 5) {
    bonuses.push({ ...BONUS_DEFINITIONS[0] });
  }
  // High-volume OSAT: ≥85% with ≥10 surveys (only if not perfect)
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
    bonuses.push({ ...BONUS_DEFINITIONS[6] });
  }

  // Recovery kicker: ≥2 hours at C or below (<77), but daily avg ≥ B- (80)
  if (input.hourlyScores.length >= 4) {
    const badHours = input.hourlyScores.filter(s => s < 77).length;
    const dailyAvg = input.hourlyScores.reduce((a, b) => a + b, 0) / input.hourlyScores.length;
    if (badHours >= 2 && dailyAvg >= 80) {
      bonuses.push({ ...BONUS_DEFINITIONS[4] });
    }
  }

  // Consistency: no hour below B (83)
  if (input.hourlyScores.length >= 4 && input.hourlyScores.every(s => s >= 83)) {
    bonuses.push({ ...BONUS_DEFINITIONS[5] });
  }

  // The Closer: 1 bonus point per attachment category at target, requires 4+/6
  if (input.attachmentCategoriesAtTarget !== undefined && input.attachmentCategoriesAtTarget >= 4) {
    bonuses.push({ ...BONUS_DEFINITIONS[7], points: input.attachmentCategoriesAtTarget });
  }

  const totalBonus = bonuses.reduce((sum, b) => sum + b.points, 0);
  const cappedBonus = Math.min(totalBonus, BONUS_CAP);

  return { bonuses, totalBonus, cappedBonus };
}

// ──────────────────────────────────────────
// Shared formatters (avoid creating Intl.NumberFormat per render)
// ──────────────────────────────────────────

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatCurrency(amount: number): string {
  return currencyFormatter.format(amount);
}

export function formatPercentage(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${Math.round(value)}%`;
}

export function formatSignedCurrency(amount: number): string {
  const sign = amount >= 0 ? "+" : "";
  return `${sign}${formatCurrency(amount)}`;
}
