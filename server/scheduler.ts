import { fetchSalesFromAPI, fetchHourlySalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales } from "./scraper/7shifts-api";
import { db } from "./db";
import { dailySales, hourlySales } from "@shared/schema";
import { sql } from "drizzle-orm";

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
        log("Fetching historical daily sales (8 days)...");
        await fetchHistoricalSales(8);
        log("Historical daily sales loaded");
        
        log("Fetching historical hourly sales (8 days)...");
        await fetchHistoricalHourlySales(8);
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
  
  runScheduledSync();
}
