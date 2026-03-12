import { Router, Request, Response } from "express";
import { db } from "../db";
import { polls, pollOptions, pollVotes } from "@shared/schema";
import { eq, and, or, gte, isNull, desc, sql, count } from "drizzle-orm";
import type { PollWithResults } from "@shared/schema";

const router = Router();

// ─── Public: Get active polls with results ──────────────────────────────────

router.get("/api/polls/active", async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const userId = req.session?.userId || null;

    const activePolls = await db
      .select()
      .from(polls)
      .where(
        and(
          eq(polls.isActive, true),
          or(isNull(polls.expiresAt), gte(polls.expiresAt, now))
        )
      )
      .orderBy(desc(polls.createdAt))
      .limit(10);

    const results: PollWithResults[] = [];

    for (const poll of activePolls) {
      // Get options
      const options = await db
        .select()
        .from(pollOptions)
        .where(eq(pollOptions.pollId, poll.id))
        .orderBy(pollOptions.sortOrder);

      // Get vote counts per option
      const voteCounts = await db
        .select({
          optionId: pollVotes.optionId,
          voteCount: count(),
        })
        .from(pollVotes)
        .where(eq(pollVotes.pollId, poll.id))
        .groupBy(pollVotes.optionId);

      const voteMap = new Map(voteCounts.map(v => [v.optionId, Number(v.voteCount)]));

      // Check if user already voted
      let userVotedOptionId: string | null = null;
      if (userId) {
        const [userVote] = await db
          .select()
          .from(pollVotes)
          .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.voterId, userId)))
          .limit(1);
        if (userVote) userVotedOptionId = userVote.optionId;
      }

      const totalVotes = Array.from(voteMap.values()).reduce((sum, c) => sum + c, 0);

      results.push({
        ...poll,
        options: options.map(o => ({
          ...o,
          voteCount: voteMap.get(o.id) || 0,
        })),
        totalVotes,
        userVotedOptionId,
      });
    }

    return res.json({ polls: results });
  } catch (error) {
    console.error("[polls] Failed to fetch active polls:", error);
    return res.status(500).json({ message: "Failed to fetch polls" });
  }
});

// ─── Public: Vote on a poll ─────────────────────────────────────────────────

router.post("/api/polls/:pollId/vote", async (req: Request, res: Response) => {
  try {
    const { pollId } = req.params;
    const { optionId } = req.body;
    const userId = req.session?.userId;

    if (!userId) {
      return res.status(401).json({ message: "Must be logged in to vote" });
    }

    if (!optionId) {
      return res.status(400).json({ message: "Option ID is required" });
    }

    // Check poll exists and is active
    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    if (!poll || !poll.isActive) {
      return res.status(404).json({ message: "Poll not found or inactive" });
    }

    // Check if expired
    if (poll.expiresAt && new Date(poll.expiresAt) < new Date()) {
      return res.status(400).json({ message: "Poll has expired" });
    }

    // Check if option belongs to poll
    const [option] = await db
      .select()
      .from(pollOptions)
      .where(and(eq(pollOptions.id, optionId), eq(pollOptions.pollId, pollId)))
      .limit(1);

    if (!option) {
      return res.status(400).json({ message: "Invalid option for this poll" });
    }

    // Check if user already voted
    const [existingVote] = await db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.voterId, userId)))
      .limit(1);

    if (existingVote) {
      if (!poll.allowMultipleVotes) {
        // Update existing vote
        await db
          .update(pollVotes)
          .set({ optionId, votedAt: new Date() })
          .where(eq(pollVotes.id, existingVote.id));
      } else {
        // Allow new vote
        await db.insert(pollVotes).values({
          pollId,
          optionId,
          voterId: userId,
        });
      }
    } else {
      await db.insert(pollVotes).values({
        pollId,
        optionId,
        voterId: userId,
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[polls] Failed to vote:", error);
    return res.status(500).json({ message: "Failed to submit vote" });
  }
});

// ─── Admin: Get all polls ───────────────────────────────────────────────────

router.get("/api/polls/admin", async (_req: Request, res: Response) => {
  try {
    const allPolls = await db
      .select()
      .from(polls)
      .orderBy(desc(polls.createdAt))
      .limit(50);

    const results: PollWithResults[] = [];

    for (const poll of allPolls) {
      const options = await db
        .select()
        .from(pollOptions)
        .where(eq(pollOptions.pollId, poll.id))
        .orderBy(pollOptions.sortOrder);

      const voteCounts = await db
        .select({
          optionId: pollVotes.optionId,
          voteCount: count(),
        })
        .from(pollVotes)
        .where(eq(pollVotes.pollId, poll.id))
        .groupBy(pollVotes.optionId);

      const voteMap = new Map(voteCounts.map(v => [v.optionId, Number(v.voteCount)]));
      const totalVotes = Array.from(voteMap.values()).reduce((sum, c) => sum + c, 0);

      results.push({
        ...poll,
        options: options.map(o => ({
          ...o,
          voteCount: voteMap.get(o.id) || 0,
        })),
        totalVotes,
      });
    }

    return res.json({ polls: results });
  } catch (error) {
    console.error("[polls] Failed to fetch admin polls:", error);
    return res.status(500).json({ message: "Failed to fetch polls" });
  }
});

// ─── Admin: Create a poll with options ──────────────────────────────────────

router.post("/api/polls", async (req: Request, res: Response) => {
  try {
    const { question, options: optionLabels, expiresAt, allowMultipleVotes } = req.body;

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return res.status(400).json({ message: "Question is required" });
    }

    if (!optionLabels || !Array.isArray(optionLabels) || optionLabels.length < 2) {
      return res.status(400).json({ message: "At least 2 options are required" });
    }

    const [poll] = await db
      .insert(polls)
      .values({
        question: question.trim(),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        allowMultipleVotes: allowMultipleVotes ?? false,
        createdBy: req.session?.userId || "admin",
      })
      .returning();

    const createdOptions = [];
    for (let i = 0; i < optionLabels.length; i++) {
      const label = optionLabels[i];
      if (typeof label === "string" && label.trim().length > 0) {
        const [opt] = await db
          .insert(pollOptions)
          .values({
            pollId: poll.id,
            label: label.trim(),
            sortOrder: i,
          })
          .returning();
        createdOptions.push({ ...opt, voteCount: 0 });
      }
    }

    return res.json({
      poll: {
        ...poll,
        options: createdOptions,
        totalVotes: 0,
      },
    });
  } catch (error) {
    console.error("[polls] Failed to create poll:", error);
    return res.status(500).json({ message: "Failed to create poll" });
  }
});

// ─── Admin: Update poll (toggle active, change question) ────────────────────

router.patch("/api/polls/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};

    if (req.body.question !== undefined) updates.question = req.body.question;
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
    if (req.body.expiresAt !== undefined) updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;

    const [updated] = await db
      .update(polls)
      .set(updates)
      .where(eq(polls.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ message: "Poll not found" });
    }

    return res.json({ poll: updated });
  } catch (error) {
    console.error("[polls] Failed to update poll:", error);
    return res.status(500).json({ message: "Failed to update poll" });
  }
});

// ─── Admin: Delete a poll and its options/votes ─────────────────────────────

router.delete("/api/polls/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Delete votes, options, then poll
    await db.delete(pollVotes).where(eq(pollVotes.pollId, id));
    await db.delete(pollOptions).where(eq(pollOptions.pollId, id));
    const [deleted] = await db.delete(polls).where(eq(polls.id, id)).returning();

    if (!deleted) {
      return res.status(404).json({ message: "Poll not found" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[polls] Failed to delete poll:", error);
    return res.status(500).json({ message: "Failed to delete poll" });
  }
});

export default router;
