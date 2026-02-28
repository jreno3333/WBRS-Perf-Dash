import { Router } from "express";
import { db } from "../db";
import { emailSubscribers, reportSchedules } from "@shared/schema";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/api/email-subscribers", async (req, res) => {
  try {
    const subscribers = await db.select().from(emailSubscribers).orderBy(emailSubscribers.createdAt);
    res.json(subscribers);
  } catch (error) {
    console.error("Error fetching email subscribers:", error);
    res.status(500).json({ error: "Failed to fetch subscribers" });
  }
});

router.post("/api/email-subscribers", async (req, res) => {
  const { email, name, isActive, reportTime, reportTypes } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const validTypes = ['daily_report', 'leader_report', 'push_report'];
  const requestedTypes = Array.isArray(reportTypes)
    ? reportTypes.filter((t: string) => validTypes.includes(t))
    : ['daily_report', 'leader_report'];

  try {
    const [subscriber] = await db.insert(emailSubscribers)
      .values({
        email: normalizedEmail,
        name: name || null,
        isActive: isActive !== false,
        reportTime: reportTime || "06:00",
        reportTypes: requestedTypes,
      })
      .returning();
    res.json(subscriber);
  } catch (error: any) {
    if (error?.code === "23505") {
      try {
        const [existing] = await db.select().from(emailSubscribers)
          .where(eq(emailSubscribers.email, normalizedEmail)).limit(1);
        if (existing) {
          const currentTypes = existing.reportTypes || [];
          const newTypes = requestedTypes.filter((t: string) => !currentTypes.includes(t));
          if (newTypes.length > 0) {
            const mergedTypes = [...currentTypes, ...newTypes];
            const [updated] = await db.update(emailSubscribers)
              .set({ reportTypes: mergedTypes, name: name || existing.name })
              .where(eq(emailSubscribers.id, existing.id))
              .returning();
            return res.json(updated);
          }
        }
        return res.status(409).json({ error: "Email already subscribed to this report" });
      } catch (innerError) {
        console.error("Error merging subscriber report types:", innerError);
        return res.status(500).json({ error: "Failed to update subscriber" });
      }
    }
    console.error("Error adding email subscriber:", error);
    res.status(500).json({ error: "Failed to add subscriber" });
  }
});

router.patch("/api/email-subscribers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, name, reportTime, reportTypes } = req.body;
    const updates: Record<string, any> = {};
    if (typeof isActive === "boolean") updates.isActive = isActive;
    if (name !== undefined) updates.name = name;
    if (reportTime) updates.reportTime = reportTime;
    if (Array.isArray(reportTypes)) {
      const validTypes = ['daily_report', 'leader_report'];
      updates.reportTypes = reportTypes.filter((t: string) => validTypes.includes(t));
    }

    const [updated] = await db.update(emailSubscribers)
      .set(updates)
      .where(eq(emailSubscribers.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Subscriber not found" });
    }
    res.json(updated);
  } catch (error) {
    console.error("Error updating subscriber:", error);
    res.status(500).json({ error: "Failed to update subscriber" });
  }
});

router.delete("/api/email-subscribers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(emailSubscribers).where(eq(emailSubscribers.id, id));
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting subscriber:", error);
    res.status(500).json({ error: "Failed to delete subscriber" });
  }
});

router.get("/api/leader-report/preview", async (req, res) => {
  try {
    const { buildLeaderReportHtml } = await import("../leader-report");
    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = req.query.date as string || centralFormatter.format(yesterday);
    const html = await buildLeaderReportHtml(dateStr);
    if (!html) {
      res.status(404).json({ error: "No leader data available for this date range" });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Error generating leader report preview:", error);
    res.status(500).json({ error: "Failed to generate leader report preview" });
  }
});

router.post("/api/leader-report/send-now", async (req, res) => {
  try {
    const { sendLeaderReports } = await import("../leader-report");
    const result = await sendLeaderReports(true);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Error sending leader report:", error);
    res.status(500).json({ error: "Failed to send leader report" });
  }
});

router.get("/api/daily-report/preview", async (req, res) => {
  try {
    const { buildDailyReportHtml } = await import("../daily-report");
    const now = new Date();
    const centralFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = req.query.date as string || centralFormatter.format(yesterday);
    const html = await buildDailyReportHtml(dateStr);
    if (!html) {
      res.status(404).json({ error: "No data available for this date" });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Error generating report preview:", error);
    res.status(500).json({ error: "Failed to generate report preview" });
  }
});

router.post("/api/daily-report/send-now", async (req, res) => {
  try {
    const { sendDailyReports } = await import("../daily-report");
    const result = await sendDailyReports(true);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Error sending daily report:", error);
    res.status(500).json({ error: "Failed to send daily report" });
  }
});

// Report schedule configuration
router.get("/api/report-schedules", async (req, res) => {
  try {
    let schedules = await db.select().from(reportSchedules);
    if (schedules.length === 0) {
      await db.insert(reportSchedules).values([
        { reportType: 'daily_report', sendHour: 6, sendMinute: 0, isEnabled: true },
        { reportType: 'leader_report', sendHour: 6, sendMinute: 0, isEnabled: true },
        { reportType: 'push_report', sendHour: 6, sendMinute: 30, isEnabled: false },
      ]).onConflictDoNothing();
      schedules = await db.select().from(reportSchedules);
    }
    // Ensure push_report schedule exists
    if (!schedules.find(s => s.reportType === 'push_report')) {
      await db.insert(reportSchedules).values({
        reportType: 'push_report', sendHour: 6, sendMinute: 30, isEnabled: false,
      }).onConflictDoNothing();
      schedules = await db.select().from(reportSchedules);
    }
    res.json(schedules);
  } catch (error) {
    console.error("Error fetching report schedules:", error);
    res.status(500).json({ error: "Failed to fetch report schedules" });
  }
});

router.patch("/api/report-schedules/:reportType", async (req, res) => {
  try {
    const { reportType } = req.params;
    const validTypes = ['daily_report', 'leader_report', 'push_report'];
    if (!validTypes.includes(reportType)) {
      return res.status(400).json({ error: "Invalid report type" });
    }

    const { sendHour, sendMinute, isEnabled } = req.body;

    if (sendHour !== undefined && (typeof sendHour !== 'number' || sendHour < 0 || sendHour > 23)) {
      return res.status(400).json({ error: "sendHour must be 0-23" });
    }
    if (sendMinute !== undefined && (typeof sendMinute !== 'number' || sendMinute < 0 || sendMinute > 59)) {
      return res.status(400).json({ error: "sendMinute must be 0-59" });
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (sendHour !== undefined) updates.sendHour = sendHour;
    if (sendMinute !== undefined) updates.sendMinute = sendMinute;
    if (isEnabled !== undefined) updates.isEnabled = !!isEnabled;

    const result = await db.update(reportSchedules)
      .set(updates)
      .where(eq(reportSchedules.reportType, reportType))
      .returning();

    if (result.length === 0) {
      const inserted = await db.insert(reportSchedules).values({
        reportType,
        sendHour: sendHour ?? 6,
        sendMinute: sendMinute ?? 0,
        isEnabled: isEnabled !== undefined ? !!isEnabled : true,
      }).returning();
      return res.json(inserted[0]);
    }
    res.json(result[0]);
  } catch (error) {
    console.error("Error updating report schedule:", error);
    res.status(500).json({ error: "Failed to update report schedule" });
  }
});

export default router;
