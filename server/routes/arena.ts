import { Router, Request, Response } from "express";
import { db } from "../db";
import { arenaConfig, arenaBadgesEarned, arenaStreaks, arenaRecords, arenaMessages } from "@shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { DEFAULT_ARENA_CONFIG } from "../arena-default-config";
import { getCentralTime } from "../utils/dates";

const router = Router();

// Auto-create Arena tables if they don't exist (uses the app's own DB connection)
let tablesEnsured = false;
async function ensureArenaTables() {
  if (tablesEnsured) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS arena_config (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        config JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        updated_by TEXT
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS arena_badges_earned (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        badge_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_name TEXT,
        restaurant_id VARCHAR,
        earned_at TIMESTAMP DEFAULT NOW(),
        eval_date TEXT,
        eval_hour INTEGER,
        metric_value DECIMAL(10,2),
        shift_team_members JSONB,
        config_snapshot JSONB
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS arena_streaks (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_name TEXT,
        restaurant_id VARCHAR,
        streak_start TEXT NOT NULL,
        streak_count INTEGER NOT NULL DEFAULT 0,
        streak_active BOOLEAN NOT NULL DEFAULT TRUE,
        last_evaluated TEXT,
        highest_milestone INTEGER DEFAULT 0,
        ended_at TEXT
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS arena_records (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        record_type TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        holder_type TEXT NOT NULL,
        holder_name TEXT,
        restaurant_id VARCHAR,
        value DECIMAL(10,2) NOT NULL,
        set_at TIMESTAMP DEFAULT NOW(),
        eval_date TEXT,
        eval_hour INTEGER,
        team_members JSONB
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS arena_messages (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_email TEXT,
        recipient_name TEXT,
        restaurant_id VARCHAR,
        message_type TEXT NOT NULL,
        subject TEXT,
        message TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT NOW(),
        auto BOOLEAN NOT NULL DEFAULT TRUE,
        team BOOLEAN NOT NULL DEFAULT FALSE,
        badge_id TEXT
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS arena_badge_images (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        badge_id TEXT NOT NULL UNIQUE,
        image_url TEXT,
        uploaded_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Dedup indexes for idempotent badge awarding
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS arena_badges_earned_dedup_idx
        ON arena_badges_earned (badge_id, entity_id, eval_date, eval_hour)
        WHERE eval_hour IS NOT NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS arena_badges_earned_dedup_daily_idx
        ON arena_badges_earned (badge_id, entity_id, eval_date)
        WHERE eval_hour IS NULL
    `);
    tablesEnsured = true;
    console.log("Arena tables ensured.");
  } catch (err) {
    console.error("Failed to ensure arena tables:", err);
  }
}

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
    await ensureArenaTables();
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
    await ensureArenaTables();
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
    await ensureArenaTables();
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
    await ensureArenaTables();
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
    await ensureArenaTables();
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
    await ensureArenaTables();
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
    await ensureArenaTables();
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
    await ensureArenaTables();
    const today = getCentralTime().date;

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

// GET /api/arena/command-center — enhanced summary with real data
router.get("/api/arena/command-center", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    await ensureArenaTables();
    const { loadDayData, computeHourlyGradeScore, getGradeLabel } = await import("../arena-engine");

    const today = getCentralTime().date;
    const data = await loadDayData(today);

    // Count badges earned today
    const badgesToday = await db.select({ count: sql<number>`count(*)` })
      .from(arenaBadgesEarned)
      .where(eq(arenaBadgesEarned.evalDate, today));

    // Count team badges (where shift_team_members is not null)
    const teamBadgesToday = await db.select({ count: sql<number>`count(*)` })
      .from(arenaBadgesEarned)
      .where(and(eq(arenaBadgesEarned.evalDate, today), sql`shift_team_members IS NOT NULL`));

    // Count A+ hours today across all restaurants
    let aplusHoursToday = 0;
    for (const rest of data.activeRestaurants) {
      for (let h = 0; h < 24; h++) {
        const salesKey = `${rest.id}-${today}-${h}`;
        const sales = data.salesByKey.get(salesKey);
        if (!sales || sales.actualSales <= 0) continue;
        const labor = data.laborByKey.get(salesKey);
        if (!labor) continue;

        const lwDate = new Date(today + "T12:00:00Z");
        lwDate.setDate(lwDate.getDate() - 7);
        const lwDateStr = lwDate.toISOString().split("T")[0];
        const lwSales = data.salesByKey.get(`${rest.id}-${lwDateStr}-${h}`);
        const hme = data.hmeByKey.get(salesKey);
        const osat = data.osatByKey.get(salesKey);

        const score = computeHourlyGradeScore({
          actualSales: sales.actualSales,
          lastWeekSales: lwSales?.actualSales || 0,
          actualStaff: labor.employeeCount,
          projectedStaff: labor.projectedLabor / 10,
          avgDtTime: hme && hme.avgTotalTime > 0 ? hme.avgTotalTime : null,
          osatPercent: osat && osat.totalResponses > 0 ? osat.osatPercent : null,
          osatResponses: osat?.totalResponses || 0,
        });
        if (score >= 95) aplusHoursToday++;
      }
    }

    // Active streaks count
    const activeStreakCount = await db.select({ count: sql<number>`count(*)` })
      .from(arenaStreaks).where(eq(arenaStreaks.streakActive, true));

    // Top streak leaders
    const streakLeaders = await db.select().from(arenaStreaks)
      .where(eq(arenaStreaks.streakActive, true))
      .orderBy(desc(arenaStreaks.streakCount)).limit(10);

    // Company records (latest per type)
    const records = await db.execute(sql`
      SELECT DISTINCT ON (record_type) * FROM arena_records
      ORDER BY record_type, set_at DESC
    `);

    // Spotlight — leader with longest active streak or most badges today
    const spotlightBadges = await db.execute(sql`
      SELECT entity_id, entity_name, entity_type, restaurant_id, count(*) as badge_count,
             array_agg(badge_id) as badges, max(shift_team_members::text) as team
      FROM arena_badges_earned WHERE eval_date = ${today}
      GROUP BY entity_id, entity_name, entity_type, restaurant_id
      ORDER BY badge_count DESC LIMIT 1
    `);

    let spotlight = null;
    if (spotlightBadges.rows && spotlightBadges.rows.length > 0) {
      const s = spotlightBadges.rows[0] as any;
      spotlight = {
        entityName: s.entity_name, entityType: s.entity_type,
        restaurantId: s.restaurant_id, badgeCount: Number(s.badge_count),
        badges: s.badges || [],
      };
    } else if (streakLeaders.length > 0) {
      const top = streakLeaders[0];
      spotlight = {
        entityName: top.entityName, entityType: top.entityType,
        restaurantId: top.restaurantId, streakCount: top.streakCount,
        badges: [],
      };
    }

    return res.json({
      badgesToday: Number(badgesToday[0]?.count || 0),
      teamBadgesToday: Number(teamBadgesToday[0]?.count || 0),
      aplusHoursToday,
      activeStreaks: Number(activeStreakCount[0]?.count || 0),
      streakLeaders,
      companyRecords: records.rows || [],
      spotlight,
      date: today,
    });
  } catch (err: any) {
    console.error("Error fetching arena command center:", err);
    return res.status(500).json({ message: "Failed to load command center", error: err.message });
  }
});

// GET /api/arena/leaderboard — leader rankings with grades, streaks, badges
router.get("/api/arena/leaderboard", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    await ensureArenaTables();
    const { loadDayData, computeHourlyGradeScore, getGradeLabel } = await import("../arena-engine");

    const today = getCentralTime().date;
    const data = await loadDayData(today);

    // Get badges earned in last 30 days per leader
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const recentBadges = await db.select().from(arenaBadgesEarned)
      .where(and(
        eq(arenaBadgesEarned.entityType, "leader"),
        sql`eval_date >= ${thirtyDaysAgoStr}`
      ));

    // Get active streaks for leaders
    const activeStreaks = await db.select().from(arenaStreaks)
      .where(and(eq(arenaStreaks.entityType, "leader"), eq(arenaStreaks.streakActive, true)));

    const streakByEntity = new Map(activeStreaks.map(s => [s.entityId, s.streakCount ?? 0]));
    const badgesByEntity = new Map<string, string[]>();
    for (const b of recentBadges) {
      const list = badgesByEntity.get(b.entityId) || [];
      if (!list.includes(b.badgeId)) list.push(b.badgeId);
      badgesByEntity.set(b.entityId, list);
    }

    const leaders: any[] = [];

    for (const leader of data.leaderEmployees) {
      const userId = leader.sevenShiftsUserId;
      const hourlyScores: number[] = [];
      let primaryRestaurantId = "";
      const restHours = new Map<string, number>();
      let teamMembers: any[] = [];

      // Try to find leader in crew data first
      for (const rest of data.activeRestaurants) {
        for (let h = 0; h < 24; h++) {
          const crew = data.crewByKey.get(`${rest.id}-${today}-${h}`);
          if (!crew?.crewMembers?.length) continue;
          const wasWorking = crew.crewMembers.some((m: any) => m.userId === userId);
          if (!wasWorking) continue;

          restHours.set(rest.id, (restHours.get(rest.id) || 0) + 1);

          const salesKey = `${rest.id}-${today}-${h}`;
          const sales = data.salesByKey.get(salesKey);
          if (!sales || sales.actualSales <= 0) continue;
          const labor = data.laborByKey.get(salesKey);
          if (!labor) continue;

          const lwDate = new Date(today + "T12:00:00Z");
          lwDate.setDate(lwDate.getDate() - 7);
          const lwDateStr = lwDate.toISOString().split("T")[0];
          const lwSales = data.salesByKey.get(`${rest.id}-${lwDateStr}-${h}`);
          const hme = data.hmeByKey.get(salesKey);
          const osat = data.osatByKey.get(salesKey);

          const score = computeHourlyGradeScore({
            actualSales: sales.actualSales,
            lastWeekSales: lwSales?.actualSales || 0,
            actualStaff: labor.employeeCount,
            projectedStaff: labor.projectedLabor / 10,
            avgDtTime: hme && hme.avgTotalTime > 0 ? hme.avgTotalTime : null,
            osatPercent: osat && osat.totalResponses > 0 ? osat.osatPercent : null,
            osatResponses: osat?.totalResponses || 0,
          });
          hourlyScores.push(score);

          // Track team from last working hour
          teamMembers = crew.crewMembers.map((m: any) => `${m.firstName} ${m.lastName}`);
        }
      }

      // Fallback: if no crew data matched, use leader's assigned restaurant
      if (hourlyScores.length === 0 && leader.restaurantId) {
        const assignedRest = data.activeRestaurants.find(r => r.id === leader.restaurantId);
        if (assignedRest) {
          primaryRestaurantId = assignedRest.id;
          for (let h = 0; h < 24; h++) {
            const salesKey = `${assignedRest.id}-${today}-${h}`;
            const sales = data.salesByKey.get(salesKey);
            if (!sales || sales.actualSales <= 0) continue;
            const labor = data.laborByKey.get(salesKey);
            if (!labor) continue;

            const lwDate = new Date(today + "T12:00:00Z");
            lwDate.setDate(lwDate.getDate() - 7);
            const lwDateStr = lwDate.toISOString().split("T")[0];
            const lwSales = data.salesByKey.get(`${assignedRest.id}-${lwDateStr}-${h}`);
            const hme = data.hmeByKey.get(salesKey);
            const osat = data.osatByKey.get(salesKey);

            const score = computeHourlyGradeScore({
              actualSales: sales.actualSales,
              lastWeekSales: lwSales?.actualSales || 0,
              actualStaff: labor.employeeCount,
              projectedStaff: labor.projectedLabor / 10,
              avgDtTime: hme && hme.avgTotalTime > 0 ? hme.avgTotalTime : null,
              osatPercent: osat && osat.totalResponses > 0 ? osat.osatPercent : null,
              osatResponses: osat?.totalResponses || 0,
            });
            hourlyScores.push(score);
          }
        }
      }

      if (hourlyScores.length < 1) continue;

      // Determine primary restaurant
      if (!primaryRestaurantId) {
        let maxH = 0;
        restHours.forEach((hrs, rid) => { if (hrs > maxH) { maxH = hrs; primaryRestaurantId = rid; } });
      }
      const rest = data.activeRestaurants.find(r => r.id === primaryRestaurantId)
        || (leader.restaurantId ? data.activeRestaurants.find(r => r.id === leader.restaurantId) : null);

      const avgScore = hourlyScores.reduce((a, b) => a + b, 0) / hourlyScores.length;
      const entityId = String(userId);

      let displayPosition = leader.position || "";
      if (!displayPosition) displayPosition = leader.type === "asst_manager" || leader.type === "manager" ? "Manager" : "Leader";
      if (displayPosition === "asst_manager") displayPosition = "Manager";
      if (displayPosition.toLowerCase().includes("supervisor")) displayPosition = "Shift Supervisor";
      else if (displayPosition.toLowerCase().includes("manager")) displayPosition = "Manager";

      leaders.push({
        id: userId,
        name: `${leader.firstName} ${leader.lastName}`,
        store: rest?.unitNumber ? `#${rest.unitNumber}` : "",
        storeName: rest?.name || "",
        role: displayPosition,
        avgGradeScore: Math.round(avgScore * 10) / 10,
        todayGrade: getGradeLabel(avgScore),
        streak: streakByEntity.get(entityId) || 0,
        badges: badgesByEntity.get(entityId) || [],
        team: teamMembers,
      });
    }

    // Sort by avgGradeScore descending
    leaders.sort((a, b) => b.avgGradeScore - a.avgGradeScore);

    return res.json({ leaders });
  } catch (err: any) {
    console.error("Error fetching arena leaderboard:", err);
    return res.status(500).json({ message: "Failed to load leaderboard", error: err.message });
  }
});

// GET /api/arena/units — unit rankings with grades, streaks, badges
router.get("/api/arena/units", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    await ensureArenaTables();
    const { loadDayData, computeHourlyGradeScore, getGradeLabel } = await import("../arena-engine");

    const today = getCentralTime().date;
    const data = await loadDayData(today);

    // Get badges for units in last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const recentBadges = await db.select().from(arenaBadgesEarned)
      .where(and(eq(arenaBadgesEarned.entityType, "unit"), sql`eval_date >= ${thirtyDaysAgoStr}`));

    const activeStreaks = await db.select().from(arenaStreaks)
      .where(and(eq(arenaStreaks.entityType, "unit"), eq(arenaStreaks.streakActive, true)));

    const streakByEntity = new Map(activeStreaks.map(s => [s.entityId, s.streakCount ?? 0]));
    const badgesByEntity = new Map<string, string[]>();
    for (const b of recentBadges) {
      const list = badgesByEntity.get(b.entityId) || [];
      if (!list.includes(b.badgeId)) list.push(b.badgeId);
      badgesByEntity.set(b.entityId, list);
    }

    const units: any[] = [];
    for (const rest of data.activeRestaurants) {
      const hourlyScores: number[] = [];
      for (let h = 0; h < 24; h++) {
        const salesKey = `${rest.id}-${today}-${h}`;
        const sales = data.salesByKey.get(salesKey);
        if (!sales || sales.actualSales <= 0) continue;
        const labor = data.laborByKey.get(salesKey);
        if (!labor) continue;

        const lwDate = new Date(today + "T12:00:00Z");
        lwDate.setDate(lwDate.getDate() - 7);
        const lwDateStr = lwDate.toISOString().split("T")[0];
        const lwSales = data.salesByKey.get(`${rest.id}-${lwDateStr}-${h}`);
        const hme = data.hmeByKey.get(salesKey);
        const osat = data.osatByKey.get(salesKey);

        const score = computeHourlyGradeScore({
          actualSales: sales.actualSales,
          lastWeekSales: lwSales?.actualSales || 0,
          actualStaff: labor.employeeCount,
          projectedStaff: labor.projectedLabor / 10,
          avgDtTime: hme && hme.avgTotalTime > 0 ? hme.avgTotalTime : null,
          osatPercent: osat && osat.totalResponses > 0 ? osat.osatPercent : null,
          osatResponses: osat?.totalResponses || 0,
        });
        hourlyScores.push(score);
      }

      if (hourlyScores.length < 1) continue;
      const avgScore = hourlyScores.reduce((a, b) => a + b, 0) / hourlyScores.length;

      units.push({
        id: rest.unitNumber ? `#${rest.unitNumber}` : rest.id,
        name: rest.name,
        dailyGrade: getGradeLabel(avgScore),
        score: Math.round(avgScore * 10) / 10,
        streak: streakByEntity.get(rest.id) || 0,
        badges: badgesByEntity.get(rest.id) || [],
      });
    }

    units.sort((a, b) => b.score - a.score);
    return res.json({ units });
  } catch (err: any) {
    console.error("Error fetching arena units:", err);
    return res.status(500).json({ message: "Failed to load units", error: err.message });
  }
});

// GET /api/arena/debug — diagnostic: shows data counts for today
router.get("/api/arena/debug", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    const { loadDayData } = await import("../arena-engine");
    const today = getCentralTime().date;
    const dateOverride = req.query.date as string || today;
    const data = await loadDayData(dateOverride);

    return res.json({
      queryDate: dateOverride,
      centralTimeNow: getCentralTime(),
      salesRowCount: data.salesByKey.size,
      laborRowCount: data.laborByKey.size,
      hmeRowCount: data.hmeByKey.size,
      osatRowCount: data.osatByKey.size,
      crewRowCount: data.crewByKey.size,
      activeRestaurants: data.activeRestaurants.length,
      leaderEmployees: data.leaderEmployees.length,
      sampleSalesKeys: Array.from(data.salesByKey.keys()).slice(0, 5),
      sampleLaborKeys: Array.from(data.laborByKey.keys()).slice(0, 5),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/arena/evaluate — manual trigger for debug/backfill
router.post("/api/arena/evaluate", requireArenaAccess, async (req: Request, res: Response) => {
  try {
    await ensureArenaTables();
    const { runFullEvaluation } = await import("../arena-engine");
    const { date, type = "all" } = req.body;
    if (!date) return res.status(400).json({ message: "Missing date" });

    const result = await runFullEvaluation(date, type);
    return res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("Error running arena evaluation:", err);
    return res.status(500).json({ message: "Failed to run evaluation", error: err.message });
  }
});

export default router;
