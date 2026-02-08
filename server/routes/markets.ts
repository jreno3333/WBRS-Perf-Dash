import { Router } from "express";
import { db } from "../db";
import { markets, restaurantMarkets } from "@shared/schema";
import { eq } from "drizzle-orm";

const router = Router();

// ============ MARKETS API ============
// Get all markets with their restaurant assignments
router.get("/api/markets", async (req, res) => {
  try {
    const allMarkets = await db.select().from(markets);
    const allAssignments = await db.select().from(restaurantMarkets);

    const marketsWithRestaurants = allMarkets.map(market => ({
      ...market,
      restaurantIds: allAssignments
        .filter(a => a.marketId === market.id)
        .map(a => a.restaurantId),
    }));

    res.json(marketsWithRestaurants);
  } catch (error) {
    console.error("Error fetching markets:", error);
    res.status(500).json({ error: "Failed to fetch markets" });
  }
});

// Create a new market
router.post("/api/markets", async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Market name is required" });
    }

    const [newMarket] = await db.insert(markets).values({
      name,
      color: color || "#6366f1",
    }).returning();

    res.json({ ...newMarket, restaurantIds: [] });
  } catch (error) {
    console.error("Error creating market:", error);
    res.status(500).json({ error: "Failed to create market" });
  }
});

// Update a market
router.patch("/api/markets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, restaurantIds } = req.body;

    // Update market details if provided
    if (name || color) {
      const updates: Partial<{ name: string; color: string }> = {};
      if (name) updates.name = name;
      if (color) updates.color = color;

      await db.update(markets).set(updates).where(eq(markets.id, id));
    }

    // Update restaurant assignments if provided
    if (restaurantIds !== undefined) {
      // Remove all existing assignments for this market
      await db.delete(restaurantMarkets).where(eq(restaurantMarkets.marketId, id));

      // Add new assignments
      if (restaurantIds.length > 0) {
        await db.insert(restaurantMarkets).values(
          restaurantIds.map((restaurantId: string) => ({
            restaurantId,
            marketId: id,
          }))
        );
      }
    }

    // Fetch updated market with assignments
    const [updatedMarket] = await db.select().from(markets).where(eq(markets.id, id));
    const assignments = await db.select().from(restaurantMarkets).where(eq(restaurantMarkets.marketId, id));

    res.json({
      ...updatedMarket,
      restaurantIds: assignments.map(a => a.restaurantId),
    });
  } catch (error) {
    console.error("Error updating market:", error);
    res.status(500).json({ error: "Failed to update market" });
  }
});

// Delete a market
router.delete("/api/markets/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Remove all restaurant assignments first
    await db.delete(restaurantMarkets).where(eq(restaurantMarkets.marketId, id));

    // Delete the market
    await db.delete(markets).where(eq(markets.id, id));

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting market:", error);
    res.status(500).json({ error: "Failed to delete market" });
  }
});

export default router;
