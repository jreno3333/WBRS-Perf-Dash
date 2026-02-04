import { db } from "../db";
import { osatData, dailyOsat, restaurants, locationMapping } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

const QUALTRICS_DATACENTER = "iad1";
const BASE_URL = `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3`;

interface QualtricsResponse {
  responseId: string;
  values: Record<string, any>;
  labels: Record<string, any>;
  displayedFields: string[];
  displayedValues: Record<string, any>;
}

interface ExportResult {
  responses: QualtricsResponse[];
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error("Max retries exceeded");
}

async function startResponseExport(surveyId: string, apiToken: string, startDate?: string): Promise<string> {
  const body: any = {
    format: "json",
    compress: false,
    useLabels: true,
  };
  
  if (startDate) {
    body.startDate = `${startDate}T00:00:00Z`;
  }
  
  const response = await fetchWithRetry(`${BASE_URL}/surveys/${surveyId}/export-responses`, {
    method: "POST",
    headers: {
      "X-API-TOKEN": apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  
  const data = await response.json();
  return data.result.progressId;
}

async function checkExportProgress(surveyId: string, progressId: string, apiToken: string): Promise<{ complete: boolean; fileId?: string }> {
  const response = await fetchWithRetry(`${BASE_URL}/surveys/${surveyId}/export-responses/${progressId}`, {
    method: "GET",
    headers: {
      "X-API-TOKEN": apiToken,
    },
  });
  
  const data = await response.json();
  const result = data.result;
  
  if (result.status === "complete") {
    return { complete: true, fileId: result.fileId };
  }
  return { complete: false };
}

async function downloadExportFile(surveyId: string, fileId: string, apiToken: string): Promise<ExportResult> {
  const response = await fetchWithRetry(`${BASE_URL}/surveys/${surveyId}/export-responses/${fileId}/file`, {
    method: "GET",
    headers: {
      "X-API-TOKEN": apiToken,
    },
  });
  
  const data = await response.json();
  return data;
}

export async function fetchQualtricsResponses(startDate?: string): Promise<QualtricsResponse[]> {
  const apiToken = process.env.QUALTRICS_API_TOKEN;
  const surveyId = process.env.QUALTRICS_SURVEY_ID;
  
  if (!apiToken || !surveyId) {
    console.log("[Qualtrics] Missing API token or survey ID");
    return [];
  }
  
  console.log(`[Qualtrics] Starting export for survey ${surveyId}${startDate ? ` from ${startDate}` : ''}`);
  
  try {
    const progressId = await startResponseExport(surveyId, apiToken, startDate);
    console.log(`[Qualtrics] Export started, progressId: ${progressId}`);
    
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const progress = await checkExportProgress(surveyId, progressId, apiToken);
      
      if (progress.complete && progress.fileId) {
        console.log(`[Qualtrics] Export complete, downloading file`);
        const result = await downloadExportFile(surveyId, progress.fileId, apiToken);
        console.log(`[Qualtrics] Downloaded ${result.responses?.length || 0} responses`);
        return result.responses || [];
      }
      
      attempts++;
    }
    
    console.log("[Qualtrics] Export timed out");
    return [];
  } catch (error) {
    console.error("[Qualtrics] Error fetching responses:", error);
    return [];
  }
}

function parseStoreFromResponse(response: QualtricsResponse): string | null {
  const values = response.values || {};
  const labels = response.labels || {};
  
  const storeFields = [
    'store', 'Store', 'STORE',
    'location', 'Location', 'LOCATION',
    'storeNumber', 'StoreNumber', 'store_number',
    'locationId', 'LocationId', 'location_id',
    'unit', 'Unit', 'UNIT',
    'unitNumber', 'UnitNumber', 'unit_number',
    'restaurant', 'Restaurant', 'RESTAURANT',
  ];
  
  for (const field of storeFields) {
    if (values[field]) return String(values[field]);
    if (labels[field]) return String(labels[field]);
  }
  
  for (const key of Object.keys(values)) {
    if (key.toLowerCase().includes('store') || key.toLowerCase().includes('location') || key.toLowerCase().includes('unit')) {
      if (values[key]) return String(values[key]);
    }
  }
  
  return null;
}

function parseRatingFromResponse(response: QualtricsResponse): number | null {
  const values = response.values || {};
  const labels = response.labels || {};
  
  const ratingFields = [
    'osat', 'OSAT', 'Osat',
    'satisfaction', 'Satisfaction', 'SATISFACTION',
    'overall', 'Overall', 'OVERALL',
    'rating', 'Rating', 'RATING',
    'score', 'Score', 'SCORE',
    'Q1', 'Q2', 'Q3', 'q1', 'q2', 'q3',
    'overallSatisfaction', 'OverallSatisfaction',
    'overall_satisfaction',
  ];
  
  for (const field of ratingFields) {
    const val = values[field] ?? labels[field];
    if (val !== undefined && val !== null) {
      const num = Number(val);
      if (!isNaN(num) && num >= 1 && num <= 5) {
        return num;
      }
    }
  }
  
  for (const key of Object.keys(values)) {
    if (key.toLowerCase().includes('satis') || key.toLowerCase().includes('osat') || key.toLowerCase().includes('rating')) {
      const val = values[key];
      const num = Number(val);
      if (!isNaN(num) && num >= 1 && num <= 5) {
        return num;
      }
    }
  }
  
  return null;
}

function parseTimestampFromResponse(response: QualtricsResponse): Date | null {
  const values = response.values || {};
  
  const timeFields = ['endDate', 'EndDate', 'startDate', 'StartDate', 'recordedDate', 'RecordedDate', 'submittedAt', 'timestamp'];
  
  for (const field of timeFields) {
    if (values[field]) {
      const date = new Date(values[field]);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }
  
  return null;
}

export async function syncOsatData(): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;
  
  const now = new Date();
  const centralFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
  const todayStr = centralFormatter.format(now);
  
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = centralFormatter.format(yesterday);
  
  const responses = await fetchQualtricsResponses(yesterdayStr);
  
  if (responses.length === 0) {
    return { synced: 0, errors: ["No responses found"] };
  }
  
  const allRestaurants = await db.select().from(restaurants);
  const allMappings = await db.select().from(locationMapping);
  
  const restaurantByUnit: Record<string, typeof allRestaurants[0]> = {};
  for (const r of allRestaurants) {
    if (r.unitNumber) {
      restaurantByUnit[r.unitNumber] = r;
      restaurantByUnit[r.unitNumber.replace(/^0+/, '')] = r;
    }
  }
  
  for (const m of allMappings) {
    const r = allRestaurants.find(r => r.id === m.restaurantId);
    if (r && m.xenialStoreNumber) {
      restaurantByUnit[m.xenialStoreNumber] = r;
    }
  }
  
  const aggregated: Record<string, { totalResponses: number; fiveStarCount: number }> = {};
  const hourlyAggregated: Record<string, { totalResponses: number; fiveStarCount: number }> = {};
  
  for (const response of responses) {
    const storeId = parseStoreFromResponse(response);
    const rating = parseRatingFromResponse(response);
    const timestamp = parseTimestampFromResponse(response);
    
    if (!storeId) {
      errors.push(`Response ${response.responseId}: Missing store identifier`);
      continue;
    }
    
    if (rating === null) {
      errors.push(`Response ${response.responseId}: Missing rating`);
      continue;
    }
    
    const restaurant = restaurantByUnit[storeId] || restaurantByUnit[storeId.replace(/^0+/, '')];
    if (!restaurant) {
      errors.push(`Response ${response.responseId}: Unknown store ${storeId}`);
      continue;
    }
    
    let dateStr = todayStr;
    let hour = new Date().getHours();
    
    if (timestamp) {
      const centralDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
      dateStr = centralDate.format(timestamp);
      const centralHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
      hour = parseInt(centralHour.format(timestamp), 10);
    }
    
    const dailyKey = `${restaurant.id}|${dateStr}`;
    if (!aggregated[dailyKey]) {
      aggregated[dailyKey] = { totalResponses: 0, fiveStarCount: 0 };
    }
    aggregated[dailyKey].totalResponses++;
    if (rating === 5) {
      aggregated[dailyKey].fiveStarCount++;
    }
    
    const hourlyKey = `${restaurant.id}|${dateStr}|${hour}`;
    if (!hourlyAggregated[hourlyKey]) {
      hourlyAggregated[hourlyKey] = { totalResponses: 0, fiveStarCount: 0 };
    }
    hourlyAggregated[hourlyKey].totalResponses++;
    if (rating === 5) {
      hourlyAggregated[hourlyKey].fiveStarCount++;
    }
  }
  
  for (const [key, data] of Object.entries(aggregated)) {
    const [restaurantId, date] = key.split("|");
    const osatPercent = data.totalResponses > 0 
      ? ((data.fiveStarCount / data.totalResponses) * 100).toFixed(2)
      : null;
    
    try {
      await db.insert(dailyOsat).values({
        restaurantId,
        date,
        totalResponses: data.totalResponses,
        fiveStarCount: data.fiveStarCount,
        osatPercent,
      }).onConflictDoUpdate({
        target: [dailyOsat.restaurantId, dailyOsat.date],
        set: {
          totalResponses: data.totalResponses,
          fiveStarCount: data.fiveStarCount,
          osatPercent,
          syncedAt: sql`now()`,
        },
      });
      synced++;
    } catch (error) {
      errors.push(`Failed to save daily OSAT for ${restaurantId} on ${date}: ${error}`);
    }
  }
  
  for (const [key, data] of Object.entries(hourlyAggregated)) {
    const [restaurantId, date, hourStr] = key.split("|");
    const hour = parseInt(hourStr, 10);
    const osatPercent = data.totalResponses > 0 
      ? ((data.fiveStarCount / data.totalResponses) * 100).toFixed(2)
      : null;
    
    try {
      await db.insert(osatData).values({
        restaurantId,
        date,
        hour,
        totalResponses: data.totalResponses,
        fiveStarCount: data.fiveStarCount,
        osatPercent,
      }).onConflictDoUpdate({
        target: [osatData.restaurantId, osatData.date, osatData.hour],
        set: {
          totalResponses: data.totalResponses,
          fiveStarCount: data.fiveStarCount,
          osatPercent,
          syncedAt: sql`now()`,
        },
      });
    } catch (error) {
      errors.push(`Failed to save hourly OSAT for ${restaurantId} on ${date} hour ${hour}: ${error}`);
    }
  }
  
  console.log(`[Qualtrics] Synced ${synced} daily OSAT records, ${Object.keys(hourlyAggregated).length} hourly records`);
  
  return { synced, errors: errors.slice(0, 10) };
}

export async function getOsatForDate(date: string): Promise<Record<string, { osatPercent: number; totalResponses: number; fiveStarCount: number }>> {
  const records = await db.select().from(dailyOsat).where(eq(dailyOsat.date, date));
  
  const result: Record<string, { osatPercent: number; totalResponses: number; fiveStarCount: number }> = {};
  
  for (const record of records) {
    result[record.restaurantId] = {
      osatPercent: record.osatPercent ? parseFloat(record.osatPercent) : 0,
      totalResponses: record.totalResponses,
      fiveStarCount: record.fiveStarCount,
    };
  }
  
  return result;
}

export async function getHourlyOsatForDate(date: string): Promise<Record<string, Record<number, { osatPercent: number; totalResponses: number }>>> {
  const records = await db.select().from(osatData).where(eq(osatData.date, date));
  
  const result: Record<string, Record<number, { osatPercent: number; totalResponses: number }>> = {};
  
  for (const record of records) {
    if (!result[record.restaurantId]) {
      result[record.restaurantId] = {};
    }
    result[record.restaurantId][record.hour] = {
      osatPercent: record.osatPercent ? parseFloat(record.osatPercent) : 0,
      totalResponses: record.totalResponses,
    };
  }
  
  return result;
}
