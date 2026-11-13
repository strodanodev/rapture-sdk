/**
 * YOUR BOARD CONFIG. Everything about the game that is not its rules (src/game/rules.ts) or its pieces
 * (src/game/pieces.ts). The ruleset imports this file too, so keep it plain data.
 */
import type { BoardConfig } from './src/kit/config';

const config: BoardConfig = {
  title: 'Board Chess',
  // A new id of your own. Never reuse another title's id (rapture-chess.* belongs to Rapture Chess).
  rulesetId: 'board-chess.v1',
  description: 'Chess on the Rapture SDK board template: the clock in the log, draw offers, settled by LitNode.',
  url: null,
  accent: '#c9a45c',
  board: { files: 8, ranks: 8, fileNames: 'abcdefgh', light: '#d9d3c5', dark: '#3a3e46', frame: '#1c1d22' },
  sides: [
    { name: 'White', color: '#ece6d8', light: '#7fb2ff' },
    { name: 'Black', color: '#25272d', light: '#ff9a5a' },
  ],
  arena: {
    model: null,
    sky: { top: '#06070c', bottom: '#151924', glow: '#2c3548', fog: '#0a0c12', fogDensity: 0.02 },
    stars: 0.7,
    key: { color: '#fff3e2', intensity: 2.3, position: [6, 12, 5] },
    rim: { color: '#9fc4ff', intensity: 45 },
    hemi: { sky: '#3c465e', ground: '#141210', intensity: 0.38 },
    floorRadius: 9,
    atmosphere: {
      shafts: { color: '#b0c8ff', intensity: 0.32, count: 3 },
      mist: { color: '#8a98b4', opacity: 0.1 },
      motes: { color: '#e8eeff', base: 0.12, rise: 0.04, size: 0.08 },
    },
    rays: { color: '#b4ccff', density: 1 / 70, maxDensity: 0.16, distanceAttenuation: 2 },
    pool: { color: '#fff1dc', intensity: 60, angle: 0.42 },
    grade: { lift: [0, 0.004, 0.014], gamma: [1, 1, 1.01], gain: [1.03, 1, 0.97] },
  },
  pieces: { models: {} },
  clock: { control: '5+3', firstMoveMs: 30_000, turnMs: 60_000 },
  maxBeats: 2000,
  modes: ['ranked', 'casual'],
  leaderboard: { kind: 'elo', k: 24 },
  // Wallet seating: point this at an ERC-721 on Liteforge (chain 4441) and holders see their tokens take the board.
  // Rapture's own collection, for example, is RaptureCards on Liteforge (see the Rapture SDK plan); the sample leaves it off.
  collection: null,
  storageKey: 'board-chess',
};

export default config;
