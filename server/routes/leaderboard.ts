import { Router } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { hourlySales, hourlyLabor, hourlyCrew, restaurants, markets, restaurantMarkets, dailyOsat, hmeTimerData, osatData as osatDataTable } from "@shared/schema";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { fetchWeather, fetchHistoricalWeather } from "../utils/weather";
import { delay } from "../utils/db-helpers";
import { getHolidayContext, getHolidayComparisonContext, getAllHolidaysForYear } from "../holidays";
import { getDailyDriveThruSummary } from "../scraper/hme-api";
import { getOsatForDate } from "../scraper/qualtrics-api";
import { getAllHourlyPosSales } from "../xenial-webhook";

const router = Router();

// Get leaderboard data
router.get("/api/leaderboard", async (req, res) => {
  try {
    const { date } = req.query;
    let targetDate: Date;
    if (date) {
      const parts = (date as string).split('-');
      targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
    } else {
      targetDate = new Date();
    }
    const leaderboard = await storage.getLeaderboard(targetDate);

    const restaurantList = await storage.getRestaurants();
    const restaurantMap = new Map(restaurantList.map(r => [r.id, r]));

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const targetDateStr = date ? (date as string) : todayStr;

    const today = new Date(todayStr + 'T12:00:00');
    const target = new Date(targetDateStr + 'T12:00:00');
    const daysDiff = Math.floor((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
    const useHistoricalWeather = daysDiff >= 3;

    const restaurantsWithWeather = [...leaderboard.restaurants];

    if (useHistoricalWeather) {
      const batchSize = 5;
      for (let i = 0; i < restaurantsWithWeather.length; i += batchSize) {
        const batch = restaurantsWithWeather.slice(i, i + batchSize);
        const weatherResults = await Promise.all(
          batch.map(async (r) => {
            const restaurant = restaurantMap.get(r.restaurantId);
            if (restaurant?.latitude && restaurant?.longitude) {
              return await fetchHistoricalWeather(
                parseFloat(String(restaurant.latitude)),
                parseFloat(String(restaurant.longitude)),
                targetDateStr
              );
            }
            return null;
          })
        );

        for (let j = 0; j < batch.length; j++) {
          const weather = weatherResults[j];
          if (weather) {
            (restaurantsWithWeather[i + j] as any).weather = {
              temp: weather.avgTemp,
              highTemp: weather.highTemp,
              lowTemp: weather.lowTemp,
              condition: weather.condition,
              humidity: 0,
              windSpeed: 0,
            };
          }
        }

        if (i + batchSize < restaurantsWithWeather.length) {
          await delay(100);
        }
      }
    } else {
      const batchSize = 5;
      for (let i = 0; i < restaurantsWithWeather.length; i += batchSize) {
        const batch = restaurantsWithWeather.slice(i, i + batchSize);
        const weatherResults = await Promise.all(
          batch.map(async (r) => {
            const restaurant = restaurantMap.get(r.restaurantId);
            if (restaurant?.latitude && restaurant?.longitude) {
              return await fetchWeather(parseFloat(String(restaurant.latitude)), parseFloat(String(restaurant.longitude)));
            }
            return null;
          })
        );

        for (let j = 0; j < batch.length; j++) {
          (restaurantsWithWeather[i + j] as any).weather = weatherResults[j];
        }

        if (i + batchSize < restaurantsWithWeather.length) {
          await delay(100);
        }
      }
    }

    const dateStr = targetDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    console.log('[HME] Fetching drive-thru summary for date:', dateStr);
    const hmeSummary = await getDailyDriveThruSummary(dateStr);
    console.log('[HME] Got summary for', hmeSummary.size, 'restaurants');

    for (const r of restaurantsWithWeather) {
      const hmeData = hmeSummary.get(r.restaurantId);
      if (hmeData) {
        (r as any).driveThru = {
          carCount: hmeData.carCount,
          avgTotalTime: hmeData.avgTotalTime,
          avgServiceTime: hmeData.avgServiceTime,
          speedAttainment: hmeData.speedAttainment,
          carsUnder6Min: hmeData.carsUnder6Min,
        };
      }
    }

    const { getGoogleReviewsForAllRestaurants } = await import("../google-places");
    const googleReviews = await getGoogleReviewsForAllRestaurants(targetDateStr);

    for (const r of restaurantsWithWeather) {
      const reviews = googleReviews.get(r.restaurantId);
      if (reviews) {
        (r as any).googleReviews = {
          rating: reviews.rating,
          reviewCount: reviews.reviewCount,
          newReviewsToday: reviews.newReviewsToday,
        };
      }
    }

    const osatDataMap = await getOsatForDate(targetDateStr);

    for (const r of restaurantsWithWeather) {
      const osat = osatDataMap[r.restaurantId];
      if (osat) {
        (r as any).osat = {
          osatPercent: osat.osatPercent,
          totalResponses: osat.totalResponses,
          fiveStarCount: osat.fiveStarCount,
        };
      }
    }

    res.json({
      ...leaderboard,
      restaurants: restaurantsWithWeather,
    });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    res.status(500).json({
      error: "Failed to fetch leaderboard data",
      details: error instanceof Error ? error.message : String(error),
      stack: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.stack : undefined) : undefined
    });
  }
});

// Get pace data for a specific restaurant or all restaurants
router.get("/api/pace/:restaurantId", async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    const paceData = await storage.getPaceData(restaurantId, targetDate);

    const getCurrentHour = (tz: string) => {
      const options: Intl.DateTimeFormatOptions = { hour: 'numeric', hour12: false, timeZone: tz };
      return parseInt(new Intl.DateTimeFormat('en-US', options).format(new Date()));
    };
    const centralHour = getCurrentHour('America/Chicago');
    const easternHour = getCurrentHour('America/New_York');
    const currentHour = Math.min(centralHour, easternHour);

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const selectedStr = targetDate.toISOString().split('T')[0];
    const isToday = todayStr === selectedStr;

    res.json({
      data: paceData,
      currentHour: isToday ? currentHour : null,
      isToday
    });
  } catch (error) {
    console.error("Error fetching pace data:", error);
    res.status(500).json({ error: "Failed to fetch pace data" });
  }
});

// Get holiday context for today vs last week comparison
router.get("/api/holidays", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date
      ? new Date(`${date as string}T12:00:00`)
      : new Date();

    const context = getHolidayContext(targetDate);
    const comparison = getHolidayComparisonContext(targetDate);

    const thisYear = targetDate.getFullYear();
    const thisYearHolidays = getAllHolidaysForYear(thisYear);
    const lastYearHolidays = getAllHolidaysForYear(thisYear - 1);

    res.json({
      ...context,
      comparison,
      thisYearHolidays,
      lastYearHolidays
    });
  } catch (error) {
    console.error("Error fetching holidays:", error);
    res.status(500).json({ error: "Failed to fetch holiday data" });
  }
});

// Get hourly data for all restaurants (for bar charts)
router.get("/api/hourly-by-restaurant", async (req, res) => {
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

// Get hourly sales heatmap data for the past N days
router.get("/api/hourly-heatmap", async (req, res) => {
  try {
    const { days = "7", startDate: startParam, endDate: endParam } = req.query;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const today = new Date(`${todayStr}T12:00:00Z`);

    const dateRange: string[] = [];

    if (startParam && endParam) {
      const s = new Date(`${startParam}T12:00:00Z`);
      const e = new Date(`${endParam}T12:00:00Z`);
      const cursor = new Date(s);
      while (cursor <= e) {
        dateRange.push(cursor.toISOString().split('T')[0]);
        cursor.setDate(cursor.getDate() + 1);
      }
    } else if (startParam) {
      dateRange.push(startParam as string);
    } else {
      const numDays = parseInt(days as string) || 7;
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (numDays - 1));
      for (let i = 0; i < numDays; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        dateRange.push(date.toISOString().split('T')[0]);
      }
    }

    const allRestaurants = await storage.getRestaurants();
    const nowForFilter = new Date();
    nowForFilter.setHours(0, 0, 0, 0);
    const restaurantList = allRestaurants.filter(r => {
      if (!r.openDate) return true;
      const openDate = new Date(r.openDate);
      openDate.setHours(0, 0, 0, 0);
      return openDate <= nowForFilter;
    });

    const filteredHourlySales = await db.select().from(hourlySales)
      .where(
        and(
          gte(hourlySales.salesDate, new Date(`${dateRange[0]}T00:00:00Z`)),
          lte(hourlySales.salesDate, new Date(`${dateRange[dateRange.length - 1]}T23:59:59Z`))
        )
      );

    const restaurantOpenDates: Record<string, string | null> = {};
    for (const r of restaurantList) {
      restaurantOpenDates[r.id] = r.openDate ? new Date(r.openDate).toISOString().split('T')[0] : null;
    }

    const heatmapData: Record<string, Record<string, Record<number, number>>> = {};

    for (const restaurant of restaurantList) {
      heatmapData[restaurant.id] = {};
      const openDateStr = restaurantOpenDates[restaurant.id];

      for (const dateStr of dateRange) {
        if (openDateStr && dateStr < openDateStr) continue;

        heatmapData[restaurant.id][dateStr] = {};
        for (let hour = 0; hour < 24; hour++) {
          heatmapData[restaurant.id][dateStr][hour] = 0;
        }
      }
    }

    for (const sale of filteredHourlySales) {
      const saleDate = new Date(sale.salesDate);
      const saleDateStr = saleDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

      if (dateRange.includes(saleDateStr) && heatmapData[sale.restaurantId]?.[saleDateStr]) {
        heatmapData[sale.restaurantId][saleDateStr][sale.hour] = parseFloat(sale.actualSales as string) || 0;
      }
    }

    for (const dateStr of dateRange) {
      const targetDate = new Date(`${dateStr}T12:00:00Z`);
      const posSales = await getAllHourlyPosSales(targetDate);

      posSales.forEach((hourlyData, restaurantId) => {
        if (heatmapData[restaurantId]?.[dateStr]) {
          hourlyData.forEach((sales, hour) => {
            if (sales > 0) {
              heatmapData[restaurantId][dateStr][hour] = sales;
            }
          });
        }
      });
    }

    let maxSales = 0;
    for (const restaurantId of Object.keys(heatmapData)) {
      for (const dateStr of Object.keys(heatmapData[restaurantId])) {
        for (let hour = 0; hour < 24; hour++) {
          const sales = heatmapData[restaurantId][dateStr]?.[hour] ?? 0;
          if (sales > maxSales) maxSales = sales;
        }
      }
    }

    res.json({
      restaurants: restaurantList.map(r => ({ id: r.id, name: r.name })),
      dateRange,
      heatmapData,
      maxSales
    });
  } catch (error) {
    console.error("Error fetching hourly heatmap data:", error);
    res.status(500).json({ error: "Failed to fetch hourly heatmap data" });
  }
});

// Get map data with restaurant locations and weather
router.get("/api/map-data", async (req, res) => {
  try {
    const { date } = req.query;
    let targetDate: Date;
    if (date) {
      targetDate = new Date(date as string);
    } else {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      targetDate = new Date(`${todayStr}T12:00:00Z`);
    }
    const leaderboard = await storage.getLeaderboard(targetDate);
    const restaurantList = await storage.getRestaurants();

    const leaderboardMap = new Map(
      leaderboard.restaurants.map(r => [r.restaurantId, r])
    );

    const validRestaurants = restaurantList.filter(r => r.latitude && r.longitude);
    const mapData: any[] = [];

    for (const restaurant of validRestaurants) {
      const salesData = leaderboardMap.get(restaurant.id);

      let status: "training" | "new" | "established" = "established";
      if (restaurant.openDate) {
        const openDate = new Date(restaurant.openDate);
        const now = new Date();
        if (openDate > now) {
          status = "training";
        } else {
          const daysSinceOpen = Math.floor((now.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24));
          if (daysSinceOpen <= 90) {
            status = "new";
          }
        }
      }

      const todaySales = salesData?.actualSales || 0;
      const lastWeekSales = salesData?.actualLastWeekSales || 0;
      const isAheadOfPace = todaySales >= lastWeekSales;

      mapData.push({
        id: restaurant.id,
        name: restaurant.name,
        unitNumber: restaurant.unitNumber || "",
        address: restaurant.address || "",
        latitude: parseFloat(restaurant.latitude as string),
        longitude: parseFloat(restaurant.longitude as string),
        todaySales,
        lastWeekSales,
        isAheadOfPace,
        status,
        weather: null,
      });
    }

    const batchSize = 5;
    for (let i = 0; i < mapData.length; i += batchSize) {
      const batch = mapData.slice(i, i + batchSize);
      const weatherResults = await Promise.all(
        batch.map(r => fetchWeather(r.latitude, r.longitude))
      );

      for (let j = 0; j < batch.length; j++) {
        mapData[i + j].weather = weatherResults[j];
      }

      if (i + batchSize < mapData.length) {
        await delay(100);
      }
    }

    const holidayContext = getHolidayContext(targetDate);
    const comparison = getHolidayComparisonContext(targetDate);

    res.json({
      restaurants: mapData,
      holidays: {
        ...holidayContext,
        comparison
      }
    });
  } catch (error) {
    console.error("Error fetching map data:", error);
    res.status(500).json({ error: "Failed to fetch map data" });
  }
});

// Get weekly sales totals (Sat-Fri business week) per restaurant
// Returns current week total + prior week total for trend comparison
router.get("/api/weekly-sales", async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const today = new Date(`${todayStr}T12:00:00Z`);
    const dayOfWeek = today.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

    // Week starts Saturday (6). Find most recent Saturday.
    const daysSinceSaturday = (dayOfWeek + 1) % 7; // Sat=0, Sun=1, Mon=2, ..., Fri=6
    const currentWeekStart = new Date(today);
    currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - daysSinceSaturday);
    const currentWeekStartStr = currentWeekStart.toISOString().split('T')[0];

    const priorWeekStart = new Date(currentWeekStart);
    priorWeekStart.setUTCDate(priorWeekStart.getUTCDate() - 7);
    const priorWeekStartStr = priorWeekStart.toISOString().split('T')[0];

    const priorWeekEnd = new Date(currentWeekStart);
    priorWeekEnd.setUTCDate(priorWeekEnd.getUTCDate() - 1);
    const priorWeekEndStr = priorWeekEnd.toISOString().split('T')[0];

    // Build date lists for current week (up to today) and prior week (full 7 days)
    const currentWeekDates: string[] = [];
    for (let i = 0; i <= daysSinceSaturday; i++) {
      const d = new Date(currentWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      const ds = d.toISOString().split('T')[0];
      if (ds <= todayStr) currentWeekDates.push(ds);
    }

    const priorWeekDates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(priorWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      priorWeekDates.push(d.toISOString().split('T')[0]);
    }

    // Query hourly_sales for both weeks
    const allDates = [...currentWeekDates, ...priorWeekDates];
    const earliestDate = priorWeekStartStr;
    const latestDate = todayStr;

    const salesRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      actualSales: hourlySales.actualSales,
    }).from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, new Date(`${earliestDate}T00:00:00Z`)),
        lte(hourlySales.salesDate, new Date(`${latestDate}T23:59:59Z`))
      )
    );

    // Aggregate by restaurant and date
    const dailySales: Record<string, Record<string, number>> = {};
    for (const row of salesRows) {
      const dateStr = new Date(row.salesDate).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      if (!dailySales[row.restaurantId]) dailySales[row.restaurantId] = {};
      if (!dailySales[row.restaurantId][dateStr]) dailySales[row.restaurantId][dateStr] = 0;
      dailySales[row.restaurantId][dateStr] += parseFloat(row.actualSales as string) || 0;
    }

    // Overlay POS data for each date (POS takes priority for today's data)
    for (const dateStr of allDates) {
      const targetDate = new Date(`${dateStr}T12:00:00Z`);
      const posSales = await getAllHourlyPosSales(targetDate);
      posSales.forEach((hourlyMap, restaurantId) => {
        let dayTotal = 0;
        hourlyMap.forEach(s => dayTotal += s);
        if (dayTotal > 0) {
          if (!dailySales[restaurantId]) dailySales[restaurantId] = {};
          dailySales[restaurantId][dateStr] = dayTotal;
        }
      });
    }

    // Build weekly totals per restaurant
    const allRestaurants = await storage.getRestaurants();
    const weeklyData: Record<string, { currentWeek: number; priorWeek: number; daysInCurrentWeek: number }> = {};

    for (const r of allRestaurants) {
      let currentWeekTotal = 0;
      let priorWeekTotal = 0;

      for (const d of currentWeekDates) {
        currentWeekTotal += dailySales[r.id]?.[d] || 0;
      }
      for (const d of priorWeekDates) {
        priorWeekTotal += dailySales[r.id]?.[d] || 0;
      }

      weeklyData[r.id] = {
        currentWeek: Math.round(currentWeekTotal),
        priorWeek: Math.round(priorWeekTotal),
        daysInCurrentWeek: currentWeekDates.length,
      };
    }

    res.json({
      currentWeekStart: currentWeekStartStr,
      currentWeekEnd: todayStr,
      priorWeekStart: priorWeekStartStr,
      priorWeekEnd: priorWeekEndStr,
      daysInCurrentWeek: currentWeekDates.length,
      daysInPriorWeek: priorWeekDates.length,
      restaurants: weeklyData,
    });
  } catch (error) {
    console.error("Error fetching weekly sales:", error);
    res.status(500).json({ error: "Failed to fetch weekly sales" });
  }
});

export default router;
