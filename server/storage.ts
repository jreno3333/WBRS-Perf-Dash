import {
  type Restaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData,
  type InsertDailyWeather,
  type DailyWeather,
  type HourlyLabor,
  restaurants,
  dailyWeather,
  hourlySales,
  hourlyLabor,
  hourlyCrew,
  hmeTimerData,
  scraperRuns,
  posOrders,
  historicalDailySales,
} from "@shared/schema";
import { db, posDb } from "./db";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { getPosSalesByRestaurant, getAllHourlyPosSales, getCheckAverageByRestaurant, getDestinationBreakdownByRestaurant } from "./xenial-webhook";
import { getHourlyOsatForDate } from "./scraper/qualtrics-api";
import { getCurrentHourInTimezone, getTodayInTimezone, getNormalizedHourCutoff } from "./utils/dates";
import { deduplicateHourly } from "./utils/db-helpers";

type ParsedHourlySales = Omit<import("@shared/schema").HourlySales, 'actualSales' | 'projectedSales' | 'pastActualSales' | 'projectedLabor' | 'actualLabor' | 'employeeCount'> & {
  _actualSales: number;
  _projectedSales: number;
  _pastActualSales: number;
  _projectedLabor: number;
  _actualLabor: number;
  _employeeCount: number;
  actualSales: string;
  projectedSales: string | null;
  pastActualSales: string | null;
  projectedLabor: string | null;
  actualLabor: string | null;
  employeeCount: string | null;
};

function parseHourlySalesRows(rows: import("@shared/schema").HourlySales[]): ParsedHourlySales[] {
  return rows.map(r => ({
    ...r,
    _actualSales: parseFloat(r.actualSales || '0'),
    _projectedSales: parseFloat(r.projectedSales || '0'),
    _pastActualSales: parseFloat(r.pastActualSales || '0'),
    _projectedLabor: parseFloat(r.projectedLabor || '0'),
    _actualLabor: parseFloat(r.actualLabor || '0'),
    _employeeCount: Number(r.employeeCount) || 0,
  }));
}

function buildHourMap(rows: ParsedHourlySales[]): Map<number, ParsedHourlySales> {
  const map = new Map<number, ParsedHourlySales>();
  for (const r of rows) {
    map.set(r.hour, r);
  }
  return map;
}

export class DatabaseStorage {
  private _restaurantCache: { data: Restaurant[]; timestamp: number } | null = null;
  private _restaurantCacheTTL = 60_000;

  async getRestaurants(): Promise<Restaurant[]> {
    const now = Date.now();
    if (this._restaurantCache && (now - this._restaurantCache.timestamp) < this._restaurantCacheTTL) {
      return this._restaurantCache.data;
    }
    const allRestaurants = await db.select().from(restaurants).where(eq(restaurants.isActive, true));
    const filtered = allRestaurants.filter(r =>
      !r.name.toLowerCase().includes('training') &&
      !r.name.toLowerCase().includes('development')
    );
    this._restaurantCache = { data: filtered, timestamp: now };
    return filtered;
  }

  invalidateRestaurantCache() {
    this._restaurantCache = null;
  }

  async getRestaurant(id: string): Promise<Restaurant | undefined> {
    const cached = await this.getRestaurants();
    const found = cached.find(r => r.id === id);
    if (found) return found;
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
      if (daysOpen < 120) return { status: "new", daysOpen };
      return { status: "established", daysOpen };
    };

    const selectedDateStart = new Date(`${selectedDateStr}T00:00:00.000Z`);
    const selectedDateEnd = new Date(`${selectedDateStr}T23:59:59.999Z`);
    const lastWeekStart = new Date(`${lastWeekStr}T00:00:00.000Z`);
    const lastWeekEnd = new Date(`${lastWeekStr}T23:59:59.999Z`);

    const [allHourlySales, allHourlyLabor, posHourlySales, posLastWeekHourlySales] = await Promise.all([
      db.select().from(hourlySales).where(and(gte(hourlySales.salesDate, lastWeekStart), lte(hourlySales.salesDate, selectedDateEnd))),
      db.select().from(hourlyLabor).where(eq(hourlyLabor.date, selectedDateStr)),
      getAllHourlyPosSales(selectedDate),
      getAllHourlyPosSales(lastWeek),
    ]);

    const laborByKey = new Map<string, HourlyLabor>();
    allHourlyLabor.forEach(l => {
      const dateStr = l.date.split('T')[0];
      const key = `${l.restaurantId}-${dateStr}-${l.hour}`;
      laborByKey.set(key, l);
    });

    const selectedDateHourly = parseHourlySalesRows(deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    })));

    const lastWeekHourly = parseHourlySalesRows(deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    })));

    const selectedByRestaurant = new Map<string, ParsedHourlySales[]>();
    for (const s of selectedDateHourly) {
      if (!selectedByRestaurant.has(s.restaurantId)) selectedByRestaurant.set(s.restaurantId, []);
      selectedByRestaurant.get(s.restaurantId)!.push(s);
    }
    const lastWeekByRestaurant = new Map<string, ParsedHourlySales[]>();
    for (const s of lastWeekHourly) {
      if (!lastWeekByRestaurant.has(s.restaurantId)) lastWeekByRestaurant.set(s.restaurantId, []);
      lastWeekByRestaurant.get(s.restaurantId)!.push(s);
    }

    const restaurantSales: RestaurantSales[] = restaurantList.map(restaurant => {
      const allSelectedDateHours = selectedByRestaurant.get(restaurant.id) || [];
      const selectedDateRestaurantHours = allSelectedDateHours.filter(s => s.hour <= normalizedHourCutoff);
      const allLastWeekHours = lastWeekByRestaurant.get(restaurant.id) || [];
      const lastWeekRestaurantHours = allLastWeekHours.filter(s => s.hour <= normalizedHourCutoff);

      const restaurantCurrentHour = getCurrentHourInTimezone(restaurant.timezone);
      const restaurantCompletedHour = isToday ? restaurantCurrentHour - 1 : 23;

      const lastWeekHoursForComparison = allLastWeekHours.filter(s => s.hour <= restaurantCompletedHour);

      const posSalesForRestaurant = posHourlySales.get(restaurant.id);
      const posLastWeekSalesForRestaurant = posLastWeekHourlySales.get(restaurant.id);

      let selectedDateSalesAmount = 0;
      let actualSalesAmount = 0;
      let completedSalesAmount = 0;

      if (posSalesForRestaurant && posSalesForRestaurant.size > 0) {
        posSalesForRestaurant.forEach((sales, hour) => {
          if (hour <= normalizedHourCutoff) {
            selectedDateSalesAmount += sales;
          }
          if (hour <= restaurantCompletedHour) {
            completedSalesAmount += sales;
          }
          actualSalesAmount += sales;
        });
      } else if (!isToday) {
        selectedDateSalesAmount = selectedDateRestaurantHours.reduce(
          (sum, s) => sum + s._actualSales, 0
        );
        actualSalesAmount = allSelectedDateHours.reduce(
          (sum, s) => sum + s._actualSales, 0
        );
        completedSalesAmount = actualSalesAmount;
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
          (sum, s) => sum + s._actualSales, 0
        );
        actualLastWeekAmount = lastWeekHoursForComparison.reduce(
          (sum, s) => sum + s._actualSales, 0
        );
      }

      let lastWeekRemainingHoursSales = 0;
      let lastWeekFutureOnlyHoursSales = 0;
      if (isToday) {
        if (posLastWeekSalesForRestaurant && posLastWeekSalesForRestaurant.size > 0) {
          posLastWeekSalesForRestaurant.forEach((sales, hour) => {
            if (hour > restaurantCompletedHour) {
              lastWeekRemainingHoursSales += sales;
            }
            if (hour > restaurantCurrentHour) {
              lastWeekFutureOnlyHoursSales += sales;
            }
          });
        } else {
          const lastWeekAllHoursForForecast = allLastWeekHours;
          if (lastWeekAllHoursForForecast.length > 0) {
            const lwHourMap = buildHourMap(lastWeekAllHoursForForecast);
            for (let hour = restaurantCompletedHour + 1; hour < 24; hour++) {
              const lastWeekHour = lwHourMap.get(hour);
              const amt = lastWeekHour?._actualSales || 0;
              lastWeekRemainingHoursSales += amt;
              if (hour > restaurantCurrentHour) {
                lastWeekFutureOnlyHoursSales += amt;
              }
            }
          }
        }
      }
      const peakStartHour = 10;
      const operatingHours = 16;
      const completedHoursCount = restaurantCompletedHour + 1;
      const isPeakData = restaurantCompletedHour >= peakStartHour;
      const rawPaceRatio = actualLastWeekAmount > 0 ? completedSalesAmount / actualLastWeekAmount : 1;
      const dayProgress = isToday ? Math.min(completedHoursCount / operatingHours, 1) : 1;
      const earlyDayMaxDeviation = isPeakData ? 0.5 : 0.15;
      const clampedDeviation = Math.max(-earlyDayMaxDeviation, Math.min(earlyDayMaxDeviation, (rawPaceRatio - 1) * dayProgress));
      const paceRatio = 1 + clampedDeviation;
      const lastWeekFullDayAmount = actualLastWeekAmount + lastWeekRemainingHoursSales;
      const forecastSalesAmount = isToday
        ? actualSalesAmount + lastWeekFutureOnlyHoursSales * paceRatio
        : completedSalesAmount + lastWeekRemainingHoursSales * paceRatio;

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
          if (allLastWeekHours.length > 0) {
            const todayHourMap = buildHourMap(allSelectedDateHours);
            const lwHourMap2 = buildHourMap(allLastWeekHours);
            for (let hour = normalizedHourCutoff + 1; hour < 24; hour++) {
              const todayHour = todayHourMap.get(hour);
              const lastWeekHour = lwHourMap2.get(hour);
              const forecastValue = (todayHour?._projectedSales || 0) > 0
                ? todayHour!._projectedSales
                : (lastWeekHour?._actualSales || 0);
              remainingForecastSales += forecastValue;
            }
          }
        }

        projectedEndOfDaySales = selectedDateSalesAmount + remainingForecastSales;
      } else {
        projectedEndOfDaySales = allSelectedDateHours.reduce(
          (sum, s) => sum + s._actualSales, 0
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
        completedSales: completedSalesAmount,
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

    const rangeStart = new Date(`${lastWeekStr}T00:00:00.000Z`);
    const rangeEnd = new Date(`${selectedDateStr}T23:59:59.999Z`);

    const dbFilters = [
      gte(hourlySales.salesDate, rangeStart),
      lte(hourlySales.salesDate, rangeEnd),
    ];
    if (restaurantId !== "all") {
      dbFilters.push(eq(hourlySales.restaurantId, restaurantId));
    }

    const allHourlySales = await db.select().from(hourlySales).where(and(...dbFilters));

    const laborFilters = [eq(hourlyLabor.date, selectedDateStr)];
    if (restaurantId !== "all") {
      laborFilters.push(eq(hourlyLabor.restaurantId, restaurantId));
    }
    const allHourlyLabor = await db.select().from(hourlyLabor).where(and(...laborFilters));
    const laborByKey = new Map<string, HourlyLabor>();
    allHourlyLabor.forEach(l => {
      const dateStr = l.date.split('T')[0];
      const key = `${l.restaurantId}-${dateStr}-${l.hour}`;
      laborByKey.set(key, l);
    });

    const selectedDateHourly = parseHourlySalesRows(deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    })));

    const lastWeekHourly = parseHourlySalesRows(deduplicateHourly(allHourlySales.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    })));

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
            lastWeekByHour.set(s.hour, current + s._actualSales);
          });
        }

        lastWeekHourly.forEach(s => {
          const currentForecast = forecastByHour.get(s.hour) || 0;
          forecastByHour.set(s.hour, currentForecast + s._actualSales);
        });
      } else {
        selectedDateHourly.forEach(s => {
          const current = selectedByHour.get(s.hour) || 0;
          selectedByHour.set(s.hour, current + s._actualSales);
          const currentForecast = forecastByHour.get(s.hour) || 0;
          forecastByHour.set(s.hour, currentForecast + s._projectedSales);
        });
        lastWeekHourly.forEach(s => {
          const current = lastWeekByHour.get(s.hour) || 0;
          lastWeekByHour.set(s.hour, current + s._actualSales);
        });
      }

      selectedDateLabor.forEach(l => {
        const currentLabor = laborByHourMap.get(l.hour) || 0;
        laborByHourMap.set(l.hour, currentLabor + parseFloat(l.projectedLabor || '0'));
        const currentActualLabor = actualLaborByHour.get(l.hour) || 0;
        actualLaborByHour.set(l.hour, currentActualLabor + parseFloat(l.actualLabor || '0'));
      });
    } else {
      selectedDateHourly.forEach(s => {
        selectedByHour.set(s.hour, s._actualSales);
        forecastByHour.set(s.hour, s._projectedSales);
      });
      selectedDateLabor.forEach(l => {
        laborByHourMap.set(l.hour, parseFloat(l.projectedLabor || '0'));
        actualLaborByHour.set(l.hour, parseFloat(l.actualLabor || '0'));
        employeeCountByHour.set(l.hour, Number(l.employeeCount) || 0);
        if (l.positionBreakdown) {
          positionByHour.set(l.hour, l.positionBreakdown as Record<string, number>);
        }
      });
      lastWeekHourly.forEach(s => {
        lastWeekByHour.set(s.hour, s._actualSales);
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

    const allHourlySalesRaw = await db.select().from(hourlySales).where(
      and(
        gte(hourlySales.salesDate, rangeStart),
        lte(hourlySales.salesDate, rangeEnd)
      )
    );

    const selectedDateHourly = parseHourlySalesRows(deduplicateHourly(allHourlySalesRaw.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === selectedDateStr;
    })));

    const lastWeekHourly = parseHourlySalesRows(deduplicateHourly(allHourlySalesRaw.filter(s => {
      const saleDate = new Date(s.salesDate).toISOString().split('T')[0];
      return saleDate === lastWeekStr;
    })));

    // Fetch supplementary data for selected date only
    const allHmeData = await db.select().from(hmeTimerData).where(sql`${hmeTimerData.date} LIKE ${selectedDateStr + '%'}`);
    const allHourlyLaborData = await db.select().from(hourlyLabor).where(sql`${hourlyLabor.date} LIKE ${selectedDateStr + '%'}`);
    const allHourlyCrewData = await db.select().from(hourlyCrew).where(sql`${hourlyCrew.date} LIKE ${selectedDateStr + '%'}`);

    const posHourlySales = await getAllHourlyPosSales(selectedDate);
    const posLastWeekHourlySales = await getAllHourlyPosSales(lastWeek);
    const hourlyOsatData = await getHourlyOsatForDate(selectedDateStr);
    const checkAvgData = await getCheckAverageByRestaurant(selectedDate);
    const checkAvgLastWeek = await getCheckAverageByRestaurant(lastWeek);
    const destinationBreakdown = await getDestinationBreakdownByRestaurant(selectedDate);

    // Fetch last year's daily sales from historical_daily_sales for YoY bonus
    // Use DOW-matching: subtract 1 year, then adjust to same day-of-week (matches yoy-bulk endpoint)
    const lastYearDate = new Date(selectedDate);
    lastYearDate.setFullYear(lastYearDate.getFullYear() - 1);
    const sameDow = lastYearDate.getDay();
    const targetDow = selectedDate.getDay();
    lastYearDate.setDate(lastYearDate.getDate() + (targetDow - sameDow));
    const lastYearDateStr = lastYearDate.toISOString().split('T')[0];
    const lastYearSalesData = await db.select().from(historicalDailySales)
      .where(eq(historicalDailySales.date, lastYearDateStr));
    const lastYearSalesMap = new Map<string, number>();
    for (const row of lastYearSalesData) {
      lastYearSalesMap.set(row.restaurantId, parseFloat(String(row.netSales)) || 0);
    }

    // POS fallback for YoY data — fill gaps for restaurants without uploaded CSV data
    // (matches yoy-bulk endpoint which also falls back to hourlySales)
    const lyStart = new Date(`${lastYearDateStr}T00:00:00.000Z`);
    const lyEnd = new Date(`${lastYearDateStr}T23:59:59.999Z`);
    const lyPosRows = await db.select({
      restaurantId: hourlySales.restaurantId,
      totalSales: sql<string>`SUM(CAST(${hourlySales.actualSales} AS numeric))`,
    })
      .from(hourlySales)
      .where(and(gte(hourlySales.salesDate, lyStart), lte(hourlySales.salesDate, lyEnd)))
      .groupBy(hourlySales.restaurantId);
    for (const row of lyPosRows) {
      if (!lastYearSalesMap.has(row.restaurantId)) {
        const total = parseFloat(row.totalSales || "0");
        if (total > 0) {
          lastYearSalesMap.set(row.restaurantId, total);
        }
      }
    }

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
          selectedByHour.set(s.hour, s._actualSales);
        });
        if (posSalesForRestaurant && posSalesForRestaurant.size > 0) {
          posSalesForRestaurant.forEach((sales, hour) => {
            selectedByHour.set(hour, sales);
          });
        }
      }

      restaurantSelectedHourly.forEach(s => {
        forecastByHour.set(s.hour, s._projectedSales);
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
          lastWeekByHour.set(s.hour, s._actualSales);
        });

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
          const txnData = checkAvgData.get(restaurant.id)?.hourly.get(hour);
          const txnLastWeek = checkAvgLastWeek.get(restaurant.id)?.hourly.get(hour);
          const destHourData = destinationBreakdown.get(restaurant.id)?.get(hour);
          const ootActive = (destHourData?.['dt3'] || 0) >= 1;
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
            ootActive: ootActive || undefined, // only set when true to keep payload small
            osatPercent: osatHourData?.osatPercent,
            osatResponses: osatHourData?.totalResponses,
            transactionCount: txnData?.orders,
            lastWeekTransactionCount: txnLastWeek?.orders,
            lastYearDailySales: lastYearSalesMap.get(restaurant.id),
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
