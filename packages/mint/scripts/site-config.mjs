// After a deploy: point a mint site (the Rapture SDK's apps/mint-site template) at the shop. Read-only on chain.
//
//   node scripts/site-config.mjs --config my-drop/mint.config.json --site ../../apps/mint-site/web/site.config.json [--network local]
//
// Reads the shop from deployments/<network>.json next to the config and CHECKS it on chain before writing: it must
// have code and the MINTER role, a fixed-price catalogue must hold templates, and a packs shop must be locked with the
// config's deck and use the recorded beacon. Then it rewrites the site config's "chain" and "mint" sections and
// leaves branding, art and text alone. Public data only. A paused shop is fine: the site says sales are closed.
import fs from "node:fs";
import path from "node:path";
import { ethers, parseArgs, networkInfo, provider, loadConfigOrExit, deploymentOrExit } from "./lib/chain.mjs";

const args = parseArgs();
const cfg = loadConfigOrExit(args.config || process.env.MINT_CONFIG || "mint.config.json");
const NET = args.network || cfg.network;
const dep = deploymentOrExit(cfg, NET);
const net = networkInfo(NET);
const p = provider(net);
const sitePath = path.resolve(args.site || path.join(import.meta.dirname, "..", "..", "..", "apps", "mint-site", "web", "site.config.json"));
if (!fs.existsSync(sitePath)) { console.error(`no site config at ${sitePath}: pass --site <path to site.config.json>`); process.exit(1); }

if ((await p.getCode(dep.shop)) === "0x") throw new Error(`no code at ${dep.shop} on ${NET}`);
const cards = dep.referenceCollection?.cards ?? cfg.collection.cards;
const tokenIdBase = dep.referenceCollection ? String(BigInt(dep.referenceCollection.setId) << 32n) : cfg.collection.tokenIdBase;
if (!cards) throw new Error("collection.cards (the ERC-721 address) is not set in the mint config: the site's library needs it");

let mint;
if (dep.contract === "FixedPriceMinter") {
  const shop = new ethers.Contract(dep.shop, ["function config() view returns (uint256 price, uint32 maxPerWallet, bool paused, bool ready, bool locked, uint256 templateCount, uint256 totalMinted, uint256 maxSupply)"], p);
  const c = await shop.config();
  if (!c.ready) throw new Error("the minter does not hold the MINTER role on the collection yet");
  if (c.templateCount === 0n) throw new Error("the minter has no templates");
  console.log(`FixedPriceMinter ${dep.shop}: ${ethers.formatEther(c.price)} per card, ${c.templateCount} templates, ${c.totalMinted}/${c.maxSupply} minted, paused ${c.paused}, locked ${c.locked}`);
  mint = { mode: "fixed", address: dep.shop, collection: cards, tokenIdBase };
} else if (dep.contract === "PackShopV2") {
  const shop = new ethers.Contract(dep.shop, [
    "function config() view returns (uint256 price, uint8 packSize, uint16 dailyLimit, bool paused, bool ready, uint32 maxSupply, uint32 packsTotal, uint32 packsSold, uint256 cardsLeft, uint256 templateCount)",
    "function deckInitial() view returns (uint16[3][5])",
    "function locked() view returns (bool)",
    "function beacon() view returns (address)",
  ], p);
  const c = await shop.config();
  if (!(await shop.locked())) throw new Error("the shop's deck is not locked");
  const onChain = Array.from(await shop.deckInitial(), (row) => Array.from(row, Number)).flat().join("/");
  if (onChain !== cfg.deck.counts.flat().join("/")) throw new Error(`the locked deck (${onChain}) is not the config's deck`);
  if ((await shop.beacon()).toLowerCase() !== dep.beacon.toLowerCase()) throw new Error("the shop's beacon is not the recorded EvmnetRegistry");
  if (!c.ready) throw new Error("the shop is not ready (MINTER role? sold out? shut down?)");
  console.log(`PackShopV2 ${dep.shop}: ${ethers.formatEther(c.price)} a pack of ${c.packSize}, ${c.cardsLeft}/${c.maxSupply} cards left, paused ${c.paused}`);
  mint = { mode: "packs", address: dep.shop, collection: cards, tokenIdBase, beacon: { registry: dep.beacon } };
} else throw new Error(`unknown contract ${dep.contract} in the deployment record`);

const site = JSON.parse(fs.readFileSync(sitePath, "utf8"));
site.chain = { id: net.chainId, name: net.name, rpc: net.rpc, explorer: net.explorer ?? null, currency: net.currency };
site.mint = mint;
fs.writeFileSync(sitePath, JSON.stringify(site, null, 2) + "\n");
console.log(`wrote the chain and mint sections of ${path.relative(process.cwd(), sitePath)}. In the site folder, run pnpm csp to refresh vercel.json's Content-Security-Policy.`);
