import {
  type Restaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData,
  type InsertDailyWeather,
  type DailyWeather,
  type HourlyLabor,
  restaurants,
  dailySales,
  dailyWeather,
  hourlySales,
  hourlyLabor,
  hourlyCrew,
  hmeTimerData,
  scraperRuns,
  posOrders,
} from "@shared/schema";
import { db, posDb } from "./db";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { getPosSalesByRestaurant, getAllHourlyPosSales } from "./xenial-webhook";
import { getHourlyOsatForDate } from "./scraper/qualtrics-api";
import { getCurrentHourInTimezone, getTodayInTimezone, getNormalizedHourCutoff } from "./utils/dates";
import { deduplicateHourly } from "./utils/db-helpers";

export class DatabaseStorage {

  async getRestaurants(): Promise<Restaurant[]> {
    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    return allRestaurants.filter(r =>
      !r.name.toLowerCase().includes('training') &&
      !r.name.toLowerCase().includes('development')
    );
  }

  async getRestaurant(id: string): Promise<Restaurant | undefined> {
    const result = await db.select().from(restaurants).where(eq(restaurants.id, id));
    return result[0];
  }

  async getLeaderboard(targetDate: Date = new Date()): Promise<LeaderboardData> {
    const now = new Date();
    const selectedDate = new Date(targetDate);
    const lastWeek = new Date(selectedDate);
    lastWeek.setDate(lastWeek.getDate() - 7);

    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    const todayStr = getTodayInTimezone('America/Chicago');

    const isToday = selectedDateStr === todayStr;

    const restaurantList = await this.getRestaurants();
    const normalizedHourCutoff = isToday ? getNormalizedHourCutoff(restaurantList) : 23;

    const getRestaurantStatus = (openDate: string | Date | null | undefined): { status: "training" | "new" | "established"; daysOpen?: number } => {
      if (!openDate) return { status: "established" };
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const openDateNorm = new Date(openDate);
      openDateNorm.setHours(0, 0, 0, 0);
      if (openDateNorm > today) return { status: "training" };
      const diffTime = today.getTime() - openDateNorm.getTime();
      const daysOpen = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      if (daysOpen < 90) return { status: "new", daysOpen };
      return { status: "established", daysOpen };
    };

    // OPTIMIZED: Filter at DB level instead of fetching all rows
    const selectedDateStart = new Date(`${selectedDateStr}T00:00:00.000Z`);
    const selectedDateEnd = new Date(`${selectedDateStr}T23:59:59.999Z`);
    const lastWeekStart = new Date(`${lastWeekStr}T00:00:00.000Z`);
    const lastWeekEnd = new Date(`${lastWeekStr}T23:59:59.999Z`);

    // Only fetch hourly sales for the two dates we need
    const allHourlySales = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, lastWeekStart),
        lte(hourlySales.salesDate, selectedDateEnd)
      )
    );

    // Only fetch hourly labor for the selected date
    const allHourlyLabor = await db.select().from(hourlyLabor).where(
      eq(hourlyLabor.date, selectedDateStr)
    );

    const laborByKey = new Map<string, HourlyLabor>();
    allHourlyLabor.forEach(l => {
      const dateStr = l.date.split('T')[0];
      const key = `${l.restaurantId}-${dateStr}-${l.hour}`;
      laborByKey.set(key, l);
    });

    const posHourlySales = await getAllHourlyPosSales(selectedDate);
    const posLastWeekHourlySales = await getAllHourlyPosSales(lastWeek);

    // Only fetch daily sales for last week date
    const allDailySales = await db.select().from(dailySales).where(
      and(
        gte(dailySales.salesDate, lastWeekStart),
        lte(dailySales.salesDate, lastWeekEnd)
      )
    );
    const lastWeekDailySalesMap = new Map<string, number>();
    allDailySales.forEach(d => {
      const saleDate = new Date(d.salesDate).toISOString().split('T')[0];
      if (saleDate === lastWeekStr) {
        lastWeekDailySalesMap.set(d.restaurantId, parseFloat(d.totalSales || '0') / 100);
      }
    });

    const selectedDateHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    }));

    const lastWeekHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    }));

    const restaurantSales: RestaurantSales[] = restaurantList.map(restaurant => {
      const selectedDateRestaurantHours = selectedDateHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= normalizedHourCutoff
      );
      const allSelectedDateHours = selectedDateHourly.filter(
        s => s.restaurantId === restaurant.id
      );
      const lastWeekRestaurantHours = lastWeekHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= normalizedHourCutoff
      );

      const restaurantCurrentHour = getCurrentHourInTimezone(restaurant.timezone);
      const restaurantCompletedHour = isToday ? restaurantCurrentHour - 1 : 23;

      const lastWeekHoursForComparison = lastWeekHourly.filter(
        s => s.restaurantId === restaurant.id && s.hour <= restaurantCompletedHour
      );

      const posSalesForRestaurant = posHourlySales.get(restaurant.id);
      const posLastWeekSalesForRestaurant = posLastWeekHourlySales.get(restaurant.id);

      let selectedDateSalesAmount = 0;
      let actualSalesAmount = 0;

      if (posSalesForRestaurant && posSalesForRestaurant.size > 0) {
        posSalesForRestaurant.forEach((sales, hour) => {
          if (hour <= normalizedHourCutoff) {
            selectedDateSalesAmount += sales;
          }
          if (hour <= restaurantCompletedHour) {
            actualSalesAmount += sales;
          }
        });
      } else if (!isToday) {
        selectedDateSalesAmount = selectedDateRestaurantHours.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );
        actualSalesAmount = allSelectedDateHours.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );
      }

      let lastWeekSalesAmount = 0;
      let actualLastWeekAmount = 0;

      if (posLastWeekSalesForRestaurant && posLastWeekSalesForRestaurant.size > 0) {
        posLastWeekSalesForRestaurant.forEach((sales, hour) => {
          if (hour <= normalizedHourCutoff) {
            lastWeekSalesAmount += sales;
          }
          if (hour <= restaurantCompletedHour) {
            actualLastWeekAmount += sales;
          }
        });
      } else {
        lastWeekSalesAmount = lastWeekRestaurantHours.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );
        actualLastWeekAmount = lastWeekHoursForComparison.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );

        if (lastWeekSalesAmount === 0 && lastWeekDailySalesMap.has(restaurant.id)) {
          const dailyTotal = lastWeekDailySalesMap.get(restaurant.id) || 0;
          const dayProgress = (normalizedHourCutoff + 1) / 24;
          lastWeekSalesAmount = dailyTotal * dayProgress;
          const displayProgress = (restaurantCompletedHour + 1) / 24;
          actualLastWeekAmount = dailyTotal * displayProgress;
        }
      }

      let lastWeekRemainingHoursSales = 0;
      if (isToday) {
        if (posLastWeekSalesForRestaurant && posLastWeekSalesForRestaurant.size > 0) {
          posLastWeekSalesForRestaurant.forEach((sales, hour) => {
            if (hour > restaurantCompletedHour) {
              lastWeekRemainingHoursSales += sales;
            }
          });
        } else {
          const lastWeekAllHoursForForecast = lastWeekHourly.filter(
            s => s.restaurantId === restaurant.id
          );
          if (lastWeekAllHoursForForecast.length > 0) {
            for (let hour = restaurantCompletedHour + 1; hour < 24; hour++) {
              const lastWeekHour = lastWeekAllHoursForForecast.find(s => s.hour === hour);
              lastWeekRemainingHoursSales += parseFloat(lastWeekHour?.actualSales || '0');
            }
          } else if (lastWeekDailySalesMap.has(restaurant.id)) {
            const dailyTotal = lastWeekDailySalesMap.get(restaurant.id) || 0;
            const remainingProgress = (24 - restaurantCompletedHour - 1) / 24;
            lastWeekRemainingHoursSales = dailyTotal * remainingProgress;
          }
        }
      }
      const rawPaceRatio = actualLastWeekAmount > 0 ? actualSalesAmount / actualLastWeekAmount : 1;
      // Dampen the pace ratio early in the day to avoid volatile projections.
      // Typical restaurant operating hours are ~6 AM to 10 PM (16 hours).
      // Early in the day, blend toward 1.0 (assume same as last week);
      // as more hours complete, trust the actual pace ratio more.
      const operatingHours = 16;
      const dayProgress = isToday ? Math.min((restaurantCompletedHour + 1) / operatingHours, 1) : 1;
      const paceRatio = 1 + (rawPaceRatio - 1) * dayProgress;
      const lastWeekFullDayAmount = actualLastWeekAmount + lastWeekRemainingHoursSales;
      const forecastSalesAmount = actualSalesAmount + lastWeekRemainingHoursSales * paceRatio;

      const completedHours = Math.max(0, normalizedHourCutoff + 1);
      const pacePercentage = (completedHours / 24) * 100;
      const isAheadOfPace = selectedDateSalesAmount >= lastWeekSalesAmount;

      let actualLaborCompleted = 0;
      let projectedLaborRemaining = 0;

      for (let hour = 0; hour <= normalizedHourCutoff; hour++) {
        const laborKey = `${restaurant.id}-${selectedDateStr}-${hour}`;
        const laborData = laborByKey.get(laborKey);
        actualLaborCompleted += parseFloat(laborData?.actualLabor || '0');
      }

      for (let hour = normalizedHourCutoff + 1; hour < 24; hour++) {
        const laborKey = `${restaurant.id}-${selectedDateStr}-${hour}`;
        const laborData = laborByKey.get(laborKey);
        projectedLaborRemaining += parseFloat(laborData?.projectedLabor || '0');
      }

      const projectedLaborCost = actualLaborCompleted + projectedLaborRemaining;

      let projectedEndOfDaySales: number;
      if (isToday) {
        let remainingForecastSales = 0;

        if (posLastWeekSalesForRestaurant && posLastWeekSalesForRestaurant.size > 0) {
          posLastWeekSalesForRestaurant.forEach((sales, hour) => {
            if (hour > normalizedHourCutoff) {
              remainingForecastSales += sales;
            }
          });
        } else {
          const lastWeekAllHours = lastWeekHourly.filter(
            s => s.restaurantId === restaurant.id
          );
          if (lastWeekAllHours.length > 0) {
            for (let hour = normalizedHourCutoff + 1; hour < 24; hour++) {
              const todayHour = allSelectedDateHours.find(s => s.hour === hour);
              const lastWeekHour = lastWeekAllHours.find(s => s.hour === hour);
              const forecastValue = parseFloat(todayHour?.projectedSales || '0') > 0
                ? parseFloat(todayHour?.projectedSales || '0')
                : parseFloat(lastWeekHour?.actualSales || '0');
              remainingForecastSales += forecastValue;
            }
          } else if (lastWeekDailySalesMap.has(restaurant.id)) {
            const dailyTotal = lastWeekDailySalesMap.get(restaurant.id) || 0;
            const remainingProgress = (24 - normalizedHourCutoff - 1) / 24;
            remainingForecastSales = dailyTotal * remainingProgress;
          }
        }

        projectedEndOfDaySales = selectedDateSalesAmount + remainingForecastSales;
      } else {
        projectedEndOfDaySales = allSelectedDateHours.reduce(
          (sum, s) => sum + parseFloat(s.actualSales || '0'), 0
        );
      }

      const projectedLaborPercent = projectedEndOfDaySales > 0
        ? (projectedLaborCost / projectedEndOfDaySales) * 100
        : 0;

      const laborTarget = parseFloat(restaurant.laborTarget || '25');
      const willHitLaborTarget = projectedLaborPercent <= laborTarget;

      const unitStatus = getRestaurantStatus(restaurant.openDate);

      return {
        restaurantId: restaurant.id.toString(),
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        todaySales: selectedDateSalesAmount,
        actualSales: actualSalesAmount,
        lastWeekSales: lastWeekSalesAmount,
        actualLastWeekSales: actualLastWeekAmount,
        forecastSales: forecastSalesAmount,
        lastWeekFullDay: lastWeekFullDayAmount,
        pacePercentage,
        isAheadOfPace,
        rank: 0,
        normalizedHour: normalizedHourCutoff,
        localCurrentHour: isToday ? getCurrentHourInTimezone(restaurant.timezone) - 1 : 23,
        projectedLaborCost: Math.round(projectedLaborCost * 100) / 100,
        projectedEndOfDaySales: Math.round(projectedEndOfDaySales * 100) / 100,
        projectedLaborPercent: Math.round(projectedLaborPercent * 10) / 10,
        laborTarget,
        willHitLaborTarget,
        status: unitStatus.status,
        daysOpen: unitStatus.daysOpen,
        openDate: restaurant.openDate && !isNaN(new Date(restaurant.openDate).getTime()) ? new Date(restaurant.openDate).toISOString() : null,
        revenuePorts: restaurant.revenuePorts,
      };
    });

    const rankedUnits = restaurantSales.filter(r => r.status !== "training");
    const trainingUnits = restaurantSales.filter(r => r.status === "training");

    rankedUnits.sort((a, b) => b.actualSales - a.actualSales);
    rankedUnits.forEach((r, idx) => { r.rank = idx + 1; });
    trainingUnits.forEach(r => { r.rank = 0; });

    const sortedRestaurantSales = [...rankedUnits, ...trainingUnits];

    let lastUpdated: string;
    if (isToday) {
      const lastPosOrder = await posDb.select()
        .from(posOrders)
        .orderBy(desc(posOrders.receivedAt))
        .limit(1);
      lastUpdated = lastPosOrder.length > 0 && lastPosOrder[0].receivedAt
        ? lastPosOrder[0].receivedAt.toISOString()
        : now.toISOString();
    } else {
      const lastSync = await db.select()
        .from(scraperRuns)
        .where(eq(scraperRuns.status, 'success'))
        .orderBy(desc(scraperRuns.completedAt))
        .limit(1);
      lastUpdated = lastSync.length > 0 && lastSync[0].completedAt
        ? lastSync[0].completedAt.toISOString()
        : now.toISOString();
    }

    return {
      restaurants: sortedRestaurantSales,
      lastUpdated,
      currentDate: selectedDateStr,
    };
  }

  async getPaceData(restaurantId: string, targetDate: Date = new Date()): Promise<HourlySalesData[]> {
    const hourlyData: HourlySalesData[] = [];
    const restaurantList = await this.getRestaurants();
    const selectedDate = new Date(targetDate);
    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    const todayStr = getTodayInTimezone('America/Chicago');

    const isToday = selectedDateStr === todayStr;
    const timezones = Array.from(new Set(restaurantList.map(r => r.timezone)));
    const currentHours = timezones.map(tz => getCurrentHourInTimezone(tz));
    const displayHourCutoff = isToday ? Math.min(...currentHours) : 23;

    const lastWeek = new Date(selectedDate);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekStr = lastWeek.toISOString().split('T')[0];

    // OPTIMIZED: Filter at DB level
    const rangeStart = new Date(`${lastWeekStr}T00:00:00.000Z`);
    const rangeEnd = new Date(`${selectedDateStr}T23:59:59.999Z`);

    const allHourlySales = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, rangeStart),
        lte(hourlySales.salesDate, rangeEnd)
      )
    );

    // Only fetch labor for selected date
    const allHourlyLabor = await db.select().from(hourlyLabor).where(
      eq(hourlyLabor.date, selectedDateStr)
    );
    const laborByKey = new Map<string, HourlyLabor>();
    allHourlyLabor.forEach(l => {
      const dateStr = l.date.split('T')[0];
      const key = `${l.restaurantId}-${dateStr}-${l.hour}`;
      laborByKey.set(key, l);
    });

    const selectedDateHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    }));

    const lastWeekHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    }));

    const selectedDateLabor = allHourlyLabor.filter(l => l.date.split('T')[0] === selectedDateStr);

    const selectedByHour: Map<number, number> = new Map();
    const lastWeekByHour: Map<number, number> = new Map();
    const forecastByHour: Map<number, number> = new Map();
    const laborByHourMap: Map<number, number> = new Map();
    const actualLaborByHour: Map<number, number> = new Map();
    const employeeCountByHour: Map<number, number> = new Map();
    const positionByHour: Map<number, Record<string, number>> = new Map();

    for (let h = 0; h < 24; h++) {
      selectedByHour.set(h, 0);
      lastWeekByHour.set(h, 0);
      forecastByHour.set(h, 0);
      laborByHourMap.set(h, 0);
      actualLaborByHour.set(h, 0);
      employeeCountByHour.set(h, 0);
    }

    if (restaurantId === "all") {
      if (isToday) {
        const posHourlySales = await getAllHourlyPosSales(selectedDate);
        const posLastWeekSales = await getAllHourlyPosSales(lastWeek);

        posHourlySales.forEach((hourlyMap) => {
          hourlyMap.forEach((sales, hour) => {
            const current = selectedByHour.get(hour) || 0;
            selectedByHour.set(hour, current + sales);
          });
        });

        posLastWeekSales.forEach((hourlyMap) => {
          hourlyMap.forEach((sales, hour) => {
            const current = lastWeekByHour.get(hour) || 0;
            lastWeekByHour.set(hour, current + sales);
          });
        });

        if (posLastWeekSales.size === 0) {
          lastWeekHourly.forEach(s => {
            const current = lastWeekByHour.get(s.hour) || 0;
            lastWeekByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
          });
        }

        lastWeekHourly.forEach(s => {
          const currentForecast = forecastByHour.get(s.hour) || 0;
          forecastByHour.set(s.hour, currentForecast + parseFloat(s.actualSales || '0'));
        });
      } else {
        selectedDateHourly.forEach(s => {
          const current = selectedByHour.get(s.hour) || 0;
          selectedByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
          const currentForecast = forecastByHour.get(s.hour) || 0;
          forecastByHour.set(s.hour, currentForecast + parseFloat(s.projectedSales || '0'));
        });
        lastWeekHourly.forEach(s => {
          const current = lastWeekByHour.get(s.hour) || 0;
          lastWeekByHour.set(s.hour, current + parseFloat(s.actualSales || '0'));
        });
      }

      selectedDateLabor.forEach(l => {
        const currentLabor = laborByHourMap.get(l.hour) || 0;
        laborByHourMap.set(l.hour, currentLabor + parseFloat(l.projectedLabor || '0'));
        const currentActualLabor = actualLaborByHour.get(l.hour) || 0;
        actualLaborByHour.set(l.hour, currentActualLabor + parseFloat(l.actualLabor || '0'));
      });
    } else {
      selectedDateHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
        selectedByHour.set(s.hour, parseFloat(s.actualSales || '0'));
        forecastByHour.set(s.hour, parseFloat(s.projectedSales || '0'));
      });
      selectedDateLabor.filter(l => l.restaurantId === restaurantId).forEach(l => {
        laborByHourMap.set(l.hour, parseFloat(l.projectedLabor || '0'));
        actualLaborByHour.set(l.hour, parseFloat(l.actualLabor || '0'));
        employeeCountByHour.set(l.hour, Number(l.employeeCount) || 0);
        if (l.positionBreakdown) {
          positionByHour.set(l.hour, l.positionBreakdown as Record<string, number>);
        }
      });
      lastWeekHourly.filter(s => s.restaurantId === restaurantId).forEach(s => {
        lastWeekByHour.set(s.hour, parseFloat(s.actualSales || '0'));
      });
    }

    for (let h = 0; h < 24; h++) {
      if ((forecastByHour.get(h) || 0) === 0 && (lastWeekByHour.get(h) || 0) > 0) {
        forecastByHour.set(h, lastWeekByHour.get(h) || 0);
      }
    }

    let cumulativeSelected = 0;
    let cumulativeLastWeek = 0;
    let cumulativeForecast = 0;

    for (let hour = 0; hour < 24; hour++) {
      if (hour <= displayHourCutoff) {
        cumulativeSelected += selectedByHour.get(hour) || 0;
        cumulativeLastWeek += lastWeekByHour.get(hour) || 0;
        cumulativeForecast += forecastByHour.get(hour) || 0;
      }

      const showCumulativeSelected = hour <= displayHourCutoff ? Math.round(cumulativeSelected) : 0;
      const showCumulativeLastWeek = hour <= displayHourCutoff
        ? Math.round(cumulativeLastWeek)
        : Math.round(cumulativeLastWeek + (lastWeekByHour.get(hour) || 0));
      const showCumulativeForecast = hour <= displayHourCutoff
        ? Math.round(cumulativeForecast)
        : Math.round(cumulativeForecast + (forecastByHour.get(hour) || 0));

      if (hour > displayHourCutoff) {
        cumulativeLastWeek += lastWeekByHour.get(hour) || 0;
        cumulativeForecast += forecastByHour.get(hour) || 0;
      }

      const projectedLabor = Math.round((laborByHourMap.get(hour) || 0) * 100) / 100;
      const actualLabor = Math.round((actualLaborByHour.get(hour) || 0) * 100) / 100;
      const employeeCount = employeeCountByHour.get(hour) || 0;
      const positionBreakdown = positionByHour.get(hour);
      hourlyData.push({
        hour,
        todaySales: showCumulativeSelected,
        lastWeekSales: showCumulativeLastWeek,
        forecastSales: showCumulativeForecast,
        projectedLabor,
        actualLabor,
        employeeCount,
        positionBreakdown,
        label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
      });
    }

    return hourlyData;
  }

  async getHourlyDataByRestaurant(targetDate: Date = new Date()): Promise<Record<string, HourlySalesData[]>> {
    const selectedDate = new Date(targetDate);
    const lastWeek = new Date(selectedDate);
    lastWeek.setDate(lastWeek.getDate() - 7);

    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    const lastWeekStr = lastWeek.toISOString().split('T')[0];
    const todayStr = getTodayInTimezone('America/Chicago');

    const isToday = selectedDateStr === todayStr;

    const restaurantList = await this.getRestaurants();

    // OPTIMIZED: Filter at DB level
    const rangeStart = new Date(`${lastWeekStr}T00:00:00.000Z`);
    const rangeEnd = new Date(`${selectedDateStr}T23:59:59.999Z`);

    const allHourlySales = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, rangeStart),
        lte(hourlySales.salesDate, rangeEnd)
      )
    );

    const selectedDateHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    }));

    const lastWeekHourly = deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    }));

    // Fallback daily sales for last week
    const lastWeekStartTs = new Date(`${lastWeekStr}T00:00:00.000Z`);
    const lastWeekEndTs = new Date(`${lastWeekStr}T23:59:59.999Z`);
    const lastWeekDailyData = await db.select().from(dailySales).where(
      and(
        gte(dailySales.salesDate, lastWeekStartTs),
        lte(dailySales.salesDate, lastWeekEndTs)
      )
    );
    const lastWeekDailyMap = new Map<string, number>();
    for (const d of lastWeekDailyData) {
      lastWeekDailyMap.set(d.restaurantId, parseFloat(String(d.totalSales)) / 100);
    }

    // Fetch supplementary data for selected date only
    const allHmeData = await db.select().from(hmeTimerData).where(sql`${hmeTimerData.date} LIKE ${selectedDateStr + '%'}`);
    const allHourlyLaborData = await db.select().from(hourlyLabor).where(sql`${hourlyLabor.date} LIKE ${selectedDateStr + '%'}`);
    const allHourlyCrewData = await db.select().from(hourlyCrew).where(sql`${hourlyCrew.date} LIKE ${selectedDateStr + '%'}`);

    const posHourlySales = await getAllHourlyPosSales(selectedDate);
    const posLastWeekHourlySales = await getAllHourlyPosSales(lastWeek);
    const hourlyOsatData = await getHourlyOsatForDate(selectedDateStr);

    const result: Record<string, HourlySalesData[]> = {};

    for (const restaurant of restaurantList) {
      const hourlyDataForRestaurant: HourlySalesData[] = [];

      const restaurantSelectedHourly = selectedDateHourly.filter(s => s.restaurantId === restaurant.id);
      const restaurantLastWeekHourly = lastWeekHourly.filter(s => s.restaurantId === restaurant.id);
      const restaurantHmeData = allHmeData.filter(h => h.restaurantId === restaurant.id);
      const restaurantLaborData = allHourlyLaborData.filter(l => l.restaurantId === restaurant.id);
      const restaurantCrewData = allHourlyCrewData.filter(c => c.restaurantId === restaurant.id);

      const selectedByHour: Map<number, number> = new Map();
      const lastWeekByHour: Map<number, number> = new Map();
      const forecastByHour: Map<number, number> = new Map();
      const laborByHour: Map<number, number> = new Map();
      const actualLaborByHour: Map<number, number> = new Map();
      const employeeCountByHour: Map<number, number> = new Map();
      const leadersByHour: Map<number, { firstName: string; position: string }[]> = new Map();
      const positionByHour: Map<number, Record<string, number>> = new Map();
      const hmeByHour: Map<number, { avgServiceTime: number; carCount: number; carsUnder6Min: number }> = new Map();
      const osatByHour: Map<number, { osatPercent: number; totalResponses: number }> = new Map();

      const restaurantOsatData = hourlyOsatData[restaurant.id];
      if (restaurantOsatData) {
        for (const [hour, data] of Object.entries(restaurantOsatData)) {
          osatByHour.set(Number(hour), data);
        }
      }

      restaurantHmeData.forEach(h => {
        hmeByHour.set(h.hour, { avgServiceTime: h.avgTotalTime, carCount: h.carCount, carsUnder6Min: h.carsUnder6Min });
      });

      const posSalesForRestaurant = posHourlySales.get(restaurant.id);
      const posLastWeekSalesForRestaurant = posLastWeekHourlySales.get(restaurant.id);

      if (isToday) {
        if (posSalesForRestaurant && posSalesForRestaurant.size > 0) {
          posSalesForRestaurant.forEach((sales, hour) => {
            selectedByHour.set(hour, sales);
          });
        }
      } else {
        restaurantSelectedHourly.forEach(s => {
          selectedByHour.set(s.hour, parseFloat(s.actualSales || '0'));
        });
        if (posSalesForRestaurant && posSalesForRestaurant.size > 0) {
          posSalesForRestaurant.forEach((sales, hour) => {
            selectedByHour.set(hour, sales);
          });
        }
      }

      restaurantSelectedHourly.forEach(s => {
        forecastByHour.set(s.hour, parseFloat(s.projectedSales || '0'));
      });
      const quarterByHour: Map<number, { q0: number; q1: number; q2: number; q3: number }> = new Map();
      restaurantLaborData.forEach(l => {
        laborByHour.set(l.hour, parseFloat(l.projectedLabor || '0'));
        actualLaborByHour.set(l.hour, parseFloat(l.actualLabor || '0'));
        employeeCountByHour.set(l.hour, Number(l.employeeCount) || 0);
        if (l.positionBreakdown) {
          positionByHour.set(l.hour, l.positionBreakdown as Record<string, number>);
        }
        if (l.quarterBreakdown) {
          quarterByHour.set(l.hour, l.quarterBreakdown as { q0: number; q1: number; q2: number; q3: number });
        }
      });

      for (const c of restaurantCrewData) {
        const crewMembers = c.crewMembers as { userId: number; firstName: string; lastName: string; tenureMonths: number; category: string; position?: string }[] | null;
        if (crewMembers && crewMembers.length > 0) {
          const positions = positionByHour.get(c.hour) || {};
          const leaders: { firstName: string; position: string }[] = [];

          for (const member of crewMembers) {
            if (member.position) {
              const posLower = member.position.toLowerCase();
              if (posLower.includes('manager') || posLower.includes('supervisor')) {
                leaders.push({ firstName: member.firstName, position: member.position });
              }
            }
          }

          if (positions['_operatorScheduled'] === 1) {
            leaders.push({ firstName: 'Operator', position: 'Operator' });
          }

          if (leaders.length > 0) {
            leadersByHour.set(c.hour, leaders);
          }
        }
      }

      if (posLastWeekSalesForRestaurant && posLastWeekSalesForRestaurant.size > 0) {
        posLastWeekSalesForRestaurant.forEach((sales, hour) => {
          lastWeekByHour.set(hour, sales);
        });
      } else {
        restaurantLastWeekHourly.forEach(s => {
          lastWeekByHour.set(s.hour, parseFloat(s.actualSales || '0'));
        });

        if (restaurantLastWeekHourly.length === 0 && lastWeekDailyMap.has(restaurant.id)) {
          const dailyTotal = lastWeekDailyMap.get(restaurant.id) || 0;
          const hourlyDistribution: Record<number, number> = {
            5: 0.01, 6: 0.02, 7: 0.03, 8: 0.04, 9: 0.05, 10: 0.06,
            11: 0.09, 12: 0.11, 13: 0.09, 14: 0.06, 15: 0.05, 16: 0.05,
            17: 0.07, 18: 0.08, 19: 0.07, 20: 0.05, 21: 0.04, 22: 0.02, 23: 0.01
          };
          for (let h = 0; h < 24; h++) {
            const pct = hourlyDistribution[h] || 0;
            if (pct > 0) {
              lastWeekByHour.set(h, Math.round(dailyTotal * pct));
            }
          }
        }
      }

      for (let h = 0; h < 24; h++) {
        if ((forecastByHour.get(h) || 0) === 0 && (lastWeekByHour.get(h) || 0) > 0) {
          forecastByHour.set(h, lastWeekByHour.get(h) || 0);
        }
      }

      const restaurantCurrentHour = isToday ? getCurrentHourInTimezone(restaurant.timezone) : 23;

      for (let hour = 0; hour <= restaurantCurrentHour; hour++) {
        const todaySales = Math.round(selectedByHour.get(hour) || 0);
        const lastWeekSales = Math.round(lastWeekByHour.get(hour) || 0);
        const forecastSales = Math.round(forecastByHour.get(hour) || 0);
        const projectedLabor = Math.round((laborByHour.get(hour) || 0) * 100) / 100;
        const actualLabor = Math.round((actualLaborByHour.get(hour) || 0) * 100) / 100;
        const employeeCount = employeeCountByHour.get(hour) || 0;
        const positionBreakdown = positionByHour.get(hour);
        const quarterBreakdown = quarterByHour.get(hour);

        const osatHourData = osatByHour.get(hour);
        const hasOsatData = osatHourData && osatHourData.totalResponses > 0;
        if (todaySales > 0 || lastWeekSales > 0 || forecastSales > 0 || projectedLabor > 0 || actualLabor > 0 || hasOsatData) {
          const hmeHourData = hmeByHour.get(hour);
          const leaders = leadersByHour.get(hour);
          hourlyDataForRestaurant.push({
            hour,
            todaySales,
            lastWeekSales,
            forecastSales,
            projectedLabor,
            actualLabor,
            employeeCount,
            positionBreakdown,
            quarterBreakdown,
            leaders,
            label: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`,
            avgServiceTime: hmeHourData?.avgServiceTime,
            carCount: hmeHourData?.carCount,
            speedAttainment: hmeHourData && hmeHourData.carCount > 0 && hmeHourData.carsUnder6Min > 0 ? Math.round((hmeHourData.carsUnder6Min / hmeHourData.carCount) * 100) : undefined,
            osatPercent: osatHourData?.osatPercent,
            osatResponses: osatHourData?.totalResponses,
          });
        }
      }

      result[restaurant.id] = hourlyDataForRestaurant;
    }

    return result;
  }

  async saveDailyWeather(data: InsertDailyWeather): Promise<void> {
    await db
      .insert(dailyWeather)
      .values(data)
      .onConflictDoUpdate({
        target: [dailyWeather.restaurantId, dailyWeather.date],
        set: {
          highTemp: data.highTemp,
          lowTemp: data.lowTemp,
          avgTemp: data.avgTemp,
          condition: data.condition,
          humidity: data.humidity,
          windSpeed: data.windSpeed,
          savedAt: sql`now()`,
        },
      });
  }

  async getDailyWeather(restaurantId: string, date: string): Promise<DailyWeather | null> {
    const result = await db
      .select()
      .from(dailyWeather)
      .where(and(
        eq(dailyWeather.restaurantId, restaurantId),
        eq(dailyWeather.date, date)
      ))
      .limit(1);
    return result[0] || null;
  }

  async getAllDailyWeather(date: string): Promise<DailyWeather[]> {
    return await db
      .select()
      .from(dailyWeather)
      .where(eq(dailyWeather.date, date));
  }
}

export const storage = new DatabaseStorage();
