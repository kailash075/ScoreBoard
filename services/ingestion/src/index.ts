import express from "express";
import { TOPIC_RAW_EVENTS, type RawMatchEvent } from "@scoreboard/events";
import { getProducer } from "./kafka.js";
import { login, requireScorer } from "./auth.js";

// Ingestion: the ONLY entry point for raw events into the system.
//   POST /ingest         — machine adapters (Sportradar/Opta/demo). Trusts `source`.
//                          MUST be network-restricted in prod (not public).
//   POST /ingest/manual  — human scorer. Requires a scorer JWT; `source` is stamped
//                          server-side from the token so a scorer can't spoof identity.
// Both normalize to RawMatchEvent and publish to Kafka keyed by matchId (ordering).

const app = express();
app.use(express.json());

// Dev CORS so the scorer page (localhost:4000) can call this from the browser.
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "authorization,content-type");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

app.get("/health", (_req, res) => res.json({ ok: true, service: "ingestion" }));

async function publish(event: RawMatchEvent) {
  const producer = await getProducer();
  await producer.send({
    topic: TOPIC_RAW_EVENTS,
    messages: [{ key: event.matchId, value: JSON.stringify(event) }],
  });
}

function buildEvent(b: any, source: string): RawMatchEvent | null {
  if (!b?.matchId || !b?.sportId || !b?.type) return null;
  return {
    matchId: b.matchId, sportId: b.sportId, type: b.type,
    period: b.period ?? {}, payload: b.payload ?? {},
    source, ts: b.ts ?? new Date().toISOString(),
  };
}

// ── Auth: issue a scorer token ──────────────────────────────────────────
app.post("/auth/login", (req, res) => {
  const { user, pass } = req.body ?? {};
  const result = login(user, pass);
  if (!result) return res.status(401).json({ error: "invalid credentials" });
  res.json(result);
});

// ── Machine adapters (trusted source) ───────────────────────────────────
app.post("/ingest", async (req, res) => {
  const event = buildEvent(req.body, req.body?.source ?? "http");
  if (!event) return res.status(400).json({ error: "matchId, sportId, type required" });
  await publish(event);
  res.status(202).json({ accepted: true });
});

// ── Human scorer (authenticated; source stamped from token) ─────────────
app.post("/ingest/manual", requireScorer, async (req: express.Request & { scorerId?: string }, res) => {
  const event = buildEvent(req.body, `manual:${req.scorerId}`); // ignore any client-sent source
  if (!event) return res.status(400).json({ error: "matchId, sportId, type required" });
  await publish(event);
  res.status(202).json({ accepted: true, source: event.source });
});

const port = Number(process.env.INGESTION_PORT ?? 4001);
app.listen(port, () => console.log(`[ingestion] listening on :${port}`));
