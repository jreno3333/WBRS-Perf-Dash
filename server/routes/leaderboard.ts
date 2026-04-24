import { Router } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { hourlySales, hourlyLabor, hourlyCrew, restaurants, markets, restaurantMarkets, dailyOsat, hmeTimerData, osatData as osatDataTable } from "@shared/schema";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { fetchWeather, fetchHistoricalWeather, CurrentWeather, HistoricalWeather } from "../utils/weather";
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

    const dateStr = targetDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    const { getGoogleReviewsForAllRestaurants } = await import("../google-places");

    const weatherPromise = Promise.all(
      restaurantsWithWeather.map(async (r) => {
        const restaurant = restaurantMap.get(r.restaurantId);
        if (restaurant?.latitude && restaurant?.longitude) {
          if (useHistoricalWeather) {
            return await fetchHistoricalWeather(
              parseFloat(String(restaurant.latitude)),
              parseFloat(String(restaurant.longitude)),
              targetDateStr
            );
          } else {
            return await fetchWeather(
              parseFloat(String(restaurant.latitude)),
              parseFloat(String(restaurant.longitude))
            );
          }
        }
        return null;
      })
    );

    console.log('[HME] Fetching drive-thru summary for date:', dateStr);
    const [weatherSettled, hmeSettled, googleSettled, osatSettled] = await Promise.allSettled([
      weatherPromise,
      getDailyDriveThruSummary(dateStr),
      getGoogleReviewsForAllRestaurants(targetDateStr),
      getOsatForDate(targetDateStr),
    ]);
    const weatherResults = weatherSettled.status === 'fulfilled' ? weatherSettled.value : restaurantsWithWeather.map(() => null);
    const hmeSummary = hmeSettled.status === 'fulfilled' ? hmeSettled.value : new Map();
    const googleReviews = googleSettled.status === 'fulfilled' ? googleSettled.value : new Map();
    const osatDataMap = osatSettled.status === 'fulfilled' ? osatSettled.value : new Map();
    if (weatherSettled.status === 'rejected') console.error('[Leaderboard] Weather fetch failed:', weatherSettled.reason?.message || weatherSettled.reason);
    if (hmeSettled.status === 'rejected') console.error('[Leaderboard] HME fetch failed:', hmeSettled.reason?.message || hmeSettled.reason);
    if (googleSettled.status === 'rejected') console.error('[Leaderboard] Google Reviews fetch failed:', googleSettled.reason?.message || googleSettled.reason);
    if (osatSettled.status === 'rejected') console.error('[Leaderboard] OSAT fetch failed:', osatSettled.reason?.message || osatSettled.reason);
    console.log('[HME] Got summary for', hmeSummary.size, 'restaurants');

    for (let i = 0; i < restaurantsWithWeather.length; i++) {
      const r = restaurantsWithWeather[i];
      const weather = weatherResults[i];
      if (weather) {
        if (useHistoricalWeather) {
          const hw = weather as HistoricalWeather;
          r.weather = {
            temp: hw.avgTemp,
            highTemp: hw.highTemp,
            lowTemp: hw.lowTemp,
            condition: hw.condition,
            humidity: 0,
            windSpeed: 0,
          };
        } else {
          r.weather = weather as CurrentWeather;
        }
      }

      const hmeData = hmeSummary.get(r.restaurantId);
      if (hmeData) {
        r.driveThru = {
          carCount: hmeData.carCount,
          avgTotalTime: hmeData.avgTotalTime,
          avgServiceTime: hmeData.avgServiceTime,
          speedAttainment: hmeData.speedAttainment,
          carsUnder6Min: hmeData.carsUnder6Min,
        };
      }

      const reviews = googleReviews.get(r.restaurantId);
      if (reviews) {
        r.googleReviews = {
          rating: reviews.rating,
          reviewCount: reviews.reviewCount,
          newReviewsToday: reviews.newReviewsToday,
        };
      }

      const osat = osatDataMap[r.restaurantId];
      if (osat) {
        r.osat = {
          osatPercent: osat.osatPercent,
          totalResponses: osat.totalResponses,
          fiveStarCount: osat.fiveStarCount,
        };

        // Customer-feedback speed badge: store 1682 (Cumberland Avenue) has no
        // drive-thru, so it falls back to the generic Speed of Service question.
        // All other stores use the DT Speed of Service question.
        // Methodology matches OSAT and the Qualtrics dashboard: 5-star top-box %.
        const restaurant = restaurantMap.get(r.restaurantId);
        const useGeneric = restaurant?.unitNumber === '1682';
        const source: 'dt' | 'generic' = useGeneric ? 'generic' : 'dt';
        const responses = useGeneric ? osat.genericSpeedResponses : osat.dtSpeedResponses;
        const fiveStar = useGeneric ? osat.genericSpeedFiveStarCount : osat.dtSpeedFiveStarCount;
        r.feedbackSpeed = responses > 0
          ? { topBoxPercent: (fiveStar / responses) * 100, fiveStarCount: fiveStar, responses, source }
          : { topBoxPercent: 0, fiveStarCount: 0, responses: 0, source };
      } else {
        const restaurant = restaurantMap.get(r.restaurantId);
        const useGeneric = restaurant?.unitNumber === '1682';
        r.feedbackSpeed = { topBoxPercent: 0, fiveStarCount: 0, responses: 0, source: useGeneric ? 'generic' : 'dt' };
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
    const sortedDates = [...datesToQuery].sort();
    const earliest = sortedDates[0];
    const latest = sortedDates[sortedDates.length - 1];

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
      salesMap[dStr][row.restaurantId][row.hour] = parseFloat(row.actualSales as string) || 0;
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

    // Aggregate company-wide totals through a given max hour
    function aggregateThroughHour(dateStr: string, maxHour: number): number {
      let total = 0;
      const dateData = salesMap[dateStr];
      if (!dateData) return 0;
      for (const r of activeRestaurants) {
        const rData = dateData[r.id];
        if (!rData) continue;
        for (const [h, s] of Object.entries(rData)) {
          if (parseInt(h) <= maxHour) total += s;
        }
      }
      return total;
    }

    // Aggregate full-day totals (all hours)
    function aggregateFullDay(dateStr: string): number {
      return aggregateThroughHour(dateStr, 23);
    }

    // -- Full-day totals (for completed past days) --
    const lastWeekFullDay = aggregateFullDay(lastWeekDateStr);
    const normalBaselineFullDay = normalBaselineDateStr ? aggregateFullDay(normalBaselineDateStr) : null;

    // -- Progress-to-date totals (apples-to-apples through same hour) --
    const todayProgress = aggregateThroughHour(selectedDateStr, hourCutoff);
    const lastWeekProgress = aggregateThroughHour(lastWeekDateStr, hourCutoff);
    const normalBaselineProgress = normalBaselineDateStr
      ? aggregateThroughHour(normalBaselineDateStr, hourCutoff)
      : null;

    // Forecast: today actual (including in-progress hour) + future-only hours from baseline
    // Uses all actual sales accumulated so far, not just completed-hour sales,
    // so the projection updates smoothly as orders come in during the current hour.
    const todayAllActual = aggregateFullDay(selectedDateStr);
    const maxCurrentHour = isToday ? Math.max(...currentHours) : 23;
    let forecastSales = isToday ? todayAllActual : todayProgress;
    if (isToday) {
      const forecastSourceDate = normalBaselineDateStr || lastWeekDateStr;
      const sourceData = salesMap[forecastSourceDate];
      if (sourceData) {
        for (const r of activeRestaurants) {
          const rData = sourceData[r.id];
          if (!rData) continue;
          for (const [h, s] of Object.entries(rData)) {
            if (parseInt(h) > maxCurrentHour) forecastSales += s;
          }
        }
      }
    }

    // Calculate variances — all progress-to-date (apples-to-apples)
    const vsHolidayProgress = lastWeekProgress > 0
      ? ((todayProgress / lastWeekProgress) - 1) * 100
      : null;
    const vsNormalProgress = normalBaselineProgress && normalBaselineProgress > 0
      ? ((todayProgress / normalBaselineProgress) - 1) * 100
      : null;

    // Full-day variances — holiday boost vs normal, forecast vs normal
    const holidayVsNormal = normalBaselineFullDay && normalBaselineFullDay > 0 && lastWeekFullDay > 0
      ? ((lastWeekFullDay / normalBaselineFullDay) - 1) * 100
      : null;
    const forecastVsNormal = normalBaselineFullDay && normalBaselineFullDay > 0
      ? ((forecastSales / normalBaselineFullDay) - 1) * 100
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
        today: Math.round(todayProgress),
        lastWeek: Math.round(lastWeekProgress),
        lastWeekFullDay: Math.round(lastWeekFullDay),
        normalBaseline: normalBaselineFullDay != null ? Math.round(normalBaselineFullDay) : null,
        normalBaselineProgress: normalBaselineProgress != null ? Math.round(normalBaselineProgress) : null,
        forecast: Math.round(forecastSales),
      },
      variance: {
        vsLastWeek: vsHolidayProgress != null ? Math.round(vsHolidayProgress * 10) / 10 : null,
        vsNormal: vsNormalProgress != null ? Math.round(vsNormalProgress * 10) / 10 : null,
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
      hourlySalesMap[row.restaurantId][dateStr][h] = parseFloat(row.actualSales as string) || 0;
    }

    // Overlay POS data for each date (POS takes priority)
    // When POS has data for a restaurant/date, replace DB data entirely
    // (matches the DAY calculation in storage.ts which ignores DB when POS exists)
    for (const dateStr of allDates) {
      const targetDate = new Date(`${dateStr}T12:00:00Z`);
      const posSales = await getAllHourlyPosSales(targetDate);
      posSales.forEach((hourlyMap, restaurantId) => {
        if (!hourlySalesMap[restaurantId]) hourlySalesMap[restaurantId] = {};
        // Clear DB data for this restaurant/date so stale hours don't leak through
        hourlySalesMap[restaurantId][dateStr] = {};
        hourlyMap.forEach((sales, hour) => {
          hourlySalesMap[restaurantId][dateStr][hour] = sales;
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

    // Fetch WTD labor costs from 7shifts punches (actualLabor in hourly_labor)
    const laborRows = await db.select({
      restaurantId: hourlyLabor.restaurantId,
      date: hourlyLabor.date,
      actualLabor: hourlyLabor.actualLabor,
    }).from(hourlyLabor).where(
      and(
        gte(hourlyLabor.date, currentWeekStartStr),
        lte(hourlyLabor.date, todayStr)
      )
    );

    // Aggregate labor cost by restaurant and date
    const laborByRestaurantDate: Record<string, Record<string, number>> = {};
    for (const row of laborRows) {
      const dateKey = row.date.split('T')[0];
      if (!laborByRestaurantDate[row.restaurantId]) laborByRestaurantDate[row.restaurantId] = {};
      if (!laborByRestaurantDate[row.restaurantId][dateKey]) laborByRestaurantDate[row.restaurantId][dateKey] = 0;
      laborByRestaurantDate[row.restaurantId][dateKey] += parseFloat(row.actualLabor as string || '0');
    }

    // Build weekly totals per restaurant with hour-level precision + EOW forecast
    const allRestaurants = await storage.getRestaurants();
    // Use per-restaurant local hour cutoffs to match the DAY calculation in storage.ts
    // which uses getCurrentHourInTimezone(restaurant.timezone) - 1 for actualSales.
    // Previously we used a single company-wide minimum (getNormalizedHourCutoff) which
    // under-counted restaurants in later timezones, causing WTD != DAY on first day of week.
    const isLiveToday = todayStr === realTodayStr;
    const weeklyData: Record<string, { currentWeek: number; priorWeek: number; eowForecast: number; priorWeekFull: number; daysInCurrentWeek: number; wtdLaborCost: number }> = {};

    for (const r of allRestaurants) {
      // Per-restaurant hour cutoff matching the DAY (actualSales) calculation
      const restaurantHourCutoff = isLiveToday
        ? getCurrentHourInTimezone(r.timezone) - 1
        : 23;

      // --- WTD: actual sales Sat through selected day ---
      // Use ALL POS hours for today (no cutoff) to match actualSales on the daily card
      let currentWeekTotal = 0;
      for (const d of currentWeekDates) {
        currentWeekTotal += sumDateSales(r.id, d);
      }

      // --- Prior week (apples-to-apples mirror of WTD) ---
      // For the matching day in prior week, cap at the same completed hour so comparison is fair
      let priorWeekTotal = 0;
      for (let i = 0; i < currentWeekDates.length; i++) {
        const d = priorWeekDates[i];
        if (currentWeekDates[i] === todayStr && isLiveToday) {
          priorWeekTotal += sumDateSales(r.id, d, restaurantHourCutoff);
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

      // WTD labor cost from 7shifts punches
      let wtdLaborCost = 0;
      for (const d of currentWeekDates) {
        wtdLaborCost += laborByRestaurantDate[r.id]?.[d] || 0;
      }

      weeklyData[r.id] = {
        currentWeek: Math.round(currentWeekTotal),
        priorWeek: Math.round(priorWeekTotal),
        eowForecast: Math.round(eowForecast),
        priorWeekFull: Math.round(fullPriorWeek),
        daysInCurrentWeek: currentWeekDates.length,
        wtdLaborCost: Math.round(wtdLaborCost * 100) / 100,
      };
    }

    res.json({
      currentWeekStart: currentWeekStartStr,
      currentWeekEnd: todayStr,
      priorWeekStart: priorWeekStartStr,
      priorWeekEnd: priorWeekEndStr,
      daysInCurrentWeek: currentWeekDates.length,
      daysInPriorWeek: priorWeekDates.length,
      currentHourCT: isLiveToday ? 'per-restaurant' : 23,
      restaurants: weeklyData,
    });
  } catch (error) {
    console.error("Error fetching weekly sales:", error);
    res.status(500).json({ error: "Failed to fetch weekly sales" });
  }
});

// 2-week rolling trend: trailing 14-day sales vs prior 14-day sales per restaurant
router.get("/api/two-week-trend", async (req, res) => {
  try {
    const now = new Date();
    const realTodayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    const { date } = req.query;
    const todayStr = date ? String(date) : realTodayStr;

    const endDate = new Date(`${todayStr}T12:00:00Z`);

    const trailingStart = new Date(endDate);
    trailingStart.setUTCDate(trailingStart.getUTCDate() - 13);
    const trailingStartStr = trailingStart.toISOString().split('T')[0];

    const priorEnd = new Date(trailingStart);
    priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
    const priorEndStr = priorEnd.toISOString().split('T')[0];

    const priorStart = new Date(priorEnd);
    priorStart.setUTCDate(priorStart.getUTCDate() - 13);
    const priorStartStr = priorStart.toISOString().split('T')[0];

    const trailingDates: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(trailingStart);
      d.setUTCDate(d.getUTCDate() + i);
      trailingDates.push(d.toISOString().split('T')[0]);
    }

    const priorDates: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(priorStart);
      d.setUTCDate(d.getUTCDate() + i);
      priorDates.push(d.toISOString().split('T')[0]);
    }

    const allDates = [...trailingDates, ...priorDates];

    const salesRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      salesDate: hourlySales.salesDate,
      actualSales: hourlySales.actualSales,
    }).from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, new Date(`${priorStartStr}T00:00:00Z`)),
        lte(hourlySales.salesDate, new Date(`${todayStr}T23:59:59Z`))
      )
    );

    const salesByRestaurantDate: Record<string, Record<string, number>> = {};
    for (const row of salesRows) {
      const ds = new Date(row.salesDate).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      if (!salesByRestaurantDate[row.restaurantId]) salesByRestaurantDate[row.restaurantId] = {};
      if (!salesByRestaurantDate[row.restaurantId][ds]) salesByRestaurantDate[row.restaurantId][ds] = 0;
      salesByRestaurantDate[row.restaurantId][ds] += parseFloat(row.actualSales as string) || 0;
    }

    for (const dateStr of allDates) {
      const targetDate = new Date(`${dateStr}T12:00:00Z`);
      const posSales = await getAllHourlyPosSales(targetDate);
      posSales.forEach((hourlyMap, restaurantId) => {
        if (!salesByRestaurantDate[restaurantId]) salesByRestaurantDate[restaurantId] = {};
        salesByRestaurantDate[restaurantId][dateStr] = 0;
        hourlyMap.forEach((sales) => {
          salesByRestaurantDate[restaurantId][dateStr] += sales;
        });
      });
    }

    const allRestaurants = await storage.getRestaurants();
    const twoWeekData: Record<string, { trailing: number; prior: number }> = {};

    for (const r of allRestaurants) {
      let trailing = 0;
      for (const d of trailingDates) {
        trailing += salesByRestaurantDate[r.id]?.[d] || 0;
      }

      let prior = 0;
      for (const d of priorDates) {
        prior += salesByRestaurantDate[r.id]?.[d] || 0;
      }

      twoWeekData[r.id] = {
        trailing: Math.round(trailing),
        prior: Math.round(prior),
      };
    }

    res.json({
      trailingStart: trailingStartStr,
      trailingEnd: todayStr,
      priorStart: priorStartStr,
      priorEnd: priorEndStr,
      restaurants: twoWeekData,
    });
  } catch (error) {
    console.error("Error fetching two-week trend:", error);
    res.status(500).json({ error: "Failed to fetch two-week trend" });
  }
});

export default router;
