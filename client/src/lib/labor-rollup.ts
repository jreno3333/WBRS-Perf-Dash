import type { RestaurantSales, HourlySalesData } from "@shared/schema";

export interface WeeklyLaborInput {
  restaurants?: Record<string, { currentWeek: number; wtdLaborCost?: number }>;
}

export interface GroupLaborTarget {
  dayTarget: number;
  dayTargetSource: "plan" | "default";
  dayTargetCoverage: number; // count of stores contributing plan rows
  wtdTarget: number;
  wtdTargetSource: "plan" | "default";
  wtdTargetCoverage: number;
}

export interface GroupLaborMetrics {
  dayLaborCost: number;
  daySales: number;
  dayLaborPct: number | null;
  wtdLaborCost: number;
  wtdSales: number;
  wtdLaborPct: number | null;
}

const FALLBACK_TARGET = 25;

// Sales-weighted plan labor target for a group of restaurants. Each unit's
// `dayPlanLaborPct` / `wtdPlanLaborPct` is weighted by its planned net sales
// for the same window so the rollup matches the per-unit cards (which use
// the same plan %). When a unit has a plan % but no usable plan-net-sales
// weight, we fall back to its actual sales as the weight so it still
// contributes to the group target — keeping the rollup consistent with the
// unit card. When no unit in the group has a plan % at all we fall back to
// 25% so the rollup matches the unit-card default behaviour.
export function computeGroupLaborTarget(restaurants: RestaurantSales[]): GroupLaborTarget {
  let dayWeighted = 0;
  let dayWeight = 0;
  let dayCoverage = 0;
  let wtdWeighted = 0;
  let wtdWeight = 0;
  let wtdCoverage = 0;

  for (const r of restaurants) {
    if (r.dayPlanLaborPct != null) {
      const weight =
        r.dayPlanNetSales != null && r.dayPlanNetSales > 0
          ? r.dayPlanNetSales
          : r.actualSales > 0
          ? r.actualSales
          : 0;
      if (weight > 0) {
        dayWeighted += r.dayPlanLaborPct * weight;
        dayWeight += weight;
        dayCoverage += 1;
      }
    }
    if (r.wtdPlanLaborPct != null) {
      const weight =
        r.wtdPlanNetSales != null && r.wtdPlanNetSales > 0
          ? r.wtdPlanNetSales
          : r.actualSales > 0
          ? r.actualSales
          : 0;
      if (weight > 0) {
        wtdWeighted += r.wtdPlanLaborPct * weight;
        wtdWeight += weight;
        wtdCoverage += 1;
      }
    }
  }

  const dayTarget = dayWeight > 0 ? dayWeighted / dayWeight : FALLBACK_TARGET;
  const wtdTarget = wtdWeight > 0 ? wtdWeighted / wtdWeight : FALLBACK_TARGET;

  return {
    dayTarget: Math.round(dayTarget * 10) / 10,
    dayTargetSource: dayWeight > 0 ? "plan" : "default",
    dayTargetCoverage: dayCoverage,
    wtdTarget: Math.round(wtdTarget * 10) / 10,
    wtdTargetSource: wtdWeight > 0 ? "plan" : "default",
    wtdTargetCoverage: wtdCoverage,
  };
}

// Sum the day's actual labor dollars across hourly rows for the supplied
// restaurants. Mirrors the per-unit math in the leaderboard card so the
// rollup % matches the underlying unit cards.
export function computeGroupLaborMetrics(
  restaurants: RestaurantSales[],
  hourlyByRestaurant?: Record<string, HourlySalesData[]>,
  weeklySalesData?: WeeklyLaborInput,
): GroupLaborMetrics {
  let dayLaborCost = 0;
  let daySales = 0;
  let wtdLaborCost = 0;
  let wtdSales = 0;

  for (const r of restaurants) {
    daySales += r.actualSales || 0;
    if (hourlyByRestaurant) {
      const hours = hourlyByRestaurant[r.restaurantId];
      if (hours) {
        for (const hour of hours) {
          dayLaborCost += hour.actualLabor || 0;
        }
      }
    }
    if (weeklySalesData?.restaurants) {
      const wk = weeklySalesData.restaurants[r.restaurantId];
      if (wk) {
        wtdSales += wk.currentWeek || 0;
        wtdLaborCost += wk.wtdLaborCost || 0;
      }
    }
  }

  return {
    dayLaborCost,
    daySales,
    dayLaborPct: daySales > 0 && dayLaborCost > 0 ? (dayLaborCost / daySales) * 100 : null,
    wtdLaborCost,
    wtdSales,
    wtdLaborPct: wtdSales > 0 && wtdLaborCost > 0 ? (wtdLaborCost / wtdSales) * 100 : null,
  };
}

export function laborTargetTooltip(target: number, source: "plan" | "default", coverage?: number): string {
  if (source === "plan") {
    return coverage && coverage > 0
      ? `Plan target ${target.toFixed(1)}% (sales-weighted across ${coverage} ${coverage === 1 ? "store" : "stores"})`
      : `Plan target ${target.toFixed(1)}%`;
  }
  return `Default target ${target.toFixed(1)}% (no plan rows)`;
}
