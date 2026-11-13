// The metadata pipeline: collection config -> everything a launch needs, in one folder.
//
//   out/upload/            content-addressed files to publish as ONE directory (pin it: its CID is the image base)
//                          <sha256>.<ext> art, <sha256>.glb avatars, <sha256>.webm turntables, <keccak256>.md souls,
//                          <designHash>.json design documents
//   out/cards.json         the StudioCard tuples, in mint order: what mintBatch takes (and PackShop's templates)
//   out/metadata/<id>.json each token's full character.json, byte for byte what tokenURI will encode
//   out/manifest.json      per token: id, name, designHash and the characterConfigHash its registry twin will hold
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildToken } from './design.js';
import { agentConfig, characterJson, contractJson } from './metadata.js';

/** @typedef {import('./config.js').CollectionConfig} CollectionConfig */
/** @typedef {import('./design.js').BuiltToken} BuiltToken */

/**
 * Build every token in memory (no files written).
 * @param {CollectionConfig} cfg
 * @param {{ read?: (path: string) => Uint8Array, firstIndex?: number }} [io]
 * @returns {BuiltToken[]}
 */
export function buildTokens(cfg, io = {}) {
  const first = io.firstIndex ?? 0;
  if (cfg.maxSupply && first + cfg.tokens.length > cfg.maxSupply) {
    throw new Error(`${cfg.tokens.length} tokens from index ${first} exceed maxSupply ${cfg.maxSupply}`);
  }
  return cfg.tokens.map((src, i) => buildToken(cfg, src, first + i, io));
}

/** JSON with bigints as strings. @param {unknown} v */
const pretty = (v) => `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;

/**
 * Build and write the out/ folder.
 * @param {CollectionConfig} cfg
 * @param {string} outDir
 * @param {{ read?: (path: string) => Uint8Array, firstIndex?: number, imageBase?: string, chainId?: number, collection?: string }} [opts]
 *   imageBase overrides the config's (e.g. the CID a pin returned); chainId + collection add each token's
 *   characterConfigURI to the manifest once the collection is deployed.
 */
export function buildCollection(cfg, outDir, opts = {}) {
  const out = resolve(outDir);
  const tokens = buildTokens(cfg, opts);
  const at = { imageBase: opts.imageBase ?? cfg.images.base, artExt: cfg.images.ext };
  for (const d of ['upload', 'metadata']) mkdirSync(join(out, d), { recursive: true });

  const written = new Set();
  for (const t of tokens) {
    for (const f of t.files) {
      if (written.has(f.name)) continue;   // editions share their files
      writeFileSync(join(out, 'upload', f.name), f.data);
      written.add(f.name);
    }
    writeFileSync(join(out, 'metadata', `${t.tokenId}.json`), characterJson(cfg, t, true, at));
  }
  writeFileSync(join(out, 'cards.json'), pretty(tokens.map((t) => ({ tokenId: t.tokenId, index: t.index, card: t.card }))));
  writeFileSync(join(out, 'contract.json'), `${contractJson(cfg)}\n`);
  const where = opts.chainId != null && opts.collection ? { chainId: opts.chainId, collection: opts.collection } : null;
  const manifest = {
    collection: cfg.name,
    setId: cfg.setId,
    imageBase: at.imageBase,
    tokens: tokens.map((t) => {
      const ac = agentConfig(cfg, t, where ?? { chainId: 0, collection: '0x0000000000000000000000000000000000000000' });
      return {
        tokenId: t.tokenId,
        index: t.index,
        name: t.card.design.name,
        designHash: t.card.design.designHash,
        characterConfigHash: ac.hash,
        ...(where ? { characterConfigURI: ac.uri } : {}),
        files: t.files.map((f) => f.name),
      };
    }),
    upload: [...written].sort(),
  };
  writeFileSync(join(out, 'manifest.json'), pretty(manifest));
  return { tokens, manifest, out };
}
