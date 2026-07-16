-- ScoreBoard schema (matches docs/data-model.md after validation changes).
-- Idempotent-ish for local dev: drop + recreate.

DROP TABLE IF EXISTS match_event CASCADE;
DROP TABLE IF EXISTS match_participant CASCADE;
DROP TABLE IF EXISTS standing CASCADE;
DROP TABLE IF EXISTS follow CASCADE;
DROP TABLE IF EXISTS match CASCADE;
DROP TABLE IF EXISTS participant_player CASCADE;
DROP TABLE IF EXISTS participant CASCADE;
DROP TABLE IF EXISTS player CASCADE;
DROP TABLE IF EXISTS tournament CASCADE;
DROP TABLE IF EXISTS venue CASCADE;
DROP TABLE IF EXISTS sport CASCADE;

CREATE TABLE sport (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    is_team_sport BOOLEAN NOT NULL,
    period_kind   TEXT NOT NULL,
    scoreboard_schema_version INT NOT NULL DEFAULT 1,
    config        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE participant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sport_id    TEXT NOT NULL REFERENCES sport(id),
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    short_name  TEXT,
    country     TEXT,
    metadata    JSONB DEFAULT '{}'
);

CREATE TABLE player (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sport_id    TEXT NOT NULL REFERENCES sport(id),
    name        TEXT NOT NULL,
    dob         DATE,
    country     TEXT,
    metadata    JSONB DEFAULT '{}'
);

CREATE TABLE participant_player (
    participant_id UUID REFERENCES participant(id),
    player_id      UUID REFERENCES player(id),
    shirt_no       INT,
    PRIMARY KEY (participant_id, player_id)
);

CREATE TABLE tournament (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sport_id    TEXT NOT NULL REFERENCES sport(id),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    season      TEXT,
    start_date  DATE,
    end_date    DATE,
    metadata    JSONB DEFAULT '{}'
);

CREATE TABLE venue (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name     TEXT NOT NULL,
    city     TEXT,
    country  TEXT,
    metadata JSONB DEFAULT '{}'
);

CREATE TABLE match (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sport_id      TEXT NOT NULL REFERENCES sport(id),
    tournament_id UUID REFERENCES tournament(id),
    venue_id      UUID REFERENCES venue(id),
    format        TEXT NOT NULL DEFAULT 'versus',   -- versus|field|bout
    status        TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    scoreboard    JSONB,
    result        JSONB,
    last_seq      BIGINT NOT NULL DEFAULT 0,
    feed_status   TEXT NOT NULL DEFAULT 'ok',
    metadata      JSONB DEFAULT '{}'
);
CREATE INDEX idx_match_list ON match (sport_id, status, scheduled_at);
CREATE INDEX idx_match_live ON match (status) WHERE status = 'live';

CREATE TABLE match_participant (
    match_id       UUID REFERENCES match(id),
    participant_id UUID REFERENCES participant(id),
    side           TEXT,          -- NULL for field sports
    seed_or_pos    INT,
    PRIMARY KEY (match_id, participant_id)
);

-- Not partitioned here for scaffold simplicity; PARTITION BY RANGE(ts) in prod.
CREATE TABLE match_event (
    match_id   UUID NOT NULL REFERENCES match(id),
    seq        BIGINT NOT NULL,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    type       TEXT NOT NULL,
    period     JSONB NOT NULL DEFAULT '{}',
    payload    JSONB NOT NULL DEFAULT '{}',
    commentary JSONB,
    source     TEXT NOT NULL DEFAULT 'unknown',
    PRIMARY KEY (match_id, seq)
);

CREATE TABLE standing (
    tournament_id  UUID REFERENCES tournament(id),
    group_name     TEXT,
    participant_id UUID REFERENCES participant(id),
    rank           INT,
    stats          JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (tournament_id, participant_id)
);

CREATE TABLE follow (
    user_id     UUID NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   UUID NOT NULL,
    PRIMARY KEY (user_id, entity_type, entity_id)
);

-- ── Seed: one cricket match for the demo vertical slice ──────────────────
INSERT INTO sport (id, name, is_team_sport, period_kind, config) VALUES
  ('cricket',  'Cricket',  true, 'innings', '{"format":"T20","oversPerInnings":20}'),
  ('football', 'Football', true, 'half',    '{"halves":2,"minutesPerHalf":45}'),
  ('tennis',   'Tennis',   false,'set',     '{"bestOf":3}');

INSERT INTO participant (id, sport_id, kind, name, short_name, country) VALUES
  -- cricket
  ('11111111-1111-1111-1111-111111111111','cricket','team','India','IND','India'),
  ('22222222-2222-2222-2222-222222222222','cricket','team','Australia','AUS','Australia'),
  -- football
  ('33333333-3333-3333-3333-333333333333','football','team','Arsenal','ARS','England'),
  ('44444444-4444-4444-4444-444444444444','football','team','Chelsea','CHE','England'),
  -- tennis (individuals)
  ('55555555-5555-5555-5555-555555555555','tennis','individual','Alcaraz','ALC','Spain'),
  ('66666666-6666-6666-6666-666666666666','tennis','individual','Sinner','SIN','Italy');

INSERT INTO match (id, sport_id, format, status, scoreboard) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cricket','versus','live',
   '{"currentInnings":1,"innings":[{"battingSide":"A","runs":0,"wickets":0,"balls":0,"overs":0.0,"runRate":0}]}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','football','versus','live',
   '{"score":{"home":0,"away":0},"clock":{"half":1,"minute":0},"scorers":[],"cards":[]}'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','tennis','versus','live',
   '{"sets":[{"a":0,"b":0}],"currentGame":{"a":"0","b":"0"},"serving":"A","bestOf":3}');

INSERT INTO match_participant (match_id, participant_id, side) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','A'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222','B'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','33333333-3333-3333-3333-333333333333','A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','44444444-4444-4444-4444-444444444444','B'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','55555555-5555-5555-5555-555555555555','A'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','66666666-6666-6666-6666-666666666666','B');
