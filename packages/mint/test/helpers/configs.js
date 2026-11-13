// A copy of an example mint config in a temp folder, patched, with its templates and deck beside it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** exampleDir: an examples/<name> folder. patch(raw) edits the config (or returns a new one). Returns the new file's path. */
function configWith(exampleDir, patch = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mint-config-"));
  for (const f of fs.readdirSync(exampleDir)) if (f.endsWith(".json")) fs.copyFileSync(path.join(exampleDir, f), path.join(dir, f));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "mint.config.json"), "utf8"));
  if (raw.templates.startsWith("../")) {
    fs.copyFileSync(path.resolve(exampleDir, raw.templates), path.join(dir, "templates.json"));
    raw.templates = "templates.json";
  }
  const merged = patch(raw) ?? raw;
  fs.writeFileSync(path.join(dir, "mint.config.json"), JSON.stringify(merged));
  return path.join(dir, "mint.config.json");
}

module.exports = { configWith };
