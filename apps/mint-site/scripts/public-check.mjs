// The public kit's own check. The rapture-sdk mirror publishes this template without the pack module (web/packs/ and
// test/packs/: PackShop v2 stays in Rapture's private build until the pack shop launches; scripts/publish-mirrors.sh
// PRIVATE[rapture-sdk]). This copies the template to a temp folder without them, links node_modules, and runs the site
// check and every test there, offline, then proves a "packs" config is refused with a clear reason.
//
//   node scripts/public-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** What the mirror drops from this template (keep in step with PRIVATE[rapture-sdk]). */
const PRIVATE = ["web/packs", "test/packs"].map((p) => p.split("/").join(path.sep));
/** Local state: never copied. */
const LOCAL = ["node_modules", ".vercel", path.join("web", "site.config.local.json")];

if (!PRIVATE.some((p) => fs.existsSync(path.join(ROOT, p)))) {
  console.log("public-only pass: skipped, this already is the public kit (no web/packs/)");
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rapture-mint-site-public-"));
const nm = path.join(tmp, "node_modules");
let status = 1;
const run = (what, args, { expectFail = null } = {}) => {
  console.log(`\n== public-only pass: ${what} (${tmp})`);
  const r = spawnSync(process.execPath, args, { cwd: tmp, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (expectFail) {
    if (r.status === 0 || !expectFail.test(`${r.stdout}${r.stderr}`)) throw new Error(`public-only pass: ${what}: expected a failure matching ${expectFail}`);
  } else if (r.status !== 0) throw new Error(`public-only pass failed: ${what}`);
};
try {
  const skip = new Set([...PRIVATE, ...LOCAL]);
  fs.cpSync(ROOT, tmp, { recursive: true, filter: (src) => !skip.has(path.relative(ROOT, src)) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), nm, "junction");
  run("the site check, without the pack module", [path.join("scripts", "check.mjs")]);
  run("every test, without the pack module", ["--test", "test/**/*.test.mjs"]);
  const packs = JSON.parse(fs.readFileSync(path.join(tmp, "web", "site.config.json"), "utf8"));
  packs.mint.mode = "packs";
  fs.writeFileSync(path.join(tmp, "packs.config.json"), JSON.stringify(packs));
  run('a "packs" config is refused', [path.join("scripts", "check.mjs"), "--config", "packs.config.json"], { expectFail: /isn't published in this kit yet/ });
  status = 0;
  console.log("\n== public-only pass: ok");
} catch (e) {
  console.error(e.message);
} finally {
  try { fs.unlinkSync(nm); } catch { /* not linked yet */ }
  if (!fs.existsSync(nm)) fs.rmSync(tmp, { recursive: true, force: true });   // the link is gone first: never touches node_modules
}
process.exit(status);
