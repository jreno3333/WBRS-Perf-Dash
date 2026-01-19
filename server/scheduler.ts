import { fetchSalesFromAPI, fetchHourlySalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales } from "./scraper/7shifts-api";
import { db } from "./db";
import { dailySales, hourlySales } from "@shared/schema";
import { sql, lt } from "drizzle-orm";

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
  
  log("Starting scheduled 7shifts sync...");
  
  try {
    const dailyResult = await fetchSalesFromAPI();
    if (dailyResult.success) {
      log(`Daily sync completed: ${dailyResult.recordsScraped} records updated`);
    } else {
      log(`Daily sync failed: ${dailyResult.error}`);
    }
    
    const hourlyResult = await fetchHourlySalesFromAPI();
    if (hourlyResult.success) {
      log(`Hourly sync completed: ${hourlyResult.recordsScraped} hourly records updated`);
    } else {
      log(`Hourly sync failed: ${hourlyResult.error}`);
    }
  } catch (error) {
    log(`Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function checkAndSeedHistoricalData() {
  try {
    // Get date from 7 days ago to check for historical data
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(23, 59, 59, 999); // End of that day
    
    // Check if we have historical daily data (from 7+ days ago)
    const dailyHistoricalResult = await db.select({ count: sql<number>`count(*)` })
      .from(dailySales)
      .where(lt(dailySales.salesDate, sevenDaysAgo));
    const dailyHistoricalCount = Number(dailyHistoricalResult[0]?.count || 0);
    
    // Check if we have historical hourly data (from 7+ days ago)
    const hourlyHistoricalResult = await db.select({ count: sql<number>`count(*)` })
      .from(hourlySales)
      .where(lt(hourlySales.salesDate, sevenDaysAgo));
    const hourlyHistoricalCount = Number(hourlyHistoricalResult[0]?.count || 0);
    
    const needsDailySeeding = dailyHistoricalCount === 0;
    const needsHourlySeeding = hourlyHistoricalCount === 0;
    
    log(`Database check: ${dailyHistoricalCount} historical daily, ${hourlyHistoricalCount} historical hourly records (before ${sevenDaysAgo.toISOString().split('T')[0]})`);
    
    if (needsDailySeeding || needsHourlySeeding) {
      // Pause scheduler during historical sync
      pauseScheduler();
      
      try {
        if (needsDailySeeding) {
          log("Fetching historical daily sales (8 days)...");
          await fetchHistoricalSales(8);
          log("Historical daily sales loaded");
        }
        
        if (needsHourlySeeding) {
          log("Fetching historical hourly sales (8 days)...");
          await fetchHistoricalHourlySales(8);
          log("Historical hourly sales loaded");
        }
        
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
  
  runScheduledSync();
}
