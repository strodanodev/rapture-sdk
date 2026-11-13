// The LitNode title artifact's entry: scripts/build-title.mjs bundles this file (the match layer, your rules, chess.js
// for the sample) into titles/<rulesetId>.mjs, then LitNode's bundler checks it and writes rulesets/<rulesetId>.js.
import config from '../../board.config';
import { game } from '../game/rules';
import { defineBoardTitle } from '../kit/title';

export default defineBoardTitle(game, config);
