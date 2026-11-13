// Every game the menu board replays is a real checkmate (chess.js), and plays through the match layer to the same end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { MATES, showcase } from '../src/game/showcase';
import { game } from '../src/game/rules';
import { createMatchRules, encodeMove } from '../src/kit/match';

test('the menu mates are all checkmate', () => {
  assert.ok(MATES.length >= 8);
  for (const m of MATES) {
    const c = new Chess();
    for (const san of m.moves.split(' ')) assert.ok(c.move(san), `${m.name}: illegal ${san}`);
    assert.ok(c.isCheckmate(), `${m.name} does not end in mate`);
  }
});

test('the showcase replays through the match layer to the mate', () => {
  const rules = createMatchRules(game);
  const P = ['a', 'b'];
  for (const g of showcase()) {
    let s = rules.init('menu', P);
    for (const code of g.moves) s = rules.step(s, { [P[s.turn]]: encodeMove(code), [P[s.turn ^ 1]]: 0 });
    assert.equal(s.reason, 'checkmate', g.name);
    assert.equal(s.plies, g.moves.length, g.name);
  }
});
