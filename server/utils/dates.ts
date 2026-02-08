/**
 * Shared date/timezone utilities used across the application.
 * All restaurant data is normalized to Central Time (America/Chicago).
 */

export function getCurrentHourInTimezone(timezone: string): number {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  };
  return parseInt(new Intl.DateTimeFormat('en-US', options).format(now));
}

export function getTodayInTimezone(timezone: string): string {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(now);
}

export function getNormalizedHourCutoff(restaurantList: { timezone: string }[]): number {
  const timezones = Array.from(new Set(restaurantList.map(r => r.timezone)));
  const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
  const minCurrentHour = Math.min(...currentHours);
  return minCurrentHour - 1;
}

export function getDateRangeForDay(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Get Central timezone hour, minute, and date string from a Date object.
 * Used by the scheduler for time-based job triggers.
 */
export function getCentralTime(now: Date = new Date()): { hour: number; minute: number; date: string } {
  const centralHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  }).format(now));
  const centralMinute = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    minute: 'numeric',
  }).format(now));
  const centralDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return { hour: centralHour, minute: centralMinute, date: centralDate };
}
