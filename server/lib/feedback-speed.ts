/**
 * Helpers for deriving the customer-feedback speed metric from a daily OSAT
 * row. Mirrors the source-selection logic used by the leaderboard badge:
 *   - Store 1682 (Cumberland Avenue) has no drive-thru, so it falls back to
 *     the generic Speed of Service question.
 *   - All other stores use the DT Speed of Service question.
 *
 * Methodology matches OSAT and the Qualtrics dashboard: 5-star top-box %.
 */

export interface FeedbackSpeedSource {
  topBoxPercent: number;
  fiveStarCount: number;
  responses: number;
  source: "dt" | "generic";
}

export interface DailyFeedbackSpeedRow {
  dtSpeedResponses: number;
  dtSpeedFiveStarCount: number;
  genericSpeedResponses: number;
  genericSpeedFiveStarCount: number;
}

export function isFeedbackSpeedGenericStore(unitNumber: string | null | undefined): boolean {
  return unitNumber === "1682";
}

export function deriveFeedbackSpeed(
  row: DailyFeedbackSpeedRow | null | undefined,
  unitNumber: string | null | undefined,
): FeedbackSpeedSource {
  const useGeneric = isFeedbackSpeedGenericStore(unitNumber);
  const source: "dt" | "generic" = useGeneric ? "generic" : "dt";
  if (!row) return { topBoxPercent: 0, fiveStarCount: 0, responses: 0, source };
  const responses = useGeneric ? row.genericSpeedResponses : row.dtSpeedResponses;
  const fiveStar = useGeneric ? row.genericSpeedFiveStarCount : row.dtSpeedFiveStarCount;
  if (!responses || responses <= 0) {
    return { topBoxPercent: 0, fiveStarCount: 0, responses: 0, source };
  }
  return {
    topBoxPercent: (fiveStar / responses) * 100,
    fiveStarCount: fiveStar,
    responses,
    source,
  };
}
