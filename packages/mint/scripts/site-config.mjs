// After a deploy: point a mint site (the Rapture SDK's apps/mint-site template) at the shop. Read-only on chain.
//
//   node scripts/site-config.mjs --config my-drop/mint.config.json --site ../../apps/mint-site/web/site.config.json [--network local]
//
// Reads the shop from deployments/<network>.json next to the config and CHECKS it on chain before writing: it must
// have code and the MINTER role, a fixed-price catalogue must hold templates (a pack shop runs its own checks, from
// packs/), and the shop's templates must be the config's, in order. Then it rewrites
// the site config's "chain", "mint" and "cards" sections (a card keeps the "art" it had) and leaves branding, art and
// text alone. Public data only. A paused shop is fine: the site says sales are closed.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ethers, parseArgs, networkInfo, provider, loadConfigOrExit, deploymentOrExit, TEMPLATE_TUPLE } from "./lib/chain.mjs";

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
} else {
  // a pack shop (PackShop v2): its checks live with it in packs/, where this kit has it
  const { requirePacks } = createRequire(import.meta.url)("./lib/packs.js");
  const packs = requirePacks("site-packs.js");
  mint = await packs.mintSection({ ethers, p, dep, cfg, cards, tokenIdBase });
}


// the shop's templates are the config's, in order: the site names cards by template id
const reader = new ethers.Contract(dep.shop, ["function templateCount() view returns (uint256)", `function templateOf(uint256) view returns (${TEMPLATE_TUPLE})`], p);
const count = Number(await reader.templateCount());
if (count !== cfg.templates.length) throw new Error(`the shop holds ${count} templates, the config ${cfg.templates.length}`);
for (let i = 0; i < count; i++) {
  if ((await reader.templateOf(i)).design.designHash.toLowerCase() !== cfg.templates[i].design.designHash.toLowerCase()) throw new Error(`template ${i} on chain is not the config's`);
}
// the collection's design records (the reference StudioMinter names them with design()): any token -> its design
const collectionMinter = dep.referenceCollection?.minter ?? cfg.collection.minter;
mint.designRecords = await new ethers.Contract(collectionMinter, ["function design() view returns (address)"], p).design().catch(() => null);

const site = JSON.parse(fs.readFileSync(sitePath, "utf8"));
const artOf = new Map((site.cards ?? []).filter((c) => c.art).map((c) => [c.id, c.art]));
site.chain = { id: net.chainId, name: net.name, rpc: net.rpc, explorer: net.explorer ?? null, faucet: site.chain?.faucet ?? null, currency: net.currency };
site.mint = mint;
site.cards = cfg.templates.map((t, id) => ({ id, name: t.design.name, epithet: t.design.epithet, kind: t.kind, designHash: t.design.designHash, ...(artOf.has(id) ? { art: artOf.get(id) } : {}) }));
fs.writeFileSync(sitePath, JSON.stringify(site, null, 2) + "\n");
console.log(`wrote the chain, mint and cards sections of ${path.relative(process.cwd(), sitePath)} (${site.cards.length} cards). In the site folder, run pnpm csp to refresh vercel.json's Content-Security-Policy.`);
