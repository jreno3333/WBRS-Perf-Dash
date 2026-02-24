/**
 * Shared Execution Grade Utilities
 *
 * Centralizes grade calculation logic that was duplicated across
 * dashboard.tsx, leaderboard-card.tsx, summary-cards.tsx,
 * state-breakdown.tsx, market-breakdown.tsx, and daily-summary.tsx.
 *
 * WEIGHTS: Sales 35%, Speed 25%, OSAT 25%, Staffing 15%
 */

export const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 } as const;

// ──────────────────────────────────────────
// Score <-> Grade conversions
// ──────────────────────────────────────────

export function scoreToGradeLabel(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  return 'F';
}

/** Midpoint numeric value for a given letter grade (for averaging). */
export function gradeToMidpoint(grade: string): number {
  const scores: Record<string, number> = {
    'A+': 97, 'A': 92, 'A-': 87, 'B+': 82, 'B': 77, 'B-': 72,
    'C+': 67, 'C': 62, 'C-': 57, 'D': 52, 'F': 25,
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
  if (grade === 'D') return 'text-orange-500';
  return 'text-red-500';
}

export function getGradeBgColor(grade: string): string {
  if (grade.startsWith('A')) return 'bg-green-500/10 border-green-500/30';
  if (grade.startsWith('B')) return 'bg-blue-500/10 border-blue-500/30';
  if (grade.startsWith('C')) return 'bg-yellow-500/10 border-yellow-500/30';
  if (grade === 'D') return 'bg-orange-500/10 border-orange-500/30';
  return 'bg-red-500/10 border-red-500/30';
}

export function getGradeBadgeColor(grade: string): string {
  if (grade.startsWith('A')) return 'text-green-500 bg-green-500/10 border-green-500/30';
  if (grade.startsWith('B')) return 'text-blue-500 bg-blue-500/10 border-blue-500/30';
  if (grade.startsWith('C')) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30';
  if (grade === 'D') return 'text-orange-500 bg-orange-500/10 border-orange-500/30';
  return 'text-red-500 bg-red-500/10 border-red-500/30';
}

// ──────────────────────────────────────────
// Weighted execution grade calculation
// ──────────────────────────────────────────

interface GradeComponent {
  score: number;
  weight: number;
}

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
): number {
  const components: GradeComponent[] = [];

  // Sales (35%)
  if (hasComparableSales) {
    components.push({ score: salesVariancePct >= -5 ? 100 : 50, weight: GRADE_WEIGHTS.sales });
  } else {
    components.push({ score: 100, weight: GRADE_WEIGHTS.sales });
  }

  // Speed (25%)
  if (speedAttainment !== undefined && speedAttainment >= 0) {
    let speedScore = 100;
    if (speedAttainment < 50) speedScore = 40;
    else if (speedAttainment < 70) speedScore = 70;
    components.push({ score: speedScore, weight: GRADE_WEIGHTS.speed });
  }

  // OSAT (25%)
  if (osatPercent !== undefined && osatPercent > 0) {
    let osatScore = 100;
    if (osatPercent < 80) osatScore = 40;
    else if (osatPercent < 85) osatScore = 70;
    components.push({ score: osatScore, weight: GRADE_WEIGHTS.osat });
  }

  // Staffing (15%)
  if (hasValidStaffing) {
    let staffingScore = 100;
    const isSalesSurge = salesVariancePct >= 20 || !hasComparableSales;
    if (staffingDiff > 1) staffingScore = 60;
    else if (staffingDiff < -1 && !isSalesSurge) staffingScore = 60;
    components.push({ score: staffingScore, weight: GRADE_WEIGHTS.staffing });
  }

  if (components.length === 0) return 0;
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  return components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;
}

/**
 * Full execution grade result (label + color + hasGrade flag).
 * This is what leaderboard-card.tsx and others use for display.
 */
export function getExecutionGrade(
  salesVariancePct: number,
  speedAttainment: number | undefined,
  staffingDiff: number,
  hasComparableSales = true,
  hasValidStaffing = true,
  osatPercent: number | undefined = undefined,
): { grade: string; color: string; score: number; hasGrade: boolean } {
  const score = computeExecutionScore(
    salesVariancePct, speedAttainment, staffingDiff,
    hasComparableSales, hasValidStaffing, osatPercent,
  );
  if (score === 0) {
    return { grade: '-', color: 'text-muted-foreground', score: 0, hasGrade: false };
  }
  const grade = scoreToGradeLabel(score);
  return { grade, color: getGradeColor(grade), score, hasGrade: true };
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
