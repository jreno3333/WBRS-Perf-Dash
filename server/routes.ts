import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchSalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, fetchHourlySalesFromAPI, syncLocationsFromAPI } from "./scraper/7shifts-api";
import { db, posDb } from "./db";
import { scraperRuns, posOrders, hourlySales, hourlyLabor, hourlyCrew, restaurants, employees, markets, restaurantMarkets, dailyOsat, hmeTimerData } from "@shared/schema";
import { desc, sql, gte, lte, lt, and, eq } from "drizzle-orm";
import { processXenialOrder, validateWebhookToken, seedLocationMappings, getPosOrdersSummary, getAllHourlyPosSales } from "./xenial-webhook";
import { getHolidayContext, getHolidayComparisonContext, getAllHolidaysForYear } from "./holidays";
import { getDailyDriveThruSummary } from "./scraper/hme-api";
import { syncOsatData, getOsatForDate } from "./scraper/qualtrics-api";

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
      
      // Fetch OSAT data for all restaurants
      const osatDataMap = await getOsatForDate(targetDateStr);
      
      // Add OSAT data to each restaurant
      for (const r of restaurantsWithWeather) {
        const osat = osatDataMap[r.restaurantId];
        if (osat) {
          (r as any).osat = {
            osatPercent: osat.osatPercent,
            totalResponses: osat.totalResponses,
            fiveStarCount: osat.fiveStarCount,
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

  // Debug endpoint to resync labor data for a specific restaurant and date
  app.post("/api/debug/labor-resync", async (req, res) => {
    try {
      const { restaurantName, date } = req.body;
      if (!restaurantName || !date) {
        return res.status(400).json({ error: "restaurantName and date are required" });
      }
      
      const { resyncLaborForRestaurant } = await import("./scraper/7shifts-api");
      const result = await resyncLaborForRestaurant(restaurantName, date);
      res.json(result);
    } catch (error) {
      console.error("Error resyncing labor:", error);
      res.status(500).json({ error: "Failed to resync labor data" });
    }
  });

  // Fix labor data for Eastern timezone stores on a specific date
  app.post("/api/debug/fix-labor", async (req, res) => {
    try {
      const { restaurantName, date } = req.body;
      if (!restaurantName || !date) {
        return res.status(400).json({ error: "restaurantName and date are required" });
      }
      
      const { fixLaborForRestaurant } = await import("./scraper/7shifts-api");
      const result = await fixLaborForRestaurant(restaurantName, date);
      res.json(result);
    } catch (error) {
      console.error("Error fixing labor:", error);
      res.status(500).json({ error: "Failed to fix labor data" });
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

  // ========== QUALTRICS OSAT ENDPOINTS ==========
  
  // Get OSAT sync status
  app.get("/api/osat/status", async (req, res) => {
    try {
      const apiToken = process.env.QUALTRICS_API_TOKEN;
      const surveyId = process.env.QUALTRICS_SURVEY_ID;
      
      const credentialsConfigured = !!(apiToken && surveyId);
      
      // Get today's OSAT data
      const now = new Date();
      const centralFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
      const todayStr = centralFormatter.format(now);
      
      const todayData = await db.select().from(dailyOsat).where(eq(dailyOsat.date, todayStr));
      
      const restaurantsWithData = todayData.length;
      const totalResponses = todayData.reduce((sum, r) => sum + r.totalResponses, 0);
      const totalFiveStar = todayData.reduce((sum, r) => sum + r.fiveStarCount, 0);
      const avgOsat = totalResponses > 0 ? ((totalFiveStar / totalResponses) * 100).toFixed(1) : null;
      
      // Get last sync time
      const latestSync = todayData.length > 0 
        ? todayData.reduce((latest, r) => {
            const syncTime = r.syncedAt ? new Date(r.syncedAt) : new Date(0);
            return syncTime > latest ? syncTime : latest;
          }, new Date(0))
        : null;
      
      res.json({
        credentialsConfigured,
        surveyIdConfigured: !!surveyId,
        restaurantsWithData,
        totalResponses,
        avgOsat,
        dateChecked: todayStr,
        lastSync: latestSync?.toISOString() || null,
      });
    } catch (error) {
      console.error("Error getting OSAT status:", error);
      res.status(500).json({ error: "Failed to get OSAT status" });
    }
  });
  
  // Sync OSAT data from Qualtrics (default 3 days)
  app.post("/api/osat/sync", async (req, res) => {
    try {
      const daysBack = req.body?.daysBack || 3;
      const result = await syncOsatData(daysBack);
      res.json({
        message: "OSAT sync completed",
        synced: result.synced,
        daysBack,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error("Error syncing OSAT data:", error);
      res.status(500).json({ error: error.message || "Failed to sync OSAT data" });
    }
  });
  
  // Historical OSAT sync (7 days)
  app.post("/api/osat/sync-historical", async (req, res) => {
    try {
      const daysBack = req.body?.daysBack || 7;
      console.log(`[OSAT] Starting historical sync for ${daysBack} days`);
      const result = await syncOsatData(daysBack);
      res.json({
        message: "Historical OSAT sync completed",
        synced: result.synced,
        daysBack,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error("Error syncing historical OSAT data:", error);
      res.status(500).json({ error: error.message || "Failed to sync historical OSAT data" });
    }
  });
  
  // Get OSAT summary for a specific date
  app.get("/api/osat/summary", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? String(date) : new Date().toISOString().split('T')[0];
      
      const osatMap = await getOsatForDate(targetDate);
      res.json({ date: targetDate, osat: osatMap });
    } catch (error) {
      console.error("Error fetching OSAT summary:", error);
      res.status(500).json({ error: "Failed to fetch OSAT summary" });
    }
  });
  
  // Get category issues for a restaurant on a specific date
  app.get("/api/osat/category-issues", async (req, res) => {
    try {
      const { osatCategoryIssues } = await import("@shared/schema");
      const { restaurantId, date } = req.query;
      
      if (!restaurantId || !date) {
        return res.status(400).json({ error: "restaurantId and date are required" });
      }
      
      const issues = await db.select()
        .from(osatCategoryIssues)
        .where(and(
          eq(osatCategoryIssues.restaurantId, String(restaurantId)),
          eq(osatCategoryIssues.date, String(date))
        ));
      
      // Aggregate issues by category
      const categoryNames: Record<string, string> = {
        orderAccuracy: 'Order Accuracy',
        foodQuality: 'Food Quality',
        menuOptions: 'Menu Options',
        value: 'Value',
        easeOfOrdering: 'Ease of Ordering',
        employeeFriendliness: 'Employee Friendliness',
        speedOfService: 'Speed of Service',
        cleanliness: 'Cleanliness',
        driveThruWaitTime: 'Drive-Thru Wait Time',
      };
      
      // Count low ratings (< 3) per category
      const categoryIssues: { category: string; lowCount: number; totalCount: number; avgRating: number }[] = [];
      
      for (const [key, label] of Object.entries(categoryNames)) {
        const ratings = issues
          .map(i => (i as any)[key])
          .filter((r: any) => r !== null && r !== undefined) as number[];
        
        if (ratings.length > 0) {
          const lowCount = ratings.filter(r => r < 3).length;
          const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
          
          if (lowCount > 0 || avgRating < 3) {
            categoryIssues.push({
              category: label,
              lowCount,
              totalCount: ratings.length,
              avgRating: Math.round(avgRating * 10) / 10,
            });
          }
        }
      }
      
      // Sort by most issues first
      categoryIssues.sort((a, b) => b.lowCount - a.lowCount || a.avgRating - b.avgRating);
      
      res.json({ 
        restaurantId, 
        date, 
        totalSurveys: issues.length,
        categoryIssues 
      });
    } catch (error) {
      console.error("Error fetching category issues:", error);
      res.status(500).json({ error: "Failed to fetch category issues" });
    }
  });
  
  // Get category issues aggregated for all restaurants on a specific date
  // Support both query param and path param formats
  const handleCategoryIssuesAll = async (date: string, res: any) => {
    try {
      const { osatCategoryIssues } = await import("@shared/schema");
      
      const issues = await db.select()
        .from(osatCategoryIssues)
        .where(eq(osatCategoryIssues.date, date));
      
      // Group by restaurant
      const byRestaurant: Record<string, typeof issues> = {};
      for (const issue of issues) {
        if (!byRestaurant[issue.restaurantId]) {
          byRestaurant[issue.restaurantId] = [];
        }
        byRestaurant[issue.restaurantId].push(issue);
      }
      
      res.json({ date, issuesByRestaurant: byRestaurant });
    } catch (error) {
      console.error("Error fetching all category issues:", error);
      res.status(500).json({ error: "Failed to fetch category issues" });
    }
  };
  
  // Query param version: /api/osat/category-issues/all?date=2026-02-04
  app.get("/api/osat/category-issues/all", async (req, res) => {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }
    return handleCategoryIssuesAll(String(date), res);
  });
  
  // Path param version: /api/osat/category-issues/all/2026-02-04
  app.get("/api/osat/category-issues/all/:date", async (req, res) => {
    const { date } = req.params;
    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }
    return handleCategoryIssuesAll(date, res);
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
      // Accept date from body or query parameters
      const date = req.body?.date || req.query?.date;
      const { syncHourlyCrew } = await import("./scraper/7shifts-api");
      const targetDate = date ? new Date(String(date)) : undefined;
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
              
              // Don't penalize understaffing when sales are 20%+ higher than last week
              const salesSurge = salesVariancePct >= 20;
              let staffingScore: number;
              if (Math.abs(staffingDiff) <= 1) {
                staffingScore = 100; // Properly staffed
              } else if (staffingDiff > 1) {
                staffingScore = 70; // Overstaffed
              } else {
                // Understaffed
                staffingScore = salesSurge ? 100 : 60; // No penalty if sales 20%+ above last week
              }
              
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
  // ============ MARKETS API ============
  // Get all markets with their restaurant assignments
  app.get("/api/markets", async (req, res) => {
    try {
      const allMarkets = await db.select().from(markets);
      const allAssignments = await db.select().from(restaurantMarkets);
      
      const marketsWithRestaurants = allMarkets.map(market => ({
        ...market,
        restaurantIds: allAssignments
          .filter(a => a.marketId === market.id)
          .map(a => a.restaurantId),
      }));
      
      res.json(marketsWithRestaurants);
    } catch (error) {
      console.error("Error fetching markets:", error);
      res.status(500).json({ error: "Failed to fetch markets" });
    }
  });

  // Create a new market
  app.post("/api/markets", async (req, res) => {
    try {
      const { name, color } = req.body;
      if (!name) {
        return res.status(400).json({ error: "Market name is required" });
      }
      
      const [newMarket] = await db.insert(markets).values({
        name,
        color: color || "#6366f1",
      }).returning();
      
      res.json({ ...newMarket, restaurantIds: [] });
    } catch (error) {
      console.error("Error creating market:", error);
      res.status(500).json({ error: "Failed to create market" });
    }
  });

  // Update a market
  app.patch("/api/markets/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, color, restaurantIds } = req.body;
      
      // Update market details if provided
      if (name || color) {
        const updates: Partial<{ name: string; color: string }> = {};
        if (name) updates.name = name;
        if (color) updates.color = color;
        
        await db.update(markets).set(updates).where(eq(markets.id, id));
      }
      
      // Update restaurant assignments if provided
      if (restaurantIds !== undefined) {
        // Remove all existing assignments for this market
        await db.delete(restaurantMarkets).where(eq(restaurantMarkets.marketId, id));
        
        // Add new assignments
        if (restaurantIds.length > 0) {
          await db.insert(restaurantMarkets).values(
            restaurantIds.map((restaurantId: string) => ({
              restaurantId,
              marketId: id,
            }))
          );
        }
      }
      
      // Fetch updated market with assignments
      const [updatedMarket] = await db.select().from(markets).where(eq(markets.id, id));
      const assignments = await db.select().from(restaurantMarkets).where(eq(restaurantMarkets.marketId, id));
      
      res.json({
        ...updatedMarket,
        restaurantIds: assignments.map(a => a.restaurantId),
      });
    } catch (error) {
      console.error("Error updating market:", error);
      res.status(500).json({ error: "Failed to update market" });
    }
  });

  // Delete a market
  app.delete("/api/markets/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      // Remove all restaurant assignments first
      await db.delete(restaurantMarkets).where(eq(restaurantMarkets.marketId, id));
      
      // Delete the market
      await db.delete(markets).where(eq(markets.id, id));
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting market:", error);
      res.status(500).json({ error: "Failed to delete market" });
    }
  });

  // Performance History endpoint - returns daily grades over a date range
  app.get("/api/performance-history", async (req, res) => {
    try {
      const { days = "7", startDate, endDate } = req.query;
      
      // Calculate date range based on available data
      // First, find the most recent date that has data
      const latestDataResult = await db.select({ maxDate: sql<string>`MAX(DATE(sales_date))` })
        .from(hourlySales);
      const latestDataDate = latestDataResult[0]?.maxDate;
      
      let dateRange: string[] = [];
      
      if (startDate && endDate) {
        // Custom date range
        const start = new Date(`${startDate}T12:00:00Z`);
        const end = new Date(`${endDate}T12:00:00Z`);
        const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        
        for (let i = 0; i < daysDiff; i++) {
          const date = new Date(start);
          date.setDate(date.getDate() + i);
          dateRange.push(date.toISOString().split('T')[0]);
        }
      } else {
        // Last N days - use the most recent date with data as the end point
        const numDays = parseInt(days as string) || 7;
        const endDate = latestDataDate 
          ? new Date(`${latestDataDate}T12:00:00Z`) 
          : new Date();
        const startDateCalc = new Date(endDate);
        startDateCalc.setDate(startDateCalc.getDate() - (numDays - 1));
        
        for (let i = 0; i < numDays; i++) {
          const date = new Date(startDateCalc);
          date.setDate(date.getDate() + i);
          dateRange.push(date.toISOString().split('T')[0]);
        }
      }
      
      // Fetch all hourly sales data for the date range
      // hourlySales uses salesDate (timestamp) - we need to filter by date range
      const startDateTs = new Date(`${dateRange[0]}T00:00:00Z`);
      const endDateTs = new Date(`${dateRange[dateRange.length - 1]}T23:59:59Z`);
      const allHourlySales = await db.select().from(hourlySales)
        .where(and(
          gte(hourlySales.salesDate, startDateTs),
          lte(hourlySales.salesDate, endDateTs)
        ));
      
      // Fetch all hourly labor data for the date range
      const allHourlyLabor = await db.select().from(hourlyLabor)
        .where(and(
          gte(hourlyLabor.date, dateRange[0]),
          lte(hourlyLabor.date, dateRange[dateRange.length - 1])
        ));
      
      // Fetch OSAT data for the date range
      const allOsatData = await db.select().from(dailyOsat)
        .where(and(
          gte(dailyOsat.date, dateRange[0]),
          lte(dailyOsat.date, dateRange[dateRange.length - 1])
        ));
      
      // Fetch HME timer data for speed
      const allHmeData = await db.select().from(hmeTimerData)
        .where(and(
          gte(hmeTimerData.date, dateRange[0]),
          lte(hmeTimerData.date, dateRange[dateRange.length - 1])
        ));
      
      // Fetch hourly crew data for experience scores (XP)
      const allCrewData = await db.select().from(hourlyCrew)
        .where(and(
          gte(hourlyCrew.date, dateRange[0]),
          lte(hourlyCrew.date, dateRange[dateRange.length - 1])
        ));
      
      // Get all restaurants
      const restaurantList = await storage.getRestaurants();
      
      // Get markets
      const allMarkets = await db.select().from(markets);
      const marketAssignments = await db.select().from(restaurantMarkets);
      
      // Build market lookup (restaurant.id is string, rm.restaurantId is number, market.id is string)
      const restaurantToMarket = new Map<string, { id: string; name: string }>();
      marketAssignments.forEach(rm => {
        const market = allMarkets.find(m => m.id === String(rm.marketId));
        if (market) {
          restaurantToMarket.set(String(rm.restaurantId), { id: market.id, name: market.name });
        }
      });
      
      // Helper function to calculate execution grade - ALIGNED WITH CLIENT-SIDE LOGIC
      // Matches getExecutionGrade in leaderboard-card.tsx exactly
      const GRADE_WEIGHTS = { sales: 35, speed: 25, osat: 25, staffing: 15 };
      
      const calculateGrade = (
        salesVariancePct: number,
        speedSeconds: number | undefined,
        staffingDiff: number,
        hasComparableSales: boolean,
        hasValidStaffing: boolean,
        osatPercent: number | undefined,
        isFirstWeek: boolean = false
      ): { grade: number; gradeLabel: string; hasGrade: boolean } => {
        const components: { name: string; score: number; weight: number }[] = [];
        
        // Sales component (weight: 35%)
        // For units with comparable data: Within -5% to +infinity = 100, Below -5% = 50
        // For first-week units without comparable data: give neutral score (100)
        // For established units without comparable data: skip the sales component
        if (hasComparableSales) {
          const salesScore = salesVariancePct >= -5 ? 100 : 50;
          components.push({ name: 'sales', score: salesScore, weight: GRADE_WEIGHTS.sales });
        } else if (isFirstWeek) {
          // First week units get neutral sales score since no historical data exists
          components.push({ name: 'sales', score: 100, weight: GRADE_WEIGHTS.sales });
        }
        
        // Speed component (weight: 25%) - only if we have valid drive-thru data
        // GREEN (<5min/300s) = 100, YELLOW (5-7min/300-420s) = 70, RED (>7min/420s) = 40
        if (speedSeconds !== undefined && speedSeconds > 0) {
          let speedScore = 100;
          if (speedSeconds > 420) speedScore = 40;
          else if (speedSeconds > 300) speedScore = 70;
          components.push({ name: 'speed', score: speedScore, weight: GRADE_WEIGHTS.speed });
        }
        
        // OSAT component (weight: 25%) - only if we have customer satisfaction data
        // 85%+ = 100 (excellent), 80-85% = 70 (acceptable), <80% = 40 (needs improvement)
        if (osatPercent !== undefined && osatPercent > 0) {
          let osatScore = 100;
          if (osatPercent < 80) osatScore = 40;
          else if (osatPercent < 85) osatScore = 70;
          components.push({ name: 'osat', score: osatScore, weight: GRADE_WEIGHTS.osat });
        }
        
        // Staffing component (weight: 15%) - only if we have valid staffing data
        // PROPER (within ±1) = 100, UNDER/OVER = 60
        // SALES SURGE EXCEPTION: No understaffing penalty when sales are 20%+ above last week
        if (hasValidStaffing) {
          let staffingScore = 100;
          const isSalesSurge = salesVariancePct >= 20;
          const isUnderstaffed = staffingDiff < -1;
          const isOverstaffed = staffingDiff > 1;
          
          if (isOverstaffed) {
            staffingScore = 60;
          } else if (isUnderstaffed && !isSalesSurge) {
            staffingScore = 60;
          }
          components.push({ name: 'staffing', score: staffingScore, weight: GRADE_WEIGHTS.staffing });
        }
        
        // If no components to grade, return no grade
        if (components.length === 0) {
          return { grade: 0, gradeLabel: '-', hasGrade: false };
        }
        
        // Calculate weighted average - normalize weights based on available components
        const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
        const avgScore = components.reduce((sum, c) => sum + (c.score * c.weight), 0) / totalWeight;
        
        return { grade: avgScore, gradeLabel: getGradeLabel(avgScore), hasGrade: true };
      };
      
      // Helper to get grade label - ALIGNED WITH CLIENT-SIDE LOGIC (detailed scale)
      const getGradeLabel = (score: number): string => {
        if (score >= 95) return "A+";
        if (score >= 90) return "A";
        if (score >= 85) return "A-";
        if (score >= 80) return "B+";
        if (score >= 75) return "B";
        if (score >= 70) return "B-";
        if (score >= 65) return "C+";
        if (score >= 60) return "C";
        if (score >= 55) return "C-";
        if (score >= 50) return "D";
        return "F";
      };
      
      // Process data by date and restaurant
      type DailyGrade = {
        date: string;
        grade: number;
        gradeLabel: string;
        totalSales: number;
        salesVariance: number;
        avgSpeed?: number;
        staffingDiff: number;
        osatPercent?: number;
        osatResponses?: number;
        avgXp?: number; // Average experience score for the day (0-100)
      };
      
      type RestaurantHistory = {
        restaurantId: string;
        restaurantName: string;
        state: string;
        marketId?: string;
        marketName?: string;
        dailyGrades: DailyGrade[];
        avgGrade: number;
        avgGradeLabel: string;
        totalSales: number;
        avgSalesVariance: number;
        avgSpeed?: number;
        avgStaffingDiff: number;
        avgOsat?: number;
        totalOsatResponses: number;
        avgXp?: number; // Average experience score across all days (0-100)
        gradeImprovement: number; // Trend: positive = improving
      };
      
      const historyByRestaurant = new Map<string, RestaurantHistory>();
      
      // Tennessee stores identification
      const TENNESSEE_STORES = [
        "1680 - Powell", "1681 - Turkey Creek", "1682 - Cumberland Avenue",
        "1679 - East Ridge", "1605 - Shallowford Village", "1729 - Sevierville"
      ];
      
      const getState = (name: string): string => {
        return TENNESSEE_STORES.some(store => name.includes(store.split(" - ")[1])) ? "Tennessee" : "Alabama";
      };
      
      // Process each date
      for (const dateStr of dateRange) {
        // Filter hourly sales by salesDate (timestamp) - extract date portion
        const salesForDate = allHourlySales.filter(s => {
          const salesDateStr = s.salesDate.toISOString().split('T')[0];
          return salesDateStr === dateStr;
        });
        const laborForDate = allHourlyLabor.filter(l => l.date.startsWith(dateStr));
        const osatForDate = allOsatData.filter(o => o.date === dateStr);
        const hmeForDate = allHmeData.filter(h => h.date === dateStr);
        const crewForDate = allCrewData.filter(c => c.date === dateStr);
        
        // Group by restaurant
        const salesByRestaurant = new Map<string, typeof salesForDate>();
        salesForDate.forEach(s => {
          const key = s.restaurantId;
          if (!salesByRestaurant.has(key)) salesByRestaurant.set(key, []);
          salesByRestaurant.get(key)!.push(s);
        });
        
        // Process each restaurant
        for (const restaurant of restaurantList) {
          const restaurantSales = salesByRestaurant.get(restaurant.id) || [];
          const restaurantLabor = laborForDate.filter(l => l.restaurantId === restaurant.id);
          const restaurantOsat = osatForDate.find(o => o.restaurantId === restaurant.id);
          const restaurantHme = hmeForDate.filter(h => h.restaurantId === restaurant.id);
          const restaurantCrew = crewForDate.filter(c => c.restaurantId === restaurant.id);
          
          // Skip if no sales data for this date
          if (restaurantSales.length === 0) continue;
          
          // Calculate daily totals using actualSales and pastActualSales
          const totalSales = restaurantSales.reduce((sum, s) => sum + parseFloat(s.actualSales || "0"), 0);
          const lastWeekSales = restaurantSales.reduce((sum, s) => sum + parseFloat(s.pastActualSales || "0"), 0);
          // Handle missing comparison data - if no last week sales, mark as no comparison available
          const hasComparableSales = lastWeekSales > 0;
          const salesVariance = hasComparableSales ? ((totalSales - lastWeekSales) / lastWeekSales) * 100 : 0;
          
          // Calculate average speed from HME timer data (weighted by car count)
          let avgSpeed: number | undefined;
          const hmeWithCars = restaurantHme.filter(h => h.carCount > 0 && h.avgTotalTime > 0);
          if (hmeWithCars.length > 0) {
            const totalCars = hmeWithCars.reduce((sum, h) => sum + h.carCount, 0);
            const weightedTime = hmeWithCars.reduce((sum, h) => sum + (h.avgTotalTime * h.carCount), 0);
            avgSpeed = totalCars > 0 ? weightedTime / totalCars : undefined;
          }
          
          // Calculate staffing diff using labor cost variance as a proxy
          // NOTE: Server-side uses labor cost ratio instead of headcount-based labor model
          // that the client uses in getStaffingBreakdown(). This provides reasonable approximation
          // for historical grade calculations where we don't have the full hourly sales-to-headcount mapping.
          let staffingDiff = 0;
          let hasValidStaffing = false;
          const validLabor = restaurantLabor.filter(l => {
            const actual = parseFloat(l.actualLabor || "0");
            const projected = parseFloat(l.projectedLabor || "0");
            return actual > 0 && projected > 0;
          });
          if (validLabor.length > 0) {
            hasValidStaffing = true;
            // Calculate average labor variance as a proxy for staffing diff
            // Positive = overstaffed, negative = understaffed
            const laborVariances = validLabor.map(l => {
              const actual = parseFloat(l.actualLabor || "0");
              const projected = parseFloat(l.projectedLabor || "0");
              return (actual - projected) / projected;
            });
            const avgLaborVariance = laborVariances.reduce((sum, v) => sum + v, 0) / laborVariances.length;
            // Convert to roughly equivalent staffing diff scale (-3 to +3)
            staffingDiff = avgLaborVariance * 10;
          }
          
          // Get OSAT data - osatPercent is a string that needs conversion
          const osatPercent = restaurantOsat?.osatPercent ? parseFloat(restaurantOsat.osatPercent) : undefined;
          const osatResponses = restaurantOsat?.totalResponses ?? 0;
          
          // Calculate average experience score (XP) from crew data
          let avgXp: number | undefined;
          const crewWithXp = restaurantCrew.filter(c => c.experienceScore !== null && c.experienceScore !== undefined && c.experienceScore > 0);
          if (crewWithXp.length > 0) {
            const totalXp = crewWithXp.reduce((sum, c) => sum + (c.experienceScore || 0), 0);
            avgXp = totalXp / crewWithXp.length;
          }
          
          // Determine if this is a first-week unit (opened within the past 7 days from the date being graded)
          const gradeDate = new Date(dateStr);
          const openDate = restaurant.openDate ? new Date(restaurant.openDate) : null;
          const isFirstWeek = openDate ? 
            (gradeDate.getTime() - openDate.getTime()) <= 7 * 24 * 60 * 60 * 1000 : false;
          
          // Calculate grade using aligned logic with hasComparableSales, hasValidStaffing, and isFirstWeek
          const gradeResult = calculateGrade(
            salesVariance, 
            avgSpeed, 
            staffingDiff, 
            hasComparableSales, 
            hasValidStaffing, 
            osatPercent,
            isFirstWeek
          );
          const grade = gradeResult.grade;
          const gradeLabel = gradeResult.gradeLabel;
          
          // Initialize or update restaurant history
          if (!historyByRestaurant.has(restaurant.id)) {
            const market = restaurantToMarket.get(restaurant.id);
            historyByRestaurant.set(restaurant.id, {
              restaurantId: restaurant.id,
              restaurantName: restaurant.name,
              state: getState(restaurant.name),
              marketId: market?.id,
              marketName: market?.name,
              dailyGrades: [],
              avgGrade: 0,
              avgGradeLabel: "",
              totalSales: 0,
              avgSalesVariance: 0,
              avgSpeed: undefined,
              avgStaffingDiff: 0,
              avgOsat: undefined,
              totalOsatResponses: 0,
              avgXp: undefined,
              gradeImprovement: 0,
            });
          }
          
          historyByRestaurant.get(restaurant.id)!.dailyGrades.push({
            date: dateStr,
            grade,
            gradeLabel,
            totalSales,
            salesVariance,
            avgSpeed,
            staffingDiff,
            osatPercent,
            osatResponses,
            avgXp,
          });
        }
      }
      
      // Calculate aggregates for each restaurant
      const restaurantHistories: RestaurantHistory[] = [];
      
      historyByRestaurant.forEach(history => {
        const grades = history.dailyGrades;
        if (grades.length === 0) return;
        
        // Sort by date
        grades.sort((a, b) => a.date.localeCompare(b.date));
        
        // Calculate averages
        history.avgGrade = grades.reduce((sum, g) => sum + g.grade, 0) / grades.length;
        history.avgGradeLabel = getGradeLabel(history.avgGrade);
        history.totalSales = grades.reduce((sum, g) => sum + g.totalSales, 0);
        history.avgSalesVariance = grades.reduce((sum, g) => sum + g.salesVariance, 0) / grades.length;
        history.avgStaffingDiff = grades.reduce((sum, g) => sum + g.staffingDiff, 0) / grades.length;
        history.totalOsatResponses = grades.reduce((sum, g) => sum + (g.osatResponses || 0), 0);
        
        // Calculate average OSAT (weighted by responses)
        const osatGrades = grades.filter(g => g.osatPercent !== undefined && g.osatResponses && g.osatResponses > 0);
        if (osatGrades.length > 0) {
          const totalResponses = osatGrades.reduce((sum, g) => sum + (g.osatResponses || 0), 0);
          const weightedOsat = osatGrades.reduce((sum, g) => sum + (g.osatPercent! * (g.osatResponses || 0)), 0);
          history.avgOsat = totalResponses > 0 ? weightedOsat / totalResponses : undefined;
        }
        
        // Calculate average speed
        const speedGrades = grades.filter(g => g.avgSpeed !== undefined);
        if (speedGrades.length > 0) {
          history.avgSpeed = speedGrades.reduce((sum, g) => sum + g.avgSpeed!, 0) / speedGrades.length;
        }
        
        // Calculate average XP (experience score)
        const xpGrades = grades.filter(g => g.avgXp !== undefined);
        if (xpGrades.length > 0) {
          history.avgXp = xpGrades.reduce((sum, g) => sum + g.avgXp!, 0) / xpGrades.length;
        }
        
        // Calculate grade improvement (last half vs first half)
        if (grades.length >= 2) {
          const midpoint = Math.floor(grades.length / 2);
          const firstHalf = grades.slice(0, midpoint);
          const secondHalf = grades.slice(midpoint);
          const firstAvg = firstHalf.reduce((sum, g) => sum + g.grade, 0) / firstHalf.length;
          const secondAvg = secondHalf.reduce((sum, g) => sum + g.grade, 0) / secondHalf.length;
          history.gradeImprovement = secondAvg - firstAvg;
        }
        
        restaurantHistories.push(history);
      });
      
      // Sort by average grade descending
      restaurantHistories.sort((a, b) => b.avgGrade - a.avgGrade);
      
      // Calculate state summaries
      const stateMap = new Map<string, RestaurantHistory[]>();
      restaurantHistories.forEach(r => {
        if (!stateMap.has(r.state)) stateMap.set(r.state, []);
        stateMap.get(r.state)!.push(r);
      });
      
      const stateSummaries = Array.from(stateMap.entries()).map(([state, restaurants]) => {
        const avgGrade = restaurants.reduce((sum, r) => sum + r.avgGrade, 0) / restaurants.length;
        const totalSales = restaurants.reduce((sum, r) => sum + r.totalSales, 0);
        const avgSalesVariance = restaurants.reduce((sum, r) => sum + r.avgSalesVariance, 0) / restaurants.length;
        const osatRestaurants = restaurants.filter(r => r.avgOsat !== undefined);
        const avgOsat = osatRestaurants.length > 0 
          ? osatRestaurants.reduce((sum, r) => sum + r.avgOsat!, 0) / osatRestaurants.length 
          : undefined;
        const avgImprovement = restaurants.reduce((sum, r) => sum + r.gradeImprovement, 0) / restaurants.length;
        
        return {
          state,
          restaurantCount: restaurants.length,
          avgGrade,
          avgGradeLabel: getGradeLabel(avgGrade),
          totalSales,
          avgSalesVariance,
          avgOsat,
          avgImprovement,
        };
      });
      
      // Calculate market summaries
      const marketMap = new Map<string, RestaurantHistory[]>();
      restaurantHistories.forEach(r => {
        if (r.marketName) {
          if (!marketMap.has(r.marketName)) marketMap.set(r.marketName, []);
          marketMap.get(r.marketName)!.push(r);
        }
      });
      
      const marketSummaries = Array.from(marketMap.entries()).map(([market, restaurants]) => {
        const avgGrade = restaurants.reduce((sum, r) => sum + r.avgGrade, 0) / restaurants.length;
        const totalSales = restaurants.reduce((sum, r) => sum + r.totalSales, 0);
        const avgSalesVariance = restaurants.reduce((sum, r) => sum + r.avgSalesVariance, 0) / restaurants.length;
        const osatRestaurants = restaurants.filter(r => r.avgOsat !== undefined);
        const avgOsat = osatRestaurants.length > 0 
          ? osatRestaurants.reduce((sum, r) => sum + r.avgOsat!, 0) / osatRestaurants.length 
          : undefined;
        const avgImprovement = restaurants.reduce((sum, r) => sum + r.gradeImprovement, 0) / restaurants.length;
        
        return {
          market,
          restaurantCount: restaurants.length,
          avgGrade,
          avgGradeLabel: getGradeLabel(avgGrade),
          totalSales,
          avgSalesVariance,
          avgOsat,
          avgImprovement,
        };
      });
      
      // Overall company summary
      const companySummary = {
        restaurantCount: restaurantHistories.length,
        avgGrade: restaurantHistories.length > 0 
          ? restaurantHistories.reduce((sum, r) => sum + r.avgGrade, 0) / restaurantHistories.length 
          : 0,
        avgGradeLabel: getGradeLabel(
          restaurantHistories.length > 0 
            ? restaurantHistories.reduce((sum, r) => sum + r.avgGrade, 0) / restaurantHistories.length 
            : 0
        ),
        totalSales: restaurantHistories.reduce((sum, r) => sum + r.totalSales, 0),
        avgSalesVariance: restaurantHistories.length > 0 
          ? restaurantHistories.reduce((sum, r) => sum + r.avgSalesVariance, 0) / restaurantHistories.length 
          : 0,
        avgOsat: (() => {
          const osatRestaurants = restaurantHistories.filter(r => r.avgOsat !== undefined);
          return osatRestaurants.length > 0 
            ? osatRestaurants.reduce((sum, r) => sum + r.avgOsat!, 0) / osatRestaurants.length 
            : undefined;
        })(),
        avgImprovement: restaurantHistories.length > 0 
          ? restaurantHistories.reduce((sum, r) => sum + r.gradeImprovement, 0) / restaurantHistories.length 
          : 0,
      };
      
      res.json({
        dateRange,
        restaurants: restaurantHistories,
        stateSummaries,
        marketSummaries,
        companySummary,
      });
    } catch (error) {
      console.error("Error fetching performance history:", error);
      res.status(500).json({ error: "Failed to fetch performance history" });
    }
  });

  // Version/diagnostics endpoint to verify production deployment
  app.get("/api/version", (req, res) => {
    res.json({
      version: "2.1.0",
      buildTime: new Date().toISOString(),
      features: {
        leaderNames: true,
        experienceScores: true,
        hmeTimers: true,
        googleReviews: true,
      },
      deployedAt: process.env.REPLIT_DEPLOYMENT_ID || "development",
    });
  });

  return httpServer;
}
