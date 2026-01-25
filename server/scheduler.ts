import { fetchSalesFromAPI, fetchHourlySalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, syncSalesWithXenialPOS } from "./scraper/7shifts-api";
import { syncHMETimerData } from "./scraper/hme-api";
import { syncAllGoogleReviews, markEndOfDaySnapshots } from "./google-places";
import { db } from "./db";
import { dailySales, hourlySales, restaurants } from "@shared/schema";
import { sql, isNotNull } from "drizzle-orm";
import { storage } from "./storage";

// Set to true to pause scheduled syncs (for historical data loading)
let schedulerPaused = false; // Historical data loaded - scheduler active

function log(message: string) {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [scheduler] ${message}`);
}

export function pauseScheduler() {
  schedulerPaused = true;
  log("Scheduler PAUSED - historical sync can run uninterrupted");
}

export function resumeScheduler() {
  schedulerPaused = false;
  log("Scheduler RESUMED - regular syncs will continue");
}

export function isSchedulerPaused(): boolean {
  return schedulerPaused;
}

function getNextSyncTime(): Date {
  const now = new Date();
  const currentMinute = now.getMinutes();
  
  // Sync every 5 minutes as displayed in the UI footer
  const syncMinutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  
  let nextMinute = syncMinutes.find(m => m > currentMinute);
  
  const nextSync = new Date(now);
  nextSync.setSeconds(0);
  nextSync.setMilliseconds(0);
  
  if (nextMinute !== undefined) {
    nextSync.setMinutes(nextMinute);
  } else {
    nextSync.setHours(nextSync.getHours() + 1);
    nextSync.setMinutes(syncMinutes[0]);
  }
  
  return nextSync;
}

function scheduleNextSync() {
  const nextSync = getNextSyncTime();
  const now = new Date();
  const delay = nextSync.getTime() - now.getTime();
  
  log(`Next sync scheduled for ${nextSync.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })} (in ${Math.round(delay / 1000)} seconds)`);
  
  setTimeout(async () => {
    await runScheduledSync();
    scheduleNextSync();
  }, delay);
}

async function runScheduledSync() {
  if (schedulerPaused) {
    log("Scheduler is PAUSED - skipping sync (historical data loading)");
    return;
  }
  
  log("Starting scheduled sales sync (Xenial POS + 7shifts labor)...");
  
  try {
    // First, run the 7shifts daily/hourly sync to get data for all restaurants
    // This provides the baseline data from 7shifts
    const dailyResult = await fetchSalesFromAPI();
    if (dailyResult.success) {
      log(`Daily sync completed: ${dailyResult.recordsScraped} records updated`);
    }
    const hourlyResult = await fetchHourlySalesFromAPI();
    if (hourlyResult.success) {
      log(`Hourly sync completed: ${hourlyResult.recordsScraped} hourly records updated`);
    }
    
    // Then, overlay with Xenial POS data for restaurants that have it
    // This provides real-time sales updates for POS-connected restaurants
    const hybridResult = await syncSalesWithXenialPOS();
    if (hybridResult.success && hybridResult.recordsScraped > 0) {
      log(`Xenial POS overlay: ${hybridResult.recordsScraped} records updated with real-time sales`);
    } else if (!hybridResult.success) {
      log(`Xenial POS overlay skipped: ${hybridResult.error}`);
    }
    
    // Sync HME drive-thru timer data
    try {
      const hmeResult = await syncHMETimerData();
      log(`HME sync completed: ${hmeResult.saved} timer records updated`);
    } catch (hmeError) {
      log(`HME sync failed: ${hmeError instanceof Error ? hmeError.message : 'Unknown error'}`);
    }
    
    // Sync Google reviews (once per hour at the top of the hour)
    await syncGoogleReviewsIfNeeded();
    
    // Save end-of-day weather snapshot (at 11 PM Central)
    await saveEndOfDayWeatherIfNeeded();
    
    // Check if we should also sync yesterday's data (after midnight Central to capture hours 22-23)
    await syncYesterdayIfNeeded();
  } catch (error) {
    log(`Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Track last yesterday resync to avoid doing it too frequently
let lastYesterdaySync: string | null = null;
let lastWeatherSave: string | null = null;

// Fetch weather for a location (helper function)
async function fetchWeatherForLocation(latitude: number, longitude: number): Promise<{ temp: number; condition: string; humidity: number; windSpeed: number } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const weatherRes = await fetch(weatherUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const current = weatherData.current;
      const weatherCode = current.weather_code;
      let condition = "clear";
      if (weatherCode >= 0 && weatherCode <= 1) condition = "clear";
      else if (weatherCode >= 2 && weatherCode <= 3) condition = "partly cloudy";
      else if (weatherCode >= 45 && weatherCode <= 48) condition = "foggy";
      else if (weatherCode >= 51 && weatherCode <= 57) condition = "showers";
      else if (weatherCode >= 61 && weatherCode <= 67) condition = "rain";
      else if (weatherCode >= 71 && weatherCode <= 77) condition = "snow";
      else if (weatherCode >= 80 && weatherCode <= 82) condition = "showers";
      else if (weatherCode >= 85 && weatherCode <= 86) condition = "snow";
      else if (weatherCode >= 95 && weatherCode <= 99) condition = "thunderstorm";
      
      return {
        temp: current.temperature_2m,
        condition,
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m,
      };
    }
  } catch (e) {
    // Silently handle timeout/network errors
  }
  return null;
}

// Save daily weather snapshot for all restaurants
async function saveDailyWeatherSnapshot(date: string): Promise<number> {
  const allRestaurants = await db.select().from(restaurants).where(isNotNull(restaurants.latitude));
  let saved = 0;
  
  for (const restaurant of allRestaurants) {
    if (restaurant.latitude && restaurant.longitude) {
      const weather = await fetchWeatherForLocation(
        parseFloat(String(restaurant.latitude)),
        parseFloat(String(restaurant.longitude))
      );
      
      if (weather) {
        await storage.saveDailyWeather({
          restaurantId: restaurant.id,
          date,
          highTemp: String(weather.temp),
          lowTemp: String(weather.temp),
          avgTemp: String(weather.temp),
          condition: weather.condition,
          humidity: weather.humidity,
          windSpeed: String(weather.windSpeed),
        });
        saved++;
      }
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  return saved;
}

// Track last Google reviews sync to avoid syncing too frequently
let lastGoogleReviewsSync: string | null = null;

// Sync Google reviews once per hour
async function syncGoogleReviewsIfNeeded() {
  const now = new Date();
  const centralHour = parseInt(new Intl.DateTimeFormat('en-US', { 
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false
  }).format(now));
  
  const currentMinute = now.getMinutes();
  
  // Sync within the first 5 minutes of each hour (scheduler runs every 5 minutes)
  if (currentMinute > 4) {
    return;
  }
  
  const syncKey = `${now.toISOString().split('T')[0]}-${centralHour}`;
  
  // Don't sync more than once per hour
  if (lastGoogleReviewsSync === syncKey) {
    return;
  }
  
  log("Syncing Google reviews...");
  try {
    const result = await syncAllGoogleReviews();
    log(`Google reviews sync completed: ${result.success} success, ${result.failed} failed`);
    lastGoogleReviewsSync = syncKey;
    
    // Mark end-of-day snapshots at 11 PM Central
    if (centralHour === 23) {
      await markEndOfDaySnapshots();
      log("Google reviews end-of-day snapshots marked");
    }
  } catch (error) {
    log(`Google reviews sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Save weather at end of day (11 PM Central)
async function saveEndOfDayWeatherIfNeeded() {
  const centralHour = parseInt(new Intl.DateTimeFormat('en-US', { 
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false
  }).format(new Date()));
  
  const todayCentral = new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  
  // Save weather at 11 PM Central, once per day
  if (centralHour === 23 && lastWeatherSave !== todayCentral) {
    log("Saving end-of-day weather snapshot...");
    try {
      const saved = await saveDailyWeatherSnapshot(todayCentral);
      log(`Weather snapshot saved: ${saved} restaurants`);
      lastWeatherSave = todayCentral;
    } catch (error) {
      log(`Weather save error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

async function syncYesterdayIfNeeded() {
  // Get current hour in Central timezone
  const centralHour = parseInt(new Intl.DateTimeFormat('en-US', { 
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false
  }).format(new Date()));
  
  // Get today's date in Central timezone
  const todayCentral = new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  
  // Only sync yesterday between 12 AM and 6 AM Central, and only once per day
  if (centralHour >= 0 && centralHour < 6 && lastYesterdaySync !== todayCentral) {
    log("Running post-midnight yesterday resync to capture late hours...");
    
    try {
      // Calculate yesterday's date in Central timezone
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(yesterday);
      
      // Create a date object for yesterday at noon UTC
      const yesterdayDate = new Date(yesterdayStr + 'T12:00:00.000Z');
      
      // Resync yesterday's hourly data
      const result = await fetchHourlySalesFromAPI(yesterdayDate);
      if (result.success) {
        log(`Yesterday resync completed: ${result.recordsScraped} hourly records for ${yesterdayStr}`);
      }
      
      lastYesterdaySync = todayCentral;
    } catch (error) {
      log(`Yesterday resync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

async function checkAndSeedHistoricalData() {
  try {
    // Check if we have data for exactly 7 days ago (critical for week-over-week comparisons)
    // Use UTC date string to match how getLeaderboard compares dates
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const lastWeekDateStr = sevenDaysAgo.toISOString().split('T')[0]; // YYYY-MM-DD in UTC
    
    // Query hourly sales and filter by date string (matching getLeaderboard logic)
    const allHourlySales = await db.select().from(hourlySales);
    const lastWeekRecords = allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekDateStr;
    });
    const lastWeekHourlyCount = lastWeekRecords.length;
    
    // We need at least some data for 7 days ago (22 restaurants × ~17 hours = ~374 rows expected)
    const expectedLastWeekMin = 300;
    const needsHourlySeeding = lastWeekHourlyCount < expectedLastWeekMin;
    
    log(`Database check: ${lastWeekHourlyCount} hourly records for ${lastWeekDateStr} (need ${expectedLastWeekMin}+ for week-over-week)`);
    
    if (needsHourlySeeding) {
      // Pause scheduler during historical sync
      pauseScheduler();
      
      try {
        log("Fetching historical daily sales (9 days)...");
        await fetchHistoricalSales(9);
        log("Historical daily sales loaded");
        
        log("Fetching historical hourly sales (9 days)...");
        await fetchHistoricalHourlySales(9);
        log("Historical hourly sales loaded");
        
        log("Historical data seeding complete!");
      } catch (seedError) {
        log(`Historical data seeding error: ${seedError instanceof Error ? seedError.message : 'Unknown error'}`);
      } finally {
        resumeScheduler();
      }
    } else {
      log("Historical data already present - skipping seed");
    }
  } catch (error) {
    log(`Error checking database: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function startScheduler() {
  log("Sales sync scheduler started - syncing every 5 minutes");
  
  // Check if database needs historical data seeding
  await checkAndSeedHistoricalData();
  
  scheduleNextSync();
  
  // Run initial sync immediately and wait for it to complete
  // This ensures data (including HME) is available when the app starts
  await runScheduledSync();
}
