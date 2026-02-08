import { Router } from "express";
import { storage } from "../storage";

const router = Router();

// Get Google Reviews sync status
router.get("/api/google-reviews/status", async (req, res) => {
  try {
    const restaurants = await storage.getRestaurants();
    const configuredRestaurants = restaurants.filter(r => r.googlePlaceId);

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    const { getGoogleReviewsForAllRestaurants } = await import("../google-places");
    const reviewsMap = await getGoogleReviewsForAllRestaurants(todayStr);

    let totalReviewsToday = 0;
    let restaurantsWithData = 0;
    reviewsMap.forEach((value) => {
      restaurantsWithData++;
      totalReviewsToday += value.reviewCount;
    });

    res.json({
      credentialsConfigured: !!process.env.GOOGLE_PLACES_API_KEY,
      configuredCount: configuredRestaurants.length,
      totalRestaurants: restaurants.filter(r => r.isActive).length,
      restaurantsWithData,
      totalReviewsToday,
      dateChecked: todayStr,
    });
  } catch (error) {
    console.error("Error fetching Google reviews status:", error);
    res.status(500).json({ error: "Failed to fetch Google reviews status" });
  }
});

// Sync Google reviews for all restaurants
router.post("/api/google-reviews/sync", async (req, res) => {
  try {
    const { syncAllGoogleReviews } = await import("../google-places");
    const result = await syncAllGoogleReviews();
    res.json({
      message: "Google reviews sync completed",
      success: result.success,
      failed: result.failed,
    });
  } catch (error: any) {
    console.error("Error syncing Google reviews:", error);
    res.status(500).json({ error: error.message || "Failed to sync Google reviews" });
  }
});

// Get Google reviews for a specific restaurant
router.get("/api/google-reviews/:restaurantId", async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date } = req.query;

    const { getGoogleReviewsForRestaurant } = await import("../google-places");
    const reviews = await getGoogleReviewsForRestaurant(restaurantId, date ? String(date) : undefined);

    res.json({ restaurantId, reviews });
  } catch (error) {
    console.error("Error fetching Google reviews:", error);
    res.status(500).json({ error: "Failed to fetch Google reviews" });
  }
});

// Get Google reviews summary for all restaurants
router.get("/api/google-reviews/daily-summary", async (req, res) => {
  try {
    const { date } = req.query;

    const { getGoogleReviewsForAllRestaurants } = await import("../google-places");
    const reviewsMap = await getGoogleReviewsForAllRestaurants(date ? String(date) : undefined);

    const result: Record<string, { rating: number; reviewCount: number }> = {};
    reviewsMap.forEach((value, key) => {
      result[key] = value;
    });

    res.json({ date: date || new Date().toISOString().split('T')[0], reviews: result });
  } catch (error) {
    console.error("Error fetching Google reviews summary:", error);
    res.status(500).json({ error: "Failed to fetch Google reviews summary" });
  }
});

export default router;
