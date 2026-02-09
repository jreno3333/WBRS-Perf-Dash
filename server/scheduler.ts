import { fetchSalesFromAPI, fetchHourlySalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, syncSalesWithXenialPOS } from "./scraper/7shifts-api";
import { syncHMETimerData } from "./scraper/hme-api";
import { syncAllGoogleReviews, markEndOfDaySnapshots } from "./google-places";
import { syncOsatData } from "./scraper/qualtrics-api";
import { sendDailyReports } from "./daily-report";
import { sendLeaderReports } from "./leader-report";
import { db } from "./db";
import { dailySales, hourlySales, restaurants, hourlyLabor, hmeTimerData, dailyOsat, hourlyCrew, posOrders, osatData, dailyGoogleReviews, reportSchedules, emailSendLog } from "@shared/schema";
import { sql, isNotNull, lt, eq, and, like } from "drizzle-orm";
import { storage } from "./storage";
import { getCentralTime } from "./utils/dates";
import { fetchWeather } from "./utils/weather";

// Data retention period: 2 years (730 days)
const DATA_RETENTION_DAYS = 730;

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

// Data retention cleanup - removes data older than 2 years
async function cleanupOldData() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DATA_RETENTION_DAYS);
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
  const cutoffTimestamp = cutoffDate;
  
  log(`Starting data retention cleanup (removing data older than ${cutoffDateStr})...`);
  
  try {
    // Clean up hourly_sales (uses timestamp)
    const hourlyResult = await db.delete(hourlySales)
      .where(lt(hourlySales.salesDate, cutoffTimestamp));
    
    // Clean up hourly_labor (uses date string)
    await db.delete(hourlyLabor)
      .where(lt(hourlyLabor.date, cutoffDateStr));
    
    // Clean up daily_sales
    await db.delete(dailySales)
      .where(lt(dailySales.salesDate, cutoffTimestamp));
    
    // Clean up HME timer data
    await db.delete(hmeTimerData)
      .where(lt(hmeTimerData.date, cutoffDateStr));
    
    // Clean up OSAT data
    await db.delete(dailyOsat)
      .where(lt(dailyOsat.date, cutoffDateStr));
    await db.delete(osatData)
      .where(lt(osatData.date, cutoffDateStr));
    
    // Clean up hourly crew data
    await db.delete(hourlyCrew)
      .where(lt(hourlyCrew.date, cutoffDateStr));
    
    // Clean up POS orders (uses timestamp)
    await db.delete(posOrders)
      .where(lt(posOrders.businessDate, cutoffTimestamp));
    
    // Clean up Google reviews (uses date string)
    await db.delete(dailyGoogleReviews)
      .where(lt(dailyGoogleReviews.date, cutoffDateStr));
    
    log(`Data retention cleanup completed - removed data older than ${cutoffDateStr}`);
  } catch (error) {
    log(`Data retention cleanup error: ${error}`);
  }
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
    
    // Sync crew experience data (once per hour at the top of the hour)
    await syncCrewExperienceIfNeeded();
    
    // Sync Google reviews (once per hour at the top of the hour)
    await syncGoogleReviewsIfNeeded();
    
    // Sync Qualtrics OSAT data (every 5 minutes)
    await syncOsatIfNeeded();
    
    // Save end-of-day weather snapshot (at 11 PM Central)
    await saveEndOfDayWeatherIfNeeded();
    
    // Check if we should also sync yesterday's data (after midnight Central to capture hours 22-23)
    await syncYesterdayIfNeeded();
    
    // Send daily email reports (at 6 AM Central)
    await sendDailyReportsIfNeeded();

    // Arena evaluation hooks
    await runArenaHourlyIfNeeded();
    await runArenaEndOfDayIfNeeded();
  } catch (error) {
    log(`Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Track last yesterday resync to avoid doing it too frequently
let lastYesterdaySync: string | null = null;
let lastWeatherSave: string | null = null;
let lastDailyReportSend: string | null = null;
let lastLeaderReportSend: string | null = null;

// Arena evaluation tracking
let lastArenaHourlyEval: string | null = null;
let lastArenaDailyEval: string | null = null;

// Run hourly arena badge evaluation (top of each hour)
async function runArenaHourlyIfNeeded() {
  const now = new Date();
  const currentMinute = now.getMinutes();
  if (currentMinute > 4) return; // Only in first 5 minutes of each hour

  const { hour: centralHour, date: centralDate } = getCentralTime(now);
  const evalKey = `${centralDate}-${centralHour}`;
  if (lastArenaHourlyEval === evalKey) return;

  // Evaluate the PREVIOUS hour (the one that just completed)
  const prevHour = centralHour === 0 ? 23 : centralHour - 1;
  const evalDate = centralHour === 0
    ? (() => { const d = new Date(now); d.setDate(d.getDate() - 1); return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d); })()
    : centralDate;

  log(`Running Arena hourly evaluation for ${evalDate} hour ${prevHour}...`);
  try {
    const { evaluateHourlyBadges } = await import("./arena-engine");
    const result = await evaluateHourlyBadges(evalDate, prevHour);
    lastArenaHourlyEval = evalKey;
    log(`Arena hourly eval completed: ${result.awarded} badges awarded for ${evalDate} hour ${prevHour}`);
  } catch (error) {
    log(`Arena hourly eval error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Run end-of-day arena evaluation at 2 AM Central (evaluates yesterday's data)
// 2 AM ensures all 24-hour data is finalized (incl. Eastern timezone units closing at midnight ET = 11 PM CT)
async function runArenaEndOfDayIfNeeded() {
  const { hour: centralHour, date: centralDate } = getCentralTime();
  if (centralHour !== 2) return;

  // Calculate yesterday's date in Central timezone
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(yesterday);

  if (lastArenaDailyEval === yesterdayStr) return;

  log(`Running Arena end-of-day evaluation for ${yesterdayStr}...`);
  try {
    const { evaluateEndOfDayBadges, evaluateStreaks, evaluateRecords } = await import("./arena-engine");
    const badgeResult = await evaluateEndOfDayBadges(yesterdayStr);
    log(`Arena EOD badges: ${badgeResult.awarded} awarded`);

    const streakResult = await evaluateStreaks(yesterdayStr);
    log(`Arena streaks: ${streakResult.updated} updated`);

    const recordResult = await evaluateRecords(yesterdayStr);
    log(`Arena records: ${recordResult.newRecords} new records`);

    lastArenaDailyEval = yesterdayStr;
    log(`Arena end-of-day evaluation completed for ${yesterdayStr}`);
  } catch (error) {
    log(`Arena end-of-day eval error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// getCentralTime imported from ./utils/dates

function isPastScheduledTime(currentHour: number, currentMinute: number, targetHour: number, targetMinute: number): boolean {
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const targetTotalMinutes = targetHour * 60 + targetMinute;
  return currentTotalMinutes >= targetTotalMinutes;
}

async function hasReportBeenSentToday(reportPrefix: string, reportDate: string): Promise<boolean> {
  const reportKey = `${reportPrefix}-${reportDate}`;
  const existing = await db.select({ id: emailSendLog.id })
    .from(emailSendLog)
    .where(eq(emailSendLog.reportDate, reportKey))
    .limit(1);
  return existing.length > 0;
}

async function sendDailyReportsIfNeeded() {
  const now = new Date();
  const { hour: centralHour, minute: centralMinute, date: centralDate } = getCentralTime(now);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(yesterday);

  try {
    const schedules = await db.select().from(reportSchedules);
    
    const dailySchedule = schedules.find(s => s.reportType === 'daily_report');
    const leaderSchedule = schedules.find(s => s.reportType === 'leader_report');

    const dailyHour = dailySchedule?.sendHour ?? 6;
    const dailyMinute = dailySchedule?.sendMinute ?? 0;
    const dailyEnabled = dailySchedule?.isEnabled ?? true;

    const leaderHour = leaderSchedule?.sendHour ?? 6;
    const leaderMinute = leaderSchedule?.sendMinute ?? 0;
    const leaderEnabled = leaderSchedule?.isEnabled ?? true;

    const dailyPastTime = dailyEnabled && isPastScheduledTime(centralHour, centralMinute, dailyHour, dailyMinute);
    const leaderPastTime = leaderEnabled && isPastScheduledTime(centralHour, centralMinute, leaderHour, leaderMinute);
    
    if (centralMinute < 5) {
      log(`Report schedule check: CT ${centralHour}:${String(centralMinute).padStart(2, '0')} | Daily=${dailyEnabled ? `${dailyHour}:${String(dailyMinute).padStart(2, '0')}` : 'off'}(${dailyPastTime ? 'PAST TIME' : 'not yet'}) | Leader=${leaderEnabled ? `${leaderHour}:${String(leaderMinute).padStart(2, '0')}` : 'off'}(${leaderPastTime ? 'PAST TIME' : 'not yet'}) | lastSent: daily=${lastDailyReportSend}, leader=${lastLeaderReportSend}`);
    }

    if (dailyPastTime) {
      if (lastDailyReportSend !== centralDate) {
        const alreadySent = await hasReportBeenSentToday('daily', yesterdayDate);
        if (!alreadySent) {
          lastDailyReportSend = centralDate;
          log("Sending daily performance reports...");
          try {
            const result = await sendDailyReports();
            log(`Daily reports: ${result.sent} sent, ${result.failed} failed`);
          } catch (error) {
            log(`Daily report error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            lastDailyReportSend = null;
          }
        } else {
          lastDailyReportSend = centralDate;
          log("Daily reports already sent today (found in DB log) - skipping");
        }
      }
    }

    if (leaderPastTime) {
      if (lastLeaderReportSend !== centralDate) {
        const alreadySent = await hasReportBeenSentToday('leader', yesterdayDate);
        if (!alreadySent) {
          lastLeaderReportSend = centralDate;
          log("Sending leader ranking reports...");
          try {
            const leaderResult = await sendLeaderReports();
            log(`Leader reports: ${leaderResult.sent} sent, ${leaderResult.failed} failed`);
          } catch (error) {
            log(`Leader report error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            lastLeaderReportSend = null;
          }
        } else {
          lastLeaderReportSend = centralDate;
          log("Leader reports already sent today (found in DB log) - skipping");
        }
      }
    }
  } catch (error) {
    log(`Report schedule check error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// fetchWeather imported from ./utils/weather (unified weather code mapping)

// Save daily weather snapshot for all restaurants
async function saveDailyWeatherSnapshot(date: string): Promise<number> {
  const allRestaurants = await db.select().from(restaurants).where(isNotNull(restaurants.latitude));
  let saved = 0;
  
  for (const restaurant of allRestaurants) {
    if (restaurant.latitude && restaurant.longitude) {
      const weather = await fetchWeather(
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

// Track last crew experience sync to avoid syncing too frequently
let lastCrewSync: string | null = null;

// Sync crew experience data once per hour
async function syncCrewExperienceIfNeeded() {
  const now = new Date();
  const currentMinute = now.getMinutes();
  
  // Sync within the first 5 minutes of each hour (scheduler runs every 5 minutes)
  if (currentMinute > 4) {
    return;
  }
  
  const { hour: centralHour, date: centralDate } = getCentralTime(now);

  const syncKey = `${centralDate}-${centralHour}`;
  
  // Don't sync more than once per hour
  if (lastCrewSync === syncKey) {
    return;
  }
  
  log("Syncing crew experience data...");
  try {
    const { syncHourlyCrew } = await import("./scraper/7shifts-api");
    const result = await syncHourlyCrew();
    log(`Crew experience sync completed: ${result.count} hourly records updated`);
    lastCrewSync = syncKey;
  } catch (error) {
    log(`Crew experience sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Track last Google reviews sync to avoid syncing too frequently
let lastGoogleReviewsSync: string | null = null;

// Sync Google reviews once per hour
async function syncGoogleReviewsIfNeeded() {
  const now = new Date();
  const { hour: centralHour } = getCentralTime(now);

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

// Sync OSAT data every 5 minutes (same as sales/labor)
async function syncOsatIfNeeded() {
  log("Syncing Qualtrics OSAT data...");
  try {
    const result = await syncOsatData(3); // Sync last 3 days
    log(`OSAT sync completed: ${result.synced} records updated`);
    if (result.errors.length > 0) {
      log(`OSAT sync had ${result.errors.length} errors`);
    }
  } catch (error) {
    log(`OSAT sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Save weather at end of day (11 PM Central)
async function saveEndOfDayWeatherIfNeeded() {
  const { hour: centralHour, date: todayCentral } = getCentralTime();
  
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
  const { hour: centralHour, date: todayCentral } = getCentralTime();
  
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
    
    // OPTIMIZED: Count at DB level instead of fetching all rows
    const lastWeekStart = new Date(`${lastWeekDateStr}T00:00:00.000Z`);
    const lastWeekEnd = new Date(`${lastWeekDateStr}T23:59:59.999Z`);
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(hourlySales)
      .where(sql`${hourlySales.salesDate} >= ${lastWeekStart} AND ${hourlySales.salesDate} <= ${lastWeekEnd}`);
    const lastWeekHourlyCount = Number(countResult[0]?.count || 0);
    
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
  
  // Force initial crew sync on startup (bypasses hourly timing check)
  // This ensures production has crew data with positions after deployment
  await forceInitialCrewSync();
  
  // Schedule daily data retention cleanup (runs once per day at midnight)
  scheduleDailyCleanup();
}

// Schedule data retention cleanup to run daily at midnight
function scheduleDailyCleanup() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // Next midnight
  
  const msUntilMidnight = midnight.getTime() - now.getTime();
  
  log(`Data retention cleanup scheduled for midnight (in ${Math.round(msUntilMidnight / 60000)} minutes)`);
  
  setTimeout(async () => {
    await cleanupOldData();
    // Schedule next cleanup in 24 hours
    setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// Force crew sync on startup - runs regardless of time
async function forceInitialCrewSync() {
  log("Running initial crew sync on startup...");
  try {
    const { syncHourlyCrew } = await import("./scraper/7shifts-api");
    
    // Sync today's data
    const today = new Date();
    const todayResult = await syncHourlyCrew(today);
    log(`Initial crew sync (today): ${todayResult.count} hourly records`);
    
    // Also sync yesterday for week-over-week comparisons
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayResult = await syncHourlyCrew(yesterday);
    log(`Initial crew sync (yesterday): ${yesterdayResult.count} hourly records`);
    
  } catch (error) {
    log(`Initial crew sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
