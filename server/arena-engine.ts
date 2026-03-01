/**
 * Arena Engine — Grade Computation Utilities
 *
 * Exports grade computation functions used by other modules.
 */

import { computeHourlyScore, scoreToGradeLabel as sharedScoreToGradeLabel } from "./lib/scoring";

// ─── GRADE COMPUTATION (extracted from leaders.ts) ───

export const getGradeLabel = sharedScoreToGradeLabel;

export function gradeToMinScore(grade: string): number {
  const map: Record<string, number> = {
    "A+": 97, A: 93, "A-": 90, "B+": 87, B: 83, "B-": 80,
    "C+": 77, C: 73, "C-": 70, "D+": 67, D: 63, "D-": 60, F: 0,
  };
  return map[grade] ?? 0;
}

export interface HourlyMetrics {
  actualSales: number;
  lastWeekSales: number;
  actualStaff: number;
  projectedStaff: number;
  avgDtTime: number | null; // seconds
  osatPercent: number | null;
  osatResponses: number;
}

export function computeHourlyGradeScore(m: HourlyMetrics): number {
  const hasComparableSales = m.lastWeekSales > 0;
  const salesVariancePct = hasComparableSales
    ? ((m.actualSales - m.lastWeekSales) / m.lastWeekSales) * 100 : 0;

  const hasValidAttainment = m.avgDtTime !== null && m.avgDtTime > 0;
  // Convert DT seconds to attainment % (under 300s = 100%, 300-420 = 70%, >420 = 40%)
  let speedAttainment: number | undefined = undefined;
  if (hasValidAttainment) {
    speedAttainment = m.avgDtTime! <= 300 ? 100 : m.avgDtTime! <= 420 ? 65 : 30;
  }

  const result = computeHourlyScore({
    salesVariancePct,
    hasComparableSales,
    speedAttainment,
    staffingDiff: m.actualStaff - m.projectedStaff,
    hasValidStaffing: true,
    osatPercent: m.osatPercent !== null && m.osatResponses > 0 ? m.osatPercent : undefined,
    osatResponses: m.osatResponses,
  });

  return result.score;
}
