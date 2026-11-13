// One token's source entry -> its on-chain card (the StudioCard tuple minters pass to mintBatch), its design document
// and the content-addressed files to publish. Checks everything ChampionCollection._checkCard checks, so a bad
// token fails here instead of in a transaction.
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { SEALED, indexOf } from './config.js';
import { ZERO32, canonicalJson, hex64, keccak256, sha256 } from './hash.js';
import { checkName } from './text.js';

/** @typedef {import('./config.js').CollectionConfig} CollectionConfig */
/** @typedef {import('./config.js').TokenSource} TokenSource */
/** @typedef {import('./hash.js').Hex32} Hex32 */

export const DESIGN_SCHEMA = 'rapture-sdk/design/1';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * @typedef {{ faction: number, alignment: number, element: number, frame: number, bodyparts: number,
 *   strength: number, agility: number, resilience: number, intelligence: number }} Traits
 * @typedef {{ chainId: string, collection: string, tokenId: string }} Origin
 * @typedef {{ designHash: Hex32, art: Hex32, turntable: Hex32, overridesHash: Hex32, avatar: Hex32,
 *   avatarPlain: Hex32, soul: Hex32, kit: number, name: string, epithet: string }} Design
 * @typedef {{ to: string, kind: number, traits: Traits, styleSource: Origin, design: Design }} StudioCard
 * @typedef {{ name: string, data: Uint8Array, source: string }} PublishedFile
 * @typedef {{ index: number, tokenId: string, card: StudioCard, designDoc: Record<string, unknown>,
 *   files: PublishedFile[] }} BuiltToken
 */

/**
 * @param {CollectionConfig} cfg
 * @param {TokenSource} src
 * @param {number} index  the token's position in mint order (token id = setId << 32 | index)
 * @param {{ read?: (path: string) => Uint8Array }} [io]
 * @returns {BuiltToken}
 */
export function buildToken(cfg, src, index, io = {}) {
  const read = io.read ?? ((/** @type {string} */ p) => readFileSync(p));
  const what = `tokens[${index}]${src.name ? ` (${src.name})` : ''}`;
  const { rules, vocab } = cfg;
  const tr = vocab.traits;

  const kind = indexOf(tr.kind, src.kind, `${what}.kind`);
  if (kind >= rules.kinds) throw new Error(`${what}.kind: ${kind} is not a Kind of this collection`);
  const faction = indexOf(tr.faction, src.faction ?? 0, `${what}.faction`);
  const element = indexOf(tr.element, src.element ?? 0, `${what}.element`);
  const frame = indexOf(tr.frame, src.frame ?? 0, `${what}.frame`);
  if (faction > rules.maxFaction || element > rules.maxElement || frame > rules.maxFrame) throw new Error(`${what}: a trait is out of range`);
  const alignment = src.alignment === SEALED || (vocab.sealedLabel && src.alignment === vocab.sealedLabel)
    ? SEALED
    : indexOf(tr.alignment, src.alignment ?? 0, `${what}.alignment`);
  if (alignment === SEALED ? !rules.sealedAlignment : alignment > rules.maxAlignment) throw new Error(`${what}.alignment: out of range`);

  const partValues = Array.isArray(src.parts)
    ? src.parts
    : vocab.parts.map((label) => (label && src.parts ? /** @type {Record<string, number>} */ (src.parts)[label] ?? 0 : 0));
  if (partValues.length > 4) throw new Error(`${what}.parts: at most 4`);
  let bodyparts = 0;
  for (let i = 0; i < 4; i++) {
    const p = partValues[i] ?? 0;
    if (!Number.isInteger(p) || p < 0 || p > rules.maxParts[i]) throw new Error(`${what}.parts[${i}]: ${p} is outside 0..${rules.maxParts[i]}`);
    bodyparts += p * 2 ** (8 * i);
  }

  const lo = cfg.bands.min[kind];
  const hi = cfg.bands.max[kind];
  const s = src.stats ?? /** @type {any} */ ({});
  for (const k of /** @type {const} */ (['strength', 'agility', 'resilience', 'intelligence'])) {
    const v = s[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what}.stats.${k}: ${v} is outside the ${tr.kind.values[kind]} band ${lo}..${hi}`);
  }

  const kit = src.kit == null || src.kit === '' ? 0 : typeof src.kit === 'number' ? src.kit : indexOf(tr.kit, src.kit, `${what}.kit`) + 1;
  const needsKit = ((rules.kitKinds >> kind) & 1) === 1;
  if (needsKit ? kit === 0 || kit > rules.maxKit : kit !== 0) {
    throw new Error(`${what}.kit: ${needsKit ? `a ${tr.kind.values[kind]} must name a kit` : `a ${tr.kind.values[kind]} names no kit`}`);
  }

  const name = checkName(`${what}.name`, src.name, 1, 40);
  const epithet = checkName(`${what}.epithet`, src.epithet ?? '', 0, 48);

  /** @type {PublishedFile[]} */
  const files = [];
  const file = (/** @type {string | undefined} */ rel, /** @type {'sha256' | 'keccak256'} */ algo, /** @type {string} */ ext, /** @type {string} */ field) => {
    if (!rel) return ZERO32;
    const path = resolve(cfg.dir, rel);
    const data = read(path);
    const h = algo === 'sha256' ? sha256(data) : keccak256(data);
    files.push({ name: `${hex64(h)}.${ext}`, data, source: path });
    if (extname(path).toLowerCase() !== `.${ext}`) throw new Error(`${what}.${field}: ${rel} must be a .${ext} file`);
    return h;
  };
  if (!src.art) throw new Error(`${what}.art: every token needs its art`);
  const art = file(src.art, 'sha256', cfg.images.ext, 'art');
  const avatar = file(src.avatar, 'sha256', 'glb', 'avatar');
  const avatarPlain = file(src.avatarPlain, 'sha256', 'glb', 'avatarPlain');
  const turntable = file(src.turntable, 'sha256', 'webm', 'turntable');
  const soul = file(src.soul, 'keccak256', 'md', 'soul');
  if (avatarPlain !== ZERO32 && avatar === ZERO32) throw new Error(`${what}.avatarPlain: needs an avatar too`);
  if (rules.requireAvatar && (avatar === ZERO32 || avatarPlain === ZERO32)) throw new Error(`${what}: this collection requires avatar and avatarPlain`);

  const overrides = src.overrides ?? {};
  const overridesHash = keccak256(canonicalJson(overrides));
  const fileName = (/** @type {Hex32} */ h, /** @type {string} */ ext) => (h === ZERO32 ? undefined : `${hex64(h)}.${ext}`);
  const designDoc = {
    schema: DESIGN_SCHEMA,
    collection: cfg.name,
    name,
    epithet,
    kind: tr.kind.values[kind],
    traits: { faction, alignment, element, frame, parts: [0, 1, 2, 3].map((i) => partValues[i] ?? 0), kit },
    stats: { strength: s.strength, agility: s.agility, resilience: s.resilience, intelligence: s.intelligence },
    files: {
      art: fileName(art, cfg.images.ext),
      avatar: fileName(avatar, 'glb'),
      avatarPlain: fileName(avatarPlain, 'glb'),
      turntable: fileName(turntable, 'webm'),
      soul: fileName(soul, 'md'),
    },
    overrides,
  };
  const docText = canonicalJson(designDoc);
  const designHash = keccak256(docText);
  files.push({ name: `${hex64(designHash)}.json`, data: Buffer.from(docText, 'utf8'), source: '(design document)' });

  const o = src.styleSource;
  /** @type {StudioCard} */
  const card = {
    to: src.to ?? ZERO_ADDRESS,
    kind,
    traits: { faction, alignment, element, frame, bodyparts, strength: s.strength, agility: s.agility, resilience: s.resilience, intelligence: s.intelligence },
    styleSource: o
      ? { chainId: String(o.chainId), collection: o.collection.toLowerCase(), tokenId: String(o.tokenId) }
      : { chainId: '0', collection: ZERO_ADDRESS, tokenId: '0' },
    design: { designHash, art, turntable, overridesHash, avatar, avatarPlain, soul, kit, name, epithet },
  };
  const tokenId = ((BigInt(cfg.setId) << 32n) | BigInt(index)).toString();
  return { index, tokenId, card, designDoc, files };
}
