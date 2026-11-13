// PackShopV2 launch stages, shared by the local dev chain and the Liteforge launch. Like lib/launch.js, every stage
// reads the chain first and only sends what is missing, so a half-finished launch can be re-run. Templates, the
// MINTER grant and opening sales are the same calls as v1 and are reused from there.
const { grantMinter, stock } = require("./launch.js");

const PRICE = 10n ** 15n;   // 0.001 zkLTC
const DRAND_EVMNET = Object.freeze({
  chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
  genesis: 1727521075,
  period: 3,
  urls: ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"],
});

/**
 * Deploy `name` unless `record[key]` already has code. The CREATE address follows from the signer's nonce, so it is
 * saved as `${key}Pending` BEFORE the transaction is sent: a receipt lost to an RPC drop leaves an address to pick up
 * instead of a second deployment.
 */
async function deployOnce(ethers, { name, args = [], key, record, save = () => {}, log = console.log }) {
  for (const k of [key, `${key}Pending`]) {
    if (record[k] && (await ethers.provider.getCode(record[k])) !== "0x") {
      if (k !== key) { record[key] = record[k]; delete record[k]; log(`${name} found at ${record[key]}: a previous run deployed it and lost the receipt`); }
      else log(`${name} already deployed at ${record[key]}`);
      return ethers.getContractAt(name, record[key]);
    }
  }
  const [signer] = await ethers.getSigners();
  record[`${key}Pending`] = ethers.getCreateAddress({ from: signer.address, nonce: await ethers.provider.getTransactionCount(signer.address, "pending") });
  save(record);
  const c = await (await ethers.getContractFactory(name)).deploy(...args);
  await c.waitForDeployment();
  record[key] = await c.getAddress();
  record[`${key}Tx`] = c.deploymentTransaction().hash;
  delete record[`${key}Pending`];
  log(`${name} deployed ${record[key]} (tx ${record[`${key}Tx`]})`);
  return c;
}

/** The latest published evmnet round with its signature, from the first beacon URL that answers. */
async function latestBeacon(urls = DRAND_EVMNET.urls) {
  for (const u of urls) {
    try {
      const r = await fetch(`${u}/v2/beacons/evmnet/rounds/latest`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); return { round: BigInt(j.round), signature: "0x" + j.signature }; }
    } catch { /* next mirror */ }
  }
  throw new Error("no drand evmnet endpoint answered");
}

/** Prove that this chain verifies drand evmnet signatures: a static call of proveRound with a real, current round. */
async function checkBeacon(ethers, { registry, log = console.log }) {
  const { round, signature } = await latestBeacon();
  await registry.proveRound.staticCall(signature, round);
  log(`EvmnetRegistry verifies drand evmnet round ${round} on this chain (BN254 precompiles OK)`);
}

/** Set the print run and lock it, unless the shop is already locked with exactly this deck. */
async function setDeckAndLock(ethers, { shop, counts, reserveTo, log = console.log }) {
  const want = counts.flat().map(Number);
  if (await shop.locked()) {
    const have = Array.from(await shop.deckInitial(), (row) => Array.from(row, Number)).flat();
    if (have.join() !== want.join()) throw new Error(`the shop is locked with another deck (${have.join("/")})`);
    return log(`deck already locked: ${await shop.maxSupply()} cards`);
  }
  await (await shop.setDeck(counts, reserveTo)).wait();
  const rc = await (await shop.lock()).wait();
  log(`deck set and LOCKED: ${await shop.maxSupply()} cards, ${await shop.packsTotal()} packs, reserve ${await shop.reserveSize()} -> ${reserveTo} (tx ${rc.hash})`);
}

/** Start the two-step ownership transfer (the new owner, e.g. a Safe, then calls acceptOwnership). */
async function handOver(ethers, { shop, to, log = console.log }) {
  if ((await shop.owner()).toLowerCase() === to.toLowerCase()) return log(`owner is already ${to}`);
  if ((await shop.pendingOwner()).toLowerCase() === to.toLowerCase()) return log(`${to} still has to acceptOwnership()`);
  const rc = await (await shop.transferOwnership(to)).wait();
  log(`ownership offered to ${to}: it must call acceptOwnership() (tx ${rc.hash})`);
}

/** Unpause once the shop can sell: locked, MINTER granted, not sold out or shut down. */
async function openSales(ethers, { shop, log = console.log }) {
  if (!(await shop.ready())) throw new Error("the shop is not ready: lock the deck and grant MINTER first");
  if (await shop.paused()) {
    const rc = await (await shop.unpause()).wait();
    log(`sales opened (tx ${rc.hash})`);
  } else log("sales already open");
}

async function describeV2(shop) {
  const c = await shop.config();
  return {
    price: c.price_.toString(), packSize: Number(c.packSize_), dailyLimit: Number(c.dailyLimit_), paused: c.paused_, ready: c.ready_,
    maxSupply: Number(c.maxSupply_), packsTotal: Number(c.packsTotal_), packsSold: Number(c.packsSold_), cardsLeft: Number(c.cardsLeft_),
    templates: Number(c.templateCount_), locked: await shop.locked(), owner: await shop.owner(), nextToDeal: Number(await shop.nextToDeal()),
  };
}

/** The file the browser client reads (web/assets/rapture/packshop*.json) for a v2 shop. Public data only. */
function webConfigV2({ network, chainId, rpc, explorer, faucet, packShop, cards, registry, deck, templates }) {
  return {
    network, chainId, rpc, explorer: explorer ?? null, faucet: faucet ?? null,
    currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
    version: 2,
    packShop, cards,
    beacon: { registry, chainHash: DRAND_EVMNET.chainHash, genesis: DRAND_EVMNET.genesis, period: DRAND_EVMNET.period, urls: DRAND_EVMNET.urls },
    deck: { kinds: deck.kinds, finishes: deck.finishes, counts: deck.counts, total: deck.total },
    templates: templates.map((t) => ({ id: t.id, sourceTokenId: t.sourceTokenId, designHash: t.template.design.designHash, kind: t.template.kind })),
    writtenAt: new Date().toISOString(),
  };
}

module.exports = { PRICE, DRAND_EVMNET, deployOnce, latestBeacon, checkBeacon, setDeckAndLock, handOver, describeV2, webConfigV2, grantMinter, stock, openSales };
