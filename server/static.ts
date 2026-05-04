import express, { type Express, type Response } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Vite emits hashed filenames (e.g. index-abc123.js) for everything in
  // /assets, so they're safe to cache aggressively. HTML must stay fresh so
  // clients pick up new bundle hashes — set no-cache on it explicitly.
  app.use(
    express.static(distPath, {
      index: false,
      etag: true,
      lastModified: true,
      maxAge: "1y",
      setHeaders: (res: Response, filePath: string) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // fall through to index.html if the file doesn't exist (SPA routing)
  app.use("/{*path}", (req, res, next) => {
    if (req.originalUrl.startsWith("/api/")) {
      return next();
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
