// Verify a deployed collection's contracts on a Blockscout explorer, and write the verification package (standard
// JSON input + constructor arguments per contract) to verification/<network>/ for a manual upload.
//
//   BLOCKSCOUT_URL=https://<liteforge blockscout> node scripts/verify.mjs liteforge
//   node scripts/verify.mjs liteforge --package-only
//
// Reads deployments/<network>.json (written by pnpm deploy) and the Hardhat build in artifacts/ (run pnpm compile
// with the same sources first). There is no default explorer URL: set BLOCKSCOUT_URL to Liteforge's current one.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface } from 'ethers';

import { standardInput, verifyOnBlockscout } from '../src/blockscout.js';

const SOURCES = {
  ChampionJson: 'contracts/ChampionJson.sol',
  ChampionMetadata: 'contracts/ChampionMetadata.sol',
  ChampionCollection: 'contracts/ChampionCollection.sol',
};

const net = process.argv[2];
const packageOnly = process.argv.includes('--package-only');
if (!net) {
  console.error('usage: node scripts/verify.mjs <network> [--package-only]');
  process.exit(2);
}
const dep = JSON.parse(readFileSync(join('deployments', `${net}.json`), 'utf8'));
const explorer = process.env.BLOCKSCOUT_URL;
if (!packageOnly && !explorer) {
  console.error('set BLOCKSCOUT_URL to the explorer (Blockscout) of this chain, or pass --package-only');
  process.exit(2);
}

/** The build that holds a contract, newest first. @param {string} source @param {string} name */
function buildOf(source, name) {
  const dir = join('artifacts', 'build-info');
  const builds = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const b = builds.find((x) => x.output?.contracts?.[source]?.[name]);
  if (!b) throw new Error(`no build of ${source}:${name} in artifacts/: run pnpm compile`);
  return b;
}

const outDir = join('verification', net);
mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const [name, source] of Object.entries(SOURCES)) {
  const c = dep.contracts?.[name];
  if (!c?.address) continue;
  const build = buildOf(source, name);
  const abi = JSON.parse(readFileSync(join('artifacts', source, `${name}.json`), 'utf8')).abi;
  const constructorArgs = new Interface(abi).encodeDeploy(c.args).slice(2);
  const { input, compilerVersion } = standardInput(build, source, name);
  writeFileSync(join(outDir, `${name}.standard-input.json`), `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(join(outDir, `${name}.constructor-args.txt`), `${constructorArgs}\n`);
  console.log(`${name} ${c.address}: package written (${compilerVersion})`);
  if (packageOnly || !explorer) continue;
  try {
    const r = await verifyOnBlockscout({ explorer, address: c.address, sourceName: source, contractName: name, build, constructorArgs, log: (m) => console.log(`  ${m}`) });
    console.log(`  ${r.status}: ${r.message}`);
  } catch (e) {
    failed++;
    console.error(`  ${name}: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(failed ? 1 : 0);
