import type { MatchEvent } from "@scoreboard/events";

// A sport plugin is: a pure reducer (event folded into scoreboard) + an initial
// scoreboard + an optional commentary templater. Adding a sport = add one file.
export interface SportPlugin {
  id: string;
  initialScoreboard(): unknown;
  // Pure: (currentScoreboard, event) -> nextScoreboard. No IO.
  reduce(scoreboard: any, event: MatchEvent): unknown;
  // Optional human-ish commentary line for an event.
  commentary?(event: MatchEvent, scoreboard: any): string | undefined;
}
