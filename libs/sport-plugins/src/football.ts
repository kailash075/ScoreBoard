import type { MatchEvent } from "@scoreboard/events";
import type { SportPlugin } from "./types.js";

interface FootballBoard {
  score: { home: number; away: number };
  clock: { half: number; minute: number };
  scorers: { player: string; side: string; minute: number }[];
  cards: { player: string; side: string; color: string; minute: number }[];
}

const sideKey = (s: string) => (s === "home" || s === "A" ? "home" : "away");

export const football: SportPlugin = {
  id: "football",

  initialScoreboard(): FootballBoard {
    return { score: { home: 0, away: 0 }, clock: { half: 1, minute: 0 }, scorers: [], cards: [] };
  },

  reduce(board: FootballBoard, ev: MatchEvent): FootballBoard {
    const p = (ev.payload ?? {}) as any;
    const period = (ev.period ?? {}) as any;
    if (period.minute != null) board.clock.minute = Number(period.minute);
    if (period.half != null) board.clock.half = Number(period.half);

    switch (ev.type) {
      case "goal": {
        const k = p.ownGoal ? (sideKey(p.side) === "home" ? "away" : "home") : sideKey(p.side);
        board.score[k] += 1;
        board.scorers.push({ player: p.scorer ?? "?", side: k, minute: board.clock.minute });
        return board;
      }
      case "card": {
        board.cards.push({ player: p.player ?? "?", side: sideKey(p.side), color: p.color ?? "yellow", minute: board.clock.minute });
        return board;
      }
      default:
        return board;
    }
  },

  commentary(ev: MatchEvent, board: FootballBoard): string | undefined {
    const p = (ev.payload ?? {}) as any;
    if (ev.type === "goal") return `GOAL! ${board.score.home}-${board.score.away} (${p.scorer ?? "?"}).`;
    if (ev.type === "card") return `${(p.color ?? "yellow").toUpperCase()} card for ${p.player ?? "?"}.`;
    return undefined;
  },
};
