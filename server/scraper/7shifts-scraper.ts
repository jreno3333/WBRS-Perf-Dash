import { chromium, Browser, Page } from 'playwright';
import { db } from '../db';
import { restaurants, dailySales, scraperRuns } from '@shared/schema';
import { eq, and, gte, lt } from 'drizzle-orm';

interface ScrapedSalesRow {
  locationCode: string;
  locationName: string;
  sales: number;
  vsProjected: number | null;
  laborPercent: number | null;
}

interface ScraperConfig {
  email: string;
  password: string;
  headless?: boolean;
}

export class SevenShiftsScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: ScraperConfig;

  constructor(config: ScraperConfig) {
    this.config = {
      ...config,
      headless: config.headless ?? true,
    };
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
    });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    this.page = await context.newPage();
  }

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      console.log('Navigating to 7shifts login...');
      await this.page.goto('https://app.7shifts.com/login', { waitUntil: 'networkidle' });

      await this.page.fill('input[name="email"], input[type="email"]', this.config.email);
      await this.page.fill('input[name="password"], input[type="password"]', this.config.password);

      await this.page.click('button[type="submit"]');
      
      await this.page.waitForURL('**/dashboard**', { timeout: 30000 });
      console.log('Successfully logged in to 7shifts');
      return true;
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    }
  }

  async navigateToSalesReport(date?: Date): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    const targetDate = date || new Date();
    const dateStr = targetDate.toISOString().split('T')[0];

    console.log(`Navigating to sales report for ${dateStr}...`);
    await this.page.goto(`https://app.7shifts.com/report/sales?date=${dateStr}`, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });

    await this.page.waitForSelector('table, [class*="location"]', { timeout: 15000 });
  }

  async scrapeSalesData(): Promise<ScrapedSalesRow[]> {
    if (!this.page) throw new Error('Browser not initialized');

    const salesData: ScrapedSalesRow[] = [];

    try {
      await this.page.waitForSelector('table tbody tr, [class*="table"] [class*="row"]', { timeout: 10000 });

      const rows = await this.page.$$('table tbody tr');

      for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length < 3) continue;

        const locationText = await cells[0].textContent();
        const salesText = await cells[1].textContent();
        const vsProjectedText = cells[2] ? await cells[2].textContent() : null;
        const laborText = cells[3] ? await cells[3].textContent() : null;

        if (!locationText || !salesText) continue;

        const locationMatch = locationText.match(/^(\d+)\s*[-–]\s*(.+)$/);
        if (!locationMatch) continue;

        const locationCode = locationMatch[1].trim();
        const locationName = locationMatch[2].trim();

        const sales = parseFloat(salesText.replace(/[$,]/g, '')) || 0;
        
        let vsProjected: number | null = null;
        if (vsProjectedText) {
          const projMatch = vsProjectedText.replace(/[$,]/g, '').match(/-?[\d.]+/);
          vsProjected = projMatch ? parseFloat(projMatch[0]) : null;
        }

        let laborPercent: number | null = null;
        if (laborText) {
          const laborMatch = laborText.replace(/%/g, '').match(/[\d.]+/);
          laborPercent = laborMatch ? parseFloat(laborMatch[0]) : null;
        }

        salesData.push({
          locationCode,
          locationName,
          sales,
          vsProjected,
          laborPercent,
        });
      }

      console.log(`Scraped ${salesData.length} restaurant records`);
      return salesData;
    } catch (error) {
      console.error('Error scraping sales data:', error);
      return salesData;
    }
  }

  async saveSalesToDatabase(salesData: ScrapedSalesRow[], salesDate: Date): Promise<number> {
    let savedCount = 0;

    for (const row of salesData) {
      try {
        let restaurant = await db.query.restaurants.findFirst({
          where: eq(restaurants.name, row.locationName),
        });

        if (!restaurant) {
          const [newRestaurant] = await db.insert(restaurants).values({
            name: row.locationName,
            timezone: 'America/Chicago',
            isActive: true,
          }).returning();
          restaurant = newRestaurant;
          console.log(`Created new restaurant: ${row.locationName}`);
        }

        const startOfDay = new Date(salesDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(salesDate);
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
              totalSales: row.sales.toString(),
              vsProjected: row.vsProjected?.toString() ?? null,
              laborPercent: row.laborPercent?.toString() ?? null,
              scrapedAt: new Date(),
            })
            .where(eq(dailySales.id, existing.id));
        } else {
          await db.insert(dailySales).values({
            restaurantId: restaurant.id,
            locationCode: row.locationCode,
            salesDate: salesDate,
            totalSales: row.sales.toString(),
            vsProjected: row.vsProjected?.toString() ?? null,
            laborPercent: row.laborPercent?.toString() ?? null,
          });
        }

        savedCount++;
      } catch (error) {
        console.error(`Error saving sales for ${row.locationName}:`, error);
      }
    }

    return savedCount;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}

export async function runScraper(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
  const email = process.env.SEVENSHIFTS_EMAIL;
  const password = process.env.SEVENSHIFTS_PASSWORD;

  if (!email || !password) {
    return {
      success: false,
      recordsScraped: 0,
      error: 'Missing 7shifts credentials. Set SEVENSHIFTS_EMAIL and SEVENSHIFTS_PASSWORD environment variables.',
    };
  }

  const [scraperRun] = await db.insert(scraperRuns).values({
    status: 'running',
  }).returning();

  const scraper = new SevenShiftsScraper({
    email,
    password,
    headless: true,
  });

  try {
    await scraper.initialize();

    const loggedIn = await scraper.login();
    if (!loggedIn) {
      throw new Error('Failed to log in to 7shifts');
    }

    const targetDate = date || new Date();
    await scraper.navigateToSalesReport(targetDate);

    const salesData = await scraper.scrapeSalesData();

    const recordsScraped = await scraper.saveSalesToDatabase(salesData, targetDate);

    await db.update(scraperRuns)
      .set({
        status: 'success',
        completedAt: new Date(),
        recordsScraped,
      })
      .where(eq(scraperRuns.id, scraperRun.id));

    console.log(`Scraper completed successfully. ${recordsScraped} records saved.`);
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

    console.error('Scraper failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };

  } finally {
    await scraper.close();
  }
}

export async function scrapeHistoricalData(days: number = 7): Promise<void> {
  console.log(`Scraping ${days} days of historical data...`);
  
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    console.log(`Scraping data for ${date.toISOString().split('T')[0]}...`);
    const result = await runScraper(date);
    
    if (!result.success) {
      console.error(`Failed to scrape ${date.toISOString().split('T')[0]}: ${result.error}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  console.log('Historical data scraping complete');
}
