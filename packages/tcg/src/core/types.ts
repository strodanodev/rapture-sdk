/**
 * Tessaract data model.
 *
 * Everything under `core/` is pure TypeScript with no engine, DOM or Node imports.
 * The same files are bundled into the LitNode ruleset (replayed by host and witnesses)
 * and imported by the Genesys client (rendered locally), so both sides compute the
 * exact same state from the same input log.
 */

/** ERC-6699 CoreStats as LitNode hydrates them into `ctx.agents[player].stats` (uint16 each). */
export interface AgentStats {
  strength?: number;
  agility?: number;
  resilience?: number;
  intelligence?: number;
}

export type StatName = keyof AgentStats;

export type CardType = 'unit' | 'spell' | 'relic';

/**
 * Who an effect hits. Chosen specs take the target the player picks (spells, hero powers and a unit's `play`
 * ability); automatic specs need no choice and are the only kind other triggers and relics may use.
 * - chosen:    'enemy' (enemy champion or unit), 'enemy-unit', 'own-unit', 'any-unit'
 * - automatic: 'self' (your champion), 'enemy-champion', 'all-enemy-units', 'all-own-units', 'all-units',
 *              'weakest-enemy' (the enemy unit with the least health, leftmost on ties; else the enemy champion),
 *              'newest-own-unit', 'this' (the unit whose ability it is)
 * Enemy units with `elusive` can't be chosen; automatic effects still reach them.
 */
export type TargetSpec =
  | 'enemy' | 'enemy-unit' | 'own-unit' | 'any-unit'
  | 'self' | 'enemy-champion' | 'all-enemy-units' | 'all-own-units' | 'all-units' | 'weakest-enemy' | 'newest-own-unit' | 'this';

/**
 * Which units something applies to: every field given must match (an empty filter matches every unit).
 * `sameElement` / `sameKind` compare with the card whose effect, ability or aura it is.
 */
export interface UnitFilter {
  /** One of `GameConfig.elements[].id`. */
  element?: string;
  /** A card `kind` (a collection trait, such as a Rapture Kind). */
  kind?: string;
  sameElement?: boolean;
  sameKind?: boolean;
  /** The unit's current attack is at most this. */
  attackAtMost?: number;
  /** The unit's current health is at most this. */
  healthAtMost?: number;
}

/**
 * When an ability fires or an aura holds: every field given must hold. Checked when the ability would fire (a
 * `play` ability: as the card is played, before any of its abilities resolve) and, for auras, at every settle.
 * - allies:  you control at least `count` (default 1) units matching the filter, not counting the unit itself
 * - enemies: the enemy controls at least `count` (default 1) units matching the filter
 * - lifeAtMost / enemyLifeAtMost: your / the enemy champion's life is at most N
 */
export interface Condition {
  allies?: UnitFilter & { count?: number };
  enemies?: UnitFilter & { count?: number };
  lifeAtMost?: number;
  enemyLifeAtMost?: number;
}

/**
 * What a spell, ability, hero power or relic does. Every op is defined once, in core/effects.ts.
 * - damage:  deal `amount` (+ spellPower for spells) to the target(s). Default target: 'enemy' when chosen, else 'enemy-champion'
 * - heal:    restore `amount` life to your champion, or health to units (up to their maximum). Default 'self'
 * - draw:    draw `amount` cards
 * - buff:    +attack/+health to unit(s). Default 'own-unit' when chosen, else 'newest-own-unit'
 * - energy:  gain `amount` energy this turn
 * - summon:  put `count` (default 1) copies of unit card `card` onto your board
 * - shield:  give unit(s) a shield that blocks the next damage. Default like buff
 * - destroy: destroy unit(s), through shields. Default 'enemy-unit' when chosen, else 'weakest-enemy'
 * - silence: remove unit(s)' keywords, abilities and aura (buffs stay). Default like destroy
 * - freeze:  unit(s) can't attack on their owner's next turn (or for the rest of this one). Default like destroy
 * - bounce:  return unit(s) to their owner's hand, as the card (burned when the hand is full). Default like destroy
 * - break:   destroy `count` (default 1) of the enemy's relics, oldest first
 * Unit-targeting ops take an optional `filter`: only matching units can be chosen or are hit.
 */
export type Effect =
  | { op: 'damage'; amount: number; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'heal'; amount: number; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'draw'; amount: number }
  | { op: 'buff'; attack?: number; health?: number; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'energy'; amount: number }
  | { op: 'summon'; card: string; count?: number }
  | { op: 'shield'; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'destroy'; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'silence'; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'freeze'; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'bounce'; target?: TargetSpec; filter?: UnitFilter }
  | { op: 'break'; count?: number };

/**
 * - guard:     enemies must attack guards first
 * - haste:     can attack the turn it is played
 * - rush:      can attack units (not the champion) the turn it is played
 * - lifesteal: damage it deals heals its champion
 * - shield:    the first damage it would take is blocked
 * - poison:    any damage it deals to a unit destroys that unit
 * - elusive:   enemy spells, powers and abilities can't choose it
 */
export type Keyword = 'guard' | 'haste' | 'rush' | 'lifesteal' | 'shield' | 'poison' | 'elusive';

/**
 * When a unit's ability fires. 'play' may take a chosen target; the others are automatic.
 * - play, death, turnStart (its owner's), attack (before the hit)
 * - turnEnd:   at the end of its owner's turn
 * - damaged:   whenever it takes damage (even damage that destroys it)
 * - allyDeath: whenever another of its owner's units dies
 */
export type Trigger = 'play' | 'death' | 'turnStart' | 'attack' | 'turnEnd' | 'damaged' | 'allyDeath';

export interface Ability {
  on: Trigger;
  effect: Effect;
  /** Fires only when this holds. */
  if?: Condition;
}

/**
 * A unit's lasting bonus to units on its side, recomputed after every action while the unit is on the board (and
 * not silenced). Losing an aura lowers attack and maximum health again, but never destroys a unit.
 * - to: 'others' (default: your other units), 'this' (itself), 'all' (your units, itself included)
 */
export interface Aura {
  attack?: number;
  health?: number;
  to?: 'others' | 'this' | 'all';
  /** Only units that match get it. */
  filter?: UnitFilter;
  /** Only while this holds (checked for the aura's own unit). */
  if?: Condition;
}

/**
 * A champion's hero power: once per turn, for `cost` energy. Each champion gets the first power whose
 * conditions all match (an entry with none is the default, for players without a champion). Conditions read
 * the champion's card in this game (found by token id) and its normalized ERC-6699 stats.
 */
export interface HeroPower {
  id: string;
  name: string;
  cost: number;
  effect: Effect;
  /** The champion card's element. */
  element?: string;
  /** The champion card's kind (a collection trait, such as a Rapture Kind). */
  kind?: string;
  /** The champion's highest ERC-6699 stat (ties go to the first in strength, agility, resilience, intelligence order). */
  stat?: StatName;
}

/** Optional link from a card definition to the NFT it represents. Display-only in v1. */
export interface CardToken {
  chainId: number;
  collection: string;
  tokenId: string;
}

export interface CardDef {
  /** Stable kebab-case id; decks reference cards by it. */
  id: string;
  name: string;
  type: CardType;
  /** One of `GameConfig.elements[].id`. */
  element: string;
  cost: number;
  /** Units only. */
  attack?: number;
  /** Units only. */
  health?: number;
  keywords?: Keyword[];
  /** Units only: effects that fire on a trigger (play, death, turn start or end, attack, damaged, an ally's death). */
  abilities?: Ability[];
  /** Units only: a lasting bonus to units on its side. */
  aura?: Aura;
  /**
   * false: no deck may hold it (a summon-only token): declared decks reject it, and the deck builder, random sim
   * decks and the Gauntlet never offer it. Default true.
   */
  deckable?: boolean;
  /** Spells and relics. */
  effect?: Effect;
  /** A collection trait (such as a Rapture Kind), for display and hero-power matching. */
  kind?: string;
  /** Card face: a project asset path for bundled art, or an http(s)/ipfs URL for NFT art. */
  art?: string;
  rarity?: string;
  token?: CardToken;
}

export interface ElementDef {
  id: string;
  name: string;
  /** Element ids this element deals bonus damage to. */
  beats?: string[];
  /** CSS colour for UI accents. */
  color?: string;
}

/** Maps one ERC-6699 stat (0..65535) onto a bounded integer range. */
export interface StatMapping {
  stat: StatName;
  min: number;
  max: number;
}

/** How a player's ERC-6699 champion (the token they queue with) shapes their side. */
export interface ChampionConfig {
  life: StatMapping;
  /** Bonus damage on damage spells. */
  spellPower: StatMapping;
  /** Bonus attack on every unit you play; with `minCost`, only on units that cost at least that much. */
  unitAttack: StatMapping & { minCost?: number };
  openingHand: StatMapping;
  /** Optional hero powers; see HeroPower. */
  powers?: HeroPower[];
}

export interface RulesConfig {
  boardSlots: number;
  relicSlots: number;
  handLimit: number;
  energyStart: number;
  energyMax: number;
  energyPerTurn: number;
  /** Extra damage when the attacker's element beats the defender's. */
  elementBonus: number;
  /** Damage when drawing from an empty deck grows by 1 each time. */
  fatigue: boolean;
  /** The second player starts with this much extra energy. */
  secondPlayerEnergy: number;
  /** The second player's opening hand holds this many extra cards (default 0): a finer lever than energy. */
  secondPlayerCards?: number;
}

/**
 * 'declared': each player declares their own deck (for example the cards their wallet holds) as the first
 * entries of the match log, one card per entry, before turn 1. The log stays the whole truth, so any node
 * or witness replays it. Ownership is not a rule: the relay enforces it for owned-only matches (tools/chain-check.ts).
 */
export interface DeckRules {
  mode: 'fixed' | 'declared';
  /** Cards per declared deck. */
  size: number;
  /** Copies of one card allowed in a declared deck. */
  maxCopies: number;
}

export interface LitNodeConfig {
  /** `name.vN`. Bump N on any rules or card change: a new version is a new ruleset. */
  rulesetId: string;
  /** Nominal; a turn game records one log entry per action, not per wall-clock tick. */
  tickRate: number;
  /** Hard cap on log entries. At the cap, the higher life total wins. */
  maxTicks: number;
  modes: Array<'ranked' | 'casual'>;
  eloK: number;
  /** Where the arcade launches the client. */
  url?: string;
  cover?: string;
  accent?: string;
}

export interface GameConfig {
  $schema?: string;
  title: string;
  description?: string;
  litnode: LitNodeConfig;
  elements: ElementDef[];
  champion: ChampionConfig;
  rules: RulesConfig;
  cards: CardDef[];
  /**
   * The default deck: `{ cardId: copies }`. With `deckRules.mode: 'fixed'` (the default) every player plays
   * it; with `'declared'` it is the suggested deck and the fallback for a player who does not declare one.
   */
  deck: Record<string, number>;
  /** How decks are chosen. Omit for 'fixed'. */
  deckRules?: DeckRules;
  /** Optional card back for the client. */
  cardBack?: string;
}

// ---------------------------------------------------------------- state

export interface UnitState {
  /** Index into the compiled card list. */
  c: number;
  atk: number;
  hp: number;
  /** Health cap for heals: the card's health plus buffs. */
  max: number;
  guard: boolean;
  ready: boolean;
  /** Played this turn (a rush unit may attack only units). */
  fresh: boolean;
  /** Blocks the next damage. */
  shield: boolean;
  // The fields below exist only in games that use the mechanics behind them, so older games' states are unchanged.
  /** Frozen: can't attack until this turn number has ended. */
  frozen?: number;
  /** Silenced: no keywords, abilities or aura. */
  silenced?: boolean;
  /** The aura bonus it holds now, [attack, health] (already in atk, hp and max). */
  aura?: [number, number];
}

export interface PlayerState {
  id: string;
  life: number;
  /** Starting life; heals cap here. */
  maxLife: number;
  energy: number;
  energyCap: number;
  spellPower: number;
  unitAttack: number;
  /** Card indices, top of deck last. */
  deck: number[];
  hand: number[];
  board: UnitState[];
  relics: number[];
  fatigue: number;
  /** Index into `champion.powers`, or -1 for none. */
  power: number;
  powerUsed: boolean;
}

export interface MatchState {
  v: 2;
  /** Log entries consumed so far. */
  beat: number;
  /** Index of the player to act. */
  turn: 0 | 1;
  turnNo: number;
  over: boolean;
  /** -1 none yet, 0 or 1 a side, 2 a draw. */
  winner: -1 | 0 | 1 | 2;
  p: [PlayerState, PlayerState];
  /** Last accepted action, for UI and animation. 0 when the beat was a no-op. */
  last: number;
  /** Declared-deck matches only: 'decks' until both decks are declared, then 'play'. */
  phase?: 'decks' | 'play';
  /** Declared-deck matches only: the cards each side has declared so far (card indices). */
  decl?: [number[], number[]];
  /** The match seed: decks and draws come from it. */
  seed: string;
  /**
   * Draw entropy: folded from every accepted action. Draws come from the seed and `turnEnt` (the entropy when
   * the turn began), so nobody can compute a draw before the opponent has finished the turn before it.
   */
  ent: number;
  turnEnt: number;
  /** Draws made since the turn began. */
  drawn: number;
  /** Declared-deck matches only: each side's opening hand size, drawn once decks are declared. */
  opening?: [number, number];
}

/** What LitNode passes `init` as `ctx`. */
export interface InitContext {
  agents?: Record<string, { stats?: AgentStats; tokenId?: string } | undefined>;
}
