// The deploy stages, shared by scripts/deploy.js (any network) and the tests. Every stage reads the chain first and only
// sends what is missing, so a half-finished deploy can simply be re-run.
//
// fixed:  shop -> grant -> stock -> preflight -> lock -> open -> handover
// packs (PackShop v2, packs/lib/deploy-packs.js, where this kit has packs/): its own stages around the same shop,
// grant, stock, open and handover.
const path = require("node:path");
const { requirePacks } = require("./packs.js");

const MINTER_ABI = [
  "function admin() view returns (address)",
  "function minters(address) view returns (bool)",
  "function setMinter(address who, bool on)",
  "function bandOf(uint8 kind) view returns (uint16 min, uint16 max)",
];
const FIXED = "FixedPriceMinter";

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

/** Unpause once the shop can sell. */
async function openSales(ethers, { shop, log = console.log }) {
  if (!(await shop.ready())) throw new Error("the shop is not ready: grant MINTER first (and lock a pack shop's deck)");
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
  if (mode !== "fixed") return requirePacks("deploy-packs.js").describe(shop);
  const c = await shop.config();
  return {
    owner: await shop.owner(), pendingOwner: await shop.pendingOwner(), paused: c.paused_, ready: c.ready_,
    price: c.price_.toString(), maxPerWallet: Number(c.maxPerWallet_), locked: c.locked_, templates: Number(c.templateCount_), minted: Number(c.totalMinted_), maxSupply: Number(c.maxSupply_),
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
 * passed to save after every step). opts: stage ("all" or one stage name), log, save, signer, and options the pack module
 * reads (checkBeacon). Mode "packs" needs packs/ (lib/packs.js). Returns { shop, record, granted, extra }.
 */
async function runDeploy(hre, cfg, record, opts = {}) {
  const { stage = "all", log = console.log, save = () => {}, signer: by = null } = opts;
  const { ethers } = hre;
  const mode = cfg.mode;
  const packs = mode === "fixed" ? null : requirePacks("deploy-packs.js");
  const name = packs ? packs.CONTRACT : FIXED;
  const signer = by ?? (await ethers.getSigners())[0];
  const run = (s) => stage === "all" || stage === s;
  record.mode = mode;
  record.contract = name;
  record.collection = { ...(record.collection ?? {}), minter: cfg.collection.minter, cards: cfg.collection.cards, tokenIdBase: cfg.collection.tokenIdBase };
  save(record);

  const extra = packs ? await packs.beforeShop(hre, cfg, record, { ...opts, run, save, log, signer, deployOnce }) : null;
  if (!run("shop") && !record.shop) throw new Error(`STAGE=${stage} needs a deployed shop: run the shop stage first`);
  const args = packs ? packs.shopArgs(cfg, record, signer) : [cfg.collection.minter, signer.address, cfg.fixed.price, cfg.fixed.maxPerWallet];
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
    if (run("stock")) await stock(ethers, { shop, templates: cfg.templates, supplies: packs ? null : cfg.supplies, log });
    if (packs) await packs.afterStock(hre, cfg, { shop, signer, run, log });
    else {
      if (run("preflight") && granted) await preflightFixed(ethers, { shop, to: signer.address, log });
      if (run("lock") && cfg.fixed.lock) await lockCatalogue(ethers, { shop, log });
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
  return { shop, record, granted, extra };
}

module.exports = {
  MINTER_ABI, FIXED,
  deployOnce, minterAdmin, grantMinter, stock, preflightFixed, lockCatalogue, openSales, handOver, describe,
  deployReferenceCollection, runDeploy,
};
