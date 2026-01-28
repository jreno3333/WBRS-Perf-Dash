import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchSalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, fetchHourlySalesFromAPI, syncLocationsFromAPI } from "./scraper/7shifts-api";
import { db, posDb } from "./db";
import { scraperRuns, posOrders, hourlySales, hourlyLabor, hourlyCrew, restaurants, employees } from "@shared/schema";
import { desc, sql, gte, lte, lt, and, eq } from "drizzle-orm";
import { processXenialOrder, validateWebhookToken, seedLocationMappings, getPosOrdersSummary, getAllHourlyPosSales } from "./xenial-webhook";
import { getHolidayContext, getHolidayComparisonContext, getAllHolidaysForYear } from "./holidays";
import { getDailyDriveThruSummary } from "./scraper/hme-api";

// Weather code to condition mapping
function getWeatherCondition(weatherCode: number): string {
  if (weatherCode === 0) return "clear";
  if (weatherCode >= 1 && weatherCode <= 3) return "partly cloudy";
  if (weatherCode >= 45 && weatherCode <= 48) return "foggy";
  if (weatherCode >= 51 && weatherCode <= 67) return "rain";
  if (weatherCode >= 71 && weatherCode <= 77) return "snow";
  if (weatherCode >= 80 && weatherCode <= 82) return "showers";
  if (weatherCode >= 95) return "thunderstorm";
  return "clear";
}

// Fetch weather for a location with timeout
async function fetchWeather(latitude: number, longitude: number): Promise<{ temp: number; condition: string; humidity: number; windSpeed: number; } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const weatherRes = await fetch(weatherUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const current = weatherData.current;
      return {
        temp: current.temperature_2m,
        condition: getWeatherCondition(current.weather_code),
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m,
      };
    }
  } catch (e) {
    // Silently handle timeout/network errors
  }
  return null;
}

// Helper to add delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch historical daily weather (actual high/low for a specific date)
async function fetchHistoricalWeather(latitude: number, longitude: number, date: string): Promise<{ highTemp: number; lowTemp: number; avgTemp: number; condition: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    // Open-Meteo Archive API for historical daily data
    const weatherUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${date}&end_date=${date}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,weather_code&temperature_unit=fahrenheit`;
    const weatherRes = await fetch(weatherUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const daily = weatherData.daily;
      if (daily && daily.temperature_2m_max?.[0] !== undefined) {
        return {
          highTemp: daily.temperature_2m_max[0],
          lowTemp: daily.temperature_2m_min[0],
          avgTemp: daily.temperature_2m_mean[0],
          condition: getWeatherCondition(daily.weather_code?.[0] || 0),
        };
      }
    }
  } catch (e) {
    // Silently handle timeout/network errors
  }
  return null;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Comprehensive diagnostics endpoint for production debugging
  app.get("/api/diagnostics", async (req, res) => {
    const now = new Date();
    const isProduction = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';
    
    res.json({
      timestamp: now.toISOString(),
      environment: process.env.NODE_ENV || 'development',
      isDeployment: process.env.REPLIT_DEPLOYMENT === '1',
      secrets: {
        sevenShiftsApiToken: !!process.env.SEVENSHIFTS_API_TOKEN,
        hmeServiceAccount: !!process.env.HME_SERVICE_ACCOUNT,
        hmeAuthKey: !!process.env.HME_AUTH_KEY,
        hmeAccountEmail: !!process.env.HME_ACCOUNT_EMAIL,
        googlePlacesApiKey: !!process.env.GOOGLE_PLACES_API_KEY,
        databaseUrl: !!process.env.DATABASE_URL,
        sharedDatabaseUrl: !!process.env.SHARED_DATABASE_URL,
      },
      message: isProduction 
        ? 'Production environment - scheduler runs while app is awake'
        : 'Development environment - scheduler runs continuously',
    });
  });

  // Debug endpoint to check database connection
  app.get("/api/db-status", async (req, res) => {
    const xposSharedDbUrl = process.env.XPOSSHARED_DATABASE_URL?.trim() || '';
    const sharedDbUrl = process.env.SHARED_DATABASE_URL?.trim() || '';
    const defaultDbUrl = process.env.DATABASE_URL?.trim() || '';
    
    // Main DB: DATABASE_URL for all app tables (restaurants, sales, labor)
    const mainDbSource = defaultDbUrl ? 'DATABASE_URL' : (xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : 'SHARED_DATABASE_URL');
    
    // POS DB: XPOSSHARED_DATABASE_URL for pos_orders (shared between apps)
    const posDbSource = xposSharedDbUrl ? 'XPOSSHARED_DATABASE_URL' : (defaultDbUrl ? 'DATABASE_URL' : 'SHARED_DATABASE_URL');
    
    // Check if POS DB is separate from main DB
    const posDbIsSeparate = xposSharedDbUrl && xposSharedDbUrl !== (defaultDbUrl || sharedDbUrl);
    
    // Count POS orders from posDb and restaurants from main db
    const posCount = await posDb.select({ count: sql<number>`count(*)` }).from(posOrders);
    const restaurantCount = await db.select({ count: sql<number>`count(*)` }).from(restaurants);
    
    res.json({
      environment: process.env.NODE_ENV || 'development',
      mainDatabase: mainDbSource,
      posDatabase: posDbSource,
      posDbSeparate: posDbIsSeparate,
      xposSharedSet: !!xposSharedDbUrl,
      sharedSet: !!sharedDbUrl,
      databaseUrlSet: !!defaultDbUrl,
      posOrdersCount: posCount[0]?.count || 0,
      restaurantsCount: restaurantCount[0]?.count || 0
    });
  });

  // Get leaderboard data
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const { date } = req.query;
      // Parse date string as local date, not UTC - "2026-01-23" should stay Jan 23, not become Jan 22
      let targetDate: Date;
      if (date) {
        const parts = (date as string).split('-');
        targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
      } else {
        targetDate = new Date();
      }
      const leaderboard = await storage.getLeaderboard(targetDate);
      
      // Get all restaurants to fetch coordinates for weather
      const restaurantList = await storage.getRestaurants();
      const restaurantMap = new Map(restaurantList.map(r => [r.id, r]));
      
      // Check if viewing historical data (not today)
      // Compare date strings directly to avoid timezone parsing issues
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      // Use the input date string directly if provided, otherwise use today
      const targetDateStr = date ? (date as string) : todayStr;
      
      // Calculate days ago - archive API needs 3+ days for reliable observed data
      const today = new Date(todayStr + 'T12:00:00');
      const target = new Date(targetDateStr + 'T12:00:00');
      const daysDiff = Math.floor((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
      // Only use historical API for dates 3+ days old (archive data needs time to be accurate)
      const useHistoricalWeather = daysDiff >= 3;
      
      const restaurantsWithWeather = [...leaderboard.restaurants];
      
      if (useHistoricalWeather) {
        // For older historical dates (3+ days), fetch actual daily high/low from archive API
        const batchSize = 5;
        for (let i = 0; i < restaurantsWithWeather.length; i += batchSize) {
          const batch = restaurantsWithWeather.slice(i, i + batchSize);
          const weatherResults = await Promise.all(
            batch.map(async (r) => {
              const restaurant = restaurantMap.get(r.restaurantId);
              if (restaurant?.latitude && restaurant?.longitude) {
                return await fetchHistoricalWeather(
                  parseFloat(String(restaurant.latitude)),
                  parseFloat(String(restaurant.longitude)),
                  targetDateStr
                );
              }
              return null;
            })
          );
          
          // Assign historical weather results
          for (let j = 0; j < batch.length; j++) {
            const weather = weatherResults[j];
            if (weather) {
              (restaurantsWithWeather[i + j] as any).weather = {
                temp: weather.avgTemp,
                highTemp: weather.highTemp,
                lowTemp: weather.lowTemp,
                condition: weather.condition,
                humidity: 0, // Not available in historical API
                windSpeed: 0,
              };
            }
          }
          
          // Small delay between batches
          if (i + batchSize < restaurantsWithWeather.length) {
            await delay(100);
          }
        }
      } else {
        // For today, fetch live weather in batches
        const batchSize = 5;
        for (let i = 0; i < restaurantsWithWeather.length; i += batchSize) {
          const batch = restaurantsWithWeather.slice(i, i + batchSize);
          const weatherResults = await Promise.all(
            batch.map(async (r) => {
              const restaurant = restaurantMap.get(r.restaurantId);
              if (restaurant?.latitude && restaurant?.longitude) {
                return await fetchWeather(parseFloat(String(restaurant.latitude)), parseFloat(String(restaurant.longitude)));
              }
              return null;
            })
          );
          
          // Assign weather results back to restaurants
          for (let j = 0; j < batch.length; j++) {
            (restaurantsWithWeather[i + j] as any).weather = weatherResults[j];
          }
          
          // Small delay between batches to avoid rate limiting
          if (i + batchSize < restaurantsWithWeather.length) {
            await delay(100);
          }
        }
      }
      
      // Fetch HME timer data for drive-thru speed metrics
      // Use Central timezone for consistent date handling with HME data
      const dateStr = targetDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      console.log('[HME] Fetching drive-thru summary for date:', dateStr);
      const hmeSummary = await getDailyDriveThruSummary(dateStr);
      console.log('[HME] Got summary for', hmeSummary.size, 'restaurants');
      
      // Add HME data to each restaurant
      for (const r of restaurantsWithWeather) {
        const hmeData = hmeSummary.get(r.restaurantId);
        if (hmeData) {
          (r as any).driveThru = {
            carCount: hmeData.carCount,
            avgTotalTime: hmeData.avgTotalTime,
            avgServiceTime: hmeData.avgServiceTime,
          };
        }
      }
      
      // Fetch Google Reviews data for all restaurants
      const { getGoogleReviewsForAllRestaurants } = await import("./google-places");
      const googleReviews = await getGoogleReviewsForAllRestaurants(targetDateStr);
      
      // Add Google Reviews data to each restaurant
      for (const r of restaurantsWithWeather) {
        const reviews = googleReviews.get(r.restaurantId);
        if (reviews) {
          (r as any).googleReviews = {
            rating: reviews.rating,
            reviewCount: reviews.reviewCount,
            newReviewsToday: reviews.newReviewsToday,
          };
        }
      }
      
      res.json({
        ...leaderboard,
        restaurants: restaurantsWithWeather,
      });
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ 
        error: "Failed to fetch leaderboard data",
        details: error instanceof Error ? error.message : String(error),
        stack: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.stack : undefined) : undefined
      });
    }
  });

  // Get pace data for a specific restaurant or all restaurants
  app.get("/api/pace/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const paceData = await storage.getPaceData(restaurantId, targetDate);
      
      // Include the current hour for in-progress indicator
      const getCurrentHour = (tz: string) => {
        const options: Intl.DateTimeFormatOptions = { hour: 'numeric', hour12: false, timeZone: tz };
        return parseInt(new Intl.DateTimeFormat('en-US', options).format(new Date()));
      };
      const centralHour = getCurrentHour('America/Chicago');
      const easternHour = getCurrentHour('America/New_York');
      const currentHour = Math.min(centralHour, easternHour);
      
      // Check if viewing today
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const selectedStr = targetDate.toISOString().split('T')[0];
      const isToday = todayStr === selectedStr;
      
      res.json({ 
        data: paceData, 
        currentHour: isToday ? currentHour : null,
        isToday 
      });
    } catch (error) {
      console.error("Error fetching pace data:", error);
      res.status(500).json({ error: "Failed to fetch pace data" });
    }
  });

  // Get all restaurants
  app.get("/api/restaurants", async (req, res) => {
    try {
      const restaurantList = await storage.getRestaurants();
      res.json(restaurantList);
    } catch (error) {
      console.error("Error fetching restaurants:", error);
      res.status(500).json({ error: "Failed to fetch restaurants" });
    }
  });

  // Get holiday context for today vs last week comparison
  app.get("/api/holidays", async (req, res) => {
    try {
      const { date } = req.query;
      // Parse date at noon to avoid timezone shifting (e.g., 2026-01-27 -> 2026-01-27T12:00:00)
      const targetDate = date 
        ? new Date(`${date as string}T12:00:00`) 
        : new Date();
      
      const context = getHolidayContext(targetDate);
      const comparison = getHolidayComparisonContext(targetDate);
      
      // Get holidays for this year and last year for reference
      const thisYear = targetDate.getFullYear();
      const thisYearHolidays = getAllHolidaysForYear(thisYear);
      const lastYearHolidays = getAllHolidaysForYear(thisYear - 1);
      
      res.json({
        ...context,
        comparison,
        thisYearHolidays,
        lastYearHolidays
      });
    } catch (error) {
      console.error("Error fetching holidays:", error);
      res.status(500).json({ error: "Failed to fetch holiday data" });
    }
  });

  // Update restaurant settings (open date, labor target, revenue ports, etc.)
  app.patch("/api/restaurants/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { openDate, laborTarget, isActive, revenuePorts, googlePlaceId } = req.body;
      
      console.log(`[Restaurant Update] ID: ${id}, Body:`, JSON.stringify(req.body));
      
      const updates: Record<string, any> = {};
      if (openDate !== undefined) {
        // Store date as string (PostgreSQL date type)
        updates.openDate = openDate || null;
      }
      if (laborTarget !== undefined) {
        updates.laborTarget = laborTarget;
      }
      if (isActive !== undefined) {
        updates.isActive = isActive;
      }
      if (revenuePorts !== undefined) {
        updates.revenuePorts = revenuePorts;
      }
      if (googlePlaceId !== undefined) {
        updates.googlePlaceId = googlePlaceId || null;
      }
      
      if (Object.keys(updates).length === 0) {
        console.log(`[Restaurant Update] No valid fields to update`);
        return res.status(400).json({ error: "No valid fields to update" });
      }
      
      console.log(`[Restaurant Update] Applying updates:`, JSON.stringify(updates));
      await db.update(restaurants).set(updates).where(eq(restaurants.id, id));
      
      const updatedRestaurant = await db.select().from(restaurants).where(eq(restaurants.id, id));
      console.log(`[Restaurant Update] Result:`, JSON.stringify(updatedRestaurant[0]));
      res.json(updatedRestaurant[0]);
    } catch (error) {
      console.error("Error updating restaurant:", error);
      res.status(500).json({ error: "Failed to update restaurant" });
    }
  });

  // Get hourly data for all restaurants (for bar charts)
  app.get("/api/hourly-by-restaurant", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const hourlyData = await storage.getHourlyDataByRestaurant(targetDate);
      res.json(hourlyData);
    } catch (error) {
      console.error("Error fetching hourly data by restaurant:", error);
      res.status(500).json({ error: "Failed to fetch hourly data" });
    }
  });

  // Get hourly sales heatmap data for the past N days
  app.get("/api/hourly-heatmap", async (req, res) => {
    try {
      const { days = "7" } = req.query;
      const numDays = parseInt(days as string) || 7;
      
      // Get today's date in Central timezone (consistent with rest of app)
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const today = new Date(`${todayStr}T12:00:00Z`);
      
      // Build date range (past N days including today) - all normalized to noon UTC
      const dateRange: string[] = [];
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (numDays - 1));
      
      for (let i = 0; i < numDays; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        dateRange.push(date.toISOString().split('T')[0]);
      }
      
      const allRestaurants = await storage.getRestaurants();
      // Exclude training units from heatmap (status calculated from openDate)
      const nowForFilter = new Date();
      nowForFilter.setHours(0, 0, 0, 0);
      const restaurantList = allRestaurants.filter(r => {
        if (!r.openDate) return true; // No open date = established
        const openDate = new Date(r.openDate);
        openDate.setHours(0, 0, 0, 0);
        return openDate <= nowForFilter; // Exclude future open dates (training)
      });
      
      // Filter hourly sales at DB level by date range
      const filteredHourlySales = await db.select().from(hourlySales)
        .where(
          and(
            gte(hourlySales.salesDate, new Date(`${dateRange[0]}T00:00:00Z`)),
            lte(hourlySales.salesDate, new Date(`${dateRange[dateRange.length - 1]}T23:59:59Z`))
          )
        );
      
      // Build restaurant open date map for filtering
      const restaurantOpenDates: Record<string, string | null> = {};
      for (const r of restaurantList) {
        restaurantOpenDates[r.id] = r.openDate ? new Date(r.openDate).toISOString().split('T')[0] : null;
      }
      
      // Group hourly data by restaurant and date (only include dates on or after open date)
      const heatmapData: Record<string, Record<string, Record<number, number>>> = {};
      
      for (const restaurant of restaurantList) {
        heatmapData[restaurant.id] = {};
        const openDateStr = restaurantOpenDates[restaurant.id];
        
        for (const dateStr of dateRange) {
          // Skip dates before the restaurant opened
          if (openDateStr && dateStr < openDateStr) continue;
          
          heatmapData[restaurant.id][dateStr] = {};
          for (let hour = 0; hour < 24; hour++) {
            heatmapData[restaurant.id][dateStr][hour] = 0;
          }
        }
      }
      
      // First, populate with 7shifts hourly_sales data as baseline
      for (const sale of filteredHourlySales) {
        // Normalize the sale date to Central timezone for consistent grouping
        const saleDate = new Date(sale.salesDate);
        const saleDateStr = saleDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        
        // Check that this date exists for this restaurant (may be filtered due to open date)
        if (dateRange.includes(saleDateStr) && heatmapData[sale.restaurantId]?.[saleDateStr]) {
          heatmapData[sale.restaurantId][saleDateStr][sale.hour] = parseFloat(sale.actualSales as string) || 0;
        }
      }
      
      // Overlay with POS data (more accurate real transactions) for each date
      for (const dateStr of dateRange) {
        const targetDate = new Date(`${dateStr}T12:00:00Z`);
        const posSales = await getAllHourlyPosSales(targetDate);
        
        // POS data is Map<restaurantId, Map<hour, sales>>
        posSales.forEach((hourlyData, restaurantId) => {
          // Check that this date exists for this restaurant (may be filtered due to open date)
          if (heatmapData[restaurantId]?.[dateStr]) {
            hourlyData.forEach((sales, hour) => {
              // Only overlay if POS has sales data (don't zero out 7shifts data)
              if (sales > 0) {
                heatmapData[restaurantId][dateStr][hour] = sales;
              }
            });
          }
        });
      }
      
      // Calculate max sales for color scaling
      let maxSales = 0;
      for (const restaurantId of Object.keys(heatmapData)) {
        for (const dateStr of Object.keys(heatmapData[restaurantId])) {
          for (let hour = 0; hour < 24; hour++) {
            const sales = heatmapData[restaurantId][dateStr]?.[hour] ?? 0;
            if (sales > maxSales) maxSales = sales;
          }
        }
      }
      
      res.json({
        restaurants: restaurantList.map(r => ({ id: r.id, name: r.name })),
        dateRange,
        heatmapData,
        maxSales
      });
    } catch (error) {
      console.error("Error fetching hourly heatmap data:", error);
      res.status(500).json({ error: "Failed to fetch hourly heatmap data" });
    }
  });

  // Get map data with restaurant locations and weather
  app.get("/api/map-data", async (req, res) => {
    try {
      // Use date parameter if provided, otherwise use today in Central timezone
      const { date } = req.query;
      let targetDate: Date;
      if (date) {
        targetDate = new Date(date as string);
      } else {
        // Get today's date in Central timezone for consistent business day
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        targetDate = new Date(`${todayStr}T12:00:00Z`);
      }
      const leaderboard = await storage.getLeaderboard(targetDate);
      const restaurantList = await storage.getRestaurants();
      
      // Create a map of restaurant ID to leaderboard data
      const leaderboardMap = new Map(
        leaderboard.restaurants.map(r => [r.restaurantId, r])
      );
      
      // Combine restaurant data with leaderboard data
      const validRestaurants = restaurantList.filter(r => r.latitude && r.longitude);
      const mapData: any[] = [];
      
      // First pass: build map data without weather
      for (const restaurant of validRestaurants) {
        const salesData = leaderboardMap.get(restaurant.id);
        
        // Determine status based on openDate
        let status: "training" | "new" | "established" = "established";
        if (restaurant.openDate) {
          const openDate = new Date(restaurant.openDate);
          const now = new Date();
          if (openDate > now) {
            status = "training";
          } else {
            const daysSinceOpen = Math.floor((now.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24));
            if (daysSinceOpen <= 90) {
              status = "new";
            }
          }
        }
        
        // Get sales values
        const todaySales = salesData?.todaySales || 0;
        const lastWeekSales = salesData?.lastWeekSales || 0;
        // Calculate isAheadOfPace directly from sales values for consistency
        const isAheadOfPace = todaySales >= lastWeekSales;
        
        mapData.push({
          id: restaurant.id,
          name: restaurant.name,
          unitNumber: restaurant.unitNumber || "",
          address: restaurant.address || "",
          latitude: parseFloat(restaurant.latitude as string),
          longitude: parseFloat(restaurant.longitude as string),
          todaySales,
          lastWeekSales,
          isAheadOfPace,
          status,
          weather: null,
        });
      }
      
      // Second pass: fetch weather in batches to avoid rate limiting
      const batchSize = 5;
      for (let i = 0; i < mapData.length; i += batchSize) {
        const batch = mapData.slice(i, i + batchSize);
        const weatherResults = await Promise.all(
          batch.map(r => fetchWeather(r.latitude, r.longitude))
        );
        
        for (let j = 0; j < batch.length; j++) {
          mapData[i + j].weather = weatherResults[j];
        }
        
        // Small delay between batches to avoid rate limiting
        if (i + batchSize < mapData.length) {
          await delay(100);
        }
      }
      
      // Get holiday context
      const holidayContext = getHolidayContext(targetDate);
      const comparison = getHolidayComparisonContext(targetDate);
      
      res.json({
        restaurants: mapData,
        holidays: {
          ...holidayContext,
          comparison
        }
      });
    } catch (error) {
      console.error("Error fetching map data:", error);
      res.status(500).json({ error: "Failed to fetch map data" });
    }
  });

  // Get position breakdown for a restaurant
  app.get("/api/positions/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const dateStr = targetDate.toISOString().split('T')[0];
      
      // Fetch hourly data with position breakdown
      const allHourly = await db.select().from(hourlySales);
      const records = allHourly.filter(s => {
        const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
        return saleDate === dateStr && s.restaurantId === restaurantId;
      });
      
      // Build response with position data per hour
      // Compute totalHours directly from position breakdown sum (authoritative)
      const result = records.map(r => {
        const positions = (r.positionBreakdown || {}) as Record<string, number>;
        const totalHours = Object.values(positions).reduce((sum, hrs) => sum + hrs, 0);
        return {
          hour: r.hour,
          totalHours: Math.round(totalHours * 100) / 100,
          positions,
        };
      }).sort((a, b) => a.hour - b.hour);
      
      res.json(result);
    } catch (error) {
      console.error("Error fetching position data:", error);
      res.status(500).json({ error: "Failed to fetch position data" });
    }
  });

  // Trigger manual API sync
  app.post("/api/scraper/run", async (req, res) => {
    try {
      const { date } = req.body || {};
      const targetDate = date ? new Date(date) : undefined;
      
      res.json({ message: "API sync started", status: "running" });
      
      fetchSalesFromAPI(targetDate).then(result => {
        console.log("API sync completed:", result);
      }).catch(err => {
        console.error("API sync error:", err);
      });
    } catch (error) {
      console.error("Error starting API sync:", error);
      res.status(500).json({ error: "Failed to start API sync" });
    }
  });

  // Get scraper/sync status
  app.get("/api/scraper/status", async (req, res) => {
    try {
      const latestRuns = await db.select()
        .from(scraperRuns)
        .orderBy(desc(scraperRuns.startedAt))
        .limit(10);
      
      res.json({
        hasApiToken: !!process.env.SEVENSHIFTS_API_TOKEN,
        latestRuns,
      });
    } catch (error) {
      console.error("Error fetching sync status:", error);
      res.status(500).json({ error: "Failed to fetch sync status" });
    }
  });

  // Diagnostic: Check for duplicate hourly records
  app.get("/api/scraper/check-duplicates", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const dateStr = targetDate.toISOString().split('T')[0];
      
      const allHourly = await db.select().from(hourlySales);
      const dayRecords = allHourly.filter(s => {
        const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
        return saleDate === dateStr;
      });
      
      // Count records per restaurant/hour
      const counts: Record<string, number> = {};
      const duplicates: Array<{restaurantId: string, hour: number, count: number}> = [];
      
      dayRecords.forEach(r => {
        const key = `${r.restaurantId}-${r.hour}`;
        counts[key] = (counts[key] || 0) + 1;
      });
      
      Object.entries(counts).forEach(([key, count]) => {
        if (count > 1) {
          const [restaurantId, hour] = key.split('-');
          duplicates.push({ restaurantId, hour: parseInt(hour), count });
        }
      });
      
      const totalSales = dayRecords.reduce((sum, r) => sum + parseFloat(r.actualSales || '0'), 0);
      
      res.json({
        date: dateStr,
        totalRecords: dayRecords.length,
        expectedRecords: 22 * 24, // 22 restaurants x 24 hours
        duplicateGroups: duplicates.length,
        duplicates,
        totalSales: totalSales.toFixed(2),
      });
    } catch (error) {
      console.error("Error checking duplicates:", error);
      res.status(500).json({ error: "Failed to check duplicates" });
    }
  });

  // Cleanup: Remove duplicate hourly records, keeping the most recent
  app.post("/api/scraper/cleanup-duplicates", async (req, res) => {
    try {
      const { date } = req.body;
      const targetDate = date ? new Date(date as string) : new Date();
      const dateStr = targetDate.toISOString().split('T')[0];
      
      const allHourly = await db.select().from(hourlySales);
      const dayRecords = allHourly.filter(s => {
        const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
        return saleDate === dateStr;
      });
      
      // Group by restaurant/hour
      const groups: Record<string, typeof dayRecords> = {};
      dayRecords.forEach(r => {
        const key = `${r.restaurantId}-${r.hour}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
      });
      
      let deletedCount = 0;
      for (const records of Object.values(groups)) {
        if (records.length > 1) {
          // Keep the first, delete the rest
          const toDelete = records.slice(1);
          for (const record of toDelete) {
            await db.delete(hourlySales).where(eq(hourlySales.id, record.id));
            deletedCount++;
          }
        }
      }
      
      // Get new total
      const remainingRecords = await db.select().from(hourlySales);
      const newDayRecords = remainingRecords.filter(s => {
        const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
        return saleDate === dateStr;
      });
      const newTotal = newDayRecords.reduce((sum, r) => sum + parseFloat(r.actualSales || '0'), 0);
      
      res.json({
        date: dateStr,
        deletedRecords: deletedCount,
        remainingRecords: newDayRecords.length,
        newTotalSales: newTotal.toFixed(2),
      });
    } catch (error) {
      console.error("Error cleaning duplicates:", error);
      res.status(500).json({ error: "Failed to cleanup duplicates" });
    }
  });

  // Sync locations from 7shifts
  app.post("/api/scraper/sync-locations", async (req, res) => {
    try {
      const count = await syncLocationsFromAPI();
      res.json({ message: `Synced ${count} locations`, count });
    } catch (error) {
      console.error("Error syncing locations:", error);
      res.status(500).json({ error: "Failed to sync locations" });
    }
  });

  // Fetch historical data (last N days)
  app.post("/api/scraper/historical", async (req, res) => {
    try {
      const days = Number(req.query.days) || (req.body && req.body.days) || 9;
      
      res.json({ message: `Starting historical fetch for ${days} days`, status: "running" });
      
      fetchHistoricalSales(days).then(() => {
        console.log("Historical fetch completed");
      }).catch(err => {
        console.error("Historical fetch error:", err);
      });
    } catch (error) {
      console.error("Error starting historical fetch:", error);
      res.status(500).json({ error: "Failed to start historical fetch" });
    }
  });

  // Fetch historical hourly data (last N days)
  app.post("/api/scraper/historical-hourly", async (req, res) => {
    try {
      const days = Number(req.query.days) || (req.body && req.body.days) || 9;
      
      res.json({ message: `Starting historical hourly fetch for ${days} days`, status: "running" });
      
      fetchHistoricalHourlySales(days).then(() => {
        console.log("Historical hourly fetch completed");
      }).catch(err => {
        console.error("Historical hourly fetch error:", err);
      });
    } catch (error) {
      console.error("Error starting historical hourly fetch:", error);
      res.status(500).json({ error: "Failed to start historical hourly fetch" });
    }
  });

  // Sync hourly data for today (with time punches)
  app.post("/api/scraper/hourly", async (req, res) => {
    try {
      const { date } = req.body || {};
      const targetDate = date ? new Date(date) : undefined;
      
      res.json({ message: "Hourly sync with time punches started", status: "running" });
      
      fetchHourlySalesFromAPI(targetDate).then(result => {
        console.log("Hourly sync completed:", result);
      }).catch(err => {
        console.error("Hourly sync error:", err);
      });
    } catch (error) {
      console.error("Error starting hourly sync:", error);
      res.status(500).json({ error: "Failed to start hourly sync" });
    }
  });

  // ===== XENIAL POS WEBHOOK ENDPOINTS =====

  // Test endpoint to verify webhook connectivity (no auth required)
  app.get("/api/xenial/ping", async (req, res) => {
    res.json({
      status: "ok",
      message: "Xenial webhook endpoint is reachable",
      timestamp: new Date().toISOString(),
      webhookUrl: "/api/xenial/order",
      authRequired: !!process.env.MWBURGER_POS_TOKEN,
    });
  });

  // Test endpoint to send a sample order (for debugging)
  app.post("/api/xenial/test-order", async (req, res) => {
    try {
      const testPayload = {
        entityName: "Order",
        data: {
          _id: `test-${Date.now()}`,
          origin: "1237",
          net_sales: 9.99,
          business_date: new Date().toISOString().split('T')[0],
          closed: new Date().toISOString(),
          order_source: "TEST",
        }
      };
      
      const result = await processXenialOrder(testPayload);
      res.json({
        message: "Test order processed",
        result,
        payload: testPayload,
      });
    } catch (error) {
      console.error("Test order error:", error);
      res.status(500).json({ error: "Failed to process test order" });
    }
  });

  // Receive order from Xenial POS (webhook endpoint)
  app.post("/api/xenial/order", async (req, res) => {
    const receivedAt = new Date().toISOString();
    console.log(`[Xenial] Webhook received at ${receivedAt}`);
    
    try {
      const authHeader = req.headers.authorization as string | undefined;
      
      // Log request details for debugging (without exposing sensitive data)
      console.log(`[Xenial] Headers: content-type=${req.headers['content-type']}, auth=${authHeader ? 'present' : 'missing'}`);
      console.log(`[Xenial] Body preview: ${JSON.stringify(req.body).substring(0, 200)}`);
      
      if (!validateWebhookToken(authHeader)) {
        console.warn("[Xenial] REJECTED: Invalid or missing auth token");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const payload = req.body;
      
      if (!payload || !payload.data) {
        console.warn("[Xenial] REJECTED: Invalid payload structure");
        res.status(400).json({ error: "Invalid payload" });
        return;
      }

      const result = await processXenialOrder(payload);
      
      if (result.success) {
        console.log(`[Xenial] SUCCESS: Order ${result.orderId} saved`);
        res.json({ success: true, orderId: result.orderId });
      } else {
        console.warn(`[Xenial] FAILED: ${result.error}`);
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error) {
      console.error("Error processing Xenial order:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get POS sales summary for a date
  app.get("/api/pos/sales", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      
      const summary = await getPosOrdersSummary(targetDate);
      
      const result: Record<string, { orders: number; total: number }> = {};
      summary.forEach((value, key) => {
        result[key] = value;
      });
      
      res.json({
        date: targetDate.toISOString().split('T')[0],
        stores: result,
        totalOrders: Array.from(summary.values()).reduce((sum, s) => sum + s.orders, 0),
        totalSales: Array.from(summary.values()).reduce((sum, s) => sum + s.total, 0),
      });
    } catch (error) {
      console.error("Error fetching POS sales:", error);
      res.status(500).json({ error: "Failed to fetch POS sales" });
    }
  });

  // Get recent POS orders (for debugging)
  app.get("/api/pos/recent", async (req, res) => {
    try {
      const { limit = 20 } = req.query;
      
      const orders = await db
        .select({
          id: posOrders.id,
          xenialOrderId: posOrders.xenialOrderId,
          storeNumber: posOrders.storeNumber,
          orderTotal: posOrders.orderTotal,
          businessDate: posOrders.businessDate,
          orderClosedAt: posOrders.orderClosedAt,
          orderSource: posOrders.orderSource,
          receivedAt: posOrders.receivedAt,
        })
        .from(posOrders)
        .orderBy(desc(posOrders.receivedAt))
        .limit(Number(limit));
      
      res.json(orders);
    } catch (error) {
      console.error("Error fetching recent orders:", error);
      res.status(500).json({ error: "Failed to fetch recent orders" });
    }
  });

  // Seed location mappings
  app.post("/api/pos/seed-mappings", async (req, res) => {
    try {
      const count = await seedLocationMappings();
      res.json({ message: `Seeded ${count} location mappings`, count });
    } catch (error) {
      console.error("Error seeding mappings:", error);
      res.status(500).json({ error: "Failed to seed mappings" });
    }
  });

  // POS webhook status - comprehensive order flow monitoring
  app.get("/api/pos/status", async (req, res) => {
    try {
      const now = new Date();
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Today's orders - use posDb for POS data in production (separate database)
      const todayOrders = await posDb
        .select({
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
        })
        .from(posOrders)
        .where(
          and(
            gte(posOrders.businessDate, today),
            lt(posOrders.businessDate, tomorrow)
          )
        );

      // Last hour orders
      const lastHourOrders = await posDb
        .select({
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
        })
        .from(posOrders)
        .where(gte(posOrders.receivedAt, oneHourAgo));

      // Total all-time orders
      const totalOrders = await posDb
        .select({
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
        })
        .from(posOrders);

      // Today's orders by store
      const storeBreakdown = await posDb
        .select({
          storeNumber: posOrders.storeNumber,
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
        })
        .from(posOrders)
        .where(
          and(
            gte(posOrders.businessDate, today),
            lt(posOrders.businessDate, tomorrow)
          )
        )
        .groupBy(posOrders.storeNumber)
        .orderBy(desc(sql`count(*)`));

      // Last 5 orders received
      const recentOrders = await posDb
        .select({
          storeNumber: posOrders.storeNumber,
          orderTotal: posOrders.orderTotal,
          orderSource: posOrders.orderSource,
          receivedAt: posOrders.receivedAt,
        })
        .from(posOrders)
        .orderBy(desc(posOrders.receivedAt))
        .limit(5);

      const lastOrder = recentOrders[0];

      res.json({
        status: "operational",
        version: "2.1.0", // Force rebuild
        webhookEndpoint: "/api/xenial/order",
        webhookEnabled: true,
        serverTime: now.toISOString(),
        today: {
          date: today.toISOString().split('T')[0],
          orderCount: todayOrders[0]?.count || 0,
          salesTotal: Number(todayOrders[0]?.total) || 0,
        },
        lastHour: {
          orderCount: lastHourOrders[0]?.count || 0,
          salesTotal: Number(lastHourOrders[0]?.total) || 0,
        },
        allTime: {
          orderCount: totalOrders[0]?.count || 0,
          salesTotal: Number(totalOrders[0]?.total) || 0,
        },
        lastOrderReceived: lastOrder?.receivedAt || null,
        lastOrderStore: lastOrder?.storeNumber || null,
        lastOrderAmount: lastOrder ? Number(lastOrder.orderTotal) : null,
        storeBreakdown: storeBreakdown.map(s => ({
          store: s.storeNumber,
          orders: s.count,
          total: Number(s.total),
        })),
        recentOrders: recentOrders.map(o => ({
          store: o.storeNumber,
          amount: Number(o.orderTotal),
          source: o.orderSource,
          receivedAt: o.receivedAt,
        })),
      });
    } catch (error) {
      console.error("Error fetching POS status:", error);
      res.status(500).json({ error: "Failed to fetch POS status" });
    }
  });

  // Simple alias for Xenial status
  app.get("/api/xenial/status", async (req, res) => {
    res.redirect("/api/pos/status");
  });

  // ===== HME DRIVE-THRU TIMER ENDPOINTS =====

  // Check HME configuration status (for debugging production issues)
  app.get("/api/hme/status", async (req, res) => {
    try {
      const { checkHMECredentials, getDailyDriveThruSummary } = await import("./scraper/hme-api");
      const credentials = checkHMECredentials();
      
      // Get count of HME data in database for today
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      let dataCount = 0;
      let restaurantsWithData = 0;
      
      try {
        const summary = await getDailyDriveThruSummary(todayStr);
        restaurantsWithData = summary.size;
        Array.from(summary.values()).forEach(data => {
          dataCount += data.carCount;
        });
      } catch (e) {
        // Ignore errors getting summary
      }
      
      res.json({
        credentialsConfigured: credentials.configured,
        missingCredentials: credentials.missing,
        dateChecked: todayStr,
        restaurantsWithData,
        totalCarsToday: dataCount,
        environment: process.env.NODE_ENV || "development",
        isDeployment: process.env.REPLIT_DEPLOYMENT === "1",
      });
    } catch (error) {
      console.error("Error checking HME status:", error);
      res.status(500).json({ 
        error: "Failed to check HME status",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Sync restaurant coordinates from 7shifts
  app.post("/api/sync-restaurants", async (req, res) => {
    try {
      console.log("[Sync] Starting restaurant sync from 7shifts...");
      const count = await syncLocationsFromAPI();
      console.log(`[Sync] Synced ${count} restaurants`);
      res.json({ 
        message: "Restaurant sync completed",
        synced: count 
      });
    } catch (error: any) {
      console.error("[Sync] Error syncing restaurants:", error);
      res.status(500).json({ error: error.message || "Failed to sync restaurants" });
    }
  });

  // Sync HME timer data
  app.post("/api/hme/sync", async (req, res) => {
    try {
      const { date } = req.body || {};
      const targetDate = date ? new Date(date) : undefined;

      const { syncHMETimerData } = await import("./scraper/hme-api");
      const result = await syncHMETimerData(targetDate);
      console.log("[HME] Sync completed:", result);
      
      res.json({ 
        message: result.saved > 0 ? "HME sync completed successfully" : "HME sync completed but no data saved",
        status: "completed",
        saved: result.saved,
        errors: result.errors 
      });
    } catch (error: any) {
      console.error("Error during HME sync:", error);
      res.status(500).json({ error: error.message || "Failed to sync HME data" });
    }
  });

  // Get HME timer metrics for a restaurant
  app.get("/api/hme/metrics/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { date } = req.query;
      
      // Use Central timezone for today's date
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const dateStr = date ? String(date) : todayStr;
      
      const { getHMETimerMetrics } = await import("./scraper/hme-api");
      const metrics = await getHMETimerMetrics(restaurantId, dateStr);
      
      res.json({ date: dateStr, metrics });
    } catch (error) {
      console.error("Error fetching HME metrics:", error);
      res.status(500).json({ error: "Failed to fetch HME metrics" });
    }
  });

  // Get HME daily summary for all restaurants
  app.get("/api/hme/daily-summary", async (req, res) => {
    try {
      const { date } = req.query;
      
      // Use Central timezone for today's date
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const dateStr = date ? String(date) : todayStr;
      
      const { getDailyDriveThruSummary } = await import("./scraper/hme-api");
      const summary = await getDailyDriveThruSummary(dateStr);
      
      const result: Record<string, { carCount: number; avgTotalTime: number; avgServiceTime: number }> = {};
      summary.forEach((value, key) => {
        result[key] = value;
      });
      
      res.json({ date: dateStr, summary: result });
    } catch (error) {
      console.error("Error fetching HME daily summary:", error);
      res.status(500).json({ error: "Failed to fetch HME daily summary" });
    }
  });

  // Get HME stores list (for validation/debugging)
  app.get("/api/hme/stores", async (req, res) => {
    try {
      const { fetchHMEStores } = await import("./scraper/hme-api");
      const stores = await fetchHMEStores();
      res.json({ total: stores.length, stores });
    } catch (error) {
      console.error("Error fetching HME stores:", error);
      res.status(500).json({ error: "Failed to fetch HME stores" });
    }
  });

  // Get Google Reviews sync status
  app.get("/api/google-reviews/status", async (req, res) => {
    try {
      const restaurants = await storage.getRestaurants();
      const configuredRestaurants = restaurants.filter(r => r.googlePlaceId);
      
      // Get today's date in Central timezone
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      
      // Count restaurants with synced data today
      const { getGoogleReviewsForAllRestaurants } = await import("./google-places");
      const reviewsMap = await getGoogleReviewsForAllRestaurants(todayStr);
      
      let totalReviewsToday = 0;
      let restaurantsWithData = 0;
      reviewsMap.forEach((value) => {
        restaurantsWithData++;
        totalReviewsToday += value.reviewCount;
      });
      
      res.json({
        credentialsConfigured: !!process.env.GOOGLE_PLACES_API_KEY,
        configuredCount: configuredRestaurants.length,
        totalRestaurants: restaurants.filter(r => r.isActive).length,
        restaurantsWithData,
        totalReviewsToday,
        dateChecked: todayStr,
      });
    } catch (error) {
      console.error("Error fetching Google reviews status:", error);
      res.status(500).json({ error: "Failed to fetch Google reviews status" });
    }
  });

  // Sync Google reviews for all restaurants
  app.post("/api/google-reviews/sync", async (req, res) => {
    try {
      const { syncAllGoogleReviews } = await import("./google-places");
      const result = await syncAllGoogleReviews();
      res.json({
        message: "Google reviews sync completed",
        success: result.success,
        failed: result.failed,
      });
    } catch (error: any) {
      console.error("Error syncing Google reviews:", error);
      res.status(500).json({ error: error.message || "Failed to sync Google reviews" });
    }
  });

  // Get Google reviews for a specific restaurant
  app.get("/api/google-reviews/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { date } = req.query;
      
      const { getGoogleReviewsForRestaurant } = await import("./google-places");
      const reviews = await getGoogleReviewsForRestaurant(restaurantId, date ? String(date) : undefined);
      
      res.json({ restaurantId, reviews });
    } catch (error) {
      console.error("Error fetching Google reviews:", error);
      res.status(500).json({ error: "Failed to fetch Google reviews" });
    }
  });

  // Get Google reviews summary for all restaurants
  app.get("/api/google-reviews/daily-summary", async (req, res) => {
    try {
      const { date } = req.query;
      
      const { getGoogleReviewsForAllRestaurants } = await import("./google-places");
      const reviewsMap = await getGoogleReviewsForAllRestaurants(date ? String(date) : undefined);
      
      const result: Record<string, { rating: number; reviewCount: number }> = {};
      reviewsMap.forEach((value, key) => {
        result[key] = value;
      });
      
      res.json({ date: date || new Date().toISOString().split('T')[0], reviews: result });
    } catch (error) {
      console.error("Error fetching Google reviews summary:", error);
      res.status(500).json({ error: "Failed to fetch Google reviews summary" });
    }
  });

  // ========== CREW EXPERIENCE ENDPOINTS ==========
  
  // Sync employees from 7shifts
  app.post("/api/crew/sync-employees", async (req, res) => {
    try {
      const { syncEmployees } = await import("./scraper/7shifts-api");
      const result = await syncEmployees();
      res.json(result);
    } catch (error) {
      console.error("Error syncing employees:", error);
      res.status(500).json({ error: "Failed to sync employees" });
    }
  });
  
  // Sync hourly crew data for a specific date
  app.post("/api/crew/sync", async (req, res) => {
    try {
      const { date } = req.body;
      const { syncHourlyCrew } = await import("./scraper/7shifts-api");
      const targetDate = date ? new Date(date) : undefined;
      const result = await syncHourlyCrew(targetDate);
      res.json(result);
    } catch (error) {
      console.error("Error syncing crew data:", error);
      res.status(500).json({ error: "Failed to sync crew data" });
    }
  });
  
  // Get crew experience data for all restaurants on a specific date
  app.get("/api/crew/experience", async (req, res) => {
    try {
      const { date } = req.query;
      const dateStr = date ? String(date) : new Date().toISOString().split('T')[0];
      
      const { hourlyCrew, employees } = await import("@shared/schema");
      const { formatTenure, formatTenureMix } = await import("./scraper/7shifts-api");
      
      // Get all restaurants
      const allRestaurants = await db.select().from(restaurants);
      
      // Get hourly crew data for the date
      const crewData = await db
        .select()
        .from(hourlyCrew)
        .where(eq(hourlyCrew.date, dateStr));
      
      // Get all employees for employee count per restaurant
      const allEmployees = await db.select().from(employees).where(eq(employees.active, true));
      
      // Group by restaurant
      const restaurantCrewMap = new Map<string, typeof crewData>();
      for (const row of crewData) {
        const existing = restaurantCrewMap.get(row.restaurantId) || [];
        existing.push(row);
        restaurantCrewMap.set(row.restaurantId, existing);
      }
      
      // Build response for each restaurant
      const result = allRestaurants.map(r => {
        const hourlyData = restaurantCrewMap.get(r.id) || [];
        
        // Calculate restaurant-level metrics
        let totalMonths = 0;
        let totalCrew = 0;
        
        const hourlyFormatted = hourlyData.map(h => {
          const members = (h.crewMembers as any[]) || [];
          totalCrew += members.length;
          members.forEach(m => totalMonths += m.tenureMonths || 0);
          
          return {
            hour: h.hour,
            label: `${h.hour === 0 ? 12 : h.hour > 12 ? h.hour - 12 : h.hour}${h.hour < 12 ? 'am' : 'pm'}`,
            crewCount: h.crewCount,
            avgTenure: formatTenure(Number(h.avgTenureMonths) || 0),
            score: h.experienceScore || 0,
            mix: formatTenureMix(h.tenureMix as any || { trainee: 0, developing: 0, experienced: 0, veteran: 0 }),
            team: members.map(m => ({
              name: `${m.firstName} ${m.lastName?.charAt(0) || ''}.`,
              tenureMonths: m.tenureMonths,
              category: m.category as 'trainee' | 'developing' | 'experienced' | 'veteran',
            })),
          };
        }).sort((a, b) => a.hour - b.hour);
        
        const avgTenureMonths = totalCrew > 0 ? totalMonths / totalCrew : 0;
        
        return {
          restaurantId: r.id,
          restaurantName: r.name,
          employeeCount: allEmployees.filter(e => e.restaurantId === r.id).length,
          avgTenure: formatTenure(avgTenureMonths),
          avgScore: hourlyFormatted.length > 0 
            ? Math.round(hourlyFormatted.reduce((sum, h) => sum + h.score, 0) / hourlyFormatted.length)
            : 0,
          hourly: hourlyFormatted,
        };
      });
      
      // Also build a flat data map keyed by restaurantId for dashboard consumption
      const dataMap: Record<string, { hour: number; crewCount: number; experienceScore: number; tenureMix: { trainee: number; developing: number; experienced: number; veteran: number } }[]> = {};
      for (const r of result) {
        if (r.hourly.length > 0) {
          dataMap[r.restaurantId] = r.hourly.map(h => ({
            hour: h.hour,
            crewCount: h.crewCount,
            experienceScore: h.score,
            tenureMix: (restaurantCrewMap.get(r.restaurantId)?.find(d => d.hour === h.hour)?.tenureMix as any) || { trainee: 0, developing: 0, experienced: 0, veteran: 0 },
          }));
        }
      }
      
      res.json({ date: dateStr, restaurants: result, data: dataMap });
    } catch (error) {
      console.error("Error fetching crew experience:", error);
      res.status(500).json({ error: "Failed to fetch crew experience data" });
    }
  });
  
  // Get crew experience summary for leaderboard (daily average scores)
  app.get("/api/crew/summary", async (req, res) => {
    try {
      const { date } = req.query;
      const dateStr = date ? String(date) : new Date().toISOString().split('T')[0];
      
      const { hourlyCrew } = await import("@shared/schema");
      
      // Get hourly crew data for the date with aggregates
      const crewData = await db
        .select({
          restaurantId: hourlyCrew.restaurantId,
          avgScore: sql<number>`avg(${hourlyCrew.experienceScore})`,
          avgCrewCount: sql<number>`avg(${hourlyCrew.crewCount})`,
          avgTenureMonths: sql<number>`avg(${hourlyCrew.avgTenureMonths}::numeric)`,
          hourCount: sql<number>`count(*)`,
        })
        .from(hourlyCrew)
        .where(eq(hourlyCrew.date, dateStr))
        .groupBy(hourlyCrew.restaurantId);
      
      // Build summary map
      const summary: Record<string, { avgScore: number; avgCrewCount: number; avgTenureMonths: number }> = {};
      for (const row of crewData) {
        summary[row.restaurantId] = {
          avgScore: Math.round(Number(row.avgScore) || 0),
          avgCrewCount: Math.round((Number(row.avgCrewCount) || 0) * 10) / 10,
          avgTenureMonths: Math.round((Number(row.avgTenureMonths) || 0) * 10) / 10,
        };
      }
      
      res.json({ date: dateStr, summary });
    } catch (error) {
      console.error("Error fetching crew summary:", error);
      res.status(500).json({ error: "Failed to fetch crew summary" });
    }
  });
  
  // Get manager/supervisor performance rankings
  app.get("/api/people/performance", async (req, res) => {
    try {
      const { date, days = "7" } = req.query;
      const endDate = date ? new Date(String(date)) : new Date();
      const numDays = Math.min(parseInt(String(days)) || 7, 180);
      const MIN_HOURS_REQUIRED = 16; // Minimum hours worked to qualify for rankings
      
      // Calculate date range
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - numDays + 1);
      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];
      
      // Get managers and shift supervisors
      const leaderEmployees = await db
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.active, true),
            sql`(${employees.position} ILIKE '%manager%' OR ${employees.position} ILIKE '%supervisor%' OR ${employees.type} IN ('manager', 'asst_manager'))`
          )
        );
      
      if (leaderEmployees.length === 0) {
        return res.json({ 
          dateRange: { start: startDateStr, end: endDateStr },
          byStore: {},
          companyRankings: [],
        });
      }
      
      // Get hourly crew data for the date range
      const crewData = await db
        .select()
        .from(hourlyCrew)
        .where(
          and(
            gte(hourlyCrew.date, startDateStr),
            sql`${hourlyCrew.date} <= ${endDateStr}`
          )
        );
      
      // Get hourly labor data for execution grade calculation
      const laborData = await db
        .select()
        .from(hourlyLabor)
        .where(
          and(
            gte(hourlyLabor.date, startDateStr),
            sql`${hourlyLabor.date} <= ${endDateStr}`
          )
        );
      
      // Get hourly sales for execution grade calculation
      const salesData = await db
        .select()
        .from(hourlySales)
        .where(
          and(
            gte(sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD')`, startDateStr),
            sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') <= ${endDateStr}`
          )
        );
      
      // Build lookup maps
      const laborByKey = new Map<string, typeof laborData[0]>();
      for (const l of laborData) {
        laborByKey.set(`${l.restaurantId}-${l.date}-${l.hour}`, l);
      }
      
      const salesByKey = new Map<string, typeof salesData[0]>();
      for (const s of salesData) {
        const dateStr = s.salesDate.toISOString().split('T')[0];
        salesByKey.set(`${s.restaurantId}-${dateStr}-${s.hour}`, s);
      }
      
      // Calculate performance for each leader
      type LeaderPerformance = {
        employeeId: string;
        name: string;
        position: string;
        restaurantId: string;
        restaurantName: string;
        hoursWorked: number;
        avgGradeScore: number;
        grade: string;
      };
      
      const allRestaurants = await db.select().from(restaurants);
      const restaurantNameMap = new Map(allRestaurants.map(r => [r.id, r.name]));
      
      const leaderPerformance: LeaderPerformance[] = [];
      
      for (const leader of leaderEmployees) {
        const userId = leader.sevenShiftsUserId;
        
        // Find hours this leader worked and track restaurants they worked at
        const gradeScores: number[] = [];
        const workedAtRestaurants = new Map<string, number>(); // restaurantId -> hours count
        
        for (const crew of crewData) {
          const members = (crew.crewMembers as any[]) || [];
          const wasWorking = members.some(m => m.userId === userId);
          
          if (wasWorking) {
            // Track restaurant where they worked
            workedAtRestaurants.set(crew.restaurantId, (workedAtRestaurants.get(crew.restaurantId) || 0) + 1);
            
            // Get execution grade for this hour
            const labor = laborByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
            const sales = salesByKey.get(`${crew.restaurantId}-${crew.date}-${crew.hour}`);
            
            if (labor && sales) {
              // Calculate execution score components
              const lastWeekSales = Number(sales.pastActualSales) || 0;
              const todaySales = Number(sales.actualSales) || 0;
              const hasComparableSales = lastWeekSales > 0;
              const salesVariancePct = hasComparableSales 
                ? ((todaySales - lastWeekSales) / lastWeekSales) * 100 
                : 0;
              
              // Staffing calculation (simplified)
              const actualStaff = Number(labor.employeeCount) || 0;
              const projectedStaff = (Number(labor.projectedLabor) || 0) / 10; // rough estimate
              const staffingDiff = actualStaff - projectedStaff;
              
              // Score components
              const salesScore = hasComparableSales ? (salesVariancePct >= -5 ? 100 : 50) : 75;
              const staffingScore = Math.abs(staffingDiff) <= 1 ? 100 : (staffingDiff > 1 ? 70 : 60);
              
              const score = (salesScore + staffingScore) / 2;
              gradeScores.push(score);
            }
          }
        }
        
        // Only include if they have minimum required hours
        if (gradeScores.length >= MIN_HOURS_REQUIRED) {
          const avgScore = gradeScores.reduce((a, b) => a + b, 0) / gradeScores.length;
          
          // Convert score to grade
          let grade = 'C';
          if (avgScore >= 95) grade = 'A+';
          else if (avgScore >= 85) grade = 'A';
          else if (avgScore >= 75) grade = 'B';
          else if (avgScore >= 65) grade = 'C';
          else if (avgScore >= 55) grade = 'D';
          else grade = 'F';
          
          // Determine restaurant from where they worked most (instead of employee profile)
          let primaryRestaurantId = '';
          let maxHours = 0;
          workedAtRestaurants.forEach((hours, rid) => {
            if (hours > maxHours) {
              maxHours = hours;
              primaryRestaurantId = rid;
            }
          });
          
          // Get restaurant name from the restaurant they worked at
          const restaurantName = restaurantNameMap.get(primaryRestaurantId) || '';
          
          // Skip if we can't determine the restaurant
          if (!primaryRestaurantId || !restaurantName) {
            continue;
          }
          
          // Map position types to display names
          let displayPosition = leader.position || '';
          if (!displayPosition) {
            // Fallback to type field but map it nicely
            if (leader.type === 'asst_manager') displayPosition = 'Manager';
            else if (leader.type === 'manager') displayPosition = 'Manager';
            else if (leader.type === 'employee') displayPosition = 'Team Member';
            else displayPosition = 'Leader';
          }
          // Additional mapping for position field values
          if (displayPosition === 'asst_manager') displayPosition = 'Manager';
          if (displayPosition.toLowerCase().includes('supervisor')) displayPosition = 'Shift Supervisor';
          if (displayPosition.toLowerCase().includes('manager') && displayPosition !== 'Shift Supervisor') displayPosition = 'Manager';
          
          leaderPerformance.push({
            employeeId: leader.id,
            name: `${leader.firstName} ${leader.lastName}`,
            position: displayPosition,
            restaurantId: primaryRestaurantId,
            restaurantName: restaurantName,
            hoursWorked: gradeScores.length,
            avgGradeScore: Math.round(avgScore),
            grade,
          });
        }
      }
      
      // Sort by score descending
      leaderPerformance.sort((a, b) => b.avgGradeScore - a.avgGradeScore);
      
      // Group by store
      const byStore: Record<string, LeaderPerformance[]> = {};
      for (const lp of leaderPerformance) {
        if (lp.restaurantId) {
          if (!byStore[lp.restaurantId]) {
            byStore[lp.restaurantId] = [];
          }
          byStore[lp.restaurantId].push(lp);
        }
      }
      
      // Sort each store's list by score
      for (const rid of Object.keys(byStore)) {
        byStore[rid].sort((a, b) => b.avgGradeScore - a.avgGradeScore);
      }
      
      res.json({
        dateRange: { start: startDateStr, end: endDateStr },
        byStore,
        companyRankings: leaderPerformance,
      });
    } catch (error) {
      console.error("Error fetching people performance:", error);
      res.status(500).json({ error: "Failed to fetch people performance data" });
    }
  });

  return httpServer;
}
