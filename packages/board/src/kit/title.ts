/**
 * A board game as a LitNode replayable title: the exact shape LitNode's `defineTitle` (titles/title.js) produces, with
 * no LitNode import, so the bundled ruleset is one import-free module that passes `sdk/conformance.mjs`. `init`/`step`
 * are the match layer over the game's rules: the host node and its witnesses replay a match's `{ seed, entries }` to
 * the same `serialize()` root and the same scores, and that replayed result is what settles.
 */
import type { BoardConfig } from './config';
import type { BoardGame } from './game';
import { createMatchRules, type MatchState } from './match';

/** The log word layout every board title shares; the game's own move layout follows it. */
export const MATCH_SCHEMA = 'board-v1:op3,move(code28)|control(base15,inc8)|clock(ms28)';

export function defineBoardTitle<P>(game: BoardGame<P>, config: Pick<BoardConfig, 'rulesetId' | 'title' | 'description' | 'url' | 'accent' | 'maxBeats' | 'modes' | 'leaderboard'>) {
  const rules = createMatchRules(game, { maxBeats: config.maxBeats });
  // The balance version pins the move encoding and the result rules; a change to either is a new ruleset id.
  const balance = { version: `bal-${config.rulesetId}`, apply: () => ({}) };
  return {
    manifest: {
      kind: 'replayable',
      rulesetId: config.rulesetId,
      tickRate: 1,
      maxTicks: config.maxBeats,
      modes: config.modes,
      participants: 2,
      inputSchema: `${MATCH_SCHEMA};${game.name}:${game.moveSchema}`,
      hiddenInfo: false,
      replicas: 3,
      standingFloor: 0,
      hostPolicy: { affinity: 'open' },
      exclusive: false,
      display: { title: config.title, url: config.url, description: config.description, cover: null, accent: config.accent },
      balanceVersion: balance.version,
      services: {
        leaderboard: config.leaderboard,
        credits: null,
        stats: { track: ['matches', 'wins', 'ticks'] },
      },
    },
    balance,
    init: rules.init,
    step: rules.step,
    done: rules.done,
    scores: rules.scores,
    /** What the root commits to: the whole state (a board game has no hidden information). */
    serialize: (s: MatchState<P>): MatchState<P> => JSON.parse(JSON.stringify(s)) as MatchState<P>,
    /** What a client may see: everything but the seed. */
    view: (s: MatchState<P>) => {
      const { seed: _seed, ...rest } = s;
      return JSON.parse(JSON.stringify(rest)) as Omit<MatchState<P>, 'seed'>;
    },
  };
}
