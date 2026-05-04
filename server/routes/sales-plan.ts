import { Router } from "express";
import * as XLSX from "xlsx";
import { db } from "../db";
import { salesPlanDaily, restaurants } from "@shared/schema";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { getAllHourlyPosSalesRange } from "../xenial-webhook";

// Fiscal calendar (mirrors client/src/lib/fiscal-calendar.ts).
// Anchor: FY2026 P1 = Saturday Oct 4, 2025; periods follow 4-4-5 weeks per quarter.
const FC_ANCHOR_UTC_MS = Date.UTC(2025, 9, 4);
const FC_PERIOD_WEEKS = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];
const FC_WEEKS_PER_FY = FC_PERIOD_WEEKS.reduce((a, b) => a + b, 0);
const FC_MS_PER_DAY = 86400000;

function fcToUtc(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function fcFmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function getQuarterStart(dateStr: string): string {
  const todayMs = fcToUtc(dateStr);
  const daysSince = Math.floor((todayMs - FC_ANCHOR_UTC_MS) / FC_MS_PER_DAY);
  let fyOffset = Math.floor(daysSince / (FC_WEEKS_PER_FY * 7));
  let weeksIntoFy = Math.floor((daysSince - fyOffset * FC_WEEKS_PER_FY * 7) / 7);
  while (weeksIntoFy < 0) { weeksIntoFy += FC_WEEKS_PER_FY; fyOffset -= 1; }
  let consumed = 0;
  let periodIdx = 0;
  for (let i = 0; i < FC_PERIOD_WEEKS.length; i++) {
    if (weeksIntoFy < consumed + FC_PERIOD_WEEKS[i]) { periodIdx = i; break; }
    consumed += FC_PERIOD_WEEKS[i];
  }
  const quarter = Math.floor(periodIdx / 3);
  const weeksBeforeQuarter = FC_PERIOD_WEEKS.slice(0, quarter * 3).reduce((a, b) => a + b, 0);
  const fyStartMs = FC_ANCHOR_UTC_MS + fyOffset * FC_WEEKS_PER_FY * 7 * FC_MS_PER_DAY;
  return fcFmt(fyStartMs + weeksBeforeQuarter * 7 * FC_MS_PER_DAY);
}
function previousDay(dateStr: string): string {
  return fcFmt(fcToUtc(dateStr) - FC_MS_PER_DAY);
}

const router = Router();

// Excel serial date → "YYYY-MM-DD" (treats serial as a calendar date, no TZ shift).
// Excel epoch is 1899-12-30 because of the spurious 1900 leap-year day.
function excelSerialToDateStr(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 80000) return null;
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDateCell(cell: any): string | null {
  if (cell == null || cell === "") return null;
  if (typeof cell === "number") return excelSerialToDateStr(cell);
  if (cell instanceof Date) {
    const y = cell.getUTCFullYear();
    const m = String(cell.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cell.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const s = String(cell).trim();
  // ISO-ish
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }
  // M/D/YY or M/D/YYYY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let [, mm, dd, yy] = us;
    let year = parseInt(yy);
    if (year < 100) year += 2000;
    return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return null;
}

function toNumber(cell: any): number | null {
  if (cell == null || cell === "") return null;
  if (typeof cell === "number") return cell;
  const n = parseFloat(String(cell).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

router.post("/api/sales-plan/upload", async (req, res) => {
  try {
    const { fileBase64, fileName, sourceLabel } = req.body as {
      fileBase64?: string;
      fileName?: string;
      sourceLabel?: string;
    };

    if (!fileBase64 || typeof fileBase64 !== "string") {
      return res.status(400).json({ error: "fileBase64 string is required" });
    }

    const buffer = Buffer.from(fileBase64, "base64");
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: "buffer" });
    } catch (e: any) {
      return res.status(400).json({ error: "Could not parse spreadsheet", details: e?.message });
    }

    const allRestaurants = await db.select({
      id: restaurants.id,
      unitNumber: restaurants.unitNumber,
      name: restaurants.name,
    }).from(restaurants);

    const unitMap = new Map<string, string>();
    for (const r of allRestaurants) {
      if (r.unitNumber) unitMap.set(String(r.unitNumber), r.id);
    }

    const label = sourceLabel || (fileName ? fileName.replace(/\.[^.]+$/, "") : null);

    let inserted = 0;
    let skipped = 0;
    let totalRows = 0;
    const unmatchedSheets = new Set<string>();
    const sheetsProcessed: Array<{ sheet: string; unitNumber: string; rows: number }> = [];

    for (const sheetName of workbook.SheetNames) {
      const ws = workbook.Sheets[sheetName];
      if (!ws) continue;

      const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null, raw: true });
      if (rows.length === 0) continue;

      // Header row → column index lookup
      const header = (rows[0] || []).map((c: any) => String(c ?? "").trim().toLowerCase());
      const col = (...names: string[]) => {
        for (const n of names) {
          const i = header.indexOf(n);
          if (i >= 0) return i;
        }
        return -1;
      };
      const cLoc = col("location_code", "location code", "location", "unit", "unit_number");
      const cDate = col("business_date", "date", "business date");
      const cNet = col("net_sales", "net sales", "plan", "planned_net_sales");
      const cGross = col("gross_sales", "gross sales");
      const cComps = col("comps_discounts", "comps", "comps/discounts", "discounts");
      const cPaper = col("paper_cost_pct", "paper cost %", "paper_pct");
      const cLabor = col("variable_labor_pct", "labor %", "labor_pct", "variable labor");

      if (cDate < 0 || cNet < 0) {
        // No usable columns on this sheet; skip silently
        continue;
      }

      // Resolve unit number: prefer the per-row location_code column, else fall back to sheet name.
      const sheetUnit = sheetName.trim();
      const sheetRestaurantId = unitMap.get(sheetUnit);

      const batch: Array<typeof salesPlanDaily.$inferInsert> = [];
      let rowsForSheet = 0;

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        totalRows++;

        const locCell = cLoc >= 0 ? r[cLoc] : null;
        const unitNumber = locCell != null && locCell !== ""
          ? String(locCell).match(/\d+/)?.[0] ?? sheetUnit
          : sheetUnit;
        const restaurantId = unitMap.get(unitNumber);

        if (!restaurantId) {
          unmatchedSheets.add(unitNumber);
          skipped++;
          continue;
        }

        const dateStr = parseDateCell(r[cDate]);
        const netSales = toNumber(r[cNet]);
        if (!dateStr || netSales == null) {
          skipped++;
          continue;
        }

        const grossSales = cGross >= 0 ? toNumber(r[cGross]) : null;
        const comps = cComps >= 0 ? toNumber(r[cComps]) : null;
        const paperPct = cPaper >= 0 ? toNumber(r[cPaper]) : null;
        const laborPct = cLabor >= 0 ? toNumber(r[cLabor]) : null;

        batch.push({
          restaurantId,
          date: dateStr,
          plannedNetSales: netSales.toFixed(2),
          plannedGrossSales: grossSales != null ? grossSales.toFixed(2) : null,
          plannedComps: comps != null ? comps.toFixed(2) : null,
          plannedPaperCostPct: paperPct != null ? paperPct.toFixed(4) : null,
          plannedVariableLaborPct: laborPct != null ? laborPct.toFixed(4) : null,
          sourceLabel: label,
        });
        rowsForSheet++;
      }

      if (batch.length === 0) continue;

      const chunkSize = 200;
      for (let i = 0; i < batch.length; i += chunkSize) {
        const chunk = batch.slice(i, i + chunkSize);
        await db.insert(salesPlanDaily)
          .values(chunk)
          .onConflictDoUpdate({
            target: [salesPlanDaily.restaurantId, salesPlanDaily.date],
            set: {
              plannedNetSales: sql`EXCLUDED.planned_net_sales`,
              plannedGrossSales: sql`EXCLUDED.planned_gross_sales`,
              plannedComps: sql`EXCLUDED.planned_comps`,
              plannedPaperCostPct: sql`EXCLUDED.planned_paper_cost_pct`,
              plannedVariableLaborPct: sql`EXCLUDED.planned_variable_labor_pct`,
              sourceLabel: sql`EXCLUDED.source_label`,
              uploadedAt: sql`NOW()`,
            },
          });
        inserted += chunk.length;
      }

      sheetsProcessed.push({ sheet: sheetName, unitNumber: sheetUnit, rows: rowsForSheet });
    }

    res.json({
      success: true,
      inserted,
      skipped,
      totalRows,
      sheetsProcessed,
      unmatchedStores: Array.from(unmatchedSheets),
    });
  } catch (error: any) {
    console.error("[sales-plan] upload error:", error);
    res.status(500).json({ error: "Failed to upload sales plan", details: error?.message });
  }
});

router.get("/api/sales-plan/summary", async (_req, res) => {
  try {
    const [row] = await db.select({
      totalRecords: sql<number>`COUNT(*)::int`,
      minDate: sql<string>`MIN(date)`,
      maxDate: sql<string>`MAX(date)`,
      storeCount: sql<number>`COUNT(DISTINCT restaurant_id)::int`,
      sources: sql<string[]>`COALESCE(ARRAY_AGG(DISTINCT source_label) FILTER (WHERE source_label IS NOT NULL), '{}')`,
    }).from(salesPlanDaily);
    res.json(row || { totalRecords: 0, minDate: null, maxDate: null, storeCount: 0, sources: [] });
  } catch (error: any) {
    console.error("[sales-plan] summary error:", error);
    res.status(500).json({ error: "Failed to fetch sales plan summary" });
  }
});

router.get("/api/sales-plan", async (req, res) => {
  try {
    const { startDate, endDate, restaurantId } = req.query as Record<string, string | undefined>;
    const conds: any[] = [];
    if (startDate) conds.push(gte(salesPlanDaily.date, startDate));
    if (endDate) conds.push(lte(salesPlanDaily.date, endDate));
    if (restaurantId) conds.push(eq(salesPlanDaily.restaurantId, restaurantId));
    const rows = await db.select().from(salesPlanDaily).where(conds.length ? and(...conds) : undefined);
    res.json({ rows });
  } catch (error: any) {
    console.error("[sales-plan] query error:", error);
    res.status(500).json({ error: "Failed to fetch sales plan" });
  }
});

// Quarter-to-date plan vs actual per restaurant. Window: current fiscal quarter
// start through the previous Central day (today excluded so we compare full days).
router.get("/api/sales-plan/qtd", async (req, res) => {
  try {
    const realToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const todayStr = req.query.date ? String(req.query.date) : realToday;
    const quarterStart = getQuarterStart(todayStr);
    const throughDate = previousDay(todayStr);

    // No completed days yet (e.g. on the first Saturday of a quarter) — return empty.
    if (throughDate < quarterStart) {
      return res.json({ quarterStart, throughDate, restaurants: {} });
    }

    // Plan totals from sales_plan_daily.
    const planRows = await db.select({
      restaurantId: salesPlanDaily.restaurantId,
      total: sql<string>`SUM(${salesPlanDaily.plannedNetSales})`,
    })
      .from(salesPlanDaily)
      .where(and(
        gte(salesPlanDaily.date, quarterStart),
        lte(salesPlanDaily.date, throughDate),
      ))
      .groupBy(salesPlanDaily.restaurantId);

    // Actual totals from POS (pos_orders), bucketed in each restaurant's local
    // timezone via the shared POS aggregation helper. Same source of truth as
    // the leaderboard's POS-driven sales numbers.
    const posMap = await getAllHourlyPosSalesRange(quarterStart, throughDate);

    const result: Record<string, { plannedSales: number; actualSales: number }> = {};
    for (const r of planRows) {
      result[r.restaurantId] = {
        plannedSales: Math.round(parseFloat(r.total ?? "0") || 0),
        actualSales: 0,
      };
    }
    posMap.forEach((sales, key) => {
      // Key shape: `${restaurantId}-${localDate YYYY-MM-DD}-${hour}`
      // restaurantId is a UUID (contains dashes), so parse from the right:
      // the 10-char date sits immediately before the final dash + hour.
      const lastDash = key.lastIndexOf("-");
      if (lastDash < 11) return;
      const localDate = key.slice(lastDash - 10, lastDash);
      const restaurantId = key.slice(0, lastDash - 11);
      if (localDate < quarterStart || localDate > throughDate) return;
      const entry = result[restaurantId] ?? { plannedSales: 0, actualSales: 0 };
      entry.actualSales += Number(sales) || 0;
      result[restaurantId] = entry;
    });
    for (const id of Object.keys(result)) {
      result[id].actualSales = Math.round(result[id].actualSales);
    }

    res.json({ quarterStart, throughDate, restaurants: result });
  } catch (error: any) {
    console.error("[sales-plan] qtd error:", error);
    res.status(500).json({ error: "Failed to fetch QTD plan variance", details: error?.message });
  }
});

router.delete("/api/sales-plan", async (_req, res) => {
  try {
    await db.delete(salesPlanDaily);
    res.json({ success: true, message: "All sales plan data deleted" });
  } catch (error: any) {
    console.error("[sales-plan] delete error:", error);
    res.status(500).json({ error: "Failed to delete sales plan data" });
  }
});

export default router;
