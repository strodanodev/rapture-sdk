// lib/fixed.js end to end: real wallet.js + chain.js + abi.js against a mock EIP-1193 wallet and a fake FixedPriceMinter.
import test from "node:test";
import assert from "node:assert/strict";
import { fixedConfig, readMinter, readEditions, templatesOf, mint, MAX_PER_TX } from "../web/lib/fixed.js";
import { ShopError } from "../web/lib/shop.js";
import { createWallet } from "../web/lib/wallet.js";
import { walletChain } from "../web/lib/config.js";
import { createChain } from "../web/lib/chain.js";
import { ALICE, ETH, createMockProvider, memoryStorage } from "./helpers.mjs";
import { createFixedChain, siteFor, MINTER, BASE } from "./fixed-chain.mjs";

const FAST = { pollMs: 2, timeoutMs: 2000 };

async function setup(opts = {}) {
  const chain = createFixedChain(opts);
  const site = siteFor();
  const cfg = { ...fixedConfig(site), client: createChain(site.chain.rpc, { fetch: chain.fetch, retries: 0, timeoutMs: 1000 }) };
  const provider = createMockProvider({ chain, accounts: [ALICE] });
  const wallet = createWallet({ provider, storage: memoryStorage(), chain: walletChain(site) });
  await wallet.connect();
  return { chain, site, cfg, provider, wallet };
}
const shopErr = (code, reason) => (e) => e instanceof ShopError && e.code === code && (reason == null || e.reason === reason);

test("fixedConfig takes the minter from the site config, and refuses a packs or undeployed site", () => {
  const cfg = fixedConfig(siteFor());
  assert.equal(cfg.shop, MINTER);
  assert.equal(cfg.chainId, 4441);
  assert.throws(() => fixedConfig(siteFor({ mode: "packs" })), shopErr("not_configured"));
  assert.throws(() => fixedConfig(siteFor({ address: null })), shopErr("not_configured"));
});

test("readMinter and readEditions decode config(), mintableBy and editionsOf", async () => {
  const { cfg, chain } = await setup({ maxPerWallet: 4 });
  const s = await readMinter(cfg, ALICE);
  assert.deepEqual({ ...s }, { price: ETH / 100n, maxPerWallet: 4, paused: false, ready: true, locked: true, templateCount: 3, totalMinted: 3, maxSupply: 18, soldOut: false, mintable: 4 });
  const e = await readEditions(cfg, s.templateCount);
  assert.deepEqual(e, [
    { id: 0, maxSupply: 5, minted: 0, retired: false, left: 5 },
    { id: 1, maxSupply: 3, minted: 3, retired: false, left: 0 },
    { id: 2, maxSupply: 10, minted: 0, retired: false, left: 10 },
  ]);
  chain.st.maxPerWallet = 0;
  assert.equal((await readMinter(cfg, ALICE)).mintable, Infinity);
  chain.st.editions[2].retired = true;
  assert.equal((await readEditions(cfg, 3))[2].left, 0);
});

test("mint sends exactly price x quantity, waits for the receipt and returns the new token ids from Minted", async () => {
  const { cfg, chain, wallet } = await setup();
  const stages = [];
  const r = await mint(wallet, cfg, 2, 3, { onStage: (s) => stages.push(s), ...FAST });
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.deepEqual(r.tokenIds, [BASE, BASE + 1n, BASE + 2n].map(String));
  assert.equal(r.templateId, 2);
  const tx = chain.st.txs[0];
  assert.equal(BigInt(tx.value), (ETH / 100n) * 3n);
  assert.equal(tx.to.toLowerCase(), MINTER.toLowerCase());
  assert.ok(BigInt(tx.gas) >= 1_200_000n, "the estimate plus headroom");
  assert.deepEqual(await templatesOf(cfg, [...r.tokenIds, "99"]), [2, 2, 2, null]);
});

test("mint checks before troubling the wallet: quantity, pause, sold out, the wallet's limit, the balance", async () => {
  const ctx = await setup({ maxPerWallet: 2 });
  const { cfg, chain, wallet, provider } = ctx;
  const none = () => assert.equal(provider.methods("eth_sendTransaction").length, 0);
  await assert.rejects(mint(wallet, cfg, 0, 0), shopErr("reverted", "BadQuantity"));
  await assert.rejects(mint(wallet, cfg, 0, MAX_PER_TX + 1), shopErr("reverted", "BadQuantity"));
  await assert.rejects(mint(wallet, cfg, 1, 1, FAST), (e) => shopErr("unavailable", "SoldOut")(e) && /sold out/.test(e.message));
  await assert.rejects(mint(wallet, cfg, 0, 3, FAST), (e) => shopErr("unavailable", "WalletLimitReached")(e) && /may mint 2 more/.test(e.message));
  await assert.rejects(mint(wallet, cfg, 7, 1, FAST), shopErr("unavailable", "UnknownTemplate"));
  chain.st.paused = true;
  await assert.rejects(mint(wallet, cfg, 0, 1, FAST), (e) => shopErr("unavailable", "EnforcedPause")(e) && /paused/.test(e.message));
  chain.st.paused = false;
  chain.st.ready = false;
  await assert.rejects(mint(wallet, cfg, 0, 1, FAST), shopErr("unavailable", "NotMinter"));
  chain.st.ready = true;
  chain.st.balances.set(ALICE.toLowerCase(), ETH / 1000n);
  await assert.rejects(mint(wallet, cfg, 0, 1, FAST), (e) => shopErr("low_balance")(e) && /Not enough zkLTC/.test(e.message));
  none();
  chain.st.balances.set(ALICE.toLowerCase(), 10n * ETH);
  const r = await mint(wallet, cfg, 0, 2, FAST);
  assert.equal(r.tokenIds.length, 2);
  await assert.rejects(mint(wallet, cfg, 0, 1, FAST), shopErr("unavailable", "WalletLimitReached"));
});

test("a price change between the read and the transaction is a revert the buyer can understand", async () => {
  const { cfg, chain, wallet } = await setup();
  const realSend = chain.sendTransaction;
  chain.sendTransaction = (tx) => { chain.st.price = ETH; return realSend(tx); };   // the owner raised the price as it was signed
  await assert.rejects(mint(wallet, cfg, 0, 1, FAST), (e) => e.code === "unavailable" || e.code === "reverted");
});
