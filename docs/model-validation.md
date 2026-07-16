# ScoreBoard — Event Model Validation (paper stress-test)

Goal: prove the MatchEvent abstraction in `data-model.md` survives sports that
break "two sides, one score" — **before** writing service code. Each sport tested
against every core table + the event/scoreboard/delta contracts. Verdict per table:
✅ fits as-is · ⚠️ bends (nullable/generic, no new table) · ❌ leak (needs core change).

Sports chosen for maximum structural difference:
- **F1** — ranked field, no opponent, time-based, positions shuffle continuously.
- **Boxing** — rounds, no running score, winner by 3 judge cards or KO.
- **Golf** — multi-day, 100+ players, no head-to-head, a "cut" removes players.

---

## 1. Formula 1

Breaks: `home/away`, "match = 2 participants", single winner-vs-loser.

### Table check
| table | verdict | note |
|---|---|---|
| `sport` | ✅ | `is_team_sport=false`, `period_kind='lap'`, config holds `laps`, `pointsSystem` |
| `participant` | ✅ | 20 drivers = 20 individual participants. Constructor (team) = separate participant, linked via metadata |
| `match` | ✅ | one race = one match |
| `match_participant` | ⚠️ | `side` meaningless. Reuse column generically = **grid position** ("1".."20"). No schema change, just semantics per sport |
| `match_event` | ✅ | lap/pit/overtake events |
| `standing` | ✅ | championship table across races = exactly what `standing` is for |

### Events
```json
period: { "lap": 34, "sector": 2 }

type:"race_start"    payload:{grid:[{driver,pos}]}
type:"lap_complete"  payload:{driver, lapTime, position, gap}
type:"pit_stop"      payload:{driver, duration, tyre}
type:"overtake"      payload:{driver, passed, newPos}
type:"penalty"       payload:{driver, seconds, reason}   // time added
type:"dnf"           payload:{driver, reason}
type:"race_result"   payload:{classification:[{driver,pos,points}]}
```

### Scoreboard JSONB
```json
{ "standings":[{"driver":"VER","pos":1,"lap":34,"gap":"LEADER","pits":1},
               {"driver":"HAM","pos":2,"gap":"+4.2s","pits":1}],
  "fastestLap":{"driver":"NOR","time":"1:18.402"},
  "lap":34, "totalLaps":58 }
```
Reducer: fold `lap_complete`/`overtake`/`penalty` → re-sort `standings` by position/time.

### Verdict
**PASS with 1 bend.** `match_participant.side` used as generic slot (grid pos), not
home/away. Confirms `side` must be `TEXT` (already is) and nullable-friendly. No new
core table. Championship points = `standing` table, no change.

---

## 2. Boxing / MMA

Breaks: no running score during play; result = 3 judge scorecards summed, or KO.
Parallel scores (3 judges) per round.

### Table check
| table | verdict | note |
|---|---|---|
| `sport` | ✅ | `period_kind='round'`, config `rounds`, `judgeCount` |
| `participant` | ✅ | 2 boxers, individual |
| `match` | ✅ | one bout = one match |
| `match_participant` | ✅ | 2 sides, "A"/"B" or red/blue corner |
| `match_event` | ✅ | knockdown/round_score/knockout |
| `official` | ⚠️ | 3 judges are officials. `data-model.md` mentioned `Official` but no table yet → **add `match_official`** OR store judges in event payload. Payload chosen (simpler, judges vary per bout) |

### Events
```json
period: { "round": 7 }

type:"bout_start"   payload:{boxerA, boxerB, weightClass, scheduledRounds}
type:"knockdown"    payload:{boxer, byBoxer, count}
type:"round_score"  payload:{round, cards:[{judge:1,a:10,b:9},
                                           {judge:2,a:10,b:9},
                                           {judge:3,a:9,b:10}]}
type:"point_deduct" payload:{boxer, points, reason}
type:"knockout"     payload:{winner, type:"KO|TKO", round, time}
type:"bout_result"  payload:{winner, method:"UD|SD|MD|KO|TKO|Draw",
                             tally:{a:97,b:93}}
```

### Scoreboard JSONB
```json
{ "corner":{"a":"Fury","b":"Usyk"},
  "round":7, "scheduledRounds":12,
  "runningCards":[{judge:1,a:68,b:65},{judge:2,a:67,b:66},{judge:3,a:66,b:67}],
  "knockdowns":{"a":0,"b":1},
  "status":"in_progress" }
```
Reducer: on `round_score`, add each judge's card to `runningCards`. Winner decided
only at `bout_result` (or early `knockout`). Parallel judge scores nest fine in JSONB.

### Verdict
**PASS.** Judge cards = array in payload + scoreboard. No running head-to-head score
needed — model doesn't assume one. Only open item: whether to formalize `match_official`
table later for judge identity/history. Not blocking. No leak.

---

## 3. Golf (stroke play)

Hardest. Breaks the most: not a "match" between 2 — a **field of 100+** over **4 rounds
(days)**, leaderboard by cumulative strokes, a **cut** eliminates ~half after round 2.
No single opponent. "Live" = many players on course simultaneously at different holes.

### Table check
| table | verdict | note |
|---|---|---|
| `sport` | ✅ | `period_kind='round'` (golf round = 18 holes), config `rounds:4, cutAfter:2` |
| `participant` | ✅ | 156 individuals |
| `match` | ⚠️ | a golf **tournament** is the competition, not a "match". One `match` row = whole tournament, its `match_event`s span 4 days. `tournament` table = the event series/season context. Semantics stretch but tables hold |
| `match_participant` | ⚠️ | 156 rows, `side` = NULL or tee-group. Confirms `side` nullable needed |
| `match_event` | ✅ | per-hole score events, high volume, partitioning matters |
| `standing` | ✅/alt | leaderboard IS the scoreboard (live), final = `standing` |

### Events
```json
period: { "round": 2, "hole": 14 }

type:"tournament_start" payload:{field:[{player, teeTime, group}]}
type:"stroke"           payload:{player, hole, strokeNo, club, result}  // fine-grained, optional
type:"hole_complete"    payload:{player, hole, strokes, par, toPar}
type:"round_complete"   payload:{player, round, gross, toPar}
type:"cut"              payload:{line:"+1", madeCut:[...], missedCut:[...]}
type:"withdraw"         payload:{player, reason}
type:"tournament_result"payload:{leaderboard:[{player,pos,toPar,strokes}]}
```

### Scoreboard JSONB
```json
{ "leaderboard":[
    {"player":"Scheffler","pos":1,"toPar":-12,"thru":14,"round":2,"today":-3},
    {"player":"McIlroy","pos":2,"toPar":-10,"thru":18,"round":2,"today":-4}],
  "cutLine":"+1", "round":2, "totalRounds":4 }
```
Reducer: fold `hole_complete` → update that player's `toPar` + `thru`, re-sort
leaderboard. `thru` (holes played) replaces a game clock — players async on course.

### Verdict
**PASS with 2 bends.**
1. `match` = whole multi-day tournament (not a 1v1). Works, but naming is off — a
   `match` here is really a "competition." Rename concept in docs, keep table.
2. `match_participant.side` MUST be nullable (many players, no sides). **Confirmed
   schema change:** `ALTER side DROP NOT NULL` — it was already nullable in intent,
   make explicit.

No new core table. High event volume (156 players × 72 holes) validates the
month-partition on `match_event` and the "store rolled-up `hole_complete`, make
fine-grained `stroke` optional" decision.

---

## 4. Confirmed Schema Changes (roll into data-model.md)

| # | change | driver | severity |
|---|---|---|---|
| 1 | `match_participant.side` explicitly **nullable** | F1, golf | trivial |
| 2 | `side` is a **generic slot** (home/away · grid pos · corner · tee-group), not fixed enum | all 3 | doc/semantics |
| 3 | Add optional `match_participant.seed_or_pos INT` for ranked-field sports | F1, golf | small, additive |
| 4 | Rename concept `match` → allow "competition" reading; add `match.format` (`versus`/`field`/`bout`) so renderer/reducer know layout | golf | small, additive |
| 5 | Defer `match_official` table (judges); store in payload for now | boxing | deferred |

None break existing tables. All additive or nullable. **Abstraction holds.**

---

## 5. Verdict Summary

| sport | breaks | result |
|---|---|---|
| F1 | no opponent, ranked field | ✅ PASS (side = grid pos) |
| Boxing | no running score, judge cards | ✅ PASS (cards in JSONB) |
| Golf | 100+ field, multi-day, cut | ✅ PASS (side nullable, match=competition) |

Event-sourced core + JSONB scoreboard + per-sport reducer survives all three. The
only real generalization learned: **`match` is not always 1-vs-1** — add a `format`
discriminator (`versus`/`field`/`bout`) so reducers and renderers branch cleanly.

Model validated. Safe to scaffold services (b) on this schema + the 5 changes above.
