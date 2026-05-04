import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startScheduler } from "./scheduler";
import { backfillDestinations } from "./xenial-webhook";
import { ensureFeatureTables } from "./db";

const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-session" {
  interface SessionData {
    userId: string;
    email: string;
  }
}

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "mwb-dashboard-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  }),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Lightweight request logger. Avoids JSON.stringify of every response body —
// for large leaderboard/analytics payloads the stringify cost showed up on the
// hot path. Log only the response byte size (from Content-Length) and slow
// request bodies (>1s) get a truncated preview to aid debugging.
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  if (!path.startsWith("/api")) return next();

  let slowResponse: unknown;
  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    if (Date.now() - start > 1000) slowResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    const size = res.getHeader("content-length");
    let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms${size ? ` (${size}b)` : ""}`;
    if (slowResponse !== undefined) {
      const body = JSON.stringify(slowResponse);
      logLine += ` :: ${body.length > 200 ? body.slice(0, 200) + "..." : body}`;
    }
    log(logLine);
  });

  next();
});

(async () => {
  // Kick off feature-table migrations in the background. Routes don't read
  // these tables until requests arrive, and migrations finish in <100ms in
  // practice — running them concurrently with route registration shaves
  // startup time without changing first-request semantics in any meaningful
  // way (a request that lands during the gap fails and the client retries).
  const featureTablesReady = ensureFeatureTables();

  await registerRoutes(httpServer, app);
  await featureTablesReady;

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      // Run post-listen tasks in the background — none of them need to block
      // request handling, and previously startScheduler was awaited inside
      // the listen callback, delaying readiness for no benefit.
      backfillDestinations().catch((err) => console.error("[startup] backfillDestinations failed:", err));
      startScheduler().catch((err) => console.error("[startup] startScheduler failed:", err));
    },
  );
})();
