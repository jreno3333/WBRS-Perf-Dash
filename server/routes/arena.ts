import { Router, Request, Response } from "express";
import { db } from "../db";
import { arenaConfig, arenaBadgesEarned, arenaStreaks, arenaRecords, arenaMessages } from "@shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { DEFAULT_ARENA_CONFIG } from "../arena-default-config";

const router = Router();

const ARENA_ACCESS_KEY = process.env.ARENA_ACCESS_KEY || "mwb2026";

// Middleware to check arena access (key param OR authenticated session)
function requireArenaAccess(req: Request, res: Response, next: Function) {
  const key = req.query.key as string;
  if (key === ARENA_ACCESS_KEY) {
    return next();
  }
  if (req.session?.userId) {
    return next();
  }
  return res.status(403).json({ message: "Arena access denied. Provide ?key= parameter or log in." });
}

// GET /api/arena/config — returns current config (or seeds default)
router.get("/api/arena/config", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const rows = await db.select().from(arenaConfig).limit(1);
    if (rows.length === 0) {
      // Seed default config on first access
      const [inserted] = await db.insert(arenaConfig).values({
        config: DEFAULT_ARENA_CONFIG,
        updatedBy: "system",
      }).returning();
      return res.json({ config: inserted.config, id: inserted.id, updatedAt: inserted.updatedAt });
    }
    const row = rows[0];
    return res.json({ config: row.config, id: row.id, updatedAt: row.updatedAt });
  } catch (err: any) {
    console.error("Error fetching arena config:", err);
    return res.status(500).json({ message: "Failed to load arena config", error: err.message });
  }
});

// POST /api/arena/config — saves updated config (admin only)
router.post("/api/arena/config", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const { config } = req.body;
    if (!config) {
      return res.status(400).json({ message: "Missing config in request body" });
    }

    const rows = await db.select().from(arenaConfig).limit(1);
    let result;
    if (rows.length === 0) {
      [result] = await db.insert(arenaConfig).values({
        config,
        updatedBy: (req.session as any)?.email || "admin",
      }).returning();
    } else {
      [result] = await db.update(arenaConfig)
        .set({
          config,
          updatedAt: new Date(),
          updatedBy: (req.session as any)?.email || "admin",
        })
        .where(eq(arenaConfig.id, rows[0].id))
        .returning();
    }
    return res.json({ config: result.config, id: result.id, updatedAt: result.updatedAt });
  } catch (err: any) {
    console.error("Error saving arena config:", err);
    return res.status(500).json({ message: "Failed to save arena config", error: err.message });
  }
});

// GET /api/arena/badges — returns all earned badges with optional filters
router.get("/api/arena/badges", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const { restaurantId, entityType, badgeId, limit: limitStr } = req.query;
    const limit = parseInt(limitStr as string) || 100;

    let query = db.select().from(arenaBadgesEarned).orderBy(desc(arenaBadgesEarned.earnedAt)).limit(limit);

    const badges = await query;

    // Apply filters in JS since drizzle dynamic where chaining is verbose
    let filtered = badges;
    if (restaurantId) filtered = filtered.filter(b => b.restaurantId === restaurantId);
    if (entityType) filtered = filtered.filter(b => b.entityType === entityType);
    if (badgeId) filtered = filtered.filter(b => b.badgeId === badgeId);

    return res.json(filtered);
  } catch (err: any) {
    console.error("Error fetching arena badges:", err);
    return res.status(500).json({ message: "Failed to load badges", error: err.message });
  }
});

// GET /api/arena/streaks — returns active streaks
router.get("/api/arena/streaks", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const streaks = await db.select().from(arenaStreaks)
      .where(eq(arenaStreaks.streakActive, true))
      .orderBy(desc(arenaStreaks.streakCount));
    return res.json(streaks);
  } catch (err: any) {
    console.error("Error fetching arena streaks:", err);
    return res.status(500).json({ message: "Failed to load streaks", error: err.message });
  }
});

// GET /api/arena/records — returns company records
router.get("/api/arena/records", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const records = await db.select().from(arenaRecords)
      .orderBy(desc(arenaRecords.setAt));
    return res.json(records);
  } catch (err: any) {
    console.error("Error fetching arena records:", err);
    return res.status(500).json({ message: "Failed to load records", error: err.message });
  }
});

// GET /api/arena/messages — returns message log
router.get("/api/arena/messages", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const messages = await db.select().from(arenaMessages)
      .orderBy(desc(arenaMessages.sentAt))
      .limit(limit);
    return res.json(messages);
  } catch (err: any) {
    console.error("Error fetching arena messages:", err);
    return res.status(500).json({ message: "Failed to load messages", error: err.message });
  }
});

// POST /api/arena/messages — send a manual message
router.post("/api/arena/messages", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const { recipientEmail, recipientName, restaurantId, messageType, subject, message } = req.body;
    if (!message || !messageType) {
      return res.status(400).json({ message: "Missing required fields: message, messageType" });
    }

    const [msg] = await db.insert(arenaMessages).values({
      recipientEmail,
      recipientName,
      restaurantId,
      messageType,
      subject,
      message,
      auto: false,
      team: false,
    }).returning();

    return res.json(msg);
  } catch (err: any) {
    console.error("Error sending arena message:", err);
    return res.status(500).json({ message: "Failed to send message", error: err.message });
  }
});

// GET /api/arena/summary — quick stats for Command Center
router.get("/api/arena/summary", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    // Count badges earned today
    const badgesToday = await db.select({ count: sql<number>`count(*)` })
      .from(arenaBadgesEarned)
      .where(eq(arenaBadgesEarned.evalDate, today));

    // Count active streaks
    const activeStreaks = await db.select({ count: sql<number>`count(*)` })
      .from(arenaStreaks)
      .where(eq(arenaStreaks.streakActive, true));

    // Get longest active streak
    const longestStreak = await db.select()
      .from(arenaStreaks)
      .where(eq(arenaStreaks.streakActive, true))
      .orderBy(desc(arenaStreaks.streakCount))
      .limit(1);

    // Recent badges (last 10)
    const recentBadges = await db.select()
      .from(arenaBadgesEarned)
      .orderBy(desc(arenaBadgesEarned.earnedAt))
      .limit(10);

    // Total records
    const totalRecords = await db.select({ count: sql<number>`count(*)` })
      .from(arenaRecords);

    return res.json({
      badgesToday: Number(badgesToday[0]?.count || 0),
      activeStreaks: Number(activeStreaks[0]?.count || 0),
      longestStreak: longestStreak[0] || null,
      recentBadges,
      totalRecords: Number(totalRecords[0]?.count || 0),
      date: today,
    });
  } catch (err: any) {
    console.error("Error fetching arena summary:", err);
    return res.status(500).json({ message: "Failed to load summary", error: err.message });
  }
});

export default router;
