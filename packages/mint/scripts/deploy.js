// Deploy a minter for a collection, from a mint config (scripts/lib/config.js).
//
//   MINT_CONFIG=examples/fixed/mint.config.json npx hardhat run scripts/deploy.js --network local
//   MINT_CONFIG=my-drop/mint.config.json DEPLOYER_KEY=0x… npx hardhat run scripts/deploy.js --network liteforge          (dry run)
//   MINT_CONFIRM=liteforge MINT_CONFIG=my-drop/mint.config.json DEPLOYER_KEY=0x… npx hardhat run scripts/deploy.js --network liteforge
//
// On a local chain (hardhat, local) it always runs, and when the config's collection minter has no code there it
// first deploys the reference collection to sell, so any config can be rehearsed end to end. On any other network it
// is a DRY RUN unless MINT_CONFIRM names that network: it prints the plan and runs read-only checks.
// The signer deploys the shop and owns it while setting it up. Granting the MINTER role needs the collection minter's
// admin: when the signer is not it, the run says which call the admin must make, and a re-run continues. With "owner"
// set in the config, ownership is then offered to it (two-step: it calls acceptOwnership()).
// Re-run after any failure: each stage reads the chain first. STAGE=<name> runs one stage (fixed: shop grant stock
// preflight lock open handover; packs: beacon shop grant stock deck open handover).
// Records addresses in deployments/<network>.json next to the config. SKIP_BEACON_CHECK=1 skips the live drand check.
const path = require("node:path");
const hre = require("hardhat");
const { loadConfig, LOCAL_NETWORKS, readDeployments, writeDeployments, deploymentsFile } = require("./lib/config.js");
const D = require("./lib/deploy.js");

async function main() {
  const { ethers, network, artifacts } = hre;
  const file = process.env.MINT_CONFIG || "mint.config.json";
  const { cfg, problems, warnings } = loadConfig(file);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (problems.length) throw new Error(`${file} has problems:\n  ${problems.join("\n  ")}`);
  if (!cfg.templates) throw new Error(`${file}: the templates file is missing`);
  const local = LOCAL_NETWORKS.has(network.name);
  if (!local && network.name !== cfg.network) throw new Error(`${file} is for network ${cfg.network}, not ${network.name}`);
  const live = local || process.env.MINT_CONFIRM === network.name;
  const [signer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const record = readDeployments(cfg, network.name) ?? { network: network.name, chainId };
  const save = () => writeDeployments(cfg, network.name, record);

  console.log(`${cfg.mode === "fixed" ? "FixedPriceMinter" : "PackShopV2"} for ${path.relative(process.cwd(), cfg.file)} on ${network.name} (chain ${chainId})`);
  console.log(`templates: ${cfg.templates.length}${cfg.mode === "packs" ? `   deck: ${cfg.deck.counts.flat().reduce((a, b) => a + b, 0)} cards in packs of ${cfg.packs.packSize}` : ""}`);

  if (local && (await ethers.provider.getCode(cfg.collection.minter)) === "0x") {
    if (!record.referenceCollection || (await ethers.provider.getCode(record.referenceCollection.minter)) === "0x") {
      console.log(`collection minter ${cfg.collection.minter} has no code on this local chain: deploying the reference collection to sell`);
      record.referenceCollection = await D.deployReferenceCollection(ethers);
      save();
    }
    cfg.collection.minter = record.referenceCollection.minter;
    cfg.collection.cards = record.referenceCollection.cards;
    cfg.collection.tokenIdBase = String(BigInt(record.referenceCollection.setId) << 32n);
  }

  if (!live) {
    const who = signer?.address ?? null;
    if (who) console.log(`signer ${who}  balance ${ethers.formatEther(await ethers.provider.getBalance(who))}`);
    else console.log("no DEPLOYER_KEY set: a live run needs one");
    const admin = await D.minterAdmin(ethers, cfg.collection.minter);
    if ((await ethers.provider.getCode(cfg.collection.minter)) === "0x") throw new Error(`collection.minter ${cfg.collection.minter} has no code on ${network.name}`);
    console.log(`collection minter ${cfg.collection.minter}, admin ${admin ?? "(no admin() view)"}${who && admin && admin.toLowerCase() !== who.toLowerCase() ? "  <- not the signer: it must grant MINTER itself" : ""}`);
    if (cfg.mode === "packs" && !cfg.packs.beacon) await D.preflightBeacon(ethers, artifacts);
    console.log(`\nDRY RUN (set MINT_CONFIRM=${network.name} to send transactions). Stages that would run:`);
    if (cfg.mode === "fixed") {
      console.log(`  shop       FixedPriceMinter(minter, owner=signer, price ${cfg.fixed.priceText}, ${cfg.fixed.maxPerWallet || "no"} per-wallet limit)`);
      console.log("  grant      setMinter(shop, true) on the collection minter (its admin only)");
      console.log(`  stock      addTemplates x${Math.ceil(cfg.templates.length / 10)} batches of 10 (edition sizes ${[...new Set(cfg.supplies)].join(", ")})`);
      console.log("  preflight  every template mints (static ownerMint calls, nothing sent)");
      console.log(`  lock       ${cfg.fixed.lock ? "lock(): the catalogue and edition sizes are frozen   <- irreversible" : "skipped (fixed.lock is false)"}`);
    } else {
      console.log(`  beacon     ${cfg.packs.beacon ? `use EvmnetRegistry ${cfg.packs.beacon}` : "EvmnetRegistry (permissionless drand evmnet verifier), then a static proveRound check"}`);
      console.log(`  shop       PackShopV2(minter, beacon, owner=signer, price ${cfg.packs.priceText}, ${cfg.packs.packSize} cards, ${cfg.packs.dailyLimit || "no"} daily limit)`);
      console.log("  grant      setMinter(shop, true) on the collection minter (its admin only)");
      console.log(`  stock      addTemplates x${Math.ceil(cfg.templates.length / 10)} batches of 10`);
      console.log(`  deck       setDeck(${cfg.deck.counts.map((r) => r.join("/")).join("  ")}) + lock()   <- irreversible`);
    }
    console.log("  open       unpause()");
    console.log(`  handover   ${cfg.owner ? `transferOwnership(${cfg.owner}); it must call acceptOwnership()` : "skipped (set \"owner\" in the config, e.g. a Safe)"}`);
    console.log(`\nAfter it: pnpm verify, pnpm site-config${cfg.mode === "packs" ? ", and start the keeper (pnpm keeper)" : ""}.`);
    return;
  }
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");

  const { shop } = await D.runDeploy(hre, cfg, record, {
    stage: process.env.STAGE || "all", save, checkBeacon: !process.env.SKIP_BEACON_CHECK,
  });
  console.log(`\n${record.contract} state:`, await D.describe(shop, cfg.mode));
  console.log(`recorded in ${path.relative(process.cwd(), deploymentsFile(cfg, network.name))}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
