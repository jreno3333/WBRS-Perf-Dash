import { sql } from "drizzle-orm";
import { pgTable, text, varchar, decimal, timestamp, integer, boolean, jsonb, uniqueIndex, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Restaurant model
export const restaurants = pgTable("restaurants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"), // Eastern or Central
  isActive: boolean("is_active").notNull().default(true),
  laborTarget: decimal("labor_target", { precision: 5, scale: 2 }).default("25.00"), // Target labor % (default 25%)
  openDate: date("open_date"), // Date when restaurant opened/will open. Future = training, < 90 days = new unit
  revenuePorts: text("revenue_ports").array(), // Revenue ports: dine_in, drive_thru, app, 3pd
  address: text("address"), // Full street address
  latitude: decimal("latitude", { precision: 10, scale: 7 }), // GPS latitude
  longitude: decimal("longitude", { precision: 10, scale: 7 }), // GPS longitude
  unitNumber: text("unit_number"), // Store unit number (e.g., "1237")
  googlePlaceId: text("google_place_id"), // Google Places API ID for fetching reviews
});

export const insertRestaurantSchema = createInsertSchema(restaurants).omit({
  id: true,
});

export type InsertRestaurant = z.infer<typeof insertRestaurantSchema>;
export type Restaurant = typeof restaurants.$inferSelect;

// Daily sales snapshot from 7shifts scraping
// NOTE: Labor data is also stored in daily_labor table, but these columns are kept for backward compatibility
export const dailySales = pgTable("daily_sales", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  locationCode: text("location_code").notNull(), // 7shifts location code (e.g., "1060")
  salesDate: timestamp("sales_date").notNull(),
  totalSales: decimal("total_sales", { precision: 10, scale: 2 }).notNull(),
  vsProjected: decimal("vs_projected", { precision: 10, scale: 2 }), // Difference from projected
  // Legacy labor columns (kept for backward compatibility with existing data)
  laborPercent: decimal("labor_percent", { precision: 5, scale: 2 }),
  projectedLaborCost: decimal("projected_labor_cost", { precision: 10, scale: 2 }),
  laborTarget: decimal("labor_target", { precision: 5, scale: 2 }),
  scrapedAt: timestamp("scraped_at").defaultNow(),
});

// Daily labor data from 7shifts - stored separately to keep sales tables clean
export const dailyLabor = pgTable("daily_labor", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  laborPercent: decimal("labor_percent", { precision: 5, scale: 2 }),
  projectedLaborCost: decimal("projected_labor_cost", { precision: 10, scale: 2 }), // Total scheduled labor for the day
  actualLaborCost: decimal("actual_labor_cost", { precision: 10, scale: 2 }), // Actual labor cost from punched hours
  laborTarget: decimal("labor_target", { precision: 5, scale: 2 }).default("25.00"), // Target labor % (default 25%)
  syncedAt: timestamp("synced_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDate: uniqueIndex("daily_labor_restaurant_date_idx")
    .on(table.restaurantId, table.date),
}));

export const insertDailySalesSchema = createInsertSchema(dailySales).omit({
  id: true,
  scrapedAt: true,
});

export type InsertDailySales = z.infer<typeof insertDailySalesSchema>;
export type DailySales = typeof dailySales.$inferSelect;

export const insertDailyLaborSchema = createInsertSchema(dailyLabor).omit({
  id: true,
  syncedAt: true,
});

export type InsertDailyLabor = z.infer<typeof insertDailyLaborSchema>;
export type DailyLabor = typeof dailyLabor.$inferSelect;

// Hourly sales data for timezone-normalized comparisons
// NOTE: Labor data is also stored in hourly_labor table, but these columns are kept for backward compatibility
export const hourlySales = pgTable("hourly_sales", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  salesDate: timestamp("sales_date").notNull(),
  hour: integer("hour").notNull(), // 0-23
  actualSales: decimal("actual_sales", { precision: 10, scale: 2 }).notNull(),
  projectedSales: decimal("projected_sales", { precision: 10, scale: 2 }),
  pastActualSales: decimal("past_actual_sales", { precision: 10, scale: 2 }), // Last week same hour
  // Legacy labor columns (kept for backward compatibility with existing data)
  projectedLabor: decimal("projected_labor", { precision: 10, scale: 2 }),
  actualLabor: decimal("actual_labor", { precision: 10, scale: 2 }),
  employeeCount: decimal("employee_count", { precision: 10, scale: 2 }),
  positionBreakdown: jsonb("position_breakdown").$type<Record<string, number>>(),
  scrapedAt: timestamp("scraped_at").defaultNow(),
});

// Hourly labor data from 7shifts - stored separately to keep sales tables clean
export const hourlyLabor = pgTable("hourly_labor", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  hour: integer("hour").notNull(), // 0-23
  projectedLabor: decimal("projected_labor", { precision: 10, scale: 2 }), // Scheduled labor cost for this hour
  actualLabor: decimal("actual_labor", { precision: 10, scale: 2 }), // Actual labor cost from punched hours
  employeeCount: decimal("employee_count", { precision: 10, scale: 2 }), // Total labor hours deployed during this hour
  positionBreakdown: jsonb("position_breakdown").$type<Record<string, number>>(), // Hours by position: { "Manager": 1.5, "Team Member": 3.0 }
  syncedAt: timestamp("synced_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDateHour: uniqueIndex("hourly_labor_restaurant_date_hour_idx")
    .on(table.restaurantId, table.date, table.hour),
}));

export const insertHourlySalesSchema = createInsertSchema(hourlySales).omit({
  id: true,
  scrapedAt: true,
});

export type InsertHourlySales = z.infer<typeof insertHourlySalesSchema>;
export type HourlySales = typeof hourlySales.$inferSelect;

export const insertHourlyLaborSchema = createInsertSchema(hourlyLabor).omit({
  id: true,
  syncedAt: true,
});

export type InsertHourlyLabor = z.infer<typeof insertHourlyLaborSchema>;
export type HourlyLabor = typeof hourlyLabor.$inferSelect;

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

// Daily Google reviews snapshot - stores review score per restaurant per day
export const dailyGoogleReviews = pgTable("daily_google_reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  rating: decimal("rating", { precision: 2, scale: 1 }), // Google rating 1.0-5.0
  reviewCount: integer("review_count"), // Total number of reviews
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  isFinalSnapshot: boolean("is_final_snapshot").default(false), // True if this is end-of-day snapshot
}, (table) => ({
  uniqueRestaurantDate: uniqueIndex("daily_google_reviews_restaurant_date_idx")
    .on(table.restaurantId, table.date),
}));

export const insertDailyGoogleReviewsSchema = createInsertSchema(dailyGoogleReviews).omit({
  id: true,
  lastSyncedAt: true,
});

export type InsertDailyGoogleReviews = z.infer<typeof insertDailyGoogleReviewsSchema>;
export type DailyGoogleReviews = typeof dailyGoogleReviews.$inferSelect;

// Types for API responses
export interface RestaurantSales {
  restaurantId: string;
  restaurantName: string;
  timezone: string;
  todaySales: number; // Normalized sales for fair ranking (capped at normalized hour)
  actualSales: number; // Actual current sales (all available hours, matches 7shifts)
  lastWeekSales: number; // Normalized last week (for ranking comparison)
  actualLastWeekSales: number; // Full last week sales (all hours, for display)
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
  // Unit status fields
  status?: "training" | "new" | "established"; // Based on openDate
  daysOpen?: number; // Days since open date (for NEW UNIT countdown)
  openDate?: string | null; // Open date for training units display
  revenuePorts?: string[] | null; // Revenue ports: dine_in, drive_thru, app, 3pd
  weather?: {
    temp: number;
    highTemp?: number; // For historical data: actual daily high
    lowTemp?: number;  // For historical data: actual daily low
    condition: string;
    humidity: number;
    windSpeed: number;
  } | null;
  driveThru?: {
    carCount: number;
    avgTotalTime: number; // seconds
    avgServiceTime: number; // seconds
  } | null;
  googleReviews?: {
    rating: number; // 1.0-5.0
    reviewCount: number;
    newReviewsToday: number; // New reviews received today (compared to yesterday)
  } | null;
}

export interface HourlySalesData {
  hour: number;
  todaySales: number;
  lastWeekSales: number;
  forecastSales: number;
  projectedLabor: number; // Scheduled labor cost for this hour
  actualLabor: number; // Actual labor cost from punched hours
  employeeCount: number; // Number of employees on clock during this hour
  positionBreakdown?: Record<string, number>; // Hours by position: { "Manager": 1.5, "Team Member": 3.0 }
  label: string;
  // HME drive-thru data
  avgServiceTime?: number; // Window time in seconds (SOS)
  carCount?: number; // Number of cars in that hour
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

// HME drive-thru timer data (hourly aggregates)
export const hmeTimerData = pgTable("hme_timer_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  hour: integer("hour").notNull(), // 0-23
  carCount: integer("car_count").notNull().default(0),
  avgTotalTime: integer("avg_total_time").notNull().default(0), // seconds
  avgMenuBoardTime: integer("avg_menu_board_time").notNull().default(0), // seconds
  avgServiceTime: integer("avg_service_time").notNull().default(0), // seconds
  avgQueueTime: integer("avg_queue_time").notNull().default(0), // seconds
  maxTotalTime: integer("max_total_time").notNull().default(0),
  minTotalTime: integer("min_total_time").notNull().default(0),
  syncedAt: timestamp("synced_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDateHour: uniqueIndex("hme_timer_restaurant_date_hour_idx")
    .on(table.restaurantId, table.date, table.hour),
}));

export const insertHmeTimerDataSchema = createInsertSchema(hmeTimerData).omit({
  id: true,
  syncedAt: true,
});

export type InsertHmeTimerData = z.infer<typeof insertHmeTimerDataSchema>;
export type HmeTimerData = typeof hmeTimerData.$inferSelect;

// Daily weather data for historical reference
export const dailyWeather = pgTable("daily_weather", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  highTemp: decimal("high_temp", { precision: 5, scale: 2 }),
  lowTemp: decimal("low_temp", { precision: 5, scale: 2 }),
  avgTemp: decimal("avg_temp", { precision: 5, scale: 2 }),
  condition: text("condition"), // Most common condition of the day
  humidity: integer("humidity"), // Average humidity
  windSpeed: decimal("wind_speed", { precision: 5, scale: 2 }),
  savedAt: timestamp("saved_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDate: uniqueIndex("daily_weather_restaurant_date_idx")
    .on(table.restaurantId, table.date),
}));

export const insertDailyWeatherSchema = createInsertSchema(dailyWeather).omit({
  id: true,
  savedAt: true,
});

export type InsertDailyWeather = z.infer<typeof insertDailyWeatherSchema>;
export type DailyWeather = typeof dailyWeather.$inferSelect;

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
