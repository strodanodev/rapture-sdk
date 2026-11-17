import { decode, Op } from './actions';
import { seededRandom } from './rng';
import type { Rules } from './rules';
import type { MatchState, UnitState } from './types';

/**
 * A greedy, deterministic opponent: plays the action that most improves a board score, ends the turn when
 * nothing helps. Setup plays (non-unit cards and hero powers) get a second look one action deeper, so it
 * spends energy and draw cards when they lead somewhere. Used by the offline client, the headless sim and
 * as a stand-in for AFK players in tests. Not part of any ruleset.
 *
 * `level` sets the strength, deterministically (any randomness is seeded from the state, so sims and replays
 * of bot games stay reproducible):
 * - 1, easy: picks among its three best moves at random, and sometimes ends the turn early;
 * - 2, normal (the default): the greedy bot the sim balances with;
 * - 3, hard: looks one action deeper on its six best candidates.
 */
export type BotLevel = 1 | 2 | 3;

export function greedyBot(rules: Rules, { level = 2 }: { level?: BotLevel } = {}): (state: MatchState, side?: 0 | 1) => number {
  const cards = rules.game.cards;
  const has = (u: UnitState, k: string): boolean => !u.silenced && (cards[u.c].keywords?.includes(k as never) ?? false);
  // Abilities that keep paying off while the unit lives (a silenced unit has none).
  const lasting = (u: UnitState): boolean => !u.silenced && (cards[u.c].abilities?.some((a) => a.on === 'turnStart' || a.on === 'death') ?? false);
  const newer = (u: UnitState): boolean => !u.silenced && (cards[u.c].abilities?.some((a) => a.on === 'turnEnd' || a.on === 'damaged' || a.on === 'allyDeath') ?? false);
  // The terms after `lasting` only apply to the newer mechanics, so games without them score exactly as before.
  const unitValue = (u: UnitState): number =>
    u.atk * 2 + u.hp + (u.guard ? 1 : 0) + (u.shield ? u.atk + 1 : 0) + (has(u, 'lifesteal') ? u.atk * 0.5 : 0) + (has(u, 'poison') ? 3 : 0) + (lasting(u) ? 2 : 0)
    + (newer(u) ? 2 : 0)
    // An aura's bonus is already in its units' stats; the source is worth a little more for keeping it up.
    + (!u.silenced && cards[u.c].aura ? 1 : 0)
    // A frozen unit loses its next attack.
    - (u.frozen !== undefined ? u.atk : 0);
  // Synergy games (conditions or auras): the order of unit plays matters, so unit plays get the setup look-ahead too.
  const synergy = cards.some((c) => c.aura || c.abilities?.some((a) => a.if));
  // Games that can break relics: the enemy's relics count against me too (elsewhere they are out of reach anyway).
  const breaks = JSON.stringify([cards, rules.game.config.champion.powers ?? []]).includes('"op":"break"');
  // Life gets more valuable as it runs out, for both sides: defend when low, press when the enemy is low.
  const lifeValue = (l: number): number => 3 * l - 0.15 * Math.max(0, 15 - l) ** 2;
  const score = (s: MatchState, me: 0 | 1): number => {
    if (s.over) return s.winner === me ? 1e6 : s.winner === 2 ? 0 : -1e6;
    const P = s.p[me], E = s.p[me === 0 ? 1 : 0];
    const board = (units: UnitState[]): number => units.reduce((n, u) => n + unitValue(u), 0);
    // The enemy's board next turn, past my guards: facing lethal is nearly as bad as losing.
    const threat = E.board.reduce((n, u) => n + (u.frozen !== undefined && u.frozen > s.turnNo ? 0 : u.atk), 0) - P.board.filter((u) => u.guard).reduce((n, u) => n + u.hp, 0);
    const danger = threat >= P.life ? 40 : 0;
    // Relics pay off over turns and spare energy enables more plays, so both count a little.
    return lifeValue(P.life) - lifeValue(E.life) + 1.5 * (board(P.board) - board(E.board)) + P.hand.length - E.hand.length + P.relics.length * 4 + P.energy * 0.5 - danger
      - (breaks ? E.relics.length * 4 : 0);
  };
  const isSetup = (s: MatchState, x: number): boolean => {
    const { op, a } = decode(x);
    if (op === Op.Power) return true;
    if (op !== Op.Play) return false;
    const c = s.p[s.turn].hand[a];
    return c !== undefined && (cards[c].type !== 'unit' || synergy);
  };
  /** Every non-END action with its score, best first. */
  const ranked = (state: MatchState, me: 0 | 1, deeper: boolean): Array<{ x: number; v: number }> => {
    const id = state.p[me].id;
    const out: Array<{ x: number; v: number; next: MatchState }> = [];
    for (const x of rules.legalActions(state)) {
      if (decode(x).op === Op.End) continue;
      const next = rules.step(state, { [id]: x });
      let v = score(next, me);
      if (deeper && isSetup(state, x) && !next.over && next.turn === me) v = Math.max(v, bestOf(next, me, false).v - 0.1);
      out.push({ x, v, next });
    }
    out.sort((a, b) => b.v - a.v);
    if (level === 3 && deeper) {
      // Hard: the best follow-up decides among the top candidates, so it sets up kills it can't see in one step.
      for (const c of out.slice(0, 6)) if (!c.next.over && c.next.turn === me) c.v = Math.max(c.v, bestOf(c.next, me, false).v - 0.05);
      out.sort((a, b) => b.v - a.v);
    }
    return out;
  };
  const bestOf = (state: MatchState, me: 0 | 1, deeper: boolean): { x: number; v: number } => ranked(state, me, deeper)[0] ?? { x: 0, v: -Infinity };
  return (state, side = state.turn) => {
    if (state.phase === 'decks') return rules.suggestedDeclaration(state, side);
    const me = state.turn;
    const end = rules.legalActions(state).at(-1) ?? 0;
    const pass = score(state, me);
    const options = ranked(state, me, true).filter((o) => o.v >= pass);
    if (!options.length) return end;
    if (level === 1) {
      // Easy: a seeded pick among the top three, and a one-in-five chance to stop spending.
      const rnd = seededRandom(`${state.seed}|bot|${state.beat}`);
      if (rnd() % 5 === 0) return end;
      return options[rnd() % Math.min(3, options.length)].x;
    }
    return options[0].x;
  };
}
