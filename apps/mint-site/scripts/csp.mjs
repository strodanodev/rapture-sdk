// Rewrite vercel.json from web/site.config.json: run it after changing the RPC, the mint mode or the IPFS gateway.
//
//   node scripts/csp.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSiteConfig } from "../web/lib/config.js";
import { vercelConfig } from "./vercel.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "site.config.json"), "utf8"));
const { problems } = validateSiteConfig(site);
if (problems.length) {
  console.error(`web/site.config.json:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const out = vercelConfig(site);
fs.writeFileSync(path.join(ROOT, "vercel.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote vercel.json. Content-Security-Policy: ${out.headers[0].headers[0].value}`);
