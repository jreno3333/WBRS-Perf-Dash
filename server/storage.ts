import { 
  type User, 
  type InsertUser, 
  type Restaurant, 
  type InsertRestaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData,
  restaurants,
  dailySales,
  hourlySales,
  scraperRuns,
  posOrders
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
  updateRestaurantLaborTarget(id: string, laborTarget: number): Promise<Restaurant | undefined>;
  
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

  async updateRestaurantLaborTarget(id: string, laborTarget: number): Promise<Restaurant | undefined> {
    const result = await db.update(restaurants)
      .set({ laborTarget: laborTarget.toFixed(2) })
      .where(eq(restaurants.id, id))
      .returning();
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
    
    // Get all hourly sales from 7shifts for comparison data
    const allHourlySales = await db.select().from(hourlySales);
    
    const selectedDateHourly = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    });
    
    const lastWeekHourly = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    });
    
    const restaurantSales: RestaurantSales[] = restaurantList.map(restaurant => {
      // All hourly data for the selected date (used for completed hours comparison)
      const selectedDateRestaurantHours = selectedDateHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= normalizedHourCutoff
      );
      // All hourly data for the entire day (used for labor forecast)
      const allSelectedDateHours = selectedDateHourly.filter(
        s => s.restaurantId === restaurant.id
      );
      const lastWeekRestaurantHours = lastWeekHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= normalizedHourCutoff
      );
      
      // Use 7shifts hourly data for sales (works for both today and historical)
      const selectedDateSalesAmount = selectedDateRestaurantHours.reduce(
        (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
      );
      
      const lastWeekSalesAmount = lastWeekRestaurantHours.reduce(
        (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
      );
      const forecastSalesAmount = selectedDateRestaurantHours.reduce(
        (sum, s) => sum + parseFloat(s.projectedSales || '0'), 0
      );
      
      // Handle -1 case: when no hours are completed, pace is 0%
      const completedHours = Math.max(0, normalizedHourCutoff + 1);
      const pacePercentage = (completedHours / 24) * 100;
      const isAheadOfPace = selectedDateSalesAmount >= lastWeekSalesAmount;
      
      // Labor forecast calculation
      // Get total scheduled labor for the day (sum of all projected_labor for all hours)
      const projectedLaborCost = allSelectedDateHours.reduce(
        (sum, s) => sum + parseFloat(s.projectedLabor || '0'), 0
      );
      
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
        for (let hour = normalizedHourCutoff + 1; hour < 24; hour++) {
          const todayHour = allSelectedDateHours.find(s => s.hour === hour);
          const lastWeekHour = lastWeekAllHours.find(s => s.hour === hour);
          
          // Prefer 7shifts projected, fallback to last week's actual
          const forecastValue = parseFloat(todayHour?.projectedSales || '0') > 0 
            ? parseFloat(todayHour?.projectedSales || '0')
            : parseFloat(lastWeekHour?.actualSales || '0');
          remainingForecastSales += forecastValue;
        }
        
        projectedEndOfDaySales = selectedDateSalesAmount + remainingForecastSales;
      } else {
        // For historical: use actual sales through end of day
        projectedEndOfDaySales = allSelectedDateHours.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );
      }
      
      // Calculate projected labor percentage
      const projectedLaborPercent = projectedEndOfDaySales > 0 
        ? (projectedLaborCost / projectedEndOfDaySales) * 100 
        : 0;
      
      // Labor target from restaurant config (default 25%)
      const laborTarget = parseFloat(restaurant.laborTarget || '25');
      const willHitLaborTarget = projectedLaborPercent <= laborTarget;
      
      return {
        restaurantId: restaurant.id.toString(),
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        todaySales: selectedDateSalesAmount,
        lastWeekSales: lastWeekSalesAmount,
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
      };
    });
    
    restaurantSales.sort((a, b) => b.todaySales - a.todaySales);
    restaurantSales.forEach((r, idx) => {
      r.rank = idx + 1;
    });
    
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
      restaurants: restaurantSales,
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
    
    // For today: get real-time POS hourly sales
    let posHourlySales: Map<string, Map<number, number>> | null = null;
    if (isToday) {
      posHourlySales = await getAllHourlyPosSales(selectedDate);
    }
    
    const selectedDateHourly = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    });
    
    const lastWeekHourly = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    });
    
    const selectedByHour: Map<number, number> = new Map();
    const lastWeekByHour: Map<number, number> = new Map();
    const forecastByHour: Map<number, number> = new Map();
    const laborByHour: Map<number, number> = new Map();
    const actualLaborByHour: Map<number, number> = new Map();
    
    for (let h = 0; h < 24; h++) {
      selectedByHour.set(h, 0);
      lastWeekByHour.set(h, 0);
      forecastByHour.set(h, 0);
      laborByHour.set(h, 0);
      actualLaborByHour.set(h, 0);
    }
    
    if (restaurantId === "all") {
      // For today: use POS data for current sales
      if (isToday && posHourlySales) {
        posHourlySales.forEach((hourlyMap, restId) => {
          hourlyMap.forEach((sales, hour) => {
            const current = selectedByHour.get(hour) || 0;
            selectedByHour.set(hour, current + sales);
          });
        });
      } else {
        selectedDateHourly.forEach(s => {
          const current = selectedByHour.get(s.hour) || 0;
          selectedByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
        });
      }
      // Forecast from 7shifts
      selectedDateHourly.forEach(s => {
        const currentForecast = forecastByHour.get(s.hour) || 0;
        forecastByHour.set(s.hour, currentForecast + parseFloat(s.projectedSales || '0'));
        // Projected labor for this hour
        const currentLabor = laborByHour.get(s.hour) || 0;
        laborByHour.set(s.hour, currentLabor + parseFloat(s.projectedLabor || '0'));
        // Actual labor for this hour
        const currentActualLabor = actualLaborByHour.get(s.hour) || 0;
        actualLaborByHour.set(s.hour, currentActualLabor + parseFloat(s.actualLabor || '0'));
      });
      // Last week from 7shifts
      lastWeekHourly.forEach(s => {
        const current = lastWeekByHour.get(s.hour) || 0;
        lastWeekByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
      });
    } else {
      // For today: use POS data for the specific restaurant
      if (isToday && posHourlySales) {
        const restaurantPosData = posHourlySales.get(restaurantId);
        if (restaurantPosData) {
          restaurantPosData.forEach((sales, hour) => {
            selectedByHour.set(hour, sales);
          });
        }
      } else {
        selectedDateHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
          selectedByHour.set(s.hour, parseFloat(s.actualSales || '0'));
        });
      }
      // Forecast and labor from 7shifts
      selectedDateHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
        forecastByHour.set(s.hour, parseFloat(s.projectedSales || '0'));
        laborByHour.set(s.hour, parseFloat(s.projectedLabor || '0'));
        actualLaborByHour.set(s.hour, parseFloat(s.actualLabor || '0'));
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
      hourlyData.push({
        hour,
        todaySales: showCumulativeSelected,
        lastWeekSales: showCumulativeLastWeek,
        forecastSales: showCumulativeForecast,
        projectedLabor,
        actualLabor, // Use actual labor as-is from 7shifts punched hours
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
    
    // For today: get real-time POS hourly sales
    let posHourlySales: Map<string, Map<number, number>> | null = null;
    if (isToday) {
      posHourlySales = await getAllHourlyPosSales(selectedDate);
    }
    
    const selectedDateHourly = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    });
    
    const lastWeekHourly = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    });
    
    const result: Record<string, HourlySalesData[]> = {};
    
    for (const restaurant of restaurantList) {
      const hourlyData: HourlySalesData[] = [];
      
      const restaurantSelectedHourly = selectedDateHourly.filter(s => s.restaurantId === restaurant.id);
      const restaurantLastWeekHourly = lastWeekHourly.filter(s => s.restaurantId === restaurant.id);
      
      const selectedByHour: Map<number, number> = new Map();
      const lastWeekByHour: Map<number, number> = new Map();
      const forecastByHour: Map<number, number> = new Map();
      const laborByHour: Map<number, number> = new Map();
      const actualLaborByHour: Map<number, number> = new Map();
      
      // For today: use POS data for current sales
      if (isToday && posHourlySales) {
        const restaurantPosData = posHourlySales.get(restaurant.id);
        if (restaurantPosData) {
          restaurantPosData.forEach((sales, hour) => {
            selectedByHour.set(hour, sales);
          });
        }
      } else {
        restaurantSelectedHourly.forEach(s => {
          selectedByHour.set(s.hour, parseFloat(s.actualSales || '0'));
        });
      }
      
      // Forecast and labor from 7shifts
      restaurantSelectedHourly.forEach(s => {
        forecastByHour.set(s.hour, parseFloat(s.projectedSales || '0'));
        laborByHour.set(s.hour, parseFloat(s.projectedLabor || '0'));
        actualLaborByHour.set(s.hour, parseFloat(s.actualLabor || '0'));
      });
      // Last week from 7shifts
      restaurantLastWeekHourly.forEach(s => {
        lastWeekByHour.set(s.hour, parseFloat(s.actualSales || '0'));
      });
      
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
        
        if (todaySales > 0 || lastWeekSales > 0 || forecastSales > 0) {
          const projectedLabor = Math.round((laborByHour.get(hour) || 0) * 100) / 100;
          const actualLabor = Math.round((actualLaborByHour.get(hour) || 0) * 100) / 100;
          hourlyData.push({
            hour,
            todaySales,
            lastWeekSales,
            forecastSales,
            projectedLabor,
            actualLabor, // Use actual labor as-is from 7shifts punched hours
            label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
          });
        }
      }
      
      result[restaurant.id] = hourlyData;
    }
    
    return result;
  }
}

export const storage = new DatabaseStorage();
