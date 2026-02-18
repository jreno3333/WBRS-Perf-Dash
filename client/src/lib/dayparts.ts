/**
 * MWB Daypart Definitions
 *
 * Dayparts partition operating hours into meaningful business periods.
 * Aligned with the labor model's breakfast boundary (6-10) and CFA operating patterns.
 */

export interface Daypart {
  id: string;
  label: string;
  shortLabel: string;
  startHour: number; // inclusive
  endHour: number;   // inclusive
  color: string;     // Tailwind text color class
  bgColor: string;   // Tailwind bg color class
}

export const DAYPARTS: Daypart[] = [
  {
    id: 'breakfast',
    label: 'Breakfast',
    shortLabel: 'BRK',
    startHour: 6,
    endHour: 10,
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-100 dark:bg-amber-900/30',
  },
  {
    id: 'lunch',
    label: 'Lunch',
    shortLabel: 'LCH',
    startHour: 11,
    endHour: 13,
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-100 dark:bg-orange-900/30',
  },
  {
    id: 'afternoon',
    label: 'Afternoon',
    shortLabel: 'AFT',
    startHour: 14,
    endHour: 16,
    color: 'text-sky-600 dark:text-sky-400',
    bgColor: 'bg-sky-100 dark:bg-sky-900/30',
  },
  {
    id: 'dinner',
    label: 'Dinner',
    shortLabel: 'DIN',
    startHour: 17,
    endHour: 20,
    color: 'text-indigo-600 dark:text-indigo-400',
    bgColor: 'bg-indigo-100 dark:bg-indigo-900/30',
  },
  {
    id: 'late',
    label: 'Late',
    shortLabel: 'LTE',
    startHour: 21,
    endHour: 23,
    color: 'text-violet-600 dark:text-violet-400',
    bgColor: 'bg-violet-100 dark:bg-violet-900/30',
  },
];

/** Get the daypart for a given hour (0-23). Returns undefined for hours outside operating (0-5). */
export function getDaypart(hour: number): Daypart | undefined {
  return DAYPARTS.find(dp => hour >= dp.startHour && hour <= dp.endHour);
}

/** Get all hours that belong to a daypart */
export function getDaypartHours(daypartId: string): number[] {
  const dp = DAYPARTS.find(d => d.id === daypartId);
  if (!dp) return [];
  const hours: number[] = [];
  for (let h = dp.startHour; h <= dp.endHour; h++) {
    hours.push(h);
  }
  return hours;
}

/** Grade scoring helpers shared with daypart grading */
export function gradeToScore(grade: string): number {
  const scores: Record<string, number> = { 'A+': 100, 'A': 90, 'B': 80, 'C': 70, 'D': 60, 'F': 50 };
  return scores[grade] || 0;
}

export function scoreToGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 75) return 'B';
  if (score >= 65) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

export function getGradeColor(grade: string): string {
  if (grade === 'A+' || grade === 'A') return 'text-green-600 dark:text-green-400';
  if (grade === 'B') return 'text-blue-600 dark:text-blue-400';
  if (grade === 'C') return 'text-yellow-600 dark:text-yellow-400';
  if (grade === 'D') return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
}
