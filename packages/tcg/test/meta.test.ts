import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LocalBotSession, PuzzleSession } from '../src/client/session';
import { compileGame, createRules, endTurn, greedyBot, validateGame } from '../src/core/index';
import type { GameConfig, MatchState } from '../src/core/index';
import { addMatch, createGauntlet, createPuzzles, emptyProfile, loadProfile, MAX_MATCHES, saveProfile, STAGES, summarize } from '../src/meta/index';
import type { MatchEntry, Store } from '../src/meta/index';

const load = (p: string): GameConfig => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as GameConfig;
const SAMPLE = createRules(compileGame(load('./fixtures/sample-duel.game.json')));
const STARTER = createRules(compileGame(load('../templates/starter.game.json')));
const memory = (): Store & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } }; };
const match = (result: MatchEntry['result'], extra: Partial<MatchEntry> = {}): MatchEntry => ({ at: 0, mode: 'practice', result, turns: 10, ruleset: 'g.v1', ...extra });

test('profile: history newest first, capped; streaks; per-champion records; survives storage round trips', () => {
  let p = emptyProfile('g');
  for (const r of ['win', 'win', 'loss', 'win', 'win', 'win'] as const) p = addMatch(p, match(r, { champion: r === 'loss' ? '2' : '1' }));
  const s = summarize(p);
  assert.deepEqual([s.played, s.wins, s.losses, s.streak, s.bestStreak], [6, 5, 1, 3, 3]);
  assert.deepEqual(s.byChampion[0], { champion: '1', played: 5, wins: 5 });
  for (let i = 0; i < MAX_MATCHES + 5; i++) p = addMatch(p, match('loss'));
  assert.equal(p.matches.length, MAX_MATCHES);
  const store = memory();
  saveProfile(store, p);
  assert.deepEqual(loadProfile(store, 'g.v7'), p, 'a profile outlives ruleset versions');
  store.data.set('deckwright.profile.g', '{not json');
  assert.deepEqual(loadProfile(store, 'g.v1'), emptyProfile('g'), 'unreadable storage starts fresh');
});

test('profile: the puzzle streak counts consecutive days back from today (or yesterday)', () => {
  const day = (d: string) => Date.parse(`${d}T12:00:00Z`);
  const p = { ...emptyProfile('g'), puzzles: { '2026-10-20': { at: 0, actions: 3 }, '2026-10-22': { at: 0, actions: 3 }, '2026-10-23': { at: 0, actions: 2 } } };
  assert.equal(summarize(p, day('2026-10-23')).puzzleStreak, 2);
  assert.equal(summarize(p, day('2026-10-24')).puzzleStreak, 2, 'today not solved yet: the streak still stands');
  assert.equal(summarize(p, day('2026-10-25')).puzzleStreak, 0);
});

test('Gauntlet: legal decks, rising opponents, rewards that keep the deck legal, and the run ends on a loss or after eight', () => {
  const g = createGauntlet(SAMPLE);
  const dr = SAMPLE.game.config.deckRules!;
  const legal = (deck: number[]) => deck.length === dr.size && deck.every((c) => deck.filter((d) => d === c).length <= dr.maxCopies);
  let run = g.start('seed-1', { tokenId: SAMPLE.game.cards.find((c) => c.token)!.token!.tokenId, stats: { resilience: 30000 } });
  assert.deepEqual(g.start('seed-1', { tokenId: run.champion.tokenId, stats: { resilience: 30000 } }, run.started), run, 'deterministic from the seed');
  assert.ok(legal(run.deck));
  const levels: number[] = [];
  for (let stage = 1; stage <= STAGES; stage++) {
    const opp = g.opponent(run);
    assert.equal(opp.stage, stage);
    assert.ok(legal(opp.deck));
    levels.push(opp.level);
    run = g.result(run, true);
    if (stage < STAGES) {
      assert.equal(run.offers.length, 3);
      const card = run.offers.findIndex((o) => o.kind === 'card');
      run = g.choose(run, card >= 0 ? card : 0);
      assert.ok(legal(run.deck), `deck stays legal after stage ${stage}`);
    }
  }
  assert.deepEqual([run.over, run.cleared, run.wins], [true, true, STAGES]);
  assert.deepEqual(levels, [1, 1, 2, 2, 2, 2, 3, 3]);
  const lost = g.result(g.start('seed-2'), false);
  assert.deepEqual([lost.over, lost.cleared], [true, false]);
});

test('Gauntlet: blessings raise the champion stats that go into init, and fixed-deck games offer blessings only', () => {
  const g = createGauntlet(STARTER);
  let run = g.result(g.start('s'), true);
  assert.deepEqual(run.deck, []);
  assert.ok(run.offers.every((o) => o.kind === 'bless'));
  const pick = run.offers[0] as { stat: 'strength'; amount: number };
  run = g.choose(run, 0);
  assert.equal(g.player(run).stats[pick.stat], pick.amount);
  assert.ok(STARTER.champion(g.player(run).stats).life >= STARTER.champion().life);
});

test('Gauntlet: one attempt per stage; a match that starts and never reports a result is a loss', () => {
  const g = createGauntlet(SAMPLE);
  const run = g.start('forfeit');
  assert.equal(g.forfeit(run), run, 'nothing under way: nothing to settle');
  const fighting = g.fight(run);
  assert.equal(fighting.fighting, 1);
  const lost = g.forfeit(fighting);
  assert.deepEqual([lost.over, lost.cleared, lost.wins, 'fighting' in lost], [true, false, 0, false]);
  const won = g.result(fighting, true);
  assert.ok(!('fighting' in won) && won.offers.length > 0, 'a reported result clears the mark');
  assert.equal(g.forfeit(won), won, 'a match that reported its result is never forfeited');
  assert.equal(g.fight(won), won, 'no match starts while a reward is waiting');
});

test('Gauntlet: every blessing offered changes a number the match uses, and none is offered once a stat is spent', () => {
  for (const rules of [SAMPLE, STARTER]) {
    const g = createGauntlet(rules);
    for (const champion of [undefined, { stats: { strength: 30000, agility: 32000, resilience: 40000, intelligence: 10 } }]) {
      let run = g.start(`bless-${champion ? 'c' : 'base'}`, champion);
      for (let stage = 1; stage < STAGES; stage++) {
        run = g.result(run, true);
        for (const o of run.offers.filter((x) => x.kind === 'bless')) {
          const gains = g.gains(run, o);
          assert.ok(Object.keys(gains).length > 0 && Object.values(gains).every((n) => n! > 0), `stage ${stage}: ${o.kind === 'bless' ? o.stat : ''} blessing gains ${JSON.stringify(gains)}`);
        }
        const b = run.offers.findIndex((x) => x.kind === 'bless');
        run = g.choose(run, b >= 0 ? b : 0);
      }
      // A base champion blessed every time ends with numbers well above its own.
      const before = rules.champion(champion?.stats), after = rules.champion(g.player(run).stats);
      assert.ok(after.life + after.spellPower + after.unitAttack + after.openingHand > before.life + before.spellPower + before.unitAttack + before.openingHand);
      assert.deepEqual(g.blessed(run), Object.fromEntries((['life', 'spellPower', 'unitAttack', 'openingHand'] as const).filter((k) => after[k] !== before[k]).map((k) => [k, after[k] - before[k]])));
    }
    // A champion at the top of every range has nothing left to bless.
    const max = { strength: 65535, agility: 65535, resilience: 65535, intelligence: 65535 };
    assert.ok(g.result(g.start('max', { stats: max }), true).offers.every((o) => o.kind === 'card'));
  }
});

test('Gauntlet: card offers skip summon-only tokens, suggest a like-for-like swap, and let you pick the card to give up', () => {
  const g = createGauntlet(SAMPLE);
  const { cards, deckList } = SAMPLE.game;
  const summonedOnly = new Set<number>();
  const walk = (n: unknown): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { const o = n as Record<string, unknown>; if (o.op === 'summon') { const i = cards.findIndex((c) => c.id === o.card); if (i >= 0 && !deckList.includes(i)) summonedOnly.add(i); } Object.values(o).forEach(walk); } };
  walk(SAMPLE.game.config);
  assert.ok(summonedOnly.size > 0, 'the fixture has summon-only tokens');
  for (let r = 0; r < 40; r++) {
    let run = g.start(`cards-${r}`);
    assert.ok(run.deck.every((c) => !summonedOnly.has(c)), 'no token in a starting deck');
    for (let stage = 1; stage < STAGES; stage++) {
      assert.ok(g.opponent(run).deck.every((c) => !summonedOnly.has(c)), 'no token in a foe deck');
      run = g.result(run, true);
      for (const o of run.offers) if (o.kind === 'card') {
        assert.ok(!summonedOnly.has(o.card), `token ${cards[o.card].id} offered`);
        assert.ok(run.deck.includes(o.replaces) && o.replaces !== o.card);
      }
      const i = run.offers.findIndex((o) => o.kind === 'card');
      if (i < 0) { run = g.choose(run, 0); continue; }
      const offer = run.offers[i] as { card: number; replaces: number };
      // The player gives up a card of their choosing instead of the suggestion.
      const mine = run.deck.find((c) => c !== offer.card && c !== offer.replaces)!;
      const before = run.deck.filter((c) => c === mine).length;
      run = g.choose(run, i, mine);
      assert.equal(run.deck.filter((c) => c === mine).length, before - 1);
      assert.ok(run.deck.includes(offer.card));
    }
  }
  // A replacement that isn't in the deck (or is the card itself) falls back to the suggestion.
  const run = g.result(g.start('fallback'), true);
  const i = run.offers.findIndex((o) => o.kind === 'card');
  const offer = run.offers[i] as { card: number; replaces: number };
  for (const bad of [offer.card, -1, 9999]) assert.deepEqual(g.choose(run, i, bad), g.choose(run, i));
});

test('Gauntlet matches: the bot plays the opponent deck it was given', () => {
  const g = createGauntlet(SAMPLE);
  const run = g.start('decks');
  const opp = g.opponent(run), me = g.player(run);
  const s = new LocalBotSession(SAMPLE, 'decks-1', me, opp, { level: opp.level, foeDeck: opp.deck });
  s.declareDeck(me.deck);
  s.close();
  assert.deepEqual([...s.state!.decl![1]].sort(), [...opp.deck].sort());
});

test('daily puzzle: the same for everyone on a date, solvable by the bot, failed by ending the turn, retryable', () => {
  for (const rules of [SAMPLE, STARTER]) {
    const P = createPuzzles(rules);
    const p = P.daily('2026-10-24')!;
    assert.ok(p, 'a puzzle exists');
    assert.deepEqual(P.daily('2026-10-24'), p, 'deterministic');
    assert.ok(p.par >= 2 && p.odds <= 0.35);
    // The bot that produced it wins again from the same position.
    const bot = greedyBot(rules);
    let s: MatchState = P.opening(p);
    for (let n = 0; n < 40 && P.status(p, s) === 'playing'; n++) s = rules.step(s, { [p.participants[p.side]]: bot(s) });
    assert.equal(P.status(p, s), 'solved');
    // In a session: ending the turn fails it, retry goes back to the start of the turn.
    const session = new PuzzleSession(rules, p);
    session.act(endTurn());
    assert.equal(P.status(p, session.state!), 'failed');
    session.retry();
    assert.equal(P.status(p, session.state!), 'playing');
    assert.equal(session.actions, 0);
    assert.deepEqual(validateGame(rules.game.config), []);
  }
});

test('bot levels: deterministic at every level, and they play differently', () => {
  const run = (level: 1 | 2 | 3) => {
    const bot = greedyBot(STARTER, { level });
    let s = STARTER.init('levels', ['a', 'b'], {});
    const log: number[] = [];
    while (!s.over && s.turnNo < 8) { const x = bot(s); log.push(x); s = STARTER.step(s, { [s.p[s.turn].id]: x }); }
    return log;
  };
  for (const l of [1, 2, 3] as const) assert.deepEqual(run(l), run(l));
  assert.notDeepEqual(run(1), run(2));
});
