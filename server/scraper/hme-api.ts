import { db } from "../db";
import { restaurants, hmeTimerData } from "@shared/schema";
import { eq, and, gte, lte } from "drizzle-orm";

const HME_BASE_URL = "https://api.hmecloud.com";

interface HMEDetector {
  EventName: string;
  TimeOnDetector: number;
  TimeInQueue: number;
}

interface HMECarEvent {
  EventType: string;
  DepartureTime: string;
  Lane: number;
  Detectors: HMEDetector[];
  TotalTimeInLane?: number;
  QueueTimeInLane?: number;
  Total2TimeInLane?: number;
  Queue2TimeInLane?: number;
  CarsInQueue?: number;
}

interface HMECarRecord {
  RecordId: string;
  StoreNumber: string;
  LaneConfig: string;
  Brand: string;
  Events: HMECarEvent[];
}

interface HMERawCarDataResponse {
  data: {
    total: number;
    moreData: boolean;
    totalInSet: number;
    offsetNext: number | null;
    data: HMECarRecord[];
  };
  status: boolean;
}

interface HMEStore {
  Brand: string;
  StoreNumber: string;
  StoreName: string;
  ReportGroup: string | null;
  AccountEmail: string;
  LaneConfig: string;
  City: string;
  State: string;
  DeviceInfo?: Array<{ DeviceType: string; DeviceVersion: string }>;
}

interface HMEStoresResponse {
  total: number;
  moreData: boolean;
  totalInSet: number;
  offsetNext: number | null;
  data: HMEStore[];
}

function getHMEHeaders() {
  const serviceAccount = process.env.HME_SERVICE_ACCOUNT;
  const authKey = process.env.HME_AUTH_KEY;
  const accountEmail = process.env.HME_ACCOUNT_EMAIL;

  // Log which credentials are missing for debugging
  const missing: string[] = [];
  if (!serviceAccount) missing.push("HME_SERVICE_ACCOUNT");
  if (!authKey) missing.push("HME_AUTH_KEY");
  if (!accountEmail) missing.push("HME_ACCOUNT_EMAIL");
  
  if (missing.length > 0) {
    console.error(`[HME] Missing credentials: ${missing.join(", ")}`);
    throw new Error(`HME API credentials not configured: missing ${missing.join(", ")}`);
  }

  return {
    "accept": "application/json; charset=utf-8",
    "service-account": serviceAccount as string,
    "auth-key": authKey as string,
    "account-email": accountEmail as string,
  };
}

// Check if HME credentials are configured (for diagnostics)
export function checkHMECredentials(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.HME_SERVICE_ACCOUNT) missing.push("HME_SERVICE_ACCOUNT");
  if (!process.env.HME_AUTH_KEY) missing.push("HME_AUTH_KEY");
  if (!process.env.HME_ACCOUNT_EMAIL) missing.push("HME_ACCOUNT_EMAIL");
  return { configured: missing.length === 0, missing };
}

export async function fetchHMEStores(): Promise<HMEStore[]> {
  const allStores: HMEStore[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `${HME_BASE_URL}/dxsmgmt/v2/store/list/default?Limit=${limit}&Offset=${offset}`;
    const { "account-email": _, ...headers } = getHMEHeaders(); // account-email not needed for stores endpoint

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HME API error: ${response.status} ${response.statusText}`);
    }

    const data: HMEStoresResponse = await response.json();
    allStores.push(...data.data);

    if (!data.moreData || data.offsetNext === null) {
      break;
    }
    offset = data.offsetNext;
  }

  return allStores;
}

export async function fetchHMERawCarData(
  startDateTime: Date,
  endDateTime: Date,
  storeNumbers?: string[]
): Promise<HMECarRecord[]> {
  const allRecords: HMECarRecord[] = [];
  let offset = 0;
  const limit = 5000;

  // HME API limitation: max 72 hours per request
  const maxHours = 72;
  const hoursDiff = (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 60 * 60);
  if (hoursDiff > maxHours) {
    throw new Error(`Date range exceeds ${maxHours} hours limit`);
  }

  const startStr = startDateTime.toISOString();
  const endStr = endDateTime.toISOString();

  while (true) {
    let url = `${HME_BASE_URL}/dxs/v1/rcd/report?StartDateTime=${startStr}&EndDateTime=${endStr}&Limit=${limit}&Offset=${offset}`;
    
    if (storeNumbers && storeNumbers.length > 0) {
      url += `&StoreNumberList=${encodeURIComponent(JSON.stringify(storeNumbers))}`;
    }

    const response = await fetch(url, { headers: getHMEHeaders() });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HME API error: ${response.status} - ${errorText}`);
    }

    const result: HMERawCarDataResponse = await response.json();
    
    if (!result.status) {
      throw new Error("HME API returned status: false");
    }

    allRecords.push(...result.data.data);

    if (!result.data.moreData || result.data.offsetNext === null) {
      break;
    }
    offset = result.data.offsetNext;

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return allRecords;
}

export interface DriveThruMetrics {
  storeNumber: string;
  hour: number;
  date: string;
  carCount: number;
  avgTotalTime: number;
  avgMenuBoardTime: number;
  avgServiceTime: number;
  avgQueueTime: number;
  carsUnder6Min: number;
  maxTotalTime: number;
  minTotalTime: number;
}

function extractDetectorTime(detectors: HMEDetector[], patterns: string[]): number {
  for (const detector of detectors) {
    const name = detector.EventName.toLowerCase();
    for (const pattern of patterns) {
      if (name.includes(pattern.toLowerCase())) {
        return detector.TimeOnDetector;
      }
    }
  }
  return 0;
}

export function aggregateCarDataToHourly(records: HMECarRecord[]): DriveThruMetrics[] {
  const hourlyMap = new Map<string, {
    times: number[];
    menuBoardTimes: number[];
    serviceTimes: number[];
    queueTimes: number[];
  }>();

  for (const record of records) {
    for (const event of record.Events) {
      if (event.EventType !== "Car_Departure") continue;
      if (!event.TotalTimeInLane) continue;

      const dtMatch = event.DepartureTime.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):/);
      if (!dtMatch) continue;
      
      const dateStr = dtMatch[1];
      const hour = parseInt(dtMatch[2]);
      const key = `${record.StoreNumber}|${dateStr}|${hour}`;

      if (!hourlyMap.has(key)) {
        hourlyMap.set(key, {
          times: [],
          menuBoardTimes: [],
          serviceTimes: [],
          queueTimes: [],
        });
      }

      const bucket = hourlyMap.get(key)!;
      bucket.times.push(event.TotalTimeInLane);
      bucket.queueTimes.push(event.QueueTimeInLane || 0);

      const menuTime = extractDetectorTime(event.Detectors, ["menu", "order"]);
      const serviceTime = extractDetectorTime(event.Detectors, ["service", "window", "present", "delivery"]);
      
      bucket.menuBoardTimes.push(menuTime);
      bucket.serviceTimes.push(serviceTime);
    }
  }

  const metrics: DriveThruMetrics[] = [];
  
  for (const [key, bucket] of Array.from(hourlyMap.entries())) {
    const [storeNumber, date, hourStr] = key.split("|");
    const hour = parseInt(hourStr);

    if (bucket.times.length === 0) continue;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const carsUnder6Min = bucket.times.filter(t => t < 360).length;

    metrics.push({
      storeNumber,
      date,
      hour,
      carCount: bucket.times.length,
      avgTotalTime: Math.round(avg(bucket.times)),
      avgMenuBoardTime: Math.round(avg(bucket.menuBoardTimes)),
      avgServiceTime: Math.round(avg(bucket.serviceTimes)),
      avgQueueTime: Math.round(avg(bucket.queueTimes)),
      carsUnder6Min,
      maxTotalTime: Math.max(...bucket.times),
      minTotalTime: Math.min(...bucket.times),
    });
  }

  return metrics;
}

export async function syncHMETimerData(targetDate?: Date): Promise<{ saved: number; errors: string[] }> {
  const errors: string[] = [];
  
  // Fetch full day's data to ensure complete hourly coverage
  const now = new Date();
  const endTime = targetDate || now;
  
  // Use 24 hours before end time to capture the full day (within 72hr API limit)
  const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);

  console.log(`[HME] Fetching timer data from ${startTime.toISOString()} to ${endTime.toISOString()}`);

  try {
    const records = await fetchHMERawCarData(startTime, endTime);
    console.log(`[HME] Fetched ${records.length} car records`);

    const metrics = aggregateCarDataToHourly(records);
    console.log(`[HME] Aggregated to ${metrics.length} hourly records`);

    // Log per-store record counts from raw data for diagnostics
    const storeRecordCounts = new Map<string, number>();
    for (const r of records) {
      storeRecordCounts.set(r.StoreNumber, (storeRecordCounts.get(r.StoreNumber) || 0) + r.Events.filter(e => e.EventType === 'Car_Departure').length);
    }
    const storeSummary = Array.from(storeRecordCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([store, count]) => `${store}:${count}`)
      .join(', ');
    console.log(`[HME] Raw car events by store: ${storeSummary}`);

    // Get restaurant mapping (store number -> restaurant ID)
    const allRestaurants = await db.select().from(restaurants);
    const storeMap = new Map<string, string>();
    const storeNameMap = new Map<string, string>();
    
    for (const r of allRestaurants) {
      if (r.unitNumber) {
        storeMap.set(r.unitNumber, r.id);
        storeNameMap.set(r.unitNumber, r.name);
      }
      const nameMatch = r.name.match(/^(\d{4})\s*-/);
      if (nameMatch && !storeMap.has(nameMatch[1])) {
        storeMap.set(nameMatch[1], r.id);
        storeNameMap.set(nameMatch[1], r.name);
      }
    }
    
    console.log(`[HME] Store mapping: ${storeMap.size} stores mapped`);
    
    // Log which mapped stores have no data in this sync
    const storesWithData = new Set(metrics.map(m => m.storeNumber));
    const missingStores = Array.from(storeMap.keys()).filter(s => !storesWithData.has(s));
    if (missingStores.length > 0) {
      console.log(`[HME] Mapped stores with NO data this sync: ${missingStores.map(s => storeNameMap.get(s) || s).join(', ')}`);
    }

    let saved = 0;
    for (const m of metrics) {
      const restaurantId = storeMap.get(m.storeNumber);
      if (!restaurantId) {
        if (!errors.includes(`Unknown store: ${m.storeNumber}`)) {
          errors.push(`Unknown store: ${m.storeNumber}`);
        }
        continue;
      }

      try {
        // First, check if record exists and delete it (to handle databases without unique constraint)
        await db.delete(hmeTimerData).where(
          and(
            eq(hmeTimerData.restaurantId, restaurantId),
            eq(hmeTimerData.date, m.date),
            eq(hmeTimerData.hour, m.hour)
          )
        );
        
        // Then insert the new data
        await db.insert(hmeTimerData).values({
          restaurantId,
          date: m.date,
          hour: m.hour,
          carCount: m.carCount,
          avgTotalTime: m.avgTotalTime,
          avgMenuBoardTime: m.avgMenuBoardTime,
          avgServiceTime: m.avgServiceTime,
          avgQueueTime: m.avgQueueTime,
          carsUnder6Min: m.carsUnder6Min,
          maxTotalTime: m.maxTotalTime,
          minTotalTime: m.minTotalTime,
        });
        saved++;
      } catch (err: any) {
        errors.push(`Error saving ${m.storeNumber} ${m.date} H${m.hour}: ${err.message}`);
      }
    }

    return { saved, errors };
  } catch (err: any) {
    errors.push(`HME sync failed: ${err.message}`);
    return { saved: 0, errors };
  }
}

export async function getHMETimerMetrics(restaurantId: string, date: string): Promise<DriveThruMetrics[]> {
  const data = await db.select()
    .from(hmeTimerData)
    .where(and(
      eq(hmeTimerData.restaurantId, restaurantId),
      eq(hmeTimerData.date, date)
    ));

  return data.map(d => ({
    storeNumber: "",
    date: d.date,
    hour: d.hour,
    carCount: d.carCount,
    avgTotalTime: d.avgTotalTime,
    avgMenuBoardTime: d.avgMenuBoardTime,
    avgServiceTime: d.avgServiceTime,
    avgQueueTime: d.avgQueueTime,
    carsUnder6Min: d.carsUnder6Min,
    maxTotalTime: d.maxTotalTime,
    minTotalTime: d.minTotalTime,
  }));
}

export async function getDailyDriveThruSummary(date: string): Promise<Map<string, {
  carCount: number;
  avgTotalTime: number;
  avgServiceTime: number;
  speedAttainment: number;
}>> {
  const data = await db.select()
    .from(hmeTimerData)
    .where(eq(hmeTimerData.date, date));

  const summaryMap = new Map<string, {
    totalCars: number;
    totalTimeSum: number;
    serviceTimeSum: number;
    carsUnder6Min: number;
    count: number;
  }>();

  for (const d of data) {
    if (!summaryMap.has(d.restaurantId)) {
      summaryMap.set(d.restaurantId, {
        totalCars: 0,
        totalTimeSum: 0,
        serviceTimeSum: 0,
        carsUnder6Min: 0,
        count: 0,
      });
    }
    const s = summaryMap.get(d.restaurantId)!;
    s.totalCars += d.carCount;
    s.totalTimeSum += d.avgTotalTime * d.carCount;
    s.serviceTimeSum += d.avgServiceTime * d.carCount;
    s.carsUnder6Min += d.carsUnder6Min;
    s.count += d.carCount;
  }

  const result = new Map<string, { carCount: number; avgTotalTime: number; avgServiceTime: number; speedAttainment: number; carsUnder6Min: number }>();
  for (const [id, s] of Array.from(summaryMap.entries())) {
    result.set(id, {
      carCount: s.totalCars,
      avgTotalTime: s.count > 0 ? Math.round(s.totalTimeSum / s.count) : 0,
      avgServiceTime: s.count > 0 ? Math.round(s.serviceTimeSum / s.count) : 0,
      speedAttainment: s.totalCars > 0 ? Math.round((s.carsUnder6Min / s.totalCars) * 100) : 0,
      carsUnder6Min: s.carsUnder6Min,
    });
  }

  return result;
}
