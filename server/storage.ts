import { 
  type User, 
  type InsertUser, 
  type Restaurant, 
  type InsertRestaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData 
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Restaurant methods
  getRestaurants(): Promise<Restaurant[]>;
  getRestaurant(id: string): Promise<Restaurant | undefined>;
  
  // Sales methods
  getLeaderboard(): Promise<LeaderboardData>;
  getPaceData(restaurantId: string): Promise<HourlySalesData[]>;
}

// Sample restaurant data
const sampleRestaurants: Restaurant[] = [
  { id: "r1", name: "Downtown Grill", timezone: "America/New_York", isActive: true },
  { id: "r2", name: "Midtown Express", timezone: "America/New_York", isActive: true },
  { id: "r3", name: "Harbor View", timezone: "America/New_York", isActive: true },
  { id: "r4", name: "Central Kitchen", timezone: "America/Chicago", isActive: true },
  { id: "r5", name: "Lakeside Diner", timezone: "America/Chicago", isActive: true },
  { id: "r6", name: "University Square", timezone: "America/Chicago", isActive: true },
  { id: "r7", name: "Airport Hub", timezone: "America/New_York", isActive: true },
  { id: "r8", name: "Mall Food Court", timezone: "America/Chicago", isActive: true },
];

// Generate realistic hourly sales pattern
function generateHourlySales(baseDaily: number): number[] {
  // Restaurant sales pattern: low morning, peak lunch, lower afternoon, peak dinner
  const hourlyPattern = [
    0.01, 0.01, 0.01, 0.01, 0.02, 0.03, // 12am-5am
    0.04, 0.05, 0.06, 0.07, 0.08, 0.10, // 6am-11am (breakfast)
    0.12, 0.11, 0.08, 0.06, 0.05, 0.07, // 12pm-5pm (lunch/afternoon)
    0.10, 0.12, 0.11, 0.08, 0.05, 0.03, // 6pm-11pm (dinner)
  ];
  
  return hourlyPattern.map(pct => Math.round(baseDaily * pct * (0.85 + Math.random() * 0.3)));
}

// Get current hour in a timezone
function getCurrentHourInTimezone(timezone: string): number {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = { 
    hour: 'numeric', 
    hour12: false, 
    timeZone: timezone 
  };
  return parseInt(new Intl.DateTimeFormat('en-US', options).format(now));
}

// Get the minimum current hour across all timezones for fair comparison
// This ensures all restaurants are compared at the same number of business hours
function getNormalizedHourCutoff(restaurants: Restaurant[]): number {
  const timezones = [...new Set(restaurants.map(r => r.timezone))];
  const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
  // Use the minimum hour so no restaurant has "extra" time
  return Math.min(...currentHours);
}

// Generate sample sales data based on time of day
function generateSampleSalesData(): Map<string, { today: number[], lastWeek: number[] }> {
  const salesData = new Map<string, { today: number[], lastWeek: number[] }>();
  
  // Different base daily sales for each restaurant
  const baseSales: Record<string, number> = {
    r1: 12500,
    r2: 9800,
    r3: 11200,
    r4: 8900,
    r5: 7500,
    r6: 10300,
    r7: 14200,
    r8: 6800,
  };
  
  sampleRestaurants.forEach(restaurant => {
    const base = baseSales[restaurant.id] || 10000;
    // Last week is the baseline
    const lastWeek = generateHourlySales(base);
    // Today can be ahead or behind
    const variance = 0.9 + Math.random() * 0.25; // 90% to 115% of last week
    const today = generateHourlySales(base * variance);
    
    salesData.set(restaurant.id, { today, lastWeek });
  });
  
  return salesData;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private restaurants: Map<string, Restaurant>;
  private salesData: Map<string, { today: number[], lastWeek: number[] }>;

  constructor() {
    this.users = new Map();
    this.restaurants = new Map(sampleRestaurants.map(r => [r.id, r]));
    this.salesData = generateSampleSalesData();
  }

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
    return Array.from(this.restaurants.values()).filter(r => r.isActive);
  }

  async getRestaurant(id: string): Promise<Restaurant | undefined> {
    return this.restaurants.get(id);
  }

  async getLeaderboard(): Promise<LeaderboardData> {
    const restaurants = await this.getRestaurants();
    const now = new Date();
    
    // Get the normalized hour cutoff for fair comparison across timezones
    // This ensures Eastern stores (1 hour ahead) don't get credit for extra sales time
    const normalizedHourCutoff = getNormalizedHourCutoff(restaurants);
    
    const restaurantSales: RestaurantSales[] = restaurants.map(restaurant => {
      const localCurrentHour = getCurrentHourInTimezone(restaurant.timezone);
      const sales = this.salesData.get(restaurant.id);
      
      if (!sales) {
        return {
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          timezone: restaurant.timezone,
          todaySales: 0,
          lastWeekSales: 0,
          pacePercentage: 0,
          isAheadOfPace: false,
          rank: 0,
          normalizedHour: normalizedHourCutoff,
        };
      }
      
      // CRITICAL: Use normalized hour cutoff for TODAY'S sales comparison
      // This ensures all restaurants are compared at the same number of business hours
      const todaySales = sales.today.slice(0, normalizedHourCutoff + 1).reduce((a, b) => a + b, 0);
      
      // For last week, we compare against the full day total
      const lastWeekSales = sales.lastWeek.reduce((a, b) => a + b, 0);
      
      // Also get last week at the same normalized hour for pace comparison
      const lastWeekAtNormalizedHour = sales.lastWeek.slice(0, normalizedHourCutoff + 1).reduce((a, b) => a + b, 0);
      
      // Pace percentage = how far through the day (by normalized hour)
      const pacePercentage = ((normalizedHourCutoff + 1) / 24) * 100;
      
      // Are they ahead of where they were last week at this normalized hour?
      const isAheadOfPace = todaySales >= lastWeekAtNormalizedHour;
      
      return {
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        todaySales,
        lastWeekSales,
        pacePercentage,
        isAheadOfPace,
        rank: 0,
        normalizedHour: normalizedHourCutoff,
      };
    });
    
    // Sort by today's sales (descending) and assign ranks
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
    const restaurants = await this.getRestaurants();
    const normalizedHourCutoff = getNormalizedHourCutoff(restaurants);
    
    if (restaurantId === "all") {
      // Aggregate all restaurants with normalized hour cutoff
      for (let hour = 0; hour < 24; hour++) {
        let todayTotal = 0;
        let lastWeekTotal = 0;
        
        restaurants.forEach(restaurant => {
          const sales = this.salesData.get(restaurant.id);
          if (sales) {
            // For today, only include hours up to normalized cutoff
            if (hour <= normalizedHourCutoff) {
              todayTotal += sales.today[hour] || 0;
            }
            lastWeekTotal += sales.lastWeek[hour] || 0;
          }
        });
        
        hourlyData.push({
          hour,
          todaySales: hour <= normalizedHourCutoff ? todayTotal : 0,
          lastWeekSales: lastWeekTotal,
          label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
        });
      }
    } else {
      const sales = this.salesData.get(restaurantId);
      if (!sales) return hourlyData;
      
      for (let hour = 0; hour < 24; hour++) {
        hourlyData.push({
          hour,
          todaySales: hour <= normalizedHourCutoff ? sales.today[hour] || 0 : 0,
          lastWeekSales: sales.lastWeek[hour] || 0,
          label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
        });
      }
    }
    
    return hourlyData;
  }
}

export const storage = new MemStorage();
