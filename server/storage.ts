import { 
  type User, 
  type InsertUser, 
  type Restaurant, 
  type InsertRestaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData,
  restaurants,
  dailySales
} from "@shared/schema";
import { db } from "./db";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getRestaurants(): Promise<Restaurant[]>;
  getRestaurant(id: string): Promise<Restaurant | undefined>;
  
  getLeaderboard(): Promise<LeaderboardData>;
  getPaceData(restaurantId: string): Promise<HourlySalesData[]>;
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

function getNormalizedHourCutoff(restaurantList: Restaurant[]): number {
  const timezones = Array.from(new Set(restaurantList.map(r => r.timezone)));
  const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
  const minCurrentHour = Math.min(...currentHours);
  // Use the last COMPLETED hour, not the current hour
  // If Central is at 1pm (hour 13), they've only completed through hour 12
  return Math.max(0, minCurrentHour - 1);
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

  async getLeaderboard(): Promise<LeaderboardData> {
    const now = new Date();
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    
    const todayStr = today.toISOString().split('T')[0];
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    
    const restaurantList = await this.getRestaurants();
    const normalizedHourCutoff = getNormalizedHourCutoff(restaurantList);
    
    const allSales = await db.select().from(dailySales);
    
    const todaySales = allSales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === todayStr;
    });
    
    const lastWeekSales = allSales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    });
    
    const todaySalesMap = new Map(todaySales.map(s => [s.restaurantId, s]));
    const lastWeekSalesMap = new Map(lastWeekSales.map(s => [s.restaurantId, s]));
    
    const restaurantSales: RestaurantSales[] = restaurantList.map(restaurant => {
      const todayData = todaySalesMap.get(restaurant.id);
      const lastWeekData = lastWeekSalesMap.get(restaurant.id);
      
      const todaySalesAmount = todayData ? parseFloat(todayData.totalSales || '0') / 100 : 0;
      const lastWeekSalesAmount = lastWeekData ? parseFloat(lastWeekData.totalSales || '0') / 100 : 0;
      
      const pacePercentage = ((normalizedHourCutoff + 1) / 24) * 100;
      const expectedAtThisPoint = lastWeekSalesAmount * (pacePercentage / 100);
      const isAheadOfPace = todaySalesAmount >= expectedAtThisPoint;
      
      return {
        restaurantId: restaurant.id.toString(),
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        todaySales: todaySalesAmount,
        lastWeekSales: lastWeekSalesAmount,
        pacePercentage,
        isAheadOfPace,
        rank: 0,
        normalizedHour: normalizedHourCutoff,
      };
    });
    
    restaurantSales.sort((a, b) => b.todaySales - a.todaySales);
    restaurantSales.forEach((r, idx) => {
      r.rank = idx + 1;
    });
    
    return {
      restaurants: restaurantSales,
      lastUpdated: now.toISOString(),
      currentDate: now.toISOString().split('T')[0],
    };
  }

  async getPaceData(restaurantId: string): Promise<HourlySalesData[]> {
    const hourlyData: HourlySalesData[] = [];
    const restaurantList = await this.getRestaurants();
    const normalizedHourCutoff = getNormalizedHourCutoff(restaurantList);
    
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    
    const todayStr = today.toISOString().split('T')[0];
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    
    const allSales = await db.select().from(dailySales);
    
    const todaySales = allSales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === todayStr;
    });
    
    const lastWeekSales = allSales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    });
    
    let todayTotal = 0;
    let lastWeekTotal = 0;
    
    if (restaurantId === "all") {
      todaySales.forEach(s => {
        todayTotal += parseFloat(s.totalSales || '0') / 100;
      });
      lastWeekSales.forEach(s => {
        lastWeekTotal += parseFloat(s.totalSales || '0') / 100;
      });
    } else {
      const todayData = todaySales.find(s => s.restaurantId === restaurantId);
      const lastWeekData = lastWeekSales.find(s => s.restaurantId === restaurantId);
      todayTotal = todayData ? parseFloat(todayData.totalSales || '0') / 100 : 0;
      lastWeekTotal = lastWeekData ? parseFloat(lastWeekData.totalSales || '0') / 100 : 0;
    }
    
    const hourlyPattern = [
      0.01, 0.01, 0.01, 0.01, 0.02, 0.03,
      0.04, 0.05, 0.06, 0.07, 0.08, 0.10,
      0.12, 0.11, 0.08, 0.06, 0.05, 0.07,
      0.10, 0.12, 0.11, 0.08, 0.05, 0.03,
    ];
    
    let cumulativeToday = 0;
    let cumulativeLastWeek = 0;
    
    for (let hour = 0; hour < 24; hour++) {
      const hourPercent = hourlyPattern[hour];
      
      if (hour <= normalizedHourCutoff) {
        cumulativeToday += todayTotal * hourPercent;
      }
      cumulativeLastWeek += lastWeekTotal * hourPercent;
      
      hourlyData.push({
        hour,
        todaySales: hour <= normalizedHourCutoff ? Math.round(cumulativeToday) : 0,
        lastWeekSales: Math.round(cumulativeLastWeek),
        label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
      });
    }
    
    return hourlyData;
  }
}

export const storage = new DatabaseStorage();
