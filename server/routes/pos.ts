import { Router } from "express";
import { db, posDb } from "../db";
import { posOrders, restaurants } from "@shared/schema";
import { desc, sql, gte, lt, and } from "drizzle-orm";
import { processXenialOrder, validateWebhookToken, seedLocationMappings, getPosOrdersSummary, getCheckAverageByRestaurant, getDestinationBreakdownByRestaurant, getCheckAverageTrend, getAttachmentRatesFromDetail } from "../xenial-webhook";
import { ATTACHMENT_BENCHMARKS } from "../lib/scoring";

const router = Router();

// Test endpoint to verify webhook connectivity (no auth required)
router.get("/api/xenial/ping", async (req, res) => {
  res.json({
    status: "ok",
    message: "Xenial webhook endpoint is reachable",
    timestamp: new Date().toISOString(),
    webhookUrl: "/api/xenial/order",
    authRequired: !!process.env.MWBURGER_POS_TOKEN,
  });
});

// Test endpoint to send a sample order (for debugging)
router.post("/api/xenial/test-order", async (req, res) => {
  try {
    const testPayload = {
      entityName: "Order",
      data: {
        _id: `test-${Date.now()}`,
        origin: "1237",
        net_sales: 9.99,
        business_date: new Date().toISOString().split('T')[0],
        closed: new Date().toISOString(),
        order_source: "TEST",
      }
    };

    const result = await processXenialOrder(testPayload);
    res.json({
      message: "Test order processed",
      result,
      payload: testPayload,
    });
  } catch (error) {
    console.error("Test order error:", error);
    res.status(500).json({ error: "Failed to process test order" });
  }
});

// Receive order from Xenial POS (webhook endpoint)
router.post("/api/xenial/order", async (req, res) => {
  const receivedAt = new Date().toISOString();
  console.log(`[Xenial] Webhook received at ${receivedAt}`);

  try {
    const authHeader = req.headers.authorization as string | undefined;

    console.log(`[Xenial] Headers: content-type=${req.headers['content-type']}, auth=${authHeader ? 'present' : 'missing'}`);
    console.log(`[Xenial] Body preview: ${JSON.stringify(req.body).substring(0, 200)}`);

    if (!validateWebhookToken(authHeader)) {
      console.warn("[Xenial] REJECTED: Invalid or missing auth token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const payload = req.body;

    if (!payload || !payload.data) {
      console.warn("[Xenial] REJECTED: Invalid payload structure");
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    const result = await processXenialOrder(payload);

    if (result.success) {
      console.log(`[Xenial] SUCCESS: Order ${result.orderId} saved`);
      res.json({ success: true, orderId: result.orderId });
    } else {
      console.warn(`[Xenial] FAILED: ${result.error}`);
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error("Error processing Xenial order:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get POS sales summary for a date
router.get("/api/pos/sales", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();

    const summary = await getPosOrdersSummary(targetDate);

    const result: Record<string, { orders: number; total: number }> = {};
    summary.forEach((value, key) => {
      result[key] = value;
    });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      stores: result,
      totalOrders: Array.from(summary.values()).reduce((sum, s) => sum + s.orders, 0),
      totalSales: Array.from(summary.values()).reduce((sum, s) => sum + s.total, 0),
    });
  } catch (error) {
    console.error("Error fetching POS sales:", error);
    res.status(500).json({ error: "Failed to fetch POS sales" });
  }
});

// Get recent POS orders (for debugging)
router.get("/api/pos/recent", async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const orders = await posDb
      .select({
        id: posOrders.id,
        xenialOrderId: posOrders.xenialOrderId,
        storeNumber: posOrders.storeNumber,
        orderTotal: posOrders.orderTotal,
        businessDate: posOrders.businessDate,
        orderClosedAt: posOrders.orderClosedAt,
        orderSource: posOrders.orderSource,
        receivedAt: posOrders.receivedAt,
      })
      .from(posOrders)
      .orderBy(desc(posOrders.receivedAt))
      .limit(Number(limit));

    res.json(orders);
  } catch (error) {
    console.error("Error fetching recent orders:", error);
    res.status(500).json({ error: "Failed to fetch recent orders" });
  }
});

// Seed location mappings
router.post("/api/pos/seed-mappings", async (req, res) => {
  try {
    const count = await seedLocationMappings();
    res.json({ message: `Seeded ${count} location mappings`, count });
  } catch (error) {
    console.error("Error seeding mappings:", error);
    res.status(500).json({ error: "Failed to seed mappings" });
  }
});

// Check average by restaurant for a given date
router.get("/api/pos/check-average", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const data = await getCheckAverageByRestaurant(targetDate);

    const result: Record<string, { totalOrders: number; totalSales: number; checkAverage: number; hourly: Record<number, { orders: number; sales: number; avg: number }> }> = {};
    data.forEach((value, key) => {
      const hourly: Record<number, { orders: number; sales: number; avg: number }> = {};
      value.hourly.forEach((hv, hk) => { hourly[hk] = hv; });
      result[key] = {
        totalOrders: value.totalOrders,
        totalSales: value.totalSales,
        checkAverage: Math.round(value.checkAverage * 100) / 100,
        hourly,
      };
    });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      restaurants: result,
    });
  } catch (error) {
    console.error("Error fetching check averages:", error);
    res.status(500).json({ error: "Failed to fetch check averages" });
  }
});

// POS webhook status - comprehensive order flow monitoring
router.get("/api/pos/status", async (req, res) => {
  try {
    const now = new Date();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const todayOrders = await posDb
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, today),
          lt(posOrders.businessDate, tomorrow)
        )
      );

    const lastHourOrders = await posDb
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
      })
      .from(posOrders)
      .where(gte(posOrders.receivedAt, oneHourAgo));

    const totalOrders = await posDb
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
      })
      .from(posOrders);

    const storeBreakdown = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        count: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${posOrders.orderTotal}::numeric), 0)`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.businessDate, today),
          lt(posOrders.businessDate, tomorrow)
        )
      )
      .groupBy(posOrders.storeNumber)
      .orderBy(desc(sql`count(*)`));

    const recentOrders = await posDb
      .select({
        storeNumber: posOrders.storeNumber,
        orderTotal: posOrders.orderTotal,
        orderSource: posOrders.orderSource,
        receivedAt: posOrders.receivedAt,
      })
      .from(posOrders)
      .orderBy(desc(posOrders.receivedAt))
      .limit(5);

    const lastOrder = recentOrders[0];

    res.json({
      status: "operational",
      version: process.env.npm_package_version || "2.1.0",
      webhookEndpoint: "/api/xenial/order",
      webhookEnabled: true,
      serverTime: now.toISOString(),
      today: {
        date: today.toISOString().split('T')[0],
        orderCount: todayOrders[0]?.count || 0,
        salesTotal: Number(todayOrders[0]?.total) || 0,
      },
      lastHour: {
        orderCount: lastHourOrders[0]?.count || 0,
        salesTotal: Number(lastHourOrders[0]?.total) || 0,
      },
      allTime: {
        orderCount: totalOrders[0]?.count || 0,
        salesTotal: Number(totalOrders[0]?.total) || 0,
      },
      lastOrderReceived: lastOrder?.receivedAt || null,
      lastOrderStore: lastOrder?.storeNumber || null,
      lastOrderAmount: lastOrder ? Number(lastOrder.orderTotal) : null,
      storeBreakdown: storeBreakdown.map(s => ({
        store: s.storeNumber,
        orders: s.count,
        total: Number(s.total),
      })),
      recentOrders: recentOrders.map(o => ({
        store: o.storeNumber,
        amount: Number(o.orderTotal),
        source: o.orderSource,
        receivedAt: o.receivedAt,
      })),
    });
  } catch (error) {
    console.error("Error fetching POS status:", error);
    res.status(500).json({ error: "Failed to fetch POS status" });
  }
});

// Destination breakdown by restaurant/hour (for dt3 outside lane tracking)
router.get("/api/pos/destinations", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const data = await getDestinationBreakdownByRestaurant(targetDate);

    const result: Record<string, Record<number, Record<string, number>>> = {};
    data.forEach((hourlyMap, restaurantId) => {
      const hourly: Record<number, Record<string, number>> = {};
      hourlyMap.forEach((destCounts, hour) => {
        hourly[hour] = destCounts;
      });
      result[restaurantId] = hourly;
    });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      restaurants: result,
    });
  } catch (error) {
    console.error("Error fetching destination breakdown:", error);
    res.status(500).json({ error: "Failed to fetch destination breakdown" });
  }
});

// 7-day rolling check average trend by restaurant
router.get("/api/pos/check-average-trend", async (req, res) => {
  try {
    const { date, days = "7" } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const numDays = Math.min(parseInt(days as string) || 7, 30);
    const data = await getCheckAverageTrend(targetDate, numDays);

    const result: Record<string, { daily: { date: string; orders: number; sales: number; avg: number }[]; avg7d: number; trend: string }> = {};
    data.forEach((value, key) => {
      result[key] = value;
    });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      days: numDays,
      restaurants: result,
    });
  } catch (error) {
    console.error("Error fetching check average trend:", error);
    res.status(500).json({ error: "Failed to fetch check average trend" });
  }
});

// Attachment rate analysis from REAL item-level POS data
// Parses raw_json items from Xenial orders and classifies add-ons into
// cheese, bacon, jalapeños, dipping sauces, shakes & malts, and whatasize
router.get("/api/pos/attachment-rates", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const data = await getAttachmentRatesFromDetail(targetDate);

    const categoryLabels: Record<string, string> = {
      cheese: 'Cheese',
      bacon: 'Bacon',
      jalapenos: 'Jalapeños',
      dipping_sauces: 'Dipping Sauces',
      shakes_malts: 'Shakes & Malts',
      whatasize: 'Whatasize',
    };

    const benchmarks: Record<string, { min: number; max: number; benchmark: number }> = {
      cheese: { min: 15, max: 45, benchmark: ATTACHMENT_BENCHMARKS.cheese },
      bacon: { min: 8, max: 35, benchmark: ATTACHMENT_BENCHMARKS.bacon },
      jalapenos: { min: 5, max: 25, benchmark: ATTACHMENT_BENCHMARKS.jalapenos },
      dipping_sauces: { min: 15, max: 50, benchmark: ATTACHMENT_BENCHMARKS.dipping_sauces },
      shakes_malts: { min: 5, max: 30, benchmark: ATTACHMENT_BENCHMARKS.shakes_malts },
      whatasize: { min: 10, max: 45, benchmark: ATTACHMENT_BENCHMARKS.whatasize },
    };

    const restaurantResults: Record<string, {
      restaurantName: string;
      totalOrders: number;
      checkAverage: number;
      categories: Record<string, { attachRate: number; estimatedUnits: number; benchmark: number; vsTarget: number }>;
      overallAttachScore: number;
    }> = {};

    data.forEach((value, key) => {
      restaurantResults[key] = value;
    });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      source: "pos_detail",
      categoryLabels,
      benchmarks,
      restaurants: restaurantResults,
    });
  } catch (error) {
    console.error("Error fetching attachment rates:", error);
    res.status(500).json({ error: "Failed to fetch attachment rates" });
  }
});

// Simple alias for Xenial status
router.get("/api/xenial/status", async (req, res) => {
  res.redirect("/api/pos/status");
});

export default router;
