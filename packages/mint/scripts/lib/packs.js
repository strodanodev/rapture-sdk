// PackShop v2, the pack option, lives in packs/ (contracts, tests, keeper, its deploy and site steps, examples). Rapture's
// private build has it; the public kit does not yet: the mirror drops packs/ until Rapture launches the pack shop.
// Shared code reaches it only through here, so everything else works the same with or without the folder.
const fs = require("node:fs");
const path = require("node:path");

const PACKS_DIR = path.join(__dirname, "..", "..", "packs");
const PACKS_MISSING = "PackShop v2 isn't published in this kit yet: mode \"packs\" needs the packs/ module, which stays in Rapture's private build until the pack shop launches. Use mode \"fixed\".";

const hasPacks = () => fs.existsSync(path.join(PACKS_DIR, "lib"));
/** A packs/lib module, or null when this kit has no packs/. */
const loadPacks = (file) => (hasPacks() ? require(path.join(PACKS_DIR, "lib", file)) : null);
/** A packs/lib module, or an Error with PACKS_MISSING. */
function requirePacks(file) {
  const m = loadPacks(file);
  if (!m) throw new Error(PACKS_MISSING);
  return m;
}
/** The same for an ES module (packs/lib/*.mjs), from a script. */
async function importPacks(file) {
  if (!hasPacks()) throw new Error(PACKS_MISSING);
  return import(require("node:url").pathToFileURL(path.join(PACKS_DIR, "lib", file)).href);
}

module.exports = { PACKS_DIR, PACKS_MISSING, hasPacks, loadPacks, requirePacks, importPacks };
