/**
 * Shared TypeScript interfaces for API responses and component props.
 *
 * These types were previously defined inline in multiple components.
 * Centralizing them prevents drift between dashboard.tsx, summary-cards.tsx,
 * and other consumers of the same API data.
 */

export interface WeeklySalesData {
  currentWeekStart: string;
  currentWeekEnd: string;
  priorWeekStart: string;
  priorWeekEnd: string;
  daysInCurrentWeek: number;
  daysInPriorWeek: number;
  restaurants: Record<string, {
    currentWeek: number;
    priorWeek: number;
    eowForecast: number;
    priorWeekFull: number;
    daysInCurrentWeek: number;
  }>;
}

export interface CheckAverageData {
  totalOrders: number;
  totalSales: number;
  checkAverage: number;
  hourly: Record<number, { orders: number; sales: number; avg: number }>;
}

export interface CheckAvgTrendData {
  daily: { date: string; orders: number; sales: number; avg: number }[];
  avg7d: number;
  trend: 'up' | 'down' | 'flat';
}
