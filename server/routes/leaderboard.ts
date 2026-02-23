import { Router } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { hourlySales, hourlyLabor, hourlyCrew, restaurants, markets, restaurantMarkets, dailyOsat, hmeTimerData, osatData as osatDataTable } from "@shared/schema";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { fetchWeather, fetchHistoricalWeather } from "../utils/weather";
import { delay } from "../utils/db-helpers";
import { getHolidayContext, getHolidayComparisonContext, getAllHolidaysForYear, getNormalBaselineDate } from "../holidays";
import { getDailyDriveThruSummary } from "../scraper/hme-api";
import { getOsatForDate } from "../scraper/qualtrics-api";
import { getAllHourlyPosSales } from "../xenial-webhook";
import { getCurrentHourInTimezone } from "../utils/dates";

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

// Holiday sales comparison: provides a 3-way comparison when a holiday is in the
// comparison window.  Returns today's sales, the holiday comparison day (last week),
// and a "normal" non-holiday same-day-of-week baseline so users can see that current
// performance isn't actually slower — the comparison target was just inflated by a holiday.
router.get("/api/holiday-sales-comparison", async (req, res) => {
  try {
    const { date } = req.query;
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const selectedDateStr = date ? String(date) : todayStr;
    const selectedDate = new Date(`${selectedDateStr}T12:00:00`);
    const isToday = selectedDateStr === todayStr;

    // Determine holiday context
    const context = getHolidayContext(selectedDate);
    const { todayHoliday, lastWeekHoliday } = context;

    // Only return data when a holiday is in play
    if (!todayHoliday && !lastWeekHoliday) {
      res.json({ applicable: false });
      return;
    }

    // Dates involved
    const lastWeekDate = new Date(selectedDate);
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const lastWeekDateStr = lastWeekDate.toISOString().split('T')[0];

    // Find the normal (non-holiday) baseline — same day-of-week, 2+ weeks back
    const normalBaselineDateStr = getNormalBaselineDate(selectedDate);

    // Fetch restaurants for aggregation
    const restaurantList = await storage.getRestaurants();
    const activeRestaurants = restaurantList.filter(r => {
      if (!r.openDate) return true;
      const openDate = new Date(r.openDate);
      return openDate <= now;
    });

    // Determine hour cutoff for fair comparison
    const timezones = Array.from(new Set(activeRestaurants.map(r => r.timezone)));
    const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
    const hourCutoff = isToday ? Math.min(...currentHours) - 1 : 23;

    // Build date list for the DB query
    const datesToQuery = [selectedDateStr, lastWeekDateStr];
    if (normalBaselineDateStr) datesToQuery.push(normalBaselineDateStr);
    const earliest = datesToQuery.sort()[0];
    const latest = datesToQuery.sort()[datesToQuery.length - 1];

    // Fetch hourly sales from DB
    const salesRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      hour: hourlySales.hour,
      actualSales: hourlySales.actualSales,
    }).from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, new Date(`${earliest}T00:00:00Z`)),
        lte(hourlySales.salesDate, new Date(`${latest}T23:59:59Z`))
      )
    );

    // Index: { date: { restaurantId: { hour: sales } } }
    const salesMap: Record<string, Record<string, Record<number, number>>> = {};
    for (const row of salesRows) {
      const dStr = new Date(row.salesDate).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      if (!salesMap[dStr]) salesMap[dStr] = {};
      if (!salesMap[dStr][row.restaurantId]) salesMap[dStr][row.restaurantId] = {};
      salesMap[dStr][row.restaurantId][row.hour] =
        (salesMap[dStr][row.restaurantId][row.hour] || 0) + (parseFloat(row.actualSales as string) || 0);
    }

    // Overlay POS data (takes priority)
    for (const dStr of datesToQuery) {
      const targetDt = new Date(`${dStr}T12:00:00Z`);
      const posSales = await getAllHourlyPosSales(targetDt);
      posSales.forEach((hourlyMap, restaurantId) => {
        if (!salesMap[dStr]) salesMap[dStr] = {};
        if (!salesMap[dStr][restaurantId]) salesMap[dStr][restaurantId] = {};
        hourlyMap.forEach((sales, hour) => {
          if (sales > 0) {
            salesMap[dStr][restaurantId][hour] = sales;
          }
        });
      });
    }

    // Aggregate company-wide totals through hourCutoff
    function aggregateSales(dateStr: string): number {
      let total = 0;
      const dateData = salesMap[dateStr];
      if (!dateData) return 0;
      for (const r of activeRestaurants) {
        const rData = dateData[r.id];
        if (!rData) continue;
        for (const [h, s] of Object.entries(rData)) {
          if (parseInt(h) <= hourCutoff) total += s;
        }
      }
      return total;
    }

    // Aggregate full-day totals (for completed days)
    function aggregateFullDaySales(dateStr: string): number {
      let total = 0;
      const dateData = salesMap[dateStr];
      if (!dateData) return 0;
      for (const r of activeRestaurants) {
        const rData = dateData[r.id];
        if (!rData) continue;
        for (const s of Object.values(rData)) {
          total += s;
        }
      }
      return total;
    }

    const todaySales = aggregateSales(selectedDateStr);
    const lastWeekSales = isToday ? aggregateSales(lastWeekDateStr) : aggregateFullDaySales(lastWeekDateStr);
    const normalBaselineSales = normalBaselineDateStr
      ? aggregateFullDaySales(normalBaselineDateStr)
      : null;

    // Forecast: today actual + remaining hours from last week
    let forecastSales = todaySales;
    if (isToday) {
      const lwDateData = salesMap[lastWeekDateStr];
      if (lwDateData) {
        for (const r of activeRestaurants) {
          const rData = lwDateData[r.id];
          if (!rData) continue;
          for (const [h, s] of Object.entries(rData)) {
            if (parseInt(h) > hourCutoff) forecastSales += s;
          }
        }
      }
    }

    // Calculate variances
    const vsHoliday = lastWeekSales > 0 ? ((todaySales / lastWeekSales) - 1) * 100 : null;
    const vsNormal = normalBaselineSales && normalBaselineSales > 0
      ? ((todaySales / normalBaselineSales) - 1) * 100
      : null;
    const holidayVsNormal = normalBaselineSales && normalBaselineSales > 0 && lastWeekSales > 0
      ? ((lastWeekSales / normalBaselineSales) - 1) * 100
      : null;
    const forecastVsNormal = normalBaselineSales && normalBaselineSales > 0
      ? ((forecastSales / normalBaselineSales) - 1) * 100
      : null;

    // Determine which scenario we're in
    let scenario: 'today_is_holiday' | 'comparing_to_holiday' = 'comparing_to_holiday';
    let holidayName = lastWeekHoliday?.name || '';
    if (todayHoliday) {
      scenario = 'today_is_holiday';
      holidayName = todayHoliday.name;
    }

    res.json({
      applicable: true,
      scenario,
      holidayName,
      dates: {
        today: selectedDateStr,
        lastWeek: lastWeekDateStr,
        normalBaseline: normalBaselineDateStr,
      },
      sales: {
        today: Math.round(todaySales),
        lastWeek: Math.round(lastWeekSales),
        normalBaseline: normalBaselineSales != null ? Math.round(normalBaselineSales) : null,
        forecast: Math.round(forecastSales),
      },
      variance: {
        vsLastWeek: vsHoliday != null ? Math.round(vsHoliday * 10) / 10 : null,
        vsNormal: vsNormal != null ? Math.round(vsNormal * 10) / 10 : null,
        holidayVsNormal: holidayVsNormal != null ? Math.round(holidayVsNormal * 10) / 10 : null,
        forecastVsNormal: forecastVsNormal != null ? Math.round(forecastVsNormal * 10) / 10 : null,
      },
      hourCutoff,
      isToday,
    });
  } catch (error) {
    console.error("Error fetching holiday sales comparison:", error);
    res.status(500).json({ error: "Failed to fetch holiday sales comparison" });
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
// Returns current week total + prior week total for apples-to-apples trend comparison
// Prior week is truncated to match the same elapsed days/hours as the current week
router.get("/api/weekly-sales", async (req, res) => {
  try {
    const now = new Date();
    const realTodayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    // Accept optional date param — when viewing a past date, compute the week around that date
    const { date } = req.query;
    const todayStr = date ? String(date) : realTodayStr;
    const today = new Date(`${todayStr}T12:00:00Z`);
    const dayOfWeek = today.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

    // Real current hour in Central Time (0-23)
    const realCurrentHourCT = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));

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

    // Build full current week dates (all 7 days Sat-Fri)
    const currentWeekFullDates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      currentWeekFullDates.push(d.toISOString().split('T')[0]);
    }
    const currentWeekEndStr = currentWeekFullDates[6]; // Friday

    // Build date lists for current week (up to selected day)
    const currentWeekDates: string[] = [];
    for (let i = 0; i <= daysSinceSaturday; i++) {
      const d = new Date(currentWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      const ds = d.toISOString().split('T')[0];
      if (ds <= todayStr) currentWeekDates.push(ds);
    }

    // Is the entire selected week in the past? (Friday of selected week < real today)
    const isPastWeek = currentWeekEndStr < realTodayStr;

    // Prior week dates (apples-to-apples): only match elapsed days in current week
    const priorWeekDates: string[] = [];
    for (let i = 0; i < currentWeekDates.length; i++) {
      const d = new Date(priorWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      priorWeekDates.push(d.toISOString().split('T')[0]);
    }

    // Full prior week dates (all 7 days Sat-Fri) - needed for EOW forecasting
    const priorWeekFullDates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(priorWeekStart);
      d.setUTCDate(d.getUTCDate() + i);
      priorWeekFullDates.push(d.toISOString().split('T')[0]);
    }

    // Remaining prior week dates (days not yet elapsed in current week) - for live week forecast
    const priorWeekRemainingDates = priorWeekFullDates.filter(d => !priorWeekDates.includes(d));

    // The last date in each week that needs hour-level cutoff
    const currentWeekCutoffDate = currentWeekDates[currentWeekDates.length - 1]; // selected day
    const priorWeekCutoffDate = priorWeekDates[priorWeekDates.length - 1]; // same day-of-week last week

    // Query hourly_sales for both weeks — include full current week for past-week actual EOW
    // For current week viewing a past day, we need data through real today for EOW
    const allDates = [...new Set([...currentWeekFullDates, ...priorWeekFullDates])];
    const earliestDate = priorWeekStartStr;
    const latestDate = isPastWeek ? currentWeekEndStr : realTodayStr;

    const salesRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      hour: hourlySales.hour,
      actualSales: hourlySales.actualSales,
    }).from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, new Date(`${earliestDate}T00:00:00Z`)),
        lte(hourlySales.salesDate, new Date(`${latestDate}T23:59:59Z`))
      )
    );

    // Aggregate by restaurant, date, and hour
    // Structure: { restaurantId: { date: { hour: sales } } }
    const hourlySalesMap: Record<string, Record<string, Record<number, number>>> = {};
    for (const row of salesRows) {
      const dateStr = new Date(row.salesDate).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      if (!hourlySalesMap[row.restaurantId]) hourlySalesMap[row.restaurantId] = {};
      if (!hourlySalesMap[row.restaurantId][dateStr]) hourlySalesMap[row.restaurantId][dateStr] = {};
      const h = row.hour;
      hourlySalesMap[row.restaurantId][dateStr][h] = (hourlySalesMap[row.restaurantId][dateStr][h] || 0) + (parseFloat(row.actualSales as string) || 0);
    }

    // Overlay POS data for each date (POS takes priority)
    for (const dateStr of allDates) {
      const targetDate = new Date(`${dateStr}T12:00:00Z`);
      const posSales = await getAllHourlyPosSales(targetDate);
      posSales.forEach((hourlyMap, restaurantId) => {
        if (!hourlySalesMap[restaurantId]) hourlySalesMap[restaurantId] = {};
        if (!hourlySalesMap[restaurantId][dateStr]) hourlySalesMap[restaurantId][dateStr] = {};
        hourlyMap.forEach((sales, hour) => {
          if (sales > 0) {
            hourlySalesMap[restaurantId][dateStr][hour] = sales;
          }
        });
      });
    }

    // Helper: sum sales for a date, optionally capped at a max hour
    function sumDateSales(restaurantId: string, dateStr: string, maxHour?: number): number {
      const dayData = hourlySalesMap[restaurantId]?.[dateStr];
      if (!dayData) return 0;
      let total = 0;
      for (const [hourStr, sales] of Object.entries(dayData)) {
        const h = parseInt(hourStr);
        if (maxHour !== undefined && h > maxHour) continue;
        total += sales;
      }
      return total;
    }

    // Helper: sum ALL hours for a date (full day total from prior week)
    function sumFullDaySales(restaurantId: string, dateStr: string): number {
      return sumDateSales(restaurantId, dateStr);
    }

    // Helper: sum only remaining hours after a cutoff (for forecast)
    function sumRemainingHoursSales(restaurantId: string, dateStr: string, afterHour: number): number {
      const dayData = hourlySalesMap[restaurantId]?.[dateStr];
      if (!dayData) return 0;
      let total = 0;
      for (const [hourStr, sales] of Object.entries(dayData)) {
        const h = parseInt(hourStr);
        if (h > afterHour) total += sales;
      }
      return total;
    }

    // Build weekly totals per restaurant with hour-level precision + EOW forecast
    const allRestaurants = await storage.getRestaurants();
    const weeklyData: Record<string, { currentWeek: number; priorWeek: number; eowForecast: number; priorWeekFull: number; daysInCurrentWeek: number }> = {};

    for (const r of allRestaurants) {
      // Use each restaurant's local timezone for the hour cutoff (matches DAY calculation in storage.ts)
      const restaurantWtdHourCutoff = (todayStr === realTodayStr)
        ? Math.max(0, getCurrentHourInTimezone(r.timezone) - 1)
        : 23;

      // --- WTD: actual sales Sat through selected day ---
      let currentWeekTotal = 0;
      for (const d of currentWeekDates) {
        if (d === todayStr) {
          currentWeekTotal += sumDateSales(r.id, d, restaurantWtdHourCutoff);
        } else {
          currentWeekTotal += sumDateSales(r.id, d);
        }
      }

      // --- Prior week (apples-to-apples mirror of WTD) ---
      let priorWeekTotal = 0;
      for (let i = 0; i < currentWeekDates.length; i++) {
        const d = priorWeekDates[i];
        if (currentWeekDates[i] === todayStr) {
          priorWeekTotal += sumDateSales(r.id, d, restaurantWtdHourCutoff);
        } else {
          priorWeekTotal += sumDateSales(r.id, d);
        }
      }

      // --- Full prior week (all 7 days for EOW comparison) ---
      let fullPriorWeek = 0;
      for (const d of priorWeekFullDates) {
        fullPriorWeek += sumFullDaySales(r.id, d);
      }

      // --- EOW: all actual data through real "now" + forecast for remaining time ---
      let eowActual = 0;
      let forecastRemaining = 0;

      if (isPastWeek) {
        // Entire week is complete — EOW = actual full week, no forecast
        for (const d of currentWeekFullDates) {
          eowActual += sumFullDaySales(r.id, d);
        }
      } else {
        // Current week — sum actuals through real today + forecast remaining
        // Use each restaurant's local completed hour so actuals only count finished hours,
        // and forecast picks up from the current in-progress hour onward via LW data.
        // This avoids a gap where POS hasn't reported the in-progress hour yet.
        const restaurantCompletedHour = Math.max(0, getCurrentHourInTimezone(r.timezone) - 1);

        // 1. Actual: complete days before real today + real today through completed hour
        for (const d of currentWeekFullDates) {
          if (d < realTodayStr) {
            eowActual += sumFullDaySales(r.id, d);
          } else if (d === realTodayStr) {
            eowActual += sumDateSales(r.id, d, restaurantCompletedHour);
          }
          // days after real today: skip (will be forecast)
        }

        // 2. Forecast remaining from prior week:
        // Find the prior week day matching real today's day-of-week
        const realTodayDow = new Date(`${realTodayStr}T12:00:00Z`).getUTCDay();
        const realDaysSinceSat = (realTodayDow + 1) % 7;
        const priorWeekMatchingToday = priorWeekFullDates[realDaysSinceSat];

        // Remaining hours today from LW (starting from the current in-progress hour)
        forecastRemaining += sumRemainingHoursSales(r.id, priorWeekMatchingToday, restaurantCompletedHour);

        // Full days after real today through Friday from LW
        for (let i = realDaysSinceSat + 1; i < 7; i++) {
          forecastRemaining += sumFullDaySales(r.id, priorWeekFullDates[i]);
        }
      }

      const eowForecast = eowActual + forecastRemaining;

      weeklyData[r.id] = {
        currentWeek: Math.round(currentWeekTotal),
        priorWeek: Math.round(priorWeekTotal),
        eowForecast: Math.round(eowForecast),
        priorWeekFull: Math.round(fullPriorWeek),
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
      currentHourCT: todayStr === realTodayStr ? Math.max(0, realCurrentHourCT - 1) : 23,
      restaurants: weeklyData,
    });
  } catch (error) {
    console.error("Error fetching weekly sales:", error);
    res.status(500).json({ error: "Failed to fetch weekly sales" });
  }
});

export default router;
