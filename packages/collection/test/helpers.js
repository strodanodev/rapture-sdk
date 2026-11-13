// Shared test fixtures: the example configs, deployed against a stand-in registry on the Hardhat chain.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { id } from 'ethers';

import { loadConfig, normalizeConfig } from '../src/config.js';
import { buildTokens } from '../src/build.js';
import { deployCollection } from '../scripts/lib/deploy.js';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REGISTRY = 'contracts/test/ERC6699Registry.sol:ERC6699Registry';

/** File contents for tests: deterministic bytes per path, so no art is needed (and none is shipped). */
export const fakeRead = (/** @type {string} */ p) => Buffer.from(`test file ${basename(p)}`);

/**
 * An example config (examples/<name>/collection.json), its token list resolved, optionally edited first.
 * @param {string} name
 * @param {(raw: any) => void} [edit]
 */
export function example(name, edit = () => {}) {
  const file = join(ROOT, 'examples', name, 'collection.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.tokens = loadConfig(file).tokens;
  edit(raw);
  return normalizeConfig(raw, file);
}

/**
 * Deploy a registry stand-in and the collection from a config. approve: the registry admin approves the collection.
 * @param {any} ethers
 * @param {import('../src/config.js').CollectionConfig} cfg
 * @param {{ approve?: boolean, admin?: string }} [o]
 */
export async function deploy(ethers, cfg, o = {}) {
  const [deployer, ...others] = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory(REGISTRY)).deploy(deployer.address);
  await registry.waitForDeployment();
  const d = await deployCollection(ethers, cfg, { registry: await registry.getAddress(), admin: o.admin });
  await (await d.collection.setMinter(deployer.address, true)).wait();
  if (o.approve ?? true) await (await registry.setMinter(await d.collection.getAddress(), true)).wait();
  const tokens = buildTokens(cfg, { read: fakeRead });
  return { ...d, registry, deployer, others, tokens };
}

/** A token's card addressed to `to`. @param {import('../src/design.js').BuiltToken} t @param {string} to */
export const cardTo = (t, to) => ({ ...t.card, to });

/**
 * Await a call that must revert with a custom error.
 * @param {Promise<unknown>} p
 * @param {string} error
 */
export async function reverts(p, error) {
  await assert.rejects(p, (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    // Hardhat names the error when it can map the revert to a contract, else it prints the raw selector
    const selector = id(`${error}()`).slice(0, 10);
    assert.ok(msg.includes(error) || msg.includes(selector), `expected ${error}, got: ${msg.slice(0, 300)}`);
    return true;
  });
}

/** Decode a data:application/json;base64 URI. @param {string} uri */
export function decodeDataUri(uri) {
  assert.ok(uri.startsWith('data:application/json;base64,'), uri.slice(0, 60));
  return Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8');
}
