// The collection config: one JSON file that describes a collection, read by the deploy script (contract
// parameters and vocabulary) and by the metadata pipeline (tokens, files, hashes). See examples/starter/collection.json
// and the README's "Collection config" section.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { checkJsonText, checkName } from './text.js';

export const TRAITS = /** @type {const} */ (['kind', 'faction', 'alignment', 'element', 'frame', 'kit']);
export const SEALED = 255;
export const DEFAULT_SLOTS = ['head', 'body', 'mainhand', 'offhand', 'trinket'];

/**
 * @typedef {{ label: string, values: string[] }} Trait
 * @typedef {{
 *   kinds: number, maxFaction: number, maxAlignment: number, sealedAlignment: boolean, maxElement: number,
 *   maxFrame: number, maxParts: [number, number, number, number], maxKit: number, kitKinds: number, requireAvatar: boolean
 * }} Rules
 * @typedef {{
 *   tagline: string, sealedLabel: string, traits: Record<typeof TRAITS[number], Trait>,
 *   parts: [string, string, string, string], avatarRequires: string[], equipmentSlots: string[]
 * }} Vocabulary
 * @typedef {{
 *   name?: string, epithet?: string, kind: string | number, faction?: string | number, alignment?: string | number,
 *   element?: string | number, frame?: string | number, parts?: number[] | Record<string, number>, kit?: string | number | null,
 *   stats: { strength: number, agility: number, resilience: number, intelligence: number },
 *   art: string, avatar?: string, avatarPlain?: string, turntable?: string, soul?: string,
 *   styleSource?: { chainId: number | string, collection: string, tokenId: number | string },
 *   overrides?: Record<string, unknown>, to?: string
 * }} TokenSource
 * @typedef {{
 *   file: string, dir: string, name: string, symbol: string, setId: number, maxSupply: number,
 *   registry: Record<string, string>, identity: string | null, admin: string | null, json: string | null, minters: string[],
 *   images: { base: string, ext: string }, info: { description: string, image: string, externalLink: string },
 *   rules: Rules, bands: { min: number[], max: number[] }, vocab: Vocabulary, tokens: TokenSource[]
 * }} CollectionConfig
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
  }
}

/** @param {unknown} v @param {string} what @param {number} max */
function uint(v, what, max) {
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 0 || /** @type {number} */ (v) > max) throw new Error(`${what}: expected an integer 0..${max}, got ${JSON.stringify(v)}`);
  return /** @type {number} */ (v);
}

/** @param {any} t @param {string} what @returns {Trait} */
function trait(t, what) {
  if (t == null) return { label: '', values: [] };
  const label = checkJsonText(`${what}.label`, t.label ?? '', 0, 48);
  const values = /** @type {unknown[]} */ (t.values ?? []);
  if (!Array.isArray(values) || values.length > 64) throw new Error(`${what}.values: expected at most 64 names`);
  return { label, values: values.map((v, i) => checkJsonText(`${what}.values[${i}]`, v, 1, 48)) };
}

/**
 * Load and check a collection config. Token entries may be inline or in a separate file ("tokens": "tokens.json");
 * file paths inside tokens are resolved later, against the config's folder.
 * @param {string} file
 * @returns {CollectionConfig}
 */
export function loadConfig(file) {
  const path = resolve(file);
  return normalizeConfig(readJson(path), path);
}

/**
 * @param {any} raw
 * @param {string} path  the config file (its folder resolves relative paths)
 * @returns {CollectionConfig}
 */
export function normalizeConfig(raw, path) {
  const dir = dirname(path);
  const name = checkJsonText('name', raw.name, 1, 64);
  const symbol = checkJsonText('symbol', raw.symbol, 1, 16);
  const setId = uint(raw.setId ?? 1, 'setId', 0xffff);
  if (setId === 0) throw new Error('setId: must be 1..65535 (token ids are setId << 32 | index, never 0)');
  const maxSupply = uint(raw.maxSupply ?? 0, 'maxSupply', 0xffffffff);

  /** @type {Record<string, string>} */
  const registry = typeof raw.registry === 'string' ? { default: raw.registry } : { ...(raw.registry ?? {}) };
  for (const [net, a] of Object.entries(registry)) {
    if (!ADDRESS.test(a)) throw new Error(`registry.${net}: not an address: ${a}`);
  }
  const optAddr = (/** @type {unknown} */ a, /** @type {string} */ what) => {
    if (a == null || a === '') return null;
    if (typeof a !== 'string' || !ADDRESS.test(a)) throw new Error(`${what}: not an address: ${a}`);
    return a;
  };

  const t = raw.traits ?? {};
  const traits = /** @type {Record<typeof TRAITS[number], Trait>} */ (Object.fromEntries(TRAITS.map((k) => [k, trait(t[k], `traits.${k}`)])));
  const kind = traits.kind;
  if (kind.values.length === 0 || kind.values.length > 16) throw new Error('traits.kind.values: name 1..16 Kinds');
  if (!kind.label) throw new Error('traits.kind.label: the Kind trait needs a label');

  const bands = /** @type {unknown} */ (t.kind?.bands);
  if (!Array.isArray(bands) || bands.length !== kind.values.length) throw new Error('traits.kind.bands: one [min, max] stat band per Kind');
  const min = bands.map((b, i) => uint(b?.[0], `traits.kind.bands[${i}][0]`, 0xffff));
  const max = bands.map((b, i) => uint(b?.[1], `traits.kind.bands[${i}][1]`, 0xffff));
  min.forEach((m, i) => {
    if (m === 0 || m > max[i]) throw new Error(`traits.kind.bands[${i}]: need 0 < min <= max`);
  });

  const partsRaw = /** @type {any[]} */ (t.parts ?? []);
  if (!Array.isArray(partsRaw) || partsRaw.length > 4) throw new Error('traits.parts: at most 4 body-part slots');
  const parts = /** @type {[string, string, string, string]} */ ([0, 1, 2, 3].map((i) => checkJsonText(`traits.parts[${i}].label`, partsRaw[i]?.label ?? '', 0, 48)));
  const maxParts = /** @type {[number, number, number, number]} */ ([0, 1, 2, 3].map((i) => uint(partsRaw[i]?.max ?? 0, `traits.parts[${i}].max`, 255)));

  const kitKindsRaw = /** @type {unknown[]} */ (t.kit?.kinds ?? []);
  let kitKinds = 0;
  for (const k of kitKindsRaw) kitKinds |= 1 << indexOf(kind, k, 'traits.kit.kinds');
  const maxOf = (/** @type {Trait} */ tr) => Math.max(tr.values.length - 1, 0);
  const sealed = t.alignment?.sealed;
  const sealedLabel = sealed == null ? '' : checkJsonText('traits.alignment.sealed', sealed, 1, 48);

  /** @type {Rules} */
  const rules = {
    kinds: kind.values.length,
    maxFaction: maxOf(traits.faction),
    maxAlignment: maxOf(traits.alignment),
    sealedAlignment: sealed != null,
    maxElement: maxOf(traits.element),
    maxFrame: maxOf(traits.frame),
    maxParts,
    maxKit: traits.kit.values.length,
    kitKinds,
    requireAvatar: !!raw.avatar?.required,
  };
  if (rules.maxKit === 0 && kitKinds !== 0) throw new Error('traits.kit.kinds: names Kinds that need a kit, but traits.kit.values is empty');

  const list = (/** @type {unknown} */ v, /** @type {string} */ what) => {
    if (!Array.isArray(v) || v.length > 64) throw new Error(`${what}: expected a list`);
    return v.map((x, i) => checkJsonText(`${what}[${i}]`, x, 1, 48));
  };
  /** @type {Vocabulary} */
  const vocab = {
    tagline: checkJsonText('tagline', raw.tagline ?? '', 0, 160),
    sealedLabel,
    traits,
    parts,
    avatarRequires: list(raw.avatar?.requires ?? [], 'avatar.requires'),
    equipmentSlots: list(raw.equipmentSlots ?? DEFAULT_SLOTS, 'equipmentSlots'),
  };

  const ext = raw.images?.ext ?? 'webp';
  if (!/^[0-9a-z]{1,8}$/.test(ext)) throw new Error('images.ext: 1-8 lowercase letters or digits (webp, png)');
  const images = { base: checkJsonText('images.base', raw.images?.base ?? '', 0, 512), ext };
  const info = {
    description: checkJsonText('info.description', raw.info?.description ?? '', 0, 1000),
    image: checkJsonText('info.image', raw.info?.image ?? '', 0, 512),
    externalLink: checkJsonText('info.externalLink', raw.info?.externalLink ?? '', 0, 512),
  };

  const minters = /** @type {unknown[]} */ (raw.minters ?? ['deployer']);
  if (!Array.isArray(minters)) throw new Error('minters: expected a list of addresses (or "deployer")');
  for (const m of minters) {
    if (m !== 'deployer' && (typeof m !== 'string' || !ADDRESS.test(m))) throw new Error(`minters: not an address: ${m}`);
  }

  let tokens = raw.tokens ?? [];
  if (typeof tokens === 'string') tokens = readJson(resolve(dir, tokens));
  if (!Array.isArray(tokens)) throw new Error('tokens: expected a list, or the path of a JSON file holding one');

  return {
    file: path, dir, name, symbol, setId, maxSupply, registry,
    identity: optAddr(raw.identity, 'identity'),
    admin: optAddr(raw.admin, 'admin'),
    json: optAddr(raw.json, 'json'),
    minters: /** @type {string[]} */ (minters),
    images, info, rules, bands: { min, max }, vocab, tokens,
  };
}

/**
 * A trait value by name or number.
 * @param {Trait} t
 * @param {unknown} v
 * @param {string} what
 * @returns {number}
 */
export function indexOf(t, v, what) {
  if (typeof v === 'number') return uint(v, what, 255);
  const i = t.values.indexOf(/** @type {string} */ (v));
  if (i < 0) throw new Error(`${what}: "${v}" is not one of ${JSON.stringify(t.values)}`);
  return i;
}

/** The registry address for a network: the env override, the network's entry, or "default". */
export function registryFor(/** @type {CollectionConfig} */ cfg, /** @type {string} */ network, env = process.env) {
  const a = env.ERC6699_REGISTRY || cfg.registry[network] || cfg.registry.default;
  return a && ADDRESS.test(a) ? a : null;
}

export { checkName };
