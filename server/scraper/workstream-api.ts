import { db } from "../db";
import { applicants, workstreamLocations, restaurants } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

const WORKSTREAM_BASE_URL = "https://public-api.workstream.us";

interface WorkstreamPosition {
  digest_key: string;
  title: string;
}

interface WorkstreamLocation {
  digest_key: string;
  name: string;
}

interface WorkstreamApplicant {
  digest_key: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  status: string;
  current_stage: string;
  referer_source: string;
  position: WorkstreamPosition;
  location: WorkstreamLocation;
  created_at?: string;
  hired_at?: string;
}

interface WorkstreamResponse {
  position_applications: WorkstreamApplicant[];
}

function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function normalizePositionLevel(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('operator') || t.includes('owner') || t.includes('general manager') || t.includes('gm')) {
    return 'operator';
  }
  if (t.includes('manager') || t.includes('assistant manager') || t.includes('agm')) {
    return 'manager';
  }
  if (t.includes('shift') || t.includes('supervisor') || t.includes('lead') || t.includes('trainer')) {
    return 'shift_supervisor';
  }
  return 'team_member';
}

async function getAuthHeaders(): Promise<HeadersInit> {
  const token = process.env.WORKSTREAM_API_TOKEN;
  if (!token) {
    throw new Error("WORKSTREAM_API_TOKEN not configured");
  }
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function fetchWorkstreamApplicants(): Promise<WorkstreamApplicant[]> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${WORKSTREAM_BASE_URL}/position_applications/`, {
    method: "GET",
    headers,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error("[Workstream] API error:", response.status, errorText);
    throw new Error(`Workstream API error: ${response.status}`);
  }
  
  const data: WorkstreamResponse = await response.json();
  console.log(`[Workstream] Fetched ${data.position_applications?.length || 0} applicants`);
  return data.position_applications || [];
}

async function matchLocationToRestaurant(locationName: string): Promise<string | null> {
  const match = locationName.match(/(\d{4})/);
  if (!match) return null;
  
  const unitNumber = match[1];
  
  const [restaurant] = await db
    .select({ id: restaurants.id })
    .from(restaurants)
    .where(sql`${restaurants.name} LIKE ${'%' + unitNumber + '%'}`)
    .limit(1);
  
  return restaurant?.id || null;
}

export async function syncWorkstreamApplicants(): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;
  
  try {
    const applicantData = await fetchWorkstreamApplicants();
    
    for (const app of applicantData) {
      try {
        let restaurantId: string | null = null;
        const locationName = app.location?.name || '';
        
        if (app.location?.digest_key) {
          const [existingMapping] = await db
            .select()
            .from(workstreamLocations)
            .where(eq(workstreamLocations.workstreamDigestKey, app.location.digest_key))
            .limit(1);
          
          if (existingMapping) {
            restaurantId = existingMapping.restaurantId;
          } else {
            restaurantId = await matchLocationToRestaurant(locationName);
            
            await db.insert(workstreamLocations).values({
              workstreamDigestKey: app.location.digest_key,
              workstreamName: locationName,
              restaurantId,
            }).onConflictDoNothing();
          }
        }
        
        const appliedAt = app.created_at ? new Date(app.created_at) : new Date();
        const weekStart = getWeekStart(appliedAt);
        const positionLevel = normalizePositionLevel(app.position?.title || '');
        
        await db.insert(applicants).values({
          digestKey: app.digest_key,
          restaurantId,
          workstreamLocationId: app.location?.digest_key || null,
          workstreamLocationName: locationName,
          positionTitle: app.position?.title || 'Unknown',
          positionLevel,
          firstName: app.first_name || null,
          lastName: app.last_name || null,
          email: app.email || null,
          phone: app.phone || null,
          status: app.status || 'unknown',
          currentStage: app.current_stage || null,
          refererSource: app.referer_source || null,
          appliedAt,
          hiredAt: app.hired_at ? new Date(app.hired_at) : null,
          weekStart,
        }).onConflictDoUpdate({
          target: applicants.digestKey,
          set: {
            status: app.status || 'unknown',
            currentStage: app.current_stage || null,
            hiredAt: app.hired_at ? new Date(app.hired_at) : null,
            syncedAt: new Date(),
          },
        });
        
        synced++;
      } catch (err) {
        console.error(`[Workstream] Error syncing applicant ${app.digest_key}:`, err);
        errors++;
      }
    }
    
    console.log(`[Workstream] Sync complete: ${synced} synced, ${errors} errors`);
    return { synced, errors };
  } catch (err) {
    console.error("[Workstream] Sync failed:", err);
    throw err;
  }
}

export interface ApplicantsByWeek {
  weekStart: string;
  weekLabel: string;
  total: number;
  byLevel: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface ApplicantsByUnit {
  restaurantId: string;
  restaurantName: string;
  total: number;
  byLevel: Record<string, number>;
  hired: number;
}

export async function getApplicantsByWeek(weeks: number = 8): Promise<ApplicantsByWeek[]> {
  const results: ApplicantsByWeek[] = [];
  
  const weekStarts: string[] = [];
  const today = new Date();
  for (let i = 0; i < weeks; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (i * 7));
    weekStarts.push(getWeekStart(d));
  }
  
  for (const weekStart of weekStarts) {
    const rows = await db
      .select({
        positionLevel: applicants.positionLevel,
        status: applicants.status,
        count: sql<number>`count(*)::int`,
      })
      .from(applicants)
      .where(eq(applicants.weekStart, weekStart))
      .groupBy(applicants.positionLevel, applicants.status);
    
    const byLevel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    
    for (const row of rows) {
      const level = row.positionLevel || 'unknown';
      const status = row.status || 'unknown';
      byLevel[level] = (byLevel[level] || 0) + row.count;
      byStatus[status] = (byStatus[status] || 0) + row.count;
      total += row.count;
    }
    
    const weekDate = new Date(weekStart + 'T12:00:00Z');
    const weekLabel = weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    
    results.push({
      weekStart,
      weekLabel: `Week of ${weekLabel}`,
      total,
      byLevel,
      byStatus,
    });
  }
  
  return results;
}

export async function getApplicantsByUnit(): Promise<ApplicantsByUnit[]> {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoffWeek = getWeekStart(threeMonthsAgo);
  
  const rows = await db
    .select({
      restaurantId: applicants.restaurantId,
      positionLevel: applicants.positionLevel,
      status: applicants.status,
      count: sql<number>`count(*)::int`,
    })
    .from(applicants)
    .where(sql`${applicants.weekStart} >= ${cutoffWeek}`)
    .groupBy(applicants.restaurantId, applicants.positionLevel, applicants.status);
  
  const restaurantData: Record<string, { total: number; byLevel: Record<string, number>; hired: number }> = {};
  
  for (const row of rows) {
    const restId = row.restaurantId || 'unassigned';
    if (!restaurantData[restId]) {
      restaurantData[restId] = { total: 0, byLevel: {}, hired: 0 };
    }
    const level = row.positionLevel || 'unknown';
    restaurantData[restId].total += row.count;
    restaurantData[restId].byLevel[level] = (restaurantData[restId].byLevel[level] || 0) + row.count;
    if (row.status === 'hired') {
      restaurantData[restId].hired += row.count;
    }
  }
  
  const allRestaurants = await db.select().from(restaurants);
  const restaurantMap = new Map(allRestaurants.map(r => [r.id, r.name]));
  
  const results: ApplicantsByUnit[] = [];
  for (const [restaurantId, data] of Object.entries(restaurantData)) {
    results.push({
      restaurantId,
      restaurantName: restaurantMap.get(restaurantId) || 'Unassigned',
      total: data.total,
      byLevel: data.byLevel,
      hired: data.hired,
    });
  }
  
  results.sort((a, b) => b.total - a.total);
  return results;
}

export async function getApplicantsSummary(): Promise<{
  totalApplicants: number;
  thisWeek: number;
  hired: number;
  inProgress: number;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
}> {
  const currentWeek = getWeekStart(new Date());
  
  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(applicants);
  
  const [thisWeekResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(applicants)
    .where(eq(applicants.weekStart, currentWeek));
  
  const statusRows = await db
    .select({
      status: applicants.status,
      count: sql<number>`count(*)::int`,
    })
    .from(applicants)
    .groupBy(applicants.status);
  
  const levelRows = await db
    .select({
      positionLevel: applicants.positionLevel,
      count: sql<number>`count(*)::int`,
    })
    .from(applicants)
    .groupBy(applicants.positionLevel);
  
  const sourceRows = await db
    .select({
      refererSource: applicants.refererSource,
      count: sql<number>`count(*)::int`,
    })
    .from(applicants)
    .groupBy(applicants.refererSource);
  
  const byLevel: Record<string, number> = {};
  for (const row of levelRows) {
    byLevel[row.positionLevel || 'unknown'] = row.count;
  }
  
  const bySource: Record<string, number> = {};
  for (const row of sourceRows) {
    bySource[row.refererSource || 'unknown'] = row.count;
  }
  
  let hired = 0;
  let inProgress = 0;
  for (const row of statusRows) {
    if (row.status === 'hired') hired = row.count;
    if (row.status === 'in_progress') inProgress = row.count;
  }
  
  return {
    totalApplicants: totalResult?.count || 0,
    thisWeek: thisWeekResult?.count || 0,
    hired,
    inProgress,
    byLevel,
    bySource,
  };
}
