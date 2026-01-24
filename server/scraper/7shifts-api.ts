import { db } from '../db';
import { restaurants, dailySales, hourlySales, scraperRuns, locationMapping, posOrders } from '@shared/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

interface SevenShiftsLocation {
  id: number;
  name: string;
  address: string;
  timezone: string;
  country: string;
  lat?: number;
  lng?: number;
  formatted_address?: string;
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

interface Role {
  id: number;
  name: string;
  location_id: number;
  department_id: number;
}

interface RolesResponse {
  data: Role[];
}

interface LaborByHour {
  totalHours: number;
  byPosition: Record<string, number>; // e.g., { "Grill": 2.5, "Counter": 1.5 }
}

interface ScheduledShift {
  id: number;
  user_id: number;
  location_id: number;
  department_id: number;
  role_id: number;
  start: string;  // ISO timestamp
  end: string;    // ISO timestamp
}

interface ShiftsResponse {
  data: ScheduledShift[];
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
      // - Start from day before to catch overnight shifts that started the previous day
      // - End at noon the NEXT day to catch all punches that clocked in late at night
      //   (7shifts may interpret times as UTC, so 23:59 local could be 5:59pm UTC for Central time)
      const dayBefore = new Date(date);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const dayBeforeStr = dayBefore.toISOString().split('T')[0];
      
      const dayAfter = new Date(date);
      dayAfter.setDate(dayAfter.getDate() + 1);
      const dayAfterStr = dayAfter.toISOString().split('T')[0];
      
      // Use 4am day before to 12pm day after - wide window to ensure we capture all punches
      // getLaborHoursPerHour will filter to only count hours within the target day
      const startDate = `${dayBeforeStr}T04:00:00`;
      const endDate = `${dayAfterStr}T12:00:00`;
      
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

  // Fetch all roles for a location to map role_id to role name
  async getRoles(locationId: number): Promise<Map<number, string>> {
    if (!this.companyId) {
      await this.getCompany();
    }

    const roleMap = new Map<number, string>();
    
    try {
      const response = await this.request<RolesResponse>(
        `/v2/company/${this.companyId}/roles?location_id=${locationId}&limit=100`
      );
      
      for (const role of response.data || []) {
        roleMap.set(role.id, role.name);
      }
      
      return roleMap;
    } catch (error) {
      console.error(`Error fetching roles for location ${locationId}:`, error);
      return roleMap;
    }
  }

  // Fetch scheduled shifts for a location on a specific date
  // Returns scheduled shifts with role information to check for operators
  async getScheduledShifts(locationId: number, date: string): Promise<ScheduledShift[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    const allShifts: ScheduledShift[] = [];
    
    try {
      // Fetch shifts for the target date
      const startDate = `${date}T00:00:00`;
      const endDate = `${date}T23:59:59`;
      
      const response = await this.request<ShiftsResponse>(
        `/v2/company/${this.companyId}/shifts?location_id=${locationId}&start[gte]=${startDate}&end[lte]=${endDate}&limit=500`
      );
      
      allShifts.push(...(response.data || []));
      
      return allShifts;
    } catch (error) {
      console.error(`Error fetching scheduled shifts for location ${locationId}:`, error);
      return allShifts;
    }
  }

  // Check if an operator is scheduled for a specific hour
  // Operators don't punch in, so we check the schedule instead
  hasOperatorScheduledForHour(shifts: ScheduledShift[], roleMap: Map<number, string>, hour: number, timezone: string, date: string): boolean {
    for (const shift of shifts) {
      const roleName = roleMap.get(shift.role_id)?.toLowerCase() || '';
      if (roleName.includes('operator')) {
        // Check if this shift covers the given hour
        const shiftStart = new Date(shift.start);
        const shiftEnd = new Date(shift.end);
        
        // Convert hour to the same timezone for comparison
        const hourStart = fromZonedTime(`${date}T${hour.toString().padStart(2, '0')}:00:00`, timezone);
        const hourEnd = fromZonedTime(`${date}T${hour.toString().padStart(2, '0')}:59:59`, timezone);
        
        // Check if shift overlaps with this hour
        if (shiftStart <= hourEnd && shiftEnd >= hourStart) {
          return true;
        }
      }
    }
    return false;
  }

  // Calculate total labor hours worked for each hour based on time punches
  // Returns fractional hours (e.g., 5.6 hours) representing the sum of all employee time worked
  // Uses date string and location timezone to determine target day boundaries
  // Timezone parameter ensures hour boundaries match the location's local time
  getLaborHoursPerHour(punches: TimePunch[], date: string, timezone: string): Map<number, number> {
    const laborHoursByHour = new Map<number, number>();
    
    // Initialize all hours to 0
    for (let h = 0; h < 24; h++) {
      laborHoursByHour.set(h, 0);
    }
    
    // Use fromZonedTime with string-based date creation to avoid server timezone issues
    // This approach creates a string that represents the local time in the target timezone
    // and then converts it to UTC for comparison with punch times
    const startOfDayUTC = fromZonedTime(`${date}T00:00:00`, timezone);
    const endOfDayUTC = fromZonedTime(`${date}T23:59:59.999`, timezone);
    
    // For each punch, calculate the labor hours contributed to each hour
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
      
      // Calculate fractional hours worked for each hour interval
      for (let h = 0; h < 24; h++) {
        // Create hour boundaries in local timezone using string format, then convert to UTC
        const hourStr = h.toString().padStart(2, '0');
        const hourStartUTC = fromZonedTime(`${date}T${hourStr}:00:00`, timezone);
        // Use exact hour boundary (not 59:59.999) for accurate fraction calculation
        const nextHourStr = (h + 1).toString().padStart(2, '0');
        const hourEndUTC = h < 23 
          ? fromZonedTime(`${date}T${nextHourStr}:00:00`, timezone)
          : new Date(fromZonedTime(`${date}T23:59:59.999`, timezone).getTime() + 1);
        
        // Check if there's any overlap
        if (clockIn < hourEndUTC && clockOut > hourStartUTC) {
          // Calculate the actual overlap in this hour
          const overlapStart = clockIn > hourStartUTC ? clockIn : hourStartUTC;
          const overlapEnd = clockOut < hourEndUTC ? clockOut : hourEndUTC;
          
          // Calculate fraction of hour worked (in hours, e.g., 0.5 for 30 minutes)
          const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
          const hoursWorked = overlapMs / (1000 * 60 * 60); // Convert ms to hours
          
          laborHoursByHour.set(h, (laborHoursByHour.get(h) || 0) + hoursWorked);
        }
      }
    }
    
    return laborHoursByHour;
  }

  // Calculate labor hours per hour WITH position breakdown
  // Returns total hours AND breakdown by role/position name
  getLaborHoursWithPositions(
    punches: TimePunch[], 
    date: string, 
    timezone: string, 
    roleMap: Map<number, string>
  ): Map<number, LaborByHour> {
    const laborByHour = new Map<number, LaborByHour>();
    
    // Initialize all hours
    for (let h = 0; h < 24; h++) {
      laborByHour.set(h, { totalHours: 0, byPosition: {} });
    }
    
    const startOfDayUTC = fromZonedTime(`${date}T00:00:00`, timezone);
    const endOfDayUTC = fromZonedTime(`${date}T23:59:59.999`, timezone);
    
    for (const punch of punches) {
      let clockIn = new Date(punch.clocked_in);
      
      let clockOut: Date;
      if (punch.clocked_out) {
        clockOut = new Date(punch.clocked_out);
      } else {
        const now = new Date();
        clockOut = now < endOfDayUTC ? now : endOfDayUTC;
      }
      
      if (clockOut < startOfDayUTC || clockIn > endOfDayUTC) {
        continue;
      }
      
      if (clockIn < startOfDayUTC) clockIn = startOfDayUTC;
      if (clockOut > endOfDayUTC) clockOut = endOfDayUTC;
      
      // Get position name from role_id
      const positionName = roleMap.get(punch.role_id) || `Role ${punch.role_id}`;
      
      for (let h = 0; h < 24; h++) {
        const hourStr = h.toString().padStart(2, '0');
        const hourStartUTC = fromZonedTime(`${date}T${hourStr}:00:00`, timezone);
        const nextHourStr = (h + 1).toString().padStart(2, '0');
        const hourEndUTC = h < 23 
          ? fromZonedTime(`${date}T${nextHourStr}:00:00`, timezone)
          : new Date(fromZonedTime(`${date}T23:59:59.999`, timezone).getTime() + 1);
        
        if (clockIn < hourEndUTC && clockOut > hourStartUTC) {
          const overlapStart = clockIn > hourStartUTC ? clockIn : hourStartUTC;
          const overlapEnd = clockOut < hourEndUTC ? clockOut : hourEndUTC;
          const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
          const hoursWorked = overlapMs / (1000 * 60 * 60);
          
          const hourData = laborByHour.get(h)!;
          hourData.totalHours += hoursWorked;
          hourData.byPosition[positionName] = (hourData.byPosition[positionName] || 0) + hoursWorked;
        }
      }
    }
    
    return laborByHour;
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
        latitude: location.lat ? String(location.lat) : null,
        longitude: location.lng ? String(location.lng) : null,
        address: location.formatted_address || null,
      });
      console.log(`Created restaurant: ${location.name}`);
    } else {
      // Update existing restaurant with lat/lng if missing
      if (!existingRestaurant.latitude || !existingRestaurant.longitude) {
        await db.update(restaurants)
          .set({
            latitude: location.lat ? String(location.lat) : existingRestaurant.latitude,
            longitude: location.lng ? String(location.lng) : existingRestaurant.longitude,
            address: location.formatted_address || existingRestaurant.address,
          })
          .where(eq(restaurants.id, existingRestaurant.id));
        console.log(`Updated coordinates for: ${location.name}`);
      }
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
      
      // Fetch time punches to calculate total labor hours deployed per hour
      // Use restaurant.timezone from our database (not 7shifts API) for proper timezone-aware hour boundary calculations
      // 7shifts API returns America/Chicago for all locations regardless of actual timezone
      const timePunches = await api.getTimePunches(location.id, dateStr);
      const locationTimezone = restaurant.timezone || 'America/Chicago'; // Use our DB timezone, default to Central
      
      // Fetch roles to map role_id to position names
      const roleMap = await api.getRoles(location.id);
      
      // Fetch scheduled shifts to check for operators (they don't punch in)
      const scheduledShifts = await api.getScheduledShifts(location.id, dateStr);
      
      // Get labor hours WITH position breakdown
      const laborByHour = api.getLaborHoursWithPositions(timePunches, dateStr, locationTimezone, roleMap);
      
      if (intervals.length > 0) {
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        
        // Use transaction to ensure atomic delete + insert (prevents race conditions with queries)
        await db.transaction(async (tx) => {
          await tx.delete(hourlySales)
            .where(and(
              eq(hourlySales.restaurantId, restaurant.id),
              gte(hourlySales.salesDate, startOfDay),
              lt(hourlySales.salesDate, endOfDay)
            ));
          
          for (const interval of intervals) {
            const hourMatch = interval.start.match(/T(\d{2}):/);
            const hour = hourMatch ? parseInt(hourMatch[1]) : 0;
            
            const hourLabor = laborByHour.get(hour) || { totalHours: 0, byPosition: {} };
            
            // Round position hours to 2 decimal places for cleaner storage
            const roundedPositions: Record<string, number> = {};
            for (const [pos, hrs] of Object.entries(hourLabor.byPosition)) {
              roundedPositions[pos] = Math.round(hrs * 100) / 100;
            }
            
            // Check if an operator is scheduled for this hour (they don't punch in)
            const hasOperator = api.hasOperatorScheduledForHour(scheduledShifts, roleMap, hour, locationTimezone, dateStr);
            if (hasOperator) {
              // Store operator presence as a special flag in position breakdown
              roundedPositions['_operatorScheduled'] = 1;
            }
            
            await tx.insert(hourlySales).values({
              restaurantId: restaurant.id,
              salesDate: targetDate,
              hour,
              actualSales: (interval.actual_sales / 100).toFixed(2),
              projectedSales: (interval.projected_sales / 100).toFixed(2),
              pastActualSales: (interval.past_actual_sales / 100).toFixed(2),
              projectedLabor: (interval.projected_labor / 100).toFixed(2),
              actualLabor: (interval.actual_labor / 100).toFixed(2),
              employeeCount: (Math.round(hourLabor.totalHours * 100) / 100).toFixed(2),
              positionBreakdown: roundedPositions,
            });
            
            recordsScraped++;
          }
        });
        
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

// Hybrid sync: Uses Xenial POS for sales data + 7shifts for labor data
// This removes the 24-hour constraint from 7shifts and provides real-time sales updates
export async function syncSalesWithXenialPOS(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
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
    
    // Determine target date in Central timezone
    let targetDate: Date;
    let dateStr: string;
    
    if (date) {
      targetDate = date;
      dateStr = date.toISOString().split('T')[0];
    } else {
      dateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    }
    
    // Get all restaurants with their location mappings
    const allRestaurants = await db.select().from(restaurants);
    const allMappings = await db.select().from(locationMapping);
    
    // Build mapping from restaurant ID to Xenial store numbers
    const restaurantToXenial = new Map<string, string>();
    const sevenShiftsToRestaurant = new Map<string, string>();
    for (const mapping of allMappings) {
      if (mapping.restaurantId && mapping.xenialStoreNumber) {
        restaurantToXenial.set(mapping.restaurantId, mapping.xenialStoreNumber);
      }
      if (mapping.restaurantId && mapping.sevenShiftsLocationId) {
        sevenShiftsToRestaurant.set(mapping.sevenShiftsLocationId, mapping.restaurantId);
      }
    }
    
    // Build map for restaurant lookups by ID
    const restaurantById = new Map(allRestaurants.map(r => [r.id, r]));
    
    console.log(`Xenial POS: ${restaurantToXenial.size} restaurants have Xenial mapping`);
    
    let recordsScraped = 0;
    
    for (const location of locations) {
      // Use location_mapping to find restaurant (prefer mapping over name match)
      let restaurant = sevenShiftsToRestaurant.has(String(location.id))
        ? restaurantById.get(sevenShiftsToRestaurant.get(String(location.id))!)
        : undefined;
      
      // Fallback to name matching if no mapping found
      if (!restaurant) {
        restaurant = allRestaurants.find(r => r.name === location.name);
      }
      
      if (!restaurant) {
        continue;
      }
      
      const locationTimezone = restaurant.timezone || 'America/Chicago';
      
      // Get the date string in restaurant's local timezone for proper POS data lookup
      const localDateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: locationTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      
      // Use the same date for consistency (target date, not current date)
      const posDateStr = dateStr;
      
      // Get POS sales for this restaurant using timezone-aware hour extraction
      const xenialStoreNumber = restaurantToXenial.get(restaurant.id);
      const restaurantSales = new Map<number, number>();
      
      if (xenialStoreNumber) {
        // Fetch POS orders for this store with timezone-aware hour extraction
        const startOfDay = new Date(posDateStr + 'T00:00:00.000Z');
        const endOfDay = new Date(posDateStr + 'T23:59:59.999Z');
        
        // Extract hour in restaurant's local timezone using AT TIME ZONE
        // Use sql.raw for the timezone string since it's a known safe value from our database
        const tzLiteral = sql.raw(`'${locationTimezone}'`);
        const posResults = await db
          .select({
            hour: sql<number>`extract(hour from ${posOrders.orderClosedAt} AT TIME ZONE ${tzLiteral})::int`,
            totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
          })
          .from(posOrders)
          .where(
            and(
              eq(posOrders.storeNumber, xenialStoreNumber),
              gte(posOrders.businessDate, startOfDay),
              lt(posOrders.businessDate, endOfDay)
            )
          )
          .groupBy(sql`extract(hour from ${posOrders.orderClosedAt} AT TIME ZONE ${tzLiteral})`);
        
        for (const row of posResults) {
          restaurantSales.set(row.hour, Number(row.totalSales) || 0);
        }
      }
      
      const hasPosData = restaurantSales.size > 0;
      
      // If no POS data, skip this restaurant and keep existing hourly_sales data
      // The original 7shifts hourly sync will have populated correct data
      if (!hasPosData) {
        console.log(`No POS data for ${restaurant.name} - skipping (will use existing 7shifts data)`);
        continue;
      }
      
      // Still need 7shifts for labor data (time punches, roles, operator schedules)
      const timePunches = await api.getTimePunches(location.id, dateStr);
      const roleMap = await api.getRoles(location.id);
      const scheduledShifts = await api.getScheduledShifts(location.id, dateStr);
      
      // Get labor hours with position breakdown from 7shifts
      const laborByHour = api.getLaborHoursWithPositions(timePunches, dateStr, locationTimezone, roleMap);
      
      // Get projected labor/sales from 7shifts for forecasting (and as fallback for sales)
      const intervals = await api.getHourlySales(location.id, dateStr);
      const projectedByHour = new Map<number, { projectedSales: number; projectedLabor: number; actualLabor: number; actualSales: number }>();
      for (const interval of intervals) {
        const hourMatch = interval.start.match(/T(\d{2}):/);
        const hour = hourMatch ? parseInt(hourMatch[1]) : 0;
        projectedByHour.set(hour, {
          projectedSales: interval.projected_sales / 100,
          projectedLabor: interval.projected_labor / 100,
          actualLabor: interval.actual_labor / 100,
          actualSales: interval.actual_sales / 100, // 7shifts sales as fallback
        });
      }
      
      // Determine which hours have data (POS sales, 7shifts sales, or labor)
      const hoursWithData = new Set<number>();
      Array.from(restaurantSales.keys()).forEach(h => hoursWithData.add(h));
      Array.from(laborByHour.entries()).forEach(([h, labor]) => {
        if (labor.totalHours > 0) hoursWithData.add(h);
      });
      Array.from(projectedByHour.keys()).forEach(h => hoursWithData.add(h));
      
      if (hoursWithData.size > 0) {
        const dayStart = new Date(targetDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(targetDate);
        dayEnd.setHours(23, 59, 59, 999);
        
        await db.transaction(async (tx) => {
          // Delete existing hourly sales for this restaurant/date
          await tx.delete(hourlySales)
            .where(and(
              eq(hourlySales.restaurantId, restaurant.id),
              gte(hourlySales.salesDate, dayStart),
              lt(hourlySales.salesDate, dayEnd)
            ));
          
          // Insert new hourly records
          for (const hour of Array.from(hoursWithData).sort((a, b) => a - b)) {
            const posSales = restaurantSales.get(hour);
            const hourLabor = laborByHour.get(hour) || { totalHours: 0, byPosition: {} };
            const projected = projectedByHour.get(hour) || { projectedSales: 0, projectedLabor: 0, actualLabor: 0, actualSales: 0 };
            
            // Use POS sales if available, otherwise fall back to 7shifts actualSales
            const finalSales = posSales !== undefined ? posSales : projected.actualSales;
            
            // Round position hours
            const roundedPositions: Record<string, number> = {};
            for (const [pos, hrs] of Object.entries(hourLabor.byPosition)) {
              roundedPositions[pos] = Math.round(hrs * 100) / 100;
            }
            
            // Check if operator is scheduled
            const hasOperator = api.hasOperatorScheduledForHour(scheduledShifts, roleMap, hour, locationTimezone, dateStr);
            if (hasOperator) {
              roundedPositions['_operatorScheduled'] = 1;
            }
            
            await tx.insert(hourlySales).values({
              restaurantId: restaurant.id,
              salesDate: targetDate,
              hour,
              actualSales: finalSales.toFixed(2),
              projectedSales: projected.projectedSales.toFixed(2),
              pastActualSales: '0.00',
              projectedLabor: projected.projectedLabor.toFixed(2),
              actualLabor: projected.actualLabor.toFixed(2),
              employeeCount: (Math.round(hourLabor.totalHours * 100) / 100).toFixed(2),
              positionBreakdown: roundedPositions,
            });
            
            recordsScraped++;
          }
        });
        
        const posHours = restaurantSales.size;
        console.log(`Synced ${hoursWithData.size} hours for ${location.name} (${posHours > 0 ? posHours + ' POS' : '7shifts'} sales, ${timePunches.length} punches)`);
      }
    }
    
    console.log(`Xenial + 7shifts hybrid sync completed. ${recordsScraped} records saved.`);
    return { success: true, recordsScraped };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Hybrid sync failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };
  }
}
