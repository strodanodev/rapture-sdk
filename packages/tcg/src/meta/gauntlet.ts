/**
 * The Gauntlet: a run of eight bot matches of rising difficulty. Win and you pick a reward, lose and the run
 * ends. Everything is seeded from the run's seed, so a run can be resumed, shared and replayed. Rewards
 * never touch the rules:
 * - a card swap (declared-deck games): the picked card replaces a card in your deck (a suggested one, or
 *   any card you choose);
 * - a blessing: just enough of one stat to raise something your champion brings to a match (life, spell
 *   power, unit attack, opening hand), and it goes into `init` like any hydrated stat.
 * So every Gauntlet match replays under the game's own rulesetId. Kernel-compatible: only the deck and
 * reward pools are card-game specific.
 *
 * One life means one attempt: `fight` marks the match as under way before it starts, and a match that never
 * reports a result (left mid-match, the page closed) is settled as a loss by `forfeit`.
 */
import { seededRandom } from '../core/rng';
import type { Rules } from '../core/rules';
import { normalizeStats } from '../core/champion';
import type { BotLevel } from '../core/bot';
import type { AgentStats, StatName } from '../core/types';

export const STAGES = 8;
const STATS: StatName[] = ['strength', 'agility', 'resilience', 'intelligence'];
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
/** What a champion brings to a match (`Rules['champion']`): the numbers a blessing can raise. */
export type ChampionNumber = 'life' | 'spellPower' | 'unitAttack' | 'openingHand';
const NUMBERS: ChampionNumber[] = ['life', 'spellPower', 'unitAttack', 'openingHand'];
export type Gains = Partial<Record<ChampionNumber, number>>;

export interface GauntletRun {
  v: 1;
  seed: string;
  /** Matches won so far; the next match is stage `wins + 1`. */
  wins: number;
  over: boolean;
  /** Won all eight. */
  cleared: boolean;
  champion: { tokenId?: string; stats: Required<AgentStats> };
  /** Declared-deck games: your deck (card indices). Empty for fixed-deck games. */
  deck: number[];
  blessings: Partial<Record<StatName, number>>;
  /** Rewards to choose from after a win; empty while a match is next. */
  offers: Reward[];
  started: number;
  /** The stage whose match has started and not reported a result. A run left like this is forfeited. */
  fighting?: number;
  /** Set once a finished run has been added to the profile's totals. */
  counted?: boolean;
}

export type Reward =
  /** `replaces` is the suggested card to give up; `choose` takes any other card in the deck instead. */
  | { kind: 'card'; card: number; replaces: number }
  | { kind: 'bless'; stat: StatName; amount: number };

export interface Opponent {
  stage: number;
  name: string;
  level: BotLevel;
  tokenId?: string;
  stats: Required<AgentStats>;
  /** Declared-deck games: the opponent's deck. */
  deck: number[];
}

const rarityRank = (r: string | undefined, cost: number): number => { const i = RARITY.indexOf(r ?? ''); return i >= 0 ? i : Math.min(4, Math.max(0, cost - 1)); };
const STAGE_NAMES = ['Squire', 'Raider', 'Warden', 'Duelist', 'Champion', 'Warlord', 'Ascendant', 'The Forgemaster'];

/** Card ids some effect summons (cards, abilities, hero powers): tokens, unless the default deck also holds them. */
function summoned(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const x of node) summoned(x, out);
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.op === 'summon' && typeof o.card === 'string') out.add(o.card);
    for (const v of Object.values(o)) summoned(v, out);
  }
  return out;
}

export function createGauntlet(rules: Rules) {
  const { cards, config, deckList } = rules.game;
  const dr = config.deckRules?.mode === 'declared' ? config.deckRules : null;
  const rank = (c: number): number => rarityRank(cards[c].rarity, cards[c].cost);
  const tokens = cards.map((c, i) => (c.token ? i : -1)).filter((i) => i >= 0);
  // Summon-only tokens (a Construct a hero power makes, or any card marked deckable: false) are not deck cards:
  // never dealt into a deck or offered.
  const inDefault = new Set(deckList);
  const tokenIds = summoned([config.cards, config.champion.powers ?? []]);
  const pool = cards.map((_, i) => i).filter((i) => cards[i].deckable !== false && (inDefault.has(i) || !tokenIds.has(cards[i].id)));

  /** A legal deck of `size` cards drawn from cards whose rarity rank is at most `maxRank`, at most maxCopies each. */
  const deckFrom = (rnd: () => number, maxRank: number): number[] => {
    if (!dr) return [];
    const list = pool.filter((c) => rank(c) <= maxRank).flatMap((c) => Array.from({ length: dr.maxCopies }, () => c));
    for (let i = list.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    const deck = list.slice(0, dr.size);
    // Too few low-rarity cards: top up from the suggested deck so the deck is always legal.
    for (const c of rules.game.suggestedDeck) if (deck.length < dr.size && deck.filter((d) => d === c).length < dr.maxCopies) deck.push(c);
    return deck;
  };

  const championStats = (run: Pick<GauntletRun, 'champion' | 'blessings'>): Required<AgentStats> => {
    const s = { ...run.champion.stats };
    for (const k of STATS) s[k] = Math.min(65535, s[k] + (run.blessings[k] ?? 0));
    return s;
  };

  const gainsOf = (before: Required<AgentStats>, after: Required<AgentStats>): Gains => {
    const a = rules.champion(before), b = rules.champion(after);
    const out: Gains = {};
    for (const k of NUMBERS) if (b[k] !== a[k]) out[k] = b[k] - a[k];
    return out;
  };

  /**
   * The smallest raise of `stat` that lifts something the champion brings to a match, or 0 when nothing can
   * rise (every number on that stat is at its maximum). Stat ranges are 0-65535 but the numbers they map to
   * are small (life 20-23, say), so a fixed-size blessing often changed nothing; this one always does.
   */
  const blessingFor = (stats: Required<AgentStats>, stat: StatName): number => {
    const now = rules.champion(stats);
    let best = 0;
    for (const k of NUMBERS) {
      const m = config.champion[k];
      if (m.stat !== stat || m.max <= m.min || now[k] >= m.max) continue;
      // mapStat rounds min + (max - min) * s / 65535, so the next whole number arrives half a step early.
      let s = Math.max(stats[stat] + 1, Math.ceil(((now[k] + 0.5 - m.min) * 65535) / (m.max - m.min)));
      for (let guard = 0; s <= 65535 && guard < 4 && rules.champion({ ...stats, [stat]: s })[k] <= now[k]; guard++) s++;
      if (s <= 65535 && rules.champion({ ...stats, [stat]: s })[k] > now[k] && (!best || s - stats[stat] < best)) best = s - stats[stat];
    }
    if (!best) return 0;
    const g = gainsOf(stats, { ...stats, [stat]: stats[stat] + best });
    return Object.values(g).some((v) => v! < 0) ? 0 : best;
  };

  /**
   * The card a new one should replace by default: one of lower rarity (else no higher), of the same type and the
   * closest cost, so the deck's curve and unit count hold; ties go to the lowest rarity, then the cheaper card.
   */
  const swapFor = (deck: number[], card: number): number => {
    const others = [...new Set(deck)].filter((c) => c !== card);
    const lower = others.filter((c) => rank(c) < rank(card));
    const pick = lower.length ? lower : others.filter((c) => rank(c) <= rank(card));
    const from = pick.length ? pick : others;
    const key = (c: number): number[] => [cards[c].type === cards[card].type ? 0 : 1, Math.abs(cards[c].cost - cards[card].cost), rank(c), cards[c].cost, c];
    return from.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; })[0] ?? -1;
  };

  const offersFor = (run: GauntletRun): Reward[] => {
    const rnd = seededRandom(`${run.seed}|offers|${run.wins}`);
    const cardOffers: Reward[] = [];
    if (dr && run.deck.length) {
      // Card offers get rarer as the run goes on.
      const minRank = Math.min(4, Math.floor(run.wins / 2));
      const candidates = pool.filter((c) => rank(c) >= minRank && run.deck.filter((d) => d === c).length < dr.maxCopies);
      const seen = new Set<number>();
      for (let tries = 0; cardOffers.length < 3 && tries < 80 && candidates.length; tries++) {
        const card = candidates[rnd() % candidates.length];
        if (seen.has(card)) continue;
        seen.add(card);
        const replaces = swapFor(run.deck, card);
        if (replaces >= 0) cardOffers.push({ kind: 'card', card, replaces });
      }
    }
    // Blessings only for stats that would change something, in a seeded order.
    const stats = championStats(run), order = [...STATS], bless: Reward[] = [];
    while (order.length) {
      const stat = order.splice(rnd() % order.length, 1)[0];
      const amount = blessingFor(stats, stat);
      if (amount) bless.push({ kind: 'bless', stat, amount });
    }
    // Up to two cards and the rest blessings; when blessings run out, more cards fill the three slots.
    const out = cardOffers.slice(0, 2);
    while (out.length < 3 && bless.length) out.push(bless.shift()!);
    for (const c of cardOffers.slice(2)) if (out.length < 3) out.push(c);
    return out;
  };

  /** A run without its `fighting` mark. */
  const settled = (run: GauntletRun): GauntletRun => { const { fighting: _, ...rest } = run; return rest; };

  return {
    stages: STAGES,
    /** A new run with the chosen champion (or none). Declared-deck games start from a deck of commons to rares. */
    start(seed: string, champion?: { tokenId?: string; stats?: AgentStats }, now = Date.now()): GauntletRun {
      return {
        v: 1, seed, wins: 0, over: false, cleared: false,
        champion: { ...(champion?.tokenId ? { tokenId: String(champion.tokenId) } : {}), stats: normalizeStats(champion?.stats) },
        deck: deckFrom(seededRandom(`${seed}|start`), 2),
        blessings: {}, offers: [], started: now,
      };
    },
    /** Who stage `wins + 1` is: stronger stats, rarer decks and a smarter bot as the run goes on. */
    opponent(run: GauntletRun): Opponent {
      const stage = run.wins + 1;
      const rnd = seededRandom(`${run.seed}|stage|${stage}`);
      const tokenId = tokens.length ? cards[tokens[rnd() % tokens.length]].token!.tokenId : undefined;
      const base = Math.min(65535, 4000 + stage * 3500);
      const stats = normalizeStats(Object.fromEntries(STATS.map((k) => [k, base + (rnd() % 8000) - 4000])));
      return { stage, name: STAGE_NAMES[stage - 1] ?? `Stage ${stage}`, level: stage <= 2 ? 1 : stage <= 6 ? 2 : 3, ...(tokenId ? { tokenId: String(tokenId) } : {}), stats, deck: deckFrom(rnd, stage <= 2 ? 1 : stage <= 5 ? 2 : stage <= 7 ? 3 : 4) };
    },
    /** What you bring to the next match: your champion with its blessings, and your deck. */
    player(run: GauntletRun): { tokenId?: string; stats: Required<AgentStats>; deck: number[] } {
      return { ...(run.champion.tokenId ? { tokenId: run.champion.tokenId } : {}), stats: championStats(run), deck: [...run.deck] };
    },
    /** Mark the next match as started: save this before the match begins, so leaving it can't buy a retry. */
    fight(run: GauntletRun): GauntletRun {
      return run.over || run.offers.length ? run : { ...run, fighting: run.wins + 1 };
    },
    /** A match that started and never reported a result counts as a loss. Anything else is unchanged. */
    forfeit(run: GauntletRun): GauntletRun {
      return run.fighting && !run.over ? { ...settled(run), over: true } : run;
    },
    /** Record a match. A win offers rewards (or clears the run after the last stage); a loss or draw ends it. */
    result(run: GauntletRun, won: boolean): GauntletRun {
      if (run.over || run.offers.length) return run;
      if (!won) return { ...settled(run), over: true };
      const wins = run.wins + 1;
      const next = { ...settled(run), wins };
      return wins >= STAGES ? { ...next, over: true, cleared: true } : { ...next, offers: offersFor(next) };
    },
    /**
     * Take one of the offered rewards (index into `run.offers`). For a card, `replaces` may name any other card
     * in the deck to give up instead of the suggested one.
     */
    choose(run: GauntletRun, i: number, replaces?: number): GauntletRun {
      const r = run.offers[i];
      if (!r) return run;
      if (r.kind === 'bless') return { ...run, offers: [], blessings: { ...run.blessings, [r.stat]: (run.blessings[r.stat] ?? 0) + r.amount } };
      const out = replaces !== undefined && replaces !== r.card && run.deck.includes(replaces) ? replaces : r.replaces;
      const deck = [...run.deck];
      const at = deck.indexOf(out);
      if (at >= 0) deck[at] = r.card;
      return { ...run, offers: [], deck };
    },
    /** What a blessing would change for this run's champion, as the match sees it: `{ life: 1 }` and so on. */
    gains(run: GauntletRun, r: Reward): Gains {
      if (r.kind !== 'bless') return {};
      const s = championStats(run);
      return gainsOf(s, { ...s, [r.stat]: Math.min(65535, s[r.stat] + r.amount) });
    },
    /** Everything the run's blessings have changed so far, against the champion's own stats. */
    blessed(run: GauntletRun): Gains {
      return gainsOf(normalizeStats(run.champion.stats), championStats(run));
    },
  };
}
export type Gauntlet = ReturnType<typeof createGauntlet>;
