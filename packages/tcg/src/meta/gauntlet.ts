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
 *
 * Locked runs (meta/unlocks.ts; `start` is given the player's unlocked token ids): the deck is the unlocked
 * collection cards, then the game's stock list of support cards; card rewards are common support cards only;
 * winning UNLOCK_AT stages unlocks one random locked collection card on the spot (`run.unlock`), kept even if
 * the run is lost later. Blessings work as in any run.
 *
 * Dynamic difficulty: a locked run carries the player's `heat`, which shifts every stage's foe (stats, deck
 * rarity, bot level) up or down the ladder. A run that reaches UNLOCK_AT raises heat by one, a run that falls
 * short lowers it (`heatAfter`), so each player settles where they unlock about every other run. Heat 0 is the
 * plain ladder. It never touches the rules: every match still replays under the game's rulesetId.
 */
import { seededRandom } from '../core/rng';
import type { Rules } from '../core/rules';
import { normalizeStats } from '../core/champion';
import type { BotLevel } from '../core/bot';
import type { AgentStats, StatName } from '../core/types';

export const STAGES = 8;
/** A locked run unlocks a collection card when it wins this many stages. */
export const UNLOCK_AT = 3;
/** Heat's range: negative is gentler than the plain ladder, positive is harder. New players start at START_HEAT. */
export const HEAT_MIN = -6, HEAT_MAX = 6, START_HEAT = -2;
const clampHeat = (h: number): number => Math.max(HEAT_MIN, Math.min(HEAT_MAX, Math.round(Number.isFinite(h) ? h : START_HEAT)));
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
  /** A locked run: started with the player's unlocks. */
  locked?: true;
  /** A locked run's difficulty shift (see `heatAfter`); absent means 0, the plain ladder. */
  heat?: number;
  /** The token id this run unlocked when it won UNLOCK_AT stages (absent until then, or when nothing was left). */
  unlock?: string;
}

/** A locked run's settings: the player's unlocked token ids, their heat, and the game's stock list. */
export interface LockedRun {
  unlocked: Iterable<string>;
  heat?: number;
  /** Support cards (indices) that fill the deck after the unlocked collection cards, in order. */
  stock?: number[];
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

  const isSupport = (c: number): boolean => !cards[c].token;
  const unlockedCard = (c: number, unlocked: Set<string>): boolean => unlocked.has(String(cards[c].token!.tokenId));
  /**
   * A locked run's deck: every unlocked collection card (maxCopies each, in a seeded order, as many as fit), then
   * the stock list in order (none given: support cards up to rare, shuffled). Too few: any support card, and last
   * the suggested deck, so the deck is always legal. A new player's deck is their starter plus the stock list.
   */
  const lockedDeck = (rnd: () => number, unlocked: Set<string>, stock?: number[]): number[] => {
    if (!dr) return [];
    const shuffled = (list: number[]): number[] => { for (let i = list.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [list[i], list[j]] = [list[j], list[i]]; } return list; };
    const copies = (c: number): number[] => Array.from({ length: dr.maxCopies }, () => c);
    const deck = shuffled(pool.filter((c) => !isSupport(c) && unlockedCard(c, unlocked))).flatMap(copies).slice(0, dr.size);
    const fill = (list: number[]): void => { for (const c of list) if (deck.length < dr.size && pool.includes(c) && deck.filter((d) => d === c).length < dr.maxCopies) deck.push(c); };
    fill(stock ? stock.filter((c) => cards[c] && isSupport(c)) : shuffled(pool.filter((c) => isSupport(c) && rank(c) <= 2).flatMap(copies)));
    fill(pool.filter(isSupport).flatMap(copies));
    fill(rules.game.suggestedDeck);
    return deck;
  };

  /**
   * A foe's strength at `stage`, shifted by a locked run's heat: tier 1-8 is the plain ladder's stage 1-8. Below
   * it, foes get weaker stats and commons-only decks; above it, everything is at the top.
   */
  const foeAt = (run: Pick<GauntletRun, 'heat'>, stage: number) => {
    const t = stage + (run.heat ?? 0);
    return {
      base: Math.max(0, Math.min(65535, 4000 + t * 3500)),
      level: (t <= 2 ? 1 : t <= 6 ? 2 : 3) as BotLevel,
      maxRank: t <= 0 ? 0 : t <= 2 ? 1 : t <= 5 ? 2 : t <= 7 ? 3 : 4,
    };
  };

  /** A locked run's unlock: one random deckable collection card the player can't use yet, or none. */
  const unlockFor = (run: GauntletRun, unlocked: Set<string>): string | undefined => {
    const locked = pool.filter((c) => !isSupport(c) && !unlockedCard(c, unlocked));
    return locked.length ? String(cards[locked[seededRandom(`${run.seed}|unlock`)() % locked.length]].token!.tokenId) : undefined;
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
      // Card offers get rarer as the run goes on; a locked run offers common support cards only.
      const minRank = Math.min(4, Math.floor(run.wins / 2));
      const offerable = (c: number): boolean => (run.locked ? isSupport(c) && rank(c) === 0 : rank(c) >= minRank);
      const candidates = pool.filter((c) => offerable(c) && run.deck.filter((d) => d === c).length < dr.maxCopies);
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
    /**
     * A new run with the chosen champion (or none). Declared-deck games start from a deck of commons to rares;
     * given `locked` (the player's unlocks, heat and the game's stock list), a locked run.
     */
    start(seed: string, champion?: { tokenId?: string; stats?: AgentStats }, now = Date.now(), locked?: LockedRun): GauntletRun {
      const rnd = seededRandom(`${seed}|start`);
      return {
        v: 1, seed, wins: 0, over: false, cleared: false,
        champion: { ...(champion?.tokenId ? { tokenId: String(champion.tokenId) } : {}), stats: normalizeStats(champion?.stats) },
        deck: locked ? lockedDeck(rnd, new Set([...locked.unlocked].map(String)), locked.stock) : deckFrom(rnd, 2),
        blessings: {}, offers: [], started: now,
        ...(locked ? { locked: true as const, heat: clampHeat(locked.heat ?? START_HEAT) } : {}),
      };
    },
    /** Who stage `wins + 1` is: stronger stats, rarer decks and a smarter bot as the run goes on (shifted by heat). */
    opponent(run: GauntletRun): Opponent {
      const stage = run.wins + 1;
      const rnd = seededRandom(`${run.seed}|stage|${stage}`);
      const tokenId = tokens.length ? cards[tokens[rnd() % tokens.length]].token!.tokenId : undefined;
      const foe = foeAt(run, stage);
      const stats = normalizeStats(Object.fromEntries(STATS.map((k) => [k, Math.max(0, foe.base + (rnd() % 8000) - 4000)])));
      return { stage, name: STAGE_NAMES[stage - 1] ?? `Stage ${stage}`, level: foe.level, ...(tokenId ? { tokenId: String(tokenId) } : {}), stats, deck: deckFrom(rnd, foe.maxRank) };
    },
    /**
     * A finished locked run's effect on the player's heat: up one if it won UNLOCK_AT stages, down one if not.
     * Anything else (an open run, a run still going) leaves `heat` as it is.
     */
    heatAfter(run: GauntletRun, heat: number): number {
      if (!run.locked || !run.over) return clampHeat(heat);
      return clampHeat(heat + (run.wins >= UNLOCK_AT ? 1 : -1));
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
    /**
     * Record a match. A win offers rewards (or clears the run after the last stage); a loss or draw ends it.
     * The win that brings a locked run to UNLOCK_AT picks its unlock from the cards not in `unlocked` (the
     * player's unlocks now); the caller grants `run.unlock` as soon as it appears.
     */
    result(run: GauntletRun, won: boolean, unlocked: Iterable<string> = []): GauntletRun {
      if (run.over || run.offers.length) return run;
      if (!won) return { ...settled(run), over: true };
      const wins = run.wins + 1;
      const unlock = run.locked && wins === UNLOCK_AT ? unlockFor(run, new Set([...unlocked].map(String))) : undefined;
      const next = { ...settled(run), wins, ...(unlock ? { unlock } : {}) };
      return wins < STAGES ? { ...next, offers: offersFor(next) } : { ...next, over: true, cleared: true };
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
