// Mint site — the one config file (web/site.config.json): chain, contracts, mint mode, branding, art and the card list.
// Shared by the pages (loadSiteConfig), scripts/check.mjs and scripts/csp.mjs (validateSiteConfig, cspFor). No DOM.
//
// {
//   "name", "tagline", "description",
//   "chain":  { "id", "name", "rpc", "explorer", "faucet", "currency": { "name", "symbol", "decimals" } },
//   "mint":   { "mode": "fixed" | "packs", "address", "collection", "tokenIdBase", "designRecords", "beacon": { "registry", "urls" } },
//   "branding": { "logo", "favicon", "colors": { "background", "surface", "text", "muted", "accent", "accentText", "shiny", "gold" } },
//   "art":    { "hero", "cardBack", "pack", "placeholder", "cards": "art/cards/{id}.svg" },
//   "kinds":  [5 names], "finishes": [3 names],
//   "cards":  [{ "id", "name", "epithet", "kind", "designHash", "art"? }],
//   "ipfsGateway": null | "https://<gateway>/ipfs/"
// }
// The mint package's scripts/site-config.mjs writes "chain" and "mint" (and "cards") after a deploy.

export const DRAND_HOSTS = Object.freeze(["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"]);
export const COLOR_KEYS = Object.freeze(["background", "surface", "text", "muted", "accent", "accentText", "shiny", "gold"]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** A same-origin path: letters, digits and - _ . / { }, no scheme, no "..", not absolute. */
const LOCAL_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./{}]+$/;
const LOCAL_HOST = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/.*)?$/;

const isHttps = (u) => typeof u === "string" && /^https:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(u);
const isRpc = (u) => isHttps(u) || (typeof u === "string" && LOCAL_HOST.test(u));
export const originOf = (u) => { const m = /^(https?:\/\/[^/?#]+)/.exec(u); return m ? m[1] : null; };

/** Problems ([] = fine) and warnings in a site config. */
export function validateSiteConfig(c) {
  const problems = [], warnings = [];
  if (!c || typeof c !== "object") return { problems: ["the site config is not a JSON object"], warnings };
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 60) problems.push("name must be 1-60 characters");
  for (const k of ["tagline", "description"]) if (c[k] != null && typeof c[k] !== "string") problems.push(`${k} must be text`);

  const ch = c.chain ?? {};
  if (!Number.isSafeInteger(ch.id) || ch.id <= 0) problems.push("chain.id must be the chain id (LitVM Liteforge: 4441)");
  if (typeof ch.name !== "string" || !ch.name) problems.push("chain.name must name the network");
  if (!isRpc(ch.rpc)) problems.push("chain.rpc must be an https URL (or http://127.0.0.1 for a local node)");
  for (const k of ["explorer", "faucet"]) if (ch[k] != null && !isHttps(ch[k])) problems.push(`chain.${k} must be an https URL or null`);
  const cur = ch.currency ?? {};
  if (typeof cur.symbol !== "string" || !cur.symbol || cur.decimals !== 18) problems.push("chain.currency needs a symbol and decimals 18");

  const m = c.mint ?? {};
  if (!["fixed", "packs"].includes(m.mode)) problems.push('mint.mode must be "fixed" or "packs"');
  if (m.address == null) warnings.push("mint.address is not set: the site shows \"not open yet\" until the mint package's site-config writes it");
  else if (!ADDRESS.test(m.address)) problems.push("mint.address must be the minter's address or null");
  if (m.collection != null && !ADDRESS.test(m.collection)) problems.push("mint.collection must be the ERC-721's address or null");
  if (m.collection == null && m.address != null) warnings.push("mint.collection is not set: the library page has nothing to read");
  if (m.designRecords != null && !ADDRESS.test(m.designRecords)) problems.push("mint.designRecords must be an address or null");
  if (m.tokenIdBase != null && !/^\d+$/.test(String(m.tokenIdBase))) problems.push("mint.tokenIdBase must be a decimal token id");
  if (m.beacon != null) {
    if (typeof m.beacon !== "object") problems.push("mint.beacon must be an object");
    else {
      if (m.beacon.registry != null && !ADDRESS.test(m.beacon.registry)) problems.push("mint.beacon.registry must be an address");
      if (m.beacon.urls != null && !(Array.isArray(m.beacon.urls) && m.beacon.urls.length && m.beacon.urls.every(isHttps))) problems.push("mint.beacon.urls must be https drand mirrors");
    }
  }

  const b = c.branding ?? {};
  for (const k of ["logo", "favicon"]) if (b[k] != null && !LOCAL_PATH.test(b[k])) problems.push(`branding.${k} must be a path inside the site (e.g. art/logo.svg)`);
  const colors = b.colors ?? {};
  for (const k of COLOR_KEYS) if (colors[k] != null && !COLOR.test(colors[k])) problems.push(`branding.colors.${k} must be a #hex colour`);
  for (const k of Object.keys(colors)) if (!COLOR_KEYS.includes(k)) warnings.push(`branding.colors.${k} is not used (known: ${COLOR_KEYS.join(", ")})`);

  const art = c.art ?? {};
  for (const k of ["hero", "cardBack", "pack", "placeholder", "cards"]) if (art[k] != null && !LOCAL_PATH.test(art[k])) problems.push(`art.${k} must be a path inside the site`);
  if (art.cards != null && !art.cards.includes("{id}")) problems.push("art.cards must contain {id} (e.g. art/cards/{id}.svg)");

  if (!Array.isArray(c.kinds) || c.kinds.length !== 5 || !c.kinds.every((k) => typeof k === "string" && k)) problems.push("kinds must name the 5 kinds, in contract order 0..4");
  if (!Array.isArray(c.finishes) || c.finishes.length !== 3 || !c.finishes.every((k) => typeof k === "string" && k)) problems.push("finishes must name the 3 finishes (Normal, Shiny, Gold)");

  if (!Array.isArray(c.cards)) problems.push("cards must be a list (it may be empty until site-config fills it)");
  else {
    const ids = new Set();
    c.cards.forEach((card, i) => {
      const at = `cards[${i}]`;
      if (!Number.isSafeInteger(card?.id) || card.id < 0) problems.push(`${at}.id must be the template id`);
      else if (ids.has(card.id)) problems.push(`${at}.id ${card.id} is listed twice`);
      else ids.add(card.id);
      if (typeof card?.name !== "string" || !card.name) problems.push(`${at}.name is missing`);
      if (!Number.isSafeInteger(card?.kind) || card.kind < 0 || card.kind > 4) problems.push(`${at}.kind must be 0..4`);
      if (card?.designHash != null && !HASH.test(card.designHash)) problems.push(`${at}.designHash must be 32 bytes of 0x hex`);
      if (card?.art != null && !LOCAL_PATH.test(card.art)) problems.push(`${at}.art must be a path inside the site`);
    });
    if (!c.cards.length) warnings.push("cards is empty: names and art come from it (site-config fills it from the mint config's templates)");
  }
  if (c.ipfsGateway != null && !(isHttps(c.ipfsGateway) && c.ipfsGateway.endsWith("/"))) problems.push("ipfsGateway must be an https URL ending in / (e.g. https://ipfs.io/ipfs/) or null");
  return { problems, warnings };
}

/**
 * The Content-Security-Policy for a config: same-origin everything, plus exactly the hosts the pages talk to: the RPC,
 * the drand mirrors (packs only) and the IPFS gateway (when set). No inline script or style, no external scripts.
 */
export function cspFor(c) {
  const connect = ["'self'", originOf(c.chain.rpc)];
  if (c.mint?.mode === "packs") connect.push(...(c.mint.beacon?.urls ?? DRAND_HOSTS).map(originOf));
  const img = ["'self'", "data:", "blob:"];
  if (c.ipfsGateway) { connect.push(originOf(c.ipfsGateway)); img.push(originOf(c.ipfsGateway)); }
  const uniq = (a) => [...new Set(a.filter(Boolean))].join(" ");
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'", `img-src ${uniq(img)}`, "media-src 'self'",
    `connect-src ${uniq(connect)}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join("; ");
}

/** The chain object wallet.js createWallet() wants, from the config (so the wallet and the reads never disagree). */
export function walletChain(c) {
  const ch = c.chain;
  const out = { chainId: ch.id, name: ch.name, nativeCurrency: ch.currency, rpcUrls: [ch.rpc] };
  if (ch.explorer) out.explorer = ch.explorer;
  if (ch.faucet) out.faucet = ch.faucet;
  return out;
}

/** Art path for a card: its own art, else art.cards with {id}, else the placeholder. */
export function cardArt(c, card) {
  if (card?.art) return card.art;
  if (card && c.art?.cards) return c.art.cards.replace("{id}", String(card.id));
  return c.art?.placeholder ?? "";
}

/** Fetch and check web/site.config.json. Throws Error with every problem listed. */
export async function loadSiteConfig(url = "./site.config.json", { fetch: f = globalThis.fetch } = {}) {
  const res = await f(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`site.config.json could not be loaded (HTTP ${res.status})`);
  const c = await res.json();
  const { problems, warnings } = validateSiteConfig(c);
  for (const w of warnings) console.warn(`[site.config.json] ${w}`);
  if (problems.length) throw new Error(`site.config.json has problems:\n- ${problems.join("\n- ")}`);
  return c;
}
