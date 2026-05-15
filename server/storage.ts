import {
  type Restaurant,
  type RestaurantSales,
  type HourlySalesData,
  type LeaderboardData,
  type InsertDailyWeather,
  type DailyWeather,
  type HourlyLabor,
  type InsertTrainingCourse,
  type TrainingCourse,
  type InsertTrainingModule,
  type TrainingModule,
  type InsertTrainingEmployeeProgress,
  type TrainingEmployeeProgress,
  type InsertTrainingModuleProgress,
  type TrainingModuleProgress,
  type InsertTrainingCertification,
  type TrainingCertification,
  type InsertTrainingSyncStatus,
  type TrainingSyncStatus,
  restaurants,
  dailyWeather,
  hourlySales,
  hourlyLabor,
  hourlyCrew,
  hmeTimerData,
  scraperRuns,
  posOrders,
  historicalDailySales,
  salesPlanDaily,
  employees,
  trainingCourses,
  trainingModules,
  trainingEmployeeProgress,
  trainingModuleProgress,
  trainingCertifications,
  trainingSyncStatus,
} from "@shared/schema";
import { db, posDb } from "./db";
import { eq, ne, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
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

    // Compute Sat→selected-day window for WTD plan-labor lookup. Saturday is
    // the start of our business week (Sat→Fri). UTC math is safe here because
    // selectedDateStr is a calendar date string.
    const [sdY, sdM, sdD] = selectedDateStr.split('-').map(Number);
    const selectedUtc = new Date(Date.UTC(sdY, sdM - 1, sdD));
    const daysSinceSat = (selectedUtc.getUTCDay() + 1) % 7; // Sat=0, Sun=1, ..., Fri=6
    const weekStartUtc = new Date(selectedUtc);
    weekStartUtc.setUTCDate(weekStartUtc.getUTCDate() - daysSinceSat);
    const weekStartStr = `${weekStartUtc.getUTCFullYear()}-${String(weekStartUtc.getUTCMonth() + 1).padStart(2, '0')}-${String(weekStartUtc.getUTCDate()).padStart(2, '0')}`;

    const [allHourlySales, allHourlyLabor, posHourlySales, posLastWeekHourlySales, planRowsThisWeek] = await Promise.all([
      db.select().from(hourlySales).where(and(gte(hourlySales.salesDate, lastWeekStart), lte(hourlySales.salesDate, selectedDateEnd))),
      db.select().from(hourlyLabor).where(eq(hourlyLabor.date, selectedDateStr)),
      getAllHourlyPosSales(selectedDate),
      getAllHourlyPosSales(lastWeek),
      db.select({
        restaurantId: salesPlanDaily.restaurantId,
        date: salesPlanDaily.date,
        plannedNetSales: salesPlanDaily.plannedNetSales,
        plannedVariableLaborPct: salesPlanDaily.plannedVariableLaborPct,
      }).from(salesPlanDaily).where(and(
        gte(salesPlanDaily.date, weekStartStr),
        lte(salesPlanDaily.date, selectedDateStr),
      )),
    ]);

    // Build per-restaurant plan-labor targets:
    //   dayPlanLaborPct: today's plannedVariableLaborPct (×100 → percent)
    //   wtdPlanLaborPct: weighted avg by plannedNetSales across Sat→selected day,
    //                    falling back to a simple mean when no sales weights exist.
    type PlanAccum = {
      dayPct: number | null;
      dayNetSales: number | null;
      weightedSum: number;
      weightSum: number;
      sumPct: number;
      count: number;
    };
    const planByRestaurant = new Map<string, PlanAccum>();
    for (const row of planRowsThisWeek) {
      const pct = row.plannedVariableLaborPct != null ? parseFloat(row.plannedVariableLaborPct as string) * 100 : null;
      if (pct == null || !isFinite(pct)) continue;
      let acc = planByRestaurant.get(row.restaurantId);
      if (!acc) {
        acc = { dayPct: null, dayNetSales: null, weightedSum: 0, weightSum: 0, sumPct: 0, count: 0 };
        planByRestaurant.set(row.restaurantId, acc);
      }
      const weight = parseFloat((row.plannedNetSales as string) || '0') || 0;
      if (row.date === selectedDateStr) {
        acc.dayPct = pct;
        acc.dayNetSales = weight > 0 ? weight : null;
      }
      if (weight > 0) {
        acc.weightedSum += pct * weight;
        acc.weightSum += weight;
      }
      acc.sumPct += pct;
      acc.count += 1;
    }
    const getPlanTargets = (restaurantId: string): {
      dayPlanLaborPct: number | null;
      wtdPlanLaborPct: number | null;
      dayPlanNetSales: number | null;
      wtdPlanNetSales: number | null;
    } => {
      const acc = planByRestaurant.get(restaurantId);
      if (!acc) {
        return {
          dayPlanLaborPct: null,
          wtdPlanLaborPct: null,
          dayPlanNetSales: null,
          wtdPlanNetSales: null,
        };
      }
      const wtd = acc.weightSum > 0
        ? acc.weightedSum / acc.weightSum
        : (acc.count > 0 ? acc.sumPct / acc.count : null);
      return {
        dayPlanLaborPct: acc.dayPct != null ? Math.round(acc.dayPct * 10) / 10 : null,
        wtdPlanLaborPct: wtd != null ? Math.round(wtd * 10) / 10 : null,
        dayPlanNetSales: acc.dayNetSales != null ? Math.round(acc.dayNetSales * 100) / 100 : null,
        wtdPlanNetSales: acc.weightSum > 0 ? Math.round(acc.weightSum * 100) / 100 : null,
      };
    };

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
      const { dayPlanLaborPct, wtdPlanLaborPct, dayPlanNetSales, wtdPlanNetSales } = getPlanTargets(restaurant.id);
      // Prefer the plan target for the willHitLaborTarget projection so this
      // matches the threshold the leaderboard card displays. Falls back to the
      // per-unit override / 25% default when no plan row exists.
      const effectiveDayTarget = dayPlanLaborPct ?? laborTarget;
      const willHitLaborTarget = projectedLaborPercent <= effectiveDayTarget;

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
        dayPlanLaborPct,
        wtdPlanLaborPct,
        dayPlanNetSales,
        wtdPlanNetSales,
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

  // ─── Training Platform Sync (Phase 1) ────────────────────────────────────

  async upsertTrainingCourse(data: InsertTrainingCourse): Promise<void> {
    await db
      .insert(trainingCourses)
      .values(data)
      .onConflictDoUpdate({
        target: trainingCourses.externalCourseId,
        set: {
          title: data.title,
          category: data.category ?? null,
          totalModules: data.totalModules ?? null,
          syncedAt: new Date(),
        },
      });
  }

  async upsertTrainingModule(data: InsertTrainingModule): Promise<void> {
    await db
      .insert(trainingModules)
      .values(data)
      .onConflictDoUpdate({
        target: trainingModules.externalModuleId,
        set: {
          externalCourseId: data.externalCourseId,
          title: data.title,
          category: data.category ?? null,
          defaultDueDays: data.defaultDueDays ?? null,
          syncedAt: new Date(),
        },
      });
  }

  async upsertTrainingEmployeeProgress(data: InsertTrainingEmployeeProgress): Promise<void> {
    await db
      .insert(trainingEmployeeProgress)
      .values(data)
      .onConflictDoUpdate({
        target: [trainingEmployeeProgress.employeeId, trainingEmployeeProgress.externalCourseId],
        set: {
          externalEmployeeId: data.externalEmployeeId,
          percentComplete: data.percentComplete,
          score: data.score ?? null,
          status: data.status ?? null,
          dueDate: data.dueDate ?? null,
          completedAt: data.completedAt ?? null,
          syncedAt: new Date(),
        },
      });
  }

  async upsertTrainingModuleProgress(data: InsertTrainingModuleProgress): Promise<void> {
    await db
      .insert(trainingModuleProgress)
      .values(data)
      .onConflictDoUpdate({
        target: [trainingModuleProgress.employeeId, trainingModuleProgress.externalModuleId],
        set: {
          externalEmployeeId: data.externalEmployeeId,
          status: data.status,
          dueDate: data.dueDate ?? null,
          score: data.score ?? null,
          completedAt: data.completedAt ?? null,
          syncedAt: new Date(),
        },
      });
  }

  async upsertTrainingCertification(data: InsertTrainingCertification): Promise<void> {
    await db
      .insert(trainingCertifications)
      .values(data)
      .onConflictDoUpdate({
        target: [trainingCertifications.employeeId, trainingCertifications.certificationKey],
        set: {
          externalEmployeeId: data.externalEmployeeId,
          name: data.name,
          earnedAt: data.earnedAt ?? null,
          expiresAt: data.expiresAt ?? null,
          syncedAt: new Date(),
        },
      });
  }

  async recordTrainingSyncStatus(data: InsertTrainingSyncStatus): Promise<void> {
    await db.insert(trainingSyncStatus).values(data);
  }

  async getTrainingSyncStatus(): Promise<TrainingSyncStatus | null> {
    const [row] = await db
      .select()
      .from(trainingSyncStatus)
      .orderBy(desc(trainingSyncStatus.ranAt))
      .limit(1);
    return row ?? null;
  }

  async getTrainingProgressByEmployee(employeeId: string): Promise<{
    courses: TrainingEmployeeProgress[];
    modules: TrainingModuleProgress[];
    certifications: TrainingCertification[];
  }> {
    const [courses, modules, certifications] = await Promise.all([
      db.select().from(trainingEmployeeProgress).where(eq(trainingEmployeeProgress.employeeId, employeeId)),
      db.select().from(trainingModuleProgress).where(eq(trainingModuleProgress.employeeId, employeeId)),
      db.select().from(trainingCertifications).where(eq(trainingCertifications.employeeId, employeeId)),
    ]);
    return { courses, modules, certifications };
  }

  async getCertificationsByEmployee(employeeId: string): Promise<TrainingCertification[]> {
    return db.select().from(trainingCertifications).where(eq(trainingCertifications.employeeId, employeeId));
  }

  async getTrainingSummariesForEmployees(employeeIds: string[]): Promise<Map<string, {
    percentComplete: number;
    totalCourses: number;
    completedCourses: number;
    inProgressCourses: number;
    overdueCourses: number;
    outstandingCourses: { externalCourseId: string; title: string; category: string | null; percentComplete: number; status: string | null; dueDate: string | null }[];
    completedByCategory: Record<string, { completed: number; total: number; avgScore: number | null }>;
    certifications: { key: string; name: string; earnedAt: Date | null; expiresAt: Date | null }[];
  }>> {
    interface OutstandingCourse {
      externalCourseId: string;
      title: string;
      category: string | null;
      percentComplete: number;
      status: string | null;
      dueDate: string | null;
    }
    interface CategoryBucket {
      completed: number;
      total: number;
      avgScore: number | null;
      _scoreSum: number;
      _scoreCount: number;
    }
    interface TrainingSummary {
      percentComplete: number;
      totalCourses: number;
      completedCourses: number;
      inProgressCourses: number;
      overdueCourses: number;
      outstandingCourses: OutstandingCourse[];
      completedByCategory: Record<string, CategoryBucket>;
      certifications: { key: string; name: string; earnedAt: Date | null; expiresAt: Date | null }[];
    }
    const out = new Map<string, TrainingSummary>();
    if (employeeIds.length === 0) return out;

    const courseRows = await db
      .select({
        employeeId: trainingEmployeeProgress.employeeId,
        externalCourseId: trainingEmployeeProgress.externalCourseId,
        percentComplete: trainingEmployeeProgress.percentComplete,
        status: trainingEmployeeProgress.status,
        dueDate: trainingEmployeeProgress.dueDate,
        score: trainingEmployeeProgress.score,
        title: trainingCourses.title,
        category: trainingCourses.category,
      })
      .from(trainingEmployeeProgress)
      .leftJoin(trainingCourses, eq(trainingCourses.externalCourseId, trainingEmployeeProgress.externalCourseId))
      .where(and(
        inArray(trainingEmployeeProgress.employeeId, employeeIds),
        ne(trainingEmployeeProgress.externalCourseId, "_overall"),
      ));

    const certRows = await db
      .select()
      .from(trainingCertifications)
      .where(inArray(trainingCertifications.employeeId, employeeIds));

    for (const empId of employeeIds) {
      out.set(empId, {
        percentComplete: 0,
        totalCourses: 0,
        completedCourses: 0,
        inProgressCourses: 0,
        overdueCourses: 0,
        outstandingCourses: [],
        completedByCategory: {},
        certifications: [],
      });
    }

    for (const r of courseRows) {
      const s = out.get(r.employeeId);
      if (!s) continue;
      const pct = parseFloat(r.percentComplete || "0");
      s.totalCourses++;
      if (r.status === "completed") s.completedCourses++;
      else if (r.status === "overdue") s.overdueCourses++;
      else if (r.status === "in_progress") s.inProgressCourses++;
      if (r.status !== "completed") {
        s.outstandingCourses.push({
          externalCourseId: r.externalCourseId,
          title: r.title || r.externalCourseId,
          category: r.category,
          percentComplete: pct,
          status: r.status,
          dueDate: r.dueDate,
        });
      }
      const cat = (r.category || "uncategorized").toLowerCase();
      const bucket: CategoryBucket = s.completedByCategory[cat] || { completed: 0, total: 0, avgScore: null, _scoreSum: 0, _scoreCount: 0 };
      bucket.total++;
      if (r.status === "completed") bucket.completed++;
      const sc = r.score ? parseFloat(r.score) : null;
      if (sc !== null) {
        bucket._scoreSum += sc;
        bucket._scoreCount += 1;
      }
      s.completedByCategory[cat] = bucket;
    }

    for (const r of certRows) {
      const s = out.get(r.employeeId);
      if (!s) continue;
      s.certifications.push({
        key: r.certificationKey,
        name: r.name,
        earnedAt: r.earnedAt,
        expiresAt: r.expiresAt,
      });
    }

    out.forEach((s) => {
      if (s.totalCourses > 0) {
        const sum = s.outstandingCourses.reduce((a, c) => a + c.percentComplete, 0)
          + s.completedCourses * 100;
        s.percentComplete = Math.round((sum / s.totalCourses) * 10) / 10;
      }
      // Sort outstanding: overdue first, then by due date asc, then by percent asc
      s.outstandingCourses.sort((a, b) => {
        const ao = a.status === "overdue" ? 0 : 1;
        const bo = b.status === "overdue" ? 0 : 1;
        if (ao !== bo) return ao - bo;
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return a.percentComplete - b.percentComplete;
      });
      for (const k of Object.keys(s.completedByCategory)) {
        const b = s.completedByCategory[k];
        b.avgScore = b._scoreCount > 0 ? Math.round((b._scoreSum / b._scoreCount) * 10) / 10 : null;
      }
    });

    return out as unknown as Map<string, {
      percentComplete: number;
      totalCourses: number;
      completedCourses: number;
      inProgressCourses: number;
      overdueCourses: number;
      outstandingCourses: { externalCourseId: string; title: string; category: string | null; percentComplete: number; status: string | null; dueDate: string | null }[];
      completedByCategory: Record<string, { completed: number; total: number; avgScore: number | null }>;
      certifications: { key: string; name: string; earnedAt: Date | null; expiresAt: Date | null }[];
    }>;
  }

  async getTrainingRollupsAll(): Promise<Map<string, {
    employeeCount: number;
    employeesWithProgress: number;
    avgPercentComplete: number;
    completedCourses: number;
    overdueCourses: number;
    certifiedShiftPlusCount: number;
    certifiedShiftPlusTotal: number;
    restartQuizPassed: number;
    restartQuizTaken: number;
  }>> {
    interface RollupAccumulator {
      employeeCount: number;
      employeesWithProgress: number;
      avgPercentComplete: number;
      completedCourses: number;
      overdueCourses: number;
      certifiedShiftPlusCount: number;
      certifiedShiftPlusTotal: number;
      restartQuizPassed: number;
      restartQuizTaken: number;
      _sumPct: number;
      _rowCount: number;
      _empWithRows: Set<string>;
      _certifiedEmps: Set<string>;
      _restartEmps: Set<string>;
      _restartTakenEmps: Set<string>;
    }
    const out = new Map<string, RollupAccumulator>();

    // Pull all employees with their restaurant + position so we can identify
    // shift supervisors and managers per unit.
    const empRows = await db
      .select({
        id: employees.id,
        restaurantId: employees.restaurantId,
        position: employees.position,
      })
      .from(employees);

    const empById = new Map<string, { restaurantId: string | null; isShiftPlus: boolean }>();
    for (const e of empRows) {
      const pos = (e.position || "").toLowerCase();
      const isShiftPlus = pos.includes("manager") || pos.includes("supervisor");
      empById.set(e.id, { restaurantId: e.restaurantId, isShiftPlus });
      if (!e.restaurantId) continue;
      const cur = out.get(e.restaurantId) || {
        employeeCount: 0,
        employeesWithProgress: 0,
        avgPercentComplete: 0,
        completedCourses: 0,
        overdueCourses: 0,
        certifiedShiftPlusCount: 0,
        certifiedShiftPlusTotal: 0,
        restartQuizPassed: 0,
        restartQuizTaken: 0,
        _sumPct: 0,
        _rowCount: 0,
        _empWithRows: new Set<string>(),
        _certifiedEmps: new Set<string>(),
        _restartEmps: new Set<string>(),
        _restartTakenEmps: new Set<string>(),
      };
      cur.employeeCount++;
      if (isShiftPlus) cur.certifiedShiftPlusTotal++;
      out.set(e.restaurantId, cur);
    }

    const progressRows = await db
      .select({
        employeeId: trainingEmployeeProgress.employeeId,
        percentComplete: trainingEmployeeProgress.percentComplete,
        status: trainingEmployeeProgress.status,
      })
      .from(trainingEmployeeProgress)
      .where(ne(trainingEmployeeProgress.externalCourseId, "_overall"));

    for (const r of progressRows) {
      const e = empById.get(r.employeeId);
      if (!e || !e.restaurantId) continue;
      const cur = out.get(e.restaurantId);
      if (!cur) continue;
      cur._rowCount++;
      cur._sumPct += parseFloat(r.percentComplete || "0");
      cur._empWithRows.add(r.employeeId);
      if (r.status === "completed") cur.completedCourses++;
      if (r.status === "overdue") cur.overdueCourses++;
    }

    const certRows = await db
      .select({
        employeeId: trainingCertifications.employeeId,
        key: trainingCertifications.certificationKey,
        earnedAt: trainingCertifications.earnedAt,
      })
      .from(trainingCertifications);

    for (const r of certRows) {
      const e = empById.get(r.employeeId);
      if (!e || !e.restaurantId) continue;
      const cur = out.get(e.restaurantId);
      if (!cur) continue;
      if (r.key === "5_star_floor_management" && e.isShiftPlus) {
        cur._certifiedEmps.add(r.employeeId);
      } else if (r.key.startsWith("train_restart:")) {
        // Any row = quiz attempted; earnedAt set ⇒ passed
        cur._restartTakenEmps.add(r.employeeId);
        if (r.earnedAt) cur._restartEmps.add(r.employeeId);
      }
    }

    const final = new Map<string, {
      employeeCount: number;
      employeesWithProgress: number;
      avgPercentComplete: number;
      completedCourses: number;
      overdueCourses: number;
      certifiedShiftPlusCount: number;
      certifiedShiftPlusTotal: number;
      restartQuizPassed: number;
      restartQuizTaken: number;
    }>();
    out.forEach((cur, rid) => {
      final.set(rid, {
        employeeCount: cur.employeeCount,
        employeesWithProgress: cur._empWithRows.size,
        avgPercentComplete: cur._rowCount > 0
          ? Math.round((cur._sumPct / cur._rowCount) * 10) / 10
          : 0,
        completedCourses: cur.completedCourses,
        overdueCourses: cur.overdueCourses,
        certifiedShiftPlusCount: cur._certifiedEmps.size,
        certifiedShiftPlusTotal: cur.certifiedShiftPlusTotal,
        restartQuizPassed: cur._restartEmps.size,
        restartQuizTaken: cur._restartTakenEmps.size,
      });
    });

    return final;
  }

  async getEmployeeById(employeeId: string): Promise<{ id: string; firstName: string | null; lastName: string | null; position: string | null; type: string | null; restaurantId: string | null } | null> {
    const rows = await db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        position: employees.position,
        type: employees.type,
        restaurantId: employees.restaurantId,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getEmployeesByRestaurant(restaurantId: string): Promise<{ id: string; firstName: string | null; lastName: string | null; position: string | null; type: string | null }[]> {
    const rows = await db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        position: employees.position,
        type: employees.type,
      })
      .from(employees)
      .where(eq(employees.restaurantId, restaurantId));
    return rows;
  }

  async getTrainingRollupByRestaurant(restaurantId: string): Promise<{
    employeeCount: number;
    avgPercentComplete: number;
    completedCourses: number;
    overdueCourses: number;
  }> {
    // Aggregate all course-progress rows for employees mapped to this restaurant
    const rows = await db
      .select({
        percentComplete: trainingEmployeeProgress.percentComplete,
        status: trainingEmployeeProgress.status,
        employeeId: trainingEmployeeProgress.employeeId,
      })
      .from(trainingEmployeeProgress)
      .innerJoin(employees, eq(employees.id, trainingEmployeeProgress.employeeId))
      .where(eq(employees.restaurantId, restaurantId));

    if (rows.length === 0) {
      return { employeeCount: 0, avgPercentComplete: 0, completedCourses: 0, overdueCourses: 0 };
    }
    const empSet = new Set<string>();
    let sumPct = 0;
    let completed = 0;
    let overdue = 0;
    for (const r of rows) {
      empSet.add(r.employeeId);
      sumPct += parseFloat(r.percentComplete || "0");
      if (r.status === "completed") completed++;
      if (r.status === "overdue") overdue++;
    }
    return {
      employeeCount: empSet.size,
      avgPercentComplete: Math.round((sumPct / rows.length) * 100) / 100,
      completedCourses: completed,
      overdueCourses: overdue,
    };
  }
}

export const storage = new DatabaseStorage();
