import { db } from "../db";
import { osatData, dailyOsat, restaurants, locationMapping, osatCategoryIssues } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import AdmZip from "adm-zip";

// Category field mappings from Qualtrics survey
const CATEGORY_FIELDS = {
  orderAccuracy: 'QID1319640443_3',
  foodQuality: 'QID1319640443_8',
  menuOptions: 'QID1319640443_1',
  value: 'QID1319640443_9',
  easeOfOrdering: 'QID1319640443_2',
  employeeFriendliness: 'QID1319640443_11',
  speedOfService: 'QID1319640443_10',
  cleanliness: 'QID1319640443_12',
  driveThruWaitTime: 'QID1319640443_14',
} as const;

function parseCategoryRating(value: any): number | null {
  if (value === undefined || value === null || value === '') return null;
  const strVal = String(value).trim();
  const num = Number(strVal);
  if (!isNaN(num) && num >= 1 && num <= 5) return num;
  
  // Try text conversion
  const textRating = convertTextToRating(strVal);
  return textRating;
}

function parseCategoryRatings(record: IdpRecord): Record<string, number | null> {
  const ratings: Record<string, number | null> = {};
  for (const [key, field] of Object.entries(CATEGORY_FIELDS)) {
    ratings[key] = parseCategoryRating(record[field]);
  }
  return ratings;
}

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
  // Primary field: 's' = Transaction Unit (store number)
  if (record['s']) {
    return String(record['s']).trim();
  }
  
  // Fallback fields
  const storeFields = [
    'store', 'Store', 'STORE',
    'unit', 'Unit', 'UNIT',
    'storeNumber', 'StoreNumber', 'store_number',
    'unitNumber', 'UnitNumber', 'unit_number',
  ];
  
  for (const field of storeFields) {
    if (record[field]) return String(record[field]).trim();
  }
  
  return null;
}

function convertTextToRating(text: string): number | null {
  const lowerText = text.toLowerCase().trim();
  
  // Map text labels to numeric ratings (1-5 scale)
  const ratingMap: Record<string, number> = {
    'highly satisfied': 5,
    'very satisfied': 5,
    'extremely satisfied': 5,
    'satisfied': 4,
    'somewhat satisfied': 3,
    'neutral': 3,
    'neither satisfied nor dissatisfied': 3,
    'somewhat dissatisfied': 2,
    'dissatisfied': 2,
    'highly dissatisfied': 1,
    'very dissatisfied': 1,
    'extremely dissatisfied': 1,
    // Numbered ratings
    '5': 5, '4': 4, '3': 3, '2': 2, '1': 1,
    'five': 5, 'four': 4, 'three': 3, 'two': 2, 'one': 1,
  };
  
  if (ratingMap[lowerText] !== undefined) {
    return ratingMap[lowerText];
  }
  
  // Try to extract a number from the text
  const numMatch = text.match(/\d+/);
  if (numMatch) {
    const num = parseInt(numMatch[0], 10);
    if (num >= 1 && num <= 5) {
      return num;
    }
  }
  
  return null;
}

function parseRatingFromRecord(record: IdpRecord): number | null {
  // Primary field: QID1319640445 = "Overall, how satisfied are you with your visit?"
  const osatField = record['QID1319640445'];
  if (osatField !== undefined && osatField !== null && osatField !== '') {
    const val = String(osatField).trim();
    
    // Try direct number first
    const num = Number(val);
    if (!isNaN(num) && num >= 1 && num <= 5) {
      return num;
    }
    
    // Try text conversion
    const textRating = convertTextToRating(val);
    if (textRating !== null) {
      return textRating;
    }
  }
  
  // Fallback fields
  const ratingFields = [
    'osat', 'OSAT', 'Osat',
    'satisfaction', 'Satisfaction', 'SATISFACTION',
    'overall', 'Overall', 'OVERALL',
    'rating', 'Rating', 'RATING',
  ];
  
  for (const field of ratingFields) {
    const val = record[field];
    if (val !== undefined && val !== null && val !== '') {
      const strVal = String(val).trim();
      const num = Number(strVal);
      if (!isNaN(num) && num >= 1 && num <= 5) {
        return num;
      }
      const textRating = convertTextToRating(strVal);
      if (textRating !== null) {
        return textRating;
      }
    }
  }
  
  return null;
}

function parseTimestampFromRecord(record: IdpRecord): Date | null {
  // Primary fields: 'd' = Transaction Date, 't' = Transaction Time
  const transactionDate = record['d'];
  const transactionTime = record['t'];
  
  if (transactionDate) {
    let dateStr = String(transactionDate).trim();
    if (transactionTime) {
      dateStr += ' ' + String(transactionTime).trim();
    }
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date;
    }
    // Try parsing date-only formats (MM/DD/YYYY or YYYY-MM-DD)
    const dateOnly = new Date(transactionDate);
    if (!isNaN(dateOnly.getTime())) {
      if (transactionTime) {
        // Try to parse time separately (HH:MM or HH:MM:SS)
        const timeParts = String(transactionTime).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (timeParts) {
          dateOnly.setHours(parseInt(timeParts[1], 10));
          dateOnly.setMinutes(parseInt(timeParts[2], 10));
          if (timeParts[3]) {
            dateOnly.setSeconds(parseInt(timeParts[3], 10));
          }
        }
      }
      return dateOnly;
    }
  }
  
  // Fallback: try other date fields
  const timeFields = [
    'endDate (+00:00 GMT)', 'recordedDate (+00:00 GMT)',
    'endDate', 'EndDate', 'startDate', 'StartDate', 
    'recordedDate', 'RecordedDate',
  ];
  
  for (const field of timeFields) {
    if (record[field]) {
      const date = new Date(record[field]);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }
  
  return null;
}

export async function syncOsatData(daysBack: number = 3): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;
  
  const now = new Date();
  const centralFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
  const todayStr = centralFormatter.format(now);
  
  // Calculate start date based on daysBack parameter
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);
  const startDateStr = centralFormatter.format(startDate);
  
  console.log(`[Qualtrics] Syncing OSAT data from ${startDateStr} (${daysBack} days back)`);
  
  const records = await fetchQualtricsResponses(startDateStr);
  
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
  
  // Log date distribution and first record for debugging
  if (records.length > 0) {
    const sample = records[0];
    console.log(`[Qualtrics] Sample record - s: "${sample['s']}", QID1319640445: "${sample['QID1319640445']}", d: "${sample['d']}", t: "${sample['t']}"`);
    
    // Count records per date to understand distribution
    const dateDistribution: Record<string, number> = {};
    for (const r of records) {
      const d = r['d'] || 'unknown';
      dateDistribution[d] = (dateDistribution[d] || 0) + 1;
    }
    const sortedDates = Object.entries(dateDistribution).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`[Qualtrics] Date distribution (top 10): ${JSON.stringify(sortedDates)}`);
    
    // Check specifically for today's date (2026-02-05 or 2/5/2026)
    const today25Format = '2/5/2026';
    const todayIsoFormat = '2026-02-05';
    const todayRecords = records.filter(r => r['d'] === today25Format || r['d'] === todayIsoFormat || r['d'] === '02/05/2026');
    console.log(`[Qualtrics] Records with today's date (${todayStr}): ${todayRecords.length}`);
    if (todayRecords.length > 0) {
      console.log(`[Qualtrics] Today's surveys: ${todayRecords.map(r => `s:${r['s']}, t:${r['t']}, rating:${r['QID1319640445']}`).join(' | ')}`);
    }
  }
  
  for (const record of records) {
    const storeId = parseStoreFromRecord(record);
    const rating = parseRatingFromRecord(record);
    
    if (!storeId) {
      errors.push(`Record missing store identifier. Keys: ${Object.keys(record).slice(0, 5).join(', ')}`);
      continue;
    }
    
    if (rating === null) {
      const rawRating = record['QID1319640445'];
      errors.push(`Record for store ${storeId} missing rating (raw value: "${rawRating}")`);
      continue;
    }
    
    const restaurant = restaurantByUnit[storeId] || restaurantByUnit[storeId.replace(/^0+/, '')];
    if (!restaurant) {
      errors.push(`Unknown store: ${storeId}`);
      continue;
    }
    
    // Get restaurant's timezone (default to Central if not set)
    const restaurantTimezone = restaurant.timezone || 'America/Chicago';
    
    // Parse transaction date and time in the restaurant's local timezone
    let dateStr = todayStr;
    let hour = new Date().getHours();
    
    const transactionDate = record['d'];
    const transactionTime = record['t'];
    
    if (transactionDate) {
      // Parse the date (format: "1/29/2026" or "2026-01-29")
      let parsedDate: Date | null = null;
      const dateOnlyStr = String(transactionDate).trim();
      
      // Try MM/DD/YYYY format first
      const mdyMatch = dateOnlyStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdyMatch) {
        const [, month, day, year] = mdyMatch;
        // Use noon (12:00) to avoid timezone boundary issues when formatting
        parsedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0);
      } else {
        // Try YYYY-MM-DD format - append time to avoid timezone issues
        const isoMatch = dateOnlyStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoMatch) {
          const [, year, month, day] = isoMatch;
          parsedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0);
        } else {
          parsedDate = new Date(dateOnlyStr);
        }
      }
      
      if (parsedDate && !isNaN(parsedDate.getTime())) {
        // Format date in Central timezone for storage (consistent date key)
        const centralFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
        dateStr = centralFormatter.format(parsedDate);
        
        // Parse transaction time if available (format: "02:33PM" or "14:33")
        if (transactionTime) {
          const timeStr = String(transactionTime).trim();
          
          // Parse time in 12-hour format with AM/PM
          const time12Match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
          if (time12Match) {
            let [, hourStr, minStr, ampm] = time12Match;
            let parsedHour = parseInt(hourStr, 10);
            
            // Convert to 24-hour format
            if (ampm.toUpperCase() === 'PM' && parsedHour !== 12) {
              parsedHour += 12;
            } else if (ampm.toUpperCase() === 'AM' && parsedHour === 12) {
              parsedHour = 0;
            }
            
            // This hour is in the restaurant's LOCAL timezone
            // If restaurant is Eastern, we need to convert to Central for storage
            if (restaurantTimezone === 'America/New_York') {
              // Eastern is 1 hour ahead of Central, so subtract 1 to get Central hour
              parsedHour = parsedHour - 1;
              if (parsedHour < 0) {
                parsedHour = 23;
                // Also need to adjust the date back one day
                const prevDate = new Date(parsedDate);
                prevDate.setDate(prevDate.getDate() - 1);
                dateStr = centralFormatter.format(prevDate);
              }
            }
            
            hour = parsedHour;
          } else {
            // Try 24-hour format HH:MM
            const time24Match = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
            if (time24Match) {
              let parsedHour = parseInt(time24Match[1], 10);
              
              // Convert from restaurant timezone to Central
              if (restaurantTimezone === 'America/New_York') {
                parsedHour = parsedHour - 1;
                if (parsedHour < 0) {
                  parsedHour = 23;
                  const prevDate = new Date(parsedDate);
                  prevDate.setDate(prevDate.getDate() - 1);
                  dateStr = centralFormatter.format(prevDate);
                }
              }
              
              hour = parsedHour;
            }
          }
        }
      }
    } else {
      // Fallback: try other date fields from Qualtrics response metadata
      const timestamp = parseTimestampFromRecord(record);
      if (timestamp) {
        const centralDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
        dateStr = centralDate.format(timestamp);
        const centralHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
        hour = parseInt(centralHour.format(timestamp), 10);
        if (hour === 24) hour = 0;
      }
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
    
    // Parse and save category ratings for this survey response
    const categoryRatings = parseCategoryRatings(record);
    const hasLowRating = Object.values(categoryRatings).some(r => r !== null && r < 3);
    const hasAnyRating = Object.values(categoryRatings).some(r => r !== null);
    
    // Save category data if overall rating is low OR any category has low rating OR any category data exists
    if (rating < 5 || hasLowRating || hasAnyRating) {
      const transactionId = record['trans'] || record['transactionId'] || record['transaction_id'] || null;
      
      try {
        await db.insert(osatCategoryIssues).values({
          restaurantId: restaurant.id,
          date: dateStr,
          hour,
          orderAccuracy: categoryRatings.orderAccuracy,
          foodQuality: categoryRatings.foodQuality,
          menuOptions: categoryRatings.menuOptions,
          value: categoryRatings.value,
          easeOfOrdering: categoryRatings.easeOfOrdering,
          employeeFriendliness: categoryRatings.employeeFriendliness,
          speedOfService: categoryRatings.speedOfService,
          cleanliness: categoryRatings.cleanliness,
          driveThruWaitTime: categoryRatings.driveThruWaitTime,
          overallRating: rating,
          transactionId: transactionId ? String(transactionId) : null,
        }).onConflictDoNothing();
      } catch (error: any) {
        if (!error.message?.includes('duplicate key')) {
          console.error(`[Qualtrics] Error saving category ratings: ${error.message}`);
        }
      }
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

export async function syncOsatHistorical(daysBack: number = 7): Promise<{ synced: number; errors: string[] }> {
  console.log(`[Qualtrics] Starting historical OSAT sync for ${daysBack} days`);
  return syncOsatData(daysBack);
}
