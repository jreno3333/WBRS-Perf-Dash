import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchSalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, fetchHourlySalesFromAPI, syncLocationsFromAPI } from "./scraper/7shifts-api";
import { db } from "./db";
import { scraperRuns, posOrders, hourlySales, restaurants } from "@shared/schema";
import { desc, sql, gte, lt, and, eq } from "drizzle-orm";
import { processXenialOrder, validateWebhookToken, seedLocationMappings, getPosOrdersSummary } from "./xenial-webhook";
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
  // Get leaderboard data
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
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
      
      res.json({
        ...leaderboard,
        restaurants: restaurantsWithWeather,
      });
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard data" });
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
      const targetDate = date ? new Date(date as string) : new Date();
      
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
      const { openDate, laborTarget, isActive, revenuePorts } = req.body;
      
      const updates: Record<string, any> = {};
      if (openDate !== undefined) {
        // Parse date at noon UTC to avoid timezone boundary issues
        updates.openDate = openDate ? new Date(`${openDate}T12:00:00Z`) : null;
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
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }
      
      await db.update(restaurants).set(updates).where(eq(restaurants.id, id));
      
      const updatedRestaurant = await db.select().from(restaurants).where(eq(restaurants.id, id));
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
      const { days = 7 } = req.body;
      
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
      const { days = 8 } = req.body;
      
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

  // Receive order from Xenial POS (webhook endpoint)
  app.post("/api/xenial/order", async (req, res) => {
    try {
      const authHeader = req.headers.authorization as string | undefined;
      
      if (!validateWebhookToken(authHeader)) {
        console.warn("Xenial webhook: Invalid or missing auth token");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const payload = req.body;
      
      if (!payload || !payload.data) {
        res.status(400).json({ error: "Invalid payload" });
        return;
      }

      const result = await processXenialOrder(payload);
      
      if (result.success) {
        res.json({ success: true, orderId: result.orderId });
      } else {
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

  // POS webhook status
  app.get("/api/pos/status", async (req, res) => {
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayOrders = await db
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

      const lastOrder = await db
        .select()
        .from(posOrders)
        .orderBy(desc(posOrders.receivedAt))
        .limit(1);

      res.json({
        webhookEnabled: !!process.env.MWBURGER_POS_TOKEN,
        todayOrderCount: todayOrders[0]?.count || 0,
        todaySalesTotal: Number(todayOrders[0]?.total) || 0,
        lastOrderReceived: lastOrder[0]?.receivedAt || null,
        lastOrderStore: lastOrder[0]?.storeNumber || null,
      });
    } catch (error) {
      console.error("Error fetching POS status:", error);
      res.status(500).json({ error: "Failed to fetch POS status" });
    }
  });

  // ===== HME DRIVE-THRU TIMER ENDPOINTS =====

  // Sync HME timer data
  app.post("/api/hme/sync", async (req, res) => {
    try {
      const { date } = req.body || {};
      const targetDate = date ? new Date(date) : undefined;

      res.json({ message: "HME sync started", status: "running" });

      const { syncHMETimerData } = await import("./scraper/hme-api");
      syncHMETimerData(targetDate).then(result => {
        console.log("[HME] Sync completed:", result);
      }).catch(err => {
        console.error("[HME] Sync error:", err);
      });
    } catch (error) {
      console.error("Error starting HME sync:", error);
      res.status(500).json({ error: "Failed to start HME sync" });
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

  return httpServer;
}
