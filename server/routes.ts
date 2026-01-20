import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { fetchSalesFromAPI, fetchHistoricalSales, fetchHistoricalHourlySales, fetchHourlySalesFromAPI, syncLocationsFromAPI } from "./scraper/7shifts-api";
import { db } from "./db";
import { scraperRuns } from "@shared/schema";
import { desc } from "drizzle-orm";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Get leaderboard data
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const leaderboard = await storage.getLeaderboard(targetDate);
      res.json(leaderboard);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard data" });
    }
  });

  // Get pace data for a specific restaurant or all restaurants
  app.get("/api/pace/:restaurantId", async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const paceData = await storage.getPaceData(restaurantId, targetDate);
      res.json(paceData);
    } catch (error) {
      console.error("Error fetching pace data:", error);
      res.status(500).json({ error: "Failed to fetch pace data" });
    }
  });

  // Get all restaurants
  app.get("/api/restaurants", async (req, res) => {
    try {
      const restaurants = await storage.getRestaurants();
      res.json(restaurants);
    } catch (error) {
      console.error("Error fetching restaurants:", error);
      res.status(500).json({ error: "Failed to fetch restaurants" });
    }
  });

  // Get hourly data for all restaurants (for bar charts)
  app.get("/api/hourly-by-restaurant", async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date ? new Date(date as string) : new Date();
      const hourlyData = await storage.getHourlyDataByRestaurant(targetDate);
      res.json(hourlyData);
    } catch (error) {
      console.error("Error fetching hourly data by restaurant:", error);
      res.status(500).json({ error: "Failed to fetch hourly data" });
    }
  });

  // Trigger manual API sync
  app.post("/api/scraper/run", async (req, res) => {
    try {
      const { date } = req.body || {};
      const targetDate = date ? new Date(date) : undefined;
      
      res.json({ message: "API sync started", status: "running" });
      
      fetchSalesFromAPI(targetDate).then(result => {
        console.log("API sync completed:", result);
      }).catch(err => {
        console.error("API sync error:", err);
      });
    } catch (error) {
      console.error("Error starting API sync:", error);
      res.status(500).json({ error: "Failed to start API sync" });
    }
  });

  // Get scraper/sync status
  app.get("/api/scraper/status", async (req, res) => {
    try {
      const latestRuns = await db.select()
        .from(scraperRuns)
        .orderBy(desc(scraperRuns.startedAt))
        .limit(10);
      
      res.json({
        hasApiToken: !!process.env.SEVENSHIFTS_API_TOKEN,
        latestRuns,
      });
    } catch (error) {
      console.error("Error fetching sync status:", error);
      res.status(500).json({ error: "Failed to fetch sync status" });
    }
  });

  // Sync locations from 7shifts
  app.post("/api/scraper/sync-locations", async (req, res) => {
    try {
      const count = await syncLocationsFromAPI();
      res.json({ message: `Synced ${count} locations`, count });
    } catch (error) {
      console.error("Error syncing locations:", error);
      res.status(500).json({ error: "Failed to sync locations" });
    }
  });

  // Fetch historical data (last N days)
  app.post("/api/scraper/historical", async (req, res) => {
    try {
      const { days = 7 } = req.body;
      
      res.json({ message: `Starting historical fetch for ${days} days`, status: "running" });
      
      fetchHistoricalSales(days).then(() => {
        console.log("Historical fetch completed");
      }).catch(err => {
        console.error("Historical fetch error:", err);
      });
    } catch (error) {
      console.error("Error starting historical fetch:", error);
      res.status(500).json({ error: "Failed to start historical fetch" });
    }
  });

  // Fetch historical hourly data (last N days)
  app.post("/api/scraper/historical-hourly", async (req, res) => {
    try {
      const { days = 8 } = req.body;
      
      res.json({ message: `Starting historical hourly fetch for ${days} days`, status: "running" });
      
      fetchHistoricalHourlySales(days).then(() => {
        console.log("Historical hourly fetch completed");
      }).catch(err => {
        console.error("Historical hourly fetch error:", err);
      });
    } catch (error) {
      console.error("Error starting historical hourly fetch:", error);
      res.status(500).json({ error: "Failed to start historical hourly fetch" });
    }
  });

  return httpServer;
}
