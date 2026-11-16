// Check mint configs without touching a chain: shape, addresses, amounts, templates against the reference collection's
// rules (and, for a pack shop where this kit has packs/, its deck). Exit 1 if any config has a problem.
//
//   node scripts/check-config.mjs my-drop/mint.config.json [more.json ...]
//   node scripts/check-config.mjs --examples        every mint.config.json under examples/ (and packs/examples/, if here)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./lib/chain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = () => ["examples", "packs/examples"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d))
  .flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((f) => path.basename(f) === "mint.config.json").map((f) => path.relative(process.cwd(), path.join(d, f))))
  .sort();
const files = process.argv[2] === "--examples" ? examples() : process.argv.slice(2);
if (!files.length) { console.error("usage: node scripts/check-config.mjs <mint.config.json> [...] | --examples"); process.exit(2); }
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
    : `${cfg.mode}, ${cfg.templates?.length ?? "?"} templates`;
  console.log(`${f}: ok (${cfg.network}, ${what})`);
}
process.exit(bad ? 1 : 0);
