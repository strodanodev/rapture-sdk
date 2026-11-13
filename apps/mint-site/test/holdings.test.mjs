// lib/holdings.js: finding a holder's tokens (balanceOf, remembered ids, an ownerOf scan, or ERC721Enumerable) and
// naming each one (templatesOf, design records).
import test from "node:test";
import assert from "node:assert/strict";
import { createHoldings } from "../web/lib/holdings.js";
import { createChain } from "../web/lib/chain.js";
import { ethers, ALICE, BOB, memoryStorage } from "./helpers.mjs";
import { createFixedChain, siteFor, BASE, DESIGNS } from "./fixed-chain.mjs";

function setup({ site = siteFor(), ...opts } = {}) {
  const chain = createFixedChain(opts);
  const client = createChain(site.chain.rpc, { fetch: chain.fetch, retries: 0, timeoutMs: 1000 });
  const storage = memoryStorage();
  return { chain, site, storage, holdings: createHoldings({ site, chain: client, storage }) };
}
const ids = (r) => r.tokens.map((t) => t.tokenId);

test("finds every token by scanning ownerOf newest first, stopping once balanceOf is met, and names them", async () => {
  const { chain, holdings } = setup({ editions: [[50, 0], [50, 0], [50, 0]] });
  chain.mintTo(BOB, 0, 20);
  chain.mintTo(ALICE, 1, 2);       // ids BASE+20, BASE+21
  chain.mintTo(BOB, 2, 30);
  chain.mintTo(ALICE, 2, 1);       // id BASE+52
  const r = await holdings.read(ALICE);
  assert.equal(r.balance, 3);
  assert.equal(r.complete, true);
  assert.deepEqual(ids(r), [BASE + 52n, BASE + 21n, BASE + 20n].map(String));
  assert.deepEqual(r.tokens.map((t) => t.templateId), [2, 1, 1]);
  assert.ok(r.scanned >= 33 && r.scanned < 53, `stopped at the oldest one found (${r.scanned} ownerOf calls)`);
});

test("remembered tokens are verified with ownerOf, so a token sent away drops out; a fresh mint is found without a scan", async () => {
  const { chain, holdings } = setup({ editions: [[50, 0], [50, 0], [50, 0]] });
  const mine = chain.mintTo(ALICE, 0, 2).map(String);
  holdings.remember(ALICE, mine, mine.map(() => ({ templateId: 0 })));
  let r = await holdings.read(ALICE);
  assert.deepEqual(ids(r).sort(), [...mine].sort());
  assert.equal(r.scanned, 0, "the remembered ids met the balance");
  chain.st.owners.set(BigInt(mine[0]), BOB.toLowerCase());   // sent to Bob
  r = await holdings.read(ALICE);
  assert.deepEqual(ids(r), [mine[1]]);
  assert.equal(r.balance, 1);
});

test("an ERC721Enumerable collection is listed with tokenOfOwnerByIndex; an empty wallet reads nothing else", async () => {
  const { chain, holdings } = setup({ enumerable: true });
  chain.mintTo(ALICE, 0, 2);
  chain.mintTo(BOB, 0, 1);
  const before = chain.st.calls.length;
  const r = await holdings.read(ALICE);
  assert.equal(r.tokens.length, 2);
  assert.equal(r.scanned, 0);
  assert.ok(chain.st.calls.length - before < 10);
  assert.deepEqual((await holdings.read(ethers.Wallet.createRandom().address)).tokens, []);
});

test("design records name tokens the minter did not mint (or a site with no minter yet)", async () => {
  const site = siteFor({ address: null, designRecords: DESIGNS });
  const { chain, holdings } = setup({ site });
  chain.mintTo(ALICE, 2, 1);
  chain.mintTo(ALICE, 0, 1);
  const r = await holdings.read(ALICE);
  assert.deepEqual(r.tokens.map((t) => t.templateId), [0, 2]);
});

test("createHoldings needs the collection address", () => {
  assert.throws(() => createHoldings({ site: siteFor({ collection: null }) }), /mint.collection/);
});
