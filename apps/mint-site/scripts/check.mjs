// Offline checks of the site as it would deploy: the config is valid, every art path it names exists, vercel.json's
// CSP is the one the config needs (run pnpm csp after changing the config), and the pages load nothing from another
// origin and run no inline script or style (the CSP would block them).
//
//   node scripts/check.mjs [--config web/site.config.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSiteConfig, cardArt } from "../web/lib/config.js";
import { vercelConfig } from "./vercel.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const arg = process.argv.indexOf("--config");
const file = arg > 0 ? path.resolve(process.argv[arg + 1]) : path.join(WEB, "site.config.json");
const problems = [];
const site = JSON.parse(fs.readFileSync(file, "utf8"));
const v = validateSiteConfig(site);
problems.push(...v.problems);
for (const w of v.warnings) console.log(`warning: ${w}`);

// every path the config names is a file in web/
const named = [site.branding?.logo, site.branding?.favicon, site.art?.hero, site.art?.cardBack, site.art?.pack, site.art?.placeholder,
  ...(site.cards ?? []).map((c) => cardArt(site, c))].filter(Boolean);
for (const p of new Set(named)) if (!fs.existsSync(path.join(WEB, p))) problems.push(`${p} (named in the config) is not in web/`);

// vercel.json is what scripts/csp.mjs writes for this config
if (file === path.join(WEB, "site.config.json")) {
  const want = JSON.stringify(vercelConfig(site));
  const vf = path.join(ROOT, "vercel.json");
  const have = fs.existsSync(vf) ? JSON.stringify(JSON.parse(fs.readFileSync(vf, "utf8"))) : "";
  if (want !== have) problems.push("vercel.json does not match web/site.config.json: run pnpm csp");
}

// the pages and scripts: same-origin only, nothing inline
const RULES = [
  [/\.html$/, /<script(?![^>]*\bsrc=)[^>]*>/i, "an inline <script> (the CSP allows only same-origin script files)"],
  [/\.html$/, /\sstyle\s*=/i, "an inline style attribute (the CSP allows only same-origin stylesheets)"],
  [/\.html$/, /<(?:script|link|img)[^>]+(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, "a resource from another origin"],
  [/\.html$/, /\son[a-z]+\s*=\s*["']/i, "an inline event handler attribute"],
  [/\.js$/, /\bimport\s[^;]*["']https?:/, "an import from another origin"],
  [/\.js$/, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, "HTML written from a string (use textContent or el())"],
  [/\.css$/, /@import\s+url\(\s*["']?https?:/, "a stylesheet from another origin"],
  [/\.svg$/, /<script|href\s*=\s*["']https?:/i, "script or an external link inside an SVG"],
];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(WEB)) {
  const rel = path.relative(WEB, f).split(path.sep).join("/");
  const rules = RULES.filter(([ext]) => ext.test(rel));
  if (!rules.length) continue;
  const text = fs.readFileSync(f, "utf8");
  for (const [, re, what] of rules) if (re.test(text)) problems.push(`web/${rel}: ${what}`);
}

if (problems.length) {
  console.error(`site check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`site check: ok (${path.relative(ROOT, file)}, mode ${site.mint.mode}, ${(site.cards ?? []).length} cards)`);
