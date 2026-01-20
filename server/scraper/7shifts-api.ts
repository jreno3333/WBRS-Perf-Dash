import { db } from '../db';
import { restaurants, dailySales, hourlySales, scraperRuns } from '@shared/schema';
import { eq, and, gte, lt } from 'drizzle-orm';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

interface SevenShiftsLocation {
  id: number;
  name: string;
  address: string;
  timezone: string;
  country: string;
}

interface SevenShiftsSalesData {
  date: string;
  actual_sales: number;
  projected_sales: number;
  actual_labor_cost: number;
  projected_labor_cost: number;
  sales_per_labor_hour: number;
  labor_percent: number;
}

interface HourlyInterval {
  day: string;
  start: string;
  end: string;
  actual_sales: number;
  projected_sales: number;
  past_actual_sales: number;
  past_projected_sales: number;
  actual_labor: number;
  projected_labor: number;
}

interface DailyStatsResponse {
  data: {
    summary: {
      current_actual_sales: number;
      current_projected_sales: number;
      past_actual_sales: number;
      past_projected_sales: number;
    };
    intervals: HourlyInterval[];
  };
}

interface TimePunch {
  id: number;
  user_id: number;
  location_id: number;
  department_id: number;
  role_id: number;
  clocked_in: string;
  clocked_out: string | null;
  approved: boolean;
  hourly_wage: number;
  breaks: { in: string; out: string | null; paid: boolean }[];
}

interface TimePunchesResponse {
  data: TimePunch[];
  meta: {
    cursor?: {
      next?: string;
    };
  };
}

interface ApiConfig {
  accessToken: string;
  companyId?: number;
}

export class SevenShiftsAPI {
  private baseUrl = 'https://api.7shifts.com';
  private accessToken: string;
  private companyId: number | null = null;

  constructor(config: ApiConfig) {
    this.accessToken = config.accessToken;
    this.companyId = config.companyId || null;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`7shifts API error ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  async getCompany(): Promise<{ id: number; name: string }> {
    const response = await this.request<any>('/v2/whoami');
    
    const users = response.data?.users || [];
    if (users.length === 0) {
      throw new Error('No users found in whoami response');
    }
    
    const companyId = users[0].company_id;
    console.log(`Found company_id: ${companyId} for user: ${users[0].first_name} ${users[0].last_name}`);
    
    this.companyId = companyId;
    return { id: companyId, name: `Company ${companyId}` };
  }

  async getLocations(): Promise<SevenShiftsLocation[]> {
    if (!this.companyId) {
      await this.getCompany();
    }
    
    console.log(`Fetching locations for company ${this.companyId}...`);
    const response = await this.request<any>(
      `/v2/company/${this.companyId}/locations`
    );
    console.log(`Locations response:`, JSON.stringify(response, null, 2).substring(0, 1000));
    
    return response.data || response || [];
  }

  async getDailySalesReport(locationId: number, startDate: string, endDate: string): Promise<SevenShiftsSalesData[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    try {
      const response = await this.request<any>(
        `/v2/reports/daily_sales_and_labor?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}`
      );
      return response.data || [];
    } catch (error) {
      console.error(`Error fetching sales for location ${locationId}:`, error);
      return [];
    }
  }

  async getHourlySales(locationId: number, date: string): Promise<HourlyInterval[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    try {
      const response = await this.request<DailyStatsResponse>(
        `/v2/company/${this.companyId}/location/${locationId}/daily_stats?date=${date}`
      );
      return response.data?.intervals || [];
    } catch (error) {
      console.error(`Error fetching hourly sales for location ${locationId}:`, error);
      return [];
    }
  }

  // Fetch time punches for a location on a specific date
  // Includes punches that started before the target date but continued into it
  async getTimePunches(locationId: number, date: string): Promise<TimePunch[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    try {
      // Fetch punches that could possibly overlap the target day:
      // - Start from day before (at 4am local = 10am/9am UTC) to catch overnight shifts (e.g., 10pm-6am)
      // - The getEmployeesPerHour function will filter to only count hours within the target day
      const dayBefore = new Date(date);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const dayBeforeStr = dayBefore.toISOString().split('T')[0];
      
      // Use 4am (local) as start time - this catches any overnight shifts that started after 4am the previous day
      // Most overnight shifts start around 10pm, so 4am the day before gives us plenty of buffer
      const startDate = `${dayBeforeStr}T04:00:00`;
      const endDate = `${date}T23:59:59`;
      
      // Fetch punches where clocked_in is within range
      // Add limit=500 to get more results (7shifts API defaults to low limit)
      const response = await this.request<TimePunchesResponse>(
        `/v2/company/${this.companyId}/time_punches?location_id=${locationId}&clocked_in[gte]=${startDate}&clocked_in[lte]=${endDate}&limit=500`
      );
      return response.data || [];
    } catch (error) {
      console.error(`Error fetching time punches for location ${locationId}:`, error);
      return [];
    }
  }

  // Calculate employees on clock for each hour based on time punches
  // Uses date string and location timezone to determine target day boundaries
  // Timezone parameter ensures hour boundaries match the location's local time
  getEmployeesPerHour(punches: TimePunch[], date: string, timezone: string): Map<number, number> {
    const employeesByHour = new Map<number, number>();
    
    // Initialize all hours to 0
    for (let h = 0; h < 24; h++) {
      employeesByHour.set(h, 0);
    }
    
    // Use fromZonedTime with string-based date creation to avoid server timezone issues
    // This approach creates a string that represents the local time in the target timezone
    // and then converts it to UTC for comparison with punch times
    const startOfDayUTC = fromZonedTime(`${date}T00:00:00`, timezone);
    const endOfDayUTC = fromZonedTime(`${date}T23:59:59.999`, timezone);
    
    // For each punch, count which hours the employee was on clock
    for (const punch of punches) {
      // 7shifts returns punch times as ISO strings with timezone offset
      // Parsing with new Date() gives us UTC time
      let clockIn = new Date(punch.clocked_in);
      
      // Clamp clock out to end of target day for open punches
      let clockOut: Date;
      if (punch.clocked_out) {
        clockOut = new Date(punch.clocked_out);
      } else {
        // Still on clock - clamp to end of target day or current time, whichever is earlier
        const now = new Date();
        clockOut = now < endOfDayUTC ? now : endOfDayUTC;
      }
      
      // Skip if punch ended before start of day or started after end of day
      if (clockOut < startOfDayUTC || clockIn > endOfDayUTC) {
        continue;
      }
      
      // Clamp punch times to the target day window to avoid counting hours outside the day
      // This is critical for overnight shifts that start before midnight
      if (clockIn < startOfDayUTC) {
        clockIn = startOfDayUTC;
      }
      if (clockOut > endOfDayUTC) {
        clockOut = endOfDayUTC;
      }
      
      // Determine hours this employee was on clock
      for (let h = 0; h < 24; h++) {
        // Create hour boundaries in local timezone using string format, then convert to UTC
        const hourStr = h.toString().padStart(2, '0');
        const hourStartUTC = fromZonedTime(`${date}T${hourStr}:00:00`, timezone);
        const hourEndUTC = fromZonedTime(`${date}T${hourStr}:59:59.999`, timezone);
        
        // Employee was on clock during this hour if there's any overlap
        // Overlap exists if: clockIn <= hourEnd AND clockOut >= hourStart
        if (clockIn <= hourEndUTC && clockOut >= hourStartUTC) {
          employeesByHour.set(h, (employeesByHour.get(h) || 0) + 1);
        }
      }
    }
    
    return employeesByHour;
  }
}

export async function syncLocationsFromAPI(): Promise<number> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    throw new Error('SEVENSHIFTS_API_TOKEN not configured');
  }

  const api = new SevenShiftsAPI({ accessToken });
  const locations = await api.getLocations();
  
  let syncedCount = 0;
  
  for (const location of locations) {
    const existingRestaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.name, location.name),
    });
    
    if (!existingRestaurant) {
      await db.insert(restaurants).values({
        name: location.name,
        timezone: location.timezone || 'America/Chicago',
        isActive: true,
      });
      console.log(`Created restaurant: ${location.name}`);
    }
    syncedCount++;
  }
  
  console.log(`Synced ${syncedCount} locations from 7shifts`);
  return syncedCount;
}

export async function fetchSalesFromAPI(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      recordsScraped: 0,
      error: 'SEVENSHIFTS_API_TOKEN not configured',
    };
  }

  const [scraperRun] = await db.insert(scraperRuns).values({
    status: 'running',
  }).returning();

  try {
    const api = new SevenShiftsAPI({ accessToken });
    
    console.log('Fetching company info...');
    const company = await api.getCompany();
    console.log(`Company: ${company.name} (ID: ${company.id})`);
    
    console.log('Fetching locations...');
    const locations = await api.getLocations();
    console.log(`Found ${locations.length} locations`);
    
    // Use Central timezone to determine "today" since server runs in UTC
    // This ensures 9 PM ET / 8 PM CT on Jan 19 syncs Jan 19 data, not Jan 20
    let targetDate: Date;
    let dateStr: string;
    
    if (date) {
      targetDate = date;
      dateStr = date.toISOString().split('T')[0];
    } else {
      // Get today's date in Central timezone (handles DST automatically)
      dateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      // Create a Date object for noon UTC on the target date
      // Using noon UTC avoids timezone offset issues with midnight boundaries
      // The date portion will match the Central timezone date
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    }
    
    let recordsScraped = 0;
    
    for (const location of locations) {
      console.log(`Fetching sales for ${location.name}...`);
      
      let restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.name, location.name),
      });
      
      if (!restaurant) {
        const [newRestaurant] = await db.insert(restaurants).values({
          name: location.name,
          timezone: location.timezone || 'America/Chicago',
          isActive: true,
        }).returning();
        restaurant = newRestaurant;
        console.log(`Created restaurant: ${location.name}`);
      }
      
      const salesData = await api.getDailySalesReport(location.id, dateStr, dateStr);
      
      if (salesData.length > 0) {
        const dayData = salesData[0];
        
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        
        const existing = await db.query.dailySales.findFirst({
          where: and(
            eq(dailySales.restaurantId, restaurant.id),
            gte(dailySales.salesDate, startOfDay),
            lt(dailySales.salesDate, endOfDay)
          ),
        });
        
        if (existing) {
          await db.update(dailySales)
            .set({
              totalSales: dayData.actual_sales.toString(),
              vsProjected: (dayData.actual_sales - dayData.projected_sales).toString(),
              laborPercent: (dayData.labor_percent * 100).toString(),
              projectedLaborCost: (dayData.projected_labor_cost / 100).toFixed(2), // Convert from cents
              scrapedAt: new Date(),
            })
            .where(eq(dailySales.id, existing.id));
        } else {
          await db.insert(dailySales).values({
            restaurantId: restaurant.id,
            locationCode: location.id.toString(),
            salesDate: targetDate,
            totalSales: dayData.actual_sales.toString(),
            vsProjected: (dayData.actual_sales - dayData.projected_sales).toString(),
            laborPercent: (dayData.labor_percent * 100).toString(),
            projectedLaborCost: (dayData.projected_labor_cost / 100).toFixed(2), // Convert from cents
          });
        }
        
        recordsScraped++;
        console.log(`Saved sales for ${location.name}: $${(dayData.actual_sales / 100).toFixed(2)}`);
      }
    }
    
    await db.update(scraperRuns)
      .set({
        status: 'success',
        completedAt: new Date(),
        recordsScraped,
      })
      .where(eq(scraperRuns.id, scraperRun.id));
    
    console.log(`API sync completed. ${recordsScraped} records saved.`);
    return { success: true, recordsScraped };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await db.update(scraperRuns)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(scraperRuns.id, scraperRun.id));
    
    console.error('API sync failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };
  }
}

export async function fetchHistoricalSales(days: number = 7): Promise<void> {
  console.log(`Fetching ${days} days of historical sales data...`);
  
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    console.log(`Fetching data for ${date.toISOString().split('T')[0]}...`);
    const result = await fetchSalesFromAPI(date);
    
    if (!result.success) {
      console.error(`Failed to fetch ${date.toISOString().split('T')[0]}: ${result.error}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300)); // Reduced delay for faster seeding
  }
  
  console.log('Historical data fetch complete');
}

export async function fetchHistoricalHourlySales(days: number = 8): Promise<void> {
  console.log(`Fetching ${days} days of historical hourly sales data...`);
  
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    console.log(`Fetching hourly data for ${date.toISOString().split('T')[0]}...`);
    const result = await fetchHourlySalesFromAPI(date);
    
    if (!result.success) {
      console.error(`Failed to fetch hourly ${date.toISOString().split('T')[0]}: ${result.error}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500)); // Reduced delay for faster seeding
  }
  
  console.log('Historical hourly data fetch complete');
}

export async function fetchHourlySalesFromAPI(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      recordsScraped: 0,
      error: 'SEVENSHIFTS_API_TOKEN not configured',
    };
  }

  try {
    const api = new SevenShiftsAPI({ accessToken });
    await api.getCompany();
    
    const locations = await api.getLocations();
    
    // Use Central timezone to determine "today" since server runs in UTC
    // This ensures 9 PM ET / 8 PM CT on Jan 19 syncs Jan 19 data, not Jan 20
    let targetDate: Date;
    let dateStr: string;
    
    if (date) {
      targetDate = date;
      dateStr = date.toISOString().split('T')[0];
    } else {
      // Get today's date in Central timezone (handles DST automatically)
      dateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      // Create a Date object for noon UTC on the target date
      // Using noon UTC avoids timezone offset issues with midnight boundaries
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    }
    
    let recordsScraped = 0;
    
    for (const location of locations) {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.name, location.name),
      });
      
      if (!restaurant) {
        console.log(`Restaurant not found for location: ${location.name}`);
        continue;
      }
      
      const intervals = await api.getHourlySales(location.id, dateStr);
      
      // Fetch time punches to calculate employees on clock per hour
      // Use restaurant.timezone from our database (not 7shifts API) for proper timezone-aware hour boundary calculations
      // 7shifts API returns America/Chicago for all locations regardless of actual timezone
      const timePunches = await api.getTimePunches(location.id, dateStr);
      const locationTimezone = restaurant.timezone || 'America/Chicago'; // Use our DB timezone, default to Central
      const employeesByHour = api.getEmployeesPerHour(timePunches, dateStr, locationTimezone);
      
      if (intervals.length > 0) {
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        
        await db.delete(hourlySales)
          .where(and(
            eq(hourlySales.restaurantId, restaurant.id),
            gte(hourlySales.salesDate, startOfDay),
            lt(hourlySales.salesDate, endOfDay)
          ));
        
        for (const interval of intervals) {
          const hourMatch = interval.start.match(/T(\d{2}):/);
          const hour = hourMatch ? parseInt(hourMatch[1]) : 0;
          
          await db.insert(hourlySales).values({
            restaurantId: restaurant.id,
            salesDate: targetDate,
            hour,
            actualSales: (interval.actual_sales / 100).toFixed(2),
            projectedSales: (interval.projected_sales / 100).toFixed(2),
            pastActualSales: (interval.past_actual_sales / 100).toFixed(2),
            projectedLabor: (interval.projected_labor / 100).toFixed(2), // Scheduled labor cost for this hour
            actualLabor: (interval.actual_labor / 100).toFixed(2), // Actual labor cost from punched hours
            employeeCount: employeesByHour.get(hour) || 0, // Number of employees on clock
          });
          
          recordsScraped++;
        }
        
        console.log(`Saved ${intervals.length} hourly records for ${location.name} (${timePunches.length} time punches)`);
      }
    }
    
    console.log(`Hourly sync completed. ${recordsScraped} records saved.`);
    return { success: true, recordsScraped };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Hourly sync failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };
  }
}
