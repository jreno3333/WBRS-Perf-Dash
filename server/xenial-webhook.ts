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

export async function seedLocationMappings(): Promise<number> {
  const mappings = [
    { xenialStore: "1237", name: "Athens", sevenShifts: "298133" },
    { xenialStore: "1249", name: "Huntsville", sevenShifts: "298320" },
    { xenialStore: "1238", name: "Albertville", sevenShifts: "317365" },
    { xenialStore: "1273", name: "Hazel Green", sevenShifts: "340006" },
    { xenialStore: "1350", name: "Scottsboro", sevenShifts: "351864" },
    { xenialStore: "1351", name: "Pell City", sevenShifts: "355675" },
    { xenialStore: "1236", name: "Florence", sevenShifts: "368063" },
    { xenialStore: "1309", name: "Cullman", sevenShifts: "321834" },
    { xenialStore: "1492", name: "Jacksonville", sevenShifts: "402456" },
    { xenialStore: "1491", name: "Attalla", sevenShifts: "342831" },
    { xenialStore: "1358", name: "Jasper", sevenShifts: "208333" },
    { xenialStore: "1251", name: "Gadsden", sevenShifts: "308603" },
    { xenialStore: "1489", name: "Owens Cross Roads", sevenShifts: "420456" },
    { xenialStore: "1890", name: "Madison County Line", sevenShifts: "425678" },
    { xenialStore: "1801", name: "Cumberland Avenue", sevenShifts: "430123" },
    { xenialStore: "1802", name: "Turkey Creek", sevenShifts: "435678" },
    { xenialStore: "1803", name: "Powell", sevenShifts: "440123" },
    { xenialStore: "1679", name: "East Ridge", sevenShifts: "445678" },
    { xenialStore: "1605", name: "Shallowford Village", sevenShifts: "450123" },
    { xenialStore: "1729", name: "Sevierville", sevenShifts: "455678" },
    { xenialStore: "1000", name: "Training & Development", sevenShifts: "208334" },
  ];

  let count = 0;
  for (const mapping of mappings) {
    const existingRestaurant = await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.name, mapping.name))
      .limit(1);

    if (existingRestaurant.length > 0) {
      await db.insert(locationMapping).values({
        xenialStoreNumber: mapping.xenialStore,
        restaurantId: existingRestaurant[0].id,
        sevenShiftsLocationId: mapping.sevenShifts,
      }).onConflictDoNothing();
      count++;
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
