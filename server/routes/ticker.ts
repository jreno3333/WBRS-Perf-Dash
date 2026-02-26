import { Router, Request, Response } from "express";
import { db } from "../db";
import { tickerMessages, milestoneConfig, restaurants, hourlySales } from "@shared/schema";
import { eq, and, or, lte, gte, isNull, desc, sql } from "drizzle-orm";

const router = Router();

// ─── Public: Get active ticker messages ─────────────────────────────────────

router.get("/api/ticker/messages", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const messages = await db
      .select()
      .from(tickerMessages)
      .where(
        and(
          eq(tickerMessages.isActive, true),
          or(
            isNull(tickerMessages.scheduledAt),
            lte(tickerMessages.scheduledAt, now)
          ),
          or(
            isNull(tickerMessages.expiresAt),
            gte(tickerMessages.expiresAt, now)
          )
        )
      )
      .orderBy(desc(tickerMessages.createdAt))
      .limit(50);

    return res.json({ messages });
  } catch (error) {
    console.error("[ticker] Failed to fetch messages:", error);
    return res.status(500).json({ message: "Failed to fetch ticker messages" });
  }
});

// ─── Admin: Create a ticker message ─────────────────────────────────────────

router.post("/api/ticker/messages", async (req: Request, res: Response) => {
  try {
    const { message, type, priority, scheduledAt, expiresAt, restaurantId } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ message: "Message text is required" });
    }

    const [created] = await db
      .insert(tickerMessages)
      .values({
        message: message.trim(),
        type: type || "immediate",
        priority: priority || "normal",
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        restaurantId: restaurantId || null,
        createdBy: (req.session as any)?.userId || "admin",
      })
      .returning();

    return res.json({ message: created });
  } catch (error) {
    console.error("[ticker] Failed to create message:", error);
    return res.status(500).json({ message: "Failed to create ticker message" });
  }
});

// ─── Admin: Get all ticker messages (including expired/inactive) ────────────

router.get("/api/ticker/admin/messages", async (_req: Request, res: Response) => {
  try {
    const messages = await db
      .select()
      .from(tickerMessages)
      .orderBy(desc(tickerMessages.createdAt))
      .limit(100);

    return res.json({ messages });
  } catch (error) {
    console.error("[ticker] Failed to fetch admin messages:", error);
    return res.status(500).json({ message: "Failed to fetch ticker messages" });
  }
});

// ─── Admin: Update a ticker message ─────────────────────────────────────────

router.patch("/api/ticker/messages/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};

    if (req.body.message !== undefined) updates.message = req.body.message;
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
    if (req.body.priority !== undefined) updates.priority = req.body.priority;
    if (req.body.scheduledAt !== undefined) updates.scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    if (req.body.expiresAt !== undefined) updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;

    const [updated] = await db
      .update(tickerMessages)
      .set(updates)
      .where(eq(tickerMessages.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ message: "Message not found" });
    }

    return res.json({ message: updated });
  } catch (error) {
    console.error("[ticker] Failed to update message:", error);
    return res.status(500).json({ message: "Failed to update ticker message" });
  }
});

// ─── Admin: Delete a ticker message ─────────────────────────────────────────

router.delete("/api/ticker/messages/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [deleted] = await db
      .delete(tickerMessages)
      .where(eq(tickerMessages.id, id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ message: "Message not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[ticker] Failed to delete message:", error);
    return res.status(500).json({ message: "Failed to delete ticker message" });
  }
});

// ─── Milestone Config ───────────────────────────────────────────────────────

router.get("/api/ticker/milestone-config", async (_req: Request, res: Response) => {
  try {
    const [config] = await db.select().from(milestoneConfig).limit(1);

    if (!config) {
      // Return defaults
      return res.json({
        config: {
          id: null,
          isEnabled: false,
          milestoneTypes: {
            hourlyRecord: true,
            dailySalesRecord: true,
            fastestDriveThru: true,
            topCheckAverage: true,
            paceLeader: true,
          },
        },
      });
    }

    return res.json({ config });
  } catch (error) {
    console.error("[ticker] Failed to fetch milestone config:", error);
    return res.status(500).json({ message: "Failed to fetch milestone config" });
  }
});

router.put("/api/ticker/milestone-config", async (req: Request, res: Response) => {
  try {
    const { isEnabled, milestoneTypes } = req.body;

    const [existing] = await db.select().from(milestoneConfig).limit(1);

    if (existing) {
      const [updated] = await db
        .update(milestoneConfig)
        .set({
          isEnabled: isEnabled ?? existing.isEnabled,
          milestoneTypes: milestoneTypes ?? existing.milestoneTypes,
          updatedAt: new Date(),
          updatedBy: (req.session as any)?.userId || "admin",
        })
        .where(eq(milestoneConfig.id, existing.id))
        .returning();

      return res.json({ config: updated });
    } else {
      const [created] = await db
        .insert(milestoneConfig)
        .values({
          isEnabled: isEnabled ?? false,
          milestoneTypes: milestoneTypes ?? {
            hourlyRecord: true,
            dailySalesRecord: true,
            fastestDriveThru: true,
            topCheckAverage: true,
            paceLeader: true,
          },
          updatedBy: (req.session as any)?.userId || "admin",
        })
        .returning();

      return res.json({ config: created });
    }
  } catch (error) {
    console.error("[ticker] Failed to update milestone config:", error);
    return res.status(500).json({ message: "Failed to update milestone config" });
  }
});

// ─── Milestone Auto-Detection (called by scheduler or manually) ─────────────

router.post("/api/ticker/check-milestones", async (req: Request, res: Response) => {
  try {
    // Check if milestones are enabled
    const [config] = await db.select().from(milestoneConfig).limit(1);
    if (!config?.isEnabled) {
      return res.json({ milestones: [], message: "Milestones are disabled" });
    }

    const types = config.milestoneTypes as Record<string, boolean>;
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const currentHour = parseInt(
      now.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false })
    );

    const milestones: string[] = [];

    // Get all restaurants
    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const restaurantMap = new Map(allRestaurants.map(r => [r.id, r]));

    if (types.hourlyRecord) {
      // Check if any restaurant set an hourly sales record for the current hour
      // Compare current hour sales to same hour last 4 weeks
      const todayHourly = await db
        .select()
        .from(hourlySales)
        .where(
          and(
            eq(hourlySales.hour, currentHour - 1), // Check last completed hour
            sql`${hourlySales.salesDate}::date = ${dateStr}::date`
          )
        );

      for (const hourData of todayHourly) {
        const restaurant = restaurantMap.get(hourData.restaurantId);
        if (!restaurant) continue;
        const sales = parseFloat(hourData.actualSales);
        const lastWeek = parseFloat(hourData.pastActualSales || "0");

        if (sales > 0 && lastWeek > 0 && sales > lastWeek * 1.15) {
          const name = restaurant.unitNumber || restaurant.name;
          milestones.push(
            `Great job ${name}! $${sales.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} in hour ${currentHour - 1} - that's ${Math.round(((sales - lastWeek) / lastWeek) * 100)}% above last week!`
          );
        }
      }
    }

    if (types.paceLeader) {
      // Find the restaurant leading the pace (highest % ahead of last week)
      const todayAll = await db
        .select()
        .from(hourlySales)
        .where(sql`${hourlySales.salesDate}::date = ${dateStr}::date`);

      const salesByRestaurant: Record<string, { today: number; lastWeek: number }> = {};
      for (const h of todayAll) {
        if (!salesByRestaurant[h.restaurantId]) {
          salesByRestaurant[h.restaurantId] = { today: 0, lastWeek: 0 };
        }
        salesByRestaurant[h.restaurantId].today += parseFloat(h.actualSales);
        salesByRestaurant[h.restaurantId].lastWeek += parseFloat(h.pastActualSales || "0");
      }

      let bestPace = 0;
      let bestRestaurant = "";
      for (const [rid, totals] of Object.entries(salesByRestaurant)) {
        if (totals.lastWeek > 0) {
          const pace = ((totals.today - totals.lastWeek) / totals.lastWeek) * 100;
          if (pace > bestPace) {
            bestPace = pace;
            const r = restaurantMap.get(rid);
            bestRestaurant = r?.unitNumber || r?.name || rid;
          }
        }
      }

      if (bestPace > 5 && bestRestaurant) {
        milestones.push(
          `${bestRestaurant} is leading the pace race at +${bestPace.toFixed(1)}% vs last week!`
        );
      }
    }

    // Auto-create ticker messages for detected milestones
    for (const msg of milestones) {
      // Check if a similar milestone message already exists today
      const existing = await db
        .select()
        .from(tickerMessages)
        .where(
          and(
            eq(tickerMessages.type, "milestone"),
            eq(tickerMessages.message, msg),
            sql`${tickerMessages.createdAt}::date = ${dateStr}::date`
          )
        )
        .limit(1);

      if (existing.length === 0) {
        await db.insert(tickerMessages).values({
          message: msg,
          type: "milestone",
          priority: "high",
          isActive: true,
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // Expire after 4 hours
          createdBy: "system",
        });
      }
    }

    return res.json({ milestones, count: milestones.length });
  } catch (error) {
    console.error("[ticker] Failed to check milestones:", error);
    return res.status(500).json({ message: "Failed to check milestones" });
  }
});

export default router;
