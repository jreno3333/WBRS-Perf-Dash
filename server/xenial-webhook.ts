import { db, posDb } from "./db";
import { posOrders, locationMapping, restaurants } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

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

    await posDb.insert(posOrders).values({
      xenialOrderId: orderId,
      storeNumber: storeNumber,
      orderTotal: orderTotal.toFixed(2),
      businessDate: businessDate,
      orderClosedAt: orderClosedAt,
      orderSource: orderSource,
      rawJson: JSON.stringify(payload),
    }).onConflictDoUpdate({
      target: posOrders.xenialOrderId,
      set: {
        orderTotal: orderTotal.toFixed(2),
        orderClosedAt: orderClosedAt,
        orderSource: orderSource,
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
