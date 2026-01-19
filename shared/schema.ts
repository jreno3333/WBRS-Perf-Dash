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
  scrapedAt: timestamp("scraped_at").defaultNow(),
});

export const insertDailySalesSchema = createInsertSchema(dailySales).omit({
  id: true,
  scrapedAt: true,
});

export type InsertDailySales = z.infer<typeof insertDailySalesSchema>;
export type DailySales = typeof dailySales.$inferSelect;

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
  pacePercentage: number; // How far through the day they are vs last week
  isAheadOfPace: boolean;
  rank: number;
  normalizedHour: number; // Current hour normalized for fair comparison
}

export interface HourlySalesData {
  hour: number;
  todaySales: number;
  lastWeekSales: number;
  label: string;
}

export interface LeaderboardData {
  restaurants: RestaurantSales[];
  lastUpdated: string;
  currentDate: string;
}

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
