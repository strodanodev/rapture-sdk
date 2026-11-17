import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { attack, compileGame, createRules, declare, describeCard, endTurn, enemyUnit, greedyBot, ownUnit, play, validateGame } from '../src/core/index';
import type { CardDef, GameConfig, MatchState, UnitState } from '../src/core/index';
import { createGauntlet } from '../src/meta/gauntlet';
import { simulate } from '../src/meta/balance';

const STARTER = JSON.parse(readFileSync(new URL('../templates/starter.game.json', import.meta.url), 'utf8')) as GameConfig;
const DEMO = JSON.parse(readFileSync(new URL('./fixtures/synergy-duel.game.json', import.meta.url), 'utf8')) as GameConfig;

const unit = (id: string, attackV: number, health: number, extra: Partial<CardDef> = {}): CardDef => ({ id, name: id, type: 'unit', element: 'neutral', cost: 1, attack: attackV, health, rarity: 'common', ...extra });
const spell = (id: string, effect: CardDef['effect'], extra: Partial<CardDef> = {}): CardDef => ({ id, name: id, type: 'spell', element: 'neutral', cost: 1, effect, rarity: 'common', ...extra });
const foeOf = (me: 0 | 1): 0 | 1 => (me === 0 ? 1 : 0);

/** A test game: the starter's rules plus the given cards (each in the deck unless deckable: false). */
function setup(cards: CardDef[], tweak: (cfg: GameConfig) => void = () => {}) {
  const cfg: GameConfig = { ...STARTER, champion: { ...STARTER.champion }, rules: { ...STARTER.rules, secondPlayerCards: 0, secondPlayerEnergy: 0 }, cards, deck: Object.fromEntries(cards.filter((c) => c.deckable !== false).map((c) => [c.id, 3])) };
  tweak(cfg);
  assert.deepEqual(validateGame(cfg), []);
  const rules = createRules(compileGame(cfg));
  const idx = (id: string): number => cards.findIndex((c) => c.id === id);
  /** A fresh match with side `turn` to act, hands and boards cleared, plenty of energy. */
  const fresh = (): { s: MatchState; me: 0 | 1; foe: 0 | 1 } => {
    const s = rules.init('synergy', ['a', 'b'], {});
    for (const p of s.p) { p.hand = []; p.board = []; p.relics = []; p.energy = 10; p.energyCap = 10; p.life = 20; p.maxLife = 30; }
    return { s, me: s.turn, foe: foeOf(s.turn) };
  };
  const put = (s: MatchState, side: 0 | 1, id: string, ready = true): UnitState => {
    const c = idx(id), def = cards[c];
    const u: UnitState = { c, atk: def.attack!, hp: def.health!, max: def.health!, guard: def.keywords?.includes('guard') ?? false, ready, fresh: !ready, shield: def.keywords?.includes('shield') ?? false };
    s.p[side].board.push(u);
    return u;
  };
  const hand = (s: MatchState, side: 0 | 1, id: string): void => { s.p[side].hand.push(idx(id)); };
  const act = (s: MatchState, x: number): MatchState => {
    assert.ok(rules.isLegal(s, x), `action ${x} should be legal`);
    return rules.step(s, { [s.p[s.turn].id]: x });
  };
  const ids = (s: MatchState, side: 0 | 1): string[] => s.p[side].board.map((u) => cards[u.c].id);
  return { cfg, rules, idx, fresh, put, hand, act, ids };
}

test('conditions: a play ability fires only when its `if` holds when the card is played', () => {
  const g = setup([
    unit('squire', 2, 1, { element: 'fire', kind: 'Mortal', abilities: [{ on: 'play', if: { allies: { sameElement: true } }, effect: { op: 'buff', attack: 1, health: 1, target: 'this' } }] }),
    unit('ember', 1, 1, { element: 'fire', kind: 'Mortal' }),
    unit('king', 3, 3, { element: 'water', kind: 'King', abilities: [{ on: 'play', if: { allies: { kind: 'Mortal', count: 2 } }, effect: { op: 'draw', amount: 1 } }] }),
    unit('headsman', 2, 2, { abilities: [{ on: 'play', if: { enemyLifeAtMost: 10 }, effect: { op: 'damage', amount: 3 } }] }),
  ]);
  // No other fire unit: the squire stays 2/1 (it is not its own ally).
  let { s, me, foe } = g.fresh();
  g.hand(s, me, 'squire');
  s = g.act(s, play(0));
  assert.deepEqual([s.p[me].board[0].atk, s.p[me].board[0].hp], [2, 1]);
  // With a fire ally it grows.
  ({ s, me } = g.fresh());
  g.put(s, me, 'ember');
  g.hand(s, me, 'squire');
  s = g.act(s, play(0));
  assert.deepEqual([s.p[me].board[1].atk, s.p[me].board[1].hp], [3, 2]);
  // count: two Mortals needed.
  ({ s, me } = g.fresh());
  g.put(s, me, 'ember');
  g.hand(s, me, 'king');
  s = g.act(s, play(0));
  assert.equal(s.p[me].hand.length, 0);
  ({ s, me } = g.fresh());
  g.put(s, me, 'ember'); g.put(s, me, 'squire');
  g.hand(s, me, 'king');
  s = g.act(s, play(0));
  assert.equal(s.p[me].hand.length, 1);
  // A chosen-target play ability whose condition fails takes no target: only target 0 is legal.
  ({ s, me, foe } = g.fresh());
  g.hand(s, me, 'headsman');
  assert.equal(g.rules.isLegal(s, play(0, 0)), true);
  assert.equal(g.rules.isLegal(s, play(0, ownUnit(0))), false);
  s.p[foe].life = 12;
  s = g.act(s, play(0));
  assert.equal(s.p[foe].life, 12);
  ({ s, me, foe } = g.fresh());
  s.p[foe].life = 10;
  g.hand(s, me, 'headsman');
  s = g.act(s, play(0, 0));
  assert.equal(s.p[foe].life, 7);
});

test('auras: tribal bonuses follow their source, health auras never kill, silence switches them off', () => {
  const g = setup([
    unit('king', 3, 4, { kind: 'King', aura: { attack: 1, filter: { kind: 'Mortal' } } }),
    unit('mortal', 1, 2, { kind: 'Mortal' }),
    unit('beast', 2, 2, { kind: 'Beast' }),
    unit('banner', 0, 3, { aura: { health: 2, to: 'all' } }),
    unit('veteran', 2, 3, { aura: { attack: 2, to: 'this', if: { lifeAtMost: 10 } } }),
    spell('bolt', { op: 'damage', amount: 3, target: 'enemy-unit' }),
    spell('hush', { op: 'silence', target: 'enemy-unit' }),
    spell('nick', { op: 'damage', amount: 1, target: 'all-units' }),
  ]);
  let { s, me, foe } = g.fresh();
  g.put(s, me, 'mortal'); g.put(s, me, 'beast');
  g.hand(s, me, 'king');
  s = g.act(s, play(0));
  // The Mortal gets +1 attack, the Beast and the King itself don't.
  assert.deepEqual(s.p[me].board.map((u) => u.atk), [2, 2, 3]);
  assert.deepEqual(s.p[me].board[0].aura, [1, 0]);
  assert.equal(s.p[me].board[1].aura, undefined);
  // The King dies: the bonus goes with it.
  s.turn = foe;
  g.hand(s, foe, 'bolt'); g.hand(s, foe, 'bolt');
  s = g.act(s, play(0, enemyUnit(2)));
  s = g.act(s, play(0, enemyUnit(2)));
  assert.deepEqual(g.ids(s, me), ['mortal', 'beast']);
  assert.deepEqual(s.p[me].board.map((u) => u.atk), [1, 2]);
  assert.equal(s.p[me].board[0].aura, undefined);

  // A health aura raises health and max; losing it caps health at the new max, never below 1.
  ({ s, me, foe } = g.fresh());
  g.put(s, me, 'mortal');
  g.hand(s, me, 'banner'); g.hand(s, me, 'nick');
  s = g.act(s, play(0));
  assert.deepEqual([s.p[me].board[0].hp, s.p[me].board[0].max, s.p[me].board[1].hp], [4, 4, 5]);
  s = g.act(s, play(0)); // 1 to every unit: mortal 3/4, banner 4/5
  assert.deepEqual([s.p[me].board[0].hp, s.p[me].board[1].hp], [3, 4]);
  // Silence the banner (from the other side): the mortal drops to max 2, health 2; the banner itself to 3 max.
  s.turn = foe;
  g.hand(s, foe, 'hush');
  s = g.act(s, play(0, enemyUnit(1)));
  assert.deepEqual(s.p[me].board.map((u) => [u.hp, u.max]), [[2, 2], [3, 3]]);
  assert.equal(s.p[me].board[1].silenced, true);

  // A conditional aura on itself: the veteran hits harder once its champion is low.
  ({ s, me, foe } = g.fresh());
  g.hand(s, me, 'veteran');
  s = g.act(s, play(0));
  assert.equal(s.p[me].board[0].atk, 2);
  s.p[me].life = 9;
  g.hand(s, me, 'nick');
  s = g.act(s, play(0));
  assert.equal(s.p[me].board[0].atk, 4);
});

test('filters: chosen targets must match, automatic ones skip what does not', () => {
  const g = setup([
    unit('wyrm', 5, 6, { cost: 6, abilities: [{ on: 'play', effect: { op: 'destroy', target: 'enemy-unit', filter: { attackAtMost: 3 } } }] }),
    unit('small', 2, 2, { element: 'fire' }),
    unit('big', 6, 6, { element: 'water' }),
    spell('sweep', { op: 'damage', amount: 2, target: 'all-enemy-units', filter: { element: 'fire' } }),
  ]);
  let { s, me, foe } = g.fresh();
  g.put(s, foe, 'big'); g.put(s, foe, 'small');
  g.hand(s, me, 'wyrm');
  assert.equal(g.rules.isLegal(s, play(0, enemyUnit(0))), false);
  s = g.act(s, play(0, enemyUnit(1)));
  assert.deepEqual(g.ids(s, foe), ['big']);
  // Nothing matches: the ability fizzles and the unit is still played with target 0.
  ({ s, me, foe } = g.fresh());
  g.put(s, foe, 'big');
  g.hand(s, me, 'wyrm');
  assert.equal(g.rules.isLegal(s, play(0, enemyUnit(0))), false);
  s = g.act(s, play(0, 0));
  assert.deepEqual([g.ids(s, me), g.ids(s, foe)], [['wyrm'], ['big']]);
  // Automatic: only the fire unit is hit.
  ({ s, me, foe } = g.fresh());
  g.put(s, foe, 'big'); g.put(s, foe, 'small');
  g.hand(s, me, 'sweep');
  s = g.act(s, play(0));
  assert.deepEqual(g.ids(s, foe), ['big']);
  assert.equal(s.p[foe].board[0].hp, 6);
});

test('destroy goes through shields; silence strips keywords and abilities but keeps buffs', () => {
  const g = setup([
    unit('knight', 3, 3, { keywords: ['shield', 'guard'], abilities: [{ on: 'death', effect: { op: 'damage', amount: 5 } }] }),
    unit('ghost', 2, 2, { keywords: ['elusive'] }),
    unit('adder', 1, 3, { keywords: ['poison'] }),
    unit('ogre', 4, 9),
    spell('execute', { op: 'destroy' }),
    spell('hush', { op: 'silence', target: 'any-unit' }),
    spell('hush-all', { op: 'silence', target: 'all-enemy-units' }),
    spell('bolt', { op: 'damage', amount: 1, target: 'enemy-unit' }),
  ]);
  let { s, me, foe } = g.fresh();
  g.put(s, foe, 'knight');
  g.hand(s, me, 'execute');
  s = g.act(s, play(0, enemyUnit(0)));
  assert.deepEqual(g.ids(s, foe), []);
  // Its death ability fired (5 to my champion).
  assert.equal(s.p[me].life, 15);

  // Silenced: no shield, no guard, no death ability; a buff on it stays.
  ({ s, me, foe } = g.fresh());
  const k = g.put(s, foe, 'knight');
  k.atk += 2;
  g.put(s, me, 'ogre');
  g.hand(s, me, 'hush'); g.hand(s, me, 'execute');
  s = g.act(s, play(0, enemyUnit(0)));
  assert.deepEqual([s.p[foe].board[0].shield, s.p[foe].board[0].guard, s.p[foe].board[0].atk], [false, false, 5]);
  s = g.act(s, play(0, enemyUnit(0)));
  assert.equal(s.p[me].life, 20);

  // Elusive can't be chosen until silenced by an area effect; a silenced adder no longer poisons.
  ({ s, me, foe } = g.fresh());
  g.put(s, foe, 'ghost'); g.put(s, foe, 'adder');
  g.put(s, me, 'ogre');
  g.hand(s, me, 'bolt'); g.hand(s, me, 'hush-all');
  assert.equal(g.rules.isLegal(s, play(0, enemyUnit(0))), false);
  s = g.act(s, play(1));
  assert.equal(g.rules.isLegal(s, play(0, enemyUnit(0))), true);
  s.turn = foe;
  s.p[foe].board[1].ready = true;
  s = g.act(s, attack(1, enemyUnit(0)));
  assert.deepEqual(g.ids(s, me), ['ogre']);
  assert.equal(s.p[me].board[0].hp, 8);
});

test('freeze: a frozen unit misses its owner\'s next turn, then thaws', () => {
  const g = setup([
    unit('ogre', 4, 9),
    spell('chill', { op: 'freeze', target: 'enemy-unit' }),
    spell('self-chill', { op: 'freeze', target: 'own-unit' }),
  ]);
  let { s, me, foe } = g.fresh();
  const T = s.turnNo;
  g.put(s, foe, 'ogre');
  g.hand(s, me, 'chill');
  s = g.act(s, play(0, enemyUnit(0)));
  assert.equal(s.p[foe].board[0].frozen, T + 1);
  s = g.act(s, endTurn());
  assert.equal(g.rules.isLegal(s, attack(0, 0)), false);
  s = g.act(s, endTurn());
  assert.equal(s.p[foe].board[0].frozen, undefined);
  s = g.act(s, endTurn());
  assert.equal(g.rules.isLegal(s, attack(0, 0)), true);

  // Frozen on its owner's own turn: it can't attack now, nor on the owner's next turn.
  ({ s, me, foe } = g.fresh());
  g.put(s, me, 'ogre');
  g.hand(s, me, 'self-chill');
  s = g.act(s, play(0, ownUnit(0)));
  assert.equal(g.rules.isLegal(s, attack(0, 0)), false);
  s = g.act(s, endTurn());
  s = g.act(s, endTurn());
  assert.equal(g.rules.isLegal(s, attack(0, 0)), false);
  s = g.act(s, endTurn());
  s = g.act(s, endTurn());
  assert.equal(g.rules.isLegal(s, attack(0, 0)), true);
});

test('bounce returns the card to its owner\'s hand without dying; break removes the oldest relics', () => {
  const g = setup([
    unit('ogre', 4, 9, { abilities: [{ on: 'death', effect: { op: 'damage', amount: 5 } }] }),
    unit('mourner', 1, 5, { abilities: [{ on: 'allyDeath', effect: { op: 'draw', amount: 1 } }] }),
    spell('unmake', { op: 'bounce', target: 'any-unit' }),
    { id: 'idol', name: 'idol', type: 'relic', element: 'neutral', cost: 1, effect: { op: 'heal', amount: 1 }, rarity: 'common' },
    { id: 'totem', name: 'totem', type: 'relic', element: 'neutral', cost: 1, effect: { op: 'damage', amount: 1 }, rarity: 'common' },
    spell('shatter', { op: 'break' }),
  ]);
  let { s, me, foe } = g.fresh();
  const ogre = g.put(s, foe, 'ogre');
  ogre.atk += 3; ogre.hp = 2;
  g.put(s, foe, 'mourner');
  g.hand(s, me, 'unmake');
  s = g.act(s, play(0, enemyUnit(0)));
  assert.deepEqual(g.ids(s, foe), ['mourner']);
  assert.deepEqual(s.p[foe].hand, [g.idx('ogre')]);
  // No death ability (my life unchanged), no ally-death draw.
  assert.equal(s.p[me].life, 20);
  // A full hand burns the bounced card.
  ({ s, me, foe } = g.fresh());
  g.put(s, foe, 'ogre');
  s.p[foe].hand = Array.from({ length: g.cfg.rules.handLimit }, () => g.idx('shatter'));
  g.hand(s, me, 'unmake');
  s = g.act(s, play(0, enemyUnit(0)));
  assert.deepEqual([g.ids(s, foe), s.p[foe].hand.includes(g.idx('ogre'))], [[], false]);

  ({ s, me, foe } = g.fresh());
  s.p[foe].relics = [g.idx('idol'), g.idx('totem')];
  g.hand(s, me, 'shatter');
  s = g.act(s, play(0));
  assert.deepEqual(s.p[foe].relics, [g.idx('totem')]);
});

test('new triggers: turnEnd, damaged (even when it dies) and allyDeath', () => {
  const g = setup([
    unit('tender', 1, 4, { abilities: [{ on: 'turnEnd', effect: { op: 'heal', amount: 2 } }] }),
    unit('acolyte', 1, 2, { abilities: [{ on: 'damaged', effect: { op: 'draw', amount: 1 } }] }),
    unit('mourner', 1, 5, { abilities: [{ on: 'allyDeath', effect: { op: 'buff', attack: 2, target: 'this' } }] }),
    unit('pricker', 1, 3, { abilities: [{ on: 'damaged', effect: { op: 'damage', amount: 1, target: 'all-enemy-units' } }] }),
    spell('bolt', { op: 'damage', amount: 1, target: 'enemy-unit' }),
    spell('blast', { op: 'damage', amount: 5, target: 'enemy-unit' }),
    spell('nova', { op: 'damage', amount: 1, target: 'all-units' }),
  ]);
  // turnEnd heals at the end of its owner's turn only.
  let { s, me, foe } = g.fresh();
  g.put(s, me, 'tender');
  s.p[me].life = 10;
  s = g.act(s, endTurn());
  assert.equal(s.p[me].life, 12);
  s = g.act(s, endTurn());
  assert.equal(s.p[me].life, 12);

  // damaged: one draw for surviving a hit, one more for the hit that kills it.
  ({ s, me, foe } = g.fresh());
  g.put(s, foe, 'acolyte'); g.put(s, foe, 'mourner');
  g.hand(s, me, 'bolt'); g.hand(s, me, 'blast');
  s = g.act(s, play(0, enemyUnit(0)));
  assert.equal(s.p[foe].hand.length, 1);
  s = g.act(s, play(0, enemyUnit(0)));
  assert.equal(s.p[foe].hand.length, 2);
  // allyDeath: the mourner grew when the acolyte died.
  assert.deepEqual(g.ids(s, foe), ['mourner']);
  assert.equal(s.p[foe].board[0].atk, 3);

  // Damaged triggers chain through the settle: two prickers set each other off, bounded by MAX_CHAIN.
  ({ s, me, foe } = g.fresh());
  g.put(s, me, 'pricker'); g.put(s, foe, 'pricker');
  g.hand(s, me, 'nova');
  s = g.act(s, play(0));
  assert.deepEqual([g.ids(s, me), g.ids(s, foe)], [[], []]);
});

test('unitAttack.minCost: champions only boost units that cost at least that much', () => {
  const g = setup([unit('cheap', 1, 1, { cost: 1 }), unit('dear', 3, 3, { cost: 3 }), unit('token', 1, 1, { cost: 0, deckable: false }), spell('call', { op: 'summon', card: 'token' })], (cfg) => {
    cfg.champion = { ...cfg.champion, unitAttack: { stat: 'strength', min: 1, max: 1, minCost: 2 } };
  });
  let { s, me } = g.fresh();
  for (const p of s.p) p.unitAttack = 1;
  g.hand(s, me, 'cheap'); g.hand(s, me, 'dear'); g.hand(s, me, 'call');
  s = g.act(s, play(0));
  s = g.act(s, play(0));
  s = g.act(s, play(0));
  assert.deepEqual(s.p[me].board.map((u) => u.atk), [1, 4, 1]);
  // Without minCost every unit gets it, as before.
  const old = setup([unit('cheap', 1, 1, { cost: 1 }), unit('filler', 1, 1)], (cfg) => { cfg.champion = { ...cfg.champion, unitAttack: { stat: 'strength', min: 1, max: 1 } }; });
  ({ s, me } = old.fresh());
  for (const p of s.p) p.unitAttack = 1;
  old.hand(s, me, 'cheap');
  s = old.act(s, play(0));
  assert.equal(s.p[me].board[0].atk, 2);
});

test('deckable: false keeps a token out of every deck', () => {
  const rules = createRules(compileGame(DEMO));
  const wisp = rules.game.cardIndex['spirit-wisp'];
  assert.equal(DEMO.cards[wisp].deckable, false);
  // The rules refuse to declare it.
  const s = rules.init('decks', ['a', 'b'], {});
  assert.equal(rules.isLegal(s, declare(wisp), 0), false);
  assert.ok(!rules.legalActions(s, 0).includes(declare(wisp)));
  assert.ok(!rules.game.suggestedDeck.includes(wisp));
  // The Gauntlet never deals or offers it; random sim decks never hold it (their declarations all land).
  const gauntlet = createGauntlet(rules);
  for (let i = 0; i < 20; i++) {
    const run = gauntlet.start(`run-${i}`);
    assert.ok(!run.deck.includes(wisp));
  }
  const report = simulate(DEMO, { matches: 10, decks: 'random' });
  assert.equal(report.mismatches, 0);
  // A deck that lists it is invalid.
  const bad = { ...DEMO, deck: { ...DEMO.deck, 'spirit-wisp': 1 } };
  assert.ok(validateGame(bad).some((e) => e.includes('spirit-wisp') && e.includes('deckable: false')));
});

test('validation explains bad synergy configs', () => {
  const base = DEMO;
  const withCard = (patch: Partial<CardDef>, id = 'village-recruit'): string[] => validateGame({ ...base, cards: base.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const has = (errs: string[], text: string): void => assert.ok(errs.some((e) => e.includes(text)), `expected an error with ${JSON.stringify(text)} in ${JSON.stringify(errs)}`);
  has(withCard({ abilities: [{ on: 'play', if: {}, effect: { op: 'draw', amount: 1 } }] }), 'if needs at least one of');
  has(withCard({ abilities: [{ on: 'play', if: { allies: { kind: 'Dragon' } }, effect: { op: 'draw', amount: 1 } }] }), 'is no card\'s kind');
  has(withCard({ abilities: [{ on: 'play', if: { allies: { element: 'void' } }, effect: { op: 'draw', amount: 1 } }] }), 'is not an element of this game');
  has(withCard({ abilities: [{ on: 'play', if: { allies: { count: 9 } }, effect: { op: 'draw', amount: 1 } }] }), 'count must be an integer 1-5');
  has(withCard({ abilities: [{ on: 'play', if: { lifeAtMost: 0 } as never, effect: { op: 'draw', amount: 1 } }] }), 'lifeAtMost must be an integer 1-999');
  has(withCard({ abilities: [{ on: 'play', if: { mana: 3 } as never, effect: { op: 'draw', amount: 1 } }] }), 'unknown field "mana"');
  has(withCard({ abilities: [{ on: 'whenever' as never, effect: { op: 'draw', amount: 1 } }] }), 'ability trigger must be one of');
  has(withCard({ abilities: [{ on: 'turnEnd', effect: { op: 'destroy', target: 'enemy-unit' } }] }), 'needs a choice');
  has(withCard({ abilities: [{ on: 'play', effect: { op: 'damage', amount: 2, filter: { kind: 'King' } } }] }), 'filter needs a unit target');
  has(withCard({ abilities: [{ on: 'play', effect: { op: 'break', count: 7 } }] }), 'break count must be 1-5');
  has(withCard({ aura: { attack: 0 } }), 'aura needs attack and/or health');
  has(withCard({ aura: { attack: 1, to: 'enemies' as never } }), 'aura.to must be');
  has(withCard({ aura: { attack: 1, filter: { attackAtMost: 2 } } }), 'aura.filter has unknown field "attackAtMost"');
  has(withCard({ aura: { attack: 1 } }, 'spark'), 'only units have an aura');
  has(withCard({ deckable: 'no' as never }), 'deckable must be true or false');
  has(validateGame({ ...base, champion: { ...base.champion, unitAttack: { ...base.champion.unitAttack, minCost: -1 } } }), 'unitAttack.minCost must be');
  has(validateGame({ ...base, champion: { ...base.champion, life: { ...base.champion.life, minCost: 2 } as never } }), 'only unitAttack takes a minCost');
});

test('card text covers conditions, auras, filters and the new ops', () => {
  const name = (id: string): string => DEMO.cards.find((c) => c.id === id)?.name ?? id;
  const text = (id: string): string => describeCard(DEMO.cards.find((c) => c.id === id)!, name).join(' / ');
  assert.equal(text('ember-squire'), 'On play, if you control another unit of its element: +1/+1 to itself');
  assert.equal(text('king-of-embers'), 'Your other Mortal units have +1/+0');
  assert.equal(text('last-stand-veteran'), 'Has +2/+0 while your champion has 12 or less life');
  assert.equal(text('gravewyrm'), 'On play: Destroy an enemy unit with 3 or less attack');
  assert.equal(text('wind-trickster'), 'On play: Return an enemy unit with 3 or less health to hand');
  assert.equal(text('tide-king'), 'End of turn: +0/+1 to your Mortal units / On play, if you control 2 other Mortal units: Draw 1');
  assert.equal(text('deep-freeze'), 'Freeze all enemy units');
  assert.equal(text('shatter'), 'Break 2 enemy relics');
  assert.equal(text('stone-warden'), 'Guard / When an ally dies: +1/+1 to itself');
  assert.equal(text('tide-acolyte'), 'When damaged: Draw 1');
  // "a" becomes "an" before a vowel.
  assert.equal(describeCard(spell('x', { op: 'silence', target: 'any-unit', filter: { element: 'earth' } })).join(), 'Silence an Earth unit');
});

test('the demo game: bots play it to the end, replays match, and old games never carry the new state fields', () => {
  const rules = createRules(compileGame(DEMO));
  const bot = greedyBot(rules);
  let sawAura = false, sawFrozen = false, sawSilenced = false;
  for (let m = 0; m < 12; m++) {
    let s = rules.init(`demo-${m}`, ['a', 'b'], {});
    const log: Array<Record<string, number>> = [];
    while (!s.over) {
      const input = s.phase === 'decks' ? { a: bot(s, 0), b: bot(s, 1) } : { [s.p[s.turn].id]: bot(s) };
      log.push(input);
      s = rules.step(s, input);
      for (const p of s.p) for (const u of p.board) { sawAura ||= !!u.aura; sawFrozen ||= u.frozen !== undefined; sawSilenced ||= !!u.silenced; }
    }
    let r = rules.init(`demo-${m}`, ['a', 'b'], {});
    for (const input of log) r = rules.step(r, input);
    assert.deepEqual(r, s);
  }
  assert.ok(sawAura && sawFrozen && sawSilenced, 'the bot uses auras, freeze and silence in the demo');

  const old = createRules(compileGame(STARTER));
  const oldBot = greedyBot(old);
  let s = old.init('old', ['a', 'b'], {});
  while (!s.over) {
    s = old.step(s, { [s.p[s.turn].id]: oldBot(s) });
    for (const p of s.p) for (const u of p.board) assert.deepEqual(Object.keys(u).sort(), ['atk', 'c', 'fresh', 'guard', 'hp', 'max', 'ready', 'shield']);
  }
});

test('the bot breaks relics only when there are some, and removes the biggest threat', () => {
  const g = setup([
    unit('ogre', 6, 6),
    unit('imp', 1, 1),
    spell('shatter', { op: 'break' }),
    spell('execute', { op: 'destroy' }, { cost: 3 }),
    { id: 'totem', name: 'totem', type: 'relic', element: 'neutral', cost: 1, effect: { op: 'damage', amount: 1 }, rarity: 'common' },
  ]);
  const bot = greedyBot(g.rules);
  let { s, me, foe } = g.fresh();
  g.hand(s, me, 'shatter');
  assert.equal(bot(s), endTurn());
  s.p[foe].relics = [g.idx('totem')];
  assert.equal(bot(s), play(0));
  ({ s, me, foe } = g.fresh());
  g.put(s, foe, 'imp'); g.put(s, foe, 'ogre');
  g.hand(s, me, 'execute');
  assert.equal(bot(s), play(0, enemyUnit(1)));
});
