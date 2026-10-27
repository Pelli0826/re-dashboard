// Sign-in: one shared password, login rate limit, and the guard on every other /api route.
import type { Express } from "express";
import crypto from "crypto";

const isProduction = process.env.NODE_ENV === "production";

// In production a password is mandatory. Without one the dashboard stays locked
// rather than falling open to anyone who finds the URL.
function passwordStatus(): "set" | "missing-dev" | "missing-prod" {
  if (process.env.DASHBOARD_PASSWORD) return "set";
  return isProduction ? "missing-prod" : "missing-dev";
}

function passwordMatches(input: unknown): boolean {
  const correct = process.env.DASHBOARD_PASSWORD;
  if (!correct || typeof input !== "string") return false;
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(correct).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple in-memory login throttle: 10 attempts per 15 minutes per IP.
const loginAttempts = new Map<string, { count: number; first: number }>();
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > 15 * 60_000) {
    loginAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

export function requireAuth(req: any, res: any, next: any) {
  const status = passwordStatus();
  if (status === "missing-dev") return next();
  if (status === "missing-prod") {
    return res.status(503).json({ message: "Dashboard is locked: set DASHBOARD_PASSWORD in Railway to enable sign-in." });
  }
  if (req.session?.authenticated) return next();
  return res.status(401).json({ message: "Unauthorized" });
}

export function registerAuthRoutes(app: Express) {
  // ── Health check (public, used by Railway) ──────────────────────────────
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // ── Auth routes (public — no middleware) ────────────────────────────────
  app.post("/api/auth/login", (req, res) => {
    const status = passwordStatus();
    if (status === "missing-dev") {
      req.session.authenticated = true;
      return res.json({ ok: true });
    }
    if (status === "missing-prod") {
      return res.status(503).json({ message: "Sign-in is disabled until DASHBOARD_PASSWORD is set in Railway." });
    }
    if (tooManyAttempts(req.ip ?? "unknown")) {
      return res.status(429).json({ message: "Too many attempts. Wait 15 minutes and try again." });
    }
    if (!passwordMatches(req.body?.password)) {
      return res.status(401).json({ message: "Incorrect password" });
    }
    loginAttempts.delete(req.ip ?? "unknown");
    // New session ID on login prevents session fixation.
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ message: "Could not start session" });
      req.session.authenticated = true;
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {});
    res.json({ ok: true });
  });

  app.get("/api/auth/check", (req, res) => {
    const status = passwordStatus();
    if (status === "missing-dev") return res.json({ authenticated: true, passwordRequired: false });
    res.json({
      authenticated: status === "set" && !!req.session?.authenticated,
      passwordRequired: true,
      locked: status === "missing-prod",
    });
  });

}
