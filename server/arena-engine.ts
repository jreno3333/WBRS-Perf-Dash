/**
 * Arena Evaluation Engine — Phase 2
 *
 * Evaluates badges, streaks, and records using real production data.
 * All functions are idempotent (safe to re-run via dedup indexes).
 */

import { db } from "./db";
import {
  arenaConfig, arenaBadgesEarned, arenaStreaks, arenaRecords, arenaMessages,
  hourlySales, hourlyLabor, hmeTimerData, osatData as osatDataTable,
  hourlyCrew, dailyOsat, dailyGoogleReviews, restaurants, employees,
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";

// ─── GRADE COMPUTATION (extracted from leaders.ts) ───

export function getGradeLabel(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

export function gradeToMinScore(grade: string): number {
  const map: Record<string, number> = {
    "A+": 97, A: 93, "A-": 90, "B+": 87, B: 83, "B-": 80,
    "C+": 77, C: 73, "C-": 70, "D+": 67, D: 63, "D-": 60, F: 0,
  };
  return map[grade] ?? 0;
}

interface HourlyMetrics {
  actualSales: number;
  lastWeekSales: number;
  actualStaff: number;
  projectedStaff: number;
  avgDtTime: number | null; // seconds
  osatPercent: number | null;
  osatResponses: number;
}

export function computeHourlyGradeScore(m: HourlyMetrics): number {
  const hasComparableSales = m.lastWeekSales > 0;
  const salesVariancePct = hasComparableSales
    ? ((m.actualSales - m.lastWeekSales) / m.lastWeekSales) * 100 : 0;
  const salesSurge = salesVariancePct >= 20;

  const components: { weight: number; score: number }[] = [];

  if (hasComparableSales) {
    components.push({ weight: 35, score: salesVariancePct >= -5 ? 100 : 50 });
  }

  let staffingScore = 100;
  const staffDiff = m.actualStaff - m.projectedStaff;
  if (Math.abs(staffDiff) > 1) {
    staffingScore = staffDiff > 1 ? 60 : (salesSurge ? 100 : 60);
  }
  components.push({ weight: 15, score: staffingScore });

  if (m.avgDtTime !== null && m.avgDtTime > 0) {
    components.push({ weight: 25, score: m.avgDtTime > 420 ? 40 : m.avgDtTime > 300 ? 70 : 100 });
  }

  if (m.osatPercent !== null && m.osatResponses > 0) {
    components.push({ weight: 25, score: m.osatPercent < 80 ? 40 : m.osatPercent < 85 ? 70 : 100 });
  }

  if (components.length === 0) return 0;
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  return components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
}

// ─── DATA LOADING ───

interface DayData {
  salesByKey: Map<string, { actualSales: number; restaurantId: string; hour: number }>;
  laborByKey: Map<string, { employeeCount: number; projectedLabor: number }>;
  hmeByKey: Map<string, { avgTotalTime: number; carCount: number }>;
  osatByKey: Map<string, { osatPercent: number; totalResponses: number }>;
  crewByKey: Map<string, { crewMembers: any[] }>;
  activeRestaurants: { id: string; name: string; unitNumber: string | null; timezone: string }[];
  leaderEmployees: { id: string; sevenShiftsUserId: number; firstName: string; lastName: string; position: string | null; type: string | null; restaurantId: string | null }[];
}

export async function loadDayData(dateStr: string): Promise<DayData> {
  // Also load last week for week-over-week comparisons
  const lastWeekDate = new Date(dateStr + "T12:00:00Z");
  lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeekDateStr = lastWeekDate.toISOString().split("T")[0];

  const [salesRows, lwSalesRows, laborRows, hmeRows, osatRows, crewRows, restRows, empRows] = await Promise.all([
    db.select().from(hourlySales).where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${dateStr}`
    ),
    db.select().from(hourlySales).where(
      sql`to_char(${hourlySales.salesDate}, 'YYYY-MM-DD') = ${lastWeekDateStr}`
    ),
    db.select().from(hourlyLabor).where(eq(hourlyLabor.date, dateStr)),
    db.select().from(hmeTimerData).where(eq(hmeTimerData.date, dateStr)),
    db.select().from(osatDataTable).where(eq(osatDataTable.date, dateStr)),
    db.select().from(hourlyCrew).where(eq(hourlyCrew.date, dateStr)),
    db.select().from(restaurants).where(eq(restaurants.isActive, true)),
    db.select().from(employees).where(
      and(
        eq(employees.active, true),
        sql`(${employees.position} ILIKE '%manager%' OR ${employees.position} ILIKE '%supervisor%' OR ${employees.type} IN ('manager', 'asst_manager'))`,
        sql`${employees.position} NOT ILIKE '%team member trainer%'`
      )
    ),
  ]);

  // Build keyed maps
  const salesByKey = new Map<string, { actualSales: number; restaurantId: string; hour: number }>();
  for (const s of salesRows) {
    const key = `${s.restaurantId}-${dateStr}-${s.hour}`;
    salesByKey.set(key, { actualSales: Number(s.actualSales) || 0, restaurantId: s.restaurantId, hour: s.hour });
  }
  // Also add last week sales with last week's date key
  for (const s of lwSalesRows) {
    const key = `${s.restaurantId}-${lastWeekDateStr}-${s.hour}`;
    if (!salesByKey.has(key)) {
      salesByKey.set(key, { actualSales: Number(s.actualSales) || 0, restaurantId: s.restaurantId, hour: s.hour });
    }
  }

  const laborByKey = new Map<string, { employeeCount: number; projectedLabor: number }>();
  for (const l of laborRows) {
    laborByKey.set(`${l.restaurantId}-${l.date}-${l.hour}`, {
      employeeCount: Number(l.employeeCount) || 0,
      projectedLabor: Number(l.projectedLabor) || 0,
    });
  }

  const hmeByKey = new Map<string, { avgTotalTime: number; carCount: number }>();
  for (const h of hmeRows) {
    hmeByKey.set(`${h.restaurantId}-${h.date}-${h.hour}`, {
      avgTotalTime: h.avgTotalTime ?? 0,
      carCount: h.carCount ?? 0,
    });
  }

  const osatByKey = new Map<string, { osatPercent: number; totalResponses: number }>();
  for (const o of osatRows) {
    osatByKey.set(`${o.restaurantId}-${o.date}-${o.hour}`, {
      osatPercent: Number(o.osatPercent) || 0,
      totalResponses: o.totalResponses ?? 0,
    });
  }

  const crewByKey = new Map<string, { crewMembers: any[] }>();
  for (const c of crewRows) {
    crewByKey.set(`${c.restaurantId}-${c.date}-${c.hour}`, {
      crewMembers: (c.crewMembers as any[]) || [],
    });
  }

  return {
    salesByKey, laborByKey, hmeByKey, osatByKey, crewByKey,
    activeRestaurants: restRows.map(r => ({ id: r.id, name: r.name, unitNumber: r.unitNumber, timezone: r.timezone })),
    leaderEmployees: empRows.map(e => ({
      id: e.id, sevenShiftsUserId: e.sevenShiftsUserId ?? 0,
      firstName: e.firstName ?? "", lastName: e.lastName ?? "",
      position: e.position, type: e.type, restaurantId: e.restaurantId,
    })),
  };
}

function getHourlyMetrics(data: DayData, restaurantId: string, dateStr: string, hour: number): HourlyMetrics | null {
  const salesKey = `${restaurantId}-${dateStr}-${hour}`;
  const sales = data.salesByKey.get(salesKey);
  if (!sales || sales.actualSales <= 0) return null;

  const labor = data.laborByKey.get(salesKey);
  if (!labor) return null;

  // Get last week sales
  const lwDate = new Date(dateStr + "T12:00:00Z");
  lwDate.setDate(lwDate.getDate() - 7);
  const lwDateStr = lwDate.toISOString().split("T")[0];
  const lwSales = data.salesByKey.get(`${restaurantId}-${lwDateStr}-${hour}`);

  const hme = data.hmeByKey.get(salesKey);
  const osat = data.osatByKey.get(salesKey);

  return {
    actualSales: sales.actualSales,
    lastWeekSales: lwSales?.actualSales || 0,
    actualStaff: labor.employeeCount,
    projectedStaff: labor.projectedLabor / 10,
    avgDtTime: hme && hme.avgTotalTime > 0 ? hme.avgTotalTime : null,
    osatPercent: osat && osat.totalResponses > 0 ? osat.osatPercent : null,
    osatResponses: osat?.totalResponses || 0,
  };
}

// ─── CONFIG LOADING ───

interface BadgeConfig {
  id: string; name: string; icon: string; tier: string; category: string;
  active: boolean; metric: string; operator: string; threshold: number;
  evalFrequency: string; timeWindow: string; hourFilter: { start: number; end: number } | null;
  scope: string; rewardTarget: string; shiftCrewMode: string;
}

interface ArenaConfigFull {
  badges: BadgeConfig[];
  streakConfig: { minGrade: string; trackBy: string; resetOn: string; milestones: any[] };
  gradeThresholds: Record<string, number>;
  fiscalWeekStart: string;
}

async function loadArenaConfig(): Promise<ArenaConfigFull | null> {
  const rows = await db.select().from(arenaConfig).limit(1);
  if (rows.length === 0) return null;
  return rows[0].config as any as ArenaConfigFull;
}

// ─── BADGE AWARDING ───

async function awardBadge(params: {
  badgeId: string; entityId: string; entityType: string; entityName: string;
  restaurantId: string; evalDate: string; evalHour: number | null;
  metricValue: number; shiftTeamMembers?: any[];
}): Promise<boolean> {
  try {
    // Uses ON CONFLICT DO NOTHING via the dedup indexes
    const result = await db.execute(sql`
      INSERT INTO arena_badges_earned (badge_id, entity_id, entity_type, entity_name, restaurant_id, eval_date, eval_hour, metric_value, shift_team_members)
      VALUES (${params.badgeId}, ${params.entityId}, ${params.entityType}, ${params.entityName},
              ${params.restaurantId}, ${params.evalDate}, ${params.evalHour},
              ${params.metricValue}, ${params.shiftTeamMembers ? JSON.stringify(params.shiftTeamMembers) : null}::jsonb)
      ON CONFLICT DO NOTHING
    `);
    return true;
  } catch (err) {
    console.error(`Failed to award badge ${params.badgeId} to ${params.entityId}:`, err);
    return false;
  }
}

// ─── HOURLY BADGE EVALUATION ───

export async function evaluateHourlyBadges(dateStr: string, hour: number): Promise<{ awarded: number }> {
  const config = await loadArenaConfig();
  if (!config) return { awarded: 0 };

  const data = await loadDayData(dateStr);
  let awarded = 0;

  const activeBadges = config.badges.filter(b => b.active);

  // biggerBetterHour — unit badge, hourly: sales beat last week by threshold%
  const bbbBadge = activeBadges.find(b => b.id === "biggerBetterHour");
  if (bbbBadge) {
    for (const rest of data.activeRestaurants) {
      const metrics = getHourlyMetrics(data, rest.id, dateStr, hour);
      if (!metrics || metrics.lastWeekSales <= 0) continue;

      const pctBeat = ((metrics.actualSales - metrics.lastWeekSales) / metrics.lastWeekSales) * 100;
      if (pctBeat >= bbbBadge.threshold) {
        const crew = data.crewByKey.get(`${rest.id}-${dateStr}-${hour}`);
        const teamMembers = crew?.crewMembers || [];
        const unitLabel = rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name;

        const didAward = await awardBadge({
          badgeId: "biggerBetterHour", entityId: rest.id, entityType: "unit",
          entityName: unitLabel, restaurantId: rest.id,
          evalDate: dateStr, evalHour: hour,
          metricValue: Math.round(pctBeat * 100) / 100,
          shiftTeamMembers: teamMembers,
        });
        if (didAward) awarded++;
      }
    }
  }

  // whatAnHour — unit badge, hourly: grade score >= threshold
  const wahBadge = activeBadges.find(b => b.id === "whatAnHour");
  if (wahBadge) {
    for (const rest of data.activeRestaurants) {
      const metrics = getHourlyMetrics(data, rest.id, dateStr, hour);
      if (!metrics) continue;

      const score = computeHourlyGradeScore(metrics);
      if (score >= wahBadge.threshold) {
        const crew = data.crewByKey.get(`${rest.id}-${dateStr}-${hour}`);
        const teamMembers = crew?.crewMembers || [];
        const unitLabel = rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name;

        const didAward = await awardBadge({
          badgeId: "whatAnHour", entityId: rest.id, entityType: "unit",
          entityName: unitLabel, restaurantId: rest.id,
          evalDate: dateStr, evalHour: hour,
          metricValue: Math.round(score * 100) / 100,
          shiftTeamMembers: teamMembers,
        });
        if (didAward) awarded++;
      }
    }
  }

  // rushHour — leader badge, hourly: grade >= threshold during rush hours
  const rhBadge = activeBadges.find(b => b.id === "rushHour");
  if (rhBadge) {
    const hourStart = rhBadge.hourFilter?.start ?? 11;
    const hourEnd = rhBadge.hourFilter?.end ?? 13;

    if (hour >= hourStart && hour <= hourEnd) {
      for (const rest of data.activeRestaurants) {
        const metrics = getHourlyMetrics(data, rest.id, dateStr, hour);
        if (!metrics) continue;

        const score = computeHourlyGradeScore(metrics);
        if (score < rhBadge.threshold) continue;

        // Find leaders on shift this hour
        const crew = data.crewByKey.get(`${rest.id}-${dateStr}-${hour}`);
        if (!crew?.crewMembers?.length) continue;

        for (const member of crew.crewMembers) {
          const leader = data.leaderEmployees.find(e => e.sevenShiftsUserId === member.userId);
          if (!leader) continue;

          const leaderName = `${leader.firstName} ${leader.lastName}`;
          const didAward = await awardBadge({
            badgeId: "rushHour", entityId: String(leader.sevenShiftsUserId), entityType: "leader",
            entityName: leaderName, restaurantId: rest.id,
            evalDate: dateStr, evalHour: hour,
            metricValue: Math.round(score * 100) / 100,
            shiftTeamMembers: crew.crewMembers,
          });
          if (didAward) awarded++;
        }
      }
    }
  }

  return { awarded };
}

// ─── END-OF-DAY BADGE EVALUATION ───

export async function evaluateEndOfDayBadges(dateStr: string): Promise<{ awarded: number }> {
  const config = await loadArenaConfig();
  if (!config) return { awarded: 0 };

  const data = await loadDayData(dateStr);
  let awarded = 0;

  const activeBadges = config.badges.filter(b => b.active);

  // honeyButter — unit badge, company max: highest hourly sales
  const hbBadge = activeBadges.find(b => b.id === "honeyButter");
  if (hbBadge) {
    let maxSales = 0;
    let winner: { restaurantId: string; hour: number; sales: number; team: any[] } | null = null;

    for (const rest of data.activeRestaurants) {
      for (let h = 0; h < 24; h++) {
        const salesRec = data.salesByKey.get(`${rest.id}-${dateStr}-${h}`);
        if (!salesRec || salesRec.actualSales <= 0) continue;

        if (salesRec.actualSales > maxSales) {
          maxSales = salesRec.actualSales;
          const crew = data.crewByKey.get(`${rest.id}-${dateStr}-${h}`);
          winner = { restaurantId: rest.id, hour: h, sales: salesRec.actualSales, team: crew?.crewMembers || [] };
        }
      }
    }

    if (winner) {
      const rest = data.activeRestaurants.find(r => r.id === winner!.restaurantId);
      const unitLabel = rest ? (rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name) : winner.restaurantId;

      const didAward = await awardBadge({
        badgeId: "honeyButter", entityId: winner.restaurantId, entityType: "unit",
        entityName: unitLabel, restaurantId: winner.restaurantId,
        evalDate: dateStr, evalHour: winner.hour,
        metricValue: Math.round(maxSales * 100) / 100,
        shiftTeamMembers: winner.team,
      });
      if (didAward) awarded++;
    }
  }

  // goodnessLives — unit badge: every operational hour graded A+ (>= 95)
  const glBadge = activeBadges.find(b => b.id === "goodnessLives");
  if (glBadge) {
    for (const rest of data.activeRestaurants) {
      let allAPlus = true;
      let hoursEvaluated = 0;

      for (let h = 0; h < 24; h++) {
        const metrics = getHourlyMetrics(data, rest.id, dateStr, h);
        if (!metrics) continue; // No data this hour — skip

        hoursEvaluated++;
        const score = computeHourlyGradeScore(metrics);
        if (score < 95) {
          allAPlus = false;
          break;
        }
      }

      if (allAPlus && hoursEvaluated >= 8) { // Need minimum 8 hours of data
        const unitLabel = rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name;
        const didAward = await awardBadge({
          badgeId: "goodnessLives", entityId: rest.id, entityType: "unit",
          entityName: unitLabel, restaurantId: rest.id,
          evalDate: dateStr, evalHour: null,
          metricValue: hoursEvaluated,
        });
        if (didAward) awarded++;
      }
    }
  }

  return { awarded };
}

// ─── STREAK EVALUATION ───

export async function evaluateStreaks(dateStr: string): Promise<{ updated: number }> {
  const config = await loadArenaConfig();
  if (!config) return { updated: 0 };

  const data = await loadDayData(dateStr);
  const minScore = gradeToMinScore(config.streakConfig.minGrade);
  const trackBy = config.streakConfig.trackBy || "both";
  let updated = 0;

  // Helper: compute daily grade for an entity's hours
  function computeDailyGrade(hours: HourlyMetrics[]): number {
    if (hours.length === 0) return 0;
    const scores = hours.map(h => computeHourlyGradeScore(h));
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Evaluate units
  if (trackBy === "units" || trackBy === "both") {
    for (const rest of data.activeRestaurants) {
      const hourlyMetrics: HourlyMetrics[] = [];
      for (let h = 0; h < 24; h++) {
        const m = getHourlyMetrics(data, rest.id, dateStr, h);
        if (m) hourlyMetrics.push(m);
      }
      if (hourlyMetrics.length < 8) continue; // Need minimum hours

      const dailyGrade = computeDailyGrade(hourlyMetrics);
      const meetsThreshold = dailyGrade >= minScore;
      const entityId = rest.id;
      const entityType = "unit";
      const entityName = rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name;

      // Get current active streak
      const activeStreaks = await db.select().from(arenaStreaks)
        .where(and(
          eq(arenaStreaks.entityId, entityId),
          eq(arenaStreaks.entityType, entityType),
          eq(arenaStreaks.streakActive, true)
        )).limit(1);

      if (meetsThreshold) {
        if (activeStreaks.length === 0) {
          // Start new streak
          await db.insert(arenaStreaks).values({
            entityId, entityType, entityName, restaurantId: rest.id,
            streakStart: dateStr, streakCount: 1, streakActive: true,
            lastEvaluated: dateStr, highestMilestone: 0,
          });
          updated++;
        } else {
          const streak = activeStreaks[0];
          if (streak.lastEvaluated !== dateStr) {
            const newCount = (streak.streakCount ?? 0) + 1;
            // Check milestones
            let highestMilestone = streak.highestMilestone ?? 0;
            for (const ms of config.streakConfig.milestones || []) {
              if (newCount >= ms.days && ms.days > highestMilestone) {
                highestMilestone = ms.days;
              }
            }
            await db.update(arenaStreaks)
              .set({ streakCount: newCount, lastEvaluated: dateStr, highestMilestone })
              .where(eq(arenaStreaks.id, streak.id));
            updated++;
          }
        }
      } else {
        // Break streak
        if (activeStreaks.length > 0) {
          await db.update(arenaStreaks)
            .set({ streakActive: false, endedAt: dateStr })
            .where(eq(arenaStreaks.id, activeStreaks[0].id));
          updated++;
        }
      }
    }
  }

  // Evaluate leaders
  if (trackBy === "leaders" || trackBy === "both") {
    for (const leader of data.leaderEmployees) {
      const hourlyMetrics: HourlyMetrics[] = [];
      let primaryRestaurantId = "";
      const restHours = new Map<string, number>();

      for (const rest of data.activeRestaurants) {
        for (let h = 0; h < 24; h++) {
          const crew = data.crewByKey.get(`${rest.id}-${dateStr}-${h}`);
          if (!crew?.crewMembers?.length) continue;
          const wasWorking = crew.crewMembers.some((m: any) => m.userId === leader.sevenShiftsUserId);
          if (!wasWorking) continue;

          const m = getHourlyMetrics(data, rest.id, dateStr, h);
          if (m) {
            hourlyMetrics.push(m);
            restHours.set(rest.id, (restHours.get(rest.id) || 0) + 1);
          }
        }
      }

      if (hourlyMetrics.length < 4) continue; // Need minimum hours for a leader

      // Determine primary restaurant
      let maxH = 0;
      restHours.forEach((hrs, rid) => { if (hrs > maxH) { maxH = hrs; primaryRestaurantId = rid; } });

      const dailyGrade = computeDailyGrade(hourlyMetrics);
      const meetsThreshold = dailyGrade >= minScore;
      const entityId = String(leader.sevenShiftsUserId);
      const entityType = "leader";
      const entityName = `${leader.firstName} ${leader.lastName}`;

      const activeStreaks = await db.select().from(arenaStreaks)
        .where(and(
          eq(arenaStreaks.entityId, entityId),
          eq(arenaStreaks.entityType, entityType),
          eq(arenaStreaks.streakActive, true)
        )).limit(1);

      if (meetsThreshold) {
        if (activeStreaks.length === 0) {
          await db.insert(arenaStreaks).values({
            entityId, entityType, entityName, restaurantId: primaryRestaurantId,
            streakStart: dateStr, streakCount: 1, streakActive: true,
            lastEvaluated: dateStr, highestMilestone: 0,
          });
          updated++;
        } else {
          const streak = activeStreaks[0];
          if (streak.lastEvaluated !== dateStr) {
            const newCount = (streak.streakCount ?? 0) + 1;
            let highestMilestone = streak.highestMilestone ?? 0;
            for (const ms of config.streakConfig.milestones || []) {
              if (newCount >= ms.days && ms.days > highestMilestone) {
                highestMilestone = ms.days;
              }
            }
            await db.update(arenaStreaks)
              .set({ streakCount: newCount, lastEvaluated: dateStr, highestMilestone })
              .where(eq(arenaStreaks.id, streak.id));
            updated++;
          }
        }
      } else {
        if (activeStreaks.length > 0) {
          await db.update(arenaStreaks)
            .set({ streakActive: false, endedAt: dateStr })
            .where(eq(arenaStreaks.id, activeStreaks[0].id));
          updated++;
        }
      }
    }
  }

  return { updated };
}

// ─── RECORDS EVALUATION ───

export async function evaluateRecords(dateStr: string): Promise<{ newRecords: number }> {
  const data = await loadDayData(dateStr);
  let newRecords = 0;

  // highest_hourly_sales — find peak hourly sales across all restaurants
  let maxSales = 0;
  let maxSalesInfo: { restaurantId: string; hour: number; team: any[] } | null = null;
  for (const rest of data.activeRestaurants) {
    for (let h = 0; h < 24; h++) {
      const s = data.salesByKey.get(`${rest.id}-${dateStr}-${h}`);
      if (s && s.actualSales > maxSales) {
        maxSales = s.actualSales;
        const crew = data.crewByKey.get(`${rest.id}-${dateStr}-${h}`);
        maxSalesInfo = { restaurantId: rest.id, hour: h, team: crew?.crewMembers || [] };
      }
    }
  }
  if (maxSalesInfo && maxSales > 0) {
    const existing = await db.select().from(arenaRecords)
      .where(eq(arenaRecords.recordType, "highest_hourly_sales"))
      .orderBy(desc(arenaRecords.value)).limit(1);
    if (existing.length === 0 || maxSales > Number(existing[0].value)) {
      const rest = data.activeRestaurants.find(r => r.id === maxSalesInfo!.restaurantId);
      const holderName = rest ? (rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name) : maxSalesInfo.restaurantId;
      await db.insert(arenaRecords).values({
        recordType: "highest_hourly_sales", holderId: maxSalesInfo.restaurantId,
        holderType: "unit", holderName, restaurantId: maxSalesInfo.restaurantId,
        value: String(Math.round(maxSales * 100) / 100),
        evalDate: dateStr, evalHour: maxSalesInfo.hour,
        teamMembers: maxSalesInfo.team,
      });
      newRecords++;
    }
  }

  // fastest_dt_avg — find best (lowest) daily avg DT time
  for (const rest of data.activeRestaurants) {
    let totalTime = 0;
    let totalCars = 0;
    for (let h = 0; h < 24; h++) {
      const hme = data.hmeByKey.get(`${rest.id}-${dateStr}-${h}`);
      if (hme && hme.avgTotalTime > 0 && hme.carCount > 0) {
        totalTime += hme.avgTotalTime * hme.carCount;
        totalCars += hme.carCount;
      }
    }
    if (totalCars < 20) continue; // Minimum car threshold
    const avgDt = totalTime / totalCars;

    const existing = await db.select().from(arenaRecords)
      .where(eq(arenaRecords.recordType, "fastest_dt_avg"))
      .orderBy(arenaRecords.value).limit(1);

    if (existing.length === 0 || avgDt < Number(existing[0].value)) {
      const holderName = rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name;
      await db.insert(arenaRecords).values({
        recordType: "fastest_dt_avg", holderId: rest.id,
        holderType: "unit", holderName, restaurantId: rest.id,
        value: String(Math.round(avgDt * 100) / 100),
        evalDate: dateStr, evalHour: null,
      });
      newRecords++;
    }
  }

  // best_daily_osat — highest OSAT score for the day
  const osatRows = await db.select().from(dailyOsat).where(eq(dailyOsat.date, dateStr));
  let bestOsat = 0;
  let bestOsatRest: typeof osatRows[0] | null = null;
  for (const o of osatRows) {
    const pct = Number(o.osatPercent) || 0;
    if (pct > bestOsat && (o.totalResponses ?? 0) >= 3) { // Minimum 3 responses
      bestOsat = pct;
      bestOsatRest = o;
    }
  }
  if (bestOsatRest && bestOsat > 0) {
    const existing = await db.select().from(arenaRecords)
      .where(eq(arenaRecords.recordType, "best_daily_osat"))
      .orderBy(desc(arenaRecords.value)).limit(1);

    if (existing.length === 0 || bestOsat > Number(existing[0].value)) {
      const rest = data.activeRestaurants.find(r => r.id === bestOsatRest!.restaurantId);
      const holderName = rest ? (rest.unitNumber ? `#${rest.unitNumber} ${rest.name}` : rest.name) : bestOsatRest.restaurantId;
      await db.insert(arenaRecords).values({
        recordType: "best_daily_osat", holderId: bestOsatRest.restaurantId,
        holderType: "unit", holderName, restaurantId: bestOsatRest.restaurantId,
        value: String(Math.round(bestOsat * 100) / 100),
        evalDate: dateStr, evalHour: null,
      });
      newRecords++;
    }
  }

  // longest_streak — check current active streaks
  const longestActive = await db.select().from(arenaStreaks)
    .where(eq(arenaStreaks.streakActive, true))
    .orderBy(desc(arenaStreaks.streakCount)).limit(1);
  if (longestActive.length > 0) {
    const count = longestActive[0].streakCount ?? 0;
    const existing = await db.select().from(arenaRecords)
      .where(eq(arenaRecords.recordType, "longest_streak"))
      .orderBy(desc(arenaRecords.value)).limit(1);

    if (existing.length === 0 || count > Number(existing[0].value)) {
      await db.insert(arenaRecords).values({
        recordType: "longest_streak", holderId: longestActive[0].entityId,
        holderType: longestActive[0].entityType, holderName: longestActive[0].entityName,
        restaurantId: longestActive[0].restaurantId,
        value: String(count), evalDate: dateStr, evalHour: null,
      });
      newRecords++;
    }
  }

  return { newRecords };
}

// ─── FULL EVALUATION RUNNER (for manual/debug trigger) ───

export async function runFullEvaluation(dateStr: string, type: string = "all"): Promise<{
  hourlyBadges: number; dailyBadges: number; streaksUpdated: number; newRecords: number;
}> {
  let hourlyBadges = 0;
  let dailyBadges = 0;
  let streaksUpdated = 0;
  let newRecords = 0;

  if (type === "all" || type === "hourly") {
    for (let h = 0; h < 24; h++) {
      const result = await evaluateHourlyBadges(dateStr, h);
      hourlyBadges += result.awarded;
    }
  }

  if (type === "all" || type === "daily") {
    const dailyResult = await evaluateEndOfDayBadges(dateStr);
    dailyBadges = dailyResult.awarded;

    const streakResult = await evaluateStreaks(dateStr);
    streaksUpdated = streakResult.updated;

    const recordResult = await evaluateRecords(dateStr);
    newRecords = recordResult.newRecords;
  }

  return { hourlyBadges, dailyBadges, streaksUpdated, newRecords };
}
