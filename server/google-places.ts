import { db } from "./db";
import { restaurants, dailyGoogleReviews } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

// All other daily_* tables (daily_osat, hme_timer_data, hourly_labor, etc.) key
// their `date` column in Central time. The exec summary / dashboard queries also
// build their date ranges in Central time. We must write the same way here so a
// sync that runs after 6 PM Central (= midnight UTC) doesn't file today's row
// under tomorrow's date and disappear from the dashboard.
function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

interface GooglePlaceDetails {
  rating?: number;
  userRatingCount?: number;
  displayName?: {
    text: string;
  };
}

interface GooglePlacesResponse {
  rating?: number;
  userRatingCount?: number;
  displayName?: {
    text: string;
  };
}

export type FetchGoogleReviewsResult =
  | { ok: true; rating: number; reviewCount: number }
  | { ok: false; error: string };

export async function fetchGoogleReviews(placeId: string): Promise<FetchGoogleReviewsResult> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return { ok: false, error: "GOOGLE_PLACES_API_KEY not configured" };
  }

  try {
    const url = `https://places.googleapis.com/v1/places/${placeId}?fields=rating,userRatingCount,displayName&key=${apiKey}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Google Places] API error for ${placeId}: ${response.status} - ${errorText}`);
      // Try to extract a human-readable message from the Google error payload
      let msg = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed?.error?.message) msg = parsed.error.message;
      } catch {
        if (errorText) msg = errorText.slice(0, 300);
      }
      return { ok: false, error: msg };
    }

    const data: GooglePlacesResponse = await response.json();

    if (data.rating === undefined) {
      return { ok: false, error: "No rating data returned for this place" };
    }

    return {
      ok: true,
      rating: data.rating,
      reviewCount: data.userRatingCount || 0,
    };
  } catch (error) {
    console.error(`[Google Places] Error fetching reviews for ${placeId}:`, error);
    return { ok: false, error: error instanceof Error ? error.message : "Unknown fetch error" };
  }
}

export async function syncGoogleReviewsForRestaurant(restaurantId: string, placeId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const reviews = await fetchGoogleReviews(placeId);

  if (!reviews.ok) {
    return reviews;
  }

  const today = todayCentral();

  try {
    await db.insert(dailyGoogleReviews)
      .values({
        restaurantId,
        date: today,
        rating: reviews.rating.toFixed(1),
        reviewCount: reviews.reviewCount,
        isFinalSnapshot: false,
      })
      .onConflictDoUpdate({
        target: [dailyGoogleReviews.restaurantId, dailyGoogleReviews.date],
        set: {
          rating: reviews.rating.toFixed(1),
          reviewCount: reviews.reviewCount,
          lastSyncedAt: sql`NOW()`,
        },
      });

    console.log(`[Google Reviews] Synced ${restaurantId}: ${reviews.rating} stars (${reviews.reviewCount} reviews)`);
    return { ok: true };
  } catch (error) {
    console.error(`[Google Reviews] Error saving reviews for ${restaurantId}:`, error);
    return { ok: false, error: error instanceof Error ? error.message : "DB write failed" };
  }
}

export async function syncAllGoogleReviews(): Promise<{ success: number; failed: number; errors: string[] }> {
  const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));

  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const restaurant of allRestaurants) {
    if (!restaurant.googlePlaceId) {
      continue;
    }

    const result = await syncGoogleReviewsForRestaurant(restaurant.id, restaurant.googlePlaceId);
    if (result.ok) {
      success++;
    } else {
      failed++;
      // Collect unique error messages so the UI can surface the real reason
      if (!errors.includes(result.error)) errors.push(result.error);
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`[Google Reviews] Sync complete: ${success} success, ${failed} failed`);
  return { success, failed, errors };
}

export async function markEndOfDaySnapshots(): Promise<number> {
  const today = todayCentral();
  
  const result = await db.update(dailyGoogleReviews)
    .set({ isFinalSnapshot: true })
    .where(eq(dailyGoogleReviews.date, today));
  
  console.log(`[Google Reviews] Marked ${today} records as final snapshots`);
  return 0;
}

export async function getGoogleReviewsForRestaurant(restaurantId: string, date?: string): Promise<{ rating: number; reviewCount: number } | null> {
  const targetDate = date || todayCentral();
  
  const result = await db.select()
    .from(dailyGoogleReviews)
    .where(and(
      eq(dailyGoogleReviews.restaurantId, restaurantId),
      eq(dailyGoogleReviews.date, targetDate)
    ))
    .limit(1);
  
  if (result.length === 0 || !result[0].rating) {
    return null;
  }
  
  return {
    rating: parseFloat(result[0].rating),
    reviewCount: result[0].reviewCount || 0,
  };
}

export async function getGoogleReviewsForAllRestaurants(date?: string): Promise<Map<string, { rating: number; reviewCount: number; newReviewsToday: number }>> {
  const targetDate = date || todayCentral();

  // Get yesterday's date for comparison (string math to stay in Central, no UTC drift)
  const [yy, mm, dd] = targetDate.split("-").map(Number);
  const anchor = new Date(Date.UTC(yy, mm - 1, dd, 12));
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  const yesterdayStr = `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-${String(anchor.getUTCDate()).padStart(2, "0")}`;
  
  // Get today's reviews
  const todayResults = await db.select()
    .from(dailyGoogleReviews)
    .where(eq(dailyGoogleReviews.date, targetDate));
  
  // Get yesterday's reviews for comparison
  const yesterdayResults = await db.select()
    .from(dailyGoogleReviews)
    .where(eq(dailyGoogleReviews.date, yesterdayStr));
  
  // Build yesterday's count map
  const yesterdayMap = new Map<string, number>();
  for (const row of yesterdayResults) {
    yesterdayMap.set(row.restaurantId, row.reviewCount || 0);
  }
  
  const reviewsMap = new Map<string, { rating: number; reviewCount: number; newReviewsToday: number }>();
  
  for (const row of todayResults) {
    if (row.rating) {
      const todayCount = row.reviewCount || 0;
      const yesterdayCount = yesterdayMap.get(row.restaurantId) || todayCount; // If no yesterday data, assume no change
      const newReviews = Math.max(0, todayCount - yesterdayCount);
      
      reviewsMap.set(row.restaurantId, {
        rating: parseFloat(row.rating),
        reviewCount: todayCount,
        newReviewsToday: newReviews,
      });
    }
  }
  
  return reviewsMap;
}
