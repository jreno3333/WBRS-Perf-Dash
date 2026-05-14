// Training Platform API client.
//
// ───────────────────────────────────────────────────────────────────────────
// API contract (Phase 1 — read-only sync)
// ───────────────────────────────────────────────────────────────────────────
// Base URL:   process.env.TRAINING_API_BASE_URL  (e.g. https://training.example.com/api/v1)
// Auth:       Bearer token in `Authorization` header
//             Header: `Authorization: Bearer <process.env.TRAINING_API_KEY>`
// Format:     JSON, paginated via `?page=N&pageSize=200`
//             Responses use `{ data: T[], page, pageSize, totalPages }` envelope.
//
// Endpoints we consume:
//   GET /courses                 → TrainingCourseDTO[]
//   GET /modules                 → TrainingModuleDTO[]   (filter: ?courseId=)
//   GET /employees               → TrainingEmployeeDTO[] (used to map external→internal IDs)
//   GET /progress/courses        → TrainingCourseProgressDTO[]   (paginated; per employee/course)
//   GET /progress/modules        → TrainingModuleProgressDTO[]   (paginated; per employee/module)
//   GET /certifications          → TrainingCertificationDTO[]    (paginated; per employee/cert)
//
// Field that maps the training platform's employee → our `employees.id`:
//   TrainingEmployeeDTO.externalId  →  matches employees.sevenShiftsUserId (numeric, stringified)
//   The training platform stores our 7shifts user id in its `external_id` column.
//   Unmatched IDs are surfaced in training_sync_status.unmappedExternalIds.
// ───────────────────────────────────────────────────────────────────────────

import { db } from "../db";
import {
  employees,
  trainingCourses,
  trainingModules,
  trainingEmployeeProgress,
  trainingModuleProgress,
  trainingCertifications,
} from "@shared/schema";
import { storage } from "../storage";

// ───── DTOs ─────────────────────────────────────────────────────────────────
export interface TrainingCourseDTO {
  id: string;
  title: string;
  category?: string | null;        // e.g. "quality", "service", "speed", "hospitality"
  totalModules?: number | null;
}

export interface TrainingModuleDTO {
  id: string;
  courseId: string;
  title: string;
  category?: string | null;
  defaultDueDays?: number | null;
}

export interface TrainingEmployeeDTO {
  id: string;
  externalId: string;              // our employees.sevenShiftsUserId, stringified
  firstName?: string;
  lastName?: string;
}

export interface TrainingCourseProgressDTO {
  employeeExternalId: string;      // matches our sevenShiftsUserId
  courseId: string;
  percentComplete: number;         // 0..100
  score?: number | null;           // 0..100
  completedAt?: string | null;     // ISO
  dueDate?: string | null;         // YYYY-MM-DD
  status?: string | null;          // not_started | in_progress | completed | overdue
}

export interface TrainingModuleProgressDTO {
  employeeExternalId: string;
  moduleId: string;
  status: string;
  dueDate?: string | null;
  score?: number | null;
  completedAt?: string | null;
}

export interface TrainingCertificationDTO {
  employeeExternalId: string;
  certificationKey: string;        // stable key, e.g. "5_star_floor_management"
  name: string;                    // human-readable, e.g. "5-Star Floor Management"
  earnedAt?: string | null;        // ISO
  expiresAt?: string | null;       // ISO
}

interface ApiPage<T> {
  data: T[];
  page?: number;
  pageSize?: number;
  totalPages?: number;
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

async function fetchAllPages<T>(path: string, apiKey: string, baseUrl: string, pageSize = 200): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${baseUrl}${path}${sep}page=${page}&pageSize=${pageSize}`;
    const res = await fetchWithRetry(url, apiKey);
    const json = (await res.json()) as ApiPage<T> | T[];
    const data: T[] = Array.isArray(json) ? json : (json.data ?? []);
    out.push(...data);
    const totalPages = Array.isArray(json) ? 1 : (json.totalPages ?? 1);
    if (page >= totalPages || data.length === 0) break;
    page++;
  }
  return out;
}

// ───── Employee map helper ──────────────────────────────────────────────────
async function buildEmployeeMap(): Promise<Map<string, string>> {
  const rows = await db.select({ id: employees.id, sevenShiftsUserId: employees.sevenShiftsUserId }).from(employees);
  const map = new Map<string, string>();
  for (const e of rows) {
    if (e.sevenShiftsUserId != null) {
      map.set(String(e.sevenShiftsUserId), e.id);
    }
  }
  return map;
}

// ───── Sync functions ───────────────────────────────────────────────────────

export interface TrainingSyncResult {
  success: boolean;
  durationMs: number;
  recordsSynced: {
    courses: number;
    modules: number;
    courseProgress: number;
    moduleProgress: number;
    certifications: number;
  };
  unmappedExternalIds: string[];
  error?: string;
}

export async function syncTrainingCourses(): Promise<{ courses: number; modules: number }> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Training API not configured");

  const courseDtos = await fetchAllPages<TrainingCourseDTO>("/courses", cfg.apiKey, cfg.baseUrl);
  for (const c of courseDtos) {
    await storage.upsertTrainingCourse({
      externalCourseId: c.id,
      title: c.title,
      category: c.category ?? null,
      totalModules: c.totalModules ?? null,
    });
  }

  const moduleDtos = await fetchAllPages<TrainingModuleDTO>("/modules", cfg.apiKey, cfg.baseUrl);
  for (const m of moduleDtos) {
    await storage.upsertTrainingModule({
      externalModuleId: m.id,
      externalCourseId: m.courseId,
      title: m.title,
      category: m.category ?? null,
      defaultDueDays: m.defaultDueDays ?? null,
    });
  }

  return { courses: courseDtos.length, modules: moduleDtos.length };
}

export async function syncTrainingProgress(): Promise<{ courseProgress: number; moduleProgress: number; unmapped: Set<string> }> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Training API not configured");
  const empMap = await buildEmployeeMap();
  const unmapped = new Set<string>();

  const courseProgressDtos = await fetchAllPages<TrainingCourseProgressDTO>("/progress/courses", cfg.apiKey, cfg.baseUrl);
  let courseProgressCount = 0;
  for (const p of courseProgressDtos) {
    const employeeId = empMap.get(String(p.employeeExternalId));
    if (!employeeId) {
      unmapped.add(String(p.employeeExternalId));
      continue;
    }
    await storage.upsertTrainingEmployeeProgress({
      employeeId,
      externalEmployeeId: String(p.employeeExternalId),
      externalCourseId: p.courseId,
      percentComplete: String(p.percentComplete ?? 0),
      score: p.score != null ? String(p.score) : null,
      status: p.status ?? null,
      dueDate: p.dueDate ?? null,
      completedAt: p.completedAt ? new Date(p.completedAt) : null,
    });
    courseProgressCount++;
  }

  const moduleProgressDtos = await fetchAllPages<TrainingModuleProgressDTO>("/progress/modules", cfg.apiKey, cfg.baseUrl);
  let moduleProgressCount = 0;
  for (const p of moduleProgressDtos) {
    const employeeId = empMap.get(String(p.employeeExternalId));
    if (!employeeId) {
      unmapped.add(String(p.employeeExternalId));
      continue;
    }
    await storage.upsertTrainingModuleProgress({
      employeeId,
      externalEmployeeId: String(p.employeeExternalId),
      externalModuleId: p.moduleId,
      status: p.status,
      dueDate: p.dueDate ?? null,
      score: p.score != null ? String(p.score) : null,
      completedAt: p.completedAt ? new Date(p.completedAt) : null,
    });
    moduleProgressCount++;
  }

  return { courseProgress: courseProgressCount, moduleProgress: moduleProgressCount, unmapped };
}

export async function syncCertifications(): Promise<{ certifications: number; unmapped: Set<string> }> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Training API not configured");
  const empMap = await buildEmployeeMap();
  const unmapped = new Set<string>();

  const certDtos = await fetchAllPages<TrainingCertificationDTO>("/certifications", cfg.apiKey, cfg.baseUrl);
  let count = 0;
  for (const c of certDtos) {
    const employeeId = empMap.get(String(c.employeeExternalId));
    if (!employeeId) {
      unmapped.add(String(c.employeeExternalId));
      continue;
    }
    await storage.upsertTrainingCertification({
      employeeId,
      externalEmployeeId: String(c.employeeExternalId),
      certificationKey: c.certificationKey,
      name: c.name,
      earnedAt: c.earnedAt ? new Date(c.earnedAt) : null,
      expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
    });
    count++;
  }

  return { certifications: count, unmapped };
}

// Top-level sync used by scheduler and admin trigger
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
    const { courses, modules } = await syncTrainingCourses();
    const { courseProgress, moduleProgress, unmapped: u1 } = await syncTrainingProgress();
    const { certifications, unmapped: u2 } = await syncCertifications();

    const merged = new Set<string>();
    u1.forEach(v => merged.add(v));
    u2.forEach(v => merged.add(v));
    const unmappedExternalIds = Array.from(merged).sort();
    const recordsSynced = { courses, modules, courseProgress, moduleProgress, certifications };
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

// Re-export the table refs so callers (e.g. tests) can introspect easily
export { trainingCourses, trainingModules, trainingEmployeeProgress, trainingModuleProgress, trainingCertifications };
