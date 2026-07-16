import express from "express";
import { Pool } from "pg";

// API Gateway: read side (REST). Serves match lists, a single match + scoreboard,
// and the event timeline (commentary). Read-heavy => cache hard in prod (finished
// matches immutable => cache forever; live => short TTL). Here: plain Postgres reads.

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://scoreboard:scoreboard@localhost:5432/scoreboard" });

// Dev CORS: let the web page (localhost:4000) call this API from the browser.
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "api-gateway" }));

app.get("/sports", async (_req, res) => {
  const { rows } = await pool.query("SELECT id, name, is_team_sport, period_kind FROM sport ORDER BY name");
  res.json(rows);
});

// GET /matches?status=live&sport=cricket
app.get("/matches", async (req, res) => {
  const { status, sport } = req.query as { status?: string; sport?: string };
  const conds: string[] = [];
  const args: unknown[] = [];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (sport)  { args.push(sport);  conds.push(`sport_id = $${args.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, sport_id, format, status, scheduled_at, scoreboard
     FROM match ${where} ORDER BY scheduled_at DESC LIMIT 100`, args);
  res.json(rows);
});

// GET /matches/:id  -> metadata + current scoreboard
app.get("/matches/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.sport_id, m.format, m.status, m.scoreboard, m.result, m.last_seq,
            COALESCE(json_agg(json_build_object('participantId', mp.participant_id,
              'side', mp.side, 'name', p.name)) FILTER (WHERE mp.participant_id IS NOT NULL), '[]') AS participants
     FROM match m
     LEFT JOIN match_participant mp ON mp.match_id = m.id
     LEFT JOIN participant p ON p.id = mp.participant_id
     WHERE m.id = $1
     GROUP BY m.id`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// GET /matches/:id/events?after=seq  -> timeline / commentary (delta-friendly)
app.get("/matches/:id/events", async (req, res) => {
  const after = Number(req.query.after ?? 0);
  const { rows } = await pool.query(
    `SELECT seq, ts, type, period, payload, commentary, source
     FROM match_event WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 500`,
    [req.params.id, after]);
  res.json(rows);
});

const port = Number(process.env.API_PORT ?? 4004);
app.listen(port, () => console.log(`[api-gateway] listening on :${port}`));
