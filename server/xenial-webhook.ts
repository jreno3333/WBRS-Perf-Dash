import { db } from "./db";
import { posOrders, locationMapping, restaurants } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

interface XenialOrderData {
  _id: string;
  origin?: string;
  store_number?: string;
  net_sales?: number | string;
  net_amount?: number | string;
  total?: number | string;
  business_date?: string;
  closed?: string;
  order_source?: string;
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

    // Parse net sales - prioritize net_sales/net_amount (excludes tax/fees), fallback to total
    const rawAmount = data.net_sales ?? data.net_amount ?? data.total ?? 0;
    const orderTotal = typeof rawAmount === 'string' ? parseFloat(rawAmount) : Number(rawAmount);
    
    if (isNaN(orderTotal) || orderTotal <= 0) {
      return { success: false, error: "Invalid order amount" };
    }

    const businessDateStr = data.business_date;
    const closedStr = data.closed;
    
    if (!businessDateStr || !closedStr) {
      return { success: false, error: "Missing date information" };
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

    await db.insert(posOrders).values({
      xenialOrderId: orderId,
      storeNumber: storeNumber,
      orderTotal: orderTotal.toFixed(2),
      businessDate: businessDate,
      orderClosedAt: orderClosedAt,
      orderSource: data.order_source || "POS",
      rawJson: JSON.stringify(payload),
    }).onConflictDoUpdate({
      target: posOrders.xenialOrderId,
      set: {
        orderTotal: orderTotal.toFixed(2),
        orderClosedAt: orderClosedAt,
        orderSource: data.order_source || "POS",
        rawJson: JSON.stringify(payload),
      },
    });

    console.log(`Processed Xenial order ${orderId} from store ${storeNumber}: $${orderTotal}`);
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

  const results = await db
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

  const results = await db
    .select({
      hour: sql<number>`extract(hour from ${posOrders.orderClosedAt})::int`,
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
    .groupBy(sql`extract(hour from ${posOrders.orderClosedAt})`);

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

  // Join pos_orders with location_mapping to get restaurant IDs
  const results = await db
    .select({
      restaurantId: locationMapping.restaurantId,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .innerJoin(locationMapping, eq(posOrders.storeNumber, locationMapping.xenialStoreNumber))
    .where(
      and(
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(locationMapping.restaurantId);

  const salesByRestaurant = new Map<string, number>();
  for (const row of results) {
    if (row.restaurantId) {
      salesByRestaurant.set(row.restaurantId, Number(row.totalSales) || 0);
    }
  }

  return salesByRestaurant;
}

// Get hourly POS sales by restaurant ID for a specific date
export async function getHourlyPosSalesByRestaurant(restaurantId: string, targetDate: Date): Promise<Map<number, number>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  const results = await db
    .select({
      hour: sql<number>`extract(hour from ${posOrders.orderClosedAt})::int`,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .innerJoin(locationMapping, eq(posOrders.storeNumber, locationMapping.xenialStoreNumber))
    .where(
      and(
        eq(locationMapping.restaurantId, restaurantId),
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(sql`extract(hour from ${posOrders.orderClosedAt})`);

  const hourlyData = new Map<number, number>();
  for (const row of results) {
    hourlyData.set(row.hour, Number(row.totalSales) || 0);
  }

  return hourlyData;
}

// Get all hourly POS sales for all restaurants on a given date
export async function getAllHourlyPosSales(targetDate: Date): Promise<Map<string, Map<number, number>>> {
  const dateStr = targetDate.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

  const results = await db
    .select({
      restaurantId: locationMapping.restaurantId,
      hour: sql<number>`extract(hour from ${posOrders.orderClosedAt})::int`,
      totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
    })
    .from(posOrders)
    .innerJoin(locationMapping, eq(posOrders.storeNumber, locationMapping.xenialStoreNumber))
    .where(
      and(
        gte(posOrders.businessDate, startOfDay),
        lt(posOrders.businessDate, endOfDay)
      )
    )
    .groupBy(locationMapping.restaurantId, sql`extract(hour from ${posOrders.orderClosedAt})`);

  const allHourlySales = new Map<string, Map<number, number>>();
  for (const row of results) {
    if (row.restaurantId) {
      if (!allHourlySales.has(row.restaurantId)) {
        allHourlySales.set(row.restaurantId, new Map());
      }
      allHourlySales.get(row.restaurantId)!.set(row.hour, Number(row.totalSales) || 0);
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
      await db.insert(locationMapping).values({
        xenialStoreNumber: mapping.xenialStore,
        restaurantId: existingRestaurant[0].id,
        sevenShiftsLocationId: mapping.sevenShifts,
      }).onConflictDoNothing();
      count++;
      console.log(`Mapped Xenial store ${mapping.xenialStore} to ${existingRestaurant[0].name}`);
    }
  }

  return count;
}

export function validateWebhookToken(authHeader: string | undefined): boolean {
  const expectedToken = process.env.MWBURGER_POS_TOKEN;
  if (!expectedToken) {
    console.warn("MWBURGER_POS_TOKEN not set - webhook authentication disabled");
    return true;
  }

  if (!authHeader) {
    return false;
  }

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  return token === expectedToken;
}
