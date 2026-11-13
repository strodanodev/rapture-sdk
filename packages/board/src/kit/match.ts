/**
 * The match layer every two-player board game shares, generalised from Rapture Chess's rules (v2): `init(seed,
 * participants)`, then one `step` per log entry, each entry carrying one 32-bit word per player. Any integer replays
 * safely: a word that does nothing is a no-op. The state is plain JSON, so a relay, a bot, the browser and a LitNode
 * ruleset replay the same log to the same state.
 *
 *   bits 0-2   op      0 none, 1 move, 2 concede, 3 offer a draw, 4 accept a draw, 5 decline a draw,
 *                      6 time control (first entry only), 7 clock stamp
 *   move       bits 3-30 the game's move code (BoardGame.moveSchema)
 *   control    bits 3-17 base seconds, 18-25 increment seconds
 *   clock      bits 3-30 milliseconds the side to move spent since the previous entry
 *
 * The clock is part of the log: the relay stamps every entry of a timed game with the time the side to move used, in
 * the slot of the player who did not act, and both players sign the log. A side whose time runs out loses, unless the
 * opponent cannot win (BoardGame.canWin), which is a draw. A move stamped after the flag fell is ignored. The
 * increment is added after each move (Fischer). Draws: a side may offer at any time (once per two plies); the opponent
 * accepts or declines, or declines by moving; an offer against a standing offer is an acceptance.
 */
import { MAX_MOVE_CODE, type BoardGame, type Side } from './game';

export const Op = { None: 0, Move: 1, Concede: 2, Offer: 3, Accept: 4, Decline: 5, Control: 6, Clock: 7 } as const;
/** The longest single clock stamp a word holds (28 bits of milliseconds, about 74 hours). */
export const MAX_STAMP_MS = 0x0fffffff;
/** The default move limit: a log longer than this ends drawn (the manifest's maxTicks matches it). */
export const MAX_BEATS = 2000;

export interface TimeControl { base: number; inc: number }

export interface MatchState<P = unknown> {
  v: 1;
  /** Log entries consumed so far. */
  beat: number;
  turn: Side;
  /** Moves played so far (plies). */
  plies: number;
  turnNo: number;
  over: boolean;
  /** -1 none yet, 0 or 1 a side, 2 a draw. */
  winner: -1 | 0 | 1 | 2;
  reason: string;
  /** The word that took effect on the last beat, for the UI and animation. 0 when the beat was a no-op. */
  last: number;
  seed: string;
  /** The two player ids, side 0 then side 1: inputs are keyed by them. */
  p: [string, string];
  /** The time control in milliseconds, or null for an untimed game. */
  tc: TimeControl | null;
  /** Milliseconds left on each side's clock, as of the last entry. */
  left: [number, number];
  /** The side whose draw offer stands, or -1. */
  offer: -1 | 0 | 1;
  /** The ply count when each side last offered a draw. */
  offeredAt: [number, number];
  /** The game's position. */
  pos: P;
  /** The moves so far, in the game's notation. */
  notes: string[];
}

export const encodeMove = (code: number): number => (Op.Move | ((code & MAX_MOVE_CODE) << 3)) | 0;
export const moveCode = (word: number): number => (word >>> 3) & MAX_MOVE_CODE;
export const concede = (): number => Op.Concede;
export const offerDraw = (): number => Op.Offer;
export const acceptDraw = (): number => Op.Accept;
export const declineDraw = (): number => Op.Decline;
/** The time control word: base and increment in whole seconds (base up to 32767 s, increment up to 255 s). */
export const encodeControl = (baseSec: number, incSec: number): number =>
  Op.Control | ((Math.max(0, Math.min(0x7fff, Math.floor(baseSec))) << 3) | (Math.max(0, Math.min(0xff, Math.floor(incSec))) << 18));
/** The clock stamp word: milliseconds the side to move spent since the previous entry. */
export const encodeClock = (ms: number): number => Op.Clock | (Math.max(0, Math.min(MAX_STAMP_MS, Math.floor(ms))) << 3);
export const decodeControl = (x: number): TimeControl => ({ base: ((x >>> 3) & 0x7fff) * 1000, inc: ((x >>> 18) & 0xff) * 1000 });

/** The player action in an entry's two words (the word that is not a clock stamp), or 0. */
export const entryAction = (inputs: readonly number[]): number => {
  for (const w of inputs) if (w && (w & 7) !== Op.Clock) return w | 0;
  return 0;
};

export interface MatchRules<P> {
  readonly game: BoardGame<P>;
  readonly maxBeats: number;
  init(seed: string, participants: string[]): MatchState<P>;
  step(state: MatchState<P>, inputs: Record<string, number>): MatchState<P>;
  done(state: MatchState<P>): boolean;
  scores(state: MatchState<P>): Record<string, number>;
  /** Every legal move word for the side to move. */
  legalActions(state: MatchState<P>): number[];
  /** Whether a move word is legal for the side to move now. */
  isLegal(state: MatchState<P>, action: number): boolean;
  /** Whether a draw word (offer, accept, decline) from `side` would take effect now. */
  canDraw(state: MatchState<P>, side: Side, action: number): boolean;
}

export function createMatchRules<P>(game: BoardGame<P>, opts: { maxBeats?: number } = {}): MatchRules<P> {
  const maxBeats = opts.maxBeats ?? MAX_BEATS;

  const isLegal = (state: MatchState<P>, action: number): boolean =>
    !state.over && (action & 7) === Op.Move && game.moves(state.pos).includes(moveCode(action));

  function canDraw(state: MatchState<P>, side: Side, action: number): boolean {
    if (state.over) return false;
    const other = side === 0 ? 1 : 0;
    switch (action & 7) {
      case Op.Offer: return state.offer === other || (state.offer === -1 && state.plies - state.offeredAt[side] >= 2);
      case Op.Accept: case Op.Decline: return state.offer === other;
      default: return false;
    }
  }

  function end(state: MatchState<P>, winner: 0 | 1 | 2, reason: string): MatchState<P> {
    state.over = true; state.winner = winner; state.reason = reason; state.offer = -1;
    return state;
  }

  return {
    game,
    maxBeats,
    init(seed, who) {
      const pos = game.setup(seed);
      return {
        v: 1, beat: 0, turn: game.turn(pos), plies: 0, turnNo: 1, over: false, winner: -1, reason: '', last: 0, seed,
        p: [String(who[0]), String(who[1])], tc: null, left: [0, 0], offer: -1, offeredAt: [-2, -2], pos, notes: [],
      };
    },
    step(prev, inputs) {
      const state: MatchState<P> = { ...prev, notes: prev.notes.slice(), left: [prev.left[0], prev.left[1]], offeredAt: [prev.offeredAt[0], prev.offeredAt[1]], beat: prev.beat + 1, last: 0 };
      if (state.over) return state;
      const words = [(inputs[state.p[0]] ?? 0) | 0, (inputs[state.p[1]] ?? 0) | 0];
      const stamps = words.filter((w) => (w & 7) === Op.Clock);
      if (stamps.length === 2) return state; // one stamp per entry
      const acts = words.map((w) => ((w & 7) === Op.Clock ? 0 : w));

      // 1. the time control, in the first entry only
      for (const side of [0, 1] as const) {
        if ((acts[side] & 7) === Op.Control) {
          if (state.tc || state.beat !== 1) return state;
          const tc = decodeControl(acts[side]);
          if (tc.base <= 0) return state;
          state.tc = tc; state.left = [tc.base, tc.base]; state.last = acts[side];
          return state;
        }
      }

      // 2. the clock: the stamp is charged to the side to move; a flag ends the game before anything else counts
      if (state.tc && stamps.length) {
        const mover = state.turn;
        state.left[mover] -= stamps[0] >>> 3;
        if (state.left[mover] <= 0) {
          state.left[mover] = 0;
          state.last = stamps[0];
          const other = mover === 0 ? 1 : 0;
          return (game.canWin?.(state.pos, other) ?? true) ? end(state, other, 'timeout') : end(state, 2, 'timeout vs insufficient material');
        }
      }

      // 3. a concession, from either side
      for (const side of [0, 1] as const) {
        if ((acts[side] & 7) === Op.Concede) { state.last = acts[side]; return end(state, side === 0 ? 1 : 0, 'concession'); }
      }

      // 4. draw offers, from either side
      for (const side of [0, 1] as const) {
        const x = acts[side], op = x & 7;
        if (op < Op.Offer || op > Op.Decline || !canDraw(state, side, x)) continue;
        state.last = x;
        if (op === Op.Decline) { state.offer = -1; continue; }
        if (op === Op.Accept || state.offer !== -1) return end(state, 2, 'agreement');
        state.offer = side; state.offeredAt[side] = state.plies;
      }

      // 5. the move, from the side to move
      const mover = state.turn;
      const x = acts[mover];
      if (isLegal(state, x)) {
        const played = game.play(state.pos, moveCode(x));
        state.pos = played.position;
        state.notes.push(played.notation);
        state.plies += 1;
        state.last = x;
        state.turn = game.turn(state.pos);
        state.turnNo = Math.floor(state.plies / 2) + 1;
        if (state.offer !== -1 && state.offer !== mover) state.offer = -1; // moving declines the opponent's offer
        if (state.tc) state.left[mover] += state.tc.inc;
        if (played.outcome) end(state, played.outcome.winner, played.outcome.reason);
      }
      if (!state.over && state.beat >= maxBeats) end(state, 2, 'move limit');
      return state;
    },
    done: (s) => s.over,
    scores(s) {
      const w = s.winner === 2 ? [0.5, 0.5] : s.winner === 0 ? [1, 0] : s.winner === 1 ? [0, 1] : [0, 0];
      return Object.fromEntries(s.p.map((p, i) => [p, w[i]]));
    },
    legalActions: (s) => (s.over ? [] : game.moves(s.pos).map(encodeMove)),
    isLegal,
    canDraw,
  };
}
