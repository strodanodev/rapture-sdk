// Content hashes, as the contracts and the metadata name files: sha256 for art and avatars, keccak256 for
// SOUL.MD and for canonical JSON (the design document, the overrides, the location-free character.json).
import { createHash } from 'node:crypto';
import { keccak256 as ethersKeccak, toUtf8Bytes } from 'ethers';

/** @typedef {`0x${string}`} Hex32 */

export const ZERO32 = /** @type {Hex32} */ (`0x${'0'.repeat(64)}`);

/** @param {Uint8Array | string} data @returns {Hex32} */
export function sha256(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return /** @type {Hex32} */ (`0x${createHash('sha256').update(bytes).digest('hex')}`);
}

/** @param {Uint8Array | string} data @returns {Hex32} */
export function keccak256(data) {
  return /** @type {Hex32} */ (ethersKeccak(typeof data === 'string' ? toUtf8Bytes(data) : data));
}

/** 64 lowercase hex digits without 0x: the file name a hash addresses (ChampionJson.hex64). @param {string} h */
export function hex64(h) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not a 32-byte hash: ${h}`);
  return h.slice(2).toLowerCase();
}

/**
 * Canonical JSON: object keys sorted, no whitespace, numbers as JSON prints them. The hashes of the design document
 * and the overrides are keccak256 of this form, so anyone can recompute them.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonical JSON has no NaN or Infinity');
    if (value === undefined) throw new Error('canonical JSON has no undefined');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
