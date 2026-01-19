import { fetchSalesFromAPI } from "./scraper/7shifts-api";

function log(message: string) {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [scheduler] ${message}`);
}

function getNextSyncTime(): Date {
  const now = new Date();
  const currentMinute = now.getMinutes();
  
  const syncMinutes = [2, 10, 18, 26, 34, 42, 50, 58];
  
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
  log("Starting scheduled 7shifts sync...");
  
  try {
    const result = await fetchSalesFromAPI();
    if (result.success) {
      log(`Sync completed: ${result.recordsScraped} records updated`);
    } else {
      log(`Sync failed: ${result.error}`);
    }
  } catch (error) {
    log(`Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function startScheduler() {
  log("Sales sync scheduler started - syncing every 8 minutes at :02, :10, :18, :26, :34, :42, :50, :58");
  
  scheduleNextSync();
  
  runScheduledSync();
}
