import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Minimal stateless auth for the manual scorer. HMAC-signed token (JWT-ish):
// base64url(payload) + "." + HMAC-SHA256. No DB — validation is a signature check.
// Prod: replace the static user list with a real user store + rotate SCORER_SECRET.

const SECRET = process.env.SCORER_SECRET ?? "dev-secret-change-me";
const TTL_MS = 8 * 60 * 60 * 1000; // 8h

interface ScorerUser { user: string; pass: string; id: string; }
const USERS: ScorerUser[] = JSON.parse(
  process.env.SCORER_USERS ?? '[{"user":"scorer1","pass":"scorepass","id":"scorer1"}]');

interface TokenPayload { id: string; exp: number; }

function sign(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token: string): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  // timingSafeEqual throws on length mismatch — guard it.
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

export function login(user: string, pass: string): { token: string; scorerId: string } | null {
  const u = USERS.find((x) => x.user === user && x.pass === pass);
  if (!u) return null;
  return { token: sign({ id: u.id, exp: Date.now() + TTL_MS }), scorerId: u.id };
}

// Express middleware: require a valid scorer bearer token; attach scorerId.
export function requireScorer(req: Request & { scorerId?: string }, res: Response, next: NextFunction) {
  const h = req.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  req.scorerId = payload.id;
  next();
}
