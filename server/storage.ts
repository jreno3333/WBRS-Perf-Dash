import { 
  type User, 
  type InsertUser, 
  type Restaurant, 
  type InsertRestaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData,
  type InsertDailyWeather,
  type DailyWeather,
  restaurants,
  dailySales,
  hourlySales,
  scraperRuns,
  posOrders,
  dailyWeather,
  hmeTimerData
} from "@shared/schema";
import { db } from "./db";
import { eq, and, gte, lt, lte, desc, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getPosSalesByRestaurant, getAllHourlyPosSales } from "./xenial-webhook";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getRestaurants(): Promise<Restaurant[]>;
  getRestaurant(id: string): Promise<Restaurant | undefined>;
  
  getLeaderboard(date?: Date): Promise<LeaderboardData>;
  getPaceData(restaurantId: string, date?: Date): Promise<HourlySalesData[]>;
}

function getCurrentHourInTimezone(timezone: string): number {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = { 
    hour: 'numeric', 
    hour12: false, 
    timeZone: timezone 
  };
  return parseInt(new Intl.DateTimeFormat('en-US', options).format(now));
}

function getTodayInTimezone(timezone: string): string {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = { 
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone 
  };
  // Format as MM/DD/YYYY then convert to YYYY-MM-DD
  const formatted = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: timezone }).format(now);
  return formatted; // en-CA gives YYYY-MM-DD format
}

function getNormalizedHourCutoff(restaurantList: Restaurant[]): number {
  const timezones = Array.from(new Set(restaurantList.map(r => r.timezone)));
  const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
  const minCurrentHour = Math.min(...currentHours);
  // Use the last COMPLETED hour, not the current hour
  // If Central is at 1pm (hour 13), they've only completed through hour 12
  // If Central is at hour 0 (midnight), no hours are completed yet, return -1
  // This ensures Eastern stores (hour 1) don't get unfair advantage from their hour 0
  return minCurrentHour - 1;
}

function getDateRangeForDay(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export class DatabaseStorage implements IStorage {
  private users: Map<string, User> = new Map();

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async getRestaurants(): Promise<Restaurant[]> {
    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    return allRestaurants.filter(r => 
      !r.name.toLowerCase().includes('training') && 
      !r.name.toLowerCase().includes('development')
    );
  }

  async getRestaurant(id: string): Promise<Restaurant | undefined> {
    const result = await db.select().from(restaurants).where(eq(restaurants.id, id));
    return result[0];
  }

  async getLeaderboard(targetDate: Date = new Date()): Promise<LeaderboardData> {
    const now = new Date();
    const selectedDate = new Date(targetDate);
    const lastWeek = new Date(selectedDate);
    lastWeek.setDate(lastWeek.getDate() - 7);
    
    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    // Use Central timezone to determine "today" since server runs in UTC
    const todayStr = getTodayInTimezone('America/Chicago');
    
    // Check if selected date is today - use POS data for today, 7shifts data for historical
    const isToday = selectedDateStr === todayStr;
    
    const restaurantList = await this.getRestaurants();
    const normalizedHourCutoff = isToday ? getNormalizedHourCutoff(restaurantList) : 23;
    
    // Helper to calculate restaurant status from openDate
    const getRestaurantStatus = (openDate: string | Date | null | undefined): { status: "training" | "new" | "established"; daysOpen?: number } => {
      if (!openDate) return { status: "established" };
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const openDateNorm = new Date(openDate);
      openDateNorm.setHours(0, 0, 0, 0);
      
      if (openDateNorm > today) {
        return { status: "training" };
      }
      
      const diffTime = today.getTime() - openDateNorm.getTime();
      const daysOpen = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      
      if (daysOpen < 90) {
        return { status: "new", daysOpen };
      }
      
      return { status: "established", daysOpen };
    };
    
    // Get all hourly sales from 7shifts for comparison data
    const allHourlySales = await db.select().from(hourlySales);
    
    // Get daily_sales as fallback for last week data when hourly data is not available
    // 7shifts API only returns hourly intervals for ~3 days, so we need daily_sales for week-over-week
    const allDailySales = await db.select().from(dailySales);
    const lastWeekDailySalesMap = new Map<string, number>();
    allDailySales.forEach(d => {
      const saleDate = new Date(d.salesDate).toISOString().split('T')[0];
      if (saleDate === lastWeekStr) {
        // daily_sales stores values in cents, convert to dollars for consistency with hourly_sales
        lastWeekDailySalesMap.set(d.restaurantId, parseFloat(d.totalSales || '0') / 100);
      }
    });
    
    // Helper function to deduplicate hourly data - only keep one record per restaurant+hour
    // Takes the last record if there are duplicates (most recent data)
    const deduplicateHourly = (hourlyData: typeof allHourlySales) => {
      const uniqueMap = new Map<string, typeof allHourlySales[0]>();
      hourlyData.forEach(record => {
        const key = `${record.restaurantId}-${record.hour}`;
        // Always overwrite - last one wins (most recent)
        uniqueMap.set(key, record);
      });
      return Array.from(uniqueMap.values());
    };
    
    const selectedDateHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    }));
    
    const lastWeekHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    }));
    
    console.log(`[Leaderboard Debug] selectedDateStr: ${selectedDateStr}, lastWeekStr: ${lastWeekStr}`);
    console.log(`[Leaderboard Debug] allHourlySales count: ${allHourlySales.length}, selectedDateHourly: ${selectedDateHourly.length}, lastWeekHourly: ${lastWeekHourly.length}`);
    console.log(`[Leaderboard Debug] lastWeekDailySalesMap size: ${lastWeekDailySalesMap.size}`);
    if (allHourlySales.length > 0) {
      // Debug: Show raw salesDate values and how they're being parsed
      const sampleDates = allHourlySales.slice(0, 3).map(s => ({
        raw: s.salesDate,
        type: typeof s.salesDate,
        parsed: new Date(s.salesDate).toISOString(),
        dateOnly: new Date(s.salesDate).toISOString().split('T')[0]
      }));
      console.log(`[Leaderboard Debug] Sample date parsing:`, JSON.stringify(sampleDates));
      
      const uniqueDates = Array.from(new Set(allHourlySales.map(s => new Date(s.salesDate).toISOString().split('T')[0]))).sort();
      console.log(`[Leaderboard Debug] Available dates in hourly_sales: ${uniqueDates.join(', ')}`);
    }
    
    const restaurantSales: RestaurantSales[] = restaurantList.map(restaurant => {
      // All hourly data for the selected date (used for completed hours comparison)
      const selectedDateRestaurantHours = selectedDateHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= normalizedHourCutoff
      );
      // All hourly data for the entire day (used for labor forecast)
      const allSelectedDateHours = selectedDateHourly.filter(
        s => s.restaurantId === restaurant.id
      );
      // Normalized last week hours (for ranking comparison)
      const lastWeekRestaurantHours = lastWeekHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= normalizedHourCutoff
      );
      
      // Get current hour in this restaurant's timezone for proper comparison
      const restaurantCurrentHour = getCurrentHourInTimezone(restaurant.timezone);
      // Last completed hour in this restaurant's timezone
      // For historical dates, all hours are complete (use 23), for today use current-1
      const restaurantCompletedHour = isToday ? restaurantCurrentHour - 1 : 23;
      
      // Last week hours up to current hour in this restaurant's timezone
      const lastWeekHoursForComparison = lastWeekHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= restaurantCompletedHour
      );
      
      // Use 7shifts hourly data for sales (works for both today and historical)
      // Normalized sales (capped at normalized hour for fair ranking)
      const selectedDateSalesAmount = selectedDateRestaurantHours.reduce(
        (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
      );
      
      // Actual current sales (all available hours, matches 7shifts display)
      const actualSalesAmount = allSelectedDateHours.reduce(
        (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
      );
      
      // Normalized last week (for ranking)
      // Use hourly data if available, otherwise fall back to daily_sales
      // 7shifts API only returns hourly intervals for ~3 days, so daily_sales is used for older dates
      let lastWeekSalesAmount = lastWeekRestaurantHours.reduce(
        (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
      );
      let actualLastWeekAmount = lastWeekHoursForComparison.reduce(
        (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
      );
      
      // Fallback to daily_sales if hourly data not available for last week
      if (lastWeekSalesAmount === 0 && lastWeekDailySalesMap.has(restaurant.id)) {
        const dailyTotal = lastWeekDailySalesMap.get(restaurant.id) || 0;
        // For ranking: use proportional amount based on normalized hour
        // (e.g., if normalized hour is 19/23 = 83% of day, use 83% of daily total)
        const dayProgress = (normalizedHourCutoff + 1) / 24;
        lastWeekSalesAmount = dailyTotal * dayProgress;
        // For display: use actual daily total for full day, or proportional for today
        const displayProgress = (restaurantCompletedHour + 1) / 24;
        actualLastWeekAmount = dailyTotal * displayProgress;
      }
      
      // Calculate forecast: current actual sales + last week's remaining hours
      // For historical dates: no remaining hours (day is complete), forecast = actual
      // For today: actual + last week's remaining hours as forecast
      const lastWeekAllHoursForForecast = lastWeekHourly.filter(
        s => s.restaurantId === restaurant.id
      );
      let lastWeekRemainingHoursSales = 0;
      // Only calculate remaining hours for today (historical has no remaining hours)
      if (isToday) {
        // Check if we have hourly data for last week
        if (lastWeekAllHoursForForecast.length > 0) {
          for (let hour = restaurantCompletedHour + 1; hour < 24; hour++) {
            const lastWeekHour = lastWeekAllHoursForForecast.find(s => s.hour === hour);
            lastWeekRemainingHoursSales += parseFloat(lastWeekHour?.actualSales || '0');
          }
        } else if (lastWeekDailySalesMap.has(restaurant.id)) {
          // Fallback: use daily_sales to estimate remaining hours
          const dailyTotal = lastWeekDailySalesMap.get(restaurant.id) || 0;
          const remainingProgress = (24 - restaurantCompletedHour - 1) / 24;
          lastWeekRemainingHoursSales = dailyTotal * remainingProgress;
        }
      }
      // Forecast = today's actual sales so far + last week's remaining hours
      // For historical: remaining = 0, so forecast = actual
      const forecastSalesAmount = actualSalesAmount + lastWeekRemainingHoursSales;
      
      // Handle -1 case: when no hours are completed, pace is 0%
      const completedHours = Math.max(0, normalizedHourCutoff + 1);
      const pacePercentage = (completedHours / 24) * 100;
      const isAheadOfPace = selectedDateSalesAmount >= lastWeekSalesAmount;
      
      // Labor forecast calculation
      // Blended approach: actual labor for completed hours + projected labor for remaining hours
      // This gives the most accurate projected end-of-day labor %
      let actualLaborCompleted = 0;
      let projectedLaborRemaining = 0;
      
      // Sum actual labor for completed hours (0 through normalizedHourCutoff)
      for (let hour = 0; hour <= normalizedHourCutoff; hour++) {
        const hourData = allSelectedDateHours.find(s => s.hour === hour);
        actualLaborCompleted += parseFloat(hourData?.actualLabor || '0');
      }
      
      // Sum projected labor for remaining hours
      for (let hour = normalizedHourCutoff + 1; hour < 24; hour++) {
        const hourData = allSelectedDateHours.find(s => s.hour === hour);
        projectedLaborRemaining += parseFloat(hourData?.projectedLabor || '0');
      }
      
      // Total projected labor = actual so far + projected for remaining hours
      const projectedLaborCost = actualLaborCompleted + projectedLaborRemaining;
      
      // Calculate projected end-of-day sales:
      // For today: current actual sales + forecasted sales for remaining hours
      // For historical: just use actual sales (day is complete)
      // Note: 7shifts doesn't provide forecast for all future hours, so use last week's actuals as fallback
      let projectedEndOfDaySales: number;
      if (isToday) {
        // Get last week's data for remaining hours (as forecast fallback)
        const lastWeekAllHours = lastWeekHourly.filter(
          s => s.restaurantId === restaurant.id
        );
        
        // Remaining hours' forecasted sales
        // Use 7shifts projectedSales if available, otherwise use last week's actual as estimate
        let remainingForecastSales = 0;
        
        // Check if we have hourly data for last week
        if (lastWeekAllHours.length > 0) {
          for (let hour = normalizedHourCutoff + 1; hour < 24; hour++) {
            const todayHour = allSelectedDateHours.find(s => s.hour === hour);
            const lastWeekHour = lastWeekAllHours.find(s => s.hour === hour);
            
            // Prefer 7shifts projected, fallback to last week's actual
            const forecastValue = parseFloat(todayHour?.projectedSales || '0') > 0 
              ? parseFloat(todayHour?.projectedSales || '0')
              : parseFloat(lastWeekHour?.actualSales || '0');
            remainingForecastSales += forecastValue;
          }
        } else if (lastWeekDailySalesMap.has(restaurant.id)) {
          // Fallback: use daily_sales to estimate remaining hours
          const dailyTotal = lastWeekDailySalesMap.get(restaurant.id) || 0;
          const remainingProgress = (24 - normalizedHourCutoff - 1) / 24;
          remainingForecastSales = dailyTotal * remainingProgress;
        }
        
        projectedEndOfDaySales = selectedDateSalesAmount + remainingForecastSales;
      } else {
        // For historical: use actual sales through end of day
        projectedEndOfDaySales = allSelectedDateHours.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );
      }
      
      // Calculate projected labor percentage (blended actual + projected)
      const projectedLaborPercent = projectedEndOfDaySales > 0 
        ? (projectedLaborCost / projectedEndOfDaySales) * 100 
        : 0;
      
      // Labor target from restaurant config (default 25%)
      const laborTarget = parseFloat(restaurant.laborTarget || '25');
      const willHitLaborTarget = projectedLaborPercent <= laborTarget;
      
      // Get unit status from openDate
      const unitStatus = getRestaurantStatus(restaurant.openDate);
      
      return {
        restaurantId: restaurant.id.toString(),
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        todaySales: selectedDateSalesAmount, // Normalized for fair ranking
        actualSales: actualSalesAmount, // Current sales matching 7shifts
        lastWeekSales: lastWeekSalesAmount, // Normalized for ranking
        actualLastWeekSales: actualLastWeekAmount, // Full last week for display
        forecastSales: forecastSalesAmount,
        pacePercentage,
        isAheadOfPace,
        rank: 0,
        normalizedHour: normalizedHourCutoff,
        // Labor forecast fields
        projectedLaborCost: Math.round(projectedLaborCost * 100) / 100,
        projectedEndOfDaySales: Math.round(projectedEndOfDaySales * 100) / 100,
        projectedLaborPercent: Math.round(projectedLaborPercent * 10) / 10, // Round to 1 decimal
        laborTarget,
        willHitLaborTarget,
        // Unit status fields
        status: unitStatus.status,
        daysOpen: unitStatus.daysOpen,
        openDate: restaurant.openDate && !isNaN(new Date(restaurant.openDate).getTime()) ? new Date(restaurant.openDate).toISOString() : null,
        revenuePorts: restaurant.revenuePorts,
      };
    });
    
    // Separate training units from ranked units
    const rankedUnits = restaurantSales.filter(r => r.status !== "training");
    const trainingUnits = restaurantSales.filter(r => r.status === "training");
    
    // Sort ranked units by sales
    rankedUnits.sort((a, b) => b.todaySales - a.todaySales);
    
    // Assign ranks only to non-training units
    rankedUnits.forEach((r, idx) => {
      r.rank = idx + 1;
    });
    
    // Training units get rank 0 (unranked) and are appended at the end
    trainingUnits.forEach(r => {
      r.rank = 0;
    });
    
    // Combine: ranked units first (sorted by sales), then training units at the end
    const sortedRestaurantSales = [...rankedUnits, ...trainingUnits];
    
    // Get the last POS order time for "last updated" when viewing today
    let lastUpdated: string;
    if (isToday) {
      const lastPosOrder = await db.select()
        .from(posOrders)
        .orderBy(desc(posOrders.receivedAt))
        .limit(1);
      lastUpdated = lastPosOrder.length > 0 && lastPosOrder[0].receivedAt 
        ? lastPosOrder[0].receivedAt.toISOString()
        : now.toISOString();
    } else {
      const lastSync = await db.select()
        .from(scraperRuns)
        .where(eq(scraperRuns.status, 'success'))
        .orderBy(desc(scraperRuns.completedAt))
        .limit(1);
      lastUpdated = lastSync.length > 0 && lastSync[0].completedAt 
        ? lastSync[0].completedAt.toISOString()
        : now.toISOString();
    }
    
    return {
      restaurants: sortedRestaurantSales,
      lastUpdated,
      currentDate: selectedDateStr,
    };
  }

  async getPaceData(restaurantId: string, targetDate: Date = new Date()): Promise<HourlySalesData[]> {
    const hourlyData: HourlySalesData[] = [];
    const restaurantList = await this.getRestaurants();
    const now = new Date();
    const selectedDate = new Date(targetDate);
    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    // Use Central timezone to determine "today" since server runs in UTC
    const todayStr = getTodayInTimezone('America/Chicago');
    
    // For charts, show all data through the current hour (not just completed hours)
    const isToday = selectedDateStr === todayStr;
    // For display: use minimum current hour across all timezones (shows in-progress hour)
    const timezones = Array.from(new Set(restaurantList.map(r => r.timezone)));
    const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
    const displayHourCutoff = isToday ? Math.min(...currentHours) : 23;
    
    const lastWeek = new Date(selectedDate);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    
    const allHourlySales = await db.select().from(hourlySales);
    
    // Helper function to deduplicate hourly data - only keep one record per restaurant+hour
    const deduplicateHourly = (hourlyData: typeof allHourlySales) => {
      const uniqueMap = new Map<string, typeof allHourlySales[0]>();
      hourlyData.forEach(record => {
        const key = `${record.restaurantId}-${record.hour}`;
        uniqueMap.set(key, record);
      });
      return Array.from(uniqueMap.values());
    };
    
    const selectedDateHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    }));
    
    const lastWeekHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    }));
    
    const selectedByHour: Map<number, number> = new Map();
    const lastWeekByHour: Map<number, number> = new Map();
    const forecastByHour: Map<number, number> = new Map();
    const laborByHour: Map<number, number> = new Map();
    const actualLaborByHour: Map<number, number> = new Map();
    const employeeCountByHour: Map<number, number> = new Map();
    const positionByHour: Map<number, Record<string, number>> = new Map();
    
    for (let h = 0; h < 24; h++) {
      selectedByHour.set(h, 0);
      lastWeekByHour.set(h, 0);
      forecastByHour.set(h, 0);
      laborByHour.set(h, 0);
      actualLaborByHour.set(h, 0);
      employeeCountByHour.set(h, 0);
    }
    
    if (restaurantId === "all") {
      // Use 7shifts data for all sales
      selectedDateHourly.forEach(s => {
        const current = selectedByHour.get(s.hour) || 0;
        selectedByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
      });
      // Forecast and labor from 7shifts (but NOT employee count - doesn't make sense to sum)
      selectedDateHourly.forEach(s => {
        const currentForecast = forecastByHour.get(s.hour) || 0;
        forecastByHour.set(s.hour, currentForecast + parseFloat(s.projectedSales || '0'));
        // Projected labor for this hour
        const currentLabor = laborByHour.get(s.hour) || 0;
        laborByHour.set(s.hour, currentLabor + parseFloat(s.projectedLabor || '0'));
        // Actual labor for this hour
        const currentActualLabor = actualLaborByHour.get(s.hour) || 0;
        actualLaborByHour.set(s.hour, currentActualLabor + parseFloat(s.actualLabor || '0'));
        // Employee count is NOT aggregated for "all" view - leave at 0
        // Summing employee counts across all stores is not meaningful
      });
      // Last week from 7shifts
      lastWeekHourly.forEach(s => {
        const current = lastWeekByHour.get(s.hour) || 0;
        lastWeekByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
      });
    } else {
      // Use 7shifts data for the specific restaurant
      selectedDateHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
        selectedByHour.set(s.hour, parseFloat(s.actualSales || '0'));
      });
      // Forecast, labor, employee count, and position breakdown from 7shifts
      selectedDateHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
        forecastByHour.set(s.hour, parseFloat(s.projectedSales || '0'));
        laborByHour.set(s.hour, parseFloat(s.projectedLabor || '0'));
        actualLaborByHour.set(s.hour, parseFloat(s.actualLabor || '0'));
        employeeCountByHour.set(s.hour, Number(s.employeeCount) || 0);
        if (s.positionBreakdown) {
          positionByHour.set(s.hour, s.positionBreakdown as Record<string, number>);
        }
      });
      // Last week from 7shifts
      lastWeekHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
        lastWeekByHour.set(s.hour, parseFloat(s.actualSales || '0'));
      });
    }
    
    // For hours without forecast data (future hours), use last week's actual as forecast
    // 7shifts only provides projected_sales for completed hours, not future forecasts
    for (let h = 0; h < 24; h++) {
      if ((forecastByHour.get(h) || 0) === 0 && (lastWeekByHour.get(h) || 0) > 0) {
        forecastByHour.set(h, lastWeekByHour.get(h) || 0);
      }
    }
    
    let cumulativeSelected = 0;
    let cumulativeLastWeek = 0;
    let cumulativeForecast = 0;
    
    for (let hour = 0; hour < 24; hour++) {
      // Accumulate data through the display cutoff (current hour, not just completed hours)
      // This shows in-progress data on charts while leaderboard uses completed hours only
      if (hour <= displayHourCutoff) {
        cumulativeSelected += selectedByHour.get(hour) || 0;
        cumulativeLastWeek += lastWeekByHour.get(hour) || 0;
        cumulativeForecast += forecastByHour.get(hour) || 0;
      }
      
      // Show cumulative up to the cutoff, then full last week/forecast for reference
      const showCumulativeSelected = hour <= displayHourCutoff ? Math.round(cumulativeSelected) : 0;
      const showCumulativeLastWeek = hour <= displayHourCutoff 
        ? Math.round(cumulativeLastWeek) 
        : Math.round(cumulativeLastWeek + (lastWeekByHour.get(hour) || 0));
      const showCumulativeForecast = hour <= displayHourCutoff 
        ? Math.round(cumulativeForecast) 
        : Math.round(cumulativeForecast + (forecastByHour.get(hour) || 0));
      
      // Keep accumulating last week and forecast for future hours (reference line)
      if (hour > displayHourCutoff) {
        cumulativeLastWeek += lastWeekByHour.get(hour) || 0;
        cumulativeForecast += forecastByHour.get(hour) || 0;
      }
      
      const projectedLabor = Math.round((laborByHour.get(hour) || 0) * 100) / 100;
      const actualLabor = Math.round((actualLaborByHour.get(hour) || 0) * 100) / 100;
      const employeeCount = employeeCountByHour.get(hour) || 0;
      const positionBreakdown = positionByHour.get(hour);
      hourlyData.push({
        hour,
        todaySales: showCumulativeSelected,
        lastWeekSales: showCumulativeLastWeek,
        forecastSales: showCumulativeForecast,
        projectedLabor,
        actualLabor, // Use actual labor as-is from 7shifts punched hours
        employeeCount, // Number of employees on clock from time punches
        positionBreakdown, // Hours worked by each position
        label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
      });
    }
    
    return hourlyData;
  }

  async getHourlyDataByRestaurant(targetDate: Date = new Date()): Promise<Record<string, HourlySalesData[]>> {
    const now = new Date();
    const selectedDate = new Date(targetDate);
    const lastWeek = new Date(selectedDate);
    lastWeek.setDate(lastWeek.getDate() - 7);
    
    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    // Use Central timezone to determine "today" since server runs in UTC
    const todayStr = getTodayInTimezone('America/Chicago');
    
    const isToday = selectedDateStr === todayStr;
    
    const restaurantList = await this.getRestaurants();
    // For display: use current hour (shows in-progress data), not last completed hour
    const timezones = Array.from(new Set(restaurantList.map(r => r.timezone)));
    const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
    const displayHourCutoff = isToday ? Math.min(...currentHours) : 23;
    
    const allHourlySales = await db.select().from(hourlySales);
    
    // Helper function to deduplicate hourly data - only keep one record per restaurant+hour
    const deduplicateHourly = (hourlyData: typeof allHourlySales) => {
      const uniqueMap = new Map<string, typeof allHourlySales[0]>();
      hourlyData.forEach(record => {
        const key = `${record.restaurantId}-${record.hour}`;
        uniqueMap.set(key, record);
      });
      return Array.from(uniqueMap.values());
    };
    
    const selectedDateHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    }));
    
    const lastWeekHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    }));
    
    // Fallback: get daily_sales for last week when hourly data is missing
    // (7shifts daily_stats API only provides detailed intervals for ~3 days)
    // Use date range to match since timestamps aren't normalized
    const lastWeekStart = new Date(lastWeekStr + 'T00:00:00.000Z');
    const lastWeekEnd = new Date(lastWeekStr + 'T23:59:59.999Z');
    const lastWeekDailyData = await db.select().from(dailySales).where(
      and(
        gte(dailySales.salesDate, lastWeekStart),
        lte(dailySales.salesDate, lastWeekEnd)
      )
    );
    const lastWeekDailyMap = new Map<string, number>();
    for (const d of lastWeekDailyData) {
      // daily_sales.totalSales is stored in cents, convert to dollars
      lastWeekDailyMap.set(d.restaurantId, parseFloat(String(d.totalSales)) / 100);
    }
    
    // Fetch HME timer data for the selected date
    const allHmeData = await db.select().from(hmeTimerData).where(eq(hmeTimerData.date, selectedDateStr));
    
    // Fetch Xenial POS hourly data - prioritize over 7shifts for any date
    // POS data is more accurate when available (real transactions vs 7shifts estimates)
    const posHourlySales = await getAllHourlyPosSales(selectedDate);
    
    const result: Record<string, HourlySalesData[]> = {};
    
    for (const restaurant of restaurantList) {
      const hourlyData: HourlySalesData[] = [];
      
      const restaurantSelectedHourly = selectedDateHourly.filter(s => s.restaurantId === restaurant.id);
      const restaurantLastWeekHourly = lastWeekHourly.filter(s => s.restaurantId === restaurant.id);
      const restaurantHmeData = allHmeData.filter(h => h.restaurantId === restaurant.id);
      
      const selectedByHour: Map<number, number> = new Map();
      const lastWeekByHour: Map<number, number> = new Map();
      const forecastByHour: Map<number, number> = new Map();
      const laborByHour: Map<number, number> = new Map();
      const actualLaborByHour: Map<number, number> = new Map();
      const employeeCountByHour: Map<number, number> = new Map();
      const positionByHour: Map<number, Record<string, number>> = new Map();
      const hmeByHour: Map<number, { avgServiceTime: number; carCount: number }> = new Map();
      
      // HME drive-thru data by hour (using avgTotalTime = lane total)
      restaurantHmeData.forEach(h => {
        hmeByHour.set(h.hour, { avgServiceTime: h.avgTotalTime, carCount: h.carCount });
      });
      
      // Get Xenial POS data for this restaurant (prioritize over 7shifts)
      const posSalesForRestaurant = posHourlySales.get(restaurant.id);
      
      // Use 7shifts data as base for sales
      restaurantSelectedHourly.forEach(s => {
        selectedByHour.set(s.hour, parseFloat(s.actualSales || '0'));
      });
      
      // Override with Xenial POS data when available - this is more accurate real-time data
      if (posSalesForRestaurant && posSalesForRestaurant.size > 0) {
        // POS data exists - use it for hours where we have data
        // This overwrites any 7shifts estimates with actual POS transactions
        posSalesForRestaurant.forEach((sales, hour) => {
          selectedByHour.set(hour, sales);
        });
        // Clear 7shifts data for hours before the first POS hour that have no POS data
        // This prevents showing inflated 7shifts estimates for early morning
        const firstPosHour = Math.min(...Array.from(posSalesForRestaurant.keys()));
        for (let h = 0; h < firstPosHour; h++) {
          // Only clear if we have no POS data for this hour
          if (!posSalesForRestaurant.has(h)) {
            selectedByHour.set(h, 0);
          }
        }
      }
      
      // Forecast, labor, employee count, and position breakdown from 7shifts
      restaurantSelectedHourly.forEach(s => {
        forecastByHour.set(s.hour, parseFloat(s.projectedSales || '0'));
        laborByHour.set(s.hour, parseFloat(s.projectedLabor || '0'));
        actualLaborByHour.set(s.hour, parseFloat(s.actualLabor || '0'));
        employeeCountByHour.set(s.hour, Number(s.employeeCount) || 0);
        if (s.positionBreakdown) {
          positionByHour.set(s.hour, s.positionBreakdown as Record<string, number>);
        }
      });
      // Last week from 7shifts hourly data
      restaurantLastWeekHourly.forEach(s => {
        lastWeekByHour.set(s.hour, parseFloat(s.actualSales || '0'));
      });
      
      // Fallback: if no hourly data for last week, estimate from daily_sales
      // This handles the case when 7shifts API doesn't provide detailed intervals for older dates
      if (restaurantLastWeekHourly.length === 0 && lastWeekDailyMap.has(restaurant.id)) {
        const dailyTotal = lastWeekDailyMap.get(restaurant.id) || 0;
        // Use a typical restaurant hourly distribution (approximate based on QSR patterns)
        // Peak hours: 11am-1pm (lunch), 5pm-8pm (dinner)
        const hourlyDistribution: Record<number, number> = {
          5: 0.01, 6: 0.02, 7: 0.03, 8: 0.04, 9: 0.05, 10: 0.06,
          11: 0.09, 12: 0.11, 13: 0.09, 14: 0.06, 15: 0.05, 16: 0.05,
          17: 0.07, 18: 0.08, 19: 0.07, 20: 0.05, 21: 0.04, 22: 0.02, 23: 0.01
        };
        for (let h = 0; h < 24; h++) {
          const pct = hourlyDistribution[h] || 0;
          if (pct > 0) {
            lastWeekByHour.set(h, Math.round(dailyTotal * pct));
          }
        }
      }
      
      // For hours without forecast data (future hours), use last week's actual as forecast
      for (let h = 0; h < 24; h++) {
        if ((forecastByHour.get(h) || 0) === 0 && (lastWeekByHour.get(h) || 0) > 0) {
          forecastByHour.set(h, lastWeekByHour.get(h) || 0);
        }
      }
      
      for (let hour = 0; hour <= displayHourCutoff; hour++) {
        const todaySales = Math.round(selectedByHour.get(hour) || 0);
        const lastWeekSales = Math.round(lastWeekByHour.get(hour) || 0);
        const forecastSales = Math.round(forecastByHour.get(hour) || 0);
        const projectedLabor = Math.round((laborByHour.get(hour) || 0) * 100) / 100;
        const actualLabor = Math.round((actualLaborByHour.get(hour) || 0) * 100) / 100;
        const employeeCount = employeeCountByHour.get(hour) || 0;
        const positionBreakdown = positionByHour.get(hour);
        
        // Include hours with any data (sales, forecast, or labor)
        // Hours 0-4 often have labor but no sales - needed for Early Bird labor totals
        if (todaySales > 0 || lastWeekSales > 0 || forecastSales > 0 || projectedLabor > 0 || actualLabor > 0) {
          const hmeHourData = hmeByHour.get(hour);
          hourlyData.push({
            hour,
            todaySales,
            lastWeekSales,
            forecastSales,
            projectedLabor,
            actualLabor,
            employeeCount,
            positionBreakdown,
            label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
            avgServiceTime: hmeHourData?.avgServiceTime,
            carCount: hmeHourData?.carCount,
          });
        }
      }
      
      result[restaurant.id] = hourlyData;
    }
    
    return result;
  }

  // Save daily weather for a restaurant
  async saveDailyWeather(data: InsertDailyWeather): Promise<void> {
    await db
      .insert(dailyWeather)
      .values(data)
      .onConflictDoUpdate({
        target: [dailyWeather.restaurantId, dailyWeather.date],
        set: {
          highTemp: data.highTemp,
          lowTemp: data.lowTemp,
          avgTemp: data.avgTemp,
          condition: data.condition,
          humidity: data.humidity,
          windSpeed: data.windSpeed,
          savedAt: sql`now()`,
        },
      });
  }

  // Get daily weather for a restaurant and date
  async getDailyWeather(restaurantId: string, date: string): Promise<DailyWeather | null> {
    const result = await db
      .select()
      .from(dailyWeather)
      .where(and(
        eq(dailyWeather.restaurantId, restaurantId),
        eq(dailyWeather.date, date)
      ))
      .limit(1);
    return result[0] || null;
  }

  // Get all daily weather for a date
  async getAllDailyWeather(date: string): Promise<DailyWeather[]> {
    return await db
      .select()
      .from(dailyWeather)
      .where(eq(dailyWeather.date, date));
  }
}

export const storage = new DatabaseStorage();
