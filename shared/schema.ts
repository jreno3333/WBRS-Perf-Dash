import { sql } from "drizzle-orm";
import { pgTable, text, varchar, decimal, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Restaurant model
export const restaurants = pgTable("restaurants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"), // Eastern or Central
  isActive: boolean("is_active").notNull().default(true),
  laborTarget: decimal("labor_target", { precision: 5, scale: 2 }).default("25.00"), // Target labor % (default 25%)
});

export const insertRestaurantSchema = createInsertSchema(restaurants).omit({
  id: true,
});

export type InsertRestaurant = z.infer<typeof insertRestaurantSchema>;
export type Restaurant = typeof restaurants.$inferSelect;

// Daily sales snapshot from 7shifts scraping
export const dailySales = pgTable("daily_sales", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  locationCode: text("location_code").notNull(), // 7shifts location code (e.g., "1060")
  salesDate: timestamp("sales_date").notNull(),
  totalSales: decimal("total_sales", { precision: 10, scale: 2 }).notNull(),
  vsProjected: decimal("vs_projected", { precision: 10, scale: 2 }), // Difference from projected
  laborPercent: decimal("labor_percent", { precision: 5, scale: 2 }),
  projectedLaborCost: decimal("projected_labor_cost", { precision: 10, scale: 2 }), // Total scheduled labor for the day
  laborTarget: decimal("labor_target", { precision: 5, scale: 2 }).default("25.00"), // Target labor % (default 25%)
  scrapedAt: timestamp("scraped_at").defaultNow(),
});

export const insertDailySalesSchema = createInsertSchema(dailySales).omit({
  id: true,
  scrapedAt: true,
});

export type InsertDailySales = z.infer<typeof insertDailySalesSchema>;
export type DailySales = typeof dailySales.$inferSelect;

// Hourly sales data for timezone-normalized comparisons
export const hourlySales = pgTable("hourly_sales", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  salesDate: timestamp("sales_date").notNull(),
  hour: integer("hour").notNull(), // 0-23
  actualSales: decimal("actual_sales", { precision: 10, scale: 2 }).notNull(),
  projectedSales: decimal("projected_sales", { precision: 10, scale: 2 }),
  pastActualSales: decimal("past_actual_sales", { precision: 10, scale: 2 }), // Last week same hour
  projectedLabor: decimal("projected_labor", { precision: 10, scale: 2 }), // Scheduled labor cost for this hour
  scrapedAt: timestamp("scraped_at").defaultNow(),
});

export const insertHourlySalesSchema = createInsertSchema(hourlySales).omit({
  id: true,
  scrapedAt: true,
});

export type InsertHourlySales = z.infer<typeof insertHourlySalesSchema>;
export type HourlySales = typeof hourlySales.$inferSelect;

// Scraper run log for tracking automation
export const scraperRuns = pgTable("scraper_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"), // running, success, failed
  recordsScraped: integer("records_scraped").default(0),
  errorMessage: text("error_message"),
});

export const insertScraperRunSchema = createInsertSchema(scraperRuns).omit({
  id: true,
});

export type InsertScraperRun = z.infer<typeof insertScraperRunSchema>;
export type ScraperRun = typeof scraperRuns.$inferSelect;

// Types for API responses
export interface RestaurantSales {
  restaurantId: string;
  restaurantName: string;
  timezone: string;
  todaySales: number;
  lastWeekSales: number;
  forecastSales: number;
  pacePercentage: number; // How far through the day they are vs last week
  isAheadOfPace: boolean;
  rank: number;
  normalizedHour: number; // Current hour normalized for fair comparison
  // Labor forecast fields
  projectedLaborCost?: number; // Total scheduled labor for the day
  projectedEndOfDaySales?: number; // Actual + forecasted remaining sales
  projectedLaborPercent?: number; // Projected labor % at end of day
  laborTarget?: number; // Target labor % (default 25%)
  willHitLaborTarget?: boolean; // Whether projected to hit target
}

export interface HourlySalesData {
  hour: number;
  todaySales: number;
  lastWeekSales: number;
  forecastSales: number;
  projectedLabor: number; // Scheduled labor cost for this hour
  label: string;
}

export interface LeaderboardData {
  restaurants: RestaurantSales[];
  lastUpdated: string;
  currentDate: string;
}

// POS orders from Xenial webhook
export const posOrders = pgTable("pos_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  xenialOrderId: text("xenial_order_id").notNull().unique(), // Xenial UUID
  storeNumber: text("store_number").notNull(), // Xenial store ID (e.g., "1237")
  orderTotal: decimal("order_total", { precision: 10, scale: 2 }).notNull(),
  businessDate: timestamp("business_date").notNull(),
  orderClosedAt: timestamp("order_closed_at").notNull(),
  orderSource: text("order_source"), // "POS", "APP", etc.
  rawJson: text("raw_json"), // Full JSON for debugging
  receivedAt: timestamp("received_at").defaultNow(),
});

export const insertPosOrderSchema = createInsertSchema(posOrders).omit({
  id: true,
  receivedAt: true,
});

export type InsertPosOrder = z.infer<typeof insertPosOrderSchema>;
export type PosOrder = typeof posOrders.$inferSelect;

// Location mapping from Xenial store IDs to restaurant IDs
export const locationMapping = pgTable("location_mapping", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  xenialStoreNumber: text("xenial_store_number").notNull().unique(), // e.g., "1237"
  restaurantId: varchar("restaurant_id").notNull(), // Links to restaurants table
  sevenShiftsLocationId: text("seven_shifts_location_id"), // For cross-reference
});

export const insertLocationMappingSchema = createInsertSchema(locationMapping).omit({
  id: true,
});

export type InsertLocationMapping = z.infer<typeof insertLocationMappingSchema>;
export type LocationMapping = typeof locationMapping.$inferSelect;

// Users table (keeping for compatibility)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
