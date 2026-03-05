/**
 * Shared Date Utilities
 *
 * Centralized date helpers for the MWB dashboard.
 * All business-day logic uses America/Chicago (Central) timezone.
 */

/** Get the current business date in Central timezone (noon to avoid DST issues). */
export function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [year, month, day] = centralStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

/** Get yesterday's date string (YYYY-MM-DD) in Central timezone. */
export function getYesterdayStr(): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/** Format a date as "Wednesday, March 5, 2026" */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Format a YYYY-MM-DD string as "Wed, Mar 5" */
export function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
