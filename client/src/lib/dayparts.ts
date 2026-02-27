/**
 * MWB Daypart Definitions
 *
 * 6 dayparts covering the full 24-hour clock:
 *   Earlybird    12 AM – 6 AM  (hours 0-5)
 *   Breakfast     6 AM – 11 AM (hours 6-10)
 *   Lunch        11 AM – 3 PM  (hours 11-14)
 *   Snack         3 PM – 5 PM  (hours 15-16)
 *   Evening       5 PM – 8 PM  (hours 17-19)
 *   Evening Snack 8 PM – 12 AM (hours 20-23)
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
    id: 'earlybird',
    label: 'Earlybird',
    shortLabel: 'EB',
    startHour: 0,
    endHour: 5,
    color: 'text-slate-600 dark:text-slate-400',
    bgColor: 'bg-slate-100 dark:bg-slate-900/30',
  },
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
    endHour: 14,
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-100 dark:bg-orange-900/30',
  },
  {
    id: 'snack',
    label: 'Snack',
    shortLabel: 'SNK',
    startHour: 15,
    endHour: 16,
    color: 'text-sky-600 dark:text-sky-400',
    bgColor: 'bg-sky-100 dark:bg-sky-900/30',
  },
  {
    id: 'evening',
    label: 'Evening',
    shortLabel: 'EVE',
    startHour: 17,
    endHour: 19,
    color: 'text-indigo-600 dark:text-indigo-400',
    bgColor: 'bg-indigo-100 dark:bg-indigo-900/30',
  },
  {
    id: 'evening_snack',
    label: 'Evening Snack',
    shortLabel: 'ES',
    startHour: 20,
    endHour: 23,
    color: 'text-violet-600 dark:text-violet-400',
    bgColor: 'bg-violet-100 dark:bg-violet-900/30',
  },
];

/** Get the daypart for a given hour (0-23). Always returns a match since all 24 hours are covered. */
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
  const scores: Record<string, number> = {
    'A+': 98, 'A': 95, 'A-': 91, 'B+': 88, 'B': 85, 'B-': 81,
    'C+': 78, 'C': 75, 'C-': 71, 'D+': 68, 'D': 65, 'D-': 61, 'F': 30,
  };
  return scores[grade] || 0;
}

export function scoreToGrade(score: number): string {
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

export function getGradeColor(grade: string): string {
  if (grade.startsWith('A')) return 'text-green-600 dark:text-green-400';
  if (grade.startsWith('B')) return 'text-blue-600 dark:text-blue-400';
  if (grade.startsWith('C')) return 'text-yellow-600 dark:text-yellow-400';
  if (grade.startsWith('D')) return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
}
