// Read finished cards from a collection on chain (read-only) and write them as minter templates.
//
//   node scripts/export-templates.mjs --config examples/rapture/mint.config.json [--from <tokenId>] [--count N] [--out file]
//
// A template is a card's kind, traits, stats, style source and design record: exactly what the collection minter's
// mintBatch takes, minus the recipient. The card contract and its design record contract come from the minter's
// cards() and design() views (the reference StudioMinter has both); collection.cards in the config overrides the
// first. Token ids run from --from (default collection.tokenIdBase) for --count ids (default the collection's
// totalSupply, at most 1024). Cards are read in token order and de-duplicated by designHash, so re-running after a
// shop has minted editions still yields one template per design. Writes the config's templates file unless --out.
import fs from "node:fs";
import path from "node:path";
import { ethers, parseArgs, networkInfo, provider, loadConfigOrExit, pool, CARD_TUPLE, STATS_TUPLE, ORIGIN_TUPLE, DESIGN_TUPLE } from "./lib/chain.mjs";

const args = parseArgs();
const cfg = loadConfigOrExit(args.config || process.env.MINT_CONFIG || "mint.config.json");
const net = networkInfo(args.network || cfg.network);
const p = provider(net);
const LIMIT = 1024;

const minter = new ethers.Contract(cfg.collection.minter, ["function cards() view returns (address)", "function design() view returns (address)"], p);
const cardsAddr = cfg.collection.cards ?? (await minter.cards());
const designAddr = args.design ?? (await minter.design());
const cards = new ethers.Contract(cardsAddr, [
  `function cardOf(uint256) view returns (${CARD_TUPLE})`,
  `function coreStats(uint256) view returns (${STATS_TUPLE})`,
  `function originOf(uint256) view returns (${ORIGIN_TUPLE})`,
  "function totalSupply() view returns (uint256)",
], p);
const design = new ethers.Contract(designAddr, [`function designOf(uint256) view returns (${DESIGN_TUPLE})`], p);

const from = BigInt(args.from ?? cfg.collection.tokenIdBase);
const count = Math.min(Number(args.count ?? (await cards.totalSupply())), LIMIT);
console.log(`cards ${cardsAddr}, design records ${designAddr}: reading ${count} token ids from ${from}`);
const ids = Array.from({ length: count }, (_, n) => from + BigInt(n));

const rows = await pool(ids, 6, async (id) => {
  try {
    const [card, stats, origin, d] = await Promise.all([cards.cardOf(id), cards.coreStats(id), cards.originOf(id), design.designOf(id)]);
    process.stdout.write(".");
    return { id, card, stats, origin, d };
  } catch { process.stdout.write("x"); return null; }   // a burned or missing id
});
console.log();

const seen = new Set();
const templates = [];
for (const row of rows) {
  if (!row) continue;
  const { id, card, stats, origin, d } = row;
  if (d.designHash === ethers.ZeroHash) continue;           // no design record: not a finished card
  if (!card.revealed) throw new Error(`token ${id} is not revealed`);
  if (seen.has(d.designHash)) continue;                     // an edition of a design already exported
  seen.add(d.designHash);
  templates.push({
    id: templates.length,
    sourceTokenId: id.toString(),
    template: {
      kind: Number(card.kind),
      traits: {
        faction: Number(card.faction), alignment: Number(card.alignment), element: Number(card.element), frame: Number(card.frame),
        bodyparts: Number(card.bodyparts),
        strength: Number(stats.strength), agility: Number(stats.agility), resilience: Number(stats.resilience), intelligence: Number(stats.intelligence),
      },
      styleSource: { chainId: origin.chainId.toString(), collection: origin.collection, tokenId: origin.tokenId.toString() },
      design: {
        designHash: d.designHash, art: d.art, turntable: d.turntable, overridesHash: d.overridesHash,
        avatar: d.avatar, avatarPlain: d.avatarPlain, soul: d.soul, kit: Number(d.kit), name: d.name, epithet: d.epithet,
      },
    },
  });
}

console.log(`${templates.length} templates: ${[0, 1, 2, 3, 4].map((k) => `kind ${k}: ${templates.filter((t) => t.template.kind === k).length}`).join("  ")}`);
const out = args.out ? path.resolve(args.out) : cfg.templatesFile;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ chainId: net.chainId, source: { cards: cardsAddr, design: designAddr, from: from.toString(), count }, exportedAt: new Date().toISOString(), templates }, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)}`);
