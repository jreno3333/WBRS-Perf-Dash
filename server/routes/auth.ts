import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, magicLinkTokens } from "@shared/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { sendMagicLinkEmail } from "../email";
import crypto from "crypto";

const router = Router();

function getAllowedEmails(): string[] | null {
  const allowed = process.env.ALLOWED_LOGIN_EMAILS;
  if (!allowed) return null;
  return allowed.split(",").map(e => e.trim().toLowerCase());
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

router.post("/api/auth/magic-link", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const allowedEmails = getAllowedEmails();
    if (allowedEmails && !allowedEmails.includes(normalizedEmail)) {
      return res.json({ success: true, message: "If that email is authorized, you'll receive a sign-in link." });
    }

    let user = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);

    if (user.length === 0) {
      await db.insert(users).values({
        username: normalizedEmail,
        password: "magic-link-auth",
        email: normalizedEmail,
        role: "viewer",
      });
      user = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenH = hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db.insert(magicLinkTokens).values({
      email: normalizedEmail,
      tokenHash: tokenH,
      expiresAt,
    });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const magicLink = `${baseUrl}/api/auth/verify?token=${token}`;

    const sent = await sendMagicLinkEmail(normalizedEmail, magicLink);
    if (!sent) {
      console.error("[auth] Failed to send magic link email to", normalizedEmail);
    }

    return res.json({ success: true, message: "If that email is authorized, you'll receive a sign-in link." });
  } catch (error) {
    console.error("[auth] Magic link error:", error);
    return res.status(500).json({ message: "Failed to process login request" });
  }
});

router.get("/api/auth/verify", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== "string") {
      return res.redirect("/login?error=invalid");
    }

    const tokenH = hashToken(token);

    const [tokenRecord] = await db.select()
      .from(magicLinkTokens)
      .where(and(
        eq(magicLinkTokens.tokenHash, tokenH),
        isNull(magicLinkTokens.consumedAt)
      ))
      .limit(1);

    if (!tokenRecord) {
      return res.redirect("/login?error=invalid");
    }

    if (new Date() > tokenRecord.expiresAt) {
      return res.redirect("/login?error=expired");
    }

    await db.update(magicLinkTokens)
      .set({ consumedAt: new Date() })
      .where(eq(magicLinkTokens.id, tokenRecord.id));

    const [user] = await db.select()
      .from(users)
      .where(eq(users.email, tokenRecord.email))
      .limit(1);

    if (!user) {
      return res.redirect("/login?error=invalid");
    }

    if (!user.isActive) {
      return res.redirect("/login?error=deactivated");
    }

    await db.update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    req.session.userId = user.id;
    req.session.email = user.email || tokenRecord.email;

    req.session.save((err) => {
      if (err) {
        console.error("[auth] Session save error:", err);
        return res.redirect("/login?error=server");
      }
      return res.redirect("/");
    });
  } catch (error) {
    console.error("[auth] Verify error:", error);
    return res.redirect("/login?error=server");
  }
});

router.get("/api/auth/me", async (req, res) => {
  if (req.session?.userId) {
    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId)).limit(1);
    if (!user || !user.isActive) {
      req.session.destroy((err) => {
        if (err) console.error("[auth] Session destroy error:", err);
      });
      return res.json({ authenticated: false });
    }
    return res.json({
      authenticated: true,
      userId: req.session.userId,
      email: req.session.email,
      role: user.role,
    });
  }
  return res.json({ authenticated: false });
});

router.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: "Failed to logout" });
    }
    res.clearCookie("connect.sid");
    return res.json({ success: true });
  });
});

function requireAdmin(req: any, res: any, next: any) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  db.select().from(users).where(eq(users.id, req.session.userId)).limit(1)
    .then(([user]) => {
      if (!user || user.role !== "admin") {
        return res.status(403).json({ message: "Admin access required" });
      }
      next();
    })
    .catch(() => res.status(500).json({ message: "Server error" }));
}

router.get("/api/users", requireAdmin, async (_req, res) => {
  try {
    const allUsers = await db.select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    }).from(users).orderBy(desc(users.createdAt));
    return res.json(allUsers);
  } catch (error) {
    console.error("[auth] List users error:", error);
    return res.status(500).json({ message: "Failed to list users" });
  }
});

router.patch("/api/users/:id/status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive must be a boolean" });
    }

    if (id === req.session?.userId) {
      return res.status(400).json({ message: "You cannot deactivate your own account" });
    }

    await db.update(users)
      .set({ isActive })
      .where(eq(users.id, id));

    return res.json({ success: true });
  } catch (error) {
    console.error("[auth] Update user status error:", error);
    return res.status(500).json({ message: "Failed to update user status" });
  }
});

router.patch("/api/users/:id/role", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!["admin", "viewer"].includes(role)) {
      return res.status(400).json({ message: "Role must be 'admin' or 'viewer'" });
    }

    if (id === req.session?.userId) {
      return res.status(400).json({ message: "You cannot change your own role" });
    }

    await db.update(users)
      .set({ role })
      .where(eq(users.id, id));

    return res.json({ success: true });
  } catch (error) {
    console.error("[auth] Update user role error:", error);
    return res.status(500).json({ message: "Failed to update user role" });
  }
});

export default router;
