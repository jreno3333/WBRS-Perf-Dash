import { db } from '../db';
import { restaurants, dailySales, scraperRuns } from '@shared/schema';
import { eq, and, gte, lt } from 'drizzle-orm';

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
    
    const targetDate = date || new Date();
    const dateStr = targetDate.toISOString().split('T')[0];
    
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
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('Historical data fetch complete');
}
