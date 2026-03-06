import { Router } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { restaurants, hourlySales } from "@shared/schema";
import { eq, and, gte, lte } from "drizzle-orm";

const router = Router();

// Get all restaurants
router.get("/api/restaurants", async (req, res) => {
  try {
    const restaurantList = await storage.getRestaurants();
    res.json(restaurantList);
  } catch (error) {
    console.error("Error fetching restaurants:", error);
    res.status(500).json({ error: "Failed to fetch restaurants" });
  }
});

// Update restaurant settings (open date, labor target, revenue ports, etc.)
router.patch("/api/restaurants/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { openDate, laborTarget, isActive, revenuePorts, googlePlaceId } = req.body;

    console.log(`[Restaurant Update] ID: ${id}, Body:`, JSON.stringify(req.body));

    const updates: Record<string, any> = {};
    if (openDate !== undefined) {
      updates.openDate = openDate || null;
    }
    if (laborTarget !== undefined) {
      updates.laborTarget = laborTarget;
    }
    if (isActive !== undefined) {
      updates.isActive = isActive;
    }
    if (revenuePorts !== undefined) {
      updates.revenuePorts = revenuePorts;
    }
    if (googlePlaceId !== undefined) {
      updates.googlePlaceId = googlePlaceId || null;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`[Restaurant Update] No valid fields to update`);
      return res.status(400).json({ error: "No valid fields to update" });
    }

    console.log(`[Restaurant Update] Applying updates:`, JSON.stringify(updates));
    await db.update(restaurants).set(updates).where(eq(restaurants.id, id));
    storage.invalidateRestaurantCache();

    const updatedRestaurant = await db.select().from(restaurants).where(eq(restaurants.id, id));
    console.log(`[Restaurant Update] Result:`, JSON.stringify(updatedRestaurant[0]));
    res.json(updatedRestaurant[0]);
  } catch (error) {
    console.error("Error updating restaurant:", error);
    res.status(500).json({ error: "Failed to update restaurant" });
  }
});

// Get position breakdown for a restaurant
router.get("/api/positions/:restaurantId", async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const dateStr = targetDate.toISOString().split('T')[0];

    // Fetch hourly data with position breakdown (filtered at DB level)
    const dateStart = new Date(`${dateStr}T00:00:00.000Z`);
    const dateEnd = new Date(`${dateStr}T23:59:59.999Z`);
    const records = await db.select().from(hourlySales).where(
      and(
        eq(hourlySales.restaurantId, restaurantId),
        gte(hourlySales.salesDate, dateStart),
        lte(hourlySales.salesDate, dateEnd)
      )
    );

    // Build response with position data per hour
    const result = records.map(r => {
      const positions = (r.positionBreakdown || {}) as Record<string, number>;
      const totalHours = Object.values(positions).reduce((sum, hrs) => sum + hrs, 0);
      return {
        hour: r.hour,
        totalHours: Math.round(totalHours * 100) / 100,
        positions,
      };
    }).sort((a, b) => a.hour - b.hour);

    res.json(result);
  } catch (error) {
    console.error("Error fetching position data:", error);
    res.status(500).json({ error: "Failed to fetch position data" });
  }
});

export default router;
