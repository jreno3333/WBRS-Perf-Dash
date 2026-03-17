import { Router } from "express";
import { db } from "../db";
import { helperRewards } from "@shared/schema";
import { eq, and, gte, lte } from "drizzle-orm";

const router = Router();

/** GET /api/helper-rewards?date=YYYY-MM-DD — get all helper rewards for a date */
router.get("/api/helper-rewards", async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;

    if (startDate && endDate) {
      // Range query for integration with scoring
      const rows = await db.select().from(helperRewards)
        .where(and(
          gte(helperRewards.date, startDate as string),
          lte(helperRewards.date, endDate as string),
        ));
      return res.json(rows);
    }

    if (date) {
      const rows = await db.select().from(helperRewards)
        .where(eq(helperRewards.date, date as string));
      return res.json(rows);
    }

    // Default: return last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startStr = thirtyDaysAgo.toISOString().split("T")[0];
    const rows = await db.select().from(helperRewards)
      .where(gte(helperRewards.date, startStr));
    return res.json(rows);
  } catch (error) {
    console.error("[helper-rewards] GET error:", error);
    return res.status(500).json({ message: "Failed to fetch helper rewards" });
  }
});

/** POST /api/helper-rewards — upsert a helper reward for a unit on a date */
router.post("/api/helper-rewards", async (req, res) => {
  try {
    const { restaurantId, date, points, note } = req.body;
    if (!restaurantId || !date || points === undefined) {
      return res.status(400).json({ message: "restaurantId, date, and points are required" });
    }
    if (typeof points !== "number" || points < 0) {
      return res.status(400).json({ message: "Points must be a non-negative number" });
    }

    // If points is 0, delete the record instead
    if (points === 0) {
      await db.delete(helperRewards)
        .where(and(
          eq(helperRewards.restaurantId, restaurantId),
          eq(helperRewards.date, date),
        ));
      return res.json({ deleted: true });
    }

    // Upsert: try insert, on conflict update
    const existing = await db.select().from(helperRewards)
      .where(and(
        eq(helperRewards.restaurantId, restaurantId),
        eq(helperRewards.date, date),
      ));

    if (existing.length > 0) {
      const [updated] = await db.update(helperRewards)
        .set({ points, note, createdBy: req.session?.userId || "unknown" })
        .where(eq(helperRewards.id, existing[0].id))
        .returning();
      return res.json(updated);
    }

    const [inserted] = await db.insert(helperRewards).values({
      restaurantId,
      date,
      points,
      note,
      createdBy: req.session?.userId || "unknown",
    }).returning();
    return res.json(inserted);
  } catch (error) {
    console.error("[helper-rewards] POST error:", error);
    return res.status(500).json({ message: "Failed to save helper reward" });
  }
});

/** DELETE /api/helper-rewards/:id — delete a specific helper reward */
router.delete("/api/helper-rewards/:id", async (req, res) => {
  try {
    await db.delete(helperRewards).where(eq(helperRewards.id, req.params.id));
    return res.json({ deleted: true });
  } catch (error) {
    console.error("[helper-rewards] DELETE error:", error);
    return res.status(500).json({ message: "Failed to delete helper reward" });
  }
});

export default router;

/** Helper to load all helper rewards for a given date (for scoring integration) */
export async function getHelperRewardsForDate(date: string): Promise<Map<string, number>> {
  try {
    const rows = await db.select().from(helperRewards)
      .where(eq(helperRewards.date, date));
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.restaurantId, row.points);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Helper to load helper rewards for a date range (for multi-day scoring) */
export async function getHelperRewardsForDateRange(startDate: string, endDate: string): Promise<Map<string, number>> {
  try {
    const rows = await db.select().from(helperRewards)
      .where(and(
        gte(helperRewards.date, startDate),
        lte(helperRewards.date, endDate),
      ));
    // Key: "YYYY-MM-DD-restaurantId" → points
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(`${row.date}-${row.restaurantId}`, row.points);
    }
    return map;
  } catch {
    return new Map();
  }
}
