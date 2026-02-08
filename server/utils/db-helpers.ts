/**
 * Shared database helper utilities.
 */

/**
 * Deduplicates hourly sales data — keeps only one record per restaurant+hour.
 * When duplicates exist, the last record wins (most recent data).
 */
export function deduplicateHourly<T extends { restaurantId: string; hour: number }>(hourlyData: T[]): T[] {
  const uniqueMap = new Map<string, T>();
  hourlyData.forEach(record => {
    const key = `${record.restaurantId}-${record.hour}`;
    uniqueMap.set(key, record);
  });
  return Array.from(uniqueMap.values());
}

/**
 * Helper to add a delay (e.g., to avoid rate limiting).
 */
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
