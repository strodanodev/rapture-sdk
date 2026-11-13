// Launch PackShopV2 on Liteforge: the drand evmnet registry, the shop, the MINTER grant, the 50 templates, the
// ARC 1 deck (locked for good), open sales, and optionally hand ownership to a Safe.
//
//   PACKSHOP_CONFIRM=liteforge DEPLOYER_KEY=<StudioMinter admin key> [OWNER=<Safe>] [RESERVE_TO=<wallet>] \
//     npx hardhat run scripts/launch-v2.js --network liteforge
//
// The signer must be the StudioMinter admin (only it can grant MINTER). It deploys and configures the shop as its
// owner. With OWNER set, it then offers ownership to that address (two-step: the Safe calls acceptOwnership()).
// After lock() the owner can no longer change any pull, only pause sales, set price/limit, withdraw and shut down.
// RESERVE_TO receives the 3-card reserve pack (default: OWNER, else the signer). Without PACKSHOP_CONFIRM=liteforge
// this only prints what it WOULD do and checks, read-only, that Liteforge verifies drand signatures.
// Re-run after any failure: each stage reads the chain first. STAGE=registry|shop|grant|stock|deck|open|handover runs one.
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, artifacts } = require("hardhat");
const L = require("./lib/launch-v2.js");

async function main() {
  if (network.name !== "liteforge") throw new Error(`launch-v2.js is for the liteforge network (got ${network.name}); local runs use local-setup-v2.js`);
  const file = path.join(__dirname, "..", "deployments", "liteforge.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const readData = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", f), "utf8"));
  const templates = readData("templates.liteforge.json").templates.map((t) => t.template);
  const deck = readData("deck.arc1.json");
  const [signer] = await ethers.getSigners();
  const stage = process.env.STAGE || "all";
  const live = process.env.PACKSHOP_CONFIRM === "liteforge";
  const owner = process.env.OWNER || null;
  if (!signer && live) throw new Error("no signer: set DEPLOYER_KEY (the StudioMinter admin key)");
  const who = signer ? signer.address : dep.collection.admin;
  const reserveTo = process.env.RESERVE_TO || owner || who;
  for (const [k, v] of [["OWNER", owner], ["RESERVE_TO", reserveTo]]) if (v && !ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);

  const bal = await ethers.provider.getBalance(who);
  console.log(`${signer ? "signer" : "no DEPLOYER_KEY set; the launch must be signed by the StudioMinter admin"} ${who}  balance ${ethers.formatEther(bal)} zkLTC`);
  if (signer && signer.address.toLowerCase() !== dep.collection.admin.toLowerCase()) console.log(`WARNING: the StudioMinter admin is ${dep.collection.admin}; only it can grant PackShopV2 the minter role`);
  console.log(`StudioMinter ${dep.collection.StudioMinter}   templates: ${templates.length}   deck: ${deck.total} cards (${deck.total % deck.packSize} reserve -> ${reserveTo})`);

  const v2 = dep.packShopV2 ?? {};
  const record = { registry: dep.evmnetRegistry?.address, registryPending: dep.evmnetRegistry?.pending, shop: v2.address, shopPending: v2.pending };
  const persist = () => {
    dep.evmnetRegistry = { ...(dep.evmnetRegistry ?? {}), address: record.registry, pending: record.registryPending, ...(record.registryTx ? { tx: record.registryTx } : {}) };
    dep.packShopV2 = { ...(dep.packShopV2 ?? {}), address: record.shop, pending: record.shopPending, ...(record.shopTx ? { tx: record.shopTx } : {}) };
    for (const o of [dep.evmnetRegistry, dep.packShopV2]) for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  };

  if (!live) {
    // read-only preflight: the registry's runtime code, run against Liteforge state (an eth_call state override) with
    // a real drand signature. It must accept that round AND reject the same signature for another round: a call to a
    // code-less address also "succeeds", so the rejection is what proves the override ran and the pairing checked.
    const art = await artifacts.readArtifact("EvmnetRegistry");
    const { round, signature } = await L.latestBeacon();
    const probe = "0x00000000000000000000000000000000000E7e47";
    const iface = new ethers.Interface(art.abi);
    const verifies = (r) => ethers.provider.send("eth_call", [{ to: probe, data: iface.encodeFunctionData("proveRound", [signature, r]) }, "latest", { [probe]: { code: art.deployedBytecode } }])
      .then(() => true, () => false);
    const [accepts, rejectsOther] = [await verifies(round), !(await verifies(round - 1n))];
    if (accepts && rejectsOther) console.log(`preflight: Liteforge verifies drand evmnet round ${round} and rejects it for round ${round - 1n} (BN254 precompiles OK)`);
    else console.log(`preflight inconclusive (accepts ${accepts}, rejects a wrong round ${rejectsOther}): the RPC may ignore state overrides. The live run checks again before deploying the shop.`);
    console.log("\nDRY RUN (set PACKSHOP_CONFIRM=liteforge to send transactions). Stages that would run:");
    console.log("  registry  EvmnetRegistry (permissionless drand evmnet verifier), then a static proveRound check");
    console.log("  shop      PackShopV2(minter, registry, owner=signer, price 0.001 zkLTC, 5 cards, 3 packs/day)");
    console.log("  grant     StudioMinter.setMinter(PackShopV2, true)");
    console.log(`  stock     addTemplates x${Math.ceil(templates.length / 10)} batches of 10`);
    console.log(`  deck      setDeck(ARC 1: ${deck.counts.map((r) => r.join("/")).join("  ")}) + lock()   <- irreversible`);
    console.log("  open      unpause()");
    console.log(`  handover  ${owner ? `transferOwnership(${owner}); the Safe must acceptOwnership()` : "skipped (set OWNER=<Safe address>)"}`);
    console.log("\nAfter launch: node scripts/write-web-config.mjs, start the keeper (node scripts/keeper.mjs), and pause the v1 shop.");
    return;
  }
  if (bal < ethers.parseEther("0.03")) throw new Error("fund the signer with at least 0.03 zkLTC first (https://liteforge.hub.caldera.xyz)");

  const run = (s) => stage === "all" || stage === s;
  const registry = run("registry") || !record.registry
    ? await L.deployOnce(ethers, { name: "EvmnetRegistry", key: "registry", record, save: persist })
    : await ethers.getContractAt("EvmnetRegistry", record.registry);
  persist();
  await L.checkBeacon(ethers, { registry });

  if (!run("shop") && !record.shop) throw new Error(`STAGE=${stage} needs a deployed shop: run the shop stage first`);
  const shop = run("shop")
    ? await L.deployOnce(ethers, { name: "PackShopV2", key: "shop", record, save: persist,
        args: [dep.collection.StudioMinter, record.registry, signer.address, L.PRICE, 5, 3] })
    : await ethers.getContractAt("PackShopV2", record.shop);
  if (!dep.packShopV2?.deployedAt) dep.packShopV2 = { ...(dep.packShopV2 ?? {}), deployedAt: new Date().toISOString() };
  persist();

  if (run("grant")) await L.grantMinter(ethers, { minter: dep.collection.StudioMinter, shop });
  if (run("stock")) await L.stock(ethers, { shop, templates });
  if (run("deck")) await L.setDeckAndLock(ethers, { shop, counts: deck.counts, reserveTo });
  if (run("open")) await L.openSales(ethers, { shop });
  if (owner && run("handover")) await L.handOver(ethers, { shop, to: owner });
  dep.packShopV2.owner = await shop.owner();
  persist();
  console.log("\nPackShopV2 state:", await L.describeV2(shop));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
