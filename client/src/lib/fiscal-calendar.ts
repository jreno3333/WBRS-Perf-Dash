// Fiscal calendar helper for MWB.
//
// Structure (confirmed with the user):
//   - Fiscal year starts in October.
//   - 4 quarters per FY, each containing 3 periods.
//   - Period lengths within each quarter follow a 4-4-5 weeks pattern.
//   - Business week is Saturday → Friday (matches the rest of the app).
//
// Anchor: FY2026 Q1 Period 1 begins Saturday October 4, 2025.
// FY2026 Q3 Period 1 begins Saturday April 4, 2026 (matches the user's Q3
// sales-plan workbook).
//
// The helper does plain date math in UTC to stay TZ-stable; we only ever
// compare dates (not times), so all "today" inputs should be passed as a
// YYYY-MM-DD string in the user's reporting timezone (Central).

const ANCHOR_FY = 2026;
// Saturday Oct 4, 2025 = first day of FY2026.
const ANCHOR_UTC_MS = Date.UTC(2025, 9, 4); // months are 0-indexed

// 4-4-5 pattern, 12 periods total per FY (no 53rd-week adjustment for now).
const PERIOD_WEEKS = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];
const WEEKS_PER_FY = PERIOD_WEEKS.reduce((a, b) => a + b, 0); // 52
const MS_PER_DAY = 86400000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export interface FiscalPosition {
  fiscalYear: number;     // e.g. 2026
  quarter: number;        // 1..4
  period: number;         // 1..12
  periodInQuarter: number;// 1..3
  weekInPeriod: number;   // 1..N (N = 4 or 5)
  weeksInPeriod: number;  // 4 or 5
  dayInWeek: number;      // 1..7 (1 = Saturday)
  periodStart: string;    // YYYY-MM-DD
  periodEnd: string;      // YYYY-MM-DD (inclusive)
  quarterStart: string;
  quarterEnd: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  daysLeftInPeriod: number;   // including today
  weeksLeftInPeriod: number;  // ceil(daysLeftInPeriod / 7)
  daysLeftInQuarter: number;
  weeksLeftInQuarter: number;
}

function toUtcMidnight(dateStr: string): number {
  // Accepts YYYY-MM-DD; ignores any trailing time portion.
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmt(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns "today" in Central time as a YYYY-MM-DD string. Match the rest of
 * the dashboard, which keys all date math off Central.
 */
export function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/**
 * Compute the fiscal position for a given YYYY-MM-DD date.
 */
export function getFiscalPosition(dateStr: string = todayCentral()): FiscalPosition {
  const todayMs = toUtcMidnight(dateStr);
  const daysSinceAnchor = Math.floor((todayMs - ANCHOR_UTC_MS) / MS_PER_DAY);

  // Walk full FYs forward/backward until we land inside one.
  let fyOffset = Math.floor(daysSinceAnchor / (WEEKS_PER_FY * 7));
  let weeksIntoFy = Math.floor((daysSinceAnchor - fyOffset * WEEKS_PER_FY * 7) / 7);
  let dayInWeek = (daysSinceAnchor - fyOffset * WEEKS_PER_FY * 7) - weeksIntoFy * 7 + 1; // 1..7

  // Normalize negatives (dates before anchor) — flip into prior FYs cleanly.
  while (weeksIntoFy < 0) {
    weeksIntoFy += WEEKS_PER_FY;
    fyOffset -= 1;
  }
  while (dayInWeek < 1) {
    dayInWeek += 7;
    weeksIntoFy -= 1;
    if (weeksIntoFy < 0) {
      weeksIntoFy += WEEKS_PER_FY;
      fyOffset -= 1;
    }
  }

  const fiscalYear = ANCHOR_FY + fyOffset;
  const fyStartMs = ANCHOR_UTC_MS + fyOffset * WEEKS_PER_FY * MS_PER_WEEK;

  // Walk period lengths to find current period.
  let weeksConsumed = 0;
  let periodIdx = 0;
  for (let i = 0; i < PERIOD_WEEKS.length; i++) {
    if (weeksIntoFy < weeksConsumed + PERIOD_WEEKS[i]) {
      periodIdx = i;
      break;
    }
    weeksConsumed += PERIOD_WEEKS[i];
  }

  const periodNumber = periodIdx + 1; // 1..12
  const quarter = Math.floor(periodIdx / 3) + 1; // 1..4
  const periodInQuarter = (periodIdx % 3) + 1;   // 1..3
  const weeksInPeriod = PERIOD_WEEKS[periodIdx];
  const weekInPeriod = (weeksIntoFy - weeksConsumed) + 1; // 1..weeksInPeriod

  const periodStartMs = fyStartMs + weeksConsumed * MS_PER_WEEK;
  const periodEndMs = periodStartMs + weeksInPeriod * 7 * MS_PER_DAY - MS_PER_DAY;

  // Quarter spans 3 periods.
  const quarterStartIdx = (quarter - 1) * 3;
  const weeksBeforeQuarter = PERIOD_WEEKS.slice(0, quarterStartIdx).reduce((a, b) => a + b, 0);
  const weeksInQuarter = PERIOD_WEEKS.slice(quarterStartIdx, quarterStartIdx + 3).reduce((a, b) => a + b, 0);
  const quarterStartMs = fyStartMs + weeksBeforeQuarter * MS_PER_WEEK;
  const quarterEndMs = quarterStartMs + weeksInQuarter * 7 * MS_PER_DAY - MS_PER_DAY;

  const fyEndMs = fyStartMs + WEEKS_PER_FY * 7 * MS_PER_DAY - MS_PER_DAY;

  const daysLeftInPeriod = Math.max(0, Math.round((periodEndMs - todayMs) / MS_PER_DAY) + 1);
  const daysLeftInQuarter = Math.max(0, Math.round((quarterEndMs - todayMs) / MS_PER_DAY) + 1);

  return {
    fiscalYear,
    quarter,
    period: periodNumber,
    periodInQuarter,
    weekInPeriod,
    weeksInPeriod,
    dayInWeek,
    periodStart: fmt(periodStartMs),
    periodEnd: fmt(periodEndMs),
    quarterStart: fmt(quarterStartMs),
    quarterEnd: fmt(quarterEndMs),
    fiscalYearStart: fmt(fyStartMs),
    fiscalYearEnd: fmt(fyEndMs),
    daysLeftInPeriod,
    weeksLeftInPeriod: Math.ceil(daysLeftInPeriod / 7),
    daysLeftInQuarter,
    weeksLeftInQuarter: Math.ceil(daysLeftInQuarter / 7),
  };
}
