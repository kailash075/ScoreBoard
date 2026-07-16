# ScoreBoard — Data Model & Event Taxonomy

Scope: schema + event taxonomy for first 3 sports (cricket, football, tennis).
Cricket = innings/discrete-ball. Football = continuous clock. Tennis = nested
individual scoring. These three stress the abstraction in different directions.

---

## 1. Design Rules

- **Event log is canonical.** Every scoreboard is a projection (reduce) of events.
- **Sport-agnostic columns are relational.** Sport-specific state is JSONB.
- **Participant, not Team.** Individual sports (tennis) and team sports share one table.
- **Every event carries `seq`** (monotonic per match) for ordered replay + delta push.
- **Nothing mutates a finished match.** Corrections = compensating event, not UPDATE.

---

## 2. Core Relational Schema (sport-agnostic)

```sql
-- Sport registry. Drives plugin selection (reducer, renderer, event types).
CREATE TABLE sport (
    id            TEXT PRIMARY KEY,          -- 'cricket','football','tennis'
    name          TEXT NOT NULL,
    is_team_sport BOOLEAN NOT NULL,
    period_kind   TEXT NOT NULL,             -- 'innings','half','set'
    scoreboard_schema_version INT NOT NULL,  -- validates scoreboard JSONB shape
    config        JSONB NOT NULL             -- rule knobs (overs limit, sets to win)
);

-- Team OR individual. is_team_sport tells you which fields matter.
CREATE TABLE participant (
    id          UUID PRIMARY KEY,
    sport_id    TEXT NOT NULL REFERENCES sport(id),
    kind        TEXT NOT NULL,               -- 'team','individual'
    name        TEXT NOT NULL,
    short_name  TEXT,
    country     TEXT,
    metadata    JSONB DEFAULT '{}'           -- logo, colors, founded, etc.
);

-- Players. For individual sports, a participant maps 1:1 to a player.
CREATE TABLE player (
    id          UUID PRIMARY KEY,
    sport_id    TEXT NOT NULL REFERENCES sport(id),
    name        TEXT NOT NULL,
    dob         DATE,
    country     TEXT,
    metadata    JSONB DEFAULT '{}'           -- role, batting_style, height...
);

-- Roster link (team sports). Individual sports skip or self-link.
CREATE TABLE participant_player (
    participant_id UUID REFERENCES participant(id),
    player_id      UUID REFERENCES player(id),
    shirt_no       INT,
    PRIMARY KEY (participant_id, player_id)
);

CREATE TABLE tournament (
    id          UUID PRIMARY KEY,
    sport_id    TEXT NOT NULL REFERENCES sport(id),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,               -- 'league','cup','bilateral','grand_slam'
    season      TEXT,
    start_date  DATE,
    end_date    DATE,
    metadata    JSONB DEFAULT '{}'
);

CREATE TABLE venue (
    id       UUID PRIMARY KEY,
    name     TEXT NOT NULL,
    city     TEXT,
    country  TEXT,
    metadata JSONB DEFAULT '{}'
);

-- The central entity. Not always 1-vs-1: a golf "match" is a whole tournament,
-- an F1 "match" is a race with a full field. `format` tells reducer + renderer
-- which layout to use.
CREATE TABLE match (
    id            UUID PRIMARY KEY,
    sport_id      TEXT NOT NULL REFERENCES sport(id),
    tournament_id UUID REFERENCES tournament(id),
    venue_id      UUID REFERENCES venue(id),
    format        TEXT NOT NULL,             -- 'versus'|'field'|'bout'
    status        TEXT NOT NULL,             -- scheduled|live|break|finished|abandoned
    scheduled_at  TIMESTAMPTZ NOT NULL,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    -- denormalized live projection, overwritten by Match Engine on each event
    scoreboard    JSONB,                     -- sport-specific shape (section 4)
    result        JSONB,                     -- winner, margin, method
    last_seq      BIGINT DEFAULT 0,          -- highest applied event seq
    feed_status   TEXT DEFAULT 'ok',         -- ok|delayed|lost (provider health)
    metadata      JSONB DEFAULT '{}'
);
CREATE INDEX ON match (sport_id, status, scheduled_at);
CREATE INDEX ON match (status) WHERE status = 'live';

-- Which participants are in a match, and their side/seeding.
-- `side` is a GENERIC slot, semantics per match.format:
--   versus -> 'home'/'away' | 'A'/'B'      (cricket, football, tennis, boxing)
--   field  -> NULL          (F1, golf: no sides)
-- Nullable on purpose: ranked-field sports have no opposing sides.
CREATE TABLE match_participant (
    match_id       UUID REFERENCES match(id),
    participant_id UUID REFERENCES participant(id),
    side           TEXT,                     -- NULL for field sports; see above
    seed_or_pos    INT,                      -- seed (tennis), grid (F1), tee group (golf)
    PRIMARY KEY (match_id, participant_id)
);

-- Canonical append-only event log. Partition by month on ts.
CREATE TABLE match_event (
    match_id   UUID NOT NULL REFERENCES match(id),
    seq        BIGINT NOT NULL,              -- monotonic per match
    ts         TIMESTAMPTZ NOT NULL,
    type       TEXT NOT NULL,                -- sport-specific, see section 3
    period     JSONB NOT NULL,               -- where in match (section 3)
    payload    JSONB NOT NULL,               -- event-specific data
    commentary JSONB,                        -- {auto, editorial, lang map}
    source     TEXT NOT NULL,                -- provider id or 'manual:{scorerId}'
    PRIMARY KEY (match_id, seq)
) PARTITION BY RANGE (ts);
CREATE INDEX ON match_event (match_id, seq);

-- Standings / points table. Generic rows, sport decides column meaning.
CREATE TABLE standing (
    tournament_id  UUID REFERENCES tournament(id),
    group_name     TEXT,                     -- NULL if single table
    participant_id UUID REFERENCES participant(id),
    rank           INT,
    stats          JSONB NOT NULL,           -- {played, won, points, nrr, gd...}
    PRIMARY KEY (tournament_id, participant_id)
);

-- User follows (drives personalized feed + notifications).
CREATE TABLE follow (
    user_id     UUID NOT NULL,
    entity_type TEXT NOT NULL,               -- 'participant','player','tournament','match'
    entity_id   UUID NOT NULL,
    PRIMARY KEY (user_id, entity_type, entity_id)
);
```

**Live vs archive split.** `match.scoreboard` in Postgres = source of truth. Redis
holds `live:{matchId}` = same JSON, sub-ms read, TTL after finish. Finished match
scoreboard immutable → cache forever at CDN.

---

## 3. Event Taxonomy

`match_event.type` + `payload` + `period` shape differ per sport. Reducer keyed by
`sport_id` knows how to fold each type into `scoreboard`.

### 3.1 Cricket

`period` shape:
```json
{ "innings": 1, "over": 14, "ball": 3 }
```

| type | payload | reducer effect |
|---|---|---|
| `innings_start` | `{battingParticipant, bowlingParticipant}` | new innings block, reset over/ball |
| `ball` | `{batsman, bowler, runs, extras:{type,runs}, shot}` | +runs, advance ball, update SR |
| `boundary` | `{batsman, four\|six}` | (specialization of ball) |
| `wicket` | `{batsman, bowler, dismissal, fielder, runs}` | +1 wicket, batsman out |
| `over_complete` | `{over}` | rotate strike, new over |
| `powerplay` | `{phase, on}` | mark field-restriction state |
| `review` | `{team, decision, outcome}` | DRS, may reverse prior wicket |
| `innings_end` | `{reason}` | close block, set target |
| `match_result` | `{winner, margin, method}` | final |

Wicket-after-review = compensating `review` event referencing the reversed `seq`.
Never edit the original `ball`/`wicket` row.

### 3.2 Football

`period` shape:
```json
{ "half": 1, "minute": 47, "stoppage": 2 }
```

| type | payload | reducer effect |
|---|---|---|
| `kickoff` | `{half}` | start clock for half |
| `goal` | `{scorer, assist, side, ownGoal, penalty}` | +1 side score |
| `card` | `{player, side, color}` | yellow/red, red → player count-- |
| `substitution` | `{off, on, side}` | lineup change |
| `penalty_awarded` | `{side, fouler}` | pending spot kick |
| `var_review` | `{incident, outcome}` | may reverse goal/card |
| `corner` / `foul` / `offside` | `{side, ...}` | stats only, no score |
| `half_end` | `{half}` | pause clock |
| `full_time` | `{}` | 90' done |
| `shootout_kick` | `{side, player, scored}` | penalty shootout tally |
| `match_result` | `{winner, method}` | final |

Clock is derived: reducer tracks `kickoff` ts + pauses. Minute in `period` is the
provider's stated minute (authoritative for display).

### 3.3 Tennis

`period` shape (nested scoring — the hard one):
```json
{ "set": 2, "game": 5, "point": 3, "tiebreak": false }
```

| type | payload | reducer effect |
|---|---|---|
| `match_start` | `{playerA, playerB, bestOf, surface}` | init set array |
| `point` | `{winner, serve:{first,ace,doubleFault}, rally}` | advance game score (0/15/30/40/deuce/adv) |
| `game_won` | `{winner}` | +1 game in current set, reset points |
| `break_point` | `{on, converted}` | stat + narrative flag |
| `set_won` | `{winner, gamesA, gamesB, tiebreakScore}` | +1 set, new set block |
| `tiebreak_start` | `{}` | switch point scoring to numeric |
| `retirement` / `walkover` | `{player, reason}` | terminate |
| `match_result` | `{winner, setsScore}` | final |

Tennis reducer is a **state machine**: point → game → set → match, each level rolls
up on win. `point` is the only frequent event; higher events are derivable but
stored explicitly so archive queries don't re-fold every point.

---

## 4. Scoreboard JSONB Shapes

Stored in `match.scoreboard`, mirrored to Redis. Frontend renderer keyed by
`sport_id` reads these.

**Cricket:**
```json
{
  "innings": [
    { "battingSide": "A", "runs": 187, "wickets": 4, "overs": 38.2,
      "runRate": 4.88, "batsmen": [{"id","runs","balls","fours","sixes","sr"}],
      "bowlers": [{"id","overs","maidens","runs","wickets","econ"}] }
  ],
  "target": 245, "requiredRunRate": 6.1, "currentInnings": 2
}
```

**Football:**
```json
{
  "score": { "home": 2, "away": 1 },
  "clock": { "half": 2, "minute": 67, "stoppage": null },
  "scorers": [{"player","side","minute"}],
  "cards": [{"player","side","color","minute"}],
  "stats": { "possession": {"home":58,"away":42}, "shots": {}, "corners": {} }
}
```

**Tennis:**
```json
{
  "sets": [ {"a":6,"b":4}, {"a":3,"b":6}, {"a":5,"b":5} ],
  "currentGame": { "a":"40", "b":"30" },
  "tiebreak": null,
  "serving": "A", "bestOf": 5,
  "stats": { "aces": {"a":12,"b":7}, "firstServePct": {"a":68,"b":61} }
}
```

---

## 5. Delta Push Contract

Client holds `lastSeq`. Reconnect / poll asks `GET /matches/{id}/events?after=N`.
Gateway pushes over SSE:
```json
{ "matchId": "...", "seq": 812, "type": "goal",
  "scoreboardPatch": {"score":{"home":3}}, "commentary": {...} }
```
Client applies patch to local scoreboard, bumps `lastSeq`. Full scoreboard only on
cold start. Event log makes "give me everything after N" trivial and idempotent.

---

## 6. Adding Sport #4 (checklist — proves the abstraction)

1. Insert `sport` row + `config`.
2. Register event types + reducer (fold events → scoreboard JSON).
3. Define scoreboard JSONB shape + schema version.
4. Add frontend renderer `scoreCard.{sport}`.
5. Map a provider adapter (or use manual scorer app) to emit `match_event`.

Zero change to core tables, gateway, or delta contract. If a new sport forces a
core-table change, the abstraction leaked — fix the model, not the table.

Next candidates to validate: F1 (ranked participants, no opponent, lap events) and
boxing (rounds + judge scorecards). These break "two-sided score" — validate on
paper before V2.
