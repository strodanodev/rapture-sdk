// Mint site — what a wallet holds of the collection, and which card each token is. No DOM: library.js draws it.
//
// FINDING THE TOKENS. balanceOf(wallet) is the authoritative count. An ERC721Enumerable collection then lists them with
// tokenOfOwnerByIndex. Otherwise (the reference collection is not enumerable, and eth_getLogs on LitVM allows only
// 2,000 blocks a call), two sources are combined and the chain has the last word:
//   remembered  token ids this browser saw minted (mints, pack opens): instant, verified with ownerOf before trusted
//   scan        ownerOf over the collection's ids, tokenIdBase + totalSupply - 1 down to tokenIdBase (newest first),
//               stopping the moment the count is met (at most SCAN_LIMIT calls)
// WHICH CARD. A FixedPriceMinter answers templatesOf(ids) for the tokens it minted. A pack shop (the pack module, where
// the site has it) answers finishesOf(ids),
// and the buyer's own packs (recentPacks, packOf, tokensOf) give their template ids. A collection with design records
// (mint.designRecords, the reference CardDesign) maps any token to its design hash, which names a card in the config.
// Anything left is shown as the token alone.
import { createChain, isAbort, AbortError } from "./chain.js";
import { NFT_SELECTORS, ERC721_ENUMERABLE, encodeCall, isAddress, words, uintAt, addressAt, boolAt } from "./abi.js";
import { templatesOf, fixedConfig } from "./fixed.js";

/** The pack module (web/packs/), loaded only by a packs site, and only where the site has it. */
let packModule = null;
const loadPacks = () => (packModule ??= import("../packs/lib/packshop.js").catch(() => null));

const SCAN_LIMIT = 1500;          // ownerOf calls one read may spend looking for tokens
const ENUM_LIMIT = 1000;          // tokens listed from an enumerable collection
const CONCURRENCY = 8;
const BATCH = 200;                // token ids per templatesOf / finishesOf call

const norm = (a) => String(a).toLowerCase();
const byIdDesc = (a, b) => { const x = BigInt(a), y = BigInt(b); return x < y ? 1 : x > y ? -1 : 0; };

function defaultStorage() {
  try { const s = globalThis.localStorage; if (s && typeof s.getItem === "function") return s; } catch { /* blocked */ }
  return null;
}
const readJson = (store, key, fallback) => { try { const r = store?.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; } };
const writeJson = (store, key, v) => { try { store?.setItem(key, JSON.stringify(v)); } catch { /* full or blocked: memory only */ } };

async function pool(items, n, fn, signal) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      if (signal?.aborted) throw new AbortError();
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/**
 * createHoldings({ site, chain, storage }) -> { remember, read }.
 *   site     the validated site config (mint.collection must be set)
 *   chain    a chain.js client (default: one for site.chain.rpc)
 *   storage  localStorage-like or null (default: localStorage when usable)
 */
export function createHoldings({ site, chain, storage } = {}) {
  const nft = site?.mint?.collection;
  if (!isAddress(nft)) throw new TypeError("createHoldings needs site.mint.collection (the ERC-721 address)");
  const client = chain ?? createChain(site.chain.rpc);
  const store = storage === undefined ? defaultStorage() : storage;
  const mode = site.mint.mode;
  const fixedCfg = isAddress(site.mint.address) && mode === "fixed" ? fixedConfig(site) : null;
  if (fixedCfg && chain) fixedCfg.client = client;
  let packsCfg;                      // undefined: not looked up yet; null: no pack shop here
  async function packs() {
    if (packsCfg !== undefined) return packsCfg;
    const P = mode === "packs" && isAddress(site.mint.address) ? await loadPacks() : null;
    packsCfg = P ? { P, cfg: { ...P.packConfig(site), ...(chain ? { client } : {}) } } : null;
    return packsCfg;
  }
  const base = BigInt(site.mint.tokenIdBase ?? "0");
  const byDesign = new Map((site.cards ?? []).filter((c) => c.designHash).map((c) => [norm(c.designHash), c.id]));
  const keyOf = (w) => `mintsite.library.v1:${site.chain.id}:${norm(nft)}:${norm(w)}`;
  const mem = new Map();
  let enumerable = null;

  const call = (to, selector, types, values, signal) => client.call({ to, data: encodeCall(selector, types, values) }, { signal });
  const load = (w) => readJson(store, keyOf(w), null) ?? mem.get(keyOf(w)) ?? { ids: [], info: {} };
  const save = (w, s) => { mem.set(keyOf(w), s); writeJson(store, keyOf(w), s); };

  async function ownerOf(id, signal) {
    try { return norm(addressAt(words(await call(nft, NFT_SELECTORS.ownerOf, ["uint256"], [id], signal)), 0)); }
    catch (e) { if (e?.isRevert) return null; throw e; }
  }
  async function isEnumerable(signal) {
    if (enumerable !== null) return enumerable;
    const data = NFT_SELECTORS.supportsInterface + ERC721_ENUMERABLE.slice(2).padEnd(64, "0");   // bytes4 is left-aligned
    try { enumerable = boolAt(words(await client.call({ to: nft, data }, { signal })), 0); }
    catch (e) { if (isAbort(e)) throw e; enumerable = false; }
    return enumerable;
  }

  /** Token ids -> { tokenId: { templateId, finish } } from every source that knows. */
  async function identify(w, ids, signal) {
    const info = {};
    const set = (id, k, v) => { if (v == null) return; (info[id] ??= {})[k] = v; };
    const remembered = load(w).info ?? {};
    for (const id of ids) if (remembered[id]) for (const [k, v] of Object.entries(remembered[id])) set(id, k, v);
    if (fixedCfg) {
      for (let i = 0; i < ids.length; i += BATCH) {
        const part = ids.slice(i, i + BATCH);
        try { (await templatesOf(fixedCfg, part, { signal })).forEach((t, j) => set(part[j], "templateId", t)); }
        catch (e) { if (isAbort(e)) throw e; }
      }
    }
    const pk = await packs();
    if (pk) {
      const { P, cfg: shopCfg } = pk;
      for (let i = 0; i < ids.length; i += BATCH) {
        const part = ids.slice(i, i + BATCH);
        try { (await P.finishesOf(shopCfg, part, { signal })).forEach((f, j) => set(part[j], "finish", f || null)); }
        catch (e) { if (isAbort(e)) throw e; }
      }
      try {
        const opened = (await P.findMyPacks(shopCfg, w, { signal })).filter((p) => p.phase === P.PHASE.Opened);
        await pool(opened, 4, async (p) => {
          const [pack, tokens] = await Promise.all([P.readPack(shopCfg, p.packId, { signal }), P.readTokens(shopCfg, p.packId, { signal })]);
          tokens.forEach((t, j) => { set(t, "templateId", pack.templateIds[j]); set(t, "finish", pack.finishes[j]); });
        }, signal);
      } catch (e) { if (isAbort(e)) throw e; }
    }
    const designs = site.mint.designRecords;
    const unknown = ids.filter((id) => info[id]?.templateId == null);
    if (isAddress(designs) && byDesign.size && unknown.length) {
      await pool(unknown, CONCURRENCY, async (id) => {
        try {
          const ws = words(await call(designs, NFT_SELECTORS.designOf, ["uint256"], [id], signal));
          const hash = "0x" + ws[1];                     // Design is returned as a dynamic tuple: offset, then designHash
          set(id, "templateId", byDesign.get(norm(hash)) ?? null);
        } catch (e) { if (isAbort(e)) throw e; }
      }, signal);
    }
    return info;
  }

  return {
    /** A mint or a pack opened in this browser: remember the tokens (and what they are) for an instant library. */
    remember(wallet, tokenIds, details = []) {
      const w = norm(wallet);
      const s = load(w);
      const ids = new Set(s.ids);
      tokenIds.forEach((id, i) => {
        ids.add(String(id));
        if (details[i]) s.info[String(id)] = { ...(s.info[String(id)] ?? {}), ...details[i] };
      });
      save(w, { ids: [...ids].sort(byIdDesc), info: s.info });
    },

    /**
     * The wallet's tokens, chain-checked, newest first: { tokens: [{ tokenId, templateId, finish }], balance,
     * complete (every token the balance counts was found), scanned (ownerOf calls spent) }.
     */
    async read(wallet, { signal } = {}) {
      if (!isAddress(wallet)) throw new TypeError("read needs a wallet address");
      const w = norm(wallet);
      const balance = Number(uintAt(words(await call(nft, NFT_SELECTORS.balanceOf, ["address"], [w], signal)), 0));
      const found = new Set();
      let scanned = 0;
      if (balance > 0 && (await isEnumerable(signal))) {
        const n = Math.min(balance, ENUM_LIMIT);
        const ids = await pool(Array.from({ length: n }, (_, i) => i), CONCURRENCY, async (i) =>
          uintAt(words(await call(nft, NFT_SELECTORS.tokenOfOwnerByIndex, ["address", "uint256"], [w, i], signal)), 0).toString(), signal);
        ids.forEach((id) => found.add(id));
      } else if (balance > 0) {
        const remembered = load(w).ids;
        const owned = await pool(remembered, CONCURRENCY, async (id) => (await ownerOf(id, signal)) === w, signal);
        remembered.forEach((id, i) => { if (owned[i]) found.add(id); });
        if (found.size < balance) {
          let supply = SCAN_LIMIT;
          try { supply = Number(uintAt(words(await call(nft, NFT_SELECTORS.totalSupply, [], [], signal)), 0)); }
          catch (e) { if (isAbort(e)) throw e; }
          for (let top = supply - 1; top >= 0 && found.size < balance && scanned < SCAN_LIMIT; top -= CONCURRENCY) {
            const ids = Array.from({ length: Math.min(CONCURRENCY, top + 1) }, (_, k) => (base + BigInt(top - k)).toString()).filter((id) => !found.has(id));
            scanned += ids.length;
            const owners = await Promise.all(ids.map((id) => ownerOf(id, signal)));
            ids.forEach((id, k) => { if (owners[k] === w) found.add(id); });
          }
        }
      }
      const ids = [...found].sort(byIdDesc);
      save(w, { ...load(w), ids });
      const info = await identify(w, ids, signal);
      return {
        tokens: ids.map((tokenId) => ({ tokenId, templateId: info[tokenId]?.templateId ?? null, finish: info[tokenId]?.finish ?? null })),
        balance,
        complete: ids.length >= balance,
        scanned,
      };
    },
  };
}
