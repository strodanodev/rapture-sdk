// Draw plain SVG placeholder art from web/site.config.json: the logo, the hero, the pack, the card back, the unknown-card
// placeholder, and one card per entry in "cards" (its name, kind and a glyph for the kind). Replace any of them with
// your own art; the paths are the config's (branding.logo, art.*).
//
//   node scripts/placeholder-art.mjs [--only cards]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const site = JSON.parse(fs.readFileSync(path.join(WEB, "site.config.json"), "utf8"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const c = { background: "#0f1117", surface: "#181b24", text: "#eef0f6", muted: "#9aa3b5", accent: "#7c9cff", shiny: "#8fe3ff", gold: "#f2c14e", ...(site.branding?.colors ?? {}) };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
const KIND_HUES = ["#5fb3a1", "#7c9cff", "#b48cff", "#e08a5f", "#f2c14e"];
// one simple glyph per kind, centred on (0, 0), about 60 units across
const GLYPHS = [
  '<circle r="30" fill="none" stroke-width="8"/>',
  '<path d="M-34 18 L-34 -14 L-17 4 L0 -26 L17 4 L34 -14 L34 18 Z" fill="none" stroke-width="7" stroke-linejoin="round"/>',
  '<path d="M0 -34 L32 26 L-32 26 Z" fill="none" stroke-width="7" stroke-linejoin="round"/>',
  '<rect x="-28" y="-28" width="56" height="56" rx="6" fill="none" stroke-width="8"/>',
  '<path d="M0 -36 L10 -11 L36 -11 L15 5 L23 32 L0 16 L-23 32 L-15 5 L-36 -11 L-10 -11 Z" fill="none" stroke-width="6" stroke-linejoin="round"/>',
];
const write = (rel, svg) => {
  const file = path.join(WEB, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg.trim() + "\n");
  console.log("wrote", path.join("web", rel));
};
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
const initials = site.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function card(entry) {
  const hue = KIND_HUES[entry.kind] ?? c.accent;
  const kind = site.kinds?.[entry.kind] ?? `Kind ${entry.kind}`;
  return svg(250, 350, `
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hue}" stop-opacity="0.55"/><stop offset="1" stop-color="${c.surface}"/></linearGradient></defs>
  <rect width="250" height="350" rx="16" fill="${c.background}"/>
  <rect x="10" y="10" width="230" height="330" rx="12" fill="url(#g)" stroke="${hue}" stroke-width="2"/>
  <g transform="translate(125 140)" stroke="${c.text}" opacity="0.9">${GLYPHS[entry.kind] ?? GLYPHS[0]}</g>
  <text x="125" y="262" text-anchor="middle" font-family="system-ui, sans-serif" font-size="19" font-weight="700" fill="${c.text}">${esc(entry.name)}</text>
  <text x="125" y="288" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="${c.muted}">${esc(kind)}</text>
  <text x="125" y="322" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="${c.muted}" opacity="0.7">placeholder art #${entry.id}</text>`);
}

if (!only || only === "cards") {
  for (const entry of site.cards ?? []) write((site.art?.cards ?? "art/cards/{id}.svg").replace("{id}", String(entry.id)), card(entry));
}
if (!only || only === "brand") {
  write(site.branding?.logo ?? "art/logo.svg", svg(64, 64, `
  <rect width="64" height="64" rx="14" fill="${c.accent}"/>
  <path d="M32 9 L52 20.5 L52 43.5 L32 55 L12 43.5 L12 20.5 Z" fill="none" stroke="${c.background}" stroke-width="4" stroke-linejoin="round"/>
  <text x="32" y="38" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" font-weight="800" fill="${c.background}">${esc(initials)}</text>`));
  write(site.art?.placeholder ?? "art/card-placeholder.svg", svg(250, 350, `
  <rect width="250" height="350" rx="16" fill="${c.surface}"/>
  <rect x="10" y="10" width="230" height="330" rx="12" fill="none" stroke="${c.muted}" stroke-width="2" stroke-dasharray="8 6"/>
  <text x="125" y="195" text-anchor="middle" font-family="system-ui, sans-serif" font-size="72" font-weight="700" fill="${c.muted}">?</text>`));
  write(site.art?.cardBack ?? "art/card-back.svg", svg(250, 350, `
  <defs><pattern id="p" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="24" height="24" fill="${c.surface}"/><path d="M0 12 H24" stroke="${c.accent}" stroke-opacity="0.35" stroke-width="2"/></pattern></defs>
  <rect width="250" height="350" rx="16" fill="${c.background}"/>
  <rect x="10" y="10" width="230" height="330" rx="12" fill="url(#p)" stroke="${c.accent}" stroke-width="3"/>
  <circle cx="125" cy="175" r="44" fill="${c.background}" stroke="${c.accent}" stroke-width="3"/>
  <text x="125" y="186" text-anchor="middle" font-family="system-ui, sans-serif" font-size="30" font-weight="800" fill="${c.accent}">${esc(initials)}</text>`));
  write(site.art?.pack ?? "art/pack.svg", svg(240, 340, `
  <defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.accent}"/><stop offset="0.5" stop-color="${c.shiny}"/><stop offset="1" stop-color="${c.accent}"/></linearGradient></defs>
  <path d="M20 22 L220 22 L214 40 L220 58 L220 300 L214 318 L220 336 L20 336 L26 318 L20 300 L20 58 L26 40 Z" fill="url(#f)"/>
  <rect x="40" y="90" width="160" height="160" rx="12" fill="${c.background}" opacity="0.85"/>
  <text x="120" y="160" text-anchor="middle" font-family="system-ui, sans-serif" font-size="34" font-weight="800" fill="${c.text}">${esc(initials)}</text>
  <text x="120" y="200" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="${c.muted}">sealed pack</text>`));
  const fan = [0, 1, 2, 3, 4].map((i) => {
    const hue = KIND_HUES[i];
    return `<g transform="translate(${320 + (i - 2) * 70} 390) rotate(${(i - 2) * 9})"><rect x="-70" y="-300" width="140" height="196" rx="12" fill="${c.surface}" stroke="${hue}" stroke-width="3"/><g transform="translate(0 -205)" stroke="${hue}">${GLYPHS[i]}</g></g>`;
  }).join("");
  write(site.art?.hero ?? "art/hero.svg", svg(640, 400, `
  <defs><radialGradient id="h" cx="0.5" cy="0.35" r="0.7"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${c.background}"/></radialGradient></defs>
  <rect width="640" height="400" fill="url(#h)"/>${fan}`));
}
