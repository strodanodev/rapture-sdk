// Mint site — PackShopV2 client: read the shop and its deck, buy a sealed pack, open it with the drand signatures its round
// needs, refund after a shutdown, and find a player's packs again after a page reload. Writes and signatures go through
// wallet.js; every read, gas estimate and receipt goes through chain.js (see the note there on why reads bypass the
// wallet). drand.js fetches the beacon signatures; this module only carries them to the chain.
//
// Conventions: money is bigint wei; ids that must survive JSON (pack ids, token ids) are decimal strings; drand rounds
// are numbers; every failure is a ShopError/WalletError whose .message is fit to show a player and whose .code /
// .reason a UI can branch on.
//
// HOW A V2 PACK OPENS. buyPack() binds the pack to a drand evmnet round 5 past the newest one the contract knows of
// (13-15 s ahead; the contract's own rule, so the client never computes it: PackBought carries the round). Once drand
// publishes that round, ANYONE may call openPack(id, rounds, signatures): the contract proves each signature on chain,
// deals every earlier undealt pack first (strictly in purchase order: with a shrinking deck the order decides who gets a
// Gold), then mints this pack to its buyer. pendingRounds(id, max) names exactly the rounds that still need proving.
// Without a keeper that bill grows (~42k gas per earlier pack, ~251k per distinct round) past what one transaction may
// spend, so deal(maxPacks, rounds, signatures) can work through the backlog in chunks first. Because opening is
// permissionless, a keeper may deal or open a player's pack before the player does; the cards are fixed either way, and
// packOf() reads them. There is no expiry and no refund while the shop runs; after an owner shutdown() the BUYER may
// refund a pack that cannot be delivered (its round never proven, or a dealt pack the shop can no longer mint).
//
// LITVM (LITEFORGE) IS ARBITRUM NITRO: the RPC's block numbers are not the contract's. Nothing here does block arithmetic:
// readiness comes from drand's schedule and the contract's own views (phaseOf / packOf / recentPacks).

import {
  SELECTORS, MINTER_SELECTORS, TOPICS, FIXED_TOPICS, encodeCall, toBigInt, fromQuantity, isAddress, isHex, words, uintAt, uintBoundAt, boolAt, addressAt,
  decodePackBought, decodePackDealt, decodePackOpened, decodePackRefunded, decodePackOf, decodeRecentPacks, decodeUintArray, decodeDeck,
  decodeRevert, extractRevertData,
} from "./abi.js";
import { createChain, RpcError, isAbort } from "./chain.js";
import { normalizeBeacon, roundTime } from "./drand.js";
import { LITEFORGE, WalletError } from "./wallet.js";

/** PackShopV2.Phase, as the contract enumerates it. Waiting = the drand round is not due by block.timestamp yet;
 *  Ready = due (fetch the signature and open); Dealt = cards fixed, not minted yet. */
export const PHASE = Object.freeze({ None: 0, Waiting: 1, Ready: 2, Dealt: 3, Opened: 4, Refunded: 5 });
export const PHASE_NAMES = Object.freeze(["None", "Waiting", "Ready", "Dealt", "Opened", "Refunded"]);
/** PackShopV2.Finish. 0 = a token this shop did not mint. */
export const FINISH = Object.freeze({ None: 0, Normal: 1, Shiny: 2, Gold: 3 });
/** Rounds the page asks pendingRounds for before an open. Getting all 16 back means there may be more: the backlog is
 *  then dealt in chunks (DEAL_ROUNDS rounds, at most DEAL_PACKS packs per deal() transaction) before the open. */
export const MAX_PROOFS = 16;
export const DEAL_ROUNDS = 12;
export const DEAL_PACKS = 150;
/** An openPack whose gas estimate is above this is not sent: the backlog is dealt first (the chain's cap is 32M). */
export const OPEN_GAS_CAP = 25_000_000n;
/** Seconds after max(shutdownAt, the pack's round) before an unopened pack can be refunded (PackShopV2.REFUND_GRACE). */
export const REFUND_GRACE = 7 * 24 * 3600;

const RECENT_PACKS = 16;                     // recentPacks(who, n) never returns more than 16 (the contract caps n)
// Gas. eth_estimateGas is a simulation against the newest state: on Nitro it also prices the parent-chain data the
// transaction posts, and an openPack proves drand signatures (~0.3M gas each), deals any earlier packs (~70k each) and
// mints five cards (~4.5M, storage-heavy), so the true cost can drift above the estimate by the time it lands. Running
// out of gas mid-mint burns the fee and leaves the pack unopened, and unused gas is refunded, so we bid the estimate + 25%
// as an explicit limit instead of trusting the wallet's own guess.
const GAS_HEADROOM_PERCENT = 25n;   // OPEN_GAS_CAP + 25% stays under the 32M per-transaction cap
const BUY_GAS_RESERVE = 600_000n;            // gas units to keep in the wallet for the buy transaction ...
const OPEN_GAS_RESERVE = 12_000_000n;        // ... and for opening the pack afterwards (a player who cannot afford to open is stuck)
const FEE_CAP_FACTOR = 2n;                   // the max fee we pass the wallet (and reserve funds for): 2x the current gas price
const FALLBACK_GAS_PRICE = 1_000_000_000n;   // 1 gwei, used only if eth_gasPrice itself fails

// ------------------------------------------------------------------ errors
/** WalletError plus the shop's own codes: not_configured, low_balance, unavailable (paused / not open / sold out / shut
 *  down / daily limit / price changed), pack_none | pack_waiting | pack_ready | pack_dealt | pack_opened | pack_refunded
 *  (the pack is not in a state the action needs; .phase / .phaseName say which), reverted (.reason = custom error name),
 *  too_much_gas (.estimate: the transaction would cost more than its cap; nothing was signed), timeout (.txHash),
 *  aborted, busy, rpc, bad_response. */
export class ShopError extends WalletError {
  constructor(code, message, props = {}) {
    super(code, message, props);
    this.name = "ShopError";
  }
}

const UNAVAILABLE = new Set(["EnforcedPause", "NotLocked", "SoldOut", "IsShutdown", "NotMinter", "DailyLimitReached", "WrongPayment", "WalletLimitReached", "UnknownTemplate"]);
const CARD_CONTRACT = new Set(["NotRegistered", "BadTraits", "BadParts", "BadKit", "EmptyBatch", "AlreadyWritten", "BadDesign", "OutOfBand"]);
const ERROR_MESSAGES = {
  NotLocked: "The shop is not open yet: its card deck is still being set up. Try again later.",
  SoldOut: "Sold out: every pack of this print run has been sold. Packs already bought still open as normal.",
  IsShutdown: "The shop has closed for good, so it sells no more packs. Packs already bought still open as normal.",
  // PackShopV2 refuses to sell without its minting permission (buy time), and StudioMinter refuses to mint without it (open time)
  NotMinter: "The shop cannot mint cards right now: its minting permission is missing. Nothing was charged, and a pack you already bought stays sealed and safe. Please tell the team.",
  WrongPayment: "The pack price just changed. Reload the page and try again.",
  DailyLimitReached: "You have bought your packs for today. Come back after midnight UTC.",
  EnforcedPause: "Sales are paused right now. Packs already bought still open as normal. Try again soon.",
  NotDealt: "This pack has already been opened or refunded.",
  BadProof: "The page sent a broken drand proof. Nothing was changed. Reload the page and try again.",
  NotRefundable: "This pack cannot be refunded: it will be delivered instead, so open it to get its cards. (After the shop shuts down for good, only the buyer can refund a pack that cannot be delivered, 7 days on.)",
  TransferFailed: "The refund could not be sent to your wallet. Try again in a moment.",
  ReentrancyGuardReentrantCall: "The shop is busy with another request. Try again.",
};
const short = (s, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Decoded revert data (abi.js decodeRevert) -> ShopError with a player-facing message and .reason = error name. */
function revertError(decoded, props = {}) {
  const name = decoded?.name ?? null;
  let message;
  if (name && ERROR_MESSAGES[name]) message = ERROR_MESSAGES[name];
  else if (name === "BeaconMissing") message = `The drand signature for round ${decoded.round ?? "?"} has not been proven yet, so the pack cannot be dealt. Nothing was changed. Try again in a few seconds.`;
  else if (name && CARD_CONTRACT.has(name)) message = `The card contract refused to mint this pack (${name}). Your pack is still sealed. Please tell the team.`;
  else if (name === "Error" && /invalid signature/i.test(decoded.reason ?? "")) message = "The chain refused a drand signature for this pack. Nothing was changed. Try again in a moment.";
  else if (name === "Error" && decoded.reason) message = `The contract refused this: ${short(decoded.reason)}`;
  else if (name === "Panic") message = `The contract hit an internal error (panic ${decoded.code != null ? "0x" + decoded.code.toString(16) : "?"}). Nothing was changed. Please tell the team.`;
  else message = `The network says this would fail${decoded?.selector ? ` (${decoded.selector})` : ""}. Nothing was changed.`;
  const extra = name === "BeaconMissing" && decoded.round != null ? { round: Number(decoded.round) } : {};
  return new ShopError(UNAVAILABLE.has(name) ? "unavailable" : "reverted", message, { reason: name, selector: decoded?.selector ?? null, ...extra, ...props });
}

const PHASE_MESSAGES = {
  None: "This pack does not exist.",
  Waiting: "Your pack's drand round is not out yet. Give it a few more seconds.",
  Ready: "This pack is ready to open.",
  Dealt: "This pack's cards are already drawn; it only needs opening.",
  Opened: "This pack has already been opened. Its cards are in your wallet.",
  Refunded: "This pack was refunded.",
};
const REFUND_MESSAGES = {
  ...PHASE_MESSAGES,
  Opened: "This pack was opened, so there is nothing to refund.",
};
/** The pack is not in the state an action needs -> ShopError(code "pack_<phase>", .phase, .phaseName). */
export function phaseError(phase, messages = PHASE_MESSAGES) {
  const name = PHASE_NAMES[phase] ?? "None";
  return new ShopError(`pack_${name.toLowerCase()}`, messages[name], { phase, phaseName: name });
}

/** chain.js / wallet failures -> what a caller should see. Programming errors pass through unchanged. */
function asShopError(e, cfg = null) {
  if (e instanceof WalletError) return e;
  if (isAbort(e)) return new ShopError("aborted", "Cancelled.", { cause: e });
  if (e instanceof RpcError) {
    const data = extractRevertData(e);
    if (e.isRevert || data) return revertError(decodeRevert(data), { cause: e, data });
    return new ShopError("rpc", `Could not reach the ${cfg?.chainName ? `${cfg.chainName} network` : "network"} (${short(e.message, 100)}). Check your connection and try again.`, { cause: e, detail: e.message });
  }
  return e;
}
const stager = (onStage) => (name) => {
  if (typeof onStage !== "function") return;
  try { onStage(name); } catch (e) { console.error("[packshop] onStage callback threw", e); }   // a UI bug must not abort a purchase mid-flight
};

// ------------------------------------------------------------------ config
/**
 * The shop config this module works on, from a validated site config (config.js): { chainId, chainName, rpc,
 * explorer, faucet, currency, packShop, beacon }. Throws ShopError(not_configured) unless the site sells packs.
 */
export function packConfig(site) {
  const m = site?.mint;
  if (!m || m.mode !== "packs" || !isAddress(m.address)) {
    throw new ShopError("not_configured", "This site does not sell packs (site.config.json mint.mode is not \"packs\").");
  }
  let beacon;
  try { beacon = normalizeBeacon(m.beacon); }
  catch (e) { throw new ShopError("not_configured", `The site config has a bad drand beacon (${e.message}).`, { cause: e }); }
  const c = site.chain ?? {};
  return {
    chainId: c.id,
    chainName: c.name ?? `chain ${c.id}`,
    rpc: c.rpc,
    explorer: c.explorer ?? null,
    faucet: c.faucet ?? null,
    currency: c.currency ?? LITEFORGE.nativeCurrency,
    packShop: m.address,
    beacon,
  };
}

/** The read-only RPC client for this config (one per RPC url). `cfg.client` overrides it (tests, custom retry policy). */
const clients = new Map();
export function rpcFor(cfg) {
  if (!cfg || !isAddress(cfg.packShop) || typeof cfg.rpc !== "string") {
    throw new ShopError("not_configured", "The pack shop is not available yet.");
  }
  if (cfg.client) return cfg.client;
  let c = clients.get(cfg.rpc);
  if (!c) { c = createChain(cfg.rpc); clients.set(cfg.rpc, c); }
  return c;
}

// ------------------------------------------------------------------ reads
/** One eth_call to the shop -> the raw return data. Empty data means there is no contract at that address. */
async function readRaw(cfg, selector, types, values, o) {
  let raw;
  try { raw = await rpcFor(cfg).call({ to: cfg.packShop, data: encodeCall(selector, types, values) }, o); }
  catch (e) { throw asShopError(e, cfg); }
  if (raw === "0x") {
    throw new ShopError("not_configured", "The pack shop contract was not found on this network. It may not be deployed yet.", { packShop: cfg.packShop });
  }
  return raw;
}
const decoding = (fn) => {
  try { return fn(); }
  catch (e) { throw new ShopError("bad_response", "The network sent back something the shop could not read.", { cause: e }); }
};
const readWords = async (cfg, selector, types, values, o) => {
  const raw = await readRaw(cfg, selector, types, values, o);
  return decoding(() => words(raw));
};
/** A uint64 drand round as a JS number (rounds are ~2e7 today; anything past 2^53 is not a real answer). */
const asRound = (v) => {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`round ${v} is out of range`);
  return Number(v);
};
const knownPhase = (phase) => {
  if (!(phase >= 0 && phase < PHASE_NAMES.length)) throw new ShopError("bad_response", `The shop reported an unknown pack state (${phase}).`);
  return phase;
};

/** Packs the address may still buy today: a number, or Infinity when the shop has no daily limit. */
export async function packsLeftToday(cfg, address, o) {
  const ws = await readWords(cfg, SELECTORS.packsLeftToday, ["address"], [address], o);
  const n = decoding(() => uintAt(ws, 0));
  return n > 0xffffn ? Infinity : Number(n);     // the contract answers uint256.max for "no limit"
}

/**
 * config() decoded: { price (bigint wei), packSize, dailyLimit (0 = none), paused, ready, maxSupply, packsTotal,
 * packsSold, cardsLeft, templateCount, soldOut }. ready is false before lock(), after shutdown(), once sold out, or
 * without the MINTER role. With an address it also carries packsLeft (see packsLeftToday).
 */
export async function readShop(cfg, address, o) {
  const [ws, packsLeft] = await Promise.all([
    readWords(cfg, SELECTORS.config, [], [], o),
    address ? packsLeftToday(cfg, address, o) : undefined,
  ]);
  const shop = decoding(() => {
    if (ws.length !== 10) throw new Error(`config() returned ${ws.length} words, PackShopV2 returns 10`);
    const n = (i, bits) => Number(uintBoundAt(ws, i, bits));
    const s = {
      price: uintAt(ws, 0),
      packSize: n(1, 8),
      dailyLimit: n(2, 16),
      paused: boolAt(ws, 3),
      ready: boolAt(ws, 4),
      maxSupply: n(5, 32),
      packsTotal: n(6, 32),
      packsSold: n(7, 32),
      cardsLeft: n(8, 32),
      templateCount: n(9, 32),
    };
    s.soldOut = s.packsTotal > 0 && s.packsSold >= s.packsTotal;
    return s;
  });
  if (packsLeft !== undefined) shop.packsLeft = packsLeft;
  return shop;
}

/** The deck, [kind][finish - 1] (Kinds in the contract's order Mortal..God): what is left (default) or what was printed. */
export async function readDeck(cfg, which = "remaining", o) {
  const raw = await readRaw(cfg, which === "initial" ? SELECTORS.deckInitial : SELECTORS.deckRemaining, [], [], o);
  return decoding(() => decodeDeck(raw));
}

/** shutdownAt(): unix seconds of the owner's one-way shutdown(), 0 while the shop runs. */
export async function readShutdownAt(cfg, o) {
  const ws = await readWords(cfg, SELECTORS.shutdownAt, [], [], o);
  return decoding(() => Number(uintBoundAt(ws, 0, 64)));
}

/** phaseOf(packId) as the PHASE number. Anything unknown to this client is an error, not a guess. */
export async function phaseOf(cfg, packId, o) {
  const ws = await readWords(cfg, SELECTORS.phaseOf, ["uint256"], [packId], o);
  return knownPhase(Number(decoding(() => uintAt(ws, 0))));
}

/**
 * packOf(packId): { packId, buyer (lowercase, the zero address for no pack), round, phase, phaseName, paid (bigint),
 * templateIds, finishes }. templateIds / finishes (1 Normal, 2 Shiny, 3 Gold) are filled once the pack is Dealt or
 * Opened, in slot order, so a pack someone else opened can still be shown.
 */
export async function readPack(cfg, packId, o) {
  const id = toBigInt(packId);
  const raw = await readRaw(cfg, SELECTORS.packOf, ["uint256"], [id], o);
  const p = decoding(() => { const d = decodePackOf(raw); return { ...d, round: asRound(d.round) }; });
  knownPhase(p.phase);
  return { packId: id.toString(), buyer: p.buyer, round: p.round, phase: p.phase, phaseName: PHASE_NAMES[p.phase], paid: p.paid, templateIds: p.templateIds, finishes: p.finishes };
}

/** The drand rounds (oldest first, at most `max`) that opening pack `upTo` still has to prove: its own, plus those of
 *  earlier undealt packs (packs are dealt strictly in purchase order). [] once everything up to it is dealt. */
export async function pendingRounds(cfg, upTo, max = MAX_PROOFS, o) {
  const raw = await readRaw(cfg, SELECTORS.pendingRounds, ["uint256", "uint256"], [toBigInt(upTo), max], o);
  return decoding(() => decodeUintArray(raw, 64, Math.max(1, Number(max))).map(asRound));
}

/** tokensOf(packId): the token ids (decimal strings) an Opened pack minted, in slot order; [] until it is Opened. */
export async function readTokens(cfg, packId, o) {
  const raw = await readRaw(cfg, SELECTORS.tokensOf, ["uint256"], [toBigInt(packId)], o);
  return decoding(() => decodeUintArray(raw, 256, 64).map(String));
}

/**
 * Can the shop still mint? minter() names its StudioMinter, whose minters(shop) says. After a shutdown this decides
 * whether a dealt pack will be delivered (true) or may be refunded by its buyer (false).
 */
export async function canMint(cfg, o) {
  const ws = await readWords(cfg, SELECTORS.minter, [], [], o);
  const minter = decoding(() => addressAt(ws, 0));
  let raw;
  try { raw = await rpcFor(cfg).call({ to: minter, data: encodeCall(MINTER_SELECTORS.minters, ["address"], [cfg.packShop]) }, o); }
  catch (e) { throw asShopError(e); }
  return decoding(() => boolAt(words(raw), 0));
}

/** finishesOf(tokenIds) -> [0 | 1 | 2 | 3] in the same order (0 = not minted by this shop). */
export async function finishesOf(cfg, tokenIds, o) {
  const ids = tokenIds.map(toBigInt);
  if (!ids.length) return [];
  const raw = await readRaw(cfg, SELECTORS.finishesOf, ["uint256[]"], [ids], o);
  return decoding(() => {
    const out = decodeUintArray(raw, 8, ids.length).map(Number);
    if (out.length !== ids.length) throw new Error(`finishesOf answered ${out.length} finishes for ${ids.length} tokens`);
    return out;
  });
}

/**
 * When an unopened pack becomes refundable (unix seconds), or null while the shop runs (shutdownAt 0): the contract
 * waits REFUND_GRACE past both the shutdown and the pack's own drand round.
 */
export function refundableAt(round, shutdownAt) {
  if (!shutdownAt) return null;
  return Math.max(roundTime(round), Number(shutdownAt)) + REFUND_GRACE;     // the contract's own evmnet constants
}

// ------------------------------------------------------------------ transactions
// One purchase / open / refund at a time per wallet: a double click must not put two identical prompts in front of the player.
const busy = new WeakSet();
async function exclusive(wallet, fn) {
  if (busy.has(wallet)) throw new ShopError("busy", "Another shop transaction is already in progress. Finish it in your wallet first.");
  busy.add(wallet);
  try { return await fn(); } finally { busy.delete(wallet); }
}

function needWallet(wallet, cfg) {
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
 * chain whose base fee idles at its floor and then drifts ~1% a block (Liteforge / Nitro: 0.01 gwei) some wallets bid
 * EXACTLY the floor, so a transaction signed a moment later is refused: "max fee per gas less than block base fee"
 * (seen live: maxFeePerGas 10000000 vs baseFee 10009000, which broke the second signature of a pack). The cap is only a
 * ceiling, the player still pays the actual base fee, so the extra headroom costs nothing. Returns {} (the wallet
 * decides) when the node cannot even say what gas costs.
 */
async function feeCaps(chain) {
  let gasPrice;
  try { gasPrice = await chain.gasPrice(); }
  catch (e) { console.warn("[packshop] eth_gasPrice failed; leaving the network fee to the wallet", e); return {}; }
  if (gasPrice <= 0n) return {};
  const maxFeePerGas = gasPrice * FEE_CAP_FACTOR;
  let tip = 0n;
  try { tip = await chain.maxPriorityFeePerGas(); }
  catch (e) { /* a node without the method: Nitro takes no tip anyway */ }
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

/**
 * estimate -> +25% -> sign -> wait for the receipt -> fail loudly if it reverted. Stages: signing, pending, confirmed.
 * maxGas: refuse (too_much_gas, before any prompt) a transaction whose estimate is above it.
 */
async function transact(wallet, cfg, tx, { onStage, signal, pollMs, timeoutMs, maxGas = null } = {}) {
  const chain = rpcFor(cfg);
  const stage = stager(onStage);
  const from = wallet.address;
  let estimate;
  try { estimate = await chain.estimateGas({ from, ...tx }); }
  catch (e) { throw asShopError(e); }     // a revert here is the friendliest place to learn about it: nothing was signed yet
  if (maxGas != null && estimate > maxGas) {
    throw new ShopError("too_much_gas", "Opening this pack now would cost more gas than one transaction may use, because of the older packs ahead of it. Nothing was signed.", { estimate });
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
    throw asShopError(e);
  }
  if (receipt.status !== "0x1") throw await explainFailure(chain, tx, from, gas, receipt, txHash);
  stage("confirmed");
  return { txHash, receipt };
}

/** The first log of this shop matching an event (and `match`), decoded. */
function findEvent(receipt, cfg, name, decode, match, txHash) {
  const shop = cfg.packShop.toLowerCase();
  let failure;
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== shop || String(log.topics?.[0]).toLowerCase() !== (TOPICS[name] ?? FIXED_TOPICS[name])) continue;
    try {
      const ev = decode(log);
      if (match(ev)) return ev;
    } catch (e) { failure = e; }
  }
  throw new ShopError("bad_response", `The transaction confirmed, but its ${name} event is missing. Reload the page: the pack will show up if it was created.`, { txHash, cause: failure });
}

/** Wallet balance vs price + the gas for buying and (later) opening; throws ShopError(low_balance) with the faucet hint. */
async function requireFunds(wallet, cfg, chain, price) {
  const [balance, gasPrice] = await Promise.all([
    chain.getBalance(wallet.address).catch((e) => { throw asShopError(e); }),
    chain.gasPrice().catch((e) => { console.warn("[packshop] eth_gasPrice failed; assuming 1 gwei", e); return FALLBACK_GAS_PRICE; }),
  ]);
  const fees = (BUY_GAS_RESERVE + OPEN_GAS_RESERVE) * gasPrice * FEE_CAP_FACTOR;
  const need = price + fees;
  if (balance >= need) return;
  const symbol = wallet.chain?.nativeCurrency?.symbol ?? cfg.currency?.symbol ?? "zkLTC";
  const faucet = wallet.chain?.faucet ?? null;       // only what the chain config names: never another network's faucet
  throw new ShopError("low_balance",
    `Not enough ${symbol}: a pack costs ${formatZkltc(price, 4, "ceil")} and network fees need about ${formatZkltc(fees, 4, "ceil")} more, but your wallet has ${formatZkltc(balance, 4, "floor")}.${faucet ? ` Get free test ${symbol} at ${faucet}` : ""}`,
    { have: balance, need, price, fees, faucet });
}

/** rounds / signatures as openPack and deal take them: equal length, rounds positive integers, 64-byte signatures. */
function proofArgs(rounds = [], signatures = []) {
  if (!Array.isArray(rounds) || !Array.isArray(signatures) || rounds.length !== signatures.length) {
    throw new TypeError("rounds and signatures must be arrays of the same length");
  }
  const rs = rounds.map((r) => {
    const n = toBigInt(r);
    if (n < 1n || n >= 1n << 64n) throw new TypeError(`not a drand round: ${String(r)}`);
    return n;
  });
  for (const s of signatures) if (!isHex(s, 64)) throw new TypeError("a drand evmnet signature is 64 bytes of 0x hex");
  return [rs, signatures];
}

/**
 * Buy one sealed pack for the shop's price. Resolves { packId (decimal string), txHash, round } once the transaction is
 * mined; round is the drand round the pack is bound to. onStage("signing" | "pending" | "confirmed"). Opts: signal
 * (stops the wait, not the transaction), pollMs, timeoutMs. findMyPacks recovers the pack after a reload.
 */
export async function buyPack(wallet, cfg, opts = {}) {
  needWallet(wallet, cfg);
  return exclusive(wallet, async () => {
    const chain = rpcFor(cfg);
    await wallet.ensureChain();
    const address = wallet.address;
    const [shop, left] = await Promise.all([readShop(cfg), packsLeftToday(cfg, address)]);
    if (shop.soldOut) throw revertError({ name: "SoldOut" });
    if (!shop.ready && (await readShutdownAt(cfg))) throw revertError({ name: "IsShutdown" });
    if (shop.paused) throw revertError({ name: "EnforcedPause" });
    if (left === 0) throw revertError({ name: "DailyLimitReached" });
    // not ready for another reason (deck not locked, minting permission missing): the gas estimate names it, before any prompt
    await requireFunds(wallet, cfg, chain, shop.price);
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data: encodeCall(SELECTORS.buyPack), value: shop.price }, opts);
    const ev = findEvent(receipt, cfg, "PackBought", decodePackBought, (e) => e.buyer === address, txHash);
    return { packId: ev.packId.toString(), txHash, round: decoding(() => asRound(ev.round)) };
  });
}

/**
 * Open a pack: prove `rounds` with their drand `signatures` (pendingRounds says which; [] once they are proven), deal
 * whatever comes before it, mint its cards to the buyer. Resolves { tokenIds: [decimal string], templateIds: [number],
 * finishes: [1 | 2 | 3], txHash } in slot order. Refuses a pack that is gone (pack_none, pack_opened, pack_refunded)
 * without troubling the wallet; a Waiting pack is tried (block.timestamp may trail drand by a few seconds and the proof
 * does not care). An estimate above maxGas (default OPEN_GAS_CAP) is refused as too_much_gas before any prompt: deal the
 * backlog first (dealPacks). onStage("signing" | "pending" | "confirmed"); opts as buyPack. Anyone may open anyone's
 * pack; the cards always go to the buyer.
 */
export async function openPack(wallet, cfg, packId, { rounds = [], signatures = [], maxGas = OPEN_GAS_CAP, ...opts } = {}) {
  needWallet(wallet, cfg);
  const id = toBigInt(packId);
  const [rs, sigs] = proofArgs(rounds, signatures);
  return exclusive(wallet, async () => {
    await wallet.ensureChain();
    const phase = await phaseOf(cfg, id);
    if (phase === PHASE.None || phase === PHASE.Opened || phase === PHASE.Refunded) throw phaseError(phase);
    const data = encodeCall(SELECTORS.openPack, ["uint256", "uint64[]", "bytes[]"], [id, rs, sigs]);
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data }, { ...opts, maxGas });
    const ev = findEvent(receipt, cfg, "PackOpened", decodePackOpened, (e) => e.packId === id, txHash);
    return { tokenIds: ev.tokenIds.map(String), templateIds: ev.templateIds, finishes: ev.finishes, txHash };
  });
}

/**
 * Work through the backlog ahead of a pack: deal(maxPacks, rounds, signatures) proves the rounds, then deals up to
 * maxPacks packs in purchase order (stopping at the first round still unproven). No money moves and nothing is minted;
 * it fixes those packs' cards, so the open after it carries less. Resolves { txHash, dealt: [packId] } (the PackDealt
 * events of this shop in the receipt, in order).
 */
export async function dealPacks(wallet, cfg, maxPacks, rounds, signatures, opts = {}) {
  needWallet(wallet, cfg);
  const max = toBigInt(maxPacks);
  if (max < 1n) throw new TypeError("dealPacks deals at least one pack");
  const [rs, sigs] = proofArgs(rounds, signatures);
  return exclusive(wallet, async () => {
    await wallet.ensureChain();
    const data = encodeCall(SELECTORS.deal, ["uint256", "uint64[]", "bytes[]"], [max, rs, sigs]);
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data }, opts);
    const shop = cfg.packShop.toLowerCase();
    const dealt = (receipt.logs ?? [])
      .filter((l) => String(l.address).toLowerCase() === shop && String(l.topics?.[0]).toLowerCase() === TOPICS.PackDealt)
      .map((l) => decoding(() => decodePackDealt(l).packId.toString()));
    return { txHash, dealt };
  });
}

/**
 * After the owner shut the shop down for good, the BUYER may claim back the price of a pack that cannot be delivered:
 * a sealed one whose drand round was never proven, or a dealt one the shop can no longer mint, once REFUND_GRACE has
 * passed (refundableAt). Anything else is NotRefundable: that pack will be delivered, so open it. Resolves
 * { txHash, amount (bigint wei) }.
 */
export async function refundPack(wallet, cfg, packId, opts = {}) {
  needWallet(wallet, cfg);
  const id = toBigInt(packId);
  return exclusive(wallet, async () => {
    await wallet.ensureChain();
    const pack = await readPack(cfg, id);
    if (pack.phase !== PHASE.Waiting && pack.phase !== PHASE.Ready && pack.phase !== PHASE.Dealt) throw phaseError(pack.phase, REFUND_MESSAGES);
    if (pack.buyer !== String(wallet.address).toLowerCase()) {
      throw new ShopError("reverted", "Only the wallet that bought this pack can refund it.", { reason: "NotRefundable" });
    }
    if (!(await readShutdownAt(cfg))) {
      throw new ShopError("reverted", "There are no refunds while the shop runs: every pack bought will be delivered. Open it to get its cards.", { reason: "NotRefundable" });
    }
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data: encodeCall(SELECTORS.refund, ["uint256"], [id]) }, opts);
    const ev = findEvent(receipt, cfg, "PackRefunded", decodePackRefunded, (e) => e.packId === id, txHash);
    return { txHash, amount: ev.amount };
  });
}

// ------------------------------------------------------------------ resume after a reload
/**
 * The address's most recent packs (at most 16: the contract's cap), oldest first, from ONE eth_call to
 * recentPacks(address, 16): [{ packId (decimal string), phase (PHASE number), phaseName, round }]. The contract keeps a
 * per-buyer index, so nothing is scanned and no pack is missed inside the 16; filter on phase to find what to resume
 * (Waiting / Ready / Dealt). A buyer with more than 16 packs sees only the newest 16. `o` is passed to the RPC call.
 */
export async function findMyPacks(cfg, address, o) {
  if (!isAddress(address)) throw new TypeError("findMyPacks needs the buyer's 0x address");
  const raw = await readRaw(cfg, SELECTORS.recentPacks, ["address", "uint256"], [address, RECENT_PACKS], o);
  const { ids, phases, rounds } = decoding(() => decodeRecentPacks(raw));
  const out = decoding(() => rounds.map(asRound));
  return ids.map((id, i) => ({ packId: id.toString(), phase: knownPhase(phases[i]), phaseName: PHASE_NAMES[phases[i]], round: out[i] }));
}

// ------------------------------------------------------------------ display
/**
 * Wei -> "0.1235" (up to `digits` decimals, trailing zeros trimmed). Any 18-decimal native token (zkLTC on LitVM). mode: "nearest" (default), "floor" (balances: never
 * show more than there is) or "ceil" (prices: never show less than it costs). A non-zero amount that would print as
 * zero prints as "<0.0001" instead.
 */
export function formatZkltc(wei, digits = 4, mode = "nearest") {
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
/** formatZkltc under a chain-neutral name. */
export const formatAmount = formatZkltc;

// Shared with fixed.js (the FixedPriceMinter client): one transaction path, one error vocabulary for both shops.
// `cfg.packShop` is the shop contract's address whichever minter it is.
export { transact, asShopError, revertError, exclusive, needWallet, findEvent, readWords, readRaw, decoding, feeCaps };
