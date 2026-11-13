// Mint the built cards (out/cards.json) to a wallet with mintBatch, in chunks, from a MINTER key. Also mirrors any
// tokens still MirrorPending once the registry has approved the collection.
//
//   MINT_TO=0x... pnpm mint --network local
//   MINT_TO=0x... DEPLOYER_KEY=0x... pnpm mint --network liteforge
//
// Env: CARDS (default out/cards.json), MINT_TO (default: the signer), BATCH (default 5), MIRROR_ONLY=1.
// The cards must be minted in order: their token ids (setId << 32 | index) were predicted from it, and the script
// stops if the collection's nextIndex does not match the next card's index.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';

const { ethers, network } = hre;

async function main() {
  const dep = JSON.parse(readFileSync(join('deployments', `${network.name}.json`), 'utf8'));
  const address = dep.contracts?.ChampionCollection?.address;
  if (!address) throw new Error(`deployments/${network.name}.json has no ChampionCollection: run pnpm deploy first`);
  const collection = await ethers.getContractAt('ChampionCollection', address);
  const [signer] = await ethers.getSigners();
  const to = process.env.MINT_TO || signer.address;
  const batch = Number(process.env.BATCH || 5);
  const cards = /** @type {{ tokenId: string, index: number, card: any }[]} */ (JSON.parse(readFileSync(process.env.CARDS || 'out/cards.json', 'utf8')));

  if (!process.env.MIRROR_ONLY) {
    if (!(await collection.minters(signer.address))) throw new Error(`${signer.address} is not a MINTER: the admin runs collection.setMinter(${signer.address}, true)`);
    let next = Number(await collection.nextIndex());
    const todo = cards.filter((c) => c.index >= next);
    if (todo.length && todo[0].index !== next) throw new Error(`the collection is at index ${next}, the next card is ${todo[0].index}: rebuild with the right first index`);
    for (let i = 0; i < todo.length; i += batch) {
      const chunk = todo.slice(i, i + batch);
      const tx = await collection.mintBatch(chunk.map((c) => ({ ...c.card, to })));
      await tx.wait();
      next += chunk.length;
      console.log(`minted ${chunk.map((c) => c.tokenId).join(', ')} (${tx.hash})`);
    }
  }

  const pending = Number(await collection.pendingMirrors());
  if (pending === 0) return console.log('every token is mirrored into the registry');
  const registry = await ethers.getContractAt('contracts/interfaces/IERC6699Registry.sol:IERC6699Registry', await collection.registry());
  if (!(await registry.minters(address))) {
    return console.log(`${pending} tokens wait for the registry admin to approve the collection (see the README)`);
  }
  const ids = [];
  const total = Number(await collection.nextIndex());
  const setId = BigInt(await collection.setId());
  for (let i = 0; i < total; i++) {
    const id = (setId << 32n) | BigInt(i);
    if (!(await collection.isMirrored(id))) ids.push(id);
  }
  for (let i = 0; i < ids.length; i += 20) {
    const tx = await collection.mirror(ids.slice(i, i + 20));
    await tx.wait();
    console.log(`mirrored ${ids.slice(i, i + 20).length} tokens (${tx.hash})`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
