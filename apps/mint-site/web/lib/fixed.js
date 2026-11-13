// Mint site — FixedPriceMinter client: read the price, the catalogue's editions and the buyer's limit, and mint cards.
// Same conventions as the other shop clients, whose transaction path it shares (lib/shop.js) (estimate + 25%, explicit fee caps, receipt wait,
// revert decoding): money is bigint wei, token ids are decimal strings, every failure is a ShopError/WalletError
// whose .message is fit to show a buyer and whose .code / .reason a UI can branch on.
import { FIXED_SELECTORS, encodeCall, toBigInt, isAddress, uintAt, uintBoundAt, boolAt, decodeEditions, decodeMinted, decodeUintArray } from "./abi.js";
import { rpcFor, formatZkltc, ShopError, transact, asShopError, revertError, exclusive, needWallet, findEvent, readWords, readRaw, decoding } from "./shop.js";
import { LITEFORGE } from "./wallet.js";

/** Cards one transaction may mint (FixedPriceMinter.MAX_PER_TX). */
export const MAX_PER_TX = 10;
const PAGE = 256;                         // editionsOf answers at most this many per call
const MINT_GAS_PER_CARD = 1_000_000n;     // ~0.9M on the reference collection, rounded up
const MINT_GAS_BASE = 300_000n;
const FEE_CAP_FACTOR = 2n;
const FALLBACK_GAS_PRICE = 1_000_000_000n;

const MESSAGES = {
  SoldOut: "That card is sold out: every copy of its edition has been minted.",
  WrongPayment: "The price just changed. Reload the page and try again.",
  WalletLimitReached: "This wallet has minted as many cards as the drop allows.",
  UnknownTemplate: "That card is not for sale any more.",
  BadQuantity: `Choose between 1 and ${MAX_PER_TX} cards.`,
  EnforcedPause: "Minting is paused right now. Try again soon.",
  NotMinter: "The minter cannot mint cards right now: its minting permission is missing. Nothing was charged. Please tell the team.",
};
/** A decoded revert (shop.js revertError: it carries .selector) in this module's wording for the fixed-price
 *  reasons. Errors this module wrote itself keep their more precise message. */
function reword(e) {
  if (e instanceof ShopError && "selector" in e && e.reason && MESSAGES[e.reason]) e.message = MESSAGES[e.reason];
  return e;
}

/**
 * The minter config this module works on, from a validated site config: { chainId, chainName, rpc, explorer, faucet,
 * currency, shop (the minter's address) }.
 */
export function fixedConfig(site) {
  const m = site?.mint;
  if (!m || m.mode !== "fixed" || !isAddress(m.address)) {
    throw new ShopError("not_configured", "This site does not sell at a fixed price (site.config.json mint.mode is not \"fixed\").");
  }
  const c = site.chain ?? {};
  return { chainId: c.id, chainName: c.name ?? `chain ${c.id}`, rpc: c.rpc, explorer: c.explorer ?? null, faucet: c.faucet ?? null, currency: c.currency ?? LITEFORGE.nativeCurrency, shop: m.address };
}

/**
 * config() decoded: { price (bigint wei), maxPerWallet (0 = none), paused, ready, locked, templateCount, totalMinted,
 * maxSupply, soldOut }. With an address it also carries mintable: cards that wallet may still buy (Infinity = no limit).
 */
export async function readMinter(cfg, address, o) {
  try {
    const [ws, mintable] = await Promise.all([
      readWords(cfg, FIXED_SELECTORS.config, [], [], o),
      address ? mintableBy(cfg, address, o) : undefined,
    ]);
    const s = decoding(() => {
      if (ws.length !== 8) throw new Error(`config() returned ${ws.length} words, FixedPriceMinter returns 8`);
      return {
        price: uintAt(ws, 0),
        maxPerWallet: Number(uintBoundAt(ws, 1, 32)),
        paused: boolAt(ws, 2),
        ready: boolAt(ws, 3),
        locked: boolAt(ws, 4),
        templateCount: Number(uintBoundAt(ws, 5, 32)),
        totalMinted: Number(uintBoundAt(ws, 6, 53)),
        maxSupply: Number(uintBoundAt(ws, 7, 53)),
      };
    });
    s.soldOut = s.maxSupply > 0 && s.totalMinted >= s.maxSupply;
    if (mintable !== undefined) s.mintable = mintable;
    return s;
  } catch (e) { throw reword(e); }
}

/** Cards the address may still buy: a number, or Infinity when the drop has no per-wallet limit. */
export async function mintableBy(cfg, address, o) {
  const ws = await readWords(cfg, FIXED_SELECTORS.mintableBy, ["address"], [address], o);
  const n = decoding(() => uintAt(ws, 0));
  return n > 0xffffffffn ? Infinity : Number(n);
}

/** Every edition, in template order: [{ id, maxSupply, minted, retired, left }] (pages of 256 calls). */
export async function readEditions(cfg, count, o) {
  const out = [];
  for (let from = 0; from < count; from += PAGE) {
    const raw = await readRaw(cfg, FIXED_SELECTORS.editionsOf, ["uint256", "uint256"], [from, PAGE], o);
    const e = decoding(() => decodeEditions(raw, PAGE));
    e.maxSupply.forEach((max, i) => out.push({ id: from + i, maxSupply: max, minted: e.minted[i], retired: e.retired[i], left: e.retired[i] ? 0 : Math.max(0, max - e.minted[i]) }));
    if (e.maxSupply.length < PAGE) break;
  }
  return out;
}

/** templatesOf(tokenIds) -> template id per token, or null for a token this minter did not mint. */
export async function templatesOf(cfg, tokenIds, o) {
  const ids = tokenIds.map(toBigInt);
  if (!ids.length) return [];
  const raw = await readRaw(cfg, FIXED_SELECTORS.templatesOf, ["uint256[]"], [ids], o);
  return decoding(() => {
    const out = decodeUintArray(raw, 256, ids.length);
    if (out.length !== ids.length) throw new Error(`templatesOf answered ${out.length} ids for ${ids.length} tokens`);
    return out.map((v) => (v === 0n ? null : Number(v - 1n)));
  });
}

/** Wallet balance vs price + gas for the mint; throws ShopError(low_balance) with the faucet hint (if the chain has one). */
async function requireFunds(wallet, cfg, quantity, cost) {
  const chain = rpcFor(cfg);
  const [balance, gasPrice] = await Promise.all([
    chain.getBalance(wallet.address).catch((e) => { throw asShopError(e, cfg); }),
    chain.gasPrice().catch(() => FALLBACK_GAS_PRICE),
  ]);
  const fees = (MINT_GAS_BASE + MINT_GAS_PER_CARD * BigInt(quantity)) * gasPrice * FEE_CAP_FACTOR;
  if (balance >= cost + fees) return;
  const symbol = wallet.chain?.nativeCurrency?.symbol ?? cfg.currency?.symbol ?? "zkLTC";
  const faucet = wallet.chain?.faucet ?? null;
  throw new ShopError("low_balance",
    `Not enough ${symbol}: ${quantity} card${quantity === 1 ? "" : "s"} cost ${formatZkltc(cost, 4, "ceil")} and network fees need about ${formatZkltc(fees, 4, "ceil")} more, but your wallet has ${formatZkltc(balance, 4, "floor")}.${faucet ? ` Get free test ${symbol} at ${faucet}` : ""}`,
    { have: balance, need: cost + fees, price: cost, fees, faucet });
}

/**
 * Mint `quantity` cards of template `templateId` for the minter's price. Resolves { tokenIds (decimal strings),
 * templateId, txHash } once mined. Checks first, without troubling the wallet: paused, sold out, the wallet's limit,
 * the balance. onStage("signing" | "pending" | "confirmed"); opts: signal, pollMs, timeoutMs.
 */
export async function mint(wallet, cfg, templateId, quantity = 1, opts = {}) {
  needWallet(wallet, cfg);
  const id = Number(templateId), q = Number(quantity);
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError("mint needs a template id");
  if (!Number.isSafeInteger(q) || q < 1 || q > MAX_PER_TX) throw reword(revertError({ name: "BadQuantity" }));
  return exclusive(wallet, async () => {
    try {
      await wallet.ensureChain();
      const s = await readMinter(cfg, wallet.address);
      if (s.paused) throw revertError({ name: "EnforcedPause" });
      if (!s.ready) throw revertError({ name: "NotMinter" });
      if (s.mintable !== Infinity && s.mintable < q) {
        throw new ShopError("unavailable", s.mintable === 0 ? MESSAGES.WalletLimitReached : `This wallet may mint ${s.mintable} more card${s.mintable === 1 ? "" : "s"}.`, { reason: "WalletLimitReached", mintable: s.mintable });
      }
      const [edition] = await readEditions(cfg, id + 1).then((all) => all.slice(id, id + 1));
      if (!edition || edition.retired) throw revertError({ name: "UnknownTemplate" });
      if (edition.left < q) throw new ShopError("unavailable", edition.left === 0 ? MESSAGES.SoldOut : `Only ${edition.left} cop${edition.left === 1 ? "y is" : "ies are"} left of that card.`, { reason: "SoldOut", left: edition.left });
      const cost = s.price * BigInt(q);
      await requireFunds(wallet, cfg, q, cost);
      const data = encodeCall(FIXED_SELECTORS.mint, ["uint256", "uint256"], [id, q]);
      const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.shop, data, value: cost }, opts);
      const me = String(wallet.address).toLowerCase();
      const ev = findEvent(receipt, cfg, "Minted", decodeMinted, (e) => e.to === me && e.templateId === id, txHash);
      return { tokenIds: ev.tokenIds.map(String), templateId: id, txHash };
    } catch (e) { throw reword(e); }
  });
}
