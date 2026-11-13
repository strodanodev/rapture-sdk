/**
 * The practice bot: iterative-deepening negamax with alpha-beta over any BoardGame, scoring leaves with the game's own
 * `view.evaluate` (0 when it has none), inside a time budget. Deterministic for a position and a budget order (no
 * randomness). It is a starting point: a game with a strong engine of its own should plug it in here.
 */
import { game, view } from '../game/rules';
import { encodeMove } from './match';

type P = ReturnType<typeof game.setup>;
const WIN = 1_000_000;
let deadline = 0;
let nodes = 0;
class Timeout extends Error {}

const evaluate = (p: P): number => view.evaluate?.(p) ?? 0;

function search(p: P, depth: number, alpha: number, beta: number): number {
  if ((++nodes & 63) === 0 && performance.now() > deadline) throw new Timeout();
  if (depth <= 0) return evaluate(p);
  const moves = game.moves(p);
  if (!moves.length) return 0;
  const mover = game.turn(p);
  let best = -Infinity;
  for (const m of moves) {
    const r = game.play(p, m);
    const s = r.outcome ? (r.outcome.winner === 2 ? 0 : r.outcome.winner === mover ? WIN + depth : -WIN - depth) : -search(r.position, depth - 1, -beta, -alpha);
    if (s > best) best = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break;
  }
  return best;
}

function choose(p: P, budgetMs: number, maxDepth = 6): number {
  const moves = game.moves(p);
  if (!moves.length) return 0;
  deadline = performance.now() + budgetMs;
  nodes = 0;
  let best = moves[0];
  const mover = game.turn(p);
  for (let depth = 1; depth <= maxDepth; depth++) {
    let bestHere = moves[0], alpha = -Infinity;
    try {
      for (const m of moves) {
        const r = game.play(p, m);
        const s = r.outcome ? (r.outcome.winner === 2 ? 0 : r.outcome.winner === mover ? WIN + depth : -WIN - depth) : -search(r.position, depth - 1, -Infinity, -alpha);
        if (s > alpha) { alpha = s; bestHere = m; }
      }
    } catch (e) { if (e instanceof Timeout) break; throw e; }
    best = bestHere;
    if (alpha >= WIN) break;
  }
  return best;
}

self.onmessage = (ev: MessageEvent<{ id: number; pos: P; budgetMs: number }>) => {
  const { id, pos, budgetMs } = ev.data;
  (self as unknown as Worker).postMessage({ id, action: encodeMove(choose(pos, budgetMs)) });
};
