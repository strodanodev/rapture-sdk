// Adversarial review of PackShopV2 (Solidity 0.8.28 viaIR, OZ 5.0.2, drand evmnet via the vendored EvmnetRegistry).
// Independent reviewer, 2026-10-19. Nothing in contracts/PackShopV2.sol was changed by this suite.
//
// Naming: `FINDING: ...` tests PASS while the issue exists (they assert the bad outcome; fixing it makes them fail on
// purpose). `blocked: ...` tests show an attack that does not work. `(was FINDING ...)` marks a round-1 finding whose
// fix the test now proves. Severity in brackets.
//
// Round 1 (fixed in PackShopV2.sol the same day):
//   was [medium] a refund of a SEALED pack after shutdown dropped it from the deal sequence, re-rolling every later
//                pack (owner subset-refund grinding: 24 tail packs -> 35 distinct target pulls, 0 Gold -> 2 Gold).
//                Fixed: a pack refunded while sealed is still drawn in its turn, so the target now has ONE pull.
//   was [low]    refund() was permissionless and took DEALT packs while minting worked (strangers voided victims'
//                pulls and the reserve; holders opened the good and refunded the bad). Fixed: buyer-only; a sealed
//                pack only while its round is unproven; a dealt pack only once the shop cannot mint.
//   was [info]   the clock margin was 10-12 s. Fixed: REVEAL_DELAY 5 (13-15 s) and the binding never goes below the
//                latest round proven through the shop, so a keeper post beats a lagging clock.
//
// Round 2 (attacking the fixes) - no new medium/high; all residuals below are info:
//   FINDING [info] the sealed-refund gate leaves one option: if NOBODY posts a pack's round for the 7 days after
//                  shutdown, its holder computes the pull off-chain and refunds it if bad (~44% of packs are all-Normal).
//                  One keeper pass (even deal(0, rounds, sigs)) in the grace week closes it; others' pulls never move.
//   FINDING [info] after shutdown, a MINTER revoke + re-grant by the (trusted) StudioMinter admin gives holders of
//                  dealt packs a refund-the-bad / open-the-good window.
//   FINDING [info] buyer-only refunds strand a contract buyer that cannot call refund() when its pack cannot be
//                  delivered: its price stays in liability for good.
//   FINDING [info] the lag sniper still works when the chain clock lags >= 13 s and no FRESH round was posted THROUGH
//                  THE SHOP (none, a stale one, or one posted straight to EvmnetRegistry): the keeper must post the
//                  latest round with deal(0, [latest], [sig]) at least every ~12 s while the clock lags.
//   FINDING [info] latestRound trusts the beacon: against a beacon that stores unpublished rounds (the test mock), anyone
//                  can brick buyPack (uint64 overflow) or bind new packs centuries out. EvmnetRegistry only stores
//                  rounds with real signatures, so production is fine; never deploy against a permissive beacon.
//   FINDING [info] (unchanged) without a keeper, opening pack N pays for every earlier undealt pack; past ~94 distinct
//                  pending rounds one openPack exceeds Nitro's 32M cap. deal() in chunks always gets it open.
//
// Helper contracts (AdversaryV2, PlainBuyerV2, LagSniperV2) live in contracts/test/AdversariesV2.sol.
"use strict";
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { deployStudio } = require("../helpers/deployStudio.js");
const { template, POOL } = require("../helpers/templates.js");
const EVMNET = require("../fixtures/evmnet-rounds.json");
const ARC1 = require("../../examples/rapture/deck.arc1.json");

const PRICE = ethers.parseEther("0.001");
const PHASE = { None: 0, Waiting: 1, Ready: 2, Dealt: 3, Opened: 4, Refunded: 5 };
const DELAY = 5n;
const GRACE = 7 * 86400;
const GENESIS = EVMNET.info.genesis_time;
const NITRO_TX_CAP = 32_000_000n;
const NONE = [[], []];
const coder = ethers.AbiCoder.defaultAbiCoder();
const rpc = (method, params = []) => ethers.provider.send(method, params);
const tick = (seconds) => rpc("evm_increaseTime", [seconds]).then(() => rpc("hardhat_mine", ["0x1"]));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const flat = (deck) => Array.from(deck, (row) => Array.from(row, Number)).flat();
const fakeSig = (round) => ethers.toUtf8Bytes(`sig-${round}`);   // the mock's fixed "drand output" per round, never chosen adversarially
const key = (cards) => cards.map((c) => `${c.tid}:${c.finish}`).join(",");
const REAL = EVMNET.rounds.map((r) => ({ round: BigInt(r.round), sig: r.signature, rnd: ethers.sha256(r.signature) }));
const realRnd = (round) => {
  const r = REAL.find((x) => x.round === BigInt(round));
  if (!r) throw new Error(`no real signature for round ${round}`);
  return r.rnd;
};
const mockRnd = (round) => ethers.sha256(fakeSig(round));
const proofs = (idx) => [idx.map((i) => REAL[i].round), idx.map((i) => REAL[i].sig)];
const upTo = (n) => Array.from({ length: n + 1 }, (_, i) => i);
const allNormal = (cards) => cards.every((c) => c.finish === 1);

// ---------------------------------------------------------------------------------------------- errors
let SELECTORS = {};
let NAMES = [];
const REASONS = ["Invalid signature", "Invalid G1 bytes length", "bad pull, try again", "cannot see the pull", "no NFTs here"];
function errName(e) {
  const blob = String(e?.message ?? "") + " " + JSON.stringify(e?.data ?? "") + " " + JSON.stringify(e?.info ?? "") + " " + JSON.stringify(e?.error ?? "");
  for (const m of blob.matchAll(/0x[0-9a-fA-F]{8}/g)) if (SELECTORS[m[0].toLowerCase()]) return SELECTORS[m[0].toLowerCase()];
  for (const n of NAMES) if (blob.includes(n)) return n;
  for (const r of REASONS) if (blob.includes(r)) return r;
  return "unknown(" + blob.slice(0, 300) + ")";
}
async function rejects(promise, error) {
  await assert.rejects(promise, (e) => {
    const got = errName(e);
    assert.equal(got, error, `expected ${error}, got ${got}`);
    return true;
  });
}
const REENTRANT = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);

// ---------------------------------------------------------------------------------------------- off-chain replica
/** PackShopV2._draw, line for line: what anyone can compute for free once a pack's drand signature is public. */
function draw(deck, seed, count, byKind) {
  deck = deck.slice();
  let left = deck.reduce((a, b) => a + b, 0n);
  const cards = [];
  for (let i = 0n; i < BigInt(count); i++) {
    const r = BigInt(ethers.keccak256(coder.encode(["uint256", "uint256"], [seed, i])));
    let x = r % left;
    let c = 0;
    while (x >= deck[c]) { x -= deck[c]; c++; }
    deck[c] -= 1n;
    left -= 1n;
    const pool = byKind[Math.floor(c / 3)];
    cards.push({ tid: pool[Number((r >> 128n) % BigInt(pool.length))], finish: (c % 3) + 1 });
  }
  return { deck, cards };
}
const seedOf = (randomness, packId, buyer, shop) =>
  BigInt(ethers.keccak256(coder.encode(["bytes32", "uint256", "address", "address"], [randomness, packId, buyer, shop])));

/** Everything the replica needs, read from chain: the deck now, the Kind pools, and every pack from nextToDeal on. */
async function readState(s) {
  const [nextToDeal, nextPackId, packSize, reserveSize, packsTotal, packsSold] = await Promise.all([
    s.nextToDeal(), s.nextPackId(), s.packSize(), s.reserveSize(), s.packsTotal(), s.packsSold(),
  ]);
  const deck = flat(await s.deckRemaining()).map(BigInt);
  const byKind = await Promise.all([0, 1, 2, 3, 4].map(async (k) => (await s.activeTemplates(k)).map(Number)));
  const packs = [];
  for (let id = nextToDeal; id < nextPackId; id++) {
    const p = await s.packOf(id);
    const reserve = reserveSize > 0n && packsSold === packsTotal && id === nextPackId - 1n && p.paid === 0n;
    packs.push({ id, buyer: p.buyer, round: p.round, phase: Number(p.phase), count: Number(reserve ? reserveSize : packSize) });
  }
  return { deck, byKind, packs, shop: await s.getAddress() };
}
/** Deal every undealt pack from nextToDeal in id order. Refunded packs are drawn too (the fixed contract's rule). */
function predict(state, rndOf) {
  let deck = state.deck;
  const out = new Map();
  for (const p of state.packs) {
    const r = draw(deck, seedOf(rndOf(p.round), p.id, p.buyer, state.shop), p.count, state.byKind);
    deck = r.deck;
    out.set(p.id, r.cards);
  }
  return out;
}
/** Gold first, then Shiny, then Kind: how a grinder ranks pulls. */
const score = (cards, pool = POOL) => cards.reduce((s, c) => s + (c.finish === 3 ? 1e6 : c.finish === 2 ? 1e3 : 0) + pool[c.tid].kind, 0);
const golds = (cards) => cards.filter((c) => c.finish === 3).length;

describe("PackShopV2 adversarial review", function () {
  this.timeout(1800000);

  let deployer, owner, alice, bob, carol, stranger, team, attacker;
  let studio, mock, registry, snap, shopDeployer;

  // Shops are deployed from a dedicated fixed-key wallet, so their addresses (part of every seed) do not depend on
  // what other test files ran first: every replayed pull below is the same in any run.
  async function deployShop({ name = "PackShopV2Harness", beacon = mock, packSize = 5, limit = 0, price = PRICE } = {}) {
    const f = await ethers.getContractFactory(name, shopDeployer);
    const s = await f.deploy(studio.minter, beacon, owner.address, price, packSize, limit);
    await s.waitForDeployment();
    return s;
  }
  async function stock(s, { pool = POOL, deck = ARC1.counts, reserveTo = team.address, lock = true, open = true } = {}) {
    for (let i = 0; i < pool.length; i += 10) await (await s.connect(owner).addTemplates(pool.slice(i, i + 10))).wait();
    await (await s.connect(owner).setDeck(deck, reserveTo)).wait();
    if (lock) await (await s.connect(owner).lock()).wait();
    await (await studio.minter.setMinter(await s.getAddress(), true)).wait();
    if (open) await (await s.connect(owner).unpause()).wait();
    return s;
  }
  const deploy = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name, shopDeployer)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const events = (rc, s, name) => rc.logs.map((l) => { try { return s.interface.parseLog(l); } catch { return null; } }).filter((l) => l?.name === name);
  const buy = async (who, s, value = PRICE) => {
    const rc = await (await s.connect(who).buyPack({ value })).wait();
    const ev = events(rc, s, "PackBought")[0];
    return { packId: ev.args.packId, round: ev.args.round, rc };
  };
  const toCards = (templateIds, finishes) => templateIds.map((t, i) => ({ tid: Number(t), finish: Number(finishes[i]) }));
  const open = async (s, packId, who, beacons = NONE) => {
    const rc = await (await s.connect(who).openPack(packId, ...beacons)).wait();
    const ev = events(rc, s, "PackOpened")[0];
    return { tokenIds: [...ev.args.tokenIds], cards: toCards(ev.args.templateIds, ev.args.finishes), rc };
  };
  const dealtCards = async (s, id) => { const p = await s.packOf(id); return toCards(p.templateIds, p.finishes); };
  // the next buy is bound to real evmnet round REAL[i] (as long as no later round was proven through this shop)
  const bindTo = (s, i) => s.setRound(REAL[i].round - DELAY);
  /** The keeper: prove every pending round with the mock's fixed output (straight to the mock), deal everything. */
  async function keeper(s) {
    const pending = await s.pendingRounds((await s.nextPackId()) - 1n, 256);
    for (const r of pending) await (await mock.proveRound(fakeSig(r), r)).wait();
    await (await s.connect(stranger).deal(10000, [], [])).wait();
  }
  const balance = (a) => ethers.provider.getBalance(a);
  const setMinter = async (s, on) => (await studio.minter.setMinter(await s.getAddress(), on)).wait();
  const shutdownAndWait = async (s) => { await (await s.connect(owner).shutdown()).wait(); await tick(GRACE + 60); };
  const snapshot = () => rpc("evm_snapshot");
  const revert = (id) => rpc("evm_revert", [id]);

  before(async () => {
    [deployer, owner, alice, bob, carol, stranger, team, attacker] = await ethers.getSigners();
    studio = await deployStudio(ethers, { minters: [deployer.address] });
    shopDeployer = new ethers.Wallet(ethers.id("PackShopV2 adversarial review: shop deployer"), ethers.provider);
    await rpc("hardhat_setBalance", [shopDeployer.address, ethers.toQuantity(10n ** 22n)]);
    mock = await deploy("MockEvmnetRegistry");
    registry = await deploy("EvmnetRegistry");
    const ifaces = [
      (await ethers.getContractFactory("PackShopV2")).interface,
      studio.minter.interface,
      studio.design.interface,
      studio.cards.interface,
    ];
    for (const iface of ifaces) for (const f of iface.fragments) if (f.type === "error") SELECTORS[f.selector.toLowerCase()] = f.name;
    for (const sig of ["ReentrancyGuardReentrantCall()", "EnforcedPause()", "ExpectedPause()", "OwnableUnauthorizedAccount(address)"]) {
      SELECTORS[ethers.id(sig).slice(0, 10)] = sig.split("(")[0];
    }
    NAMES = [...new Set(Object.values(SELECTORS))].sort((a, b) => b.length - a.length);
  });
  beforeEach(async () => { snap = await snapshot(); });
  afterEach(async () => { await revert(snap); });

  // ============================================================================================ refunds after shutdown
  describe("shutdown and refund", () => {
    it("blocked: (was FINDING [medium]) refunds no longer move the deck: the owner's subset-refund search over its own 24 sealed tail packs now gives the target ONE pull on chain, whatever it refunds; refunded packs are drawn in turn and stay Refunded", async () => {
      const s = await stock(await deployShop({ beacon: registry }));   // real EvmnetRegistry: no freedom in any signature
      await bindTo(s, 0);
      const a = await buy(alice, s);
      const K = 24;
      const sac = [];
      for (let i = 0; i < K; i++) {
        await bindTo(s, 1 + Math.floor((i * 6) / K));
        sac.push((await buy(owner, s)).packId);
      }
      await bindTo(s, 7);
      const target = (await buy(owner, s)).packId;
      await open(s, a.packId, alice, proofs([0]));   // after every buy: a proof through the shop raises latestRound
      await shutdownAndWait(s);
      const honest = predict(await readState(s), realRnd).get(target);

      const sets = [[], sac.slice(0, 12), sac.slice(12), sac, sac.filter((_, i) => i % 2 === 0), sac.filter((_, i) => i % 3 === 1)];
      const pulls = [];
      for (const S of sets) {
        const sn = await snapshot();
        for (const id of S) await (await s.connect(owner).refund(id)).wait();   // the owner is their buyer; rounds unposted
        const got = await open(s, target, owner, proofs([1, 2, 3, 4, 5, 6, 7]));
        pulls.push(key(got.cards));
        if (S.length === K) {
          const dealt = events(got.rc, s, "PackDealt").map((e) => e.args.packId);
          assert.deepEqual(dealt, [...sac, target]);   // every refunded pack drawn, in order
          for (const id of sac) assert.equal(Number(await s.phaseOf(id)), PHASE.Refunded);
          assert.equal(await s.liability(), 0n);
          assert.equal(await s.cardsLeft(), 888n - 5n * BigInt(K + 2));
        }
        await revert(sn);
      }
      assert.equal(new Set(pulls).size, 1, "the target's pull does not depend on refunds");
      assert.equal(pulls[0], key(honest));
    });

    it("blocked: (was FINDING [medium], variant) a stranger cannot refund a victim's sealed pack, and the victim's own refund leaves every later pack's cards unchanged", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      await bindTo(s, 0);
      const victim = (await buy(alice, s)).packId;
      await bindTo(s, 1);
      const mine = (await buy(attacker, s)).packId;
      await shutdownAndWait(s);
      await rejects(s.connect(attacker).refund(victim), "NotRefundable");
      await rejects(s.connect(owner).refund(victim), "NotRefundable");
      const pred = predict(await readState(s), realRnd).get(mine);
      const sn = await snapshot();
      const rc = await (await s.connect(alice).refund(victim)).wait();
      assert.equal(events(rc, s, "PackRefunded")[0].args.amount, PRICE);
      assert.deepEqual((await open(s, mine, attacker, proofs([0, 1]))).cards, pred);
      await revert(sn);
      assert.deepEqual((await open(s, mine, attacker, proofs([0, 1]))).cards, pred);
    });

    it("blocked: (was FINDING [low]) nobody - buyer included - refunds a DEALT pack while the shop can mint; strangers cannot void any pack or the reserve; once MINTER is gone the buyer alone can", async () => {
      const deck = [[20, 4, 2], [16, 3, 2], [12, 3, 1], [9, 2, 1], [6, 2, 1]];   // 84 cards: 16 packs + a 4-card reserve
      const s = await stock(await deployShop(), { deck });
      await s.setRound(1000);
      const alicePacks = [];
      const bobPacks = [];
      for (let i = 0; i < 8; i++) {
        alicePacks.push((await buy(alice, s)).packId);
        bobPacks.push((await buy(bob, s)).packId);
      }
      const reserveId = (await s.nextPackId()) - 1n;
      await keeper(s);   // every pull is fixed and public
      await shutdownAndWait(s);
      for (const id of alicePacks) {
        await rejects(s.connect(stranger).refund(id), "NotRefundable");
        await rejects(s.connect(alice).refund(id), "NotRefundable");   // she sees her cards: no handing back the bad ones
      }
      for (const id of bobPacks) await rejects(s.connect(bob).refund(id), "NotRefundable");
      await rejects(s.connect(stranger).refund(reserveId), "NotRefundable");
      await rejects(s.connect(team).refund(reserveId), "NotRefundable");
      assert.equal(await s.liability(), PRICE * 16n);

      await setMinter(s, false);   // minting is gone: now the escape hatch opens, for the buyer only
      await rejects(s.connect(stranger).refund(alicePacks[0]), "NotRefundable");
      const left = await s.cardsLeft();
      const before = await balance(alice.address);
      const rc = await (await s.connect(alice).refund(alicePacks[0])).wait();
      assert.equal(await balance(alice.address), before + PRICE - rc.fee);
      assert.equal(await s.cardsLeft(), left);   // dealt cards stay out of the deck
      assert.equal(await s.liability(), PRICE * 15n);
    });

    it("FINDING: [info] the sealed-refund gate leaves one post-shutdown option: when NOBODY posts a pack's round for the 7 days after shutdown, its holder computes the pull off-chain and refunds the bad ones (here the all-Normal packs), and keeps the rest; other packs are unaffected", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const ids = [];
      for (let i = 0; i < 8; i++) { await bindTo(s, i); ids.push((await buy(bob, s)).packId); }   // one pack per real round
      await shutdownAndWait(s);   // no keeper ran, nobody opened
      const pred = predict(await readState(s), realRnd);   // refunds no longer move the deck: one pass predicts all
      let refunded = 0;
      let opened = 0;
      for (let i = 0; i < 8; i++) {
        const cards = pred.get(ids[i]);
        if (allNormal(cards)) { await (await s.connect(bob).refund(ids[i])).wait(); refunded++; }
        else { assert.deepEqual((await open(s, ids[i], bob, proofs(upTo(i)))).cards, cards); opened++; }
      }
      const p = (754 / 888) ** 5;   // ~ C(754,5)/C(888,5): share of all-Normal packs early in the ARC 1 deck
      console.log(`      no round posted for 7 days: bob refunded ${refunded} all-Normal pulls of 8 and opened ${opened} (expected share ~${(p * 100).toFixed(0)}%)`);
      assert.ok(refunded > 0 && opened > 0);
      assert.equal(await s.liability(), 0n);
    });

    it("blocked: one keeper pass during the grace week closes that option: after deal(0, rounds, sigs) (prove only) every sealed refund reverts, and after deal(n) every dealt one does while minting works", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const ids = [];
      for (let i = 0; i < 8; i++) { await bindTo(s, i); ids.push((await buy(bob, s)).packId); }
      await (await s.connect(owner).shutdown()).wait();
      await tick(3 * 86400);
      const sn = await snapshot();
      await (await s.connect(stranger).deal(0, ...proofs(upTo(7)))).wait();   // proves, deals nothing
      assert.equal(await s.nextToDeal(), 1n);
      await tick(GRACE);
      for (const id of ids) await rejects(s.connect(bob).refund(id), "NotRefundable");
      await revert(sn);
      await (await s.connect(stranger).deal(100, ...proofs(upTo(7)))).wait();
      await tick(GRACE);
      for (const id of ids) await rejects(s.connect(bob).refund(id), "NotRefundable");
    });

    it("FINDING: [info] after shutdown, a MINTER revoke then re-grant by the (trusted) StudioMinter admin gives holders of dealt packs a window to refund the bad pulls and later open the good ones", async () => {
      const s = await stock(await deployShop());
      await s.setRound(1000);
      const ids = [];
      for (let i = 0; i < 8; i++) ids.push((await buy(bob, s)).packId);
      await keeper(s);
      await shutdownAndWait(s);
      await setMinter(s, false);
      let refunded = 0;
      const keep = [];
      for (const id of ids) {
        if (allNormal(await dealtCards(s, id))) { await (await s.connect(bob).refund(id)).wait(); refunded++; }
        else keep.push(id);
      }
      await setMinter(s, true);
      for (const id of keep) await open(s, id, bob);
      console.log(`      during the revoke window bob refunded ${refunded} plain packs, then opened ${keep.length}`);
      assert.ok(refunded > 0 && keep.length > 0);
    });

    it("blocked: a refunded sealed pack cannot strand later packs: dealing waits for its round like any other (pendingRounds lists it), anyone supplies it, later packs get exactly the no-refund cards, and liability is untouched by the draw", async () => {
      const s = await stock(await deployShop());
      await s.setRound(1000);
      const a = await buy(alice, s);
      await s.setRound(2000);
      const b = await buy(bob, s);
      await s.setRound(3000);
      const c = await buy(carol, s);
      const pred = predict(await readState(s), mockRnd);
      await shutdownAndWait(s);
      await (await s.connect(alice).refund(a.packId)).wait();
      for (const r of [b.round, c.round]) await (await mock.proveRound(fakeSig(r), r)).wait();
      assert.equal(await s.connect(stranger).deal.staticCall(10, [], []), 0n);
      await rejects(s.connect(bob).openPack(b.packId, ...NONE), "BeaconMissing");
      assert.deepEqual([...(await s.pendingRounds(c.packId, 8))], [a.round]);
      assert.equal(await s.liability(), PRICE * 2n);
      const rc = await (await s.connect(stranger).deal(10, [a.round], [fakeSig(a.round)])).wait();
      assert.deepEqual(events(rc, s, "PackDealt").map((e) => e.args.packId), [a.packId, b.packId, c.packId]);
      assert.equal(Number(await s.phaseOf(a.packId)), PHASE.Refunded);
      assert.equal(await s.liability(), PRICE * 2n);
      await rejects(s.connect(alice).openPack(a.packId, ...NONE), "NotDealt");
      await rejects(s.connect(alice).refund(a.packId), "NotRefundable");
      assert.deepEqual((await open(s, b.packId, bob)).cards, pred.get(b.packId));
      assert.deepEqual((await open(s, c.packId, carol)).cards, pred.get(c.packId));
      assert.equal(await s.liability(), 0n);
      assert.equal(await s.cardsLeft(), 888n - 15n);   // the refunded pack's cards left the deck, unminted
    });

    it("blocked: buyer-only refunds work for contract buyers and a contract reserveTo (calling refund() themselves); strangers never can; the reserve refund moves 0", async () => {
      const pool = [0, 10, 20, 30, 40].map((i) => POOL[i]);
      const deck = [[3, 1, 1], [2, 0, 1], [1, 1, 0], [1, 0, 0], [0, 1, 1]];   // 13 cards: 2 packs + a 3-card reserve
      const s = await deployShop();
      const adv = await deploy("AdversaryV2", await s.getAddress());
      const vault = await deploy("AdversaryV2", await s.getAddress());   // a contract reserve wallet
      await stock(s, { pool, deck, reserveTo: await vault.getAddress() });
      await s.setRound(1000);
      await (await adv.connect(attacker).buy({ value: PRICE })).wait();
      const p1 = await adv.lastPackId();
      await s.setRound(2000);
      const b = await buy(bob, s);
      const reserveId = events(b.rc, s, "ReserveQueued")[0].args.packId;
      await shutdownAndWait(s);
      const I = s.interface;
      await rejects(s.connect(stranger).refund(p1), "NotRefundable");
      await rejects(s.connect(attacker).refund(p1), "NotRefundable");   // the EOA behind the contract is not the buyer
      await (await adv.connect(attacker).exec(I.encodeFunctionData("refund", [p1]))).wait();
      assert.equal(await adv.received(), PRICE);
      await rejects(s.connect(stranger).refund(reserveId), "NotRefundable");
      await rejects(s.connect(team).refund(reserveId), "NotRefundable");
      const rc = await (await vault.connect(attacker).exec(I.encodeFunctionData("refund", [reserveId]))).wait();
      assert.equal(events(rc, s, "PackRefunded")[0].args.amount, 0n);
      assert.equal(await vault.received(), 0n);
      assert.equal(await s.liability(), PRICE);   // bob's pack only
    });

    it("FINDING: [info] buyer-only refunds strand a contract buyer that cannot call refund(): with minting gone for good, nobody can ever release its price (the owner cannot withdraw it either)", async () => {
      const s = await stock(await deployShop());
      const plain = await deploy("PlainBuyerV2", await s.getAddress());
      await s.setRound(1000);
      await (await plain.connect(attacker).buy({ value: PRICE })).wait();
      const dealtId = await plain.lastPackId();
      await s.setRound(2000);
      await (await plain.connect(attacker).buy({ value: PRICE })).wait();
      const sealedId = await plain.lastPackId();
      await (await mock.proveRound(fakeSig(1005), 1005)).wait();
      await (await s.connect(stranger).deal(10, [], [])).wait();   // the first dealt; the second sealed, its round unposted
      assert.equal(Number(await s.phaseOf(dealtId)), PHASE.Dealt);
      assert.equal(Number(await s.phaseOf(sealedId)), PHASE.Ready);
      await shutdownAndWait(s);
      await setMinter(s, false);
      for (const id of [sealedId, dealtId]) {
        await rejects(s.connect(stranger).refund(id), "NotRefundable");
        await rejects(s.connect(owner).refund(id), "NotRefundable");
        await rejects(s.connect(attacker).refund(id), "NotRefundable");
      }
      assert.equal(await s.liability(), PRICE * 2n);
      await rejects(s.connect(owner).withdraw(owner.address, 1n), "Insufficient");
    });

    it("blocked: refund boundaries are exact - nothing while the shop runs; a sealed pack from exactly 7 days after the later of shutdown and its round; a pack bought just before shutdown waits on its own round", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      await bindTo(s, 0);
      const a = await buy(alice, s);
      await bindTo(s, 1);
      const b = await buy(bob, s);
      await (await s.connect(stranger).deal(1, ...proofs([0]))).wait();   // a dealt, b sealed and unposted
      await tick(30 * 86400);
      await rejects(s.connect(bob).refund(b.packId), "NotRefundable");   // running shop: no refund, however late
      await (await s.connect(owner).shutdown()).wait();
      const at = Number(await s.shutdownAt());
      await rpc("evm_setNextBlockTimestamp", [at + GRACE - 1]);
      await rejects(s.connect(bob).refund(b.packId, { gasLimit: 500000 }), "NotRefundable");
      await rpc("evm_setNextBlockTimestamp", [at + GRACE]);
      await (await s.connect(bob).refund(b.packId)).wait();
      await rejects(s.connect(alice).refund(a.packId), "NotRefundable");   // dealt, minting works

      const s2 = await stock(await deployShop({ name: "PackShopV2" }));
      const c = await buy(carol, s2);
      await (await s2.connect(owner).shutdown()).wait();
      const since = Number(await s2.roundTime(c.round));
      assert.ok(since > Number(await s2.shutdownAt()));
      await rpc("evm_setNextBlockTimestamp", [since + GRACE - 1]);
      await rejects(s2.connect(carol).refund(c.packId, { gasLimit: 500000 }), "NotRefundable");
      await rpc("evm_setNextBlockTimestamp", [since + GRACE]);
      await (await s2.connect(carol).refund(c.packId)).wait();
    });

    it("blocked: terminal states - never opened twice, refunded after opening, opened after a refund (even once drawn), or refunded twice", async () => {
      const s = await stock(await deployShop());
      await s.setRound(1000);
      const a = await buy(alice, s);
      await s.setRound(2000);
      const b = await buy(bob, s);
      await (await mock.proveRound(fakeSig(a.round), a.round)).wait();
      await open(s, a.packId, alice);
      await rejects(s.connect(alice).openPack(a.packId, ...NONE), "NotDealt");
      await shutdownAndWait(s);
      await rejects(s.connect(alice).refund(a.packId), "NotRefundable");
      await (await s.connect(bob).refund(b.packId)).wait();
      await rejects(s.connect(bob).refund(b.packId), "NotRefundable");
      await rejects(s.connect(bob).openPack(b.packId, [b.round], [fakeSig(b.round)]), "NotDealt");
      await (await s.connect(stranger).deal(5, [b.round], [fakeSig(b.round)])).wait();   // drawn, still Refunded
      assert.equal(Number(await s.phaseOf(b.packId)), PHASE.Refunded);
      await rejects(s.connect(bob).openPack(b.packId, ...NONE), "NotDealt");
      await rejects(s.connect(bob).refund(b.packId), "NotRefundable");
      await rejects(s.connect(bob).refund(999), "NotRefundable");
      assert.equal(await s.liability(), 0n);
    });

    it("blocked: shutdown before sell-out - no sale, the reserve is never queued, unopened sealed packs refund to their buyers after grace, and the owner then withdraws the rest (the final distribution is then NOT the deck, by design)", async () => {
      const s = await stock(await deployShop());
      const ids = [];
      for (let i = 0; i < 3; i++) { await s.setRound(1000 + 10 * i); ids.push((await buy([alice, bob, carol][i], s)).packId); }
      await (await mock.proveRound(fakeSig(1005), 1005)).wait();
      await open(s, ids[0], alice);
      await (await s.connect(owner).shutdown()).wait();
      await rejects(s.connect(alice).buyPack({ value: PRICE }), "IsShutdown");
      assert.equal(await s.ready(), false);
      await tick(GRACE + 60);
      await (await s.connect(bob).refund(ids[1])).wait();
      await (await s.connect(carol).refund(ids[2])).wait();
      assert.equal(await s.liability(), 0n);
      assert.equal(await s.nextPackId(), 4n);   // no reserve pack, ever
      const bal = await balance(await s.getAddress());
      assert.equal(bal, PRICE);
      await (await s.connect(owner).withdraw(owner.address, bal)).wait();
      assert.equal(await balance(await s.getAddress()), 0n);
    });
  });

  // ============================================================================================ randomness and the clock
  describe("randomness and the clock", () => {
    it("blocked: (was FINDING [info]) the clock margin is now 13-15 s: a buy at second 0/1/2 of a drand period binds a round published 15/14/13 s after the block's timestamp", async () => {
      const s = await stock(await deployShop({ name: "PackShopV2" }));
      let base = (await ethers.provider.getBlock("latest")).timestamp + 30;
      base += (3 - ((base - GENESIS) % 3)) % 3;   // a drand round boundary
      const margins = [];
      for (const off of [0, 1, 2]) {
        const ts = base + 3 * off + off;
        await rpc("evm_setNextBlockTimestamp", [ts]);
        const { round, rc } = await buy(alice, s);
        assert.equal((await ethers.provider.getBlock(rc.blockNumber)).timestamp, ts);
        margins.push(Number(await s.roundTime(round)) - ts);
      }
      assert.deepEqual(margins, [15, 14, 13]);
    });

    /** Fresh buyer contracts until one keeps a pull with a Gold; misses revert and cost only gas. */
    async function snipeUntilGold(s, round, sig, tries = 60) {
      for (let i = 0; i < tries; i++) {
        const sniper = await deploy("LagSniperV2", await s.getAddress());   // a fresh buyer address is a fresh seed
        try {
          const rc = await (await sniper.connect(attacker).snipe([round], [sig], 3, { value: PRICE })).wait();
          return { id: events(rc, s, "PackBought")[0].args.packId, misses: i };
        } catch (e) {
          assert.equal(errName(e), "bad pull, try again");
        }
      }
      return null;
    }

    it("blocked: (was FINDING [info]) a keeper post of the latest round THROUGH THE SHOP (deal(0, [latest], [sig])) blinds the lag sniper even while the chain clock lags 15 s: the next pack binds latest + 5", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const latest = REAL[7];
      await s.setRound(latest.round - DELAY);   // the chain clock says R-5 is current; drand has already published R
      await (await s.connect(stranger).deal(0, [latest.round], [latest.sig])).wait();
      assert.equal(await s.latestRound(), latest.round);
      const sniper = await deploy("LagSniperV2", await s.getAddress());
      await rejects(sniper.connect(attacker).snipe.staticCall([latest.round], [latest.sig], 1, { value: PRICE }), "cannot see the pull");
      const { round } = await buy(alice, s);
      assert.equal(round, latest.round + DELAY);
    });

    it("FINDING: [info, documented residual trust] with the chain clock >= 13 s behind and no FRESH round posted through the shop - none, a stale one, or the latest posted straight to EvmnetRegistry - a buyer contract still buys, proves, deals and reads its pack in one tx and keeps only Gold pulls", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const latest = REAL[7];
      await s.setRound(latest.round - DELAY);
      const variants = {
        "nothing posted": async () => {},
        "a stale round posted through the shop": async () => (await s.connect(stranger).deal(0, ...proofs([2]))).wait(),
        "the latest round posted straight to the registry": async () => (await registry.connect(stranger).proveRound(latest.sig, latest.round)).wait(),
      };
      for (const [name, post] of Object.entries(variants)) {
        const sn = await snapshot();
        await post();
        const hit = await snipeUntilGold(s, latest.round, latest.sig);
        assert.ok(hit, `${name}: a Gold within 60 buyer addresses`);
        assert.ok(golds(await dealtCards(s, hit.id)) >= 1);
        assert.equal(await s.packsSold(), 1n, `${name}: only the kept pack was paid for`);
        console.log(`      ${name}: ${hit.misses} free misses, then a kept Gold`);
        await revert(sn);
      }
    });

    it("blocked: latestRound only ever holds rounds whose signatures exist and never decreases: a future round is refused, an unproven round with no signature is refused, an older round does not lower it, and bound rounds stay non-decreasing with id", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      await s.setRound(REAL[0].round - 100n);   // a far-behind clock
      await assert.rejects(s.connect(attacker).deal(0, [REAL[7].round + 100n], [REAL[7].sig]), /Invalid signature|reverted/);
      await assert.rejects(s.connect(attacker).deal(0, [REAL[7].round + 1n], ["0x"]), /Invalid G1 bytes length|reverted/);
      assert.equal(await s.latestRound(), 0n);
      await (await s.connect(attacker).deal(0, ...proofs([3]))).wait();
      await (await s.connect(attacker).deal(0, ...proofs([1]))).wait();
      assert.equal(await s.latestRound(), REAL[3].round);
      await (await registry.proveRound(REAL[7].sig, REAL[7].round)).wait();
      assert.equal(await s.latestRound(), REAL[3].round);   // a registry-only post does not move it...
      await (await s.connect(attacker).deal(0, [REAL[7].round], ["0x"])).wait();
      assert.equal(await s.latestRound(), REAL[7].round);   // ...until passed through the shop (no signature needed: already proven)
      // the binding is max(clock round, latestRound) + DELAY: both terms only grow, so rounds never decrease with id
      const rounds = [];
      for (const r of [REAL[0].round, REAL[7].round, REAL[7].round + 10n]) { await s.setRound(r); rounds.push((await buy(alice, s)).round); }
      assert.deepEqual(rounds, [REAL[7].round + DELAY, REAL[7].round + DELAY, REAL[7].round + 10n + DELAY]);
    });

    it("FINDING: [info] latestRound trusts the beacon: against a beacon that stores unpublished rounds (the test mock) anyone can brick buyPack with a uint64 overflow, or bind every new pack centuries out (refund then needs 7 days past that round); EvmnetRegistry only stores rounds with real signatures", async () => {
      const s = await stock(await deployShop());   // MockEvmnetRegistry: accepts any non-empty "signature"
      const far = (await s.currentRound()) + 10n ** 9n;
      await (await s.connect(attacker).deal(0, [far], ["0x01"])).wait();
      const { packId, round } = await buy(alice, s);
      assert.equal(round, far + DELAY);
      const years = (Number(await s.roundTime(round)) - (await ethers.provider.getBlock("latest")).timestamp) / (365 * 86400);
      assert.ok(years > 90, `bound ${years.toFixed(0)} years out`);
      assert.equal(Number(await s.phaseOf(packId)), PHASE.Waiting);
      await (await s.connect(attacker).deal(0, [2n ** 64n - 1n], ["0x01"])).wait();
      await assert.rejects(s.connect(bob).buyPack({ value: PRICE }), /overflow|0x11|panic/i);
    });

    it("blocked: with an honest clock the sniper is blind: its own round has no signature yet, so it cannot prove it or deal its pack; proving every EARLIER pack inside the buy only reveals the deck it will draw from, which deckRemaining() already shows everyone", async () => {
      const prod = await stock(await deployShop({ name: "PackShopV2", beacon: registry }));
      const sn = await deploy("LagSniperV2", await prod.getAddress());
      await rejects(sn.connect(attacker).snipe.staticCall([], [], 1, { value: PRICE }), "cannot see the pull");
      const bound = (await prod.currentRound()) + DELAY;
      await assert.rejects(sn.connect(attacker).snipe.staticCall([bound], [REAL[0].sig], 1, { value: PRICE }), /Invalid signature|reverted/);

      const s = await stock(await deployShop({ beacon: registry }));
      for (let i = 0; i < 4; i++) { await bindTo(s, i); await buy([alice, bob][i % 2], s); }
      await s.setRound(REAL[7].round + 1000n);
      const sn2 = await deploy("LagSniperV2", await s.getAddress());
      await rejects(sn2.connect(attacker).snipe.staticCall(...proofs([0, 1, 2, 3]), 1, { value: PRICE }), "cannot see the pull");
      const { packId } = await buy(attacker, s);
      await (await s.connect(stranger).deal(100, ...proofs([0, 1, 2, 3]))).wait();
      assert.equal(await s.nextToDeal(), packId);   // all earlier packs dealt, the attacker's still waits on its round
      await rejects(s.connect(attacker).openPack(packId, ...NONE), "BeaconMissing");
    });

    it("blocked: only (drand signature, pack id, buyer, shop) and the deck before it feed a pack: an off-chain replica predicts every pack exactly, whatever the opening order, caller, delay, or owner settings in between", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const who = [alice, bob, carol, attacker, alice, bob, carol, alice];
      const ids = [];
      for (let i = 0; i < 8; i++) { await bindTo(s, Math.floor(i / 2)); ids.push((await buy(who[i], s)).packId); }
      const pred = predict(await readState(s), realRnd);
      const all = proofs([0, 1, 2, 3]);
      const scenario = async (fn) => { const sn = await snapshot(); const out = await fn(); await revert(sn); return out; };
      const check = (got) => { for (const id of ids) assert.deepEqual(got.get(id), pred.get(id), `pack ${id}`); };

      check(await scenario(async () => {   // a keeper deals everything at once, then each buyer opens in id order
        await (await s.connect(stranger).deal(100, ...all)).wait();
        const got = new Map();
        for (let i = 0; i < 8; i++) got.set(ids[i], (await open(s, ids[i], who[i])).cards);
        return got;
      }));
      check(await scenario(async () => {   // every owner lever in between, a month late, opened last-first by a stranger
        await (await s.connect(owner).setPrice(1n)).wait();
        await (await s.connect(owner).setDailyLimit(1)).wait();
        await (await s.connect(owner).pause()).wait();
        await (await s.connect(owner).transferOwnership(bob.address)).wait();
        await (await s.connect(bob).acceptOwnership()).wait();
        await tick(30 * 86400);
        const got = new Map();
        for (let i = 7; i >= 0; i--) got.set(ids[i], (await open(s, ids[i], stranger, i === 7 ? all : NONE)).cards);
        return got;
      }));
      check(await scenario(async () => {   // proofs posted straight to the registry by someone else, packs opened scattered
        for (let i = 0; i < 4; i++) await (await registry.connect(carol).proveRound(REAL[i].sig, REAL[i].round)).wait();
        const got = new Map();
        for (const i of [4, 0, 7, 2, 1, 6, 3, 5]) got.set(ids[i], (await open(s, ids[i], [stranger, who[i]][i % 2])).cards);
        return got;
      }));
      check(await scenario(async () => {   // after shutdown, packs 2 and 5 refunded by their buyers before anything is dealt
        await shutdownAndWait(s);
        await (await s.connect(who[1]).refund(ids[1])).wait();
        await (await s.connect(who[4]).refund(ids[4])).wait();
        await (await s.connect(stranger).deal(100, ...all)).wait();
        const got = new Map([[ids[1], pred.get(ids[1])], [ids[4], pred.get(ids[4])]]);
        for (const i of [0, 2, 3, 5, 6, 7]) got.set(ids[i], (await open(s, ids[i], who[i])).cards);
        return got;
      }));
    });

    it("blocked: same-round packs and twin shops draw independently (pack id, buyer and shop address are all in the seed)", async () => {
      const s1 = await stock(await deployShop({ beacon: registry }));
      const s2 = await stock(await deployShop({ beacon: registry }));
      await bindTo(s1, 0);
      await bindTo(s2, 0);
      const a1 = await buy(alice, s1);
      const a2 = await buy(alice, s2);
      const b1 = await buy(alice, s1);
      assert.equal(a1.packId, a2.packId);
      assert.equal(a1.round, b1.round);
      const x = await open(s1, a1.packId, alice, proofs([0]));
      const y = await open(s2, a2.packId, alice, proofs([0]));
      const z = await open(s1, b1.packId, alice);
      assert.notEqual(key(x.cards), key(y.cards));
      assert.notEqual(key(x.cards), key(z.cards));
    });

    it("blocked: no measurable modulo bias - over 20000 seeds the replica's first card follows the deck (chi-square, 14 dof) and templates are uniform within each Kind (bias bound: left / 2^256 and 4096 / 2^128)", async () => {
      const deck = ARC1.counts.flat().map(BigInt);
      const byKind = [0, 1, 2, 3, 4].map((k) => Array.from({ length: 10 }, (_, i) => k * 10 + i));
      const N = 20000;
      const cells = Array(15).fill(0);
      const tpl = Array(50).fill(0);
      for (let i = 0; i < N; i++) {
        const { cards } = draw(deck, BigInt(ethers.keccak256(coder.encode(["uint256"], [i]))), 1, byKind);
        cells[Math.floor(cards[0].tid / 10) * 3 + cards[0].finish - 1]++;
        tpl[cards[0].tid]++;
      }
      let chi = 0;
      for (let c = 0; c < 15; c++) { const e = (N * Number(deck[c])) / 888; chi += (cells[c] - e) ** 2 / e; }
      assert.ok(chi < 36.12, `cell chi-square ${chi.toFixed(1)} (p = 0.001 critical 36.1)`);
      for (let k = 0; k < 5; k++) {
        const n = sum(tpl.slice(k * 10, k * 10 + 10));
        let chiK = 0;
        for (let t = 0; t < 10; t++) chiK += (tpl[k * 10 + t] - n / 10) ** 2 / (n / 10);
        assert.ok(chiK < 27.88, `Kind ${k} template chi-square ${chiK.toFixed(1)}`);
      }
    });

    it("blocked: EvmnetRegistry takes exactly one 64-byte encoding of a round's signature (coordinates + p, the negated point, infinity, other lengths, swapped halves and other rounds all revert), so roundRandomness can never be overwritten with a different value", async () => {
      const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
      const { round, sig } = REAL[0];
      const x = BigInt("0x" + sig.slice(2, 66));
      const y = BigInt("0x" + sig.slice(66, 130));
      const enc = (a, b) => ethers.concat([ethers.toBeHex(a, 32), ethers.toBeHex(b, 32)]);
      assert.equal(enc(x, y), sig);
      await (await registry.proveRound(sig, round)).wait();
      const v = await registry.roundRandomness(round);
      assert.equal(v, ethers.sha256(sig));
      const variants = {
        "x + p": enc(x + P, y),
        "y + p": enc(x, y + P),
        "negated (x, p - y)": enc(x, P - y),
        "infinity (0, 0)": enc(0n, 0n),
        "65 bytes": ethers.concat([sig, "0x00"]),
        "63 bytes": ethers.dataSlice(sig, 0, 63),
        "swapped halves": enc(y, x),
        "the next round's signature": REAL[1].sig,
      };
      for (const [name, bytes] of Object.entries(variants)) {
        await assert.rejects(registry.connect(attacker).proveRound(bytes, round), () => true, name);
        assert.equal(await registry.roundRandomness(round), v, name);
      }
      await (await registry.connect(stranger).proveRound(sig, round)).wait();   // anyone may re-prove: same value
      assert.equal(await registry.roundRandomness(round), v);
    });
  });

  // ============================================================================================ FIFO, gas and liveness
  describe("FIFO, gas and liveness", () => {
    it("FINDING: [info] without a keeper, opening pack N pays for every earlier undealt pack (one BLS proof per distinct round + one deal per pack): past ~94 distinct pending rounds a single openPack exceeds Nitro's 32M cap; deal() in chunks always gets it open", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const run = async (fn) => { const sn = await snapshot(); const out = await fn(); await revert(sn); return out; };
      const g1 = await run(async () => {
        await bindTo(s, 7);
        const { packId } = await buy(bob, s);
        return (await open(s, packId, bob, proofs([7]))).rc.gasUsed;
      });
      const g8p = await run(async () => {   // 8 packs, one round
        await bindTo(s, 7);
        for (let i = 0; i < 7; i++) await buy(alice, s);
        const { packId } = await buy(bob, s);
        return (await open(s, packId, bob, proofs([7]))).rc.gasUsed;
      });
      for (let i = 0; i < 7; i++) { await bindTo(s, i); await buy(alice, s); }   // 8 packs, 8 rounds
      await bindTo(s, 7);
      const last = (await buy(bob, s)).packId;
      assert.deepEqual([...(await s.pendingRounds(last, 16))], REAL.map((r) => r.round));
      const g8r = await run(async () => (await open(s, last, bob, proofs(upTo(7)))).rc.gasUsed);
      for (const chunk of [[0, 1, 2], [3, 4, 5], [6, 7]]) await (await s.connect(stranger).deal(100, ...proofs(chunk))).wait();
      const gChunked = (await open(s, last, bob)).rc.gasUsed;

      const perPack = (g8p - g1) / 7n;
      const perRound = (g8r - g8p) / 7n;
      const maxRounds = (NITRO_TX_CAP - g1) / (perPack + perRound) + 1n;
      console.log(`      lone pack ${g1}; +${perPack} per earlier pack, +${perRound} per extra distinct round; one openPack tops 32M past ~${maxRounds} distinct pending rounds (deck: 178 packs); after chunked deal() it costs ${gChunked}`);
      assert.ok(perRound > 200000n && perPack > 30000n);
      assert.ok(maxRounds < 178n, "a busy, keeper-less sale can make the last pack unopenable in ONE tx");
      assert.ok(gChunked < g1);
    });

    it("blocked: dealing is strictly FIFO - proving a later pack's round first deals nothing and cannot let it jump the queue", async () => {
      const s = await stock(await deployShop());
      await s.setRound(1000);
      const a = await buy(alice, s);
      await s.setRound(2000);
      const b = await buy(bob, s);
      await (await mock.proveRound(fakeSig(b.round), b.round)).wait();
      assert.equal(await s.connect(stranger).deal.staticCall(10, [], []), 0n);
      await rejects(s.connect(bob).openPack(b.packId, ...NONE), "BeaconMissing");
      assert.equal(Number(await s.phaseOf(b.packId)), PHASE.Ready);
      const rc = await (await s.connect(stranger).deal(10, [a.round], [fakeSig(a.round)])).wait();
      assert.deepEqual(events(rc, s, "PackDealt").map((e) => e.args.packId), [a.packId, b.packId]);
    });

    it("blocked: no pack can be made permanently undealable by a mint-time failure: with the MINTER role revoked, deal() still fixes every pack in order, and the cards are unchanged when minting returns", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      const ids = [];
      for (let i = 0; i < 4; i++) { await bindTo(s, i); ids.push((await buy([alice, bob][i % 2], s)).packId); }
      const pred = predict(await readState(s), realRnd);
      await setMinter(s, false);
      await rejects(s.connect(alice).buyPack({ value: PRICE }), "NotMinter");   // no new money is taken
      await rejects(s.connect(alice).openPack(ids[0], ...proofs([0])), "NotMinter");
      await (await s.connect(stranger).deal(100, ...proofs([0, 1, 2, 3]))).wait();
      for (const id of ids) assert.deepEqual(await dealtCards(s, id), pred.get(id));
      await setMinter(s, true);
      for (let i = 0; i < 4; i++) assert.deepEqual((await open(s, ids[i], stranger)).cards, pred.get(ids[i]));
    });

    it("blocked: front-running a victim's openPack (proving its round first, dealing it, or opening it for them) never fails it harmfully or changes its cards", async () => {
      const s = await stock(await deployShop({ beacon: registry }));
      await bindTo(s, 0);
      const a = await buy(alice, s);
      const b = await buy(bob, s);
      const pred = predict(await readState(s), realRnd);
      await (await registry.connect(attacker).proveRound(REAL[0].sig, REAL[0].round)).wait();
      await (await s.connect(attacker).deal(1, [], [])).wait();
      const got = await open(s, a.packId, alice, proofs([0]));   // alice's proofs are now redundant: skipped, no revert
      assert.deepEqual(got.cards, pred.get(a.packId));
      const forBob = await open(s, b.packId, attacker);           // the attacker opens bob's pack: bob gets the cards
      for (const t of forBob.tokenIds) assert.equal(await studio.cards.ownerOf(t), bob.address);
      assert.deepEqual(forBob.cards, pred.get(b.packId));
      await rejects(s.connect(bob).openPack(b.packId, ...NONE), "NotDealt");
    });

    it("blocked: views stay bounded - recentPacks returns at most 16 and pendingRounds at most `max`, deduplicating shared rounds", async () => {
      const s = await stock(await deployShop());
      await s.setRound(500);
      for (let i = 0; i < 20; i++) { if (i % 4 === 0) await s.setRound(500 + i); await buy(alice, s); }
      const r = await s.recentPacks(alice.address, 100);
      assert.equal(r.ids.length, 16);
      assert.equal(r.ids[15], 20n);
      const d = Number(DELAY);
      assert.deepEqual((await s.pendingRounds(20, 100)).map(Number), [500, 504, 508, 512, 516].map((x) => x + d));
      assert.deepEqual((await s.pendingRounds(20, 2)).map(Number), [500 + d, 504 + d]);
    });
  });

  // ============================================================================================ money and re-entrancy
  describe("money and re-entrancy", () => {
    it("blocked: random walk (5 seeds x 180 steps, two with a lazy keeper, of buys, proofs, deals, opens, buyer and stranger refunds, MINTER toggles, withdrawals, forced ETH, pause, price, shutdown): every refund succeeds exactly when the rules allow; liability == sum paid of sealed+dealt packs; withdraw never dips into it; every pack is drawn once, in strict id order, refunded or not, matching the replica; the deck is conserved cell for cell", async function () {
      const FUZZ_DECK = [[20, 3, 1], [15, 3, 1], [12, 2, 1], [7, 2, 1], [3, 1, 1]];   // 73 cards: 14 packs + 3 reserve
      for (const seed of [11, 22, 33, 44, 55]) {
        const lazy = seed >= 44;   // a keeper that rarely proves: sealed packs pile up and get refunded after shutdown
        const runSnap = await snapshot();
        let a = seed >>> 0;
        const rand = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const pick = (xs) => xs[Math.floor(rand() * xs.length)];
        const s = await stock(await deployShop(), { deck: FUZZ_DECK });
        const shopAddr = await s.getAddress();
        const I = s.interface;
        const adv = await deploy("AdversaryV2", shopAddr);
        const advAddr = await adv.getAddress();
        const signerOf = Object.fromEntries([alice, bob, carol, team].map((w) => [w.address, w]));
        const byKind = await Promise.all([0, 1, 2, 3, 4].map(async (k) => (await s.activeTemplates(k)).map(Number)));
        let jsDeck = flat(await s.deckInitial()).map(BigInt);
        const packs = new Map();   // id -> { buyer, round, count, paid, dealt, opened, refunded }
        let lastDealt = 0n;
        let reserveEvents = 0;
        let minted = 0;
        let round = 1000;
        let shut = false;
        let price = PRICE;
        const tally = { refundOk: 0, refundDenied: 0, sealedRefunds: 0, dealtRefunds: 0 };
        await s.setRound(round);

        const absorb = async (rc) => {
          for (const l of rc.logs) {
            let ev;
            try { ev = s.interface.parseLog(l); } catch { continue; }
            if (!ev) continue;
            if (ev.name === "PackBought") packs.set(ev.args.packId, { buyer: ev.args.buyer, round: ev.args.round, count: 5, paid: ev.args.paid });
            if (ev.name === "ReserveQueued") {
              reserveEvents++;
              assert.equal(await s.packsSold(), await s.packsTotal());
              assert.equal(ev.args.to, team.address);
              packs.set(ev.args.packId, { buyer: team.address, round: ev.args.round, count: Number(ev.args.count), paid: 0n });
            }
            if (ev.name === "PackDealt") {
              const id = ev.args.packId;
              const p = packs.get(id);
              assert.equal(id, lastDealt + 1n, `pack ${id} drawn in strict order (no skips)`);
              assert.ok(!p.dealt, `pack ${id} drawn once`);
              lastDealt = id;
              const r = draw(jsDeck, seedOf(mockRnd(p.round), id, p.buyer, shopAddr), p.count, byKind);
              assert.deepEqual(toCards(ev.args.templateIds, ev.args.finishes), r.cards, `pack ${id} matches the replica`);
              jsDeck = r.deck;
              p.dealt = r.cards;
            }
            if (ev.name === "PackOpened") {
              const p = packs.get(ev.args.packId);
              assert.ok(p.dealt && !p.opened && !p.refunded);
              assert.deepEqual(toCards(ev.args.templateIds, ev.args.finishes), p.dealt);
              assert.deepEqual((await s.finishesOf([...ev.args.tokenIds])).map(Number), p.dealt.map((c) => c.finish));
              p.opened = true;
              minted += ev.args.tokenIds.length;
            }
            if (ev.name === "PackRefunded") {
              const p = packs.get(ev.args.packId);
              assert.ok(!p.opened && !p.refunded);
              assert.equal(ev.args.amount, p.paid);
              p.refunded = true;
              if (p.dealt) tally.dealtRefunds++; else tally.sealedRefunds++;
            }
          }
        };
        const tryTx = async (fn) => { try { await absorb(await (await fn()).wait()); return true; } catch (e) { if (e instanceof assert.AssertionError) throw e; return false; } };

        const attemptRefund = async () => {
          const ids = [...packs.keys()];
          if (!ids.length) return;
          const id = pick(ids);
          const p = packs.get(id);
          const asBuyer = rand() < 0.8;
          const sender = asBuyer ? p.buyer : stranger.address;
          const send = asBuyer && p.buyer === advAddr
            ? (o) => adv.connect(attacker).exec(I.encodeFunctionData("refund", [id]), o)
            : (o) => s.connect(asBuyer ? signerOf[p.buyer] : stranger).refund(id, o);
          const ts = (await ethers.provider.getBlock("latest")).timestamp + 1;
          const ph = Number(await s.phaseOf(id));
          const unposted = (await mock.roundRandomness(p.round)) === ethers.ZeroHash;
          const minterOn = await studio.minter.minters(shopAddr);
          const shutAt = Number(await s.shutdownAt());
          const since = Math.max(Number(await s.roundTime(p.round)), shutAt);
          const sealed = ph === PHASE.Waiting || ph === PHASE.Ready;
          const expected = shutAt !== 0 && sender === p.buyer && ts >= since + GRACE && ((sealed && unposted) || (ph === PHASE.Dealt && !minterOn));
          await rpc("evm_setNextBlockTimestamp", [ts]);
          const ok = await tryTx(() => send({ gasLimit: 600000 }));
          assert.equal(ok, expected, `refund of pack ${id} (phase ${ph}, by ${asBuyer ? "buyer" : "stranger"}, unposted ${unposted}, minter ${minterOn})`);
          tally[ok ? "refundOk" : "refundDenied"]++;
        };

        for (let step = 0; step < 180; step++) {
          if (!shut && rand() < 0.15) {   // the owner and the StudioMinter admin restore sales now and then
            if (await s.paused()) await (await s.connect(owner).unpause()).wait();
            if (!(await studio.minter.minters(shopAddr))) await setMinter(s, true);
          }
          const x = rand();
          const ids = [...packs.keys()];
          if (shut && x < 0.12) {
            await tick(4 * 86400);
          } else if (shut && x < 0.32) {
            await attemptRefund();
          } else if (x < 0.3) {
            const who = pick([alice, bob, carol, null]);
            await tryTx(() => (who ? s.connect(who).buyPack({ value: price }) : adv.connect(attacker).buy({ value: price })));
          } else if (x < 0.38) {
            round += 1 + Math.floor(rand() * 3);
            await s.setRound(round);
          } else if (x < 0.46) {
            const pend = await s.pendingRounds((await s.nextPackId()) - 1n, 8);
            if (pend.length && !(lazy && rand() < (shut ? 0.6 : 0.85))) { const r = pick(pend); await (await mock.proveRound(fakeSig(r), r)).wait(); }
          } else if (x < 0.54) {
            await tryTx(() => s.connect(stranger).deal(1 + Math.floor(rand() * 4), [], []));
          } else if (x < 0.66 && ids.length) {
            const id = pick(ids);
            const pend = rand() < (lazy ? 0.05 : 0.5) ? await s.pendingRounds(id, 16) : [];
            await tryTx(() => s.connect(pick([stranger, alice])).openPack(id, [...pend], pend.map((r) => fakeSig(r))));
          } else if (x < 0.71) {
            const free = (await balance(shopAddr)) - (await s.liability());
            const amt = rand() < 0.2 ? free + 1n : (free * BigInt(Math.floor(rand() * 100))) / 100n;
            const ok = await tryTx(() => s.connect(owner).withdraw(stranger.address, amt));
            assert.equal(ok, amt <= free, "withdraw succeeds exactly up to the free balance");
          } else if (x < 0.73) {
            await rpc("hardhat_setBalance", [shopAddr, ethers.toQuantity((await balance(shopAddr)) + 12345n)]);
          } else if (x < 0.75) {
            price = pick([PRICE, PRICE * 2n, 7n]);
            await (await s.connect(owner).setPrice(price)).wait();
          } else if (x < 0.78) {
            await tryTx(() => ((rand() < 0.3) ? s.connect(owner).pause() : s.connect(owner).unpause()));
          } else if (x < 0.8) {
            await setMinter(s, shut ? rand() < 0.5 : rand() < 0.85);   // mostly on while selling; often off after shutdown
          } else if (x < 0.86 && step > (lazy ? 30 : 90) && !shut) {
            await (await s.connect(owner).shutdown()).wait();
            shut = true;
          } else {
            await attemptRefund();
          }

          // invariants
          let owed = 0n;
          const next = await s.nextToDeal();
          for (const [id, p] of packs) {
            const ph = Number(await s.phaseOf(id));
            if (ph === PHASE.Waiting || ph === PHASE.Ready || ph === PHASE.Dealt) owed += p.paid;
            assert.equal(Boolean(p.dealt), id < next, `pack ${id}: drawn iff behind nextToDeal`);
          }
          const liability = await s.liability();
          assert.equal(liability, owed, `step ${step}: liability`);
          assert.ok((await balance(shopAddr)) >= liability, `step ${step}: balance covers liability`);
          const remaining = flat(await s.deckRemaining()).map(BigInt);
          for (let c = 0; c < 15; c++) assert.equal(remaining[c], jsDeck[c], `step ${step}: cell ${c}`);
          assert.ok(minted <= 73 && reserveEvents <= 1);
        }
        const all = [...packs.values()];
        console.log(`      seed ${seed}: ${packs.size} packs, ${all.filter((p) => p.dealt).length} drawn, ${all.filter((p) => p.opened).length} opened, refunds ${tally.refundOk} ok (${tally.sealedRefunds} sealed, ${tally.dealtRefunds} dealt) / ${tally.refundDenied} denied, ${minted} cards minted, reserve ${reserveEvents}x`);
        await revert(runSnap);
      }
    });

    it("blocked: a hostile receiver cannot re-enter refund, openPack, deal or buyPack while being paid by refund() or withdraw()", async () => {
      const s = await stock(await deployShop());
      const adv = await deploy("AdversaryV2", await s.getAddress());
      await s.setRound(1000);
      const v = await buy(alice, s);
      await (await mock.proveRound(fakeSig(v.round), v.round)).wait();
      await open(s, v.packId, alice);   // PRICE of revenue is now withdrawable
      await s.setRound(2000);
      await (await adv.connect(attacker).buy({ value: PRICE })).wait();
      const p1 = await adv.lastPackId();
      await s.setRound(3000);
      await (await adv.connect(attacker).buy({ value: PRICE })).wait();
      const p2 = await adv.lastPackId();
      const I = s.interface;
      const calls = [I.encodeFunctionData("refund", [p1]), I.encodeFunctionData("openPack", [p2, [], []]), I.encodeFunctionData("deal", [10, [], []]), I.encodeFunctionData("buyPack", [])];

      await (await adv.arm(calls, [0n, 0n, 0n, PRICE])).wait();
      await (await s.connect(owner).withdraw(await adv.getAddress(), PRICE)).wait();
      assert.deepEqual([...(await adv.errors())], Array(4).fill(REENTRANT));
      assert.equal(await adv.successes(), 0n);

      await shutdownAndWait(s);
      await (await adv.arm(calls.slice(1).concat(I.encodeFunctionData("refund", [p2])), [0n, 0n, PRICE, 0n])).wait();
      await (await adv.connect(attacker).exec(I.encodeFunctionData("refund", [p1]))).wait();
      assert.deepEqual([...(await adv.errors())], Array(4).fill(REENTRANT));
      assert.equal(await adv.successes(), 0n);
      assert.equal(Number(await s.phaseOf(p2)), PHASE.Ready);   // untouched by the failed re-entry; still refundable normally
      await (await adv.connect(attacker).exec(I.encodeFunctionData("refund", [p2]))).wait();
      assert.equal(await adv.received(), PRICE * 3n);
      assert.equal(await s.liability(), 0n);
    });

    it("blocked: the mint path never calls the recipient (RaptureCards uses _mint): a buyer contract whose onERC721Received reverts still gets its cards, so minting offers no re-entry or reject hook", async () => {
      const s = await stock(await deployShop());
      const adv = await deploy("AdversaryV2", await s.getAddress());
      await (await adv.setRejectNfts(true)).wait();
      await (await adv.connect(attacker).buy({ value: PRICE })).wait();
      await keeper(s);
      const got = await open(s, await adv.lastPackId(), stranger);
      for (const t of got.tokenIds) assert.equal(await studio.cards.ownerOf(t), await adv.getAddress());
    });
  });

  // ============================================================================================ owner, deck and edges
  describe("owner powers, deck and edge cases", () => {
    it("blocked: after lock() the owner cannot add or retire templates, reset the deck or reserve, or lock again; StudioMinter has no band setter", async () => {
      const s = await stock(await deployShop());
      await rejects(s.connect(owner).addTemplates([template(4, 77)]), "IsLocked");
      await rejects(s.connect(owner).retireTemplate(0), "IsLocked");
      await rejects(s.connect(owner).setDeck(ARC1.counts, owner.address), "IsLocked");
      await rejects(s.connect(owner).lock(), "IsLocked");
      const fns = studio.minter.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name);
      assert.deepEqual(fns.sort(), ["mintBatch", "mintStudio", "setMinter", "transferAdmin"]);
      assert.equal(await s.reserveTo(), team.address);
    });

    it("blocked: packSize 1..6 each sell out to exactly the deck; the reserve (total % packSize) is queued once, by the last sale, to reserveTo; 6-card packs fit Pack.cards", async () => {
      const pool = [0, 10, 20, 30, 40].map((i) => POOL[i]);   // one template per Kind: ids 0..4 = Kind 0..4
      const deck = [[3, 1, 1], [2, 0, 1], [1, 1, 0], [1, 0, 0], [0, 1, 1]];   // 13 cards, all Kinds and finishes
      for (let size = 1; size <= 6; size++) {
        const s = await stock(await deployShop({ packSize: size }), { pool, deck });
        const packs = Math.floor(13 / size);
        const reserve = 13 % size;
        assert.equal(await s.packsTotal(), BigInt(packs));
        assert.equal(await s.reserveSize(), BigInt(reserve));
        let queued = [];
        for (let i = 0; i < packs; i++) {
          const b = await buy([alice, bob][i % 2], s);
          queued = queued.concat(events(b.rc, s, "ReserveQueued"));
          if (i < packs - 1) assert.equal(queued.length, 0);
        }
        await rejects(s.connect(carol).buyPack({ value: PRICE }), "SoldOut");
        assert.equal(queued.length, reserve > 0 ? 1 : 0);
        if (reserve) assert.equal(queued[0].args.to, team.address);
        await keeper(s);
        const out = Array(15).fill(0);
        const total = Number(await s.nextPackId()) - 1;
        for (let id = 1; id <= total; id++) {
          const r = await open(s, id, stranger);
          const holder = reserve && id === total ? team.address : [alice, bob][(id - 1) % 2].address;
          for (const t of r.tokenIds) assert.equal(await studio.cards.ownerOf(t), holder);
          r.cards.forEach((c) => out[pool[c.tid].kind * 3 + c.finish - 1]++);
        }
        assert.deepEqual(out, deck.flat(), `packSize ${size}`);
        assert.equal(await s.cardsLeft(), 0n);
        assert.equal(await s.liability(), 0n);
      }
    });

    it("blocked: decks with empty cells - a single-cell deck (5 Gold Gods, God templates only, no reserve, reserveTo zero) locks and deals exactly; an all-zero deck or one smaller than a pack does not lock", async () => {
      const s = await deployShop();
      await stock(s, { pool: POOL.slice(40), deck: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 5]], reserveTo: ethers.ZeroAddress });
      assert.equal(await s.maxSupply(), 5n);
      assert.equal(await s.reserveSize(), 0n);
      const b = await buy(alice, s);
      assert.equal(events(b.rc, s, "ReserveQueued").length, 0);
      await rejects(s.connect(bob).buyPack({ value: PRICE }), "SoldOut");
      await keeper(s);
      const r = await open(s, b.packId, alice);
      assert.ok(r.cards.every((c) => c.finish === 3 && c.tid < 10));   // tids index the God-only pool
      const z = await deployShop();
      await (await z.connect(owner).addTemplates(POOL.slice(0, 10))).wait();
      await (await z.connect(owner).setDeck([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], ethers.ZeroAddress)).wait();
      await rejects(z.connect(owner).lock(), "BadDeck");
      await (await z.connect(owner).setDeck([[4, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], ethers.ZeroAddress)).wait();
      await rejects(z.connect(owner).lock(), "BadDeck");
    });

    it("blocked: setDeck cannot overflow a uint16 cell (65536 is rejected at ABI decoding); 65535 in all 15 cells (983025 cards) locks and deals correctly", async () => {
      const s = await deployShop();
      for (let i = 0; i < 50; i += 10) await (await s.connect(owner).addTemplates(POOL.slice(i, i + 10))).wait();
      const full = Array.from({ length: 5 }, () => [65535, 65535, 65535]);
      const data = s.interface.encodeFunctionData("setDeck", [full, team.address]);
      const bad = data.slice(0, 10) + ethers.toBeHex(65536, 32).slice(2) + data.slice(74);
      await assert.rejects(owner.sendTransaction({ to: await s.getAddress(), data: bad, gasLimit: 300000 }));
      assert.equal(await s.cardsLeft(), 0n);
      await (await owner.sendTransaction({ to: await s.getAddress(), data })).wait();
      await (await s.connect(owner).lock()).wait();
      await setMinter(s, true);
      await (await s.connect(owner).unpause()).wait();
      assert.equal(await s.maxSupply(), 983025n);
      assert.equal(await s.packsTotal(), 196605n);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await buy(alice, s)).packId);
      const want = predict(await readState(s), mockRnd);
      await keeper(s);
      for (const id of ids) assert.deepEqual((await open(s, id, alice)).cards, want.get(id));
      assert.equal(await s.cardsLeft(), 983025n - 15n);
    });

    it("blocked: retiring templates before lock - a Kind with cards and no template left cannot lock; a partly retired Kind never deals a retired template", async () => {
      const s = await deployShop();
      for (let i = 0; i < 50; i += 10) await (await s.connect(owner).addTemplates(POOL.slice(i, i + 10))).wait();
      for (let t = 40; t < 50; t++) await (await s.connect(owner).retireTemplate(t)).wait();
      await (await s.connect(owner).setDeck(ARC1.counts, team.address)).wait();
      await rejects(s.connect(owner).lock(), "BadDeck");
      await (await s.connect(owner).addTemplates([POOL[40]])).wait();   // the design hash was freed: re-added as id 50
      for (const t of [0, 3, 9, 15]) await (await s.connect(owner).retireTemplate(t)).wait();
      await (await s.connect(owner).lock()).wait();
      assert.deepEqual((await s.activeTemplates(4)).map(Number), [50]);
      const { cells, perTemplate } = await s.drawAll(5);
      assert.deepEqual(cells.map(Number), ARC1.counts.flat());
      for (const t of [0, 3, 9, 15, ...Array.from({ length: 10 }, (_, i) => 40 + i)]) assert.equal(perTemplate[t], 0n, `retired ${t}`);
      assert.equal(perTemplate[50], 89n);
    });

    it("blocked: price at the uint96 bound - 2^96-1 is taken, recorded and refunded exactly; 2^96 is refused by setPrice and the constructor", async () => {
      const MAX = 2n ** 96n - 1n;
      await rejects(deployShop({ price: MAX + 1n }), "WrongPayment");
      const s = await stock(await deployShop());
      await rejects(s.connect(owner).setPrice(MAX + 1n), "WrongPayment");
      await (await s.connect(owner).setPrice(MAX)).wait();
      await rpc("hardhat_setBalance", [alice.address, ethers.toQuantity(2n ** 100n)]);
      const { packId } = await buy(alice, s, MAX);
      assert.equal((await s.packOf(packId)).paid, MAX);
      assert.equal(await s.liability(), MAX);
      await shutdownAndWait(s);
      const before = await balance(alice.address);
      const rc = await (await s.connect(alice).refund(packId)).wait();   // sealed, round never posted
      assert.equal(await balance(alice.address), before + MAX - rc.fee);
      assert.equal(await s.liability(), 0n);
    });

    it("blocked: the daily limit is per wallet per UTC day and rolls over exactly at midnight; lowering it mid-day stops further buys", async () => {
      const s = await stock(await deployShop({ limit: 2 }));
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const midnight = (Math.floor(now / 86400) + 2) * 86400;
      const at = async (ts, fn) => { await rpc("evm_setNextBlockTimestamp", [ts]); return fn(); };
      await at(midnight - 5, () => buy(alice, s));
      await at(midnight - 4, () => buy(alice, s));
      assert.equal(await s.packsLeftToday(alice.address), 0n);
      await at(midnight - 1, () => rejects(s.connect(alice).buyPack({ value: PRICE, gasLimit: 500000 }), "DailyLimitReached"));
      await at(midnight, () => buy(alice, s));
      await at(midnight + 1, () => buy(alice, s));
      await at(midnight + 2, () => rejects(s.connect(alice).buyPack({ value: PRICE, gasLimit: 500000 }), "DailyLimitReached"));
      await at(midnight + 3, () => buy(bob, s));
      await (await s.connect(owner).setDailyLimit(1)).wait();
      await rejects(s.connect(bob).buyPack({ value: PRICE }), "DailyLimitReached");
      await (await s.connect(owner).setDailyLimit(0)).wait();
      for (let i = 0; i < 5; i++) await buy(bob, s);
    });
  });
});
