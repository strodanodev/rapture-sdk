// The mint config: one JSON file says which collection to sell, how, and to whom the shop belongs. Read by deploy.js,
// verify.mjs, site-config.mjs and check-config.mjs (and the pack module's keeper). Pure: no chain access. Mode "packs"
// (PackShop v2) is read by packs/lib/config-packs.js, and only where this kit has packs/ (see lib/packs.js).
//
// {
//   "network": "liteforge",                       a network in hardhat.config.js
//   "collection": { "minter": "0x…", "cards": "0x…", "tokenIdBase": "0" },
//   "templates": "templates.json",                path relative to this file
//   "mode": "fixed" (or "packs" where packs/ is present),
//   "owner": null | "0x…",                         offered ownership after setup (use a Safe)
//   "fixed": { "price": "0.001", "maxPerWallet": 0, "supply": 100, "lock": true },
// }
const fs = require("node:fs");
const path = require("node:path");
const { loadPacks, PACKS_MISSING } = require("./packs.js");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const NAME_CHARS = /^[0-9A-Za-z ',\-.:_]*$/;   // CardDesign's closed charset
const KINDS = 5;
const MAX_TEMPLATES = 4096;
/** Networks where deploy.js sends transactions without MINT_CONFIRM (and may deploy the reference collection). */
const LOCAL_NETWORKS = new Set(["hardhat", "local", "localhost"]);

const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** Wei from a decimal string of the native token ("0.001" -> 10^15). */
function parseUnits(s) {
  if (typeof s !== "string" || !DECIMAL.test(s)) throw new TypeError(`not a decimal amount: ${JSON.stringify(s)}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
}

/** Template file -> [{ kind, traits, styleSource, design, supply? }]. Accepts a plain array, or { templates: [...] }
 *  whose items are templates or { template, supply } (export-templates.mjs writes the latter). */
function readTemplates(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(j) ? j : j?.templates;
  if (!Array.isArray(list)) throw new TypeError(`${file}: expected an array of templates or { "templates": [...] }`);
  return list.map((item) => (item && item.template ? { ...item.template, ...(item.supply != null ? { supply: item.supply } : {}) } : item));
}

/**
 * The rules the reference collection enforces at mint time (StudioMinter._check and CardDesign's charset), without
 * the chain's stat bands unless given.
 * bands: optional [[min, max] x 5] read from the minter (bandOf). Returns a list of problems ([] = fine).
 */
function templateProblems(t, i, bands = null) {
  const at = `template ${i}`;
  const out = [];
  if (!t || typeof t !== "object") return [`${at}: not an object`];
  const tr = t.traits ?? {}, d = t.design ?? {};
  if (!isInt(t.kind, 0, KINDS - 1)) out.push(`${at}: kind must be 0..${KINDS - 1}`);
  for (const [k, max] of [["faction", 1], ["element", 3], ["frame", 3]]) if (!isInt(tr[k], 0, max)) out.push(`${at}: traits.${k} must be 0..${max}`);
  if (!(isInt(tr.alignment, 0, 2) || tr.alignment === 255)) out.push(`${at}: traits.alignment must be 0..2 or 255`);
  const stats = ["strength", "agility", "resilience", "intelligence"];
  for (const k of stats) if (!isInt(tr[k], 0, 65535)) out.push(`${at}: traits.${k} must be a uint16`);
  if (bands && isInt(t.kind, 0, KINDS - 1)) {
    const [lo, hi] = bands[t.kind];
    for (const k of stats) if (isInt(tr[k], 0, 65535) && (tr[k] < lo || tr[k] > hi)) out.push(`${at}: traits.${k} ${tr[k]} is outside kind ${t.kind}'s band ${lo}..${hi}`);
  }
  if (!isInt(tr.bodyparts, 0, 2 ** 32 - 1)) out.push(`${at}: traits.bodyparts must be a uint32`);
  else {
    const p = tr.bodyparts, head = p & 0xff, facet = (p >>> 8) & 0xff, circuit = (p >>> 16) & 0xff, bodyType = (p >>> 24) & 0xff;
    if (head > 3 || facet > 1 || circuit > 2 || bodyType > 1) out.push(`${at}: traits.bodyparts slots out of range (head 0-3, facet 0-1, circuit 0-2, bodyType 0-1)`);
    if (t.kind === 0 && facet !== 0) out.push(`${at}: kind 0 has no facet`);
    if (t.kind === 3 && (head !== 0 || bodyType !== 0)) out.push(`${at}: kind 3 has head 0 and bodyType 0`);
  }
  const divine = t.kind === 2 || t.kind === 4;
  if (!isInt(d.kit, 0, 255) || (divine ? d.kit < 1 || d.kit > 5 : d.kit !== 0)) out.push(`${at}: design.kit must be 1..5 for kinds 2 and 4, else 0`);
  for (const k of ["designHash", "art", "turntable", "overridesHash", "avatar", "avatarPlain", "soul"]) if (!HASH.test(String(d[k]))) out.push(`${at}: design.${k} must be 32 bytes of 0x hex`);
  for (const k of ["designHash", "art", "avatar", "avatarPlain"]) if (/^0x0{64}$/.test(String(d[k]))) out.push(`${at}: design.${k} may not be zero`);
  if (typeof d.name !== "string" || d.name.length < 1 || d.name.length > 40 || !NAME_CHARS.test(d.name)) out.push(`${at}: design.name must be 1-40 characters of letters, digits, space and ' , - . : _`);
  if (typeof d.epithet !== "string" || d.epithet.length > 48 || !NAME_CHARS.test(d.epithet)) out.push(`${at}: design.epithet must be 0-48 characters of the same set`);
  const s = t.styleSource ?? {};
  if (!ADDRESS.test(String(s.collection)) || s.chainId == null || s.tokenId == null) out.push(`${at}: styleSource needs chainId, collection (address) and tokenId`);
  if (t.supply != null && !isInt(t.supply, 1, 2 ** 32 - 1)) out.push(`${at}: supply must be 1..2^32-1`);
  return out;
}

/**
 * Read and check a mint config. Returns { cfg, problems, warnings }: cfg is normalised (absolute paths, wei amounts,
 * templates/deck loaded when their files exist), problems are errors that stop a deploy, warnings do not.
 */
function loadConfig(file) {
  const problems = [], warnings = [];
  const abs = path.resolve(file);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, "utf8")); }
  catch (e) { return { cfg: null, problems: [`${file}: ${e.message}`], warnings }; }
  const dir = path.dirname(abs);
  const cfg = { file: abs, dir, raw, network: raw.network, mode: raw.mode, owner: raw.owner ?? null };

  if (typeof raw.network !== "string" || !raw.network) problems.push("network must name a network in hardhat.config.js (liteforge, local)");
  const packsModule = raw.mode === "packs" ? loadPacks("config-packs.js") : null;
  if (raw.mode === "packs" && !packsModule) problems.push(PACKS_MISSING);
  else if (!["fixed", "packs"].includes(raw.mode)) problems.push('mode must be "fixed"');
  if (cfg.owner != null && !ADDRESS.test(cfg.owner)) problems.push("owner must be an address or null");
  const col = raw.collection ?? {};
  cfg.collection = { minter: col.minter, cards: col.cards ?? null, tokenIdBase: String(col.tokenIdBase ?? "0") };
  if (!ADDRESS.test(String(col.minter))) problems.push("collection.minter must be the collection's minter address (IStudioMinter)");
  if (col.cards != null && !ADDRESS.test(String(col.cards))) problems.push("collection.cards must be the ERC-721's address or null");
  if (!/^\d+$/.test(cfg.collection.tokenIdBase)) problems.push("collection.tokenIdBase must be a decimal token id");

  cfg.templatesFile = typeof raw.templates === "string" ? path.resolve(dir, raw.templates) : null;
  cfg.templates = null;
  if (!cfg.templatesFile) problems.push("templates must be the path of a templates JSON file");
  else if (!fs.existsSync(cfg.templatesFile)) warnings.push(`${raw.templates} does not exist yet (export it with scripts/export-templates.mjs, or write it from your collection's cards)`);
  else {
    try {
      cfg.templates = readTemplates(cfg.templatesFile);
      if (!cfg.templates.length) problems.push(`${raw.templates} holds no templates`);
      if (cfg.templates.length > MAX_TEMPLATES) problems.push(`${raw.templates} holds more than ${MAX_TEMPLATES} templates`);
      cfg.templates.forEach((t, i) => problems.push(...templateProblems(t, i)));
      const seen = new Set();
      cfg.templates.forEach((t, i) => {
        const h = String(t?.design?.designHash).toLowerCase();
        if (seen.has(h)) problems.push(`template ${i}: design ${h} is listed twice`);
        seen.add(h);
      });
    } catch (e) { problems.push(`${raw.templates}: ${e.message}`); }
  }

  const money = (v, at) => { try { return parseUnits(v); } catch { problems.push(`${at} must be a decimal string of the native token, e.g. "0.001"`); return 0n; } };
  if (raw.mode === "fixed") {
    const f = raw.fixed ?? {};
    cfg.fixed = { price: money(f.price, "fixed.price"), priceText: f.price, maxPerWallet: f.maxPerWallet ?? 0, supply: f.supply ?? null, lock: f.lock ?? true };
    if (!isInt(cfg.fixed.maxPerWallet, 0, 2 ** 32 - 1)) problems.push("fixed.maxPerWallet must be 0 (no limit) or a positive uint32");
    if (cfg.fixed.supply != null && !isInt(cfg.fixed.supply, 1, 2 ** 32 - 1)) problems.push("fixed.supply (the default edition size) must be 1..2^32-1");
    if (typeof cfg.fixed.lock !== "boolean") problems.push("fixed.lock must be true or false");
    if (cfg.templates) cfg.supplies = cfg.templates.map((t) => t.supply ?? cfg.fixed.supply);
    if (cfg.supplies?.some((s) => s == null)) problems.push("every template needs an edition size: set fixed.supply or a per-template supply");
    if (cfg.fixed.price === 0n && cfg.fixed.maxPerWallet === 0) warnings.push("price 0 with no per-wallet limit: anyone can mint every edition for free");
  } else if (packsModule) {
    packsModule.loadPacksSection(raw, cfg, { problems, warnings, money, isInt, ADDRESS });
  }
  return { cfg, problems, warnings };
}

/** Where deploy.js records what it deployed for `network`: deployments/<network>.json next to the config. */
const deploymentsFile = (cfg, network) => path.join(cfg.dir, "deployments", `${network}.json`);
function readDeployments(cfg, network) {
  const f = deploymentsFile(cfg, network);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
function writeDeployments(cfg, network, data) {
  const f = deploymentsFile(cfg, network);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
  return f;
}

module.exports = {
  ADDRESS, KINDS, LOCAL_NETWORKS, PACKS_MISSING,
  isInt, parseUnits, readTemplates, templateProblems, loadConfig,
  deploymentsFile, readDeployments, writeDeployments,
};
