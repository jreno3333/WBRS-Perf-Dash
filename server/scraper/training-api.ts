// Training Platform API client.
//
// ───────────────────────────────────────────────────────────────────────────
// REAL API contract (rewired May 2026)
// ───────────────────────────────────────────────────────────────────────────
// Base URL:   process.env.TRAINING_API_BASE_URL
//             (e.g. https://mwblearning.wbrssystem.com/api/external)
// Auth:       Bearer token in `Authorization` header
//             Header: `Authorization: Bearer <process.env.TRAINING_API_KEY>`
// Format:     JSON, NOT paginated; single denormalized response.
//
// Endpoint we consume:
//   GET /training-completions?fields=all
//     → { generatedAt, totalEmployees, filters,
//         employees: [{
//           employeeId,             // LMS UUID
//           punchId,                // 7shifts punch_id (string)  ← match key
//           name, email, positionLevel, unitNumber, marketName, hireDate,
//           training: [{ positionLevel, totalCourses, completedCourses,
//                        completionPct, isFullyComplete, completedAt,
//                        startedAt, isOverdue }, ...],
//           overallProgressPct,
//           trainRestart: { positionLevel, score, passed, takenAt,
//                           totalQuestions, correctCount } | null,
//           recertification: ... | null
//         }] }
//
// Match strategy (in order, first hit wins):
//   1. employees.punchId == LMS punchId
//   2. employees.email-equivalent / lower(firstName+lastName) + unitNumber
//      (fallback for unmapped — surfaced in unmappedExternalIds for visibility)
//
// Other LMS endpoints currently return empty data and are NOT yet consumed:
//   /notifications, /lto-completions, /quarterly-tuneup-completions,
//   /servsafe-certifications, /recertifications, /budgets
// ───────────────────────────────────────────────────────────────────────────

import { db } from "../db";
import { employees, restaurants } from "@shared/schema";
import { storage } from "../storage";

// ───── DTOs (real LMS shape) ────────────────────────────────────────────────
interface LmsTrainingPositionRollup {
  positionLevel: string;
  totalCourses: number;
  completedCourses: number;
  completionPct: number;             // 0..100
  isFullyComplete: boolean;
  completedAt: string | null;        // ISO
  startedAt: string | null;          // ISO
  isOverdue: boolean;
}

interface LmsTrainRestart {
  positionLevel: string;
  score: number | null;
  passed: boolean;
  takenAt: string | null;
  totalQuestions: number | null;
  correctCount: number | null;
}

interface LmsEmployee {
  employeeId: string;
  punchId?: string | number | null;
  name?: string | null;
  email?: string | null;
  positionLevel?: string | null;
  unitNumber?: string | number | null;
  marketName?: string | null;
  hireDate?: string | null;
  training?: LmsTrainingPositionRollup[];
  overallProgressPct?: number | null;
  trainRestart?: LmsTrainRestart | null;
  recertification?: unknown | null;
}

interface LmsTrainingCompletionsResponse {
  generatedAt?: string;
  totalEmployees?: number;
  employees: LmsEmployee[];
}

// ───── HTTP helpers ─────────────────────────────────────────────────────────
function getConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.TRAINING_API_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.TRAINING_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

export function isTrainingApiConfigured(): boolean {
  return getConfig() !== null;
}

async function fetchWithRetry(url: string, apiKey: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    } catch (err) {
      lastErr = err;
      if (attempt === retries - 1) break;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Training API fetch failed");
}

// ───── Employee matching ────────────────────────────────────────────────────
interface EmployeeIndex {
  byPunchId: Map<string, string>;          // punchId → employees.id
  byEmail: Map<string, string>;            // lower(email) → employees.id
  byNameUnit: Map<string, string>;         // lower(first+last)|unitNumber → employees.id
}

async function buildEmployeeIndex(): Promise<EmployeeIndex> {
  const empRows = await db
    .select({
      id: employees.id,
      punchId: employees.punchId,
      firstName: employees.firstName,
      lastName: employees.lastName,
      restaurantId: employees.restaurantId,
    })
    .from(employees);

  // Restaurant id → unit number map (for name+unit fallback).
  const restRows = await db.select({ id: restaurants.id, unitNumber: restaurants.unitNumber }).from(restaurants);
  const unitByRestId = new Map<string, string>();
  for (const r of restRows) unitByRestId.set(r.id, String(r.unitNumber));

  const idx: EmployeeIndex = {
    byPunchId: new Map(),
    byEmail: new Map(),
    byNameUnit: new Map(),
  };

  for (const e of empRows) {
    if (e.punchId) idx.byPunchId.set(String(e.punchId), e.id);
    const unit = e.restaurantId ? unitByRestId.get(e.restaurantId) : null;
    if (unit) {
      const nameKey = `${e.firstName} ${e.lastName}`.trim().toLowerCase();
      idx.byNameUnit.set(`${nameKey}|${unit}`, e.id);
    }
  }
  return idx;
}

function resolveEmployee(
  lms: LmsEmployee,
  idx: EmployeeIndex,
): { employeeId: string; matchedBy: "punchId" | "email" | "nameUnit" } | null {
  const pid = lms.punchId != null ? String(lms.punchId).trim() : "";
  if (pid) {
    const hit = idx.byPunchId.get(pid);
    if (hit) return { employeeId: hit, matchedBy: "punchId" };
  }
  const email = (lms.email || "").trim().toLowerCase();
  if (email) {
    const hit = idx.byEmail.get(email);
    if (hit) return { employeeId: hit, matchedBy: "email" };
  }
  const name = (lms.name || "").trim().toLowerCase();
  const unit = lms.unitNumber != null ? String(lms.unitNumber).trim() : "";
  if (name && unit) {
    const hit = idx.byNameUnit.get(`${name}|${unit}`);
    if (hit) return { employeeId: hit, matchedBy: "nameUnit" };
  }
  return null;
}

// ───── Sync ─────────────────────────────────────────────────────────────────
export interface TrainingSyncResult {
  success: boolean;
  durationMs: number;
  recordsSynced: {
    courses: number;             // per-position rollup rows written
    modules: number;             // unused (kept for backward-compatible status payload)
    courseProgress: number;      // total employees written
    moduleProgress: number;      // unused
    certifications: number;      // trainRestart rows written
  };
  unmappedExternalIds: string[];
  error?: string;
}

export async function syncTrainingPlatform(): Promise<TrainingSyncResult> {
  const startedAt = Date.now();
  const cfg = getConfig();
  if (!cfg) {
    const result: TrainingSyncResult = {
      success: false,
      durationMs: 0,
      recordsSynced: { courses: 0, modules: 0, courseProgress: 0, moduleProgress: 0, certifications: 0 },
      unmappedExternalIds: [],
      error: "TRAINING_API_BASE_URL or TRAINING_API_KEY not configured",
    };
    await storage.recordTrainingSyncStatus({
      status: "skipped",
      durationMs: 0,
      recordsSynced: result.recordsSynced,
      unmappedExternalIds: [],
      errorMessage: result.error ?? null,
    });
    return result;
  }

  try {
    const url = `${cfg.baseUrl}/training-completions?fields=all`;
    const res = await fetchWithRetry(url, cfg.apiKey);
    const payload = (await res.json()) as LmsTrainingCompletionsResponse;
    const lmsEmps = Array.isArray(payload.employees) ? payload.employees : [];

    const idx = await buildEmployeeIndex();
    const unmapped = new Set<string>();
    let employeesWritten = 0;
    let positionRowsWritten = 0;
    let trainRestartWritten = 0;

    for (const lms of lmsEmps) {
      const match = resolveEmployee(lms, idx);
      if (!match) {
        // Surface a useful identifier for diagnostics.
        const tag = lms.punchId
          ? `punchId:${lms.punchId}`
          : lms.email
          ? `email:${lms.email}`
          : `name:${lms.name}|unit:${lms.unitNumber}`;
        unmapped.add(tag);
        continue;
      }
      const { employeeId } = match;
      const externalEmployeeId = String(lms.punchId ?? lms.employeeId ?? "");

      // 1. Synthetic "_overall" row carries overallProgressPct for the leaderboard rollup.
      const overall = typeof lms.overallProgressPct === "number" ? lms.overallProgressPct : 0;
      const allComplete = (lms.training ?? []).length > 0 && (lms.training ?? []).every(t => t.isFullyComplete);
      const anyOverdue = (lms.training ?? []).some(t => t.isOverdue);
      const anyStarted = (lms.training ?? []).some(t => t.startedAt != null);
      const overallStatus = allComplete
        ? "completed"
        : anyOverdue
        ? "overdue"
        : anyStarted
        ? "in_progress"
        : "not_started";
      await storage.upsertTrainingEmployeeProgress({
        employeeId,
        externalEmployeeId,
        externalCourseId: "_overall",
        percentComplete: String(overall),
        score: null,
        status: overallStatus,
        dueDate: null,
        completedAt: null,
      });
      employeesWritten++;

      // 2. One row per position-level rollup (so future UI can break it down if desired).
      for (const t of lms.training ?? []) {
        const status = t.isFullyComplete
          ? "completed"
          : t.isOverdue
          ? "overdue"
          : t.startedAt
          ? "in_progress"
          : "not_started";
        await storage.upsertTrainingEmployeeProgress({
          employeeId,
          externalEmployeeId,
          externalCourseId: `position:${t.positionLevel}`,
          percentComplete: String(t.completionPct ?? 0),
          score: null,
          status,
          dueDate: null,
          completedAt: t.completedAt ? new Date(t.completedAt) : null,
        });
        positionRowsWritten++;
      }

      // 3. trainRestart → certification row when present.
      if (lms.trainRestart && lms.trainRestart.takenAt) {
        const tr = lms.trainRestart;
        await storage.upsertTrainingCertification({
          employeeId,
          externalEmployeeId,
          certificationKey: `train_restart:${tr.positionLevel}`,
          name: `Train Restart — ${tr.positionLevel}`,
          earnedAt: tr.passed && tr.takenAt ? new Date(tr.takenAt) : null,
          expiresAt: null,
        });
        trainRestartWritten++;
      }
    }

    const unmappedExternalIds = Array.from(unmapped).sort().slice(0, 200);
    const recordsSynced = {
      courses: positionRowsWritten,
      modules: 0,
      courseProgress: employeesWritten,
      moduleProgress: 0,
      certifications: trainRestartWritten,
    };
    const durationMs = Date.now() - startedAt;

    await storage.recordTrainingSyncStatus({
      status: "success",
      durationMs,
      recordsSynced,
      unmappedExternalIds,
      errorMessage: null,
    });

    return { success: true, durationMs, recordsSynced, unmappedExternalIds };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    const durationMs = Date.now() - startedAt;
    const recordsSynced = { courses: 0, modules: 0, courseProgress: 0, moduleProgress: 0, certifications: 0 };
    await storage.recordTrainingSyncStatus({
      status: "error",
      durationMs,
      recordsSynced,
      unmappedExternalIds: [],
      errorMessage: msg,
    });
    return { success: false, durationMs, recordsSynced, unmappedExternalIds: [], error: msg };
  }
}
