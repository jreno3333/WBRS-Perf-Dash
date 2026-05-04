// Pure grading-config types and defaults shared between client and server.
//
// This file deliberately has zero imports from drizzle-orm / drizzle-zod /
// the rest of @shared/schema. The previous setup re-exported these constants
// from schema.ts, which forced the client bundle to ship ~110 kB of drizzle
// table definitions whenever any page imported DEFAULT_GRADING_CONFIG. Keep
// this file dependency-free.

export interface ScoringTier {
  threshold: number;
  points: number;
}

export interface GradingConfigData {
  weights: {
    sales: number;
    transactions: number;
    osat: number;
    speed: number;
    staffing: number;
    feedbackSpeed: number;
  };
  salesTiers: ScoringTier[];
  transactionTiers: ScoringTier[];
  osatTiers: ScoringTier[];
  speedTiers: ScoringTier[];
  feedbackSpeedTiers: ScoringTier[];
  staffingTolerance: number;
  staffingInToleranceScore: number;
  staffingOutToleranceScore: number;
}

export const DEFAULT_FEEDBACK_SPEED_TIERS: ScoringTier[] = [
  { threshold: 90, points: 100 },
  { threshold: 80, points: 70 },
];

export const DEFAULT_GRADING_CONFIG: GradingConfigData = {
  weights: { sales: 30, transactions: 15, osat: 30, speed: 15, staffing: 10, feedbackSpeed: 0 },
  salesTiers: [
    { threshold: 10, points: 100 },
    { threshold: 5, points: 95 },
    { threshold: 0, points: 90 },
    { threshold: -5, points: 80 },
    { threshold: -10, points: 60 },
  ],
  transactionTiers: [
    { threshold: 10, points: 100 },
    { threshold: 5, points: 95 },
    { threshold: 0, points: 90 },
    { threshold: -5, points: 80 },
    { threshold: -10, points: 60 },
  ],
  osatTiers: [
    { threshold: 90, points: 100 },
    { threshold: 85, points: 90 },
    { threshold: 80, points: 70 },
    { threshold: 75, points: 50 },
  ],
  speedTiers: [
    { threshold: 70, points: 100 },
    { threshold: 50, points: 70 },
  ],
  feedbackSpeedTiers: DEFAULT_FEEDBACK_SPEED_TIERS,
  staffingTolerance: 1,
  staffingInToleranceScore: 100,
  staffingOutToleranceScore: 60,
};

/**
 * Merge a stored grading config (which may be from an older schema) with the
 * current defaults. New fields like feedbackSpeed weight and feedbackSpeedTiers
 * are filled in so existing rows continue to load without a migration.
 */
export function mergeGradingConfig(stored: Partial<GradingConfigData> | null | undefined): GradingConfigData {
  const d = DEFAULT_GRADING_CONFIG;
  if (!stored) return d;
  return {
    weights: {
      sales: stored.weights?.sales ?? d.weights.sales,
      transactions: stored.weights?.transactions ?? d.weights.transactions,
      osat: stored.weights?.osat ?? d.weights.osat,
      speed: stored.weights?.speed ?? d.weights.speed,
      staffing: stored.weights?.staffing ?? d.weights.staffing,
      feedbackSpeed: stored.weights?.feedbackSpeed ?? d.weights.feedbackSpeed,
    },
    salesTiers: stored.salesTiers ?? d.salesTiers,
    transactionTiers: stored.transactionTiers ?? d.transactionTiers,
    osatTiers: stored.osatTiers ?? d.osatTiers,
    speedTiers: stored.speedTiers ?? d.speedTiers,
    feedbackSpeedTiers: stored.feedbackSpeedTiers ?? d.feedbackSpeedTiers,
    staffingTolerance: stored.staffingTolerance ?? d.staffingTolerance,
    staffingInToleranceScore: stored.staffingInToleranceScore ?? d.staffingInToleranceScore,
    staffingOutToleranceScore: stored.staffingOutToleranceScore ?? d.staffingOutToleranceScore,
  };
}
