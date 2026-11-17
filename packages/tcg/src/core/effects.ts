import type { Ability, Aura, CardDef, Condition, Effect, Keyword, TargetSpec, Trigger, UnitFilter, UnitState } from './types';

/**
 * The effect and keyword library, each entry defined once: validation, targeting, resolution and card text.
 * Adding an effect op means adding one entry to OPS (plus its type in types.ts); the rules engine, bot,
 * sim and client pick it up from here. Pure: resolution goes through the `Fx` the rules engine provides, and
 * conditions and filters read the match through the `World` it provides.
 */

// ---------------------------------------------------------------- targeting

/** Specs the acting player chooses a target for (the action's target bits). */
export const CHOSEN: readonly TargetSpec[] = ['enemy', 'enemy-unit', 'own-unit', 'any-unit'];
export const AUTOMATIC: readonly TargetSpec[] = ['self', 'enemy-champion', 'all-enemy-units', 'all-own-units', 'all-units', 'weakest-enemy', 'newest-own-unit', 'this'];
export const isChosen = (t: TargetSpec | null): boolean => t !== null && CHOSEN.includes(t);
/** Specs a `filter` can narrow: units only, chosen or every unit of a side. */
export const FILTERABLE: readonly TargetSpec[] = ['enemy-unit', 'own-unit', 'any-unit', 'all-enemy-units', 'all-own-units', 'all-units'];

/** A resolved target: a champion, or a unit on `side`'s board. */
export type Ref = { kind: 'champion'; side: 0 | 1 } | { kind: 'unit'; side: 0 | 1; unit: UnitState };

/** What effects may do to the match; the rules engine implements it. */
export interface Fx {
  /** Damage from a card (spell, ability, power or relic) of side `me`; `amount` already includes spellPower. */
  damage(ref: Ref, amount: number, sourceCard: number | null): void;
  heal(ref: Ref, amount: number): void;
  buff(unit: UnitState, attack: number, health: number): void;
  draw(side: 0 | 1, n: number): void;
  energy(side: 0 | 1, n: number): void;
  summon(side: 0 | 1, card: string, n: number): void;
  shield(unit: UnitState): void;
  /** Destroy a unit (shields don't stop it); it dies at the next settle like any other. */
  destroy(ref: Ref & { kind: 'unit' }): void;
  silence(unit: UnitState): void;
  freeze(ref: Ref & { kind: 'unit' }): void;
  /** Take a unit off the board into its owner's hand (no death). */
  bounce(ref: Ref & { kind: 'unit' }): void;
  /** Destroy up to `n` of `side`'s relics, oldest first. */
  breakRelics(side: 0 | 1, n: number): void;
}

/** What conditions and filters read: living units, life totals and card definitions. */
export interface World {
  /** `side`'s living units, left to right. */
  units(side: 0 | 1): UnitState[];
  life(side: 0 | 1): number;
  card(c: number): CardDef;
}

/** Element ids, kinds and unit card ids a config defines, for validating references to them. */
export interface Catalog {
  unitIds: ReadonlySet<string>;
  elements?: ReadonlySet<string>;
  kinds?: ReadonlySet<string>;
}

interface OpDef {
  /** Problems with this effect's fields (other than `op`, `target` and `filter`). */
  check(e: Effect, unitIds: ReadonlySet<string>): string[];
  /** The target spec when the effect omits one: `chosen` is whether a choice can be made in this context. */
  target(chosen: boolean): TargetSpec | null;
  /** Specs this op accepts. */
  allows: readonly TargetSpec[];
  apply(fx: Fx, e: Effect, me: 0 | 1, refs: Ref[], sourceCard: number | null, spellPower: number): void;
  /** Card text without the target phrase. */
  text(e: Effect, nameOf: (id: string) => string): string;
  /** The verb takes its target directly ("Destroy an enemy unit", not "Destroy to an enemy unit"). */
  direct?: boolean;
  /** Text after the target phrase. */
  after?: string;
}

const int = (n: unknown, lo: number, hi: number): boolean => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
const UNIT_SPECS: TargetSpec[] = ['own-unit', 'any-unit', 'enemy-unit', 'all-own-units', 'all-enemy-units', 'all-units', 'newest-own-unit', 'this'];
const foeOf = (me: 0 | 1): 0 | 1 => (me === 0 ? 1 : 0);
const units = (refs: Ref[]): Array<Ref & { kind: 'unit' }> => refs.filter((r): r is Ref & { kind: 'unit' } => r.kind === 'unit');

/** A unit op with no fields of its own: destroy, silence, freeze, bounce. */
const unitOp = (verb: string, apply: (fx: Fx, r: Ref & { kind: 'unit' }) => void, after?: string): OpDef => ({
  check: () => [],
  target: (chosen) => (chosen ? 'enemy-unit' : 'weakest-enemy'),
  allows: [...UNIT_SPECS, 'weakest-enemy'],
  apply: (fx, _e, _me, refs) => { for (const r of units(refs)) apply(fx, r); },
  text: () => verb,
  direct: true,
  after,
});

export const OPS: Record<Effect['op'], OpDef> = {
  damage: {
    check: (e) => (int((e as { amount: number }).amount, 1, 99) ? [] : ['damage needs an integer amount 1-99']),
    target: (chosen) => (chosen ? 'enemy' : 'enemy-champion'),
    allows: ['enemy', 'enemy-unit', 'any-unit', 'enemy-champion', 'all-enemy-units', 'all-units', 'weakest-enemy'],
    apply: (fx, e, _me, refs, src, sp) => { for (const r of refs) fx.damage(r, (e as { amount: number }).amount + sp, src); },
    text: (e) => `Deal ${(e as { amount: number }).amount}`,
  },
  heal: {
    check: (e) => (int((e as { amount: number }).amount, 1, 99) ? [] : ['heal needs an integer amount 1-99']),
    target: () => 'self',
    allows: ['self', 'own-unit', 'all-own-units', 'this'],
    apply: (fx, e, _me, refs) => { for (const r of refs) fx.heal(r, (e as { amount: number }).amount); },
    text: (e) => `Heal ${(e as { amount: number }).amount}`,
  },
  draw: {
    check: (e) => (int((e as { amount: number }).amount, 1, 9) ? [] : ['draw needs an integer amount 1-9']),
    target: () => null,
    allows: [],
    apply: (fx, e, me) => fx.draw(me, (e as { amount: number }).amount),
    text: (e) => `Draw ${(e as { amount: number }).amount}`,
  },
  energy: {
    check: (e) => (int((e as { amount: number }).amount, 1, 9) ? [] : ['energy needs an integer amount 1-9']),
    target: () => null,
    allows: [],
    apply: (fx, e, me) => fx.energy(me, (e as { amount: number }).amount),
    text: (e) => `+${(e as { amount: number }).amount} energy`,
  },
  buff: {
    check: (e) => {
      const b = e as { attack?: number; health?: number };
      return int(b.attack ?? 0, 0, 20) && int(b.health ?? 0, 0, 20) && (b.attack ?? 0) + (b.health ?? 0) > 0 ? [] : ['buff needs attack and/or health 1-20'];
    },
    target: (chosen) => (chosen ? 'own-unit' : 'newest-own-unit'),
    allows: UNIT_SPECS,
    apply: (fx, e, _me, refs) => { const b = e as { attack?: number; health?: number }; for (const r of units(refs)) fx.buff(r.unit, b.attack ?? 0, b.health ?? 0); },
    text: (e) => { const b = e as { attack?: number; health?: number }; return `+${b.attack ?? 0}/+${b.health ?? 0}`; },
  },
  shield: {
    check: () => [],
    target: (chosen) => (chosen ? 'own-unit' : 'newest-own-unit'),
    allows: UNIT_SPECS,
    apply: (fx, _e, _me, refs) => { for (const r of units(refs)) fx.shield(r.unit); },
    text: () => 'Shield',
    direct: true,
  },
  summon: {
    check: (e, unitIds) => {
      const m = e as { card: string; count?: number };
      return [...(unitIds.has(m.card) ? [] : [`summon names ${JSON.stringify(m.card)}, which is not a unit card`]), ...(int(m.count ?? 1, 1, 5) ? [] : ['summon count must be 1-5'])];
    },
    target: () => null,
    allows: [],
    apply: (fx, e, me) => { const m = e as { card: string; count?: number }; fx.summon(me, m.card, m.count ?? 1); },
    text: (e, nameOf) => { const m = e as { card: string; count?: number }; return (m.count ?? 1) > 1 ? `Summon ${m.count} ${nameOf(m.card)}s` : `Summon ${nameOf(m.card)}`; },
  },
  destroy: unitOp('Destroy', (fx, r) => fx.destroy(r)),
  silence: unitOp('Silence', (fx, r) => fx.silence(r.unit)),
  freeze: unitOp('Freeze', (fx, r) => fx.freeze(r)),
  bounce: unitOp('Return', (fx, r) => fx.bounce(r), ' to hand'),
  break: {
    check: (e) => (int((e as { count?: number }).count ?? 1, 1, 5) ? [] : ['break count must be 1-5']),
    target: () => null,
    allows: [],
    apply: (fx, e, me) => fx.breakRelics(foeOf(me), (e as { count?: number }).count ?? 1),
    text: (e) => { const n = (e as { count?: number }).count ?? 1; return n > 1 ? `Break ${n} enemy relics` : 'Break an enemy relic'; },
  },
};

/** The spec an effect uses in a context where a choice can (`chosen`) or can't be made; null for untargeted ops. */
export function specOf(e: Effect, chosen: boolean): TargetSpec | null {
  const def = OPS[e.op];
  const t = 'target' in e && e.target ? e.target : def.target(chosen);
  return def.allows.length ? t : null;
}

/** The effect's unit filter, if it has one. */
export const filterOf = (e: Effect): UnitFilter | undefined => ('filter' in e ? e.filter : undefined);

// ---------------------------------------------------------------- filters and conditions

const FILTER_KEYS = ['element', 'kind', 'sameElement', 'sameKind', 'attackAtMost', 'healthAtMost'];
const COUNTED_KEYS = [...FILTER_KEYS, 'count'];
const CONDITION_KEYS = ['allies', 'enemies', 'lifeAtMost', 'enemyLifeAtMost'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether unit `u` matches `f`; `src` is the card whose effect, ability or aura asks (for sameElement / sameKind). */
export function matches(u: UnitState, f: UnitFilter | undefined, world: World, src: CardDef | null): boolean {
  if (!f) return true;
  const def = world.card(u.c);
  if (f.element !== undefined && def.element !== f.element) return false;
  if (f.kind !== undefined && def.kind !== f.kind) return false;
  if (f.sameElement && (!src || def.element !== src.element)) return false;
  if (f.sameKind && (!src || src.kind === undefined || def.kind !== src.kind)) return false;
  if (f.attackAtMost !== undefined && u.atk > f.attackAtMost) return false;
  if (f.healthAtMost !== undefined && u.hp > f.healthAtMost) return false;
  return true;
}

/** Whether `cond` holds for side `me`; `src.unit` (the ability's or aura's own unit) never counts as an ally. */
export function holds(cond: Condition | undefined, world: World, me: 0 | 1, src: { card: CardDef | null; unit: UnitState | null }): boolean {
  if (!cond) return true;
  const count = (side: 0 | 1, f: UnitFilter & { count?: number }): boolean =>
    world.units(side).filter((u) => u !== src.unit && matches(u, f, world, src.card)).length >= (f.count ?? 1);
  if (cond.allies && !count(me, cond.allies)) return false;
  if (cond.enemies && !count(foeOf(me), cond.enemies)) return false;
  if (cond.lifeAtMost !== undefined && world.life(me) > cond.lifeAtMost) return false;
  if (cond.enemyLifeAtMost !== undefined && world.life(foeOf(me)) > cond.enemyLifeAtMost) return false;
  return true;
}

/** Problems with a unit filter `at` some path. */
export function checkFilter(f: unknown, at: string, cat: Partial<Catalog>, keys = FILTER_KEYS): string[] {
  if (!isObj(f)) return [`${at} must be an object`];
  const errs: string[] = [];
  for (const k of Object.keys(f)) if (!keys.includes(k)) errs.push(`${at} has unknown field ${JSON.stringify(k)} (known: ${keys.join(', ')})`);
  if (f.element !== undefined && (typeof f.element !== 'string' || (cat.elements && !cat.elements.has(f.element)))) errs.push(`${at}.element ${JSON.stringify(f.element)} is not an element of this game`);
  if (f.kind !== undefined && (typeof f.kind !== 'string' || (cat.kinds && !cat.kinds.has(f.kind)))) errs.push(`${at}.kind ${JSON.stringify(f.kind)} is no card's kind`);
  for (const k of ['sameElement', 'sameKind']) if (f[k] !== undefined && f[k] !== true) errs.push(`${at}.${k} must be true (or left out)`);
  for (const k of ['attackAtMost', 'healthAtMost']) if (f[k] !== undefined && !int(f[k], 0, 99)) errs.push(`${at}.${k} must be an integer 0-99`);
  if (keys === COUNTED_KEYS && f.count !== undefined && !int(f.count, 1, 5)) errs.push(`${at}.count must be an integer 1-5`);
  return errs;
}

/** Problems with a condition (`if`) `at` some path. */
export function checkCondition(c: unknown, at: string, cat: Partial<Catalog>): string[] {
  if (!isObj(c)) return [`${at} must be an object`];
  const errs: string[] = [];
  const keys = Object.keys(c);
  if (!keys.length) errs.push(`${at} needs at least one of ${CONDITION_KEYS.join(', ')}`);
  for (const k of keys) if (!CONDITION_KEYS.includes(k)) errs.push(`${at} has unknown field ${JSON.stringify(k)} (known: ${CONDITION_KEYS.join(', ')})`);
  for (const k of ['allies', 'enemies']) if (c[k] !== undefined) errs.push(...checkFilter(c[k], `${at}.${k}`, cat, COUNTED_KEYS));
  for (const k of ['lifeAtMost', 'enemyLifeAtMost']) if (c[k] !== undefined && !int(c[k], 1, 999)) errs.push(`${at}.${k} must be an integer 1-999`);
  return errs;
}

/** Problems with a unit's aura. */
export function checkAura(a: unknown, cat: Partial<Catalog>): string[] {
  if (!isObj(a)) return ['aura must be an object'];
  const errs: string[] = [];
  for (const k of Object.keys(a)) if (!['attack', 'health', 'to', 'filter', 'if'].includes(k)) errs.push(`aura has unknown field ${JSON.stringify(k)} (known: attack, health, to, filter, if)`);
  const atk = a.attack ?? 0, hp = a.health ?? 0;
  if (!int(atk, 0, 20) || !int(hp, 0, 20) || (atk as number) + (hp as number) <= 0) errs.push('aura needs attack and/or health 1-20');
  if (a.to !== undefined && !['others', 'this', 'all'].includes(a.to as string)) errs.push('aura.to must be "others", "this" or "all"');
  // An aura changes attack and health, so a filter on them could switch the aura off by turning it on: not allowed.
  if (a.filter !== undefined) errs.push(...checkFilter(a.filter, 'aura.filter', cat, ['element', 'kind', 'sameElement', 'sameKind']));
  if (a.if !== undefined) errs.push(...checkCondition(a.if, 'aura.if', cat));
  return errs;
}

/**
 * Problems with one effect, `where` it is used: a choice is possible there unless `automatic`. `units` is the unit card
 * ids (summon targets), or a Catalog that also checks the elements and kinds a filter names.
 */
export function checkEffect(e: Effect | undefined, units: ReadonlySet<string> | Catalog, opts: { automatic: boolean; onUnit: boolean }): string[] {
  const cat: Catalog = 'unitIds' in units ? units : { unitIds: units as ReadonlySet<string> };
  if (!e || !(e.op in OPS)) return [`effect op must be one of ${Object.keys(OPS).join(', ')}`];
  const def = OPS[e.op];
  const errs = def.check(e, cat.unitIds);
  const t = 'target' in e ? e.target : undefined;
  if (t !== undefined) {
    if (!def.allows.includes(t)) errs.push(`${e.op} can't target ${JSON.stringify(t)} (allowed: ${def.allows.join(', ') || 'none'})`);
    if (opts.automatic && isChosen(t)) errs.push(`target ${JSON.stringify(t)} needs a choice; here only automatic targets work (${AUTOMATIC.join(', ')})`);
    if (t === 'this' && !opts.onUnit) errs.push('target "this" only works in a unit\'s ability');
  }
  const f = (e as { filter?: unknown }).filter;
  if (f !== undefined) {
    const spec = specOf(e, !opts.automatic);
    if (!spec || !FILTERABLE.includes(spec)) errs.push(`filter needs a unit target (${FILTERABLE.join(', ')}); this ${e.op} targets ${JSON.stringify(spec ?? 'nothing')}`);
    errs.push(...checkFilter(f, 'filter', cat));
  }
  return errs;
}

// ---------------------------------------------------------------- keywords

export const KEYWORDS: Record<Keyword, string> = {
  guard: 'Enemies must attack it first',
  haste: 'Can attack the turn it is played',
  rush: 'Can attack units the turn it is played',
  lifesteal: 'Damage it deals heals your champion',
  shield: 'Blocks the first damage it would take',
  poison: 'Destroys any unit it damages',
  elusive: "Enemy spells and powers can't target it",
};

export const TRIGGERS: Record<Trigger, string> = {
  play: 'On play',
  death: 'Last words',
  turnStart: 'Each turn',
  attack: 'On attack',
  turnEnd: 'End of turn',
  damaged: 'When damaged',
  allyDeath: 'When an ally dies',
};

/** Triggers whose abilities have no choice of target ('play' is the one that may). */
export const AUTOMATIC_TRIGGERS: readonly Trigger[] = ['death', 'turnStart', 'attack', 'turnEnd', 'damaged', 'allyDeath'];

// ---------------------------------------------------------------- card text

const PHRASE: Record<TargetSpec, string> = {
  'enemy': '',
  'enemy-unit': ' to an enemy unit',
  'own-unit': ' to a friendly unit',
  'any-unit': ' to a unit',
  'self': '',
  'enemy-champion': ' to the enemy champion',
  'all-enemy-units': ' to all enemy units',
  'all-own-units': ' to your units',
  'all-units': ' to all units',
  'weakest-enemy': ' to the weakest enemy',
  'newest-own-unit': ' to your newest unit',
  'this': ' to itself',
};

const title = (s: string): string => s.replace(/(^|-)([a-z])/g, (_, d: string, ch: string) => (d ? ' ' : '') + ch.toUpperCase());
/** "a" or "an" before a word. */
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** A filter as words around "unit(s)": the adjectives before it and the clauses after it. */
function filterWords(f: UnitFilter | undefined): { adj: string; post: string } {
  if (!f) return { adj: '', post: '' };
  const adj = [f.element !== undefined ? title(f.element) : '', f.kind ?? ''].filter(Boolean).join(' ');
  const post = [
    f.sameElement ? ' of its element' : '',
    f.sameKind ? ' of its kind' : '',
    f.attackAtMost !== undefined ? ` with ${f.attackAtMost} or less attack` : '',
    f.healthAtMost !== undefined ? ` with ${f.healthAtMost} or less health` : '',
  ].join('');
  return { adj, post };
}

/** Puts a filter's words into a target phrase ("to an enemy unit" -> "to an enemy Fire unit with 2 or less attack"). */
function filtered(phrase: string, f: UnitFilter | undefined): string {
  const { adj, post } = filterWords(f);
  if (!adj && !post) return phrase;
  // "to a unit" -> "to an Earth unit"
  const out = phrase.replace(/\bunits?\b/, (u) => `${adj ? `${adj} ` : ''}${u}${post}`);
  return adj ? out.replace(` a ${adj}`, ` ${article(adj)} ${adj}`) : out;
}

/** A condition as a clause ("you control another King unit and your champion has 10 or less life"). */
export function describeCondition(c: Condition): string {
  const group = (f: UnitFilter & { count?: number }, mine: boolean): string => {
    const { adj, post } = filterWords(f);
    const n = f.count ?? 1;
    const noun = `${adj ? `${adj} ` : ''}unit${n > 1 ? 's' : ''}${post}`;
    if (mine) return n > 1 ? `you control ${n} other ${noun}` : `you control another ${noun}`;
    return n > 1 ? `the enemy controls ${n} ${noun}` : `the enemy controls ${article(noun)} ${noun}`;
  };
  return [
    c.allies ? group(c.allies, true) : '',
    c.enemies ? group(c.enemies, false) : '',
    c.lifeAtMost !== undefined ? `your champion has ${c.lifeAtMost} or less life` : '',
    c.enemyLifeAtMost !== undefined ? `the enemy champion has ${c.enemyLifeAtMost} or less life` : '',
  ].filter(Boolean).join(' and ');
}

/** One effect as card text, such as "Deal 2 to all enemy units". */
export function describeEffect(e: Effect, nameOf: (id: string) => string = (id) => id, chosen = true): string {
  const def = OPS[e.op];
  const spec = specOf(e, chosen);
  const phrase = spec ? filtered(PHRASE[spec], filterOf(e)) : '';
  // "Shield your units" reads better than "Shield to your units": the verb takes its target directly.
  return `${def.text(e, nameOf)}${def.direct ? phrase.replace(/^ to/, '') : phrase}${def.after ?? ''}`;
}

export const describeAbility = (a: Ability, nameOf?: (id: string) => string): string =>
  `${TRIGGERS[a.on]}${a.if ? `, if ${describeCondition(a.if)}` : ''}: ${describeEffect(a.effect, nameOf, a.on === 'play')}`;

/** An aura as card text, such as "Your other King units have +1/+0". */
export function describeAura(a: Aura): string {
  const { adj, post } = filterWords(a.filter);
  const bonus = `+${a.attack ?? 0}/+${a.health ?? 0}`;
  const who = `${adj ? `${adj} ` : ''}units${post}`;
  const base = a.to === 'this' ? `Has ${bonus}` : `Your ${a.to === 'all' ? '' : 'other '}${who} have ${bonus}`;
  return `${base}${a.if ? ` while ${describeCondition(a.if)}` : ''}`;
}

/** A card's rules text as lines: keywords, then its aura and abilities (units) or its effect (spells, relics). */
export function describeCard(def: CardDef, nameOf?: (id: string) => string): string[] {
  const lines: string[] = [];
  if (def.keywords?.length) lines.push(def.keywords.map((k) => k[0].toUpperCase() + k.slice(1)).join(' · '));
  if (def.aura) lines.push(describeAura(def.aura));
  for (const a of def.abilities ?? []) lines.push(describeAbility(a, nameOf));
  if (def.effect) lines.push(def.type === 'relic' ? `Each turn: ${describeEffect(def.effect, nameOf, false)}` : describeEffect(def.effect, nameOf, true));
  return lines;
}
