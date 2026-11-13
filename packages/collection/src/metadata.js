// Each token's character.json, built off chain byte for byte as ChampionMetadata + ChampionJson build it on chain.
// The tests deploy the contracts and compare, so a collection can preview, host or verify its metadata without
// a node: characterConfigHash (what the registry twin holds) is keccak256 of the location-free form.
import { SEALED } from './config.js';
import { ZERO_ADDRESS } from './design.js';
import { hex64, keccak256 } from './hash.js';

/** @typedef {import('./config.js').CollectionConfig} CollectionConfig */
/** @typedef {import('./design.js').BuiltToken} BuiltToken */
/** @typedef {import('./design.js').Design} Design */

export const SCHEMA = 'rapture-sdk/champion/1';

/** @param {string[]} xs */
const list = (xs) => `[${xs.map((x) => `"${x}"`).join(',')}]`;

/** @param {number} m thousandths */
function milli(m) {
  if (m >= 1000) return '1.000';
  return `0.${String(m).padStart(3, '0')}`;
}

/** @param {string} tagline @param {string} epithet */
export function bioOf(tagline, epithet) {
  if (!epithet) return tagline;
  if (!tagline) return epithet;
  return `${epithet}. ${tagline}`;
}

/** @param {string} base @param {string} ext @param {Design} d */
function locations(base, ext, d) {
  const anim = /^0x0+$/.test(d.avatar) ? '' : `"animation_url":"${base}${hex64(d.avatar)}.glb",`;
  return `"image":"${base}${hex64(d.art)}.${ext}",${anim}"external_url":"${base}${hex64(d.designHash)}.json",`;
}

/** @param {{ strength: number, agility: number, resilience: number, intelligence: number }} s */
function style(s) {
  const total = s.strength + s.agility + s.resilience + s.intelligence || 1;
  const w = (/** @type {number} */ v) => milli(Math.floor((v * 1000) / total));
  return `"style":{"combatWeights":{"aggression":${w(s.strength)},"tempo":${w(s.agility)},"defense":${w(s.resilience)},"economy":${w(s.intelligence)}},"frameReactions":{"retreatBelowHealth":0.25,"engageAbove":0.6}}`;
}

const zero = (/** @type {string} */ h) => /^0x0+$/.test(h);
const h32 = (/** @type {string} */ h) => h.toLowerCase();

/** @param {Design} d @param {string[]} requires */
function avatar(d, requires) {
  let out = '';
  if (!zero(d.avatar)) {
    const plain = zero(d.avatarPlain) ? '' : `,"plain":{"file":"${hex64(d.avatarPlain)}.glb","sha256":"${h32(d.avatarPlain)}"}`;
    out = `"avatar":{"schema":"erc6699-avatar/1","format":"model/gltf-binary","file":"${hex64(d.avatar)}.glb","sha256":"${h32(d.avatar)}","requires":${list(requires)}${plain}},`;
  }
  if (!zero(d.soul)) out += `"soul":{"format":"text/markdown","file":"${hex64(d.soul)}.md","keccak256":"${h32(d.soul)}"},`;
  return out;
}

/** @param {CollectionConfig} cfg @param {BuiltToken} token */
function attributes(cfg, token) {
  const { card } = token;
  const t = card.traits;
  const d = card.design;
  const v = cfg.vocab;
  /** @param {string} acc @param {string} label @param {string} value */
  const attr = (acc, label, value) => {
    if (!label) return acc;
    const piece = `{"trait_type":"${label}","value":"${value}"}`;
    return acc ? `${acc},${piece}` : piece;
  };
  /** @param {string} acc @param {string} label @param {number | string} value @param {boolean} display */
  const num = (acc, label, value, display) => {
    const piece = `{"trait_type":"${label}","value":${value}${display ? ',"display_type":"number"}' : '}'}`;
    return acc ? `${acc},${piece}` : piece;
  };
  /** @param {string} acc @param {keyof typeof v.traits} which @param {number} i */
  const trait = (acc, which, i) => {
    const tr = v.traits[which];
    return attr(acc, tr.label, i < tr.values.length ? tr.values[i] : String(i));
  };
  let a = trait('', 'kind', card.kind);
  a = trait(a, 'faction', t.faction);
  a = t.alignment === SEALED ? attr(a, v.traits.alignment.label, v.sealedLabel) : trait(a, 'alignment', t.alignment);
  a = trait(a, 'element', t.element);
  a = trait(a, 'frame', t.frame);
  for (let i = 0; i < 4; i++) {
    if (v.parts[i]) a = num(a, v.parts[i], Math.floor(t.bodyparts / 2 ** (8 * i)) % 256, false);
  }
  if (d.epithet) a = attr(a, 'Epithet', d.epithet);
  if (d.kit !== 0) a = trait(a, 'kit', d.kit - 1);
  a = num(a, 'Strength', t.strength, true);
  a = num(a, 'Agility', t.agility, true);
  a = num(a, 'Resilience', t.resilience, true);
  a = num(a, 'Intelligence', t.intelligence, true);
  const o = card.styleSource;
  if (o.collection.toLowerCase() !== ZERO_ADDRESS) a = attr(a, 'Origin', `eip155:${o.chainId}/erc721:${o.collection.toLowerCase()}/${o.tokenId}`);
  return `"attributes":[${a}]`;
}

/** @param {CollectionConfig} cfg @param {BuiltToken} token */
function block(cfg, token) {
  const { card } = token;
  const t = card.traits;
  const d = card.design;
  const p = [0, 1, 2, 3].map((i) => Math.floor(t.bodyparts / 2 ** (8 * i)) % 256);
  return `"collection":{"schema":"${SCHEMA}","name":"${cfg.name}","setId":${cfg.setId},"tokenId":"${token.tokenId}","index":${token.index}`
    + `,"kind":${card.kind},"faction":${t.faction},"alignment":${t.alignment},"element":${t.element},"frame":${t.frame}`
    + `,"parts":[${p.join(',')}],"kit":${d.kit}`
    + `,"design":{"hash":"${h32(d.designHash)}","file":"${hex64(d.designHash)}.json","art":"${h32(d.art)}","overrides":"${h32(d.overridesHash)}"}}`;
}

/**
 * The token's character.json. withLocations = false is the hashed form: no "image", "animation_url" or
 * "external_url", so moving the files never changes the hash.
 * @param {CollectionConfig} cfg
 * @param {BuiltToken} token
 * @param {boolean} withLocations
 * @param {{ imageBase?: string, artExt?: string }} [at]  where the files are (default: the config's images)
 */
export function characterJson(cfg, token, withLocations, at = {}) {
  const d = token.card.design;
  const bio = bioOf(cfg.vocab.tagline, d.epithet);
  return `{"name":"${d.name}","bio":"${bio}","description":"${bio}",`
    + (withLocations ? locations(at.imageBase ?? cfg.images.base, at.artExt ?? cfg.images.ext, d) : '')
    + `${style(token.card.traits)},"boundaries":{"equipmentSlots":${list(cfg.vocab.equipmentSlots)}},`
    + avatar(d, cfg.vocab.avatarRequires)
    + `${attributes(cfg, token)},${block(cfg, token)}}`;
}

/** The data: URI tokenURI returns. @param {CollectionConfig} cfg @param {BuiltToken} token @param {{ imageBase?: string, artExt?: string }} [at] */
export function tokenUri(cfg, token, at) {
  return `data:application/json;base64,${Buffer.from(characterJson(cfg, token, true, at), 'utf8').toString('base64')}`;
}

/**
 * ERC-6699 characterConfigURI and characterConfigHash, as agentConfig returns them and the registry twin holds them.
 * @param {CollectionConfig} cfg
 * @param {BuiltToken} token
 * @param {{ chainId: number | bigint | string, collection: string }} where
 */
export function agentConfig(cfg, token, where) {
  return {
    uri: `eip155:${where.chainId}/erc721:${where.collection.toLowerCase()}/${token.tokenId}`,
    hash: keccak256(characterJson(cfg, token, false)),
  };
}

/** The collection-level JSON contractURI encodes. @param {CollectionConfig} cfg */
export function contractJson(cfg) {
  const i = cfg.info;
  return `{"name":"${cfg.name}","description":"${i.description}","image":"${i.image}","external_link":"${i.externalLink}"}`;
}

/**
 * Recover the location-free form from a full character.json string (what a reader does to check characterConfigHash
 * from tokenURI alone).
 * @param {string} full
 */
export function stripLocations(full) {
  return full.replace(/"(image|animation_url|external_url)":"[^"]*",/g, '');
}
