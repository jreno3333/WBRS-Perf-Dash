import { Router, Request, Response } from "express";
import { db } from "../db";
import { tickerMessages, milestoneConfig, restaurants, hourlySales, hmeTimerData, posOrders } from "@shared/schema";
import { eq, and, or, lte, gte, isNull, desc, sql, ne } from "drizzle-orm";
import { getCentralTime } from "../utils/dates";

const router = Router();

// ─── Helper: Get end-of-day midnight Central ────────────────────────────────

function getEndOfDayCentral(): Date {
  const now = new Date();
  // Get current Central date
  const centralDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  // Parse to get the date components
  const [year, month, day] = centralDate.split("-").map(Number);

  // Create midnight of the NEXT day in Central (= end of today)
  // We'll approximate by using the offset. Central is UTC-6 (CST) or UTC-5 (CDT)
  const jan = new Date(year, 0, 1);
  const jul = new Date(year, 6, 1);
  const isDST = now.getTimezoneOffset() !== Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  // Use a simpler approach: set to 23:59:59 Central
  const endOfDay = new Date(`${centralDate}T23:59:59${isDST ? "-05:00" : "-06:00"}`);
  return endOfDay;
}

// ─── Helper: Format dollar amounts ──────────────────────────────────────────

function fmtDollars(val: number): string {
  return "$" + val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

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

// ─── Milestone Auto-Detection ───────────────────────────────────────────────
// Tiered system:
//   - "Great job" messages: beat your own 4-week best for that hour/day
//   - "NEW COMPANY RECORD" messages: beat the best ANY store has ever done
// All milestones expire at end of day (midnight Central)

export async function checkMilestones(): Promise<{ milestones: string[]; count: number }> {
  const [config] = await db.select().from(milestoneConfig).limit(1);
  if (!config?.isEnabled) {
    return { milestones: [], count: 0 };
  }

  const types = config.milestoneTypes as Record<string, boolean>;
  const { hour: centralHour, date: dateStr } = getCentralTime();
  const prevHour = centralHour === 0 ? 23 : centralHour - 1;
  const endOfDay = getEndOfDayCentral();

  const milestones: { msg: string; priority: "normal" | "high" | "urgent" }[] = [];

  // Get all active restaurants
  const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
  const restaurantMap = new Map(allRestaurants.map(r => [r.id, r]));

  // Build date strings for last 4 weeks (same day of week)
  const fourWeekDates: string[] = [];
  for (let w = 1; w <= 4; w++) {
    const d = new Date();
    d.setDate(d.getDate() - w * 7);
    fourWeekDates.push(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d));
  }

  // ── 1. Hourly Sales Record ──────────────────────────────────────────────

  if (types.hourlyRecord) {
    // Get today's sales for the last completed hour
    const todayHourly = await db
      .select()
      .from(hourlySales)
      .where(
        and(
          eq(hourlySales.hour, prevHour),
          sql`${hourlySales.salesDate}::date = ${dateStr}::date`
        )
      );

    for (const hourData of todayHourly) {
      const restaurant = restaurantMap.get(hourData.restaurantId);
      if (!restaurant) continue;
      const sales = parseFloat(hourData.actualSales);
      if (sales <= 0) continue;
      const name = restaurant.unitNumber || restaurant.name;

      // 4-week rolling best for THIS store at THIS hour
      const historicalForStore = await db
        .select({ actualSales: hourlySales.actualSales })
        .from(hourlySales)
        .where(
          and(
            eq(hourlySales.restaurantId, hourData.restaurantId),
            eq(hourlySales.hour, prevHour),
            sql`${hourlySales.salesDate}::date = ANY(ARRAY[${sql.join(fourWeekDates.map(d => sql`${d}::date`), sql`, `)}])`,
          )
        );

      const best4Week = Math.max(0, ...historicalForStore.map(h => parseFloat(h.actualSales)));

      // All-time company record for this hour (any store, any day)
      const [companyRecord] = await db
        .select({ maxSales: sql<string>`MAX(${hourlySales.actualSales}::numeric)` })
        .from(hourlySales)
        .where(
          and(
            eq(hourlySales.hour, prevHour),
            sql`${hourlySales.salesDate}::date < ${dateStr}::date` // Exclude today
          )
        );

      const allTimeBest = parseFloat(companyRecord?.maxSales || "0");

      if (allTimeBest > 0 && sales > allTimeBest) {
        // NEW COMPANY RECORD
        milestones.push({
          msg: `NEW COMPANY RECORD! ${name} just posted ${fmtDollars(sales)} at hour ${prevHour} - beating the previous record of ${fmtDollars(allTimeBest)}!`,
          priority: "urgent",
        });
      } else if (best4Week > 0 && sales > best4Week) {
        // Beat their own 4-week best
        const pctAbove = Math.round(((sales - best4Week) / best4Week) * 100);
        milestones.push({
          msg: `Great job ${name}! ${fmtDollars(sales)} at hour ${prevHour} - ${pctAbove}% above your 4-week best!`,
          priority: "high",
        });
      }
    }
  }

  // ── 2. Daily Sales Record (cumulative so far) ───────────────────────────

  if (types.dailySalesRecord && centralHour >= 12) {
    // Only check after noon so there's meaningful data
    const todayAll = await db
      .select()
      .from(hourlySales)
      .where(sql`${hourlySales.salesDate}::date = ${dateStr}::date`);

    // Sum today's sales by restaurant
    const todaySalesByStore: Record<string, number> = {};
    for (const h of todayAll) {
      todaySalesByStore[h.restaurantId] = (todaySalesByStore[h.restaurantId] || 0) + parseFloat(h.actualSales);
    }

    for (const [rid, todayTotal] of Object.entries(todaySalesByStore)) {
      if (todayTotal <= 0) continue;
      const restaurant = restaurantMap.get(rid);
      if (!restaurant) continue;
      const name = restaurant.unitNumber || restaurant.name;

      // Get same-day-of-week totals for last 4 weeks (through same hour for fair comparison)
      const historicalTotals: number[] = [];
      for (const histDate of fourWeekDates) {
        const [result] = await db
          .select({ total: sql<string>`COALESCE(SUM(${hourlySales.actualSales}::numeric), 0)` })
          .from(hourlySales)
          .where(
            and(
              eq(hourlySales.restaurantId, rid),
              sql`${hourlySales.salesDate}::date = ${histDate}::date`,
              lte(hourlySales.hour, prevHour) // Only compare through same hour
            )
          );
        historicalTotals.push(parseFloat(result?.total || "0"));
      }

      const best4WeekDaily = Math.max(0, ...historicalTotals);

      if (best4WeekDaily > 0 && todayTotal > best4WeekDaily * 1.05) {
        const pctAbove = Math.round(((todayTotal - best4WeekDaily) / best4WeekDaily) * 100);
        milestones.push({
          msg: `${name} is on a record-setting day! ${fmtDollars(todayTotal)} through hour ${prevHour} - ${pctAbove}% above the 4-week best pace!`,
          priority: "high",
        });
      }
    }
  }

  // ── 3. Fastest Drive-Thru Hour ──────────────────────────────────────────

  if (types.fastestDriveThru) {
    try {
      // Get today's HME data for the last completed hour
      const todayHme = await db
        .select()
        .from(hmeTimerData)
        .where(
          and(
            eq(hmeTimerData.date, dateStr),
            eq(hmeTimerData.hour, prevHour),
            sql`${hmeTimerData.carCount} >= 5` // Need meaningful volume
          )
        );

      if (todayHme.length > 0) {
        // Find the fastest store this hour
        let fastestTime = Infinity;
        let fastestStore = "";
        let fastestCars = 0;

        for (const hme of todayHme) {
          const avgTime = hme.avgServiceTime;
          if (avgTime > 0 && avgTime < fastestTime) {
            fastestTime = avgTime;
            const r = restaurantMap.get(hme.restaurantId);
            fastestStore = r?.unitNumber || r?.name || hme.restaurantId;
            fastestCars = hme.carCount;
          }
        }

        if (fastestStore && fastestTime < 180) {
          // Under 3 minutes is notable
          const mins = Math.floor(fastestTime / 60);
          const secs = fastestTime % 60;

          // Check company record for this hour
          const [companyBest] = await db
            .select({ bestTime: sql<string>`MIN(${hmeTimerData.avgServiceTime})` })
            .from(hmeTimerData)
            .where(
              and(
                eq(hmeTimerData.hour, prevHour),
                ne(hmeTimerData.date, dateStr),
                sql`${hmeTimerData.carCount} >= 5`
              )
            );

          const allTimeBestDT = parseInt(companyBest?.bestTime || "999");

          if (fastestTime < allTimeBestDT) {
            milestones.push({
              msg: `NEW DT RECORD! ${fastestStore} averaged ${mins}:${secs.toString().padStart(2, "0")} window time at hour ${prevHour} with ${fastestCars} cars!`,
              priority: "urgent",
            });
          } else {
            milestones.push({
              msg: `Fastest drive-thru at hour ${prevHour}: ${fastestStore} with ${mins}:${secs.toString().padStart(2, "0")} avg window time (${fastestCars} cars)!`,
              priority: "normal",
            });
          }
        }
      }
    } catch (e) {
      // HME data may not be available for all stores
    }
  }

  // ── 4. Top Check Average ────────────────────────────────────────────────

  if (types.topCheckAverage) {
    try {
      // Get POS check averages for the last completed hour
      const hourStart = new Date(`${dateStr}T${prevHour.toString().padStart(2, "0")}:00:00`);
      const hourEnd = new Date(`${dateStr}T${(prevHour + 1).toString().padStart(2, "0")}:00:00`);

      const checkAvgByStore = await db
        .select({
          storeNumber: posOrders.storeNumber,
          avgCheck: sql<string>`ROUND(AVG(${posOrders.orderTotal}::numeric), 2)`,
          orderCount: sql<string>`COUNT(*)`,
        })
        .from(posOrders)
        .where(
          and(
            sql`${posOrders.orderClosedAt} >= ${hourStart}`,
            sql`${posOrders.orderClosedAt} < ${hourEnd}`,
            sql`${posOrders.orderTotal}::numeric > 0`
          )
        )
        .groupBy(posOrders.storeNumber);

      if (checkAvgByStore.length > 0) {
        // Find best check average this hour (min 5 orders)
        let bestAvg = 0;
        let bestStore = "";
        let bestCount = 0;

        for (const store of checkAvgByStore) {
          const avg = parseFloat(store.avgCheck);
          const cnt = parseInt(store.orderCount);
          if (cnt >= 5 && avg > bestAvg) {
            bestAvg = avg;
            bestStore = store.storeNumber;
            bestCount = cnt;
          }
        }

        if (bestStore && bestAvg > 0) {
          // Find the restaurant name from unit number
          const matchedRestaurant = allRestaurants.find(r => r.unitNumber === bestStore);
          const displayName = matchedRestaurant?.unitNumber || matchedRestaurant?.name || bestStore;

          milestones.push({
            msg: `Highest check average at hour ${prevHour}: ${displayName} at $${bestAvg.toFixed(2)} across ${bestCount} orders!`,
            priority: "normal",
          });
        }
      }
    } catch (e) {
      // POS data may not be available
    }
  }

  // ── 5. Pace Leader of the Day (posted at 2 PM Central) ───────────────

  if (types.paceLeader && centralHour === 14) {
    // Single daily announcement at 2 PM — who is most ahead of last week
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

    // Rank all stores by pace %
    const paceRanking: { name: string; pace: number; todaySales: number; dollarsAhead: number }[] = [];
    for (const [rid, totals] of Object.entries(salesByRestaurant)) {
      if (totals.lastWeek > 500) {
        const pace = ((totals.today - totals.lastWeek) / totals.lastWeek) * 100;
        const r = restaurantMap.get(rid);
        paceRanking.push({
          name: r?.unitNumber || r?.name || rid,
          pace,
          todaySales: totals.today,
          dollarsAhead: totals.today - totals.lastWeek,
        });
      }
    }

    paceRanking.sort((a, b) => b.pace - a.pace);

    if (paceRanking.length > 0 && paceRanking[0].pace > 0) {
      const leader = paceRanking[0];
      milestones.push({
        msg: `Pace Leader of the Day: ${leader.name} at +${leader.pace.toFixed(1)}% vs last week (${fmtDollars(leader.todaySales)} today, ${fmtDollars(leader.dollarsAhead)} ahead)!`,
        priority: "high",
      });
    }
  }

  // ── Save milestones as ticker messages ──────────────────────────────────

  const savedMessages: string[] = [];

  for (const { msg, priority } of milestones) {
    // Dedup: check if this exact message already exists today
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
        priority,
        isActive: true,
        expiresAt: endOfDay, // Stays up rest of day
        createdBy: "system",
      });
      savedMessages.push(msg);
    }
  }

  return { milestones: savedMessages, count: savedMessages.length };
}

// API endpoint for manual trigger
router.post("/api/ticker/check-milestones", async (_req: Request, res: Response) => {
  try {
    const [config] = await db.select().from(milestoneConfig).limit(1);
    if (!config?.isEnabled) {
      return res.json({ milestones: [], count: 0, message: "Milestones are disabled" });
    }

    const result = await checkMilestones();
    return res.json(result);
  } catch (error) {
    console.error("[ticker] Failed to check milestones:", error);
    return res.status(500).json({ message: "Failed to check milestones" });
  }
});

export default router;
