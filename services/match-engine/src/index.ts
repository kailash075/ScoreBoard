import crypto from "node:crypto";
import { Kafka } from "kafkajs";
import { Pool } from "pg";
import { Redis } from "ioredis";
import {
  TOPIC_RAW_EVENTS, liveChannel, liveStateKey,
  type RawMatchEvent, type MatchEvent, type LiveUpdate,
} from "@scoreboard/events";
import { getPlugin } from "@scoreboard/sport-plugins";

// Deterministic UUID from a natural key so re-registering a match/participant is
// idempotent across provider polls (no duplicate rows). Valid uuid layout for PG.
function detUuid(key: string): string {
  const h = crypto.createHash("sha1").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Metadata event, NOT part of the scoring timeline: upsert match + participants.
// No seq, no match_event row, no scoreboard publish. Keeps the first real event at seq 1.
async function upsertMatch(raw: RawMatchEvent) {
  const p = (raw.payload ?? {}) as any;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plugin = getPlugin(raw.sportId);
    await client.query(
      `INSERT INTO match (id, sport_id, format, status, scoreboard)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [raw.matchId, raw.sportId, p.format ?? "versus", p.status ?? "live", plugin.initialScoreboard()]);
    for (const part of (p.participants ?? []) as any[]) {
      const pid = detUuid(`${raw.sportId}:${part.shortname ?? part.name}`);
      await client.query(
        `INSERT INTO participant (id, sport_id, kind, name, short_name)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [pid, raw.sportId, p.kind ?? "team", part.name, part.shortname ?? null]);
      await client.query(
        `INSERT INTO match_participant (match_id, participant_id, side)
         VALUES ($1,$2,$3) ON CONFLICT (match_id, participant_id) DO NOTHING`,
        [raw.matchId, pid, part.side ?? null]);
    }
    await client.query("COMMIT");
    console.log(`[engine] match_upsert ${raw.matchId} (${(p.participants ?? []).map((x: any) => x.shortname ?? x.name).join(" v ")})`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[engine] upsertMatch error", e);
  } finally {
    client.release();
  }
}

// Match Engine: the stateful core. Single ordered consumer per match (Kafka key =
// matchId => same partition => ordered). For each raw event it:
//   1. assigns the next monotonic seq (from match.last_seq)
//   2. runs the sport reducer  scoreboard' = reduce(scoreboard, event)
//   3. persists event + new scoreboard to Postgres (canonical)
//   4. writes scoreboard snapshot to Redis (fast read)
//   5. publishes a delta on Redis pub/sub (Realtime Gateway fans it out)

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://scoreboard:scoreboard@localhost:5432/scoreboard" });
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const kafka = new Kafka({ clientId: "match-engine", brokers: (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",") });

async function handle(raw: RawMatchEvent) {
  // Metadata events bypass the scoring log entirely.
  if (raw.type === "match_upsert") { await upsertMatch(raw); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the match row so seq assignment is race-free.
    const { rows } = await client.query(
      "SELECT scoreboard, last_seq FROM match WHERE id = $1 FOR UPDATE", [raw.matchId]);
    if (rows.length === 0) { await client.query("ROLLBACK"); console.warn(`[engine] unknown match ${raw.matchId}`); return; }

    const plugin = getPlugin(raw.sportId);
    const seq = Number(rows[0].last_seq) + 1;
    const isVoid = raw.type === "void" || raw.type === "undo_last";

    let board: unknown;
    let commentaryText: string | undefined;
    let payload = raw.payload ?? {};

    if (isVoid) {
      // Compensating event: never mutate/delete the target row. Append a void
      // event referencing the cancelled seq, then rebuild the scoreboard by
      // replaying every non-voided, non-void event from a FRESH initial board.
      const { rows: evs } = await client.query(
        "SELECT seq, type, period, payload FROM match_event WHERE match_id = $1 ORDER BY seq ASC",
        [raw.matchId]);
      const isVoidRow = (t: string) => t === "void" || t === "undo_last";
      const voided = new Set<number>(
        evs.filter((e: any) => isVoidRow(e.type)).map((e: any) => e.payload?.voidSeq).filter((x: any) => x != null));

      let target: number | undefined = raw.payload?.voidSeq as number | undefined;
      if (raw.type === "undo_last") {
        for (let i = evs.length - 1; i >= 0; i--) {
          const e = evs[i];
          if (isVoidRow(e.type) || voided.has(Number(e.seq))) continue;
          target = Number(e.seq); break;
        }
      }
      if (target == null) { await client.query("ROLLBACK"); console.warn(`[engine] nothing to undo for ${raw.matchId}`); return; }

      voided.add(target);
      payload = { ...(raw.payload ?? {}), voidSeq: target };
      commentaryText = `Correction — event #${target} voided.`;

      board = plugin.initialScoreboard(); // fresh: reducers mutate in place
      for (const e of evs) {
        if (isVoidRow(e.type) || voided.has(Number(e.seq))) continue;
        board = plugin.reduce(board, { matchId: raw.matchId, sportId: raw.sportId, seq: Number(e.seq), ts: "", type: e.type, period: e.period, payload: e.payload, source: "" });
      }
    } else {
      const event: MatchEvent = { ...raw, seq, ts: raw.ts ?? new Date().toISOString() };
      board = rows[0].scoreboard ?? plugin.initialScoreboard();
      board = plugin.reduce(board, event);
      commentaryText = plugin.commentary?.(event, board);
    }

    await client.query(
      `INSERT INTO match_event (match_id, seq, ts, type, period, payload, commentary, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [raw.matchId, seq, raw.ts ?? new Date().toISOString(), raw.type, raw.period ?? {}, payload,
       commentaryText ? { text: commentaryText } : null, raw.source]);

    await client.query(
      "UPDATE match SET scoreboard = $1, last_seq = $2 WHERE id = $3",
      [board, seq, raw.matchId]);

    await client.query("COMMIT");

    // Redis snapshot + pub/sub delta (after commit = never publish uncommitted state).
    const update: LiveUpdate = {
      matchId: raw.matchId, seq, type: raw.type,
      period: raw.period, payload, scoreboard: board,
      commentary: commentaryText ? { text: commentaryText } : undefined,
    };
    await redis.set(liveStateKey(raw.matchId), JSON.stringify(board));
    await redis.publish(liveChannel(raw.matchId), JSON.stringify(update));
    console.log(`[engine] ${raw.matchId} seq=${seq} ${raw.type}${commentaryText ? " :: " + commentaryText : ""}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[engine] handle error", e);
  } finally {
    client.release();
  }
}

async function main() {
  const consumer = kafka.consumer({ groupId: "match-engine" });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_RAW_EVENTS, fromBeginning: false });
  console.log("[engine] consuming", TOPIC_RAW_EVENTS);
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      await handle(JSON.parse(message.value.toString()) as RawMatchEvent);
    },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
