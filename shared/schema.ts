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
  quarterBreakdown: jsonb("quarter_breakdown").$type<{ q0: number; q1: number; q2: number; q3: number }>(), // Labor hours per 15-min quarter: q0=:00-:14, q1=:15-:29, q2=:30-:44, q3=:45-:59
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
  osat?: {
    osatPercent: number; // Percentage of 5-star responses (e.g., 85.5 = 85.5%)
    totalResponses: number;
    fiveStarCount: number;
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
  quarterBreakdown?: { q0: number; q1: number; q2: number; q3: number }; // Labor hours per 15-min quarter
  leaders?: { firstName: string; position: string }[]; // Manager, Shift Supervisor, Operator names for this hour
  label: string;
  // HME drive-thru data
  avgServiceTime?: number; // Window time in seconds (SOS)
  carCount?: number; // Number of cars in that hour
  // OSAT (customer satisfaction) data
  osatPercent?: number; // 5-star satisfaction percentage for this hour
  osatResponses?: number; // Number of survey responses for this hour
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
  destination: text("destination"), // Raw destination short_name: "dt1", "dt2", "dt3", "in", "app"
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
  carsUnder6Min: integer("cars_under_6_min").notNull().default(0),
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

// Employees table - synced from 7shifts for crew experience tracking
export const employees = pgTable("employees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sevenShiftsUserId: integer("seven_shifts_user_id").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  hireDate: date("hire_date"), // Can be null if not set in 7shifts
  invitedAt: timestamp("invited_at"), // Fallback: when they were invited to 7shifts
  active: boolean("active").notNull().default(true),
  type: text("type"), // employee, manager, asst_manager, employer
  position: text("position"), // Role name: Manager, Shift Supervisor, Team Member, etc.
  locationId: integer("location_id"), // Primary 7shifts location ID
  restaurantId: varchar("restaurant_id"), // Mapped to our restaurant
  syncedAt: timestamp("synced_at").defaultNow(),
});

export const insertEmployeeSchema = createInsertSchema(employees).omit({
  id: true,
  syncedAt: true,
});

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;

// Hourly crew data - tracks which employees worked each hour with tenure info
export const hourlyCrew = pgTable("hourly_crew", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  hour: integer("hour").notNull(), // 0-23
  crewCount: integer("crew_count").notNull().default(0),
  avgTenureMonths: decimal("avg_tenure_months", { precision: 6, scale: 1 }), // Average months of experience
  experienceScore: integer("experience_score"), // 0-100 score based on crew tenure mix
  tenureMix: jsonb("tenure_mix").$type<{ trainee: number; developing: number; experienced: number; veteran: number }>(),
  crewMembers: jsonb("crew_members").$type<{ userId: number; firstName: string; lastName: string; tenureMonths: number; category: string }[]>(),
  syncedAt: timestamp("synced_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDateHour: uniqueIndex("hourly_crew_restaurant_date_hour_idx")
    .on(table.restaurantId, table.date, table.hour),
}));

export const insertHourlyCrewSchema = createInsertSchema(hourlyCrew).omit({
  id: true,
  syncedAt: true,
});

export type InsertHourlyCrew = z.infer<typeof insertHourlyCrewSchema>;
export type HourlyCrew = typeof hourlyCrew.$inferSelect;

// Crew experience API response type
export interface CrewExperienceData {
  restaurantId: string;
  restaurantName: string;
  employeeCount: number;
  avgTenure: string; // formatted like "1yr 3mo"
  hourly: {
    hour: number;
    label: string;
    crewCount: number;
    avgTenure: string;
    score: number;
    mix: string; // "2D 1V" format
    team: { name: string; tenureMonths: number; category: 'trainee' | 'developing' | 'experienced' | 'veteran' }[];
  }[];
}

// Users table
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").unique(),
  displayName: text("display_name"),
  role: text("role").notNull().default("viewer"),
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Magic link tokens for passwordless auth
export const magicLinkTokens = pgTable("magic_link_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Email subscribers for reports
export const emailSubscribers = pgTable("email_subscribers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  isActive: boolean("is_active").notNull().default(true),
  reportTime: text("report_time").notNull().default("06:00"),
  reportTypes: text("report_types").array().notNull().default(sql`ARRAY['daily_report','leader_report']`),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertEmailSubscriberSchema = createInsertSchema(emailSubscribers).omit({
  id: true,
  createdAt: true,
});

export type InsertEmailSubscriber = z.infer<typeof insertEmailSubscriberSchema>;
export type EmailSubscriber = typeof emailSubscribers.$inferSelect;

// Report schedule configuration
export const reportSchedules = pgTable("report_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportType: text("report_type").notNull().unique(),
  sendHour: integer("send_hour").notNull().default(6),
  sendMinute: integer("send_minute").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Email send log for deduplication
export const emailSendLog = pgTable("email_send_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportDate: text("report_date").notNull(),
  email: text("email").notNull(),
  status: text("status").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
});

// Workstream applicants table - tracks applicant data by week/unit/position
export const applicants = pgTable("applicants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  digestKey: text("digest_key").notNull().unique(), // Workstream unique applicant ID
  restaurantId: varchar("restaurant_id"), // Mapped restaurant ID (nullable if location not matched)
  workstreamLocationId: text("workstream_location_id"), // Workstream location digest_key
  workstreamLocationName: text("workstream_location_name"), // Original location name from Workstream
  positionTitle: text("position_title").notNull(), // Job title (e.g., "Team Member", "Shift Leader")
  positionLevel: text("position_level"), // Normalized: team_member, shift_supervisor, manager, operator
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  status: text("status").notNull(), // in_progress, hired, rejected, etc.
  currentStage: text("current_stage"), // Application, Interview, Offer, etc.
  refererSource: text("referer_source"), // Indeed, Walk-in, Referral, etc.
  appliedAt: timestamp("applied_at"), // When the application was submitted
  hiredAt: timestamp("hired_at"), // When they were hired (if applicable)
  weekStart: text("week_start"), // YYYY-MM-DD of the week start (Monday)
  syncedAt: timestamp("synced_at").defaultNow(),
});

export const insertApplicantSchema = createInsertSchema(applicants).omit({
  id: true,
  syncedAt: true,
});

export type InsertApplicant = z.infer<typeof insertApplicantSchema>;
export type Applicant = typeof applicants.$inferSelect;

// Workstream location mapping to our restaurants
export const workstreamLocations = pgTable("workstream_locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workstreamDigestKey: text("workstream_digest_key").notNull().unique(),
  workstreamName: text("workstream_name").notNull(),
  restaurantId: varchar("restaurant_id"), // Our restaurant ID if matched
  syncedAt: timestamp("synced_at").defaultNow(),
});

export const insertWorkstreamLocationSchema = createInsertSchema(workstreamLocations).omit({
  id: true,
  syncedAt: true,
});

export type InsertWorkstreamLocation = z.infer<typeof insertWorkstreamLocationSchema>;
export type WorkstreamLocation = typeof workstreamLocations.$inferSelect;

// Markets table - for grouping restaurants into multi-unit management groups
export const markets = pgTable("markets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  color: text("color").default("#6366f1"), // Hex color for UI display
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMarketSchema = createInsertSchema(markets).omit({
  id: true,
  createdAt: true,
});

export type InsertMarket = z.infer<typeof insertMarketSchema>;
export type Market = typeof markets.$inferSelect;

// Restaurant-Market assignments (junction table)
export const restaurantMarkets = pgTable("restaurant_markets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  marketId: varchar("market_id").notNull(),
}, (table) => ({
  uniqueRestaurantMarket: uniqueIndex("restaurant_market_unique_idx")
    .on(table.restaurantId, table.marketId),
}));

export const insertRestaurantMarketSchema = createInsertSchema(restaurantMarkets).omit({
  id: true,
});

export type InsertRestaurantMarket = z.infer<typeof insertRestaurantMarketSchema>;
export type RestaurantMarket = typeof restaurantMarkets.$inferSelect;

// Market with restaurant IDs for API responses
export interface MarketWithRestaurants extends Market {
  restaurantIds: string[];
}

// Qualtrics OSAT data (survey responses aggregated by restaurant/date/hour)
export const osatData = pgTable("osat_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  hour: integer("hour").notNull(), // 0-23
  totalResponses: integer("total_responses").notNull().default(0),
  fiveStarCount: integer("five_star_count").notNull().default(0), // Number of 5-star responses
  osatPercent: decimal("osat_percent", { precision: 5, scale: 2 }), // Calculated: (fiveStarCount / totalResponses) * 100
  syncedAt: timestamp("synced_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDateHour: uniqueIndex("osat_restaurant_date_hour_idx")
    .on(table.restaurantId, table.date, table.hour),
}));

export const insertOsatDataSchema = createInsertSchema(osatData).omit({
  id: true,
  syncedAt: true,
});

export type InsertOsatData = z.infer<typeof insertOsatDataSchema>;
export type OsatData = typeof osatData.$inferSelect;

// Daily OSAT summary per restaurant
export const dailyOsat = pgTable("daily_osat", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  totalResponses: integer("total_responses").notNull().default(0),
  fiveStarCount: integer("five_star_count").notNull().default(0),
  osatPercent: decimal("osat_percent", { precision: 5, scale: 2 }), // (fiveStarCount / totalResponses) * 100
  syncedAt: timestamp("synced_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDate: uniqueIndex("daily_osat_restaurant_date_idx")
    .on(table.restaurantId, table.date),
}));

export const insertDailyOsatSchema = createInsertSchema(dailyOsat).omit({
  id: true,
  syncedAt: true,
});

export type InsertDailyOsat = z.infer<typeof insertDailyOsatSchema>;
export type DailyOsat = typeof dailyOsat.$inferSelect;

// OSAT category issues tracking - stores low-rated categories from surveys
export const osatCategoryIssues = pgTable("osat_category_issues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  hour: integer("hour").notNull(), // 0-23
  // Category ratings (1-5 scale, null if not answered)
  orderAccuracy: integer("order_accuracy"),
  foodQuality: integer("food_quality"),
  menuOptions: integer("menu_options"),
  value: integer("value"),
  easeOfOrdering: integer("ease_of_ordering"),
  employeeFriendliness: integer("employee_friendliness"),
  speedOfService: integer("speed_of_service"),
  cleanliness: integer("cleanliness"),
  driveThruWaitTime: integer("drive_thru_wait_time"),
  overallRating: integer("overall_rating"),
  transactionId: text("transaction_id"), // Optional: to avoid duplicates
  syncedAt: timestamp("synced_at").defaultNow(),
});

export const insertOsatCategoryIssuesSchema = createInsertSchema(osatCategoryIssues).omit({
  id: true,
  syncedAt: true,
});

export type InsertOsatCategoryIssues = z.infer<typeof insertOsatCategoryIssuesSchema>;
export type OsatCategoryIssues = typeof osatCategoryIssues.$inferSelect;

// Daily suppressed sales snapshots - persists daily lost sales for historical review and future rollups
export const dailySuppressedSales = pgTable("daily_suppressed_sales", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  date: text("date").notNull(), // YYYY-MM-DD format
  restaurantId: varchar("restaurant_id").notNull(),
  restaurantName: text("restaurant_name").notNull(),
  estimatedLostSales: decimal("estimated_lost_sales", { precision: 10, scale: 2 }).notNull(),
  understaffedHours: integer("understaffed_hours").notNull().default(0),
  slowDtHours: integer("slow_dt_hours").notNull().default(0),
  totalRestaurantSales: decimal("total_restaurant_sales", { precision: 12, scale: 2 }).notNull(), // Actual sales for computing %
  savedAt: timestamp("saved_at").defaultNow(),
}, (table) => ({
  uniqueDateRestaurant: uniqueIndex("daily_suppressed_sales_date_restaurant_idx")
    .on(table.date, table.restaurantId),
}));

export const insertDailySuppressedSalesSchema = createInsertSchema(dailySuppressedSales).omit({
  id: true,
  savedAt: true,
});

export type InsertDailySuppressedSales = z.infer<typeof insertDailySuppressedSalesSchema>;
export type DailySuppressedSales = typeof dailySuppressedSales.$inferSelect;

// ─── Arena (Gamification / Recognition Engine) ─────────────────────────────

// Arena configuration - single JSON document with all badge rules, streak config, notification settings
export const arenaConfig = pgTable("arena_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  config: jsonb("config").notNull(), // Full arena config JSON
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: text("updated_by"), // User email or "system"
});

export type ArenaConfig = typeof arenaConfig.$inferSelect;

// Arena badges earned - log of every badge earned
export const arenaBadgesEarned = pgTable("arena_badges_earned", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  badgeId: text("badge_id").notNull(), // References badge config id
  entityId: text("entity_id").notNull(), // Leader sevenShiftsUserId or restaurantId
  entityType: text("entity_type").notNull(), // "leader" or "unit"
  entityName: text("entity_name"), // Display name at time of earning
  restaurantId: varchar("restaurant_id"), // Store where badge was earned
  earnedAt: timestamp("earned_at").defaultNow(),
  evalDate: text("eval_date"), // YYYY-MM-DD date being evaluated
  evalHour: integer("eval_hour"), // Hour being evaluated (0-23)
  metricValue: decimal("metric_value", { precision: 10, scale: 2 }), // Actual metric value that earned the badge
  shiftTeamMembers: jsonb("shift_team_members").$type<{ userId: number; name: string; role: string }[]>(),
  configSnapshot: jsonb("config_snapshot"), // Badge config at time of earning
});

export type ArenaBadgeEarned = typeof arenaBadgesEarned.$inferSelect;

// Arena streaks - active and historical streaks
export const arenaStreaks = pgTable("arena_streaks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityId: text("entity_id").notNull(), // Leader or restaurant ID
  entityType: text("entity_type").notNull(), // "leader" or "unit"
  entityName: text("entity_name"),
  restaurantId: varchar("restaurant_id"),
  streakStart: text("streak_start").notNull(), // YYYY-MM-DD
  streakCount: integer("streak_count").notNull().default(0),
  streakActive: boolean("streak_active").notNull().default(true),
  lastEvaluated: text("last_evaluated"), // YYYY-MM-DD
  highestMilestone: integer("highest_milestone").default(0), // Highest milestone days reached
  endedAt: text("ended_at"), // YYYY-MM-DD when streak broke (null if active)
});

export type ArenaStreak = typeof arenaStreaks.$inferSelect;

// Arena records - company records
export const arenaRecords = pgTable("arena_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  recordType: text("record_type").notNull(), // e.g., "most_transactions_hour", "fastest_dt_avg"
  holderId: text("holder_id").notNull(), // Restaurant or leader ID
  holderType: text("holder_type").notNull(), // "leader" or "unit"
  holderName: text("holder_name"),
  restaurantId: varchar("restaurant_id"),
  value: decimal("value", { precision: 10, scale: 2 }).notNull(),
  setAt: timestamp("set_at").defaultNow(),
  evalDate: text("eval_date"), // YYYY-MM-DD
  evalHour: integer("eval_hour"), // 0-23
  teamMembers: jsonb("team_members").$type<{ userId: number; name: string; role: string }[]>(),
});

export type ArenaRecord = typeof arenaRecords.$inferSelect;

// Arena messages - push message log
export const arenaMessages = pgTable("arena_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  restaurantId: varchar("restaurant_id"),
  messageType: text("message_type").notNull(), // "praise", "coaching", "badge_earned", "streak_milestone", etc.
  subject: text("subject"),
  message: text("message").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
  auto: boolean("auto").notNull().default(true), // true = auto-generated, false = manual
  team: boolean("team").notNull().default(false), // true = sent to shift team
  badgeId: text("badge_id"), // Optional reference to badge that triggered message
});

export type ArenaMessage = typeof arenaMessages.$inferSelect;

// Arena badge images - custom badge images
export const arenaBadgeImages = pgTable("arena_badge_images", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  badgeId: text("badge_id").notNull().unique(),
  imageUrl: text("image_url").notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
});

export type ArenaBadgeImage = typeof arenaBadgeImages.$inferSelect;

// Historical daily sales summary - uploaded via CSV for YoY comparisons
export const historicalDailySales = pgTable("historical_daily_sales", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD format
  netSales: decimal("net_sales", { precision: 12, scale: 2 }).notNull(),
  guestCount: integer("guest_count").notNull().default(0),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
}, (table) => ({
  uniqueRestaurantDate: uniqueIndex("historical_daily_sales_restaurant_date_idx")
    .on(table.restaurantId, table.date),
}));

export const insertHistoricalDailySalesSchema = createInsertSchema(historicalDailySales).omit({
  id: true,
  uploadedAt: true,
});

export type InsertHistoricalDailySales = z.infer<typeof insertHistoricalDailySalesSchema>;
export type HistoricalDailySales = typeof historicalDailySales.$inferSelect;
