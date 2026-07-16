// Simulated feeds for the demo. POSTs events to Ingestion so you can watch scores
// move through the whole pipeline. Stands in for real provider adapters.
// Usage: tsx src/demo-feed.ts [cricket|football|tennis]  (default cricket)
import type { RawMatchEvent } from "@scoreboard/events";

const INGEST_URL = process.env.INGEST_URL ?? "http://localhost:4001/ingest";
const MATCH = {
  cricket:  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  football: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  tennis:   "cccccccc-cccc-cccc-cccc-cccccccccccc",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

async function post(ev: RawMatchEvent) {
  const res = await fetch(INGEST_URL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev),
  });
  if (!res.ok) console.error("ingest failed", res.status, await res.text());
}

async function cricket() {
  const id = MATCH.cricket;
  const outcomes = [0, 0, 1, 1, 2, 4, 6, 0, 1, "W"] as const;
  for (let balls = 0; balls < 36; balls++) {
    const over = Math.floor(balls / 6), ball = (balls % 6) + 1;
    const o = pick(outcomes);
    const ev: RawMatchEvent = o === "W"
      ? { matchId: id, sportId: "cricket", type: "wicket", period: { innings: 1, over, ball }, payload: { dismissal: "bowled" }, source: "demo" }
      : { matchId: id, sportId: "cricket", type: "ball", period: { innings: 1, over, ball }, payload: { runs: o }, source: "demo" };
    await post(ev); console.log(`[cricket] ${over}.${ball} -> ${o}`); await sleep(1200);
  }
}

async function football() {
  const id = MATCH.football;
  const scorers = { home: ["Saka", "Ødegaard", "Havertz"], away: ["Palmer", "Jackson"] };
  await post({ matchId: id, sportId: "football", type: "kickoff", period: { half: 1, minute: 0 }, payload: {}, source: "demo" });
  // 12 ticks, each an advancing minute with a chance of goal/card.
  for (let i = 0; i < 12; i++) {
    const minute = 5 + i * 7;
    const roll = Math.random();
    let ev: RawMatchEvent;
    if (roll < 0.35) {
      const side = Math.random() < 0.6 ? "home" : "away";
      ev = { matchId: id, sportId: "football", type: "goal", period: { half: minute > 45 ? 2 : 1, minute }, payload: { side, scorer: pick(scorers[side as "home" | "away"]) }, source: "demo" };
    } else if (roll < 0.5) {
      ev = { matchId: id, sportId: "football", type: "card", period: { half: minute > 45 ? 2 : 1, minute }, payload: { side: pick(["home", "away"]), player: "Defender", color: "yellow" }, source: "demo" };
    } else {
      ev = { matchId: id, sportId: "football", type: "corner", period: { half: minute > 45 ? 2 : 1, minute }, payload: { side: pick(["home", "away"]) }, source: "demo" };
    }
    await post(ev); console.log(`[football] ${minute}' -> ${ev.type} ${(ev.payload as any).side ?? ""}`); await sleep(1400);
  }
}

async function tennis() {
  const id = MATCH.tennis;
  await post({ matchId: id, sportId: "tennis", type: "match_start", period: {}, payload: { bestOf: 3 }, source: "demo" });
  // 40 points, winner weighted so games actually complete.
  for (let i = 0; i < 40; i++) {
    const winner = Math.random() < 0.55 ? "a" : "b";
    await post({ matchId: id, sportId: "tennis", type: "point", period: { set: 1 }, payload: { winner, serve: { first: true } }, source: "demo" });
    console.log(`[tennis] point -> ${winner}`); await sleep(900);
  }
}

async function main() {
  const sport = (process.argv[2] ?? "cricket") as keyof typeof MATCH;
  console.log(`[demo] streaming ${sport} to ${MATCH[sport]}`);
  if (sport === "football") await football();
  else if (sport === "tennis") await tennis();
  else await cricket();
  console.log("[demo] done");
}

main().catch((e) => { console.error(e); process.exit(1); });
