// LOCAL CHAIN ONLY: deploy the test stand-in of LitNode's ERC6699Registry, so a collection can be deployed and
// minted end to end on `pnpm node`. It refuses any other chain: on Liteforge a collection uses the canonical registry.
//
//   pnpm node                     (another terminal)
//   pnpm local-registry           -> deployments/local.json { registry }
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';

const { ethers, network } = hre;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337 && chainId !== 31338) throw new Error(`refusing: chain ${chainId} is not a local Hardhat chain`);
  const [admin] = await ethers.getSigners();
  const f = await ethers.getContractFactory('contracts/test/ERC6699Registry.sol:ERC6699Registry');
  const r = await f.deploy(admin.address);
  await r.waitForDeployment();
  const address = await r.getAddress();
  const out = join('deployments', `${network.name}.json`);
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  mkdirSync('deployments', { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...prev, network: network.name, chainId, registry: { address, admin: admin.address, standIn: true } }, null, 2)}\n`);
  console.log(`local registry stand-in: ${address} (admin ${admin.address}) -> ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
