// The deploy stages for both minters, shared by scripts/deploy.js (any network) and test/deploy.test.js. Every stage
// reads the chain first and only sends what is missing, so a half-finished deploy can simply be re-run.
//
// fixed:  shop -> grant -> stock -> preflight -> lock -> open -> handover
// packs:  beacon -> shop -> grant -> stock -> deck (setDeck + lock, irreversible) -> open -> handover
const path = require("node:path");

/** drand evmnet (api.drand.sh/v2/beacons/evmnet/info): the randomness PackShopV2 verifies on chain. */
const DRAND_EVMNET = Object.freeze({
  chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
  genesis: 1727521075,
  period: 3,
  urls: Object.freeze(["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"]),
});
const MINTER_ABI = [
  "function admin() view returns (address)",
  "function minters(address) view returns (bool)",
  "function setMinter(address who, bool on)",
  "function bandOf(uint8 kind) view returns (uint16 min, uint16 max)",
];
const CONTRACT = { fixed: "FixedPriceMinter", packs: "PackShopV2" };

/**
 * Deploy `name` unless `record[key]` already has code. The CREATE address follows from the signer's nonce, so it is
 * saved as `${key}Pending` BEFORE the transaction is sent: a receipt lost to an RPC drop leaves an address to pick up
 * instead of a second deployment.
 */
async function deployOnce(ethers, { name, args = [], key, record, save = () => {}, log = console.log, signer: by = null }) {
  const signer = by ?? (await ethers.getSigners())[0];
  for (const k of [key, `${key}Pending`]) {
    if (record[k] && (await ethers.provider.getCode(record[k])) !== "0x") {
      if (k !== key) { record[key] = record[k]; delete record[k]; log(`${name} found at ${record[key]}: a previous run deployed it and lost the receipt`); }
      else log(`${name} already deployed at ${record[key]}`);
      save(record);
      return ethers.getContractAt(name, record[key], signer);
    }
  }
  record[`${key}Pending`] = ethers.getCreateAddress({ from: signer.address, nonce: await ethers.provider.getTransactionCount(signer.address, "pending") });
  save(record);
  const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
  await c.waitForDeployment();
  record[key] = await c.getAddress();
  record[`${key}Tx`] = c.deploymentTransaction().hash;
  delete record[`${key}Pending`];
  save(record);
  log(`${name} deployed ${record[key]} (tx ${record[`${key}Tx`]})`);
  return c;
}

/** The latest published evmnet round with its signature, from the first mirror that answers. */
async function latestBeacon(urls = DRAND_EVMNET.urls) {
  for (const u of urls) {
    try {
      const r = await fetch(`${u}/v2/beacons/evmnet/rounds/latest`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); return { round: BigInt(j.round), signature: "0x" + j.signature }; }
    } catch { /* next mirror */ }
  }
  throw new Error("no drand evmnet mirror answered");
}

/** Prove that this chain verifies drand evmnet signatures: a static proveRound call with a real, current round. */
async function checkBeacon(ethers, { registry, log = console.log }) {
  const { round, signature } = await latestBeacon();
  await registry.proveRound.staticCall(signature, round);
  log(`EvmnetRegistry verifies drand evmnet round ${round} on this chain (BN254 precompiles OK)`);
}

/** Read-only: run EvmnetRegistry's code against this chain (an eth_call state override) with a real round. */
async function preflightBeacon(ethers, artifacts, log = console.log) {
  const art = await artifacts.readArtifact("EvmnetRegistry");
  const { round, signature } = await latestBeacon();
  const probe = "0x00000000000000000000000000000000000E7e47";
  const iface = new ethers.Interface(art.abi);
  const verifies = (r) => ethers.provider.send("eth_call", [{ to: probe, data: iface.encodeFunctionData("proveRound", [signature, r]) }, "latest", { [probe]: { code: art.deployedBytecode } }])
    .then(() => true, () => false);
  const [accepts, rejectsOther] = [await verifies(round), !(await verifies(round - 1n))];
  if (accepts && rejectsOther) log(`preflight: this chain verifies drand evmnet round ${round} and rejects it for round ${round - 1n} (BN254 precompiles OK)`);
  else log(`preflight inconclusive (accepts ${accepts}, rejects a wrong round ${rejectsOther}): the RPC may ignore state overrides. The live run checks again before deploying the shop.`);
}

const minterAt = async (ethers, address, signer = null) => new ethers.Contract(address, MINTER_ABI, signer ?? (await ethers.getSigners())[0] ?? ethers.provider);
async function minterAdmin(ethers, address) {
  try { return await (await minterAt(ethers, address)).admin(); } catch { return null; }
}

/**
 * Give the shop the MINTER role. Only the minter's admin can: when the signer is not it, this logs the exact call the
 * admin (often a Safe) must make and returns false.
 */
async function grantMinter(ethers, { minter, shop, log = console.log, signer: by = null }) {
  const signer = by ?? (await ethers.getSigners())[0];
  const m = await minterAt(ethers, minter, signer);
  const addr = await shop.getAddress();
  if (await m.minters(addr)) { log("the shop already holds the MINTER role"); return true; }
  const admin = await minterAdmin(ethers, minter);
  if (!admin || admin.toLowerCase() !== signer.address.toLowerCase()) {
    log(`MINTER not granted: the minter's admin${admin ? ` ${admin}` : ""} must call setMinter(${addr}, true) on ${minter}, then re-run this deploy`);
    return false;
  }
  const rc = await (await m.setMinter(addr, true)).wait();
  log(`granted MINTER to the shop (tx ${rc.hash})`);
  return true;
}

/** Load templates the shop does not have yet, `batch` at a time, checking what is already there against the file. */
async function stock(ethers, { shop, templates, supplies = null, batch = 10, log = console.log }) {
  const have = Number(await shop.templateCount());
  if (have > templates.length) throw new Error(`the shop holds ${have} templates but only ${templates.length} were given`);
  for (let i = 0; i < have; i++) {
    if ((await shop.templateOf(i)).design.designHash.toLowerCase() !== templates[i].design.designHash.toLowerCase()) throw new Error(`template ${i} on chain is not the one in the file`);
    if (supplies && Number((await shop.editionOf(i)).maxSupply) !== supplies[i]) throw new Error(`template ${i}'s edition size on chain is not the one in the config`);
  }
  const strip = ({ supply, ...t }) => t;   // eslint-disable-line no-unused-vars
  for (let i = have; i < templates.length; i += batch) {
    const part = templates.slice(i, i + batch).map(strip);
    const tx = supplies ? shop.addTemplates(part, supplies.slice(i, i + batch)) : shop.addTemplates(part);
    const rc = await (await tx).wait();
    log(`templates ${i}..${i + part.length - 1} loaded (gas ${rc.gasUsed.toLocaleString()})`);
  }
  log(`${Number(await shop.templateCount())} templates in the shop`);
}

/** Fixed price: prove every template mints, without minting (ownerMint as a static call). Needs the MINTER role. */
async function preflightFixed(ethers, { shop, to, log = console.log }) {
  const n = Number(await shop.templateCount());
  const bad = [];
  for (let i = 0; i < n; i++) {
    const e = await shop.editionOf(i);
    if (e.retired || e.minted >= e.maxSupply) continue;
    try { await shop.ownerMint.staticCall(to, i, 1); } catch (err) { bad.push(`template ${i}: ${err.shortMessage || err.message}`); }
  }
  if (bad.length) throw new Error(`these templates would not mint on this collection:\n  ${bad.join("\n  ")}`);
  log(`preflight: all ${n} templates mint on this collection`);
}

/** Fixed price: freeze the catalogue (irreversible). */
async function lockCatalogue(ethers, { shop, log = console.log }) {
  if (await shop.locked()) return log("catalogue already locked");
  const rc = await (await shop.lock()).wait();
  log(`catalogue LOCKED: ${await shop.templateCount()} templates (tx ${rc.hash})`);
}

/** Packs: set the print run and lock it, unless the shop is already locked with exactly this deck. */
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

/** Unpause once the shop can sell. */
async function openSales(ethers, { shop, log = console.log }) {
  if (!(await shop.ready())) throw new Error("the shop is not ready: grant MINTER (and, for packs, lock the deck) first");
  if (await shop.paused()) {
    const rc = await (await shop.unpause()).wait();
    log(`sales opened (tx ${rc.hash})`);
  } else log("sales already open");
}

/** Start the two-step ownership transfer (the new owner, e.g. a Safe, then calls acceptOwnership). */
async function handOver(ethers, { shop, to, log = console.log }) {
  if ((await shop.owner()).toLowerCase() === to.toLowerCase()) return log(`owner is already ${to}`);
  if ((await shop.pendingOwner()).toLowerCase() === to.toLowerCase()) return log(`${to} still has to call acceptOwnership() on ${await shop.getAddress()}`);
  const rc = await (await shop.transferOwnership(to)).wait();
  log(`ownership offered to ${to}: it must call acceptOwnership() on ${await shop.getAddress()} (tx ${rc.hash})`);
}

async function describe(shop, mode) {
  const c = await shop.config();
  const common = { owner: await shop.owner(), pendingOwner: await shop.pendingOwner(), paused: c.paused_, ready: c.ready_ };
  if (mode === "fixed") {
    return { ...common, price: c.price_.toString(), maxPerWallet: Number(c.maxPerWallet_), locked: c.locked_, templates: Number(c.templateCount_), minted: Number(c.totalMinted_), maxSupply: Number(c.maxSupply_) };
  }
  return {
    ...common, price: c.price_.toString(), packSize: Number(c.packSize_), dailyLimit: Number(c.dailyLimit_), locked: await shop.locked(),
    maxSupply: Number(c.maxSupply_), packsTotal: Number(c.packsTotal_), packsSold: Number(c.packsSold_), cardsLeft: Number(c.cardsLeft_),
    templates: Number(c.templateCount_), nextToDeal: Number(await shop.nextToDeal()),
  };
}

/** A local chain only: the reference collection (the Studio contracts the live Rapture collection runs) to sell. */
async function deployReferenceCollection(ethers, log = console.log) {
  const { deployStudio } = require(path.join(__dirname, "..", "..", "test", "helpers", "deployStudio.js"));
  const studio = await deployStudio(ethers, { minters: [] });
  const out = { minter: await studio.minter.getAddress(), cards: await studio.cards.getAddress(), design: await studio.design.getAddress(), metadata: await studio.metadata.getAddress(), setId: studio.setId };
  log(`reference collection deployed: minter ${out.minter}, cards ${out.cards} (set ${out.setId}, token ids start at ${BigInt(out.setId) << 32n})`);
  return out;
}

/**
 * Run the deploy for a loaded config (scripts/lib/config.js). record: the deployments file's object (mutated and
 * passed to save after every step). opts: stage ("all" or one stage name), log, save, checkBeacon (default true).
 * Returns { shop, record, granted }.
 */
async function runDeploy(hre, cfg, record, { stage = "all", log = console.log, save = () => {}, checkBeacon: wantBeaconCheck = true, signer: by = null } = {}) {
  const { ethers } = hre;
  const mode = cfg.mode;
  const name = CONTRACT[mode];
  const signer = by ?? (await ethers.getSigners())[0];
  const run = (s) => stage === "all" || stage === s;
  record.mode = mode;
  record.contract = name;
  record.collection = { ...(record.collection ?? {}), minter: cfg.collection.minter, cards: cfg.collection.cards, tokenIdBase: cfg.collection.tokenIdBase };
  save(record);

  let beacon = null;
  if (mode === "packs") {
    if (cfg.packs.beacon) {
      record.beacon = cfg.packs.beacon;
      if ((await ethers.provider.getCode(record.beacon)) === "0x") throw new Error(`packs.beacon ${record.beacon} has no code on this chain`);
      beacon = await ethers.getContractAt("EvmnetRegistry", record.beacon, signer);
    } else if (run("beacon") || !record.beacon) {
      beacon = await deployOnce(ethers, { name: "EvmnetRegistry", key: "beacon", record, save, log, signer });
    } else beacon = await ethers.getContractAt("EvmnetRegistry", record.beacon, signer);
    if (wantBeaconCheck) await checkBeacon(ethers, { registry: beacon, log });
  }

  if (!run("shop") && !record.shop) throw new Error(`STAGE=${stage} needs a deployed shop: run the shop stage first`);
  const args = mode === "fixed"
    ? [cfg.collection.minter, signer.address, cfg.fixed.price, cfg.fixed.maxPerWallet]
    : [cfg.collection.minter, record.beacon, signer.address, cfg.packs.price, cfg.packs.packSize, cfg.packs.dailyLimit];
  const shop = run("shop")
    ? await deployOnce(ethers, { name, args, key: "shop", record, save, log, signer })
    : await ethers.getContractAt(name, record.shop, signer);
  if (!record.shopArgs) record.shopArgs = args.map(String);
  if (!record.deployedAt) record.deployedAt = new Date().toISOString();
  save(record);

  let granted = await (await minterAt(ethers, cfg.collection.minter, signer)).minters(await shop.getAddress());
  if (run("grant")) granted = await grantMinter(ethers, { minter: cfg.collection.minter, shop, log, signer });
  const isOwner = (await shop.owner()).toLowerCase() === signer.address.toLowerCase();
  if (!isOwner && ["stock", "preflight", "lock", "deck", "open"].some(run)) {
    log(`the signer is no longer the shop's owner (${await shop.owner()}): the remaining setup is the owner's`);
  } else {
    if (run("stock")) await stock(ethers, { shop, templates: cfg.templates, supplies: mode === "fixed" ? cfg.supplies : null, log });
    if (mode === "fixed") {
      if (run("preflight") && granted) await preflightFixed(ethers, { shop, to: signer.address, log });
      if (run("lock") && cfg.fixed.lock) await lockCatalogue(ethers, { shop, log });
    } else if (run("deck")) {
      const reserveTo = cfg.packs.reserveTo ?? cfg.owner ?? signer.address;
      await setDeckAndLock(ethers, { shop, counts: cfg.deck.counts, reserveTo, log });
    }
    if (run("open")) {
      if (granted) await openSales(ethers, { shop, log });
      else log("sales stay closed until the shop holds the MINTER role");
    }
    if (cfg.owner && run("handover")) await handOver(ethers, { shop, to: cfg.owner, log });
  }
  record.owner = await shop.owner();
  record.pendingOwner = await shop.pendingOwner();
  save(record);
  return { shop, record, granted, beacon };
}

module.exports = {
  DRAND_EVMNET, MINTER_ABI, CONTRACT,
  deployOnce, latestBeacon, checkBeacon, preflightBeacon, minterAdmin, grantMinter, stock, preflightFixed, lockCatalogue,
  setDeckAndLock, openSales, handOver, describe, deployReferenceCollection, runDeploy,
};
