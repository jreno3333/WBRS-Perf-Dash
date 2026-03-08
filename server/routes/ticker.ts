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

// ─── Helper: Format hour in a store's local timezone ────────────────────────

function fmtHourLocal(centralHour: number, timezone: string): string {
  // Build a date at the given Central hour today
  const { date: dateStr } = getCentralTime();
  const isDST = (() => {
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1);
    const jul = new Date(now.getFullYear(), 6, 1);
    return now.getTimezoneOffset() !== Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  })();
  const offset = isDST ? "-05:00" : "-06:00"; // Central offset
  const dt = new Date(`${dateStr}T${centralHour.toString().padStart(2, "0")}:00:00${offset}`);

  // Format in the restaurant's local timezone
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(dt);

  // Add short timezone abbreviation (e.g., "CT", "ET")
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(dt).find(p => p.type === "timeZoneName")?.value || "";

  return `${formatted} ${tzAbbr}`;
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
            hourlyRateBadge: true,
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
  // Uses CUMULATIVE sales through the hour (not just the single hour's sales)
  // so the dollar figures match what the dashboard displays.

  if (types.hourlyRecord) {
    // Get cumulative sales through prevHour for each restaurant today.
    // For each restaurant, sum the latest-scraped actual_sales for hours 0..prevHour.
    const todayCumResult = await db.execute(sql`
      SELECT restaurant_id, SUM(actual_sales::numeric) AS cum_sales
      FROM (
        SELECT DISTINCT ON (restaurant_id, hour) restaurant_id, actual_sales
        FROM hourly_sales
        WHERE hour <= ${prevHour} AND sales_date::date = ${dateStr}::date
        ORDER BY restaurant_id, hour, scraped_at DESC NULLS LAST
      ) sub
      GROUP BY restaurant_id
    `);
    const todayCum = (todayCumResult.rows || []) as { restaurant_id: string; cum_sales: string }[];

    for (const cumData of todayCum) {
      const restaurant = restaurantMap.get(cumData.restaurant_id);
      if (!restaurant) continue;
      const sales = parseFloat(cumData.cum_sales);
      if (sales <= 0) continue;
      const name = restaurant.unitNumber || restaurant.name;

      // 4-week rolling best cumulative sales through this hour for THIS store
      const historicalResult = await db.execute(sql`
        SELECT sales_date::date AS sd, SUM(actual_sales::numeric) AS cum_sales
        FROM (
          SELECT DISTINCT ON (sales_date::date, hour) sales_date, hour, actual_sales
          FROM hourly_sales
          WHERE restaurant_id = ${cumData.restaurant_id}
            AND hour <= ${prevHour}
            AND sales_date::date = ANY(ARRAY[${sql.join(fourWeekDates.map(d => sql`${d}::date`), sql`, `)}])
          ORDER BY sales_date::date, hour, scraped_at DESC NULLS LAST
        ) sub
        GROUP BY sales_date::date
      `);
      const historicalForStore = (historicalResult.rows || []) as { sd: string; cum_sales: string }[];

      const best4Week = Math.max(0, ...historicalForStore.map(h => parseFloat(h.cum_sales)));

      // All-time company record cumulative through this hour (any store, any day)
      const companyRecordResult = await db.execute(sql`
        SELECT MAX(cum_sales) AS max_sales
        FROM (
          SELECT restaurant_id, sales_date::date AS sd, SUM(actual_sales::numeric) AS cum_sales
          FROM (
            SELECT DISTINCT ON (restaurant_id, sales_date::date, hour) restaurant_id, sales_date, hour, actual_sales
            FROM hourly_sales
            WHERE hour <= ${prevHour} AND sales_date::date < ${dateStr}::date
            ORDER BY restaurant_id, sales_date::date, hour, scraped_at DESC NULLS LAST
          ) sub
          GROUP BY restaurant_id, sales_date::date
        ) day_totals
      `);
      const companyRecord = (companyRecordResult.rows?.[0] || {}) as { max_sales: string };

      const allTimeBest = parseFloat(companyRecord?.max_sales || "0");

      const localTime = fmtHourLocal(prevHour, restaurant.timezone || "America/Chicago");

      if (allTimeBest > 0 && sales > allTimeBest) {
        // NEW COMPANY RECORD
        milestones.push({
          msg: `NEW COMPANY RECORD! ${name} just posted ${fmtDollars(sales)} at ${localTime} - beating the previous record of ${fmtDollars(allTimeBest)}!`,
          priority: "urgent",
        });
      } else if (best4Week > 0 && sales > best4Week) {
        // Beat their own 4-week cumulative best through this hour
        const pctAbove = Math.round(((sales - best4Week) / best4Week) * 100);
        if (pctAbove >= 20) {
          const amountOver = sales - best4Week;
          const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long" }).format(new Date());
          milestones.push({
            msg: `Great job ${name}! ${fmtDollars(sales)} at ${localTime} - ${fmtDollars(amountOver)} more than your best ${dayName} at this hour in 4 weeks (+${pctAbove}%)!`,
            priority: "high",
          });
        }
      }
    }
  }

  // ── 2. Daily Sales Record (cumulative so far) ───────────────────────────

  if (types.dailySalesRecord && centralHour >= 12) {
    // Only check after noon so there's meaningful data
    // Use DISTINCT ON to get only the latest-scraped row per restaurant/hour
    const todayAllResult = await db.execute(sql`
      SELECT DISTINCT ON (restaurant_id, hour) restaurant_id, hour, actual_sales
      FROM hourly_sales
      WHERE sales_date::date = ${dateStr}::date
        AND hour <= ${prevHour}
      ORDER BY restaurant_id, hour, scraped_at DESC NULLS LAST
    `);
    const todayAll = (todayAllResult.rows || []) as { restaurant_id: string; hour: number; actual_sales: string }[];

    // Sum today's sales by restaurant
    const todaySalesByStore: Record<string, number> = {};
    for (const h of todayAll) {
      todaySalesByStore[h.restaurant_id] = (todaySalesByStore[h.restaurant_id] || 0) + parseFloat(h.actual_sales);
    }

    for (const [rid, todayTotal] of Object.entries(todaySalesByStore)) {
      if (todayTotal <= 0) continue;
      const restaurant = restaurantMap.get(rid);
      if (!restaurant) continue;
      const name = restaurant.unitNumber || restaurant.name;

      // Get same-day-of-week totals for last 4 weeks (through same hour for fair comparison)
      // Use a subquery with DISTINCT ON to deduplicate before summing
      const historicalTotals: number[] = [];
      for (const histDate of fourWeekDates) {
        const histResult = await db.execute(sql`
          SELECT COALESCE(SUM(actual_sales::numeric), 0) AS total
          FROM (
            SELECT DISTINCT ON (hour) actual_sales
            FROM hourly_sales
            WHERE restaurant_id = ${rid}
              AND sales_date::date = ${histDate}::date
              AND hour <= ${prevHour}
            ORDER BY hour, scraped_at DESC NULLS LAST
          ) sub
        `);
        const result = (histResult.rows?.[0] || {}) as { total: string };
        historicalTotals.push(parseFloat(result?.total || "0"));
      }

      const best4WeekDaily = Math.max(0, ...historicalTotals);

      if (best4WeekDaily > 0 && todayTotal > best4WeekDaily * 1.05) {
        const pctAbove = Math.round(((todayTotal - best4WeekDaily) / best4WeekDaily) * 100);
        // Get the day-of-week name for a clearer message
        const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long" }).format(new Date());
        milestones.push({
          msg: `${name} is outpacing their best ${dayName} in 4 weeks! ${fmtDollars(todayTotal)} through ${fmtHourLocal(prevHour, restaurant.timezone || "America/Chicago")} - ${pctAbove}% above the previous best.`,
          priority: "high",
        });
      }
    }
  }

  // ── 3. Best Drive-Thru Speed Attainment (% of orders under 6 min) ───────

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
        // Find the store with the highest speed attainment (% under 6 min) this hour
        let bestAttainment = 0;
        let bestStore = "";
        let bestRestaurant: typeof allRestaurants[0] | undefined;
        let bestCars = 0;
        let bestUnder6 = 0;

        for (const hme of todayHme) {
          if (hme.carCount <= 0) continue;
          const attainment = Math.round((hme.carsUnder6Min / hme.carCount) * 100);
          if (attainment > bestAttainment) {
            bestAttainment = attainment;
            const r = restaurantMap.get(hme.restaurantId);
            bestRestaurant = r;
            bestStore = r?.unitNumber || r?.name || hme.restaurantId;
            bestCars = hme.carCount;
            bestUnder6 = hme.carsUnder6Min;
          }
        }

        if (bestStore && bestAttainment > 0) {
          const localTime = fmtHourLocal(prevHour, bestRestaurant?.timezone || "America/Chicago");

          // Check this store's own best attainment for this hour in the last 4 weeks
          const historicalHme = await db
            .select({
              carCount: hmeTimerData.carCount,
              carsUnder6Min: hmeTimerData.carsUnder6Min,
            })
            .from(hmeTimerData)
            .where(
              and(
                eq(hmeTimerData.restaurantId, bestRestaurant?.id || ""),
                eq(hmeTimerData.hour, prevHour),
                sql`${hmeTimerData.date} = ANY(ARRAY[${sql.join(fourWeekDates.map(d => sql`${d}`), sql`, `)}])`,
                sql`${hmeTimerData.carCount} >= 5`
              )
            );

          const best4WeekAttainment = Math.max(0, ...historicalHme.map(h =>
            h.carCount > 0 ? Math.round((h.carsUnder6Min / h.carCount) * 100) : 0
          ));

          // Check company-wide all-time best attainment for this hour
          const companyBestResult = await db.execute(sql`
            SELECT car_count, cars_under_6_min
            FROM hme_timer_data
            WHERE hour = ${prevHour}
              AND date <> ${dateStr}
              AND car_count >= 5
          `);
          const companyRows = (companyBestResult.rows || []) as { car_count: number; cars_under_6_min: number }[];
          const allTimeBestAttainment = Math.max(0, ...companyRows.map(r =>
            r.car_count > 0 ? Math.round((r.cars_under_6_min / r.car_count) * 100) : 0
          ));

          if (allTimeBestAttainment > 0 && bestAttainment > allTimeBestAttainment) {
            milestones.push({
              msg: `NEW DT RECORD! ${bestStore} hit ${bestAttainment}% under 6 min at ${localTime} (${bestUnder6}/${bestCars} cars) - beating the previous record of ${allTimeBestAttainment}%!`,
              priority: "urgent",
            });
          } else if (best4WeekAttainment > 0 && bestAttainment > best4WeekAttainment) {
            milestones.push({
              msg: `Great speed ${bestStore}! ${bestAttainment}% under 6 min at ${localTime} (${bestUnder6}/${bestCars} cars) - above your 4-week best of ${best4WeekAttainment}%!`,
              priority: "high",
            });
          } else if (bestAttainment >= 70) {
            // Meeting the 70% goal is noteworthy
            milestones.push({
              msg: `Best DT speed at ${localTime}: ${bestStore} with ${bestAttainment}% under 6 min (${bestUnder6}/${bestCars} cars)!`,
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

          const localTime = fmtHourLocal(prevHour, matchedRestaurant?.timezone || "America/Chicago");
          milestones.push({
            msg: `Highest check average at ${localTime}: ${displayName} at $${bestAvg.toFixed(2)} across ${bestCount} orders!`,
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
    // Use DISTINCT ON to get only the latest-scraped row per restaurant/hour
    const paceResult = await db.execute(sql`
      SELECT DISTINCT ON (restaurant_id, hour) restaurant_id, actual_sales, past_actual_sales
      FROM hourly_sales
      WHERE sales_date::date = ${dateStr}::date
      ORDER BY restaurant_id, hour, scraped_at DESC NULLS LAST
    `);
    const paceRows = (paceResult.rows || []) as { restaurant_id: string; actual_sales: string; past_actual_sales: string | null }[];

    const salesByRestaurant: Record<string, { today: number; lastWeek: number }> = {};
    for (const h of paceRows) {
      if (!salesByRestaurant[h.restaurant_id]) {
        salesByRestaurant[h.restaurant_id] = { today: 0, lastWeek: 0 };
      }
      salesByRestaurant[h.restaurant_id].today += parseFloat(h.actual_sales);
      salesByRestaurant[h.restaurant_id].lastWeek += parseFloat(h.past_actual_sales || "0");
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

  // ── 6. Hourly Rate Badges ($750+ Contender → $2300+ Legendary) ─────────

  if (types.hourlyRateBadge) {
    // Check each store's best single-hour sales for today
    const todayHourlyAllResult = await db.execute(sql`
      SELECT DISTINCT ON (restaurant_id, hour) restaurant_id, hour, actual_sales
      FROM hourly_sales
      WHERE sales_date::date = ${dateStr}::date
      ORDER BY restaurant_id, hour, scraped_at DESC NULLS LAST
    `);
    const todayHourlyAll = (todayHourlyAllResult.rows || []) as { restaurant_id: string; hour: number; actual_sales: string }[];

    // Find each store's peak hour
    const peakByStore: Record<string, { sales: number; hour: number }> = {};
    for (const row of todayHourlyAll) {
      const sales = parseFloat(row.actual_sales);
      if (!peakByStore[row.restaurant_id] || sales > peakByStore[row.restaurant_id].sales) {
        peakByStore[row.restaurant_id] = { sales, hour: row.hour };
      }
    }

    const RATE_TIERS = [
      { threshold: 2300, label: "LEGENDARY", emoji: "🏆" },
      { threshold: 2000, label: "ULTRA", emoji: "💎" },
      { threshold: 1500, label: "ELITE", emoji: "🔥" },
      { threshold: 1000, label: "PRO", emoji: "⭐" },
      { threshold: 750, label: "CONTENDER", emoji: "💪" },
    ];

    for (const [rid, peak] of Object.entries(peakByStore)) {
      if (peak.sales < 750) continue;
      const restaurant = restaurantMap.get(rid);
      if (!restaurant) continue;
      const name = restaurant.unitNumber || restaurant.name;
      const localTime = fmtHourLocal(peak.hour, restaurant.timezone || "America/Chicago");

      // Find the highest tier achieved
      const tier = RATE_TIERS.find(t => peak.sales >= t.threshold);
      if (tier) {
        milestones.push({
          msg: `${tier.emoji} ${name} earned ${tier.label} status! ${fmtDollars(peak.sales)}/hr at ${localTime}!`,
          priority: tier.threshold >= 2000 ? "urgent" : tier.threshold >= 1000 ? "high" : "normal",
        });
      }
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
