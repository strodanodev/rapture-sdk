// The public kit's own check. The rapture-sdk mirror publishes this package without packs/ (PackShop v2 stays in
// Rapture's private build until the pack shop launches; scripts/publish-mirrors.sh PRIVATE[rapture-sdk]). This copies the
// package to a temp folder without it, links node_modules, and compiles, tests and checks the examples there, offline,
// so every `pnpm run check` proves the public kit works on its own.
//
//   node scripts/public-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** What the mirror drops from this package (keep in step with PRIVATE[rapture-sdk]). */
const PRIVATE = ["packs"];
/** Build output and local state: never copied (the public pass compiles from scratch). */
const LOCAL = ["node_modules", "artifacts", "cache", "verification"];

if (!PRIVATE.some((p) => fs.existsSync(path.join(ROOT, p)))) {
  console.log("public-only pass: skipped, this already is the public kit (no packs/)");
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rapture-mint-public-"));
const nm = path.join(tmp, "node_modules");
let status = 1;
try {
  const skip = new Set([...PRIVATE, ...LOCAL]);
  fs.cpSync(ROOT, tmp, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      return !(skip.has(rel) || /(^|[\\/])deployments[\\/](local|hardhat)\.json$/.test(rel));
    },
  });
  fs.symlinkSync(path.join(ROOT, "node_modules"), nm, "junction");
  const hardhat = path.join(nm, "hardhat", "internal", "cli", "bootstrap.js");
  const steps = [
    ["compile and test, without packs/", [hardhat, "test"]],
    ["the examples, without packs/", [path.join(tmp, "scripts", "check-config.mjs"), "--examples"]],
  ];
  for (const [what, args] of steps) {
    console.log(`\n== public-only pass: ${what} (${tmp})`);
    const r = spawnSync(process.execPath, args, { cwd: tmp, stdio: "inherit", env: { ...process.env, FORCE_COLOR: "0" } });
    if (r.status !== 0) throw new Error(`public-only pass failed: ${what}`);
  }
  status = 0;
  console.log("\n== public-only pass: ok");
} catch (e) {
  console.error(e.message);
} finally {
  try { fs.unlinkSync(nm); } catch { /* not linked yet */ }
  if (!fs.existsSync(nm)) fs.rmSync(tmp, { recursive: true, force: true });   // the link is gone first: never touches node_modules
}
process.exit(status);
