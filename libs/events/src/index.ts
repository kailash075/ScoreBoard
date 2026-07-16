// Shared contracts across all services. Single source of truth for the wire format.

export const TOPIC_RAW_EVENTS = process.env.TOPIC_RAW_EVENTS ?? "match-events-raw";

// Redis pub/sub channel a client subscribes to for one match.
export const liveChannel = (matchId: string) => `live:${matchId}`;
// Redis key holding the current scoreboard snapshot for a match.
export const liveStateKey = (matchId: string) => `state:${matchId}`;

// Raw event as emitted by Ingestion (no seq yet — Match Engine assigns it).
export interface RawMatchEvent {
  matchId: string;
  sportId: string;
  type: string;
  period?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  source: string; // provider id or 'manual:{scorerId}'
  ts?: string;    // ISO; Match Engine stamps if absent
}

// Canonical event after Match Engine assigns a monotonic seq.
export interface MatchEvent extends RawMatchEvent {
  seq: number;
  ts: string;
}

// What Realtime Gateway pushes to clients over SSE (a delta).
export interface LiveUpdate {
  matchId: string;
  seq: number;
  type: string;
  period?: Record<string, unknown>;  // echoed so clients can render over.ball
  payload?: Record<string, unknown>; // echoed so clients can color the event
  scoreboard: unknown;               // full current scoreboard (small enough here)
  commentary?: { text: string };
}
