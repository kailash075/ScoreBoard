import express from "express";
import { Redis } from "ioredis";
import { liveChannel, liveStateKey, type LiveUpdate } from "@scoreboard/events";

// Realtime Gateway: stateless SSE fan-out. Client opens GET /matches/:id/stream,
// gateway subscribes to that match's Redis channel and forwards every delta.
// Horizontally scalable — hold no state, any instance serves any client.
// Cold start: send the current Redis snapshot immediately, then live deltas.

const app = express();
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const snapshotClient = new Redis(redisUrl); // normal client for GET

// Dev CORS so the browser EventSource can connect cross-origin.
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "realtime-gateway" }));

app.get("/matches/:id/stream", async (req, res) => {
  const matchId = req.params.id;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // 1. Cold-start snapshot.
  const snap = await snapshotClient.get(liveStateKey(matchId));
  if (snap) res.write(`event: snapshot\ndata: ${snap}\n\n`);

  // 2. Live deltas — dedicated subscriber connection per client (Redis sub mode).
  const sub = new Redis(redisUrl);
  await sub.subscribe(liveChannel(matchId));
  sub.on("message", (_ch, payload) => {
    res.write(`event: update\ndata: ${payload}\n\n`);
  });

  // Heartbeat keeps proxies from killing idle connection.
  const hb = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(hb);
    sub.disconnect();
    res.end();
  });
});

const port = Number(process.env.REALTIME_PORT ?? 4003);
app.listen(port, () => console.log(`[realtime-gateway] listening on :${port}`));

export type { LiveUpdate }; // re-export for consumers
