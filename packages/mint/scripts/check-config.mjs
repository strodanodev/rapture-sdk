// Check mint configs without touching a chain: shape, addresses, amounts, templates against the reference collection's
// rules, and the deck against the templates. Exit 1 if any config has a problem.
//
//   node scripts/check-config.mjs my-drop/mint.config.json [more.json ...]
import { config } from "./lib/chain.mjs";

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: node scripts/check-config.mjs <mint.config.json> [...]"); process.exit(2); }
let bad = 0;
for (const f of files) {
  const { cfg, problems, warnings } = config.loadConfig(f);
  for (const w of warnings) console.log(`${f}: warning: ${w}`);
  if (problems.length) {
    bad++;
    console.error(`${f}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    continue;
  }
  const what = cfg.mode === "fixed"
    ? `fixed price ${cfg.fixed.priceText}, ${cfg.templates?.length ?? "?"} templates`
    : `packs of ${cfg.packs.packSize} at ${cfg.packs.priceText}, deck ${cfg.deck.counts.flat().reduce((a, b) => a + b, 0)} cards, ${cfg.templates?.length ?? "?"} templates`;
  console.log(`${f}: ok (${cfg.network}, ${what})`);
}
process.exit(bad ? 1 : 0);
