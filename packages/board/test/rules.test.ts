// The match layer over the chess sample (ported from Rapture Chess's rules v2 tests): the clock in the log, flags
// (FIDE 6.9), draw offers, concession, the move limit, and the chess itself (mates, repetition, promotion, castling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import config from '../board.config';
import { game, view, chessMove, cannotMate, squareIndex } from '../src/game/rules';
import {
  createMatchRules, encodeMove, encodeControl, encodeClock, concede, offerDraw, acceptDraw, declineDraw, entryAction, moveCode, Op,
} from '../src/kit/match';

const rules = createMatchRules(game, { maxBeats: config.maxBeats });
const P = ['white-key', 'black-key'];
const mv = (from: string, to: string, promo = ''): number => encodeMove(chessMove(from, to, promo));
const SCHOLARS: Array<[string, string]> = [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']];
type S = ReturnType<typeof rules.init>;

/** Step one entry: `side` acts with `x`, the other slot carries `other` (a clock stamp, or 0). */
const step = (s: S, side: 0 | 1, x: number, other = 0): S => rules.step(s, { [P[side]]: x, [P[side ^ 1]]: other });
const timed = (base: number, inc: number): S => step(rules.init('seed', P), 0, encodeControl(base, inc));

test('an untimed log: scholar\'s mate', () => {
  let s = rules.init('seed', P);
  SCHOLARS.forEach(([f, t], i) => { s = step(s, (i % 2) as 0 | 1, mv(f, t)); });
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  assert.equal(s.reason, 'checkmate');
  assert.equal(s.tc, null);
  assert.deepEqual(s.notes, ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);
  assert.deepEqual(rules.scores(s), { [P[0]]: 1, [P[1]]: 0 });
});

test('move words: only the side to move, only legal moves; any integer is a safe no-op', () => {
  const s = rules.init('seed', P);
  assert.equal(step(s, 1, mv('e7', 'e5')).last, 0);                     // not Black's turn
  assert.equal(step(s, 0, mv('e2', 'e5')).last, 0);                     // illegal
  assert.equal(rules.legalActions(s).length, 20);
  assert.equal(rules.isLegal(s, mv('g1', 'f3')), true);
  assert.equal(moveCode(mv('g1', 'f3')), chessMove('g1', 'f3'));
  for (const x of [-1, 0x7fffffff, -0x80000000, 12345, 7, 6 | (1 << 3)]) rules.step(s, { [P[0]]: x, [P[1]]: x });
});

test('the time control is set by the first entry only', () => {
  const s = timed(180, 2);
  assert.deepEqual(s.tc, { base: 180_000, inc: 2_000 });
  assert.deepEqual(s.left, [180_000, 180_000]);
  assert.notEqual(s.last, 0);
  const late = step(step(rules.init('seed', P), 0, mv('e2', 'e4')), 0, encodeControl(60, 0));
  assert.equal(late.tc, null);
  assert.equal(late.last, 0);
});

test('stamps charge the side to move, the increment follows each move', () => {
  let s = timed(60, 2);
  s = step(s, 0, mv('e2', 'e4'), encodeClock(5_000));
  assert.deepEqual(s.left, [57_000, 60_000]);
  s = step(s, 1, mv('e7', 'e5'), encodeClock(10_000));
  assert.deepEqual(s.left, [57_000, 52_000]);
  // an out-of-turn action (a draw offer by Black) carries White's elapsed time in White's slot
  s = rules.step(s, { [P[0]]: encodeClock(1_000), [P[1]]: offerDraw() });
  assert.deepEqual(s.left, [56_000, 52_000]);
  assert.equal(s.offer, 1);
});

test('a flag loses, and a move stamped past the flag does not count', () => {
  let s = timed(10, 0);
  s = step(s, 0, mv('e2', 'e4'), encodeClock(1_000));
  s = step(s, 1, mv('e7', 'e5'), encodeClock(10_000));
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  assert.equal(s.reason, 'timeout');
  assert.equal(s.plies, 1);
  assert.deepEqual(s.left, [9_000, 0]);
  // a bare stamp (no action) flags too: the relay's timeout entry
  let t = timed(10, 0);
  t = rules.step(t, { [P[0]]: 0, [P[1]]: encodeClock(10_001) });
  assert.equal(t.winner, 1);
  assert.equal(t.reason, 'timeout');
});

test('FIDE 6.9: a flag against a side that cannot mate is a draw', () => {
  const pos = (fen: string) => new Chess(fen);
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/4K2Q w - - 0 1'), 1), true);          // Black: bare king
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/4K2Q w - - 0 1'), 0), false);         // White: a queen
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/2B1K3 w - - 0 1'), 0), true);         // K+B v K (dead)
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/8/1N2K3 w - - 0 1'), 0), true);         // K+N v K (dead)
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/4p3/1N2K3 w - - 0 1'), 0), false);      // K+N v K+P: a mate exists
  assert.equal(cannotMate(pos('8/8/8/4k3/8/4b3/8/2B1K3 w - - 0 1'), 0), true);       // same-colour bishops only
  assert.equal(cannotMate(pos('8/8/8/4k3/8/5b2/8/2B1K3 w - - 0 1'), 0), false);      // opposite colours: a mate exists
  assert.equal(cannotMate(pos('8/8/8/4k3/8/8/4r3/2B1K3 w - - 0 1'), 0), false);      // K+B v K+R: a mate exists
  // and the match layer asks the game (canWin) when a side flags
  const at = (fen: string): S => { const pos = { fen, keys: [] }; return { ...timed(10, 0), pos, turn: game.turn(pos) }; };
  const a = rules.step(at('8/8/8/4k3/8/8/8/4K2Q b - - 0 1'), { [P[0]]: encodeClock(10_000), [P[1]]: 0 });
  assert.equal(a.winner, 0);                                                          // Black flags; White has a queen
  assert.equal(a.reason, 'timeout');
  const b = rules.step(at('8/8/8/4k3/8/8/8/4K2Q w - - 0 1'), { [P[0]]: 0, [P[1]]: encodeClock(10_000) });
  assert.equal(b.winner, 2);                                                          // White flags; a bare king cannot mate
  assert.equal(b.reason, 'timeout vs insufficient material');
});

test('draw offers: accept, decline, decline by moving, crossing offers, the cooldown', () => {
  let s = rules.init('seed', P);
  s = step(s, 0, mv('e2', 'e4'));
  s = step(s, 1, offerDraw());
  assert.equal(s.offer, 1);
  assert.equal(rules.canDraw(s, 1, offerDraw()), false);                // no second offer while one stands
  s = step(s, 1, offerDraw());
  assert.equal(s.last, 0);
  s = step(s, 1, mv('e7', 'e5'));                                        // Black moves: its own offer stands
  assert.equal(s.plies, 2);
  assert.equal(s.offer, 1);
  s = step(s, 0, mv('g1', 'f3'));                                        // White moves: declines
  assert.equal(s.offer, -1);
  s = step(s, 1, offerDraw());
  assert.equal(s.offer, 1);
  s = step(s, 0, declineDraw());
  assert.equal(s.offer, -1);
  assert.equal(rules.canDraw(s, 1, offerDraw()), false);                // cooldown: two plies
  s = step(s, 1, mv('b8', 'c6'));
  s = step(s, 0, mv('b1', 'c3'));
  assert.equal(rules.canDraw(s, 1, offerDraw()), true);
  s = step(s, 0, offerDraw());
  s = step(s, 1, offerDraw());                                           // an offer against a standing offer agrees
  assert.equal(s.over, true);
  assert.equal(s.winner, 2);
  assert.equal(s.reason, 'agreement');
  assert.deepEqual(rules.scores(s), { [P[0]]: 0.5, [P[1]]: 0.5 });
  let a = step(rules.init('seed', P), 0, offerDraw());
  assert.equal(step(a, 0, acceptDraw()).over, false);                   // you cannot accept your own offer
  a = step(a, 1, acceptDraw());
  assert.equal(a.reason, 'agreement');
  let k = step(rules.init('seed', P), 0, offerDraw());
  k = step(k, 0, mv('e2', 'e4'));
  assert.equal(k.offer, 0);                                              // the offering side keeps its offer when it moves
});

test('concession from either seat, two stamps are a no-op, entryAction finds the action', () => {
  const s = rules.init('seed', P);
  assert.equal(step(s, 1, concede()).winner, 0);
  assert.equal(step(s, 0, concede()).reason, 'concession');
  assert.equal(rules.step(timed(60, 0), { [P[0]]: encodeClock(1), [P[1]]: encodeClock(1) }).last, 0);
  assert.equal(entryAction([mv('e2', 'e4'), encodeClock(500)]), mv('e2', 'e4'));
  assert.equal(entryAction([encodeClock(500), offerDraw()]), offerDraw());
  assert.equal(entryAction([0, encodeClock(500)]), 0);
  assert.equal(Op.Clock, 7);
});

test('the move limit ends the log drawn', () => {
  let s = rules.init('seed', P);
  for (let i = 0; i < config.maxBeats; i++) s = rules.step(s, { [P[0]]: 0, [P[1]]: 0 });
  assert.equal(s.over, true);
  assert.equal(s.reason, 'move limit');
});

test('chess: threefold repetition, promotion, castling and en passant as the board sees them', () => {
  let s = rules.init('seed', P);
  const shuffle: Array<[string, string]> = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'], ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
  shuffle.forEach(([f, t], i) => { s = step(s, (i % 2) as 0 | 1, mv(f, t)); });
  assert.equal(s.reason, 'threefold repetition');
  assert.equal(s.winner, 2);

  // promotion: the code names the piece; a promotion without one is not a legal move
  const promo = { fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1', keys: [] };
  const codes = game.moves(promo);
  assert.ok(codes.includes(chessMove('e7', 'e8', 'q')) && codes.includes(chessMove('e7', 'e8', 'n')));
  assert.ok(!codes.includes(chessMove('e7', 'e8')));
  const up = game.play(promo, chessMove('e7', 'e8', 'n'));
  assert.equal(up.notation, 'e8=N');
  assert.equal(view.sketch(promo, chessMove('e7', 'e8', 'q')).becomes, 'q');

  // castling carries the rook; en passant takes the pawn beside, not on the target
  const castle = { fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', keys: [] };
  assert.deepEqual(view.sketch(castle, chessMove('e1', 'g1')).also, [{ from: squareIndex('h1'), to: squareIndex('f1') }]);
  assert.deepEqual(view.sketch(castle, chessMove('e1', 'c1')).also, [{ from: squareIndex('a1'), to: squareIndex('d1') }]);
  const ep = { fen: '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1', keys: [] };
  assert.equal(view.sketch(ep, chessMove('d5', 'e6')).captured, squareIndex('e5'));
  assert.equal(view.sketch({ fen: game.setup('').fen, keys: [] }, chessMove('g1', 'f3')).leap, true);
  assert.equal(view.pieces(game.setup('')).length, 32);
  assert.equal(view.alert!({ fen: '4k3/8/8/8/8/8/8/4K2r w - - 0 1', keys: [] }), squareIndex('e1'));
});

test('the bot evaluation sees material from the side to move', () => {
  const up = { fen: '4k3/8/8/8/8/8/8/3QK3 w - - 0 1', keys: [] };
  assert.ok(view.evaluate!(up) > 800);
  assert.ok(view.evaluate!({ ...up, fen: up.fen.replace(' w ', ' b ') }) < -800);
});
