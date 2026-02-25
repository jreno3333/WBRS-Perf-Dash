import { Router } from "express";
import crypto from "crypto";
import { db } from "../db";
import { restaurantNotes } from "@shared/schema";
import { eq, and, sql, desc } from "drizzle-orm";

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
  } catch (e) {
    console.error("[Notes] Failed to ensure table:", e);
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

    let notes;
    if (restaurantId) {
      notes = await db.select().from(restaurantNotes)
        .where(and(
          eq(restaurantNotes.date, date as string),
          eq(restaurantNotes.restaurantId, restaurantId as string)
        ))
        .orderBy(desc(restaurantNotes.createdAt));
    } else {
      notes = await db.select().from(restaurantNotes)
        .where(eq(restaurantNotes.date, date as string))
        .orderBy(desc(restaurantNotes.createdAt));
    }

    res.json({ date, notes });
  } catch (error) {
    console.error("Error fetching notes:", error);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Create a new note
router.post("/api/notes", async (req, res) => {
  try {
    await ensureNotesTable();
    const { restaurantId, date, hour, note, author, category } = req.body;

    if (!restaurantId || !date || !note) {
      res.status(400).json({ error: "restaurantId, date, and note are required" });
      return;
    }

    const [newNote] = await db.insert(restaurantNotes).values({
      id: crypto.randomUUID(),
      restaurantId,
      date,
      hour: hour !== undefined && hour !== null ? parseInt(hour) : null,
      note,
      author: author || null,
      category: category || "general",
    }).returning();

    res.json(newNote);
  } catch (error) {
    console.error("Error creating note:", error);
    res.status(500).json({ error: "Failed to create note" });
  }
});

// Delete a note
router.delete("/api/notes/:id", async (req, res) => {
  try {
    await ensureNotesTable();
    const { id } = req.params;
    await db.delete(restaurantNotes).where(eq(restaurantNotes.id, id));
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting note:", error);
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

    const notes = await db.select().from(restaurantNotes)
      .where(
        and(
          sql`${restaurantNotes.date} >= ${startDate as string}`,
          sql`${restaurantNotes.date} <= ${endDate as string}`
        )
      )
      .orderBy(desc(restaurantNotes.createdAt));

    res.json({ startDate, endDate, notes });
  } catch (error) {
    console.error("Error fetching notes range:", error);
    res.status(500).json({ error: "Failed to fetch notes range" });
  }
});

export default router;
