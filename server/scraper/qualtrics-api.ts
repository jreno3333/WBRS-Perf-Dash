import { db } from "../db";
import { osatData, dailyOsat, restaurants, locationMapping } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import AdmZip from "adm-zip";

const QUALTRICS_DATACENTER = "iad1";
const BASE_URL = `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3`;

interface IdpRecord {
  [key: string]: any;
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

async function startIdpExport(idpSourceId: string, apiToken: string, startDate?: string): Promise<string> {
  const body: any = {
    format: "csv",
    compress: true,
    useLabels: true,
  };
  
  if (startDate) {
    body.startDate = `${startDate}T00:00:00Z`;
  }
  
  const response = await fetchWithRetry(`${BASE_URL}/imported-data-projects/${idpSourceId}/exports`, {
    method: "POST",
    headers: {
      "X-API-TOKEN": apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  
  const data = await response.json();
  console.log("[Qualtrics] Export started response:", JSON.stringify(data));
  return data.result.jobId;
}

async function checkIdpExportProgress(idpSourceId: string, jobId: string, apiToken: string): Promise<{ complete: boolean; fileId?: string; status?: string }> {
  const response = await fetchWithRetry(`${BASE_URL}/imported-data-projects/${idpSourceId}/exports/${jobId}`, {
    method: "GET",
    headers: {
      "X-API-TOKEN": apiToken,
    },
  });
  
  const data = await response.json();
  const result = data.result;
  
  console.log(`[Qualtrics] Export progress: ${result.percentComplete}% - ${result.status}`);
  
  if (result.status === "complete") {
    return { complete: true, fileId: result.fileId, status: result.status };
  }
  if (result.status === "failed") {
    return { complete: true, status: "failed" };
  }
  return { complete: false, status: result.status };
}

async function downloadIdpExportFile(idpSourceId: string, fileId: string, apiToken: string): Promise<IdpRecord[]> {
  const response = await fetchWithRetry(`${BASE_URL}/imported-data-projects/${idpSourceId}/exports/${fileId}/file`, {
    method: "GET",
    headers: {
      "X-API-TOKEN": apiToken,
    },
  });
  
  const buffer = await response.arrayBuffer();
  const zip = new AdmZip(Buffer.from(buffer));
  const zipEntries = zip.getEntries();
  
  console.log(`[Qualtrics] ZIP contains ${zipEntries.length} file(s)`);
  
  for (const entry of zipEntries) {
    if (entry.entryName.endsWith('.csv')) {
      const csvContent = entry.getData().toString('utf8');
      console.log(`[Qualtrics] Processing CSV: ${entry.entryName}`);
      return parseCsvToRecords(csvContent);
    }
  }
  
  console.log("[Qualtrics] No CSV file found in ZIP");
  return [];
}

function parseCsvToRecords(csvContent: string): IdpRecord[] {
  const lines = csvContent.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];
  
  const headers = parseCSVLine(lines[0]);
  console.log(`[Qualtrics] CSV headers: ${headers.join(', ')}`);
  
  const records: IdpRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const record: IdpRecord = {};
    for (let j = 0; j < headers.length && j < values.length; j++) {
      record[headers[j]] = values[j];
    }
    records.push(record);
  }
  
  console.log(`[Qualtrics] Parsed ${records.length} records from CSV`);
  if (records.length > 0) {
    console.log(`[Qualtrics] Sample record keys: ${Object.keys(records[0]).slice(0, 10).join(', ')}`);
  }
  
  return records;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  
  return result;
}

export async function fetchQualtricsResponses(startDate?: string): Promise<IdpRecord[]> {
  const apiToken = process.env.QUALTRICS_API_TOKEN;
  const idpSourceId = process.env.QUALTRICS_SURVEY_ID;
  
  if (!apiToken || !idpSourceId) {
    console.log("[Qualtrics] Missing API token or IDP Source ID");
    return [];
  }
  
  console.log(`[Qualtrics] Starting IDP export for ${idpSourceId}${startDate ? ` from ${startDate}` : ''}`);
  
  try {
    const jobId = await startIdpExport(idpSourceId, apiToken, startDate);
    console.log(`[Qualtrics] Export started, jobId: ${jobId}`);
    
    let attempts = 0;
    const maxAttempts = 60;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const progress = await checkIdpExportProgress(idpSourceId, jobId, apiToken);
      
      if (progress.status === "failed") {
        console.log("[Qualtrics] Export failed");
        return [];
      }
      
      if (progress.complete && progress.fileId) {
        console.log(`[Qualtrics] Export complete, downloading file`);
        const records = await downloadIdpExportFile(idpSourceId, progress.fileId, apiToken);
        console.log(`[Qualtrics] Downloaded ${records.length} records`);
        return records;
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

function parseStoreFromRecord(record: IdpRecord): string | null {
  const storeFields = [
    'store', 'Store', 'STORE',
    'location', 'Location', 'LOCATION',
    'storeNumber', 'StoreNumber', 'store_number',
    'locationId', 'LocationId', 'location_id',
    'unit', 'Unit', 'UNIT',
    'unitNumber', 'UnitNumber', 'unit_number',
    'restaurant', 'Restaurant', 'RESTAURANT',
    'StoreNumber', 'Store Number', 'store number',
  ];
  
  for (const field of storeFields) {
    if (record[field]) return String(record[field]).trim();
  }
  
  for (const key of Object.keys(record)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('store') || lowerKey.includes('location') || lowerKey.includes('unit')) {
      if (record[key]) return String(record[key]).trim();
    }
  }
  
  return null;
}

function parseRatingFromRecord(record: IdpRecord): number | null {
  const ratingFields = [
    'osat', 'OSAT', 'Osat',
    'satisfaction', 'Satisfaction', 'SATISFACTION',
    'overall', 'Overall', 'OVERALL',
    'rating', 'Rating', 'RATING',
    'score', 'Score', 'SCORE',
    'Q1', 'Q2', 'Q3', 'q1', 'q2', 'q3',
    'overallSatisfaction', 'OverallSatisfaction',
    'overall_satisfaction',
    'OverallSatisfaction', 'Overall Satisfaction',
  ];
  
  for (const field of ratingFields) {
    const val = record[field];
    if (val !== undefined && val !== null && val !== '') {
      const num = Number(val);
      if (!isNaN(num) && num >= 1 && num <= 5) {
        return num;
      }
    }
  }
  
  for (const key of Object.keys(record)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('satis') || lowerKey.includes('osat') || lowerKey.includes('rating') || lowerKey.includes('overall')) {
      const val = record[key];
      if (val !== undefined && val !== null && val !== '') {
        const num = Number(val);
        if (!isNaN(num) && num >= 1 && num <= 5) {
          return num;
        }
      }
    }
  }
  
  return null;
}

function parseTimestampFromRecord(record: IdpRecord): Date | null {
  const timeFields = [
    'endDate', 'EndDate', 'end_date',
    'startDate', 'StartDate', 'start_date',
    'recordedDate', 'RecordedDate', 'recorded_date',
    'submittedAt', 'submitted_at',
    'timestamp', 'Timestamp',
    'date', 'Date', 'DATE',
    'visitDate', 'VisitDate', 'visit_date',
    'surveyDate', 'SurveyDate', 'survey_date',
  ];
  
  for (const field of timeFields) {
    if (record[field]) {
      const date = new Date(record[field]);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }
  
  for (const key of Object.keys(record)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('date') || lowerKey.includes('time')) {
      const date = new Date(record[key]);
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
  
  const records = await fetchQualtricsResponses(yesterdayStr);
  
  if (records.length === 0) {
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
  
  for (const record of records) {
    const storeId = parseStoreFromRecord(record);
    const rating = parseRatingFromRecord(record);
    const timestamp = parseTimestampFromRecord(record);
    
    if (!storeId) {
      errors.push(`Record missing store identifier. Keys: ${Object.keys(record).slice(0, 5).join(', ')}`);
      continue;
    }
    
    if (rating === null) {
      errors.push(`Record for store ${storeId} missing rating`);
      continue;
    }
    
    const restaurant = restaurantByUnit[storeId] || restaurantByUnit[storeId.replace(/^0+/, '')];
    if (!restaurant) {
      errors.push(`Unknown store: ${storeId}`);
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
