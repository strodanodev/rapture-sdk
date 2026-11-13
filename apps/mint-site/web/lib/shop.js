// Mint site — what every shop page shares: the error vocabulary, the read-only RPC client per config, and the one
// transaction path (estimate, +25% gas, explicit fee caps, sign, wait for the receipt, explain a failure). The
// fixed-price client (fixed.js) and, where the site has one, the pack module build on it. Writes and signatures go
// through wallet.js; every read, estimate and receipt goes through chain.js (reads bypass the wallet: see chain.js).
//
// A shop config is { chainId, chainName, rpc, explorer, faucet, currency, shop } where `shop` is the contract's address
// (the pack module's configs call it `packShop`; both are read). Money is bigint wei; failures are ShopError/WalletError
// whose .message is fit to show a buyer and whose .code / .reason a UI can branch on.
import { encodeCall, fromQuantity, isAddress, words, decodeRevert, extractRevertData, FIXED_TOPICS, toBigInt } from "./abi.js";
import { createChain, RpcError, isAbort } from "./chain.js";
import { WalletError } from "./wallet.js";

// Gas. eth_estimateGas is a simulation against the newest state; on Nitro it also prices the parent-chain data, and a
// mint is storage-heavy, so the true cost can drift above the estimate by the time it lands. Running out of gas burns
// the fee, and unused gas is refunded, so the estimate + 25% is sent as an explicit limit.
const GAS_HEADROOM_PERCENT = 25n;
const FEE_CAP_FACTOR = 2n;                   // the max fee passed to the wallet: 2x the current gas price

// ------------------------------------------------------------------ errors
/** WalletError plus the shops' own codes: not_configured, low_balance, unavailable (paused / sold out / a limit /
 *  price changed), reverted (.reason = custom error name), too_much_gas (.estimate; nothing was signed), timeout
 *  (.txHash), aborted, busy, rpc, bad_response. A pack module adds pack_<phase> codes. */
export class ShopError extends WalletError {
  constructor(code, message, props = {}) {
    super(code, message, props);
    this.name = "ShopError";
  }
}

const UNAVAILABLE = new Set(["EnforcedPause", "SoldOut", "NotMinter", "WrongPayment", "WalletLimitReached", "UnknownTemplate"]);
/** The reference collection's own errors: a template or the minter role is wrong, not the buyer's request. */
export const CARD_CONTRACT = new Set(["NotRegistered", "BadTraits", "BadParts", "BadKit", "EmptyBatch", "AlreadyWritten", "BadDesign", "OutOfBand"]);
const MESSAGES = {
  SoldOut: "Sold out.",
  NotMinter: "The shop cannot mint cards right now: its minting permission is missing. Nothing was charged. Please tell the team.",
  WrongPayment: "The price just changed. Reload the page and try again.",
  EnforcedPause: "Sales are paused right now. Try again soon.",
  TransferFailed: "The payment could not be sent to your wallet. Try again in a moment.",
  ReentrancyGuardReentrantCall: "The shop is busy with another request. Try again.",
};
const describers = [];
/**
 * A shop module's own wording: messages { Name: text } (they replace the defaults), unavailable [names] (code
 * "unavailable" rather than "reverted"), and describe(decoded) -> { message, props } | null for errors whose text
 * depends on their arguments or reason string. The pack module registers PackShopV2's this way.
 */
export function registerShopErrors({ messages = {}, unavailable = [], describe = null } = {}) {
  Object.assign(MESSAGES, messages);
  for (const n of unavailable) UNAVAILABLE.add(n);
  if (describe) describers.unshift(describe);
}

export const short = (s, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Decoded revert data (abi.js decodeRevert) -> ShopError with a buyer-facing message and .reason = error name. */
export function revertError(decoded, props = {}) {
  const name = decoded?.name ?? null;
  let message, extra = {};
  const special = describers.map((d) => d(decoded)).find(Boolean);
  if (special) { message = special.message; extra = special.props ?? {}; }
  else if (name && MESSAGES[name]) message = MESSAGES[name];
  else if (name && CARD_CONTRACT.has(name)) message = `The card contract refused to mint this (${name}). Nothing was charged. Please tell the team.`;
  else if (name === "Error" && decoded.reason) message = `The contract refused this: ${short(decoded.reason)}`;
  else if (name === "Panic") message = `The contract hit an internal error (panic ${decoded.code != null ? "0x" + decoded.code.toString(16) : "?"}). Nothing was changed. Please tell the team.`;
  else message = `The network says this would fail${decoded?.selector ? ` (${decoded.selector})` : ""}. Nothing was changed.`;
  return new ShopError(UNAVAILABLE.has(name) ? "unavailable" : "reverted", message, { reason: name, selector: decoded?.selector ?? null, ...extra, ...props });
}

/** chain.js / wallet failures -> what a caller should see. Programming errors pass through unchanged. */
export function asShopError(e, cfg = null) {
  if (e instanceof WalletError) return e;
  if (isAbort(e)) return new ShopError("aborted", "Cancelled.", { cause: e });
  if (e instanceof RpcError) {
    const data = extractRevertData(e);
    if (e.isRevert || data) return revertError(decodeRevert(data), { cause: e, data });
    return new ShopError("rpc", `Could not reach the ${cfg?.chainName ? `${cfg.chainName} network` : "network"} (${short(e.message, 100)}). Check your connection and try again.`, { cause: e, detail: e.message });
  }
  return e;
}
export const stager = (onStage) => (name) => {
  if (typeof onStage !== "function") return;
  try { onStage(name); } catch (e) { console.error("[shop] onStage callback threw", e); }   // a UI bug must not abort a purchase mid-flight
};

// ------------------------------------------------------------------ reads
/** The shop contract's address in a config. */
export const shopOf = (cfg) => cfg?.shop ?? cfg?.packShop;

/** The read-only RPC client for this config (one per RPC url). `cfg.client` overrides it (tests, custom retry policy). */
const clients = new Map();
export function rpcFor(cfg) {
  if (!cfg || !isAddress(shopOf(cfg)) || typeof cfg.rpc !== "string") {
    throw new ShopError("not_configured", "The shop is not available yet.");
  }
  if (cfg.client) return cfg.client;
  let c = clients.get(cfg.rpc);
  if (!c) { c = createChain(cfg.rpc); clients.set(cfg.rpc, c); }
  return c;
}

/** One eth_call to the shop -> the raw return data. Empty data means there is no contract at that address. */
export async function readRaw(cfg, selector, types, values, o) {
  let raw;
  try { raw = await rpcFor(cfg).call({ to: shopOf(cfg), data: encodeCall(selector, types, values) }, o); }
  catch (e) { throw asShopError(e, cfg); }
  if (raw === "0x") {
    throw new ShopError("not_configured", "The shop contract was not found on this network. It may not be deployed yet.", { shop: shopOf(cfg), packShop: shopOf(cfg) });
  }
  return raw;
}
export const decoding = (fn) => {
  try { return fn(); }
  catch (e) { throw new ShopError("bad_response", "The network sent back something the shop could not read.", { cause: e }); }
};
export const readWords = async (cfg, selector, types, values, o) => {
  const raw = await readRaw(cfg, selector, types, values, o);
  return decoding(() => words(raw));
};

// ------------------------------------------------------------------ transactions
// One purchase / open / refund at a time per wallet: a double click must not put two identical prompts in front of the buyer.
const busy = new WeakSet();
export async function exclusive(wallet, fn) {
  if (busy.has(wallet)) throw new ShopError("busy", "Another shop transaction is already in progress. Finish it in your wallet first.");
  busy.add(wallet);
  try { return await fn(); } finally { busy.delete(wallet); }
}

export function needWallet(wallet, cfg) {
  rpcFor(cfg);
  if (!wallet?.connected) throw new WalletError("not_connected", "Connect your wallet first.");
  if (wallet.chain && wallet.chain.chainId !== cfg.chainId) {
    throw new ShopError("not_configured", `This wallet is set up for chain ${wallet.chain.chainId} but the shop lives on chain ${cfg.chainId}.`);
  }
}

const bump = (gas) => gas + (gas * GAS_HEADROOM_PERCENT + 99n) / 100n;    // + 25%, rounded up

/** The failed transaction's revert reason: replay it with eth_call (the block before it, then latest) and decode. */
async function explainFailure(chain, tx, from, gas, receipt, txHash) {
  const mined = receipt.blockNumber ? fromQuantity(receipt.blockNumber) : null;
  const tags = [...(mined && mined > 0n ? [mined - 1n] : []), "latest"];   // historic state may be pruned: latest is the fallback
  let lastError;
  for (const tag of tags) {
    try {
      await chain.call({ ...tx, from, blockTag: tag });
    } catch (e) {
      const data = extractRevertData(e);
      if (data) return revertError(decodeRevert(data), { cause: e, data, txHash });
      lastError = e;
    }
  }
  if (receipt.gasUsed && fromQuantity(receipt.gasUsed) >= gas) {
    return new ShopError("reverted", "The transaction ran out of gas. Only the network fee was spent. Please try again.", { reason: "OutOfGas", txHash });
  }
  return new ShopError("reverted", "The transaction failed on the network for a reason the shop could not read. Nothing was changed except the network fee.", { reason: null, txHash, cause: lastError });
}

/**
 * Explicit EIP-1559 fee caps for the wallet, 2x the current gas price. Left to itself a wallet picks its own, and on a
 * chain whose base fee idles at its floor and then drifts ~1% a block (LitVM / Nitro: 0.01 gwei) some wallets bid
 * EXACTLY the floor, so a transaction signed a moment later is refused: "max fee per gas less than block base fee".
 * The cap is only a ceiling, the buyer still pays the actual base fee. Returns {} (the wallet decides) when the node
 * cannot even say what gas costs.
 */
export async function feeCaps(chain) {
  let gasPrice;
  try { gasPrice = await chain.gasPrice(); }
  catch (e) { console.warn("[shop] eth_gasPrice failed; leaving the network fee to the wallet", e); return {}; }
  if (gasPrice <= 0n) return {};
  const maxFeePerGas = gasPrice * FEE_CAP_FACTOR;
  let tip = 0n;
  try { tip = await chain.maxPriorityFeePerGas(); }
  catch { /* a node without the method: Nitro takes no tip anyway */ }
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

/**
 * estimate -> +25% -> sign -> wait for the receipt -> fail loudly if it reverted. Stages: signing, pending, confirmed.
 * maxGas: refuse (too_much_gas, before any prompt) a transaction whose estimate is above it.
 */
export async function transact(wallet, cfg, tx, { onStage, signal, pollMs, timeoutMs, maxGas = null } = {}) {
  const chain = rpcFor(cfg);
  const stage = stager(onStage);
  const from = wallet.address;
  let estimate;
  try { estimate = await chain.estimateGas({ from, ...tx }); }
  catch (e) { throw asShopError(e, cfg); }     // a revert here is the friendliest place to learn about it: nothing was signed yet
  if (maxGas != null && estimate > maxGas) {
    throw new ShopError("too_much_gas", "This would cost more gas than one transaction may use. Nothing was signed.", { estimate });
  }
  const gas = bump(estimate);
  const fees = await feeCaps(chain);      // fetched last, right before signing: the closest we can get to the price at send time

  stage("signing");
  const txHash = await wallet.sendTransaction({ ...tx, gas, ...fees });    // WalletError (rejected, pending, wrong chain...) propagates as is

  stage("pending");
  let receipt;
  try { receipt = await chain.waitForReceipt(txHash, { signal, pollMs, timeoutMs }); }
  catch (e) {
    if (isAbort(e)) throw new ShopError("aborted", "Stopped waiting. Your transaction was already sent and may still confirm.", { txHash, cause: e });
    if (e instanceof RpcError && e.timeout) {
      throw new ShopError("timeout", "Your transaction was sent but has not confirmed yet. It may still go through. Check the explorer, then reload this page.", { txHash, cause: e });
    }
    throw asShopError(e, cfg);
  }
  if (receipt.status !== "0x1") throw await explainFailure(chain, tx, from, gas, receipt, txHash);
  stage("confirmed");
  return { txHash, receipt };
}

const TOPIC_OF = new Map(Object.entries(FIXED_TOPICS));
/** A shop module's event topics, so findEvent can look them up by name. */
export function registerTopics(topics) { for (const [n, t] of Object.entries(topics)) TOPIC_OF.set(n, t); }

/** The first log of this shop matching an event (and `match`), decoded. */
export function findEvent(receipt, cfg, name, decode, match, txHash) {
  const shop = String(shopOf(cfg)).toLowerCase();
  const topic = TOPIC_OF.get(name);
  let failure;
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== shop || String(log.topics?.[0]).toLowerCase() !== topic) continue;
    try {
      const ev = decode(log);
      if (match(ev)) return ev;
    } catch (e) { failure = e; }
  }
  throw new ShopError("bad_response", `The transaction confirmed, but its ${name} event is missing. Reload the page: it will show up if it happened.`, { txHash, cause: failure });
}

// ------------------------------------------------------------------ display
/**
 * Wei -> "0.1235" (up to `digits` decimals, trailing zeros trimmed), for any 18-decimal native token (zkLTC on LitVM).
 * mode: "nearest" (default), "floor" (balances: never show more than there is) or "ceil" (prices: never show less than
 * it costs). A non-zero amount that would print as zero prints as "<0.0001" instead.
 */
export function formatAmount(wei, digits = 4, mode = "nearest") {
  let v = toBigInt(wei);
  const neg = v < 0n;
  if (neg) v = -v;
  const d = Math.min(18, Math.max(0, Math.floor(digits)));
  const scale = 10n ** BigInt(18 - d);
  let q = v / scale;
  const r = v % scale;
  if (mode === "ceil" ? r > 0n : mode === "floor" ? false : r * 2n >= scale) q += 1n;
  const sign = neg ? "-" : "";
  if (q === 0n) return v === 0n ? "0" : `${sign}<${d ? "0." + "0".repeat(d - 1) + "1" : "1"}`;
  const unit = 10n ** BigInt(d);
  const whole = (q / unit).toString();
  const frac = (q % unit).toString().padStart(d, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? "." + frac : ""}`;
}
/** formatAmount under its first name (the zkLTC of LitVM). */
export const formatZkltc = formatAmount;
