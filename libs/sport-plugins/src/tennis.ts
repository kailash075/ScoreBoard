import type { MatchEvent } from "@scoreboard/events";
import type { SportPlugin } from "./types.js";

// Nested scoring state machine: point -> game -> set. Only `point` is frequent;
// game_won/set_won roll up. Points ladder: 0,15,30,40,AD.
const LADDER = ["0", "15", "30", "40"];

interface TennisBoard {
  sets: { a: number; b: number }[];
  currentGame: { a: string; b: string };
  serving: "A" | "B";
  bestOf: number;
}

function addPoint(board: TennisBoard, w: "a" | "b") {
  const g = board.currentGame;
  const o = w === "a" ? "b" : "a";
  if (g[w] === "40" && g[o] === "40") { g[w] = "AD"; return; }
  if (g[o] === "AD") { g[o] = "40"; return; }          // deuce back
  if (g[w] === "AD") { winGame(board, w); return; }     // game
  if (g[w] === "40") { winGame(board, w); return; }     // game
  g[w] = LADDER[LADDER.indexOf(g[w]) + 1];
}

function winGame(board: TennisBoard, w: "a" | "b") {
  board.sets[board.sets.length - 1][w] += 1;
  board.currentGame = { a: "0", b: "0" };
}

export const tennis: SportPlugin = {
  id: "tennis",

  initialScoreboard(): TennisBoard {
    return { sets: [{ a: 0, b: 0 }], currentGame: { a: "0", b: "0" }, serving: "A", bestOf: 3 };
  },

  reduce(board: TennisBoard, ev: MatchEvent): TennisBoard {
    const p = (ev.payload ?? {}) as any;
    switch (ev.type) {
      case "point":
        addPoint(board, (p.winner ?? "a").toLowerCase() === "b" ? "b" : "a");
        return board;
      case "set_won":
        board.sets.push({ a: 0, b: 0 });
        board.currentGame = { a: "0", b: "0" };
        return board;
      default:
        return board;
    }
  },

  commentary(ev: MatchEvent, board: TennisBoard): string | undefined {
    const set = board.sets[board.sets.length - 1];
    if (ev.type === "point") {
      const g = board.currentGame;
      if (g.a === "0" && g.b === "0") return `Game won. Set ${set.a}-${set.b}.`;
      return `Point. Game ${g.a}-${g.b} · Set ${set.a}-${set.b}.`;
    }
    if (ev.type === "set_won") return `Set complete.`;
    return undefined;
  },
};
