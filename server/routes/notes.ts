import { Router } from "express";
import crypto from "crypto";
import { db } from "../db";
import { sql } from "drizzle-orm";

const router = Router();

// Ensure table exists (creates if missing)
let tableEnsured = false;
async function ensureNotesTable() {
  if (tableEnsured) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS restaurant_notes (
        id VARCHAR PRIMARY KEY,
        restaurant_id VARCHAR NOT NULL,
        date TEXT NOT NULL,
        hour INTEGER,
        note TEXT NOT NULL,
        author TEXT,
        category TEXT DEFAULT 'general',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    tableEnsured = true;
    console.log("[Notes] Table ensured successfully");
  } catch (e: any) {
    // Table might already exist with old schema - try to verify it exists
    try {
      await db.execute(sql`SELECT 1 FROM restaurant_notes LIMIT 0`);
      tableEnsured = true;
      console.log("[Notes] Table already exists (verified via SELECT)");
    } catch {
      console.error("[Notes] Failed to ensure table:", e?.message || e);
    }
  }
}

// Get notes for a specific date (optionally filtered by restaurant)
router.get("/api/notes", async (req, res) => {
  try {
    await ensureNotesTable();
    const { date, restaurantId } = req.query;
    if (!date) {
      res.status(400).json({ error: "date parameter required" });
      return;
    }

    let result;
    if (restaurantId) {
      result = await db.execute(sql`
        SELECT id, restaurant_id AS "restaurantId", date, hour, note, author, category,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM restaurant_notes
        WHERE date = ${date as string} AND restaurant_id = ${restaurantId as string}
        ORDER BY created_at DESC
      `);
    } else {
      result = await db.execute(sql`
        SELECT id, restaurant_id AS "restaurantId", date, hour, note, author, category,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM restaurant_notes
        WHERE date = ${date as string}
        ORDER BY created_at DESC
      `);
    }

    res.json({ date, notes: result.rows || [] });
  } catch (error: any) {
    console.error("Error fetching notes:", error?.message || error);
    res.status(500).json({ error: "Failed to fetch notes: " + (error?.message || "unknown") });
  }
});

// Create a new note
router.post("/api/notes", async (req, res) => {
  try {
    await ensureNotesTable();
    const { restaurantId, date, hour, note, author, category } = req.body || {};

    if (!restaurantId || !date || !note) {
      res.status(400).json({ error: "restaurantId, date, and note are required" });
      return;
    }

    const id = crypto.randomUUID();
    const hourVal = hour !== undefined && hour !== null ? parseInt(hour) : null;
    const catVal = category || "general";
    // Auto-populate author from session email; fall back to request body
    const authorVal = req.session?.email || author || null;

    const result = await db.execute(sql`
      INSERT INTO restaurant_notes (id, restaurant_id, date, hour, note, author, category, created_at, updated_at)
      VALUES (${id}, ${restaurantId}, ${date}, ${hourVal}, ${note}, ${authorVal}, ${catVal}, NOW(), NOW())
      RETURNING id, restaurant_id AS "restaurantId", date, hour, note, author, category,
                created_at AS "createdAt", updated_at AS "updatedAt"
    `);

    const newNote = result.rows?.[0];
    if (!newNote) {
      res.status(500).json({ error: "Insert succeeded but no row returned" });
      return;
    }

    res.json(newNote);
  } catch (error: any) {
    console.error("Error creating note:", error?.message || error);
    res.status(500).json({ error: "Failed to create note: " + (error?.message || "unknown") });
  }
});

// Delete a note
router.delete("/api/notes/:id", async (req, res) => {
  try {
    await ensureNotesTable();
    const { id } = req.params;
    await db.execute(sql`DELETE FROM restaurant_notes WHERE id = ${id}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting note:", error?.message || error);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// Get all notes for a date range (for AI summary integration)
router.get("/api/notes/range", async (req, res) => {
  try {
    await ensureNotesTable();
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      res.status(400).json({ error: "startDate and endDate required" });
      return;
    }

    const result = await db.execute(sql`
      SELECT id, restaurant_id AS "restaurantId", date, hour, note, author, category,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM restaurant_notes
      WHERE date >= ${startDate as string} AND date <= ${endDate as string}
      ORDER BY created_at DESC
    `);

    res.json({ startDate, endDate, notes: result.rows || [] });
  } catch (error: any) {
    console.error("Error fetching notes range:", error?.message || error);
    res.status(500).json({ error: "Failed to fetch notes range" });
  }
});

// Diagnostic endpoint
router.get("/api/notes/health", async (_req, res) => {
  try {
    await ensureNotesTable();
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM restaurant_notes`);
    res.json({ status: "ok", tableEnsured, count: result.rows?.[0]?.count ?? 0 });
  } catch (error: any) {
    res.json({ status: "error", tableEnsured, error: error?.message || "unknown" });
  }
});

export default router;
