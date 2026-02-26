import { db, posDb } from "./db";
import { posOrders, locationMapping, restaurants } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

// Ensures the destination column exists before queries/inserts reference it.
// Only runs the ALTER TABLE once per server lifetime.
let destinationColumnEnsured = false;
async function ensureDestinationColumn() {
  if (destinationColumnEnsured) return;
  try {
    await posDb.execute(sql`ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS destination TEXT`);
    destinationColumnEnsured = true;
  } catch (e) {
    console.error("[Xenial] Failed to ensure destination column:", e);
  }
}

interface XenialOrderData {
  _id: string;
  origin?: string;
  store_number?: string;
  net_sales?: number | string;
  gross_sales?: number | string;
  net_amount?: number | string;
  total?: number | string;
  subtotal?: number | string;
  business_date?: string;
  closed?: string; // Legacy flat format
  time?: {
    closed?: string;
    created?: string;
    open?: string;
    first_item_added?: string;
  };
  state?: string;
  order_source?: string;
  destination?: {
    name?: string;
    short_name?: string;
  };
  payments?: Array<{ amount?: number | string }>;
}

interface XenialWebhookPayload {
  entityName: string;
  data: XenialOrderData;
}

export async function processXenialOrder(payload: XenialWebhookPayload): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const { entityName, data } = payload;
    
    if (entityName !== "Order" || !data) {
      return { success: false, error: "Invalid payload: not an Order entity" };
    }

    const orderId = data._id;
    if (!orderId) {
      return { success: false, error: "Missing order ID" };
    }

    const storeNumber = String(data.origin || data.store_number || "");
    if (!storeNumber) {
      return { success: false, error: "Missing store number" };
    }

    // Parse net sales - prioritize net_sales (excludes tax), then subtotal, then total
    const rawAmount = data.net_sales ?? data.subtotal ?? data.net_amount ?? data.total ?? 0;
    const orderTotal = typeof rawAmount === 'string' ? parseFloat(rawAmount) : Number(rawAmount);
    
    if (isNaN(orderTotal) || orderTotal <= 0) {
      return { success: false, error: `Invalid order amount: ${rawAmount}` };
    }

    const businessDateStr = data.business_date;
    // Handle nested time.closed or flat closed field
    const closedStr = data.time?.closed || data.closed;
    
    if (!businessDateStr) {
      return { success: false, error: "Missing business_date" };
    }
    
    if (!closedStr) {
      return { success: false, error: "Missing closed time (expected time.closed or closed field)" };
    }

    // Parse dates - handle ISO string format
    const businessDate = new Date(businessDateStr);
    if (isNaN(businessDate.getTime())) {
      return { success: false, error: "Invalid business date format" };
    }
    businessDate.setUTCHours(12, 0, 0, 0);
    
    const orderClosedAt = new Date(closedStr);
    if (isNaN(orderClosedAt.getTime())) {
      return { success: false, error: "Invalid closed date format" };
    }

    // Determine order source from destination or use POS as default
    const orderSource = data.order_source || data.destination?.short_name || data.destination?.name || "POS";
    // Store raw destination separately for destination-specific tracking (e.g. dt3 = outside lane)
    const destination = data.destination?.short_name || data.destination?.name || null;

    await ensureDestinationColumn();

    await posDb.insert(posOrders).values({
      xenialOrderId: orderId,
      storeNumber: storeNumber,
      orderTotal: orderTotal.toFixed(2),
      businessDate: businessDate,
      orderClosedAt: orderClosedAt,
      orderSource: orderSource,
      destination: destination,
      rawJson: JSON.stringify(payload),
    }).onConflictDoUpdate({
      target: posOrders.xenialOrderId,
      set: {
        orderTotal: orderTotal.toFixed(2),
        orderClosedAt: orderClosedAt,
        orderSource: orderSource,
        destination: destination,
        rawJson: JSON.stringify(payload),
      },
    });

    console.log(`[Xenial] Saved order ${orderId} | Store ${storeNumber} | $${orderTotal.toFixed(2)} | Source: ${orderSource}`);
    return { success: true, orderId };
  } catch (error) {
    console.error("Error processing Xenial order:", error);
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function getPosOrdersSummary(targetDate: Date): Promise<Map<string, { orders: number; total: number }>> {
  const startOfDay = new Date(targetDate);
  startOfDay.setUTCHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setUTCHours(23, 59, 59, 999);

  const results = await posDb
    .select({
      storeNumber: posOrders.storeNumber,
      orderCount: sql<number>`count(*)::int`,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .where(
      and(
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(posOrders.storeNumber);

  const summary = new Map<string, { orders: number; total: number }>();
  for (const row of results) {
    summary.set(row.storeNumber, {
      orders: row.orderCount,
      total: Number(row.totalSales) || 0,
    });
  }

  return summary;
}

export async function getHourlyPosSales(storeNumber: string, targetDate: Date): Promise<Map<number, number>> {
  const startOfDay = new Date(targetDate);
  startOfDay.setUTCHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setUTCHours(23, 59, 59, 999);

  const results = await posDb
    .select({
      hour: sql<number>`extract(hour from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')::int`,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.storeNumber, storeNumber),
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(sql`extract(hour from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')`);

  const hourlyData = new Map<number, number>();
  for (const row of results) {
    hourlyData.set(row.hour, Number(row.totalSales) || 0);
  }

  return hourlyData;
}

// Get POS sales aggregated by restaurant ID (using location_mapping to convert store numbers)
export async function getPosSalesByRestaurant(targetDate: Date): Promise<Map<string, number>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  // First, get location mappings from main database
  const mappings = await db.select().from(locationMapping);
  const storeToRestaurantId = new Map<string, string>();
  for (const mapping of mappings) {
    if (mapping.restaurantId) {
      storeToRestaurantId.set(mapping.xenialStoreNumber, mapping.restaurantId);
    }
  }

  // Query POS orders from posDb (may be separate database)
  const results = await posDb
    .select({
      storeNumber: posOrders.storeNumber,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .where(
      and(
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(posOrders.storeNumber);

  // Map store numbers to restaurant IDs in application code
  const salesByRestaurant = new Map<string, number>();
  for (const row of results) {
    const restaurantId = storeToRestaurantId.get(row.storeNumber);
    if (restaurantId) {
      salesByRestaurant.set(restaurantId, Number(row.totalSales) || 0);
    }
  }

  return salesByRestaurant;
}

// Get hourly POS sales by restaurant ID for a specific date
export async function getHourlyPosSalesByRestaurant(restaurantId: string, targetDate: Date): Promise<Map<number, number>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  // First, get the store number for this restaurant from location_mapping
  const mapping = await db.select()
    .from(locationMapping)
    .where(eq(locationMapping.restaurantId, restaurantId))
    .limit(1);
  
  if (mapping.length === 0) {
    return new Map<number, number>();
  }

  const storeNumber = mapping[0].xenialStoreNumber;

  // Query POS orders from posDb (may be separate database)
  const results = await posDb
    .select({
      hour: sql<number>`extract(hour from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')::int`,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.storeNumber, storeNumber),
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(sql`extract(hour from (${posOrders.orderClosedAt} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')`);

  const hourlyData = new Map<number, number>();
  for (const row of results) {
    hourlyData.set(row.hour, Number(row.totalSales) || 0);
  }

  return hourlyData;
}

// Get all hourly POS sales for all restaurants on a given date
// This dynamically matches store numbers to restaurants by name pattern
// (e.g., store "1237" matches restaurant "1237 - Athens")
export async function getAllHourlyPosSales(targetDate: Date): Promise<Map<string, Map<number, number>>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  // Get all restaurants to build store number -> restaurant mapping with timezones
  const allRestaurants = await db.select().from(restaurants);
  
  // Build mapping from store number to restaurant info (ID and timezone)
  const storeToRestaurant = new Map<string, { id: string; timezone: string }>();
  for (const restaurant of allRestaurants) {
    const match = restaurant.name.match(/^(\d{4})\s*-/);
    if (match) {
      storeToRestaurant.set(match[1], { 
        id: restaurant.id, 
        timezone: restaurant.timezone || 'America/Chicago' 
      });
    }
  }

  // Get unique timezones to query separately (can't use restaurant timezone in SQL across DBs)
  const timezoneSet = new Set<string>();
  storeToRestaurant.forEach((info) => timezoneSet.add(info.timezone));
  const timezones = Array.from(timezoneSet);
  
  const allHourlySales = new Map<string, Map<number, number>>();
  
  // Query POS data for each timezone separately to ensure correct hour bucketing
  for (const tz of timezones) {
    // Get store numbers that use this timezone
    const storesInTz: string[] = [];
    storeToRestaurant.forEach((info, storeNum) => {
      if (info.timezone === tz) {
        storesInTz.push(storeNum);
      }
    });
    
    if (storesInTz.length === 0) continue;
    
    // Query POS orders for stores in this timezone, converting to their local time
    // Use sql.raw for the timezone literal since it's a known safe value from our database
    const hourExpr = sql.raw(`extract(hour from (order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::int`);
    const posResults = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        hour: sql<number>`${hourExpr}`,
        totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, startOfDay),
          lt(posOrders.businessDate, endOfDay),
          sql`${posOrders.storeNumber} = ANY(ARRAY[${sql.raw(storesInTz.map(s => `'${s}'`).join(','))}])`
        )
      )
      .groupBy(posOrders.storeNumber, sql`${hourExpr}`);
    
    for (const row of posResults) {
      const restaurantInfo = storeToRestaurant.get(row.storeNumber);
      if (restaurantInfo) {
        if (!allHourlySales.has(restaurantInfo.id)) {
          allHourlySales.set(restaurantInfo.id, new Map());
        }
        allHourlySales.get(restaurantInfo.id)!.set(row.hour, Number(row.totalSales) || 0);
      }
    }
  }

  return allHourlySales;
}

// Get hourly POS sales for all restaurants across a date range
// Returns Map<"restaurantId-date-hour", sales>
export async function getAllHourlyPosSalesRange(
  startDateStr: string,
  endDateStr: string
): Promise<Map<string, number>> {
  // Broaden business_date range by 1 day on each side to capture overnight orders
  // (12am-5am orders may have business_date on adjacent day)
  const paddedStart = new Date(startDateStr + 'T00:00:00.000Z');
  paddedStart.setDate(paddedStart.getDate() - 1);
  const paddedEnd = new Date(endDateStr + 'T23:59:59.999Z');
  paddedEnd.setDate(paddedEnd.getDate() + 1);
  const startOfRange = paddedStart;
  const endOfRange = paddedEnd;

  const allRestaurants = await db.select().from(restaurants);
  const storeToRestaurant = new Map<string, { id: string; timezone: string }>();
  for (const restaurant of allRestaurants) {
    const match = restaurant.name.match(/^(\d{4})\s*-/);
    if (match) {
      storeToRestaurant.set(match[1], {
        id: restaurant.id,
        timezone: restaurant.timezone || 'America/Chicago'
      });
    }
  }

  const timezoneSet = new Set<string>();
  storeToRestaurant.forEach((info) => timezoneSet.add(info.timezone));
  const timezones = Array.from(timezoneSet);

  const salesByKey = new Map<string, number>();

  for (const tz of timezones) {
    const storesInTz: string[] = [];
    storeToRestaurant.forEach((info, storeNum) => {
      if (info.timezone === tz) storesInTz.push(storeNum);
    });
    if (storesInTz.length === 0) continue;

    const hourExpr = sql.raw(`extract(hour from (order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::int`);
    const dateExpr = sql.raw(`to_char((order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}', 'YYYY-MM-DD')`);
    const posResults = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        localDate: sql<string>`${dateExpr}`,
        hour: sql<number>`${hourExpr}`,
        totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, startOfRange),
          lt(posOrders.businessDate, endOfRange),
          sql`${posOrders.storeNumber} = ANY(ARRAY[${sql.raw(storesInTz.map(s => `'${s}'`).join(','))}])`
        )
      )
      .groupBy(posOrders.storeNumber, sql`${dateExpr}`, sql`${hourExpr}`);

    for (const row of posResults) {
      const restaurantInfo = storeToRestaurant.get(row.storeNumber);
      if (restaurantInfo) {
        const key = `${restaurantInfo.id}-${row.localDate}-${row.hour}`;
        salesByKey.set(key, Number(row.totalSales) || 0);
      }
    }
  }

  return salesByKey;
}

/**
 * Get check average data by restaurant and hour for a given date.
 * Returns order count, total sales, and check average per restaurant per hour.
 */
export async function getCheckAverageByRestaurant(targetDate: Date): Promise<Map<string, { totalOrders: number; totalSales: number; checkAverage: number; hourly: Map<number, { orders: number; sales: number; avg: number }> }>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  const allRestaurants = await db.select().from(restaurants);
  const storeToRestaurant = new Map<string, { id: string; timezone: string }>();
  for (const restaurant of allRestaurants) {
    const match = restaurant.name.match(/^(\d{4})\s*-/);
    if (match) {
      storeToRestaurant.set(match[1], { id: restaurant.id, timezone: restaurant.timezone || 'America/Chicago' });
    }
  }

  const timezoneSet = new Set<string>();
  storeToRestaurant.forEach((info) => timezoneSet.add(info.timezone));

  const result = new Map<string, { totalOrders: number; totalSales: number; checkAverage: number; hourly: Map<number, { orders: number; sales: number; avg: number }> }>();

  for (const tz of timezoneSet) {
    const storesInTz: string[] = [];
    storeToRestaurant.forEach((info, storeNum) => {
      if (info.timezone === tz) storesInTz.push(storeNum);
    });
    if (storesInTz.length === 0) continue;

    const hourExpr = sql.raw(`extract(hour from (order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::int`);
    const posResults = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        hour: sql<number>`${hourExpr}`,
        orderCount: sql<number>`count(*)::int`,
        totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, startOfDay),
          lt(posOrders.businessDate, endOfDay),
          sql`${posOrders.storeNumber} = ANY(ARRAY[${sql.raw(storesInTz.map(s => `'${s}'`).join(','))}])`
        )
      )
      .groupBy(posOrders.storeNumber, sql`${hourExpr}`);

    for (const row of posResults) {
      const restaurantInfo = storeToRestaurant.get(row.storeNumber);
      if (!restaurantInfo) continue;
      const rid = restaurantInfo.id;

      if (!result.has(rid)) {
        result.set(rid, { totalOrders: 0, totalSales: 0, checkAverage: 0, hourly: new Map() });
      }
      const entry = result.get(rid)!;
      const orders = row.orderCount;
      const sales = Number(row.totalSales) || 0;
      entry.totalOrders += orders;
      entry.totalSales += sales;
      entry.hourly.set(row.hour, { orders, sales, avg: orders > 0 ? sales / orders : 0 });
    }
  }

  // Calculate overall check average
  result.forEach((entry) => {
    entry.checkAverage = entry.totalOrders > 0 ? entry.totalSales / entry.totalOrders : 0;
  });

  return result;
}

/**
 * Get 7-day rolling check average by restaurant.
 * Returns daily check averages for the past 7 days for trend calculation.
 */
export async function getCheckAverageTrend(endDate: Date, days: number = 7): Promise<Map<string, { daily: { date: string; orders: number; sales: number; avg: number }[]; avg7d: number; trend: 'up' | 'down' | 'flat' }>> {
  const endDateStr = endDate.toISOString().split('T')[0];
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));
  const startDateStr = startDate.toISOString().split('T')[0];

  const startOfRange = new Date(startDateStr + 'T00:00:00.000Z');
  const endOfRange = new Date(endDateStr + 'T23:59:59.999Z');

  const allRestaurants = await db.select().from(restaurants);
  const storeToRestaurant = new Map<string, { id: string; timezone: string }>();
  for (const restaurant of allRestaurants) {
    const match = restaurant.name.match(/^(\d{4})\s*-/);
    if (match) {
      storeToRestaurant.set(match[1], { id: restaurant.id, timezone: restaurant.timezone || 'America/Chicago' });
    }
  }

  const timezoneSet = new Set<string>();
  storeToRestaurant.forEach((info) => timezoneSet.add(info.timezone));

  // restaurantId → date → { orders, sales }
  const dailyData = new Map<string, Map<string, { orders: number; sales: number }>>();

  for (const tz of timezoneSet) {
    const storesInTz: string[] = [];
    storeToRestaurant.forEach((info, storeNum) => {
      if (info.timezone === tz) storesInTz.push(storeNum);
    });
    if (storesInTz.length === 0) continue;

    const dateExpr = sql.raw(`to_char((order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}', 'YYYY-MM-DD')`);
    const posResults = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        localDate: sql<string>`${dateExpr}`,
        orderCount: sql<number>`count(*)::int`,
        totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, startOfRange),
          lt(posOrders.businessDate, endOfRange),
          sql`${posOrders.storeNumber} = ANY(ARRAY[${sql.raw(storesInTz.map(s => `'${s}'`).join(','))}])`
        )
      )
      .groupBy(posOrders.storeNumber, sql`${dateExpr}`);

    for (const row of posResults) {
      const restaurantInfo = storeToRestaurant.get(row.storeNumber);
      if (!restaurantInfo) continue;
      const rid = restaurantInfo.id;
      if (!dailyData.has(rid)) dailyData.set(rid, new Map());
      dailyData.get(rid)!.set(row.localDate, {
        orders: row.orderCount,
        sales: Number(row.totalSales) || 0,
      });
    }
  }

  const result = new Map<string, { daily: { date: string; orders: number; sales: number; avg: number }[]; avg7d: number; trend: 'up' | 'down' | 'flat' }>();

  dailyData.forEach((dateMap, restaurantId) => {
    const daily: { date: string; orders: number; sales: number; avg: number }[] = [];
    let totalOrders = 0;
    let totalSales = 0;

    // Build daily entries sorted by date
    const sortedDates = [...dateMap.keys()].sort();
    for (const d of sortedDates) {
      const entry = dateMap.get(d)!;
      const avg = entry.orders > 0 ? entry.sales / entry.orders : 0;
      daily.push({ date: d, orders: entry.orders, sales: entry.sales, avg: Math.round(avg * 100) / 100 });
      totalOrders += entry.orders;
      totalSales += entry.sales;
    }

    const avg7d = totalOrders > 0 ? Math.round((totalSales / totalOrders) * 100) / 100 : 0;

    // Determine trend: compare first half avg to second half avg
    // Use percentage-based threshold (2% change = trending)
    let trend: 'up' | 'down' | 'flat' = 'flat';
    if (daily.length >= 2) {
      const mid = Math.max(1, Math.floor(daily.length / 2));
      const firstHalf = daily.slice(0, mid).filter(d => d.orders > 0);
      const secondHalf = daily.slice(mid).filter(d => d.orders > 0);
      if (firstHalf.length > 0 && secondHalf.length > 0) {
        const firstAvg = firstHalf.reduce((s, d) => s + d.avg, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((s, d) => s + d.avg, 0) / secondHalf.length;
        const pctChange = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;
        if (pctChange > 2) trend = 'up';
        else if (pctChange < -2) trend = 'down';
      }
    }

    result.set(restaurantId, { daily, avg7d, trend });
  });

  return result;
}

/**
 * Get destination breakdown by restaurant and hour for a given date.
 * Returns per-destination order counts per hour (e.g. dt1, dt2, dt3, in, app).
 * Used to detect when a restaurant is running the outside DT lane (dt3 >= 5 orders/hour).
 */
export async function getDestinationBreakdownByRestaurant(targetDate: Date): Promise<Map<string, Map<number, Record<string, number>>>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  // Ensure destination column exists before querying it
  await ensureDestinationColumn();

  const allRestaurants = await db.select().from(restaurants);
  const storeToRestaurant = new Map<string, { id: string; timezone: string }>();
  for (const restaurant of allRestaurants) {
    const match = restaurant.name.match(/^(\d{4})\s*-/);
    if (match) {
      storeToRestaurant.set(match[1], { id: restaurant.id, timezone: restaurant.timezone || 'America/Chicago' });
    }
  }

  const timezoneSet = new Set<string>();
  storeToRestaurant.forEach((info) => timezoneSet.add(info.timezone));

  // restaurantId → hour → { destination: count }
  const result = new Map<string, Map<number, Record<string, number>>>();

  for (const tz of timezoneSet) {
    const storesInTz: string[] = [];
    storeToRestaurant.forEach((info, storeNum) => {
      if (info.timezone === tz) storesInTz.push(storeNum);
    });
    if (storesInTz.length === 0) continue;

    const hourExpr = sql.raw(`extract(hour from (order_closed_at AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::int`);
    // Use raw SQL column names — COALESCE handles NULL destination for older rows
    const destExpr = sql.raw(`COALESCE(LOWER(destination), LOWER(order_source))`);

    const posResults = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        hour: sql<number>`${hourExpr}`,
        destination: sql<string>`${destExpr}`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, startOfDay),
          lt(posOrders.businessDate, endOfDay),
          sql`${posOrders.storeNumber} = ANY(ARRAY[${sql.raw(storesInTz.map(s => `'${s}'`).join(','))}])`
        )
      )
      .groupBy(posOrders.storeNumber, sql`${hourExpr}`, sql`${destExpr}`);

    for (const row of posResults) {
      const restaurantInfo = storeToRestaurant.get(row.storeNumber);
      if (!restaurantInfo) continue;
      const rid = restaurantInfo.id;
      const dest = row.destination || 'unknown';

      if (!result.has(rid)) {
        result.set(rid, new Map());
      }
      const hourlyMap = result.get(rid)!;
      if (!hourlyMap.has(row.hour)) {
        hourlyMap.set(row.hour, {});
      }
      const destCounts = hourlyMap.get(row.hour)!;
      destCounts[dest] = (destCounts[dest] || 0) + row.orderCount;
    }
  }

  return result;
}

export async function seedLocationMappings(): Promise<number> {
  // Map Xenial store numbers to restaurant name patterns
  // Restaurant names in DB are like "1237 - Athens", so we match by store number prefix
  const mappings = [
    { xenialStore: "1237", storePrefix: "1237 - ", sevenShifts: "298133" },
    { xenialStore: "1249", storePrefix: "1249 - ", sevenShifts: "298320" },
    { xenialStore: "1238", storePrefix: "1238 - ", sevenShifts: "317365" },
    { xenialStore: "1273", storePrefix: "1273 - ", sevenShifts: "340006" },
    { xenialStore: "1350", storePrefix: "1350 - ", sevenShifts: "351864" },
    { xenialStore: "1351", storePrefix: "1351 - ", sevenShifts: "355675" },
    { xenialStore: "1236", storePrefix: "1236 - ", sevenShifts: "368063" },
    { xenialStore: "1309", storePrefix: "1309 - ", sevenShifts: "321834" },
    { xenialStore: "1492", storePrefix: "1492 - ", sevenShifts: "402456" },
    { xenialStore: "1491", storePrefix: "1491 - ", sevenShifts: "342831" },
    { xenialStore: "1516", storePrefix: "1516 - ", sevenShifts: "208333" },
    { xenialStore: "1508", storePrefix: "1508 - ", sevenShifts: "308603" },
    { xenialStore: "1541", storePrefix: "1541 - ", sevenShifts: "342831" },
    { xenialStore: "1438", storePrefix: "1438 - ", sevenShifts: "420456" },
    { xenialStore: "1606", storePrefix: "1606 - ", sevenShifts: "425678" },
    { xenialStore: "1682", storePrefix: "1682 - ", sevenShifts: "430123" },
    { xenialStore: "1681", storePrefix: "1681 - ", sevenShifts: "435678" },
    { xenialStore: "1680", storePrefix: "1680 - ", sevenShifts: "440123" },
    { xenialStore: "1679", storePrefix: "1679 - ", sevenShifts: "445678" },
    { xenialStore: "1605", storePrefix: "1605 - ", sevenShifts: "450123" },
    { xenialStore: "1729", storePrefix: "1729 - ", sevenShifts: "455678" },
  ];

  let count = 0;
  for (const mapping of mappings) {
    // Find restaurant by store number prefix in name (e.g., "1237 - Athens")
    const existingRestaurant = await db
      .select()
      .from(restaurants)
      .where(sql`${restaurants.name} LIKE ${mapping.storePrefix + '%'}`)
      .limit(1);

    if (existingRestaurant.length > 0) {
      // First check if mapping exists and needs update
      const existingMapping = await db
        .select()
        .from(locationMapping)
        .where(eq(locationMapping.xenialStoreNumber, mapping.xenialStore))
        .limit(1);
      
      if (existingMapping.length > 0) {
        // Update existing mapping with current restaurant ID
        await db.update(locationMapping)
          .set({ restaurantId: existingRestaurant[0].id })
          .where(eq(locationMapping.xenialStoreNumber, mapping.xenialStore));
        console.log(`Updated Xenial store ${mapping.xenialStore} -> ${existingRestaurant[0].name} (ID: ${existingRestaurant[0].id})`);
      } else {
        // Insert new mapping
        await db.insert(locationMapping).values({
          xenialStoreNumber: mapping.xenialStore,
          restaurantId: existingRestaurant[0].id,
          sevenShiftsLocationId: mapping.sevenShifts,
        });
        console.log(`Mapped Xenial store ${mapping.xenialStore} -> ${existingRestaurant[0].name} (ID: ${existingRestaurant[0].id})`);
      }
      count++;
    }
  }

  return count;
}

export function validateWebhookToken(authHeader: string | undefined): boolean {
  // Xenial webhook does not use token authentication - always allow
  return true;
}

// ─── Attachment Rate Analysis from Real POS Item Data ─────────────────────────

/**
 * Attachment category definitions — maps POS item names/categories to upsell buckets.
 * Items are classified by matching against item name patterns (case-insensitive).
 * Child items (modifiers) are checked as well.
 *
 * For Whataburger menus, "attachments" are add-on items that increase check average:
 *   cheese, bacon, jalapeños, dipping sauces, and desserts (shakes/pies/cookies/brownies).
 */

interface AttachmentCategory {
  /** Patterns to match in item name (case-insensitive). */
  namePatterns: RegExp[];
  /** Patterns for minor_reporting_category name. */
  minorCategoryPatterns?: RegExp[];
  /** Patterns for major_reporting_category name. */
  majorCategoryPatterns?: RegExp[];
  /** Patterns to EXCLUDE even if name matches (to avoid counting entrees). */
  excludePatterns?: RegExp[];
}

const ATTACHMENT_CATEGORIES: Record<string, AttachmentCategory> = {
  cheese: {
    namePatterns: [
      /\bADD\b.*\bCHEESE\b/i,
      /\bEXTRA\b.*\bCHEESE\b/i,
      /\bCHEESE\b.*\bADD\b/i,
      /\bAMERICAN\b.*\bCHEESE\b/i,
      /\bPEPPER\s*JACK\b/i,
      /\bCHEDDAR\b/i,
      /\bMONTEREY\s*JACK\b/i,
      /\bQUESO\b/i,
      /\bCHEESE\s*SAUCE\b/i,
    ],
    excludePatterns: [
      /\bCHEESEBURGER\b/i,
      /\bGRILLED\s*CHEESE\b/i,
      /\bCHEESE\s*STEAK\b/i,
      /\bCHEESE\s*WHATA/i,
    ],
  },
  bacon: {
    namePatterns: [
      /\bADD\b.*\bBACON\b/i,
      /\bEXTRA\b.*\bBACON\b/i,
      /\bBACON\b.*\bADD\b/i,
      /\bSIDE\b.*\bBACON\b/i,
      /\bBACON\s*STRIP/i,
    ],
    excludePatterns: [
      /\bBACON\s*BOB\b/i,
      /\bBACON\s*BURGER\b/i,
      /\bBACON\s*CHEESE/i,
      /\bBACON\s*BLUE/i,
      /\bBACON\s*WHATA/i,
      /\bBACON\s*&/i,
      /\bBACON\s*EGG/i,
      /\bBACON\s*BISCUIT/i,
      /\bBACON\s*TAQUITO/i,
      /\bBOBFRDR/i,
    ],
  },
  jalapenos: {
    namePatterns: [
      /\bJALAPEN/i,
      /\bJAL\b/i,
    ],
    excludePatterns: [
      /\bJALAPEN.*\bBURGER\b/i,
    ],
  },
  dipping_sauces: {
    namePatterns: [
      /\bSAUCE\b/i,
      /\bDIP\b/i,
      /\bDIPPING\b/i,
      /\bGRAVY\b/i,
      /\bRANCH\b/i,
      /\bKETCHUP\b/i,
      /\bMUSTARD\b/i,
      /\bHONEY\s*MUSTARD\b/i,
      /\bBBQ\b/i,
      /\bBUFFALO\b/i,
      /\bHONEY\s*BUTTER\b/i,
      /\bCREAMY\s*PEPPER\b/i,
      /\bSPICY\s*KETCHUP\b/i,
      /\bFANCY\s*KETCHUP\b/i,
    ],
    minorCategoryPatterns: [
      /\bSAUCE/i,
      /\bDIP/i,
      /\bCONDIMENT/i,
    ],
    excludePatterns: [
      /\bSAUCE\b.*\bBURGER/i,
      /\bCHEESE\s*SAUCE\b/i,  // Already counted in cheese
    ],
  },
  desserts: {
    namePatterns: [
      /\bSHAKE\b/i,
      /\bMALT\b/i,
      /\bPIE\b/i,
      /\bCOOKIE\b/i,
      /\bBROWNIE\b/i,
      /\bCINNAMON\b/i,
      /\bSUNDAE\b/i,
      /\bICE\s*CREAM\b/i,
      /\bDESSERT/i,
      /\bAPPLE\s*PIE\b/i,
    ],
    majorCategoryPatterns: [
      /\bDESSERT/i,
    ],
  },
  whatasize: {
    namePatterns: [
      /\bWHATASIZE\b/i,
      /\bUPSIZE\b/i,
      /\bUPGRADE\b/i,
      /\bSIZE\s*UP\b/i,
      /\bMAKE\s*IT\s*(?:A\s*)?(?:MED|MEDIUM|LG|LARGE)\b/i,
      /\bSM\s*TO\s*(?:MED|MD|MEDIUM)\b/i,
      /\bMED\s*TO\s*(?:LG|LARGE)\b/i,
      /\bMD\s*TO\s*(?:LG|LARGE)\b/i,
      /\bSMALL\s*TO\s*(?:MED|MEDIUM)\b/i,
      /\bMEDIUM\s*TO\s*(?:LG|LARGE)\b/i,
      /\bLG\b.*\bCOMBO\b/i,
      /\bLARGE\b.*\bCOMBO\b/i,
      /\bCOMBO\b.*\bLG\b/i,
      /\bCOMBO\b.*\bLARGE\b/i,
      /\bSUPERSIZE\b/i,
    ],
    excludePatterns: [
      /\bLG\s+(?!COMBO|MEAL|SIZE)/i,  // Exclude standalone LG items like "LG DIET DR PEPPER"
    ],
  },
};

const ATTACHMENT_BENCHMARKS: Record<string, { min: number; max: number; benchmark: number }> = {
  cheese: { min: 25, max: 65, benchmark: 50 },
  bacon: { min: 10, max: 45, benchmark: 30 },
  jalapenos: { min: 8, max: 30, benchmark: 20 },
  dipping_sauces: { min: 15, max: 50, benchmark: 35 },
  desserts: { min: 5, max: 25, benchmark: 15 },
  whatasize: { min: 10, max: 45, benchmark: 30 },
};

const ATTACHMENT_LABELS: Record<string, string> = {
  cheese: 'Cheese',
  bacon: 'Bacon',
  jalapenos: 'Jalapeños',
  dipping_sauces: 'Dipping Sauces',
  desserts: 'Desserts',
  whatasize: 'Whatasize',
};

interface ParsedItem {
  name: string;
  majorCategory?: string;
  minorCategory?: string;
}

function classifyItem(item: ParsedItem, category: AttachmentCategory): boolean {
  const name = item.name || '';

  // Check exclusion patterns first
  if (category.excludePatterns) {
    for (const pattern of category.excludePatterns) {
      if (pattern.test(name)) return false;
    }
  }

  // Check item name patterns
  for (const pattern of category.namePatterns) {
    if (pattern.test(name)) return true;
  }

  // Check major reporting category
  if (category.majorCategoryPatterns && item.majorCategory) {
    for (const pattern of category.majorCategoryPatterns) {
      if (pattern.test(item.majorCategory)) return true;
    }
  }

  // Check minor reporting category
  if (category.minorCategoryPatterns && item.minorCategory) {
    for (const pattern of category.minorCategoryPatterns) {
      if (pattern.test(item.minorCategory)) return true;
    }
  }

  return false;
}

function extractItemsFromOrder(rawJson: string): ParsedItem[] {
  try {
    const payload = JSON.parse(rawJson);
    const items: ParsedItem[] = [];
    const rawItems = payload?.data?.items;
    if (!Array.isArray(rawItems)) return items;

    for (const item of rawItems) {
      items.push({
        name: item.name || '',
        majorCategory: item.reporting_category?.major_reporting_category?.name,
        minorCategory: item.reporting_category?.minor_reporting_category?.name,
      });
      // Also process child_items (modifiers/add-ons)
      if (Array.isArray(item.child_items)) {
        for (const child of item.child_items) {
          items.push({
            name: child.name || '',
            majorCategory: child.reporting_category?.major_reporting_category?.name,
            minorCategory: child.reporting_category?.minor_reporting_category?.name,
          });
        }
      }
      // Process modifiers array if present
      if (Array.isArray(item.modifiers)) {
        for (const mod of item.modifiers) {
          items.push({
            name: mod.name || '',
            majorCategory: mod.reporting_category?.major_reporting_category?.name,
            minorCategory: mod.reporting_category?.minor_reporting_category?.name,
          });
        }
      }
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Compute real attachment rates from item-level POS data.
 * Parses raw_json from pos_orders for the given date and calculates
 * what percentage of orders contained items in each attachment category.
 */
export async function getAttachmentRatesFromDetail(targetDate: Date): Promise<Map<string, {
  restaurantName: string;
  totalOrders: number;
  checkAverage: number;
  categories: Record<string, { attachRate: number; estimatedUnits: number; benchmark: number; vsTarget: number }>;
  overallAttachScore: number;
}>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  // Get restaurant mappings
  const allRestaurants = await db.select().from(restaurants);
  const storeToRestaurant = new Map<string, { id: string; name: string }>();
  for (const restaurant of allRestaurants) {
    const match = restaurant.name.match(/^(\d{4})\s*-/);
    if (match) {
      storeToRestaurant.set(match[1], { id: restaurant.id, name: restaurant.name });
    }
  }

  // Fetch all orders with raw_json for the target date
  const orders = await posDb
    .select({
      storeNumber: posOrders.storeNumber,
      orderTotal: posOrders.orderTotal,
      rawJson: posOrders.rawJson,
    })
    .from(posOrders)
    .where(
      and(
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay),
        sql`${posOrders.rawJson} IS NOT NULL`
      )
    );

  // Group orders by restaurant and process items
  const restaurantData = new Map<string, {
    restaurantName: string;
    totalOrders: number;
    totalSales: number;
    categoryHits: Record<string, number>; // orders containing at least one item in category
  }>();

  const categories = Object.keys(ATTACHMENT_CATEGORIES);

  for (const order of orders) {
    const restaurantInfo = storeToRestaurant.get(order.storeNumber);
    if (!restaurantInfo) continue;
    const rid = restaurantInfo.id;

    if (!restaurantData.has(rid)) {
      restaurantData.set(rid, {
        restaurantName: restaurantInfo.name,
        totalOrders: 0,
        totalSales: 0,
        categoryHits: Object.fromEntries(categories.map(c => [c, 0])),
      });
    }

    const entry = restaurantData.get(rid)!;
    entry.totalOrders++;
    entry.totalSales += Number(order.orderTotal) || 0;

    // Parse items from raw JSON
    const items = extractItemsFromOrder(order.rawJson || '');
    if (items.length === 0) continue;

    // For each category, check if ANY item in this order matches
    for (const cat of categories) {
      const catDef = ATTACHMENT_CATEGORIES[cat];
      const hasAttachment = items.some(item => classifyItem(item, catDef));
      if (hasAttachment) {
        entry.categoryHits[cat]++;
      }
    }
  }

  // Calculate rates and scores
  const result = new Map<string, {
    restaurantName: string;
    totalOrders: number;
    checkAverage: number;
    categories: Record<string, { attachRate: number; estimatedUnits: number; benchmark: number; vsTarget: number }>;
    overallAttachScore: number;
  }>();

  restaurantData.forEach((entry, restaurantId) => {
    if (entry.totalOrders === 0) return;

    const checkAverage = entry.totalSales / entry.totalOrders;
    const catData: Record<string, { attachRate: number; estimatedUnits: number; benchmark: number; vsTarget: number }> = {};
    let totalScore = 0;

    for (const cat of categories) {
      const hits = entry.categoryHits[cat];
      const attachRate = Math.round((hits / entry.totalOrders) * 1000) / 10; // one decimal
      const benchmark = ATTACHMENT_BENCHMARKS[cat].benchmark;
      const vsTarget = Math.round((attachRate - benchmark) * 10) / 10;
      const catScore = Math.min(100, Math.max(0, (attachRate / benchmark) * 100));
      totalScore += catScore;

      catData[cat] = {
        attachRate,
        estimatedUnits: hits,
        benchmark,
        vsTarget,
      };
    }

    result.set(restaurantId, {
      restaurantName: entry.restaurantName,
      totalOrders: entry.totalOrders,
      checkAverage: Math.round(checkAverage * 100) / 100,
      categories: catData,
      overallAttachScore: Math.round(totalScore / categories.length),
    });
  });

  return result;
}

/**
 * One-time backfill: populate the `destination` column from rawJson for existing records.
 * Safe to call multiple times — only updates rows where destination IS NULL.
 */
export async function backfillDestinations(): Promise<number> {
  try {
    // First ensure the column exists (idempotent)
    await posDb.execute(sql`ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS destination TEXT`);

    // Backfill from stored rawJson payload
    const result = await posDb.execute(sql`
      UPDATE pos_orders
      SET destination = raw_json::jsonb -> 'data' -> 'destination' ->> 'short_name'
      WHERE destination IS NULL
        AND raw_json IS NOT NULL
        AND raw_json::jsonb -> 'data' -> 'destination' ->> 'short_name' IS NOT NULL
    `);
    const count = (result as any).rowCount || 0;
    if (count > 0) {
      console.log(`[Xenial] Backfilled destination for ${count} existing POS orders`);
    }
    return count;
  } catch (error) {
    console.error("[Xenial] Error backfilling destinations:", error);
    return 0;
  }
}
