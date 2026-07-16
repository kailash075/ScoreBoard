import type { MatchEvent } from "@scoreboard/events";
import type { SportPlugin } from "./types.js";

// Cricket scoreboard shape (subset of docs/data-model.md section 4).
interface Innings {
  battingSide: string;
  runs: number;
  wickets: number;
  balls: number;   // legal balls bowled
  overs: number;   // derived: floor(balls/6) + (balls%6)/10
  runRate: number;
}
interface CricketBoard {
  currentInnings: number;      // 1-based
  innings: Innings[];
  target?: number;
}

const oversFromBalls = (balls: number) =>
  Math.floor(balls / 6) + (balls % 6) / 10;

function cur(board: CricketBoard): Innings {
  return board.innings[board.currentInnings - 1];
}

export const cricket: SportPlugin = {
  id: "cricket",

  initialScoreboard(): CricketBoard {
    return {
      currentInnings: 1,
      innings: [{ battingSide: "A", runs: 0, wickets: 0, balls: 0, overs: 0, runRate: 0 }],
    };
  },

  reduce(board: CricketBoard, ev: MatchEvent): CricketBoard {
    const p = (ev.payload ?? {}) as any;
    switch (ev.type) {
      case "innings_start": {
        board.innings.push({
          battingSide: p.battingSide ?? "B",
          runs: 0, wickets: 0, balls: 0, overs: 0, runRate: 0,
        });
        board.currentInnings = board.innings.length;
        // First innings total becomes the chase target.
        if (board.currentInnings === 2) board.target = board.innings[0].runs + 1;
        return board;
      }
      case "ball":
      case "boundary": {
        const inn = cur(board);
        const runs = Number(p.runs ?? 0);
        const extras = Number(p.extras?.runs ?? 0);
        const isLegal = !["wide", "noball"].includes(p.extras?.type);
        inn.runs += runs + extras;
        if (isLegal) inn.balls += 1;
        inn.overs = oversFromBalls(inn.balls);
        inn.runRate = inn.balls ? +(inn.runs / (inn.balls / 6)).toFixed(2) : 0;
        return board;
      }
      case "wicket": {
        const inn = cur(board);
        inn.wickets += 1;
        inn.balls += 1;
        inn.overs = oversFromBalls(inn.balls);
        return board;
      }
      case "innings_end": {
        if (board.currentInnings === 1) board.target = cur(board).runs + 1;
        return board;
      }
      case "snapshot": {
        // Aggregate-score provider (e.g. cricketdata.org free tier): overwrite the
        // whole innings state from the provider's score, not ball-by-ball. Idempotent.
        const inns = (p.innings ?? []) as any[];
        if (inns.length) {
          board.innings = inns.map((x) => {
            const overs = Number(x.overs ?? 0);
            const balls = Math.floor(overs) * 6 + Math.round((overs - Math.floor(overs)) * 10);
            return {
              battingSide: x.battingSide ?? "A",
              runs: Number(x.runs ?? 0), wickets: Number(x.wickets ?? 0),
              balls, overs, runRate: balls ? +(Number(x.runs ?? 0) / (balls / 6)).toFixed(2) : 0,
            };
          });
          board.currentInnings = board.innings.length;
          if (board.innings.length === 2) board.target = board.innings[0].runs + 1;
        }
        return board;
      }
      default:
        return board; // over_complete, powerplay, review — no score change here
    }
  },

  commentary(ev: MatchEvent, board: CricketBoard): string | undefined {
    const p = (ev.payload ?? {}) as any;
    const inn = cur(board);
    if (ev.type === "wicket") return `WICKET! ${inn.wickets} down for ${inn.runs}.`;
    if (ev.type === "boundary" || (ev.type === "ball" && p.runs === 4)) return `FOUR! ${inn.runs}/${inn.wickets}.`;
    if (ev.type === "ball" && p.runs === 6) return `SIX! ${inn.runs}/${inn.wickets}.`;
    if (ev.type === "ball") return `${p.runs ?? 0} run(s). ${inn.runs}/${inn.wickets} (${inn.overs}).`;
    return undefined;
  },
};
