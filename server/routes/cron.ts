import { Router, type Request, type Response, type NextFunction } from "express";

const router = Router();

function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "CRON_SECRET not configured on server" });
  }

  const authHeader = req.headers.authorization || "";
  const headerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const provided = headerToken || queryToken;

  if (!provided || provided !== secret) {
    return res.status(401).json({ error: "Invalid or missing cron secret" });
  }

  return next();
}

router.post("/api/cron/send-report", requireCronSecret, async (req: Request, res: Response) => {
  const type = (req.query.type as string) || (req.body?.type as string) || "";

  try {
    let result: { sent: number; failed: number };

    switch (type) {
      case "push": {
        const { sendPushReports } = await import("../push-report");
        result = await sendPushReports(true);
        break;
      }
      case "leader": {
        const { sendLeaderReports } = await import("../leader-report");
        result = await sendLeaderReports(true);
        break;
      }
      case "daily": {
        const { sendDailyReports } = await import("../daily-report");
        result = await sendDailyReports(true);
        break;
      }
      case "sales-summary": {
        const { sendSalesSummaryReports } = await import("../sales-summary-report");
        result = await sendSalesSummaryReports(true);
        break;
      }
      default:
        return res.status(400).json({
          error: "Invalid type. Use one of: push, leader, daily, sales-summary",
        });
    }

    console.log(`[cron] ${type} report triggered: ${result.sent} sent, ${result.failed} failed`);
    return res.json({ success: true, type, ...result });
  } catch (error) {
    console.error(`[cron] ${type} report error:`, error);
    return res.status(500).json({
      error: `Failed to send ${type} report`,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/api/cron/health", requireCronSecret, (_req: Request, res: Response) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

export default router;
