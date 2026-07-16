# ScoreBoard

Multi-sport live score platform (Cricbuzz/Cricinfo style, but sport-agnostic).
Event-sourced core + per-sport plugins. Any sport = a stream of `MatchEvent`s
reduced into a scoreboard by a sport-specific reducer.

## Design docs
- `docs/data-model.md` — schema + event taxonomy (cricket, football, tennis)
- `docs/model-validation.md` — abstraction stress-tested vs F1, boxing, golf

## Architecture (this scaffold)

```
 provider adapter / manual scorer
              │  POST /ingest
              ▼
        ┌───────────┐   Kafka (key=matchId,     ┌──────────────┐
        │ ingestion │──ordered per match)──────▶│ match-engine │
        └───────────┘   topic: match-events-raw └──────┬───────┘
                                                        │ assign seq
                                                        │ reduce(board, event)
                                          ┌─────────────┼───────────────┐
                                          ▼             ▼               ▼
                                     Postgres        Redis         Redis pub/sub
                                   (event log +    (snapshot)      live:{matchId}
                                    scoreboard)                         │
                                          ▲                             ▼
                                    ┌─────────────┐            ┌──────────────────┐
                                    │ api-gateway │            │ realtime-gateway │
                                    │  REST reads │            │  SSE fan-out     │
                                    └─────────────┘            └──────────────────┘
```

| Service | Port | Job |
|---|---|---|
| ingestion | 4001 | normalize provider/manual feed → Kafka. No score logic |
| match-engine | — | consume Kafka, assign seq, run reducer, write PG+Redis, publish delta |
| realtime-gateway | 4003 | SSE fan-out from Redis pub/sub (stateless, scale horizontally) |
| api-gateway | 4004 | REST reads: sports, matches, scoreboard, event timeline |

Shared libs: `@scoreboard/events` (wire contracts), `@scoreboard/sport-plugins`
(reducer registry — cricket, football, tennis).

## Run it

```bash
npm install
npm run infra:up          # Redpanda + Postgres + Redis (docker)
npm run db:migrate        # schema + seed one live cricket match

# 4 terminals (or background):
npm run match-engine
npm run ingestion
npm run realtime-gateway
npm run api-gateway

# watch a live stream:
curl -N http://localhost:4003/matches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/stream

# in another terminal, push a simulated cricket innings:
npm run demo

# read side:
curl http://localhost:4004/matches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
curl "http://localhost:4004/matches/<id>/events?after=0"
```

## Live cricket from cricketdata.org (real provider)

`services/cricket-adapter` polls the cricketdata.org (cricapi v1) `currentMatches`
endpoint. The **free tier returns aggregate score snapshots** (`r/w/o` per innings),
not ball-by-ball — so the adapter:
1. emits a `match_upsert` event (metadata: registers the match + teams, idempotent),
2. emits a `snapshot` event when the score changes (the cricket reducer overwrites
   the innings state from it).

Both flow through the same ingestion → Kafka → engine pipeline. `snapshot` proves the
event model spans *both* ball-granularity and snapshot-granularity feeds.

```bash
# offline (no key needed) — replays a canned response, fast poll:
npm run adapter:cricket:mock

# live — get a free key at https://cricketdata.org, then:
CRICAPI_KEY=xxxx npm run adapter:cricket
```

Notes:
- Free quota ~100 hits/day. Default `POLL_MS=900000` (15 min) stays under it; one poll
  covers all live matches. Adapter logs `hitsToday/hitsLimit` each poll.
- Adapter dedups: a `snapshot` is only emitted when the score actually changes.
- All provider field access is isolated in `normalize()` — fix there if the live shape
  differs from the coded cricapi-v1 mapping.

## Add a new sport

1. `libs/sport-plugins/src/<sport>.ts` — export a `SportPlugin` (initialScoreboard + reduce).
2. Register it in `libs/sport-plugins/src/index.ts`.
3. Insert a `sport` row (init.sql / migration).
No changes to any service. Ingestion, engine, gateways are sport-blind.

## Not in scaffold (next)
Notifications, search indexer, GraphQL, CDN edge cache, `match_event` range
partitioning, more provider adapters (football/tennis), schema-registry on Kafka,
k8s deploy. (Done: manual scorer + auth, cricketdata.org cricket adapter.)
