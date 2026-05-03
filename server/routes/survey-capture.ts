import { Router } from "express";
import { db, posDb } from "../db";
import { osatData, restaurants, locationMapping, restaurantMarkets, markets, posOrders } from "@shared/schema";
import { and, gte, lte, eq, sql } from "drizzle-orm";

const router = Router();

const DAYPARTS = [
  { id: "earlybird",     label: "Earlybird",     shortLabel: "EB",  startHour: 0,  endHour: 5  },
  { id: "breakfast",     label: "Breakfast",     shortLabel: "BRK", startHour: 6,  endHour: 10 },
  { id: "lunch",         label: "Lunch",         shortLabel: "LCH", startHour: 11, endHour: 14 },
  { id: "snack",         label: "Snack",         shortLabel: "SNK", startHour: 15, endHour: 16 },
  { id: "evening",       label: "Evening",       shortLabel: "EVE", startHour: 17, endHour: 19 },
  { id: "evening_snack", label: "Evening Snack", shortLabel: "ES",  startHour: 20, endHour: 23 },
];

function daypartIdForHour(hour: number): string {
  for (const dp of DAYPARTS) {
    if (hour >= dp.startHour && hour <= dp.endHour) return dp.id;
  }
  return "evening_snack";
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Day-of-week from a YYYY-MM-DD string (interpreted as Central-local date).
// Using UTC math on a noon-anchored date avoids any TZ rollover issues.
function dowFromDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

router.get("/api/executive-summary/survey-capture", async (req, res) => {
  try {
    const { days = "7", date } = req.query;
    const numDays = Math.max(1, Math.min(parseInt(days as string) || 7, 90));

    // Date range — anchored to America/Chicago, default ends yesterday
    let endDate: Date;
    if (date) {
      endDate = new Date((date as string) + "T12:00:00Z");
    } else {
      endDate = new Date();
      const todayStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      endDate = new Date(todayStr + "T12:00:00Z");
      endDate.setDate(endDate.getDate() - 1);
    }
    const endDateStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - numDays + 1);
    const startDateStr = startDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // ------------------------------------------------------------------
    // Parallel queries
    // ------------------------------------------------------------------
    const [
      restaurantList,
      locMapRows,
      marketAssignments,
      marketRows,
      osatHourly,        // [{ restaurantId, date, hour, totalResponses, fiveStarCount }]
      posHourly,         // [{ storeNumber, date, hour, orderCount }]
    ] = await Promise.all([
      db.select().from(restaurants).where(eq(restaurants.isActive, true)),
      db.select().from(locationMapping),
      db.select().from(restaurantMarkets),
      db.select().from(markets),
      db.select({
        restaurantId: osatData.restaurantId,
        date: osatData.date,
        hour: osatData.hour,
        totalResponses: osatData.totalResponses,
        fiveStarCount: osatData.fiveStarCount,
      })
        .from(osatData)
        .where(and(gte(osatData.date, startDateStr), lte(osatData.date, endDateStr))),
      posDb.select({
        storeNumber: posOrders.storeNumber,
        date: sql<string>`(${posOrders.orderClosedAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date::text`,
        hour: sql<number>`EXTRACT(HOUR FROM (${posOrders.orderClosedAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago'))::int`,
        orderCount: sql<string>`COUNT(*)`,
      })
        .from(posOrders)
        .where(and(
          gte(posOrders.orderClosedAt, sql`(${startDateStr}::timestamp AT TIME ZONE 'America/Chicago')`),
          sql`${posOrders.orderClosedAt} < ((${endDateStr}::date + interval '1 day')::timestamp AT TIME ZONE 'America/Chicago')`,
        ))
        .groupBy(
          posOrders.storeNumber,
          sql`(${posOrders.orderClosedAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date`,
          sql`EXTRACT(HOUR FROM (${posOrders.orderClosedAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago'))`,
        ),
    ]);

    // Lookup maps
    const storeToRestaurant = new Map<string, string>();
    for (const lm of locMapRows) storeToRestaurant.set(lm.xenialStoreNumber, lm.restaurantId);

    const marketNameById = new Map(marketRows.map(m => [m.id, m.name]));
    const restaurantToMarket = new Map<string, { id: string; name: string }>();
    for (const a of marketAssignments) {
      const name = marketNameById.get(a.marketId);
      if (name) restaurantToMarket.set(a.restaurantId, { id: a.marketId, name });
    }

    // ------------------------------------------------------------------
    // Aggregation buckets
    // ------------------------------------------------------------------
    type Bucket = { responses: number; fiveStars: number; transactions: number };
    const newBucket = (): Bucket => ({ responses: 0, fiveStars: 0, transactions: 0 });

    const company = newBucket();
    const byDow = new Map<number, Bucket>();
    const byDaypart = new Map<string, Bucket>();
    const byRest = new Map<string, Bucket>();

    // OSAT hourly → all buckets
    for (const row of osatHourly) {
      const responses = row.totalResponses || 0;
      const fiveStars = row.fiveStarCount || 0;
      if (responses === 0) continue;

      const dow = dowFromDateStr(row.date);
      const dpId = daypartIdForHour(row.hour);

      company.responses += responses;
      company.fiveStars += fiveStars;

      const dowB = byDow.get(dow) || newBucket();
      dowB.responses += responses; dowB.fiveStars += fiveStars;
      byDow.set(dow, dowB);

      const dpB = byDaypart.get(dpId) || newBucket();
      dpB.responses += responses; dpB.fiveStars += fiveStars;
      byDaypart.set(dpId, dpB);

      const rB = byRest.get(row.restaurantId) || newBucket();
      rB.responses += responses; rB.fiveStars += fiveStars;
      byRest.set(row.restaurantId, rB);
    }

    // POS hourly → transactions
    for (const row of posHourly) {
      const restId = storeToRestaurant.get(row.storeNumber);
      if (!restId) continue;
      const txns = parseInt(row.orderCount as any) || 0;
      if (txns === 0) continue;

      const hour = Number(row.hour) || 0;
      const dow = dowFromDateStr(row.date);
      const dpId = daypartIdForHour(hour);

      company.transactions += txns;

      const dowB = byDow.get(dow) || newBucket();
      dowB.transactions += txns;
      byDow.set(dow, dowB);

      const dpB = byDaypart.get(dpId) || newBucket();
      dpB.transactions += txns;
      byDaypart.set(dpId, dpB);

      const rB = byRest.get(restId) || newBucket();
      rB.transactions += txns;
      byRest.set(restId, rB);
    }

    // ------------------------------------------------------------------
    // Format output
    // ------------------------------------------------------------------
    const ratePer1000 = (b: Bucket) => b.transactions > 0 ? (b.responses / b.transactions) * 1000 : null;
    const osatPct     = (b: Bucket) => b.responses > 0 ? (b.fiveStars / b.responses) * 100 : null;

    const dowOut = Array.from({ length: 7 }, (_, i) => {
      const b = byDow.get(i) || newBucket();
      return {
        dow: i,
        label: DOW_LABELS[i],
        responses: b.responses,
        transactions: b.transactions,
        surveysPer1000: ratePer1000(b),
        osatPct: osatPct(b),
      };
    });

    const daypartOut = DAYPARTS.map(dp => {
      const b = byDaypart.get(dp.id) || newBucket();
      return {
        id: dp.id,
        label: dp.label,
        shortLabel: dp.shortLabel,
        startHour: dp.startHour,
        endHour: dp.endHour,
        responses: b.responses,
        transactions: b.transactions,
        surveysPer1000: ratePer1000(b),
        osatPct: osatPct(b),
      };
    });

    const restaurantOut = restaurantList.map(r => {
      const b = byRest.get(r.id) || newBucket();
      const market = restaurantToMarket.get(r.id);
      return {
        id: r.id,
        name: r.name,
        unitNumber: r.unitNumber,
        marketId: market?.id ?? null,
        marketName: market?.name ?? null,
        responses: b.responses,
        transactions: b.transactions,
        surveysPer1000: ratePer1000(b),
        osatPct: osatPct(b),
      };
    }).filter(r => r.transactions > 0); // hide units with no POS activity in window

    res.json({
      dateRange: { start: startDateStr, end: endDateStr, days: numDays },
      thresholds: {
        // Industry rule of thumb: ~5 surveys per 1000 transactions is healthy for QSR
        healthyMin: 5,
        warningMin: 3,
      },
      company: {
        responses: company.responses,
        transactions: company.transactions,
        surveysPer1000: ratePer1000(company),
        osatPct: osatPct(company),
      },
      byDayOfWeek: dowOut,
      byDaypart: daypartOut,
      byRestaurant: restaurantOut,
    });
  } catch (error) {
    console.error("[survey-capture] error:", error);
    res.status(500).json({ message: "Failed to compute survey capture" });
  }
});

export default router;
