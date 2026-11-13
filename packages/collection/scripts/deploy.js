// Deploy a collection from its config. Never deploys a registry.
//
//   COLLECTION_CONFIG=examples/starter/collection.json pnpm deploy --network local       (after pnpm local-registry)
//   COLLECTION_CONFIG=my/collection.json DEPLOYER_KEY=0x... pnpm deploy --network liteforge
//
// The registry is ERC6699_REGISTRY, else the config's "registry"[<network>], else "registry".default; on the local
// chain it is the stand-in scripts/local-registry.js recorded. Writes deployments/<network>.json (addresses,
// constructor arguments for verification) and prints what the registry admin must run to approve the collection.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';

import { loadConfig, registryFor } from '../src/config.js';
import { deployCollection, registryStatus } from './lib/deploy.js';

const { ethers, network } = hre;
const LOCAL = new Set([31337, 31338]);

async function main() {
  const file = process.env.COLLECTION_CONFIG;
  if (!file) throw new Error('set COLLECTION_CONFIG to your collection.json');
  const cfg = loadConfig(file);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = join('deployments', `${network.name}.json`);
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};

  let registry = registryFor(cfg, network.name);
  if (!registry && LOCAL.has(chainId)) registry = previous.registry?.address ?? null;
  if (!registry) {
    throw new Error(`no ERC6699Registry for network "${network.name}": set ERC6699_REGISTRY or "registry" in ${file}`
      + (LOCAL.has(chainId) ? ' (on the local chain, run pnpm local-registry first)' : ''));
  }
  const [signer] = await ethers.getSigners();
  console.log(`deploying "${cfg.name}" on ${network.name} (chain ${chainId}) from ${signer.address}\nregistry ${registry}`);

  const d = await deployCollection(ethers, cfg, { registry, log: (m) => console.log(`  ${m}`) });
  let status = await registryStatus(ethers, registry, d.record.ChampionCollection.address);
  // the local stand-in only: its admin is this signer, so approve the collection the way the real admin would
  if (!status.approved && previous.registry?.standIn && LOCAL.has(chainId) && status.admin.toLowerCase() === signer.address.toLowerCase()) {
    const r = await ethers.getContractAt('contracts/test/ERC6699Registry.sol:ERC6699Registry', registry);
    await (await r.setMinter(d.record.ChampionCollection.address, true)).wait();
    console.log('  local stand-in registry: approved the collection (on Liteforge the registry admin does this)');
    status = await registryStatus(ethers, registry, d.record.ChampionCollection.address);
  }
  const record = {
    ...previous,
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    config: file,
    registry: { ...(previous.registry ?? {}), address: registry, admin: status.admin, approved: status.approved },
    admin: d.admin,
    contracts: Object.fromEntries(Object.entries(d.record).map(([name, r]) => [name, {
      ...r,
      args: r.args.map((a) => (typeof a === 'bigint' ? a.toString() : a)),
    }])),
  };
  mkdirSync('deployments', { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${out}`);

  const collection = d.record.ChampionCollection.address;
  if (status.approved) {
    console.log('the registry already lists this collection as a MINTER: every mint is mirrored');
  } else {
    console.log([
      '',
      'NOT YET APPROVED by the registry. Mints succeed, but each token stays MirrorPending until the registry admin',
      `(${status.admin}) runs:`,
      '',
      `  cast send ${registry} "setMinter(address,bool)" ${collection} true --rpc-url <rpc> --private-key <registry admin key>`,
      '',
      'then anyone mirrors the pending tokens with collection.mirror([tokenIds]) (pnpm mint does it automatically).',
    ].join('\n'));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
