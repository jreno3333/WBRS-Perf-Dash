import { db } from "./db";
import { restaurants, dailyGoogleReviews } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

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

export async function fetchGoogleReviews(placeId: string): Promise<{ rating: number; reviewCount: number } | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  
  if (!apiKey) {
    console.log("[Google Places] API key not configured");
    return null;
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
      return null;
    }
    
    const data: GooglePlacesResponse = await response.json();
    
    if (data.rating === undefined) {
      console.log(`[Google Places] No rating data for place ${placeId}`);
      return null;
    }
    
    return {
      rating: data.rating,
      reviewCount: data.userRatingCount || 0,
    };
  } catch (error) {
    console.error(`[Google Places] Error fetching reviews for ${placeId}:`, error);
    return null;
  }
}

export async function syncGoogleReviewsForRestaurant(restaurantId: string, placeId: string): Promise<boolean> {
  const reviews = await fetchGoogleReviews(placeId);
  
  if (!reviews) {
    return false;
  }
  
  const today = new Date().toISOString().split('T')[0];
  
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
    return true;
  } catch (error) {
    console.error(`[Google Reviews] Error saving reviews for ${restaurantId}:`, error);
    return false;
  }
}

export async function syncAllGoogleReviews(): Promise<{ success: number; failed: number }> {
  const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
  
  let success = 0;
  let failed = 0;
  
  for (const restaurant of allRestaurants) {
    if (!restaurant.googlePlaceId) {
      continue;
    }
    
    const result = await syncGoogleReviewsForRestaurant(restaurant.id, restaurant.googlePlaceId);
    if (result) {
      success++;
    } else {
      failed++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  console.log(`[Google Reviews] Sync complete: ${success} success, ${failed} failed`);
  return { success, failed };
}

export async function markEndOfDaySnapshots(): Promise<number> {
  const today = new Date().toISOString().split('T')[0];
  
  const result = await db.update(dailyGoogleReviews)
    .set({ isFinalSnapshot: true })
    .where(eq(dailyGoogleReviews.date, today));
  
  console.log(`[Google Reviews] Marked ${today} records as final snapshots`);
  return 0;
}

export async function getGoogleReviewsForRestaurant(restaurantId: string, date?: string): Promise<{ rating: number; reviewCount: number } | null> {
  const targetDate = date || new Date().toISOString().split('T')[0];
  
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
  const targetDate = date || new Date().toISOString().split('T')[0];
  
  // Get yesterday's date for comparison
  const yesterday = new Date(targetDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  
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
