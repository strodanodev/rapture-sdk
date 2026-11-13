// packshop.js end to end: real wallet.js + real chain.js + real abi.js against a mock EIP-1193 wallet and a fake
// Liteforge/PackShopV2 chain. Every log and result the fake produces is encoded by ethers, so the client's decoders are
// checked against an independent encoder.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE, PHASE_NAMES, FINISH, MAX_PROOFS, DEAL_ROUNDS, DEAL_PACKS, OPEN_GAS_CAP, REFUND_GRACE, ShopError,
  rpcFor, readShop, packsLeftToday, phaseOf, readPack, readDeck, readShutdownAt, pendingRounds, finishesOf,
  refundableAt, buyPack, openPack, dealPacks, refundPack, findMyPacks, formatZkltc, readTokens, canMint,
} from "../web/lib/packshop.js";
import { EVMNET, roundTime } from "../web/lib/drand.js";
import { createWallet, WalletError, LITEFORGE, chainParams } from "../web/lib/wallet.js";
import { createChain } from "../web/lib/chain.js";
import { AbiError, TOPICS } from "../web/lib/abi.js";
import {
  ethers, ALICE, BOB, SHOP, MINTER, RPC, ETH, REGISTRY, DRAND, TEST_DECK, q, cfgFor, createFakeChain, createMockProvider, memoryStorage,
  providerError, rpcError, revertRpcError, jsonRpcFetch, hangingFetch, tick, captureConsole, shopIface, sigFor, chainFromConfig, FAUCET,
} from "./helpers.mjs";

const A = ALICE.toLowerCase();
const PRICE = ETH / 10n;
const FEES = (600_000n + 12_000_000n) * 200_000_000n * 2n;     // what buyPack reserves for gas at 0.2 gwei
const FAST = { pollMs: 2, timeoutMs: 2000 };
const deckSum = (d) => d.flat().reduce((a, b) => a + b, 0);

/** Wallet + fake chain + config, all wired together. */
async function setup({ account = ALICE, connect = true, providerOpts = {}, clientOpts = {}, cfgExtra = {} } = {}) {
  const chain = createFakeChain();
  chain.setBalance(account, 10n * ETH);
  const provider = createMockProvider({ chain, accounts: [account], ...providerOpts });
  const cfg = cfgFor({ client: createChain(RPC, { fetch: chain.fetch, backoffMs: 1, retries: 1, timeoutMs: 1000, ...clientOpts }), ...cfgExtra });
  const wallet = createWallet({ provider, storage: memoryStorage(), chain: chainFromConfig(cfg) });
  if (connect) await wallet.connect();
  return { chain, provider, cfg, wallet };
}
async function buy(ctx, opts = {}) {
  const stages = [];
  const r = await buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s), ...FAST, ...opts });
  return { ...r, stages };
}
/** Let the pack's drand round come out, then open it with exactly the proofs the contract asks for. */
async function open(ctx, packId, opts = {}, wallet = ctx.wallet) {
  const p = ctx.chain.st.packs.get(BigInt(packId));
  if (p) ctx.chain.st.now = Math.max(ctx.chain.st.now, roundTime(Number(p.round)) + 1);
  const rounds = await pendingRounds(ctx.cfg, packId);
  return openPack(wallet, ctx.cfg, packId, { rounds, signatures: rounds.map(sigFor), ...FAST, ...opts });
}
// assert.rejects wants a validator that returns exactly `true`, hence Boolean()
const shopErr = (code, extra = () => true) => (e) => e instanceof ShopError && e instanceof WalletError && e.code === code && Boolean(extra(e));
const walletErr = (code, extra = () => true) => (e) => e instanceof WalletError && e.code === code && Boolean(extra(e));
const noTxSent = (ctx) => {
  assert.equal(ctx.provider.methods("eth_sendTransaction").length, 0, "the wallet was never asked to send anything");
  assert.equal(ctx.chain.st.txs.length, 0);
};
const gasBump = (est) => est + (est * 25n + 99n) / 100n;
const serve = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

// ------------------------------------------------------------------ reads
test("readShop decodes config(): price, sizes, flags, the supply counters, soldOut; packsLeft with an address", async () => {
  const { chain, cfg } = await setup();
  chain.st.cfg.price = 123456789012345678n;
  const shop = await readShop(cfg);
  assert.deepEqual(shop, {
    price: 123456789012345678n, packSize: 5, dailyLimit: 3, paused: false, ready: true,
    maxSupply: 72, packsTotal: 14, packsSold: 0, cardsLeft: 72, templateCount: 12, soldOut: false,
  });
  assert.equal(typeof shop.price, "bigint");
  assert.equal((await readShop(cfg, ALICE)).packsLeft, 3);
  chain.st.cfg.paused = true;
  chain.st.cfg.minter = false;
  const s2 = await readShop(cfg);
  assert.deepEqual([s2.paused, s2.ready], [true, false]);
  chain.st.packsSold = 14;
  assert.equal((await readShop(cfg)).soldOut, true);
  // the call went to the shop, with the right selector, on the public RPC (never the wallet)
  const call = chain.methods("eth_call")[0].params[0];
  assert.equal(call.to, SHOP);
  assert.equal(call.data, "0x79502c55");
});

test("packsLeftToday: counts down, is 0 at the limit, and Infinity when the shop has no limit", async () => {
  const { chain, cfg } = await setup();
  assert.equal(await packsLeftToday(cfg, ALICE), 3);
  chain.st.bought.set(A, 2);
  assert.equal(await packsLeftToday(cfg, ALICE), 1);
  assert.equal(await packsLeftToday(cfg, ALICE.toLowerCase()), 1, "any address casing");
  chain.st.bought.set(A, 3);
  assert.equal(await packsLeftToday(cfg, ALICE), 0);
  assert.equal(await packsLeftToday(cfg, BOB), 3, "per wallet");
  chain.st.cfg.dailyLimit = 0;
  assert.equal(await packsLeftToday(cfg, ALICE), Infinity, "uint256.max means unlimited");
  await assert.rejects(packsLeftToday(cfg, "0x1234"), AbiError);
});

test("reads say plainly when the contract is missing, the network is down, or the answer is garbage", async () => {
  const { chain, cfg } = await setup();
  await assert.rejects(readShop({ ...cfg, packShop: BOB }), shopErr("not_configured", (e) => /not found on this network/.test(e.message) && e.packShop === BOB));
  chain.st.hooks.eth_call = () => "0x1234";
  await assert.rejects(readShop(cfg), shopErr("bad_response", (e) => e.cause instanceof AbiError));
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(32 * 11);      // eleven words: a v1 PackShop's config()
  await assert.rejects(readShop(cfg), shopErr("bad_response", (e) => /PackShopV2 returns 10/.test(e.cause?.message)));
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(32 * 3) + "00".repeat(31) + "02" + "00".repeat(32 * 6);   // paused = 2: not a bool
  await assert.rejects(readShop(cfg), shopErr("bad_response"));
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(32) + "00".repeat(31) + "ff".repeat(1) + "ff".repeat(32) + "00".repeat(32 * 7);   // packSize past uint8
  await assert.rejects(readShop(cfg), shopErr("bad_response"));
  delete chain.st.hooks.eth_call;
  const down = { ...cfg, client: createChain(RPC, { fetch: async () => { throw new TypeError("Failed to fetch"); }, backoffMs: 1, retries: 1 }) };
  await assert.rejects(readShop(down), shopErr("rpc", (e) => /Could not reach the LitVM Liteforge network/.test(e.message) && e.cause));
  await assert.rejects(phaseOf(down, 1), shopErr("rpc"));
  await assert.rejects(readDeck(down), shopErr("rpc"));
});

test("readDeck and readShutdownAt: the deck left (and printed), and the one-way shutdown time", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  assert.deepEqual(await readDeck(cfg), TEST_DECK.map((r) => [...r]));
  assert.deepEqual(await readDeck(cfg, "initial"), TEST_DECK.map((r) => [...r]));
  assert.equal(await readShutdownAt(cfg), 0);
  const { packId } = await buy(ctx);
  const opened = await open(ctx, packId);
  const left = await readDeck(cfg);
  assert.equal(deckSum(left), 72 - 5, "five cards left the deck");
  const taken = TEST_DECK.flat().map((n, c) => n - left.flat()[c]);
  const expected = Array(15).fill(0);
  opened.templateIds.forEach((t, i) => { expected[(t % 5) * 3 + opened.finishes[i] - 1]++; });   // fake templates: Kind = id % 5
  assert.deepEqual(taken, expected, "exactly the opened pack's Kind x Finish cells");
  assert.deepEqual(await readDeck(cfg, "initial"), TEST_DECK.map((r) => [...r]), "the print run never changes");
  assert.equal((await readShop(cfg)).cardsLeft, 67);
  chain.st.shutdownAt = 1_790_000_123;
  assert.equal(await readShutdownAt(cfg), 1_790_000_123);
  assert.equal(chain.methods("eth_call").filter((c) => c.params[0].data === "0x5758e705").length, 2);
});

test("phaseOf follows a pack through its life: Waiting -> Ready (by the round's time) -> Dealt -> Opened", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  assert.equal(await phaseOf(cfg, 1), PHASE.None);
  const { packId, round } = await buy(ctx);
  assert.equal(round, chain.currentRound() + 5, "bound to the round five ahead of the buy's own (the contract's rule, read from PackBought)");
  assert.equal(await phaseOf(cfg, packId), PHASE.Waiting);
  chain.st.now = roundTime(round) - 1;
  assert.equal(await phaseOf(cfg, packId), PHASE.Waiting, "one second before the round: still waiting");
  chain.st.now = roundTime(round);
  assert.equal(await phaseOf(cfg, packId), PHASE.Ready, "the round is due: fetch the signature and open");
  chain.keeperDeal();
  assert.equal(await phaseOf(cfg, packId), PHASE.Dealt, "a keeper fixed the cards");
  await open(ctx, packId);
  assert.equal(await phaseOf(cfg, packId), PHASE.Opened);
  assert.deepEqual(PHASE_NAMES, ["None", "Waiting", "Ready", "Dealt", "Opened", "Refunded"]);
  assert.deepEqual({ ...PHASE }, { None: 0, Waiting: 1, Ready: 2, Dealt: 3, Opened: 4, Refunded: 5 });
  assert.deepEqual({ ...FINISH }, { None: 0, Normal: 1, Shiny: 2, Gold: 3 });
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(31) + "09";
  await assert.rejects(phaseOf(cfg, packId), shopErr("bad_response", (e) => /unknown pack state \(9\)/.test(e.message)));
});

test("readPack: no cards while sealed, the dealt cards once fixed, the same cards once opened", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  const { packId, round } = await buy(ctx);
  const sealed = await readPack(cfg, packId);
  assert.deepEqual(sealed, { packId: "1", buyer: A, round, phase: PHASE.Waiting, phaseName: "Waiting", paid: PRICE, templateIds: [], finishes: [] });
  const [dealtLog] = chain.keeperDeal();
  const dealt = await readPack(cfg, packId);
  const ev = shopIface.parseLog(dealtLog);
  assert.equal(dealt.phase, PHASE.Dealt);
  assert.deepEqual(dealt.templateIds, ev.args.templateIds.map(Number), "what PackDealt announced");
  assert.deepEqual(dealt.finishes, ev.args.finishes.map(Number));
  assert.equal(dealt.templateIds.length, 5);
  assert.ok(dealt.finishes.every((f) => f >= 1 && f <= 3));
  const minted = await open(ctx, packId);
  const after = await readPack(cfg, packId);
  assert.equal(after.phaseName, "Opened");
  assert.deepEqual([after.templateIds, after.finishes], [minted.templateIds, minted.finishes], "a pack someone else opened can still be shown");
  const none = await readPack(cfg, 999);
  assert.deepEqual([none.buyer, none.phase, none.round], [ethers.ZeroAddress, PHASE.None, 0]);
  JSON.stringify({ ...after, paid: String(after.paid) });
  await assert.rejects(readPack(cfg, "abc"), AbiError);
});

test("pendingRounds: the pack's own round, plus every earlier undealt pack's (oldest first, distinct, unproven only)", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  chain.st.cfg.dailyLimit = 0;
  const a = await buy(ctx);
  const b = await buy(ctx);                          // same second: same round as a
  chain.advance(30);
  const c = await buy(ctx);
  assert.equal(a.round, b.round);
  assert.notEqual(c.round, a.round);
  assert.deepEqual(await pendingRounds(cfg, a.packId), [a.round]);
  assert.deepEqual(await pendingRounds(cfg, c.packId), [a.round, c.round], "opening c deals a and b first: purchase order");
  assert.deepEqual(await pendingRounds(cfg, c.packId, 1), [a.round], "at most max");
  assert.deepEqual(await pendingRounds(cfg, 999), [a.round, c.round], "past the last pack: everything pending");
  chain.proveRound(a.round);
  assert.deepEqual(await pendingRounds(cfg, c.packId), [c.round], "a proven round needs no signature");
  chain.keeperDeal();
  assert.deepEqual(await pendingRounds(cfg, c.packId), [], "dealt: nothing to prove");
  const call = chain.methods("eth_call").find((x) => x.params[0].data.startsWith("0x9e405606")).params[0];
  assert.equal(call.data, shopIface.encodeFunctionData("pendingRounds", [1n, BigInt(MAX_PROOFS)]), "asks for MAX_PROOFS by default");
  assert.equal(MAX_PROOFS, 16);
});

test("readTokens: [] until the pack is opened, then exactly the tokens PackOpened named, in slot order", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  assert.deepEqual(await readTokens(ctx.cfg, packId), []);
  const opened = await open(ctx, packId);
  assert.deepEqual(await readTokens(ctx.cfg, packId), opened.tokenIds);
  assert.ok((await readTokens(ctx.cfg, packId)).every((t) => typeof t === "string"), "decimal strings, like every token id here");
  assert.deepEqual(await readTokens(ctx.cfg, 999), []);
  const call = ctx.chain.methods("eth_call").at(-1).params[0];
  assert.equal(call.data, shopIface.encodeFunctionData("tokensOf", [999n]));
});

test("canMint: minter() names the StudioMinter, whose minters(shop) says whether the shop can still mint", async () => {
  const ctx = await setup();
  assert.equal(await canMint(ctx.cfg), true);
  ctx.chain.st.cfg.minter = false;
  assert.equal(await canMint(ctx.cfg), false);
  const asked = ctx.chain.methods("eth_call").slice(-2).map((c) => [c.params[0].to.toLowerCase(), c.params[0].data.slice(0, 10)]);
  assert.deepEqual(asked, [[SHOP.toLowerCase(), "0x07546172"], [MINTER.toLowerCase(), "0xf46eccc4"]]);
  ctx.chain.st.hooks.eth_call = ([tx]) => (tx.to.toLowerCase() === MINTER.toLowerCase() ? "0x" : undefined);
  await assert.rejects(canMint(ctx.cfg), shopErr("bad_response"), "a minter with no code is not an answer");
});

test("finishesOf: the finish of every token the shop minted, 0 for anything else, in order", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  const opened = await open(ctx, packId);
  assert.deepEqual(await finishesOf(ctx.cfg, opened.tokenIds), opened.finishes);
  assert.deepEqual(await finishesOf(ctx.cfg, [opened.tokenIds[2], "4294967296", 5n, opened.tokenIds[0]]), [opened.finishes[2], 0, 0, opened.finishes[0]]);
  ctx.chain.st.calls.length = 0;
  assert.deepEqual(await finishesOf(ctx.cfg, []), []);
  assert.equal(ctx.chain.st.calls.length, 0, "nothing to ask: no call");
  ctx.chain.st.hooks.eth_call = () => shopIface.encodeFunctionResult("finishesOf", [[1, 2]]);
  await assert.rejects(finishesOf(ctx.cfg, [1n, 2n, 3n]), shopErr("bad_response"), "an answer of the wrong length is not trusted");
});

test("refundableAt: nothing while the shop runs; after a shutdown, REFUND_GRACE past the later of it and the round", () => {
  const round = 21_615_404;
  assert.equal(refundableAt(round, 0), null);
  const rt = roundTime(round);
  assert.equal(REFUND_GRACE, 7 * 86400);
  assert.equal(refundableAt(round, rt + 100), rt + 100 + REFUND_GRACE, "shut down after the round");
  assert.equal(refundableAt(round, rt - 100), rt + REFUND_GRACE, "shut down before the round");
});

// ------------------------------------------------------------------ buyPack
test("buyPack: end to end, exact transaction, stages in order, decoded PackBought with its drand round", async () => {
  const ctx = await setup();
  const { chain, provider, cfg, wallet } = ctx;
  chain.st.receiptDelay = 3;
  const order = [];
  provider.once("eth_sendTransaction", (params) => { order.push("wallet"); return chain.sendTransaction(params[0]); });
  const stages = [];
  const result = await buyPack(wallet, cfg, { onStage: (s) => { order.push(s); stages.push(s); }, ...FAST });

  assert.deepEqual(Object.keys(result).sort(), ["packId", "round", "txHash"]);
  assert.equal(result.packId, "1");
  assert.equal(result.round, chain.currentRound() + 5);
  assert.equal(typeof result.round, "number");
  assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.deepEqual(order, ["signing", "wallet", "pending", "confirmed"], "signing is announced right before the wallet prompt, pending right after it");
  JSON.stringify(result);                                                    // survives JSON: no bigint anywhere

  const [tx] = chain.st.txs;
  assert.equal(tx.from, A);
  assert.equal(tx.to, SHOP);
  assert.equal(tx.data, shopIface.encodeFunctionData("buyPack"));
  assert.equal(tx.value, q(PRICE), "exactly the price");
  assert.equal(tx.gas, q(gasBump(180_000n)), "eth_estimateGas + 25%, passed explicitly");
  assert.equal(chain.methods("eth_getTransactionReceipt").length, 4, "polled until the receipt existed");
  assert.equal(chain.st.packs.get(1n).buyer, A);
  assert.equal(chain.balanceOf(ALICE), 10n * ETH - PRICE);
  assert.deepEqual(chain.methods("eth_estimateGas")[0].params, [{ from: A, to: SHOP, data: "0xc37b9bcd", value: q(PRICE) }]);
});

test("buyPack picks its own PackBought out of a busy receipt (other buyers, other contracts)", async () => {
  const ctx = await setup();
  const foreign = (address, buyer, id) => ({
    address, ...shopIface.encodeEventLog(shopIface.getEvent("PackBought"), [id, buyer, PRICE, 1234n]),
    blockNumber: q(1), transactionHash: "0x", logIndex: "0x0",
  });
  ctx.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => {
    const r = st.receipts.get(hash);
    if (!r) return undefined;
    return { ...r, logs: [foreign(SHOP.toLowerCase(), BOB, 77n), foreign(BOB.toLowerCase(), ALICE, 88n), ...r.logs] };
  };
  const { packId } = await buy(ctx);
  assert.equal(packId, "1", "not the other buyer's 77, not the other contract's 88");
});

test("buyPack fails loudly when the receipt has no PackBought", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => (st.receipts.has(hash) ? { ...st.receipts.get(hash), logs: [] } : undefined);
  await assert.rejects(buy(ctx), shopErr("bad_response", (e) => /PackBought event is missing/.test(e.message) && /^0x[0-9a-f]{64}$/.test(e.txHash)));
  const ctx2 = await setup();
  ctx2.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => {
    const r = st.receipts.get(hash);
    return r ? { ...r, logs: r.logs.map((l) => ({ ...l, data: "0x1234" })) } : undefined;
  };
  await assert.rejects(buy(ctx2), shopErr("bad_response", (e) => e.cause instanceof AbiError));
});

test("buyPack switches the network first (known chain, and a chain the wallet has never seen)", async () => {
  const known = await setup({ providerOpts: { chainId: 1 } });
  assert.equal(known.wallet.onCorrectChain, false);
  assert.equal((await buy(known)).packId, "1");
  assert.deepEqual(known.provider.methods("wallet_switchEthereumChain").map((c) => c.params), [[{ chainId: "0x1159" }]]);
  assert.equal(known.wallet.onCorrectChain, true);

  const unknown = await setup({ providerOpts: { chainId: 1, known: [1] } });
  assert.equal((await buy(unknown)).packId, "1");
  assert.equal(unknown.provider.methods("wallet_addEthereumChain").length, 1);
  assert.deepEqual(unknown.provider.methods("wallet_addEthereumChain")[0].params[0].rpcUrls, [RPC]);
  assert.equal(unknown.provider.chainId, 4441);

  const refuses = await setup({ providerOpts: { chainId: 1 } });
  refuses.provider.once("wallet_switchEthereumChain", providerError(4001, "User rejected the request."));
  await assert.rejects(buy(refuses), walletErr("user_rejected"));
  noTxSent(refuses);
  assert.deepEqual(refuses.chain.methods("eth_call"), [], "no shop reads before the network is right");
});

test("buyPack never sends when the wallet drifts to another network between the checks and the send", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_estimateGas = () => { ctx.provider.chainId = 1; return undefined; };
  await assert.rejects(buy(ctx), walletErr("wrong_chain", (e) => e.actual === 1 && /Switch/.test(e.message)));
  noTxSent(ctx);
});

test("buyPack pre-flight: not connected, no config, wrong chain in the wallet setup", async () => {
  const idle = await setup({ connect: false });
  await assert.rejects(buyPack(idle.wallet, idle.cfg), (e) => e instanceof WalletError && e.code === "not_connected");
  assert.equal(idle.chain.st.calls.length, 0);
  const ctx = await setup();
  await assert.rejects(buyPack(ctx.wallet, null), shopErr("not_configured"));
  await assert.rejects(buyPack(ctx.wallet, { ...ctx.cfg, packShop: undefined }), shopErr("not_configured"));
  await assert.rejects(buyPack(ctx.wallet, { ...ctx.cfg, chainId: 1 }), shopErr("not_configured", (e) => /chain 4441 but the shop lives on chain 1/.test(e.message)));
  await assert.rejects(buyPack(undefined, ctx.cfg), (e) => e.code === "not_connected");
  noTxSent(ctx);
});

test("buyPack pre-flight: paused, sold out, shut down and today's limit are explained before any prompt", async () => {
  for (const [patch, reason, message] of [
    [(st) => { st.cfg.paused = true; }, "EnforcedPause", /paused/i],
    [(st) => { st.packsSold = 14; }, "SoldOut", /Sold out/],
    [(st) => { st.shutdownAt = st.now - 5; }, "IsShutdown", /closed for good/],
    [(st) => { st.shutdownAt = st.now - 5; st.cfg.paused = true; }, "IsShutdown", /closed for good/],
  ]) {
    const ctx = await setup();
    patch(ctx.chain.st);
    await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === reason && message.test(e.message)), reason);
    noTxSent(ctx);
  }
  const ctx = await setup();
  ctx.chain.st.bought.set(A, 3);
  const stages = [];
  await assert.rejects(buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s) }), shopErr("unavailable", (e) => e.reason === "DailyLimitReached" && /midnight UTC/.test(e.message)));
  assert.deepEqual(stages, [], "no stage fired: the player never saw a wallet prompt");
  noTxSent(ctx);
  const day = await setup();
  for (let i = 1; i <= 3; i++) assert.equal((await buy(day)).packId, String(i));
  await assert.rejects(buy(day), shopErr("unavailable", (e) => e.reason === "DailyLimitReached"));
  assert.equal(day.chain.st.txs.length, 3);
});

test("buyPack: a shop that is not ready for another reason (deck not locked, no minting role) is named by the estimate", async () => {
  for (const [patch, reason, message] of [
    [(st) => { st.cfg.locked = false; }, "NotLocked", /not open yet/],
    [(st) => { st.cfg.minter = false; }, "NotMinter", /minting permission is missing/],
  ]) {
    const ctx = await setup();
    patch(ctx.chain.st);
    const stages = [];
    await assert.rejects(buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s) }), shopErr("unavailable", (e) => e.reason === reason && message.test(e.message)), reason);
    assert.deepEqual(stages, []);
    noTxSent(ctx);
  }
});

test("buyPack low balance: a friendly error with the faucet, the exact shortfall, and nothing sent", async () => {
  const ctx = await setup();
  ctx.chain.setBalance(ALICE, PRICE);                 // covers the pack, not the gas
  let err;
  try { await buyPack(ctx.wallet, ctx.cfg); } catch (e) { err = e; }
  assert.ok(err instanceof ShopError && err instanceof WalletError);
  assert.equal(err.code, "low_balance");
  assert.match(err.message, /faucet\.test\.invalid/);
  assert.match(err.message, /costs 0\.1 and network fees need about 0\.0051/);
  assert.match(err.message, /your wallet has 0\.1\./);
  assert.deepEqual([err.have, err.need, err.price, err.fees, err.faucet], [PRICE, PRICE + FEES, PRICE, FEES, FAUCET]);
  noTxSent(ctx);
  ctx.chain.setBalance(ALICE, 0n);
  await assert.rejects(buy(ctx), shopErr("low_balance", (e) => /your wallet has 0\. Get free test zkLTC/.test(e.message)));
});

test("buyPack low balance on a chain with no faucet (a local dev chain) offers no faucet, and never another network's", async () => {
  const ctx = await setup({ cfgExtra: { faucet: null, explorer: null } });
  ctx.chain.setBalance(ALICE, PRICE);
  await assert.rejects(buy(ctx), shopErr("low_balance", (e) => e.faucet === null && !/https?:/.test(e.message) && /Not enough zkLTC/.test(e.message)));
  noTxSent(ctx);
});

test("buyPack low balance: the boundary is price + reserved gas, to the wei", async () => {
  const ctx = await setup();
  ctx.chain.setBalance(ALICE, PRICE + FEES - 1n);
  await assert.rejects(buy(ctx), shopErr("low_balance"));
  noTxSent(ctx);
  ctx.chain.setBalance(ALICE, PRICE + FEES);
  assert.equal((await buy(ctx)).packId, "1");
  const pricey = await setup();
  pricey.chain.st.gasPrice = 10_000_000_000n;
  pricey.chain.setBalance(ALICE, PRICE + FEES);
  await assert.rejects(buy(pricey), shopErr("low_balance", (e) => e.fees === 12_600_000n * 10_000_000_000n * 2n));
});

test("buyPack falls back to a 1 gwei reserve (and says so) when eth_gasPrice itself fails", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_gasPrice = () => { throw rpcError(-32601, "no such method"); };
  ctx.chain.setBalance(ALICE, PRICE);
  const c = captureConsole();
  try {
    await assert.rejects(buy(ctx), shopErr("low_balance", (e) => e.fees === 12_600_000n * 1_000_000_000n * 2n));
  } finally { c.restore(); }
  assert.ok(c.logs.some(([m, msg]) => m === "warn" && /eth_gasPrice failed/.test(msg)));
});

test("buyPack: every gas estimate is bumped by 25%, rounded up, and passed as the gas limit", async () => {
  for (const est of [1n, 2n, 3n, 21_000n, 180_000n, 8_000_000n, 9_999_999n]) {
    const ctx = await setup();
    ctx.chain.st.estimate = () => est;
    await buy(ctx);
    const gas = BigInt(ctx.chain.st.txs[0].gas);
    assert.equal(gas, est + (est + 3n) / 4n, `estimate ${est}`);
  }
});

test("buyPack: the player refusing, or a pending prompt, leaves everything retryable", async () => {
  const ctx = await setup();
  const stages = [];
  ctx.provider.once("eth_sendTransaction", providerError(4001, "MetaMask Tx Signature: User denied transaction signature."));
  await assert.rejects(buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s), ...FAST }), (e) => e instanceof WalletError && e.code === "user_rejected" && /cancelled/i.test(e.message));
  assert.deepEqual(stages, ["signing"], "signing was announced, pending never was");
  ctx.provider.once("eth_sendTransaction", providerError(-32002, "Already processing eth_sendTransaction."));
  await assert.rejects(buy(ctx), walletErr("request_pending"));
  ctx.provider.once("eth_sendTransaction", providerError(-32000, "insufficient funds for gas * price + value"));
  await assert.rejects(buy(ctx), (e) => e.code === "low_balance" && /faucet\.test\.invalid/.test(e.message));
  assert.equal((await buy(ctx)).packId, "1", "the lock was released and the retry just works");
  assert.equal(ctx.chain.st.txs.length, 1);
});

test("buyPack: a double click cannot put two prompts in front of the player", async () => {
  const ctx = await setup();
  let release;
  ctx.provider.once("eth_sendTransaction", (params) => new Promise((resolve) => { release = () => resolve(ctx.chain.sendTransaction(params[0])); }));
  const first = buy(ctx);
  while (!release) await tick(1);
  await assert.rejects(buy(ctx), shopErr("busy", (e) => /already in progress/.test(e.message)));
  await assert.rejects(openPack(ctx.wallet, ctx.cfg, 1), shopErr("busy"), "one transaction at a time per wallet, of any kind");
  await assert.rejects(refundPack(ctx.wallet, ctx.cfg, 1), shopErr("busy"));
  release();
  assert.equal((await first).packId, "1");
  assert.equal(ctx.chain.st.txs.length, 1);
  assert.equal((await buy(ctx)).packId, "2", "free again afterwards");
});

test("buyPack: a reverted receipt is explained by replaying the transaction (custom error name)", async () => {
  const ctx = await setup();
  ctx.chain.st.failNext = { name: "DailyLimitReached" };
  await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === "DailyLimitReached" && /^0x[0-9a-f]{64}$/.test(e.txHash) && e.selector === "0xf402e5b1"));
  const sims = ctx.chain.methods("eth_call").filter((c) => c.params[0].data === "0xc37b9bcd");
  assert.equal(sims.length, 1, "the replay used one eth_call");
  assert.equal(sims[0].params[0].from, A);
  assert.equal(sims[0].params[0].value, q(PRICE), "with the same value");
  assert.equal(sims[0].params[1], q(BigInt(ctx.chain.st.l2Block) - 1n), "at the block before the failed one");
});

test("a failed transaction falls back to the latest state when historic state is pruned, then to out-of-gas, then to 'unknown'", async () => {
  const pruned = await setup();
  pruned.chain.st.failNext = { name: "WrongPayment" };
  pruned.chain.st.hooks.eth_call = ([tx, tag]) => { if (tag !== "latest" && tx.data === "0xc37b9bcd") throw rpcError(-32000, "missing trie node abc (path )"); };
  await assert.rejects(buy(pruned), shopErr("unavailable", (e) => e.reason === "WrongPayment"));
  assert.deepEqual(pruned.chain.methods("eth_call").filter((c) => c.params[0].data === "0xc37b9bcd").map((c) => c.params[1] === "latest"), [false, true]);
  const oog = await setup();
  oog.chain.st.failNext = { outOfGas: true };
  await assert.rejects(buy(oog), shopErr("reverted", (e) => e.reason === "OutOfGas" && /ran out of gas/.test(e.message) && e.txHash));
  const mystery = await setup();
  mystery.chain.st.failNext = {};
  await assert.rejects(buy(mystery), shopErr("reverted", (e) => e.reason === null && /reason the shop could not read/.test(e.message) && e.txHash));
});

test("buyPack: a revert at the estimate stage (state moved since the checks) is explained before any prompt", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_estimateGas = () => { throw revertRpcError("WrongPayment"); };
  await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === "WrongPayment" && /price just changed/.test(e.message)));
  ctx.chain.st.hooks.eth_estimateGas = () => { throw revertRpcError("SoldOut"); };
  await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === "SoldOut"), "the last pack went to someone else a moment ago");
  ctx.chain.st.hooks.eth_estimateGas = () => { throw rpcError(-32000, "execution reverted"); };
  await assert.rejects(buy(ctx), shopErr("reverted", (e) => e.reason === null));
  ctx.chain.st.hooks.eth_estimateGas = () => { throw rpcError(3, "execution reverted: sold out", "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["sold out"]).slice(2)); };
  await assert.rejects(buy(ctx), shopErr("reverted", (e) => e.reason === "Error" && /sold out/.test(e.message)));
  noTxSent(ctx);
});

test("buyPack: waiting for the receipt can time out or be abandoned, and the transaction hash survives both", async () => {
  const slow = await setup();
  slow.chain.st.receiptDelay = 1e9;
  const stages = [];
  await assert.rejects(
    buyPack(slow.wallet, slow.cfg, { onStage: (s) => stages.push(s), pollMs: 2, timeoutMs: 40 }),
    shopErr("timeout", (e) => /^0x[0-9a-f]{64}$/.test(e.txHash) && /may still go through/.test(e.message) && e.cause?.timeout),
  );
  assert.deepEqual(stages, ["signing", "pending"]);
  const gone = await setup();
  gone.chain.st.receiptDelay = 1e9;
  const ctl = new AbortController();
  const p = buy(gone, { signal: ctl.signal, timeoutMs: 60_000 });
  while (gone.chain.methods("eth_getTransactionReceipt").length < 2) await tick(1);
  ctl.abort();
  await assert.rejects(p, shopErr("aborted", (e) => /^0x[0-9a-f]{64}$/.test(e.txHash) && /already sent/.test(e.message)));
});

test("onStage callbacks that throw cannot derail a purchase or an open", async () => {
  const ctx = await setup();
  const c = captureConsole();
  try {
    const r = await buyPack(ctx.wallet, ctx.cfg, { onStage() { throw new Error("UI bug"); }, ...FAST });
    const opened = await open(ctx, r.packId, { onStage() { throw new Error("UI bug"); } });
    assert.equal(opened.tokenIds.length, 5);
  } finally { c.restore(); }
  assert.ok(c.logs.filter(([m, msg]) => m === "error" && /callback threw/.test(msg)).length >= 6, "every throw was logged, none swallowed");
});

// ------------------------------------------------------------------ openPack
test("openPack: end to end - proves the pack's round, deals it, mints five cards with their finishes", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const bought = await buy(ctx);
  chain.st.now = roundTime(bought.round);
  const rounds = await pendingRounds(cfg, bought.packId);
  assert.deepEqual(rounds, [bought.round]);
  const stages = [];
  chain.st.receiptDelay = 2;
  const opened = await openPack(wallet, cfg, bought.packId, { rounds, signatures: rounds.map(sigFor), onStage: (s) => stages.push(s), ...FAST });
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.deepEqual(Object.keys(opened).sort(), ["finishes", "templateIds", "tokenIds", "txHash"]);
  const base = 7n << 32n;
  assert.deepEqual(opened.tokenIds, [0n, 1n, 2n, 3n, 4n].map((i) => String(base + i)));
  assert.equal(opened.templateIds.length, 5);
  assert.ok(opened.templateIds.every((t) => Number.isInteger(t) && t >= 0 && t < 12));
  assert.ok(opened.finishes.every((f) => [FINISH.Normal, FINISH.Shiny, FINISH.Gold].includes(f)));
  const log = chain.st.logs.find((l) => l.topics[0] === TOPICS.PackOpened);
  const ev = shopIface.parseLog(log);
  assert.deepEqual([opened.templateIds, opened.finishes], [ev.args.templateIds.map(Number), ev.args.finishes.map(Number)], "exactly what PackOpened says, slot by slot");
  JSON.stringify(opened);

  const tx = chain.st.txs.at(-1);
  assert.equal(tx.to, SHOP);
  assert.equal(tx.from, A);
  assert.equal(tx.data, shopIface.encodeFunctionData("openPack", [1n, [BigInt(bought.round)], [sigFor(bought.round)]]));
  assert.equal(tx.value, undefined, "opening is free");
  assert.equal(tx.gas, q(gasBump(4_500_000n + 251_000n + 42_000n)), "the estimate (one proof, one deal, five mints) + 25%");
  assert.equal(await phaseOf(cfg, bought.packId), PHASE.Opened);
  assert.ok(chain.st.proven.has(BigInt(bought.round)), "the round is proven on the registry for everyone after");
});

test("openPack deals strictly in purchase order: a later pack's open fixes an earlier pack's cards too", async () => {
  const alice = await setup();
  const { chain, cfg } = alice;
  const a = await buy(alice);
  chain.advance(30);
  chain.setBalance(BOB, 10n * ETH);
  const bobWallet = createWallet({ provider: createMockProvider({ chain, accounts: [BOB] }), storage: memoryStorage(), chain: chainFromConfig(cfg) });
  await bobWallet.connect();
  const b = await buyPack(bobWallet, cfg, FAST);
  chain.st.now = roundTime(b.round);
  const rounds = await pendingRounds(cfg, b.packId);
  assert.deepEqual(rounds, [a.round, b.round], "Bob's open needs Alice's round too");
  await openPack(bobWallet, cfg, b.packId, { rounds, signatures: rounds.map(sigFor), ...FAST });
  assert.equal(await phaseOf(cfg, a.packId), PHASE.Dealt, "Alice's pack is dealt (cards fixed) but not minted");
  const fixed = await readPack(cfg, a.packId);
  assert.deepEqual(await pendingRounds(cfg, a.packId), [], "and needs no proof any more");
  const mine = await openPack(alice.wallet, cfg, a.packId, FAST);
  assert.deepEqual([mine.templateIds, mine.finishes], [fixed.templateIds, fixed.finishes], "she gets exactly the dealt cards");
  assert.equal(alice.chain.st.txs.at(-1).data, shopIface.encodeFunctionData("openPack", [BigInt(a.packId), [], []]), "no proofs carried");
});

test("openPack tries a pack that is still Waiting by block.timestamp: the proof does not care about the chain's clock", async () => {
  const ctx = await setup();
  const { packId, round } = await buy(ctx);
  assert.equal(await phaseOf(ctx.cfg, packId), PHASE.Waiting);
  const opened = await openPack(ctx.wallet, ctx.cfg, packId, { rounds: [round], signatures: [sigFor(round)], ...FAST });
  assert.equal(opened.tokenIds.length, 5);
});

test("openPack: a pack that is gone is explained without troubling the wallet", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const stages = [];
  const attempt = (id) => openPack(wallet, cfg, id, { onStage: (s) => stages.push(s), ...FAST });
  await assert.rejects(attempt(999), shopErr("pack_none", (e) => /does not exist/.test(e.message)));
  const p = await buy(ctx);
  await open(ctx, p.packId);
  await assert.rejects(attempt(p.packId), shopErr("pack_opened", (e) => e.phase === 4 && /cards are in your wallet/.test(e.message)));
  const r = await buy(ctx);
  chain.st.shutdownAt = chain.st.now;
  chain.advance(REFUND_GRACE + 60);
  await refundPack(wallet, cfg, r.packId, FAST);
  await assert.rejects(attempt(r.packId), shopErr("pack_refunded"));
  assert.equal(chain.st.txs.length, 4, "buy, open, buy, refund: none of the refused attempts sent a transaction");
  assert.deepEqual(stages, []);
});

test("openPack: reverts are named at the estimate - a missing proof (BeaconMissing, with its round) and a refused signature", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const { packId, round } = await buy(ctx);
  chain.st.now = roundTime(round);
  const stages = [];
  await assert.rejects(openPack(wallet, cfg, packId, { onStage: (s) => stages.push(s) }),
    shopErr("reverted", (e) => e.reason === "BeaconMissing" && e.round === round && new RegExp(`round ${round}`).test(e.message) && /Nothing was changed/.test(e.message)));
  const wrong = "0x" + "11".repeat(64);
  await assert.rejects(openPack(wallet, cfg, packId, { rounds: [round], signatures: [wrong] }),
    shopErr("reverted", (e) => e.reason === "Error" && /refused a drand signature/.test(e.message)));
  assert.deepEqual(stages, []);
  assert.equal(chain.st.txs.length, 1, "only the purchase: both refusals came from the estimate");
  // shapes the contract would reject are refused before any request
  chain.st.calls.length = 0;
  for (const bad of [{ rounds: [round], signatures: [] }, { rounds: [0], signatures: [sigFor(1)] }, { rounds: [round], signatures: ["0x1234"] }, { rounds: "1", signatures: [] }]) {
    await assert.rejects(openPack(wallet, cfg, packId, bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(chain.st.calls.length, 0);
});

test("openPack: opened by someone else between the estimate and the send - the receipt fails, the replay says NotDealt", async () => {
  const ctx = await setup();
  const { packId, round } = await buy(ctx);
  ctx.chain.st.now = roundTime(round);
  ctx.chain.st.failNext = { name: "NotDealt" };
  await assert.rejects(openPack(ctx.wallet, ctx.cfg, packId, { rounds: [round], signatures: [sigFor(round)], ...FAST }),
    shopErr("reverted", (e) => e.reason === "NotDealt" && /already been opened or refunded/.test(e.message) && /^0x[0-9a-f]{64}$/.test(e.txHash)));
});

test("openPack: the receipt must carry this pack's PackOpened", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => {
    const r = st.receipts.get(hash);
    if (!r) return undefined;
    const wrong = { ...r.logs[0], ...shopIface.encodeEventLog(shopIface.getEvent("PackOpened"), [55n, ALICE, [1n], [1], [1]]) };
    return { ...r, logs: r.logs.map(() => wrong) };
  };
  await assert.rejects(open(ctx, packId), shopErr("bad_response", (e) => /PackOpened event is missing/.test(e.message)));
});

test("openPack: anyone may open a pack, the cards belong to the buyer", async () => {
  const alice = await setup();
  const { packId } = await buy(alice);
  alice.chain.setBalance(BOB, 10n * ETH);
  const bob = createWallet({ provider: createMockProvider({ chain: alice.chain, accounts: [BOB] }), storage: memoryStorage(), chain: chainFromConfig(alice.cfg) });
  await bob.connect();
  const opened = await open(alice, packId, {}, bob);
  assert.equal(opened.tokenIds.length, 5);
  const log = alice.chain.st.logs.find((l) => l.topics[0] === TOPICS.PackOpened);
  assert.equal(ethers.getAddress("0x" + log.topics[2].slice(26)), ALICE, "PackOpened names the buyer");
  assert.equal(alice.chain.st.txs.at(-1).from, BOB.toLowerCase());
});

test("openPack passes eth_estimateGas + 25% for a range of estimates", async () => {
  for (const est of [4_800_000n, 7_400_000n, 10_000_000n, 10_000_001n]) {
    const ctx = await setup();
    const { packId } = await buy(ctx);
    ctx.chain.st.estimate = () => est;
    await open(ctx, packId);
    assert.equal(BigInt(ctx.chain.st.txs.at(-1).gas), gasBump(est));
  }
});

test("openPack accepts the pack id as a string, number or bigint, and keeps huge token ids exact", async () => {
  for (const idOf of [(id) => id, (id) => Number(id), (id) => BigInt(id)]) {
    const ctx = await setup();
    const { packId } = await buy(ctx);
    ctx.chain.st.tokenCounter = 2n ** 200n;
    const opened = await open(ctx, idOf(packId));
    assert.equal(opened.tokenIds[0], String((7n << 32n) + 2n ** 200n), "beyond 2^53: decimal strings never lose a digit");
    assert.equal(opened.tokenIds[4], String((7n << 32n) + 2n ** 200n + 4n));
  }
  const ctx = await setup();
  for (const bad of ["abc", -1, 1.5, null, undefined, {}, "0x"]) {
    await assert.rejects(openPack(ctx.wallet, ctx.cfg, bad, FAST), AbiError, String(bad));
  }
  noTxSent(ctx);
});

test("buyPack binds past the newest round already proven when the chain's clock lags drand", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  const ahead = chain.currentRound() + 40;                    // a round some open proved: drand is 2 minutes past block.timestamp
  chain.proveRound(ahead);
  const { round } = await buy(ctx);
  assert.equal(round, ahead + 5, "never a round that is already public");
  assert.deepEqual(await pendingRounds(cfg, 1), [round]);
});

test("openPack refuses, before any prompt, an open whose estimate is over OPEN_GAS_CAP (deal the backlog first)", async () => {
  const ctx = await setup();
  const { packId, round } = await buy(ctx);
  assert.equal(OPEN_GAS_CAP, 25_000_000n);
  assert.ok(OPEN_GAS_CAP + OPEN_GAS_CAP / 4n < 32_000_000n, "the cap plus our 25% headroom stays under the chain's 32M");
  ctx.chain.st.estimate = () => 26_000_000n;
  const stages = [];
  await assert.rejects(openPack(ctx.wallet, ctx.cfg, packId, { rounds: [round], signatures: [sigFor(round)], onStage: (s) => stages.push(s) }),
    shopErr("too_much_gas", (e) => e.estimate === 26_000_000n && /Nothing was signed/.test(e.message)));
  assert.deepEqual(stages, []);
  assert.equal(ctx.chain.st.txs.length, 1, "only the purchase");
  const opened = await openPack(ctx.wallet, ctx.cfg, packId, { rounds: [round], signatures: [sigFor(round)], maxGas: 30_000_000n, ...FAST });
  assert.equal(opened.tokenIds.length, 5, "a caller may raise the cap");
});

test("dealPacks: deal(maxPacks, rounds, signatures) proves the rounds and deals up to maxPacks packs, in order", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.st.cfg.dailyLimit = 0;
  const a = await buy(ctx);
  const b = await buy(ctx);
  chain.advance(30);
  const c = await buy(ctx);
  chain.st.now = roundTime(c.round);
  const r = await dealPacks(wallet, cfg, 1, [a.round, c.round], [sigFor(a.round), sigFor(c.round)], FAST);
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(r.dealt, ["1"], "maxPacks bounds the work");
  assert.equal(chain.st.txs.at(-1).data, shopIface.encodeFunctionData("deal", [1n, [BigInt(a.round), BigInt(c.round)], [sigFor(a.round), sigFor(c.round)]]));
  assert.equal(chain.st.txs.at(-1).value, undefined, "no money moves");
  assert.deepEqual(await pendingRounds(cfg, c.packId), [], "both rounds proven");
  assert.deepEqual((await dealPacks(wallet, cfg, DEAL_PACKS, [], [], FAST)).dealt, ["2", "3"], "the rest, with nothing left to prove");
  assert.equal(await phaseOf(cfg, c.packId), PHASE.Dealt, "cards fixed, not minted: the open does that");
  assert.equal((await openPack(wallet, cfg, c.packId, FAST)).tokenIds.length, 5);
  await assert.rejects(dealPacks(wallet, cfg, 0, [], []), TypeError);
  await assert.rejects(dealPacks(wallet, cfg, 1, [c.round + 100], ["0x" + "22".repeat(64)], FAST), shopErr("reverted", (e) => /refused a drand signature/.test(e.message)));
  assert.equal(DEAL_ROUNDS, 12);
});

// ------------------------------------------------------------------ refundPack (only after an owner shutdown, buyer only)
test("refundPack: no refund while the shop runs, none for someone else's pack, none before the grace after a shutdown", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const { packId } = await buy(ctx);
  chain.advance(60 * 86400);
  await assert.rejects(refundPack(wallet, cfg, packId, FAST), shopErr("reverted", (e) => e.reason === "NotRefundable" && /no refunds while the shop runs/.test(e.message) && /Open it/.test(e.message)));
  chain.st.shutdownAt = chain.st.now;
  chain.setBalance(BOB, 10n * ETH);
  const bob = createWallet({ provider: createMockProvider({ chain, accounts: [BOB] }), storage: memoryStorage(), chain: chainFromConfig(cfg) });
  await bob.connect();
  chain.advance(REFUND_GRACE + 60);
  await assert.rejects(refundPack(bob, cfg, packId, FAST), shopErr("reverted", (e) => e.reason === "NotRefundable" && /Only the wallet that bought/.test(e.message)));
  assert.equal(chain.st.txs.length, 1, "refused without sending");
  chain.st.shutdownAt = chain.st.now;                  // a later shutdown: its grace has not passed yet
  await assert.rejects(refundPack(wallet, cfg, packId, FAST), shopErr("reverted", (e) => e.reason === "NotRefundable" && /delivered instead/.test(e.message)), "the estimate says not yet");
  assert.equal(chain.st.txs.length, 1);
});

test("refundPack: only a pack that cannot be delivered - sealed with its round unproven, or dealt once minting is gone", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.st.cfg.dailyLimit = 0;
  const dealt = await buy(ctx);
  const opened = await buy(ctx);
  await open(ctx, opened.packId);                     // deals both, mints the second
  chain.advance(30);
  const proven = await buy(ctx);                      // its round gets proven (a keeper), but it is not dealt
  chain.proveRound(proven.round);
  chain.advance(30);
  const sealed = await buy(ctx);                      // its round never proven
  chain.st.shutdownAt = chain.st.now;
  chain.advance(REFUND_GRACE + 60);
  const deliverable = shopErr("reverted", (e) => e.reason === "NotRefundable" && /delivered instead/.test(e.message));
  await assert.rejects(refundPack(wallet, cfg, proven.packId, FAST), deliverable, "its cards are decided: it is delivered, not refunded");
  await assert.rejects(refundPack(wallet, cfg, dealt.packId, FAST), deliverable, "the shop can still mint it");
  const before = chain.balanceOf(ALICE);
  const stages = [];
  const r = await refundPack(wallet, cfg, sealed.packId, { onStage: (s) => stages.push(s), ...FAST });
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.equal(r.amount, PRICE);
  assert.equal(chain.st.txs.at(-1).data, shopIface.encodeFunctionData("refund", [BigInt(sealed.packId)]));
  assert.equal(chain.st.txs.at(-1).gas, q(gasBump(90_000n)));
  assert.equal(chain.balanceOf(ALICE), before + PRICE);
  assert.equal(await phaseOf(cfg, sealed.packId), PHASE.Refunded);
  chain.st.cfg.minter = false;                        // the shop lost its minting role: a dealt pack can no longer be delivered
  assert.equal((await refundPack(wallet, cfg, dealt.packId, FAST)).amount, PRICE);
  await assert.rejects(refundPack(wallet, cfg, opened.packId, FAST), shopErr("pack_opened", (e) => /nothing to refund/.test(e.message)));
  await assert.rejects(refundPack(wallet, cfg, dealt.packId, FAST), shopErr("pack_refunded"));
  await assert.rejects(refundPack(wallet, cfg, 404, FAST), shopErr("pack_none"));
});

test("a pack refunded while sealed is still drawn in its turn, stays Refunded, and its discarded cards are never shown", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.st.cfg.dailyLimit = 0;
  const refunded = await buy(ctx);
  chain.advance(30);
  const later = await buy(ctx);
  chain.st.shutdownAt = chain.st.now;
  chain.advance(REFUND_GRACE + 60);
  await refundPack(wallet, cfg, refunded.packId, FAST);
  assert.deepEqual(await pendingRounds(cfg, later.packId), [refunded.round, later.round], "the refunded pack's round is still needed: it is drawn first");
  await open(ctx, later.packId);
  const dealtLogs = chain.st.logs.filter((l) => l.topics[0] === TOPICS.PackDealt).map((l) => shopIface.parseLog(l).args.packId);
  assert.deepEqual(dealtLogs, [1n, 2n], "PackDealt for the refunded pack too: its cards left the deck");
  const p = await readPack(cfg, refunded.packId);
  assert.deepEqual([p.phaseName, p.templateIds, p.finishes], ["Refunded", [], []], "packOf shows no cards for it");
  assert.deepEqual((await findMyPacks(cfg, ALICE)).map((x) => x.phaseName), ["Refunded", "Opened"]);
  await assert.rejects(openPack(wallet, cfg, refunded.packId, FAST), shopErr("pack_refunded"));
});

// ------------------------------------------------------------------ findMyPacks (one eth_call to the contract's per-buyer index)
test("findMyPacks: this buyer's packs after a reload, oldest first, with their phase and drand round", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.setBalance(BOB, 10n * ETH);
  const bob = createWallet({ provider: createMockProvider({ chain, accounts: [BOB] }), storage: memoryStorage(), chain: chainFromConfig(cfg) });
  await bob.connect();
  const a1 = await buy(ctx);                                  // ALICE #1: will be opened
  const b1 = await buyPack(bob, cfg, FAST);                    // BOB #2
  await open(ctx, a1.packId);
  chain.advance(30);
  const a2 = await buy(ctx);                                  // ALICE #3: still waiting
  assert.deepEqual([a1.packId, b1.packId, a2.packId], ["1", "2", "3"]);
  const mine = await findMyPacks(cfg, ALICE);
  assert.deepEqual(mine, [
    { packId: "1", phase: PHASE.Opened, phaseName: "Opened", round: a1.round },
    { packId: "3", phase: PHASE.Waiting, phaseName: "Waiting", round: a2.round },
  ]);
  assert.ok(mine.every((p) => typeof p.packId === "string" && typeof p.round === "number"));
  JSON.stringify(mine);
  assert.deepEqual((await findMyPacks(cfg, BOB)).map((p) => [p.packId, p.phaseName]), [["2", "Ready"]], "opening pack 1 deals only up to pack 1: Bob's comes after it");
  assert.deepEqual(await findMyPacks(cfg, "0x" + "11".repeat(20)), []);
  assert.deepEqual((await findMyPacks(cfg, ALICE.toLowerCase())).map((p) => p.packId), ["1", "3"], "any address casing");
});

test("findMyPacks is ONE eth_call to recentPacks(address, 16): no log scan, no block numbers, no per-pack lookups, no wallet", async () => {
  const ctx = await setup();
  for (let i = 0; i < 3; i++) await buy(ctx);
  ctx.chain.st.calls.length = 0;
  ctx.provider.calls.length = 0;
  assert.equal((await findMyPacks(ctx.cfg, ALICE)).length, 3);
  assert.equal(ctx.chain.st.calls.length, 1, "exactly one JSON-RPC request, however many packs");
  const [call] = ctx.chain.st.calls;
  assert.deepEqual(call.params, [{ to: SHOP, data: shopIface.encodeFunctionData("recentPacks", [ALICE, 16]) }, "latest"]);
  for (const m of ["eth_getLogs", "eth_blockNumber", "eth_getBlockByNumber"]) assert.equal(ctx.chain.methods(m).length, 0, m);
  assert.equal(ctx.provider.calls.length, 0, "reads never touch the wallet");
});

test("findMyPacks reports every phase the contract has", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.st.cfg.dailyLimit = 0;
  const p1 = await buy(ctx);                     // -> Refunded (after the shutdown below)
  const p2 = await buy(ctx);                     // -> Opened
  await open(ctx, p2.packId);                    // deals 1 and 2, mints 2
  chain.advance(30);
  const p3 = await buy(ctx);                     // -> Dealt
  chain.keeperDeal();
  chain.advance(30);
  const p4 = await buy(ctx);                     // -> Ready
  chain.st.now = roundTime(p4.round) + 2;
  await buy(ctx);                                // -> Waiting
  chain.st.shutdownAt = chain.st.now;
  chain.advance(REFUND_GRACE + 10);
  chain.st.cfg.minter = false;                   // a dealt pack is refundable only once the shop cannot mint it
  await refundPack(wallet, cfg, p1.packId, FAST);
  chain.st.now = roundTime(p4.round) + 2;        // back to before the second-to-last round for the Ready / Waiting split
  const packs = await findMyPacks(cfg, ALICE);
  assert.deepEqual(packs.map((p) => [p.packId, p.phaseName]), [["1", "Refunded"], ["2", "Opened"], ["3", "Dealt"], ["4", "Ready"], ["5", "Waiting"]]);
  assert.deepEqual(packs.filter((p) => [PHASE.Waiting, PHASE.Ready, PHASE.Dealt].includes(p.phase)).map((p) => p.packId), ["3", "4", "5"], "what a page resumes");
  assert.equal(p3.packId, "3");
});

test("findMyPacks: none, exactly 16, and more than 16 (the newest 16, oldest first)", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  chain.st.cfg.dailyLimit = 0;
  chain.st.deckInitial = [[200, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];    // 40 packs to sell
  assert.deepEqual(await findMyPacks(cfg, ALICE), [], "a buyer with no packs");
  for (let i = 0; i < 16; i++) await buy(ctx);
  assert.deepEqual((await findMyPacks(cfg, ALICE)).map((p) => p.packId), Array.from({ length: 16 }, (_, i) => String(i + 1)));
  for (let i = 0; i < 4; i++) await buy(ctx);
  const packs = await findMyPacks(cfg, ALICE);
  assert.deepEqual(packs.map((p) => p.packId), Array.from({ length: 16 }, (_, i) => String(i + 5)), "the newest 16 (5..20), oldest first");
});

test("findMyPacks: every failure is reported, never a partial answer", async () => {
  const ctx = await setup();
  await buy(ctx);
  const { chain, cfg } = ctx;
  const answer = (h) => { chain.st.hooks.eth_call = ([tx]) => (tx.data.startsWith("0xd3ee9e8d") ? h : undefined); };
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  answer("0x1234");
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response", (e) => e.cause instanceof AbiError));
  answer("0x" + w(0x60) + w(0x80) + w(0xa0) + w(2) + w(0) + w(0));
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response", (e) => /differ in length/.test(e.cause?.message)));
  answer(shopIface.encodeFunctionResult("recentPacks", [[1n], [9], [5n]]));
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response", (e) => /unknown pack state \(9\)/.test(e.message)));
  answer(shopIface.encodeFunctionResult("recentPacks", [[1n, 2n], [1, 6], [5n, 6n]]));
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response"), "one good entry does not rescue a bad one");
  answer(shopIface.encodeFunctionResult("recentPacks", [[1n], [1], [2n ** 60n]]));
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response"), "a round past 2^53 is not a real answer");
  delete chain.st.hooks.eth_call;
  await assert.rejects(findMyPacks({ ...cfg, packShop: BOB }, ALICE), shopErr("not_configured", (e) => /not found on this network/.test(e.message)));
  chain.st.hooks.eth_call = ([tx]) => { if (tx.data.startsWith("0xd3ee9e8d")) throw revertRpcError("ReentrancyGuardReentrantCall"); };
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("reverted", (e) => e.reason === "ReentrancyGuardReentrantCall"));
  delete chain.st.hooks.eth_call;
  const down = { ...cfg, client: createChain(RPC, { fetch: async () => { throw new TypeError("Failed to fetch"); }, backoffMs: 1, retries: 1 }) };
  await assert.rejects(findMyPacks(down, ALICE), shopErr("rpc", (e) => /Could not reach the LitVM Liteforge network/.test(e.message)));
});

test("findMyPacks validates its input and passes call options (the abort signal) through", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  chain.st.calls.length = 0;
  for (const bad of ["nope", "0x1234", undefined, null, 5]) {
    await assert.rejects(findMyPacks(cfg, bad), TypeError, String(bad));
  }
  await assert.rejects(findMyPacks(null, ALICE), shopErr("not_configured"));
  assert.equal(chain.st.calls.length, 0, "nothing was sent for bad input");
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(findMyPacks(cfg, ALICE, { signal: ctl.signal }), shopErr("aborted"));
  assert.equal(chain.st.calls.length, 0, "an aborted call never leaves");
});

// ------------------------------------------------------------------ formatZkltc
test("formatZkltc: display rules for wei amounts", () => {
  const table = [
    [0n, undefined, undefined, "0"],
    [10n ** 18n, undefined, undefined, "1"],
    [10n ** 17n, undefined, undefined, "0.1"],
    [ETH * 12345n / 10n, undefined, undefined, "1234.5"],
    [123456789012345678n, undefined, undefined, "0.1235"],
    [123456789012345678n, 4, "floor", "0.1234"],
    [123456789012345678n, 4, "ceil", "0.1235"],
    [123450000000000000n, 4, "ceil", "0.1235"],
    [123450000000000000n, 4, "nearest", "0.1235"],
    [123449999999999999n, 4, "nearest", "0.1234"],
    [5n * 10n ** 13n, 4, "nearest", "0.0001"],
    [49_999_999_999_999n, 4, "nearest", "<0.0001"],
    [49_999_999_999_999n, 4, "floor", "<0.0001"],
    [49_999_999_999_999n, 4, "ceil", "0.0001"],
    [1n, undefined, undefined, "<0.0001"],
    [1n, 18, undefined, "0.000000000000000001"],
    [10n ** 18n, 0, undefined, "1"],
    [5n * 10n ** 17n, 0, "nearest", "1"],
    [5n * 10n ** 17n, 0, "floor", "<1"],
    [12345678901234567890123n, 4, undefined, "12345.6789"],
    [999999999999999999n, 4, "nearest", "1"],
    [999999999999999999n, 4, "floor", "0.9999"],
    [-(10n ** 17n), undefined, undefined, "-0.1"],
    [-1n, undefined, undefined, "-<0.0001"],
    [1_000_000_000_000_000, undefined, undefined, "0.001"],
    ["100000000000000000", undefined, undefined, "0.1"],
    ["0x16345785d8a0000", undefined, undefined, "0.1"],
    [10n ** 17n, 99, undefined, "0.1"],
    [10n ** 18n, -3, undefined, "1"],
    [10n ** 17n, -3, undefined, "<1"],
    [123456789012345678n, 2, "ceil", "0.13"],
  ];
  for (const [wei, digits, mode, expected] of table) {
    assert.equal(formatZkltc(wei, digits, mode), expected, `${String(wei)} digits=${digits} mode=${mode}`);
  }
  assert.throws(() => formatZkltc(1.5), AbiError);
  assert.throws(() => formatZkltc("banana"), AbiError);
  assert.throws(() => formatZkltc(undefined), AbiError);
});

test("formatZkltc: floor never overstates, ceil never understates, nearest is within half a unit (property check)", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 400; i++) {
    const wei = BigInt(Math.floor(rnd() * 1e15)) * BigInt(Math.floor(rnd() * 1e4) + 1) + BigInt(Math.floor(rnd() * 1e6));
    const digits = Math.floor(rnd() * 7);
    const parse = (s) => (s.startsWith("<") ? null : ethers.parseUnits(s, 18));
    const lo = parse(formatZkltc(wei, digits, "floor")), hi = parse(formatZkltc(wei, digits, "ceil")), mid = parse(formatZkltc(wei, digits, "nearest"));
    const unit = 10n ** BigInt(18 - digits);
    if (lo !== null) assert.ok(lo <= wei && wei - lo < unit, `floor ${wei} ${digits}`);
    if (hi !== null) assert.ok(hi >= wei && hi - wei < unit, `ceil ${wei} ${digits}`);
    if (mid !== null) assert.ok((mid > wei ? mid - wei : wei - mid) * 2n <= unit, `nearest ${wei} ${digits}`);
  }
});

// ------------------------------------------------------------------ network fee caps (live bug, Liteforge 2026-10-02)
// A real wallet bid maxFeePerGas 10000000 (the chain's floor) against a base fee of 10009000 and the second signature of a
// pack failed. The client now passes explicit caps (2x the gas price) instead of leaving the fee to the wallet.
test("buyPack and openPack pass explicit EIP-1559 caps: 2x the gas price and the node's tip", async () => {
  const ctx = await setup();
  ctx.chain.st.gasPrice = 10_386_000n;
  ctx.chain.st.hooks.eth_maxPriorityFeePerGas = () => q(0);
  const { packId } = await buy(ctx);
  assert.equal(ctx.chain.st.txs[0].maxFeePerGas, q(2n * 10_386_000n));
  assert.equal(ctx.chain.st.txs[0].maxPriorityFeePerGas, "0x0");
  await open(ctx, packId);
  assert.equal(ctx.chain.st.txs[1].maxFeePerGas, q(2n * 10_386_000n));
  assert.equal(ctx.chain.st.txs[1].maxPriorityFeePerGas, "0x0");
});

test("a node without eth_maxPriorityFeePerGas still gets a cap and a zero tip", async () => {
  const ctx = await setup();
  await buy(ctx);
  const t = ctx.chain.st.txs[0];
  assert.equal(t.maxPriorityFeePerGas, "0x0");
  assert.equal(t.maxFeePerGas, q(2n * ctx.chain.st.gasPrice));
});

test("the tip never exceeds the cap", async () => {
  const ctx = await setup();
  ctx.chain.st.gasPrice = 1_000n;
  ctx.chain.st.hooks.eth_maxPriorityFeePerGas = () => q(5_000_000_000n);
  await buy(ctx);
  const t = ctx.chain.st.txs[0];
  assert.equal(t.maxFeePerGas, q(2_000n));
  assert.equal(t.maxPriorityFeePerGas, t.maxFeePerGas);
});

test("when the node cannot say what gas costs, no fee fields are sent and the wallet decides", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_gasPrice = () => { throw rpcError(-32601, "no such method"); };
  const c = captureConsole();
  try { await buy(ctx); } finally { c.restore(); }
  const t = ctx.chain.st.txs[0];
  assert.equal("maxFeePerGas" in t, false);
  assert.equal("maxPriorityFeePerGas" in t, false);
});

test("regression: a wallet that bids the chain's floor fee no longer breaks the purchase or the second signature", async () => {
  const ctx = await setup();
  const FLOOR = 10_000_000n, BASE_FEE = 10_009_000n;
  ctx.chain.st.gasPrice = 10_386_000n;
  const wallet = (params) => {
    const tx = params[0];
    const bid = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : FLOOR;
    if (bid < BASE_FEE) {
      throw providerError(-32603, `RPC 0x1159 Custom eth_sendRawTransaction: max fee per gas less than block base fee: address ${A}, maxFeePerGas: ${bid} baseFee: ${BASE_FEE}`);
    }
    return ctx.chain.sendTransaction(tx);
  };
  ctx.provider.once("eth_sendTransaction", wallet);
  await assert.rejects(ctx.wallet.sendTransaction({ to: SHOP, data: "0xc37b9bcd", value: PRICE }), walletErr("fee_too_low", (e) => /Nothing was charged/.test(e.message)));
  assert.equal(ctx.chain.st.txs.length, 0);
  ctx.provider.once("eth_sendTransaction", wallet);
  const { packId } = await buy(ctx);
  ctx.provider.once("eth_sendTransaction", wallet);
  assert.equal((await open(ctx, packId)).tokenIds.length, 5);
});

test("a wallet that ignores our caps and refuses on the base fee leaves the pack unopened, with a clear message", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.provider.once("eth_sendTransaction", providerError(-32603, "RPC 0x1159 Custom eth_sendRawTransaction: max fee per gas less than block base fee: address 0x729A7da21DF1252E724C67Be415f36f2E1a9f626, maxFeePerGas: 10000000 baseFee: 10009000"));
  await assert.rejects(open(ctx, packId), walletErr("fee_too_low", (e) => /Nothing was charged/.test(e.message)));
  assert.equal(await phaseOf(ctx.cfg, packId), PHASE.Ready, "the pack is untouched and can be opened on the next try");
  assert.equal((await open(ctx, packId)).tokenIds.length, 5, "the retry works");
});
