import { readFileSync } from "node:fs";
import type { RawMatchEvent } from "@scoreboard/events";

// Provider adapter for cricketdata.org (cricapi v1). The free tier returns aggregate
// score SNAPSHOTS (r/w/o per innings), not ball-by-ball — so we register the match
// (match_upsert) and emit `snapshot` events, which the cricket reducer overwrites.
//
// Env:
//   CRICAPI_KEY   your key from https://cricketdata.org (required unless MOCK_FILE)
//   CRICAPI_BASE  default https://api.cricapi.com/v1
//   POLL_MS       default 900000 (15 min → ~96/day, under the free 100/day cap)
//   INGEST_URL    default http://localhost:4001/ingest
//   MOCK_FILE     path to a canned currentMatches JSON (offline testing, no key/quota)

const KEY = process.env.CRICAPI_KEY ?? "";
const BASE = process.env.CRICAPI_BASE ?? "https://api.cricapi.com/v1";
const POLL_MS = Number(process.env.POLL_MS ?? 900_000);
const INGEST = process.env.INGEST_URL ?? "http://localhost:4001/ingest";
const MOCK_FILE = process.env.MOCK_FILE;

const lastSig = new Map<string, string>(); // matchId -> last score signature (dedup)

async function post(event: Omit<RawMatchEvent, "source">) {
  const r = await fetch(INGEST, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...event, source: "provider:cricketdata" }),
  });
  if (!r.ok) console.error("[cricket-adapter] ingest failed", r.status, await r.text());
}

// Fetch (or load) one currentMatches response. Returns { data, info }.
async function fetchCurrentMatches(): Promise<{ data: any[]; info?: any }> {
  if (MOCK_FILE) return JSON.parse(readFileSync(MOCK_FILE, "utf8"));
  const url = `${BASE}/currentMatches?apikey=${KEY}&offset=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`currentMatches ${res.status}`);
  const body = (await res.json()) as { data: any[]; info?: any; status?: string };
  if (body.status && body.status !== "success") throw new Error(`api status: ${body.status}`);
  return body;
}

// ── The ONE place provider fields are read. Fix here if the live shape differs. ──
function normalize(m: any) {
  const teams: string[] = m.teams ?? [];
  const info: any[] = m.teamInfo ?? [];
  const shortOf = (name: string) =>
    info.find((t) => t?.name === name)?.shortname ?? name?.slice(0, 3)?.toUpperCase() ?? name;
  const sideOf = (name: string) => (name === teams[0] ? "A" : "B");

  const participants = teams.map((name) => ({ name, shortname: shortOf(name), side: sideOf(name) }));

  // score: [{ r, w, o, inning: "India Inning 1" }]
  const innings = (m.score ?? []).map((s: any) => {
    const teamName = teams.find((t) => typeof s.inning === "string" && s.inning.startsWith(t)) ?? teams[0];
    return { battingSide: sideOf(teamName), runs: s.r ?? 0, wickets: s.w ?? 0, overs: s.o ?? 0 };
  });

  return {
    id: m.id as string,
    status: m.status as string,
    started: !!m.matchStarted,
    ended: !!m.matchEnded,
    participants,
    innings,
    sig: JSON.stringify(m.score ?? []) + "|" + m.status, // dedup signature
  };
}

async function pollOnce() {
  const { data, info } = await fetchCurrentMatches();
  if (info) console.log(`[cricket-adapter] poll: ${data.length} matches · hits ${info.hitsToday ?? "?"}/${info.hitsLimit ?? "?"} today`);

  for (const m of data) {
    const n = normalize(m);
    if (!n.started) continue; // not begun — nothing to score yet

    // Register/refresh the match (idempotent; engine dedups by deterministic ids).
    await post({ matchId: n.id, sportId: "cricket", type: "match_upsert",
      payload: { status: n.ended ? "finished" : "live", format: "versus", participants: n.participants } });

    // Emit a snapshot only when the score actually changed since last poll.
    if (n.innings.length && lastSig.get(n.id) !== n.sig) {
      lastSig.set(n.id, n.sig);
      await post({ matchId: n.id, sportId: "cricket", type: "snapshot", payload: { innings: n.innings } });
      const last = n.innings[n.innings.length - 1];
      console.log(`[cricket-adapter] snapshot ${n.id}: ${last.runs}/${last.wickets} (${last.overs})`);
    }
  }
}

async function main() {
  if (!KEY && !MOCK_FILE) { console.error("Set CRICAPI_KEY (or MOCK_FILE for offline test)."); process.exit(1); }
  console.log(`[cricket-adapter] source=${MOCK_FILE ? "mock:" + MOCK_FILE : BASE} poll=${POLL_MS}ms`);
  const loop = async () => { try { await pollOnce(); } catch (e) { console.error("[cricket-adapter] poll error", e); } };
  await loop();
  setInterval(loop, POLL_MS);
}

main();
