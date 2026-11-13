const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { ethers } = require("hardhat");
const { deployStudio } = require("./helpers/deployStudio.js");
const { template, POOL } = require("./helpers/templates.js");
const EVMNET = require("./fixtures/evmnet-rounds.json");
const ARC1 = require("../examples/rapture/deck.arc1.json");

const PRICE = ethers.parseEther("0.001");
const PHASE = { None: 0, Waiting: 1, Ready: 2, Dealt: 3, Opened: 4, Refunded: 5 };
const FINISH = { None: 0, Normal: 1, Shiny: 2, Gold: 3 };
const DELAY = 5n;
const GRACE = 7 * 86400;
const NONE = [[], []];   // openPack / deal with no beacons to prove

async function rejects(promise, error) {
  const selector = ethers.id(`${error}()`).slice(0, 10);
  await assert.rejects(promise, (e) => {
    const msg = String(e.message) + JSON.stringify(e.data ?? "");
    assert.ok(msg.includes(error) || msg.includes(selector), `expected ${error}, got: ${msg.slice(0, 240)}`);
    return true;
  });
}
const rpc = (method, params = []) => ethers.provider.send(method, params);
const tick = (seconds) => rpc("evm_increaseTime", [seconds]).then(() => rpc("hardhat_mine", ["0x1"]));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const flat = (deck) => Array.from(deck, (row) => Array.from(row, Number)).flat();
const fakeSig = (round) => ethers.toUtf8Bytes(`sig-${round}`);

describe("PackShopV2", function () {
  this.timeout(900000);

  let owner, alice, bob, stranger, team;
  let studio, beacon, shop, snap;

  async function deployShop({ name = "PackShopV2Harness", registry = beacon, packSize = 5, limit = 0 } = {}) {
    const f = await ethers.getContractFactory(name);
    const s = await f.deploy(studio.minter, registry, owner.address, PRICE, packSize, limit);
    await s.waitForDeployment();
    return s;
  }
  async function stock(s, { pool = POOL, deck = ARC1.counts, reserveTo = team.address, lock = true } = {}) {
    for (let i = 0; i < pool.length; i += 10) await (await s.connect(owner).addTemplates(pool.slice(i, i + 10))).wait();
    await (await s.connect(owner).setDeck(deck, reserveTo)).wait();
    if (lock) await (await s.connect(owner).lock()).wait();
    await (await studio.minter.setMinter(await s.getAddress(), true)).wait();
    await (await s.connect(owner).unpause()).wait();
    return s;
  }
  const events = (rc, s, name) => rc.logs.map((l) => { try { return s.interface.parseLog(l); } catch { return null; } }).filter((l) => l?.name === name);
  const buy = async (who = alice, s = shop) => {
    const rc = await (await s.connect(who).buyPack({ value: PRICE })).wait();
    const ev = events(rc, s, "PackBought")[0];
    return { packId: ev.args.packId, round: ev.args.round, rc };
  };
  const prove = (round, reg = beacon) => reg.proveRound(fakeSig(round), round).then((t) => t.wait());
  const open = async (packId, who = alice, s = shop, beacons = NONE) => {
    const rc = await (await s.connect(who).openPack(packId, ...beacons)).wait();
    const ev = events(rc, s, "PackOpened")[0];
    return { tokenIds: [...ev.args.tokenIds], templateIds: ev.args.templateIds.map(Number), finishes: ev.args.finishes.map(Number), rc };
  };

  before(async () => {
    let deployer;
    [deployer, owner, alice, bob, stranger, team] = await ethers.getSigners();
    studio = await deployStudio(ethers, { minters: [deployer.address] });
    beacon = await (await ethers.getContractFactory("MockEvmnetRegistry")).deploy();
    shop = await stock(await deployShop());
  });
  beforeEach(async () => { snap = await rpc("evm_snapshot"); });
  afterEach(async () => { await rpc("evm_revert", [snap]); });

  describe("setup, deck and lock", () => {
    it("deploys paused and unlocked; the ARC 1 deck locks to 888 = 177 packs + a 3-card reserve", async () => {
      const fresh = await deployShop();
      assert.equal(await fresh.paused(), true);
      assert.equal(await fresh.locked(), false);
      await rejects(fresh.connect(alice).buyPack({ value: PRICE }), "EnforcedPause");

      const c = await shop.config();
      assert.equal(c.maxSupply_, 888n);
      assert.equal(c.packsTotal_, 177n);
      assert.equal(c.packsSold_, 0n);
      assert.equal(c.cardsLeft_, 888n);
      assert.equal(await shop.reserveSize(), 3n);
      assert.equal(await shop.reserveTo(), team.address);
      assert.deepEqual(flat(await shop.deckInitial()), ARC1.counts.flat());
      assert.equal(sum(ARC1.counts.flat()), ARC1.total);
      assert.equal(c.ready_, true);
    });

    it("rejects a zero or code-less minter/beacon and a bad pack size", async () => {
      const f = await ethers.getContractFactory("PackShopV2");
      await rejects(f.deploy(ethers.ZeroAddress, beacon, owner.address, PRICE, 5, 0), "ZeroAddress");
      await rejects(f.deploy(studio.minter, stranger.address, owner.address, PRICE, 5, 0), "BadMinter");
      await rejects(f.deploy(studio.minter, beacon, owner.address, PRICE, 0, 0), "BadPackSize");
      await rejects(f.deploy(studio.minter, beacon, owner.address, PRICE, 7, 0), "BadPackSize");
    });

    it("will not lock a deck with cards for a Kind that has no template, or a reserve with no recipient", async () => {
      const s = await deployShop();
      await (await s.connect(owner).addTemplates(POOL.slice(0, 10))).wait();   // Mortals only
      await (await s.connect(owner).setDeck(ARC1.counts, team.address)).wait();
      await rejects(s.connect(owner).lock(), "BadDeck");
      await (await s.connect(owner).setDeck([[13, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], ethers.ZeroAddress)).wait();
      await rejects(s.connect(owner).lock(), "ZeroAddress");   // 13 % 5 = 3 reserve cards need somewhere to go
      await (await s.connect(owner).setDeck([[3, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], team.address)).wait();
      await rejects(s.connect(owner).lock(), "BadDeck");       // smaller than one pack
      await rejects(s.connect(owner).buyPack({ value: PRICE }), "EnforcedPause");
    });

    it("freezes templates and deck at lock(): no re-roll lever is left", async () => {
      await rejects(shop.connect(owner).addTemplates([template(4, 99)]), "IsLocked");
      await rejects(shop.connect(owner).retireTemplate(0), "IsLocked");
      await rejects(shop.connect(owner).setDeck(ARC1.counts, team.address), "IsLocked");
      await rejects(shop.connect(owner).lock(), "IsLocked");
    });

    it("only the owner configures; ownership is two-step and cannot be renounced", async () => {
      const s = await deployShop();
      await rejects(s.connect(alice).addTemplates(POOL.slice(0, 1)), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).setDeck(ARC1.counts, alice.address), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).lock(), "OwnableUnauthorizedAccount");
      await rejects(shop.connect(alice).shutdown(), "OwnableUnauthorizedAccount");
      await rejects(shop.connect(owner).renounceOwnership(), "RenounceDisabled");
      await (await shop.connect(owner).transferOwnership(bob.address)).wait();
      assert.equal(await shop.owner(), owner.address);
      await (await shop.connect(bob).acceptOwnership()).wait();
      assert.equal(await shop.owner(), bob.address);
    });

    it("validates templates at load, as v1 does", async () => {
      const s = await deployShop();
      const bad = template(0, 1);
      bad.traits.strength = 1;   // below the Mortal band
      await rejects(s.connect(owner).addTemplates([bad]), "BadTemplate");
      await (await s.connect(owner).addTemplates([template(0, 1)])).wait();
      await rejects(s.connect(owner).addTemplates([template(0, 1)]), "DuplicateDesign");
    });
  });

  describe("buying", () => {
    it("binds the pack to drand round currentRound + 5, and the production clock is drand's", async () => {
      const prod = await stock(await deployShop({ name: "PackShopV2" }));
      const { packId, round, rc } = await buy(alice, prod);
      const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
      const expected = BigInt(Math.floor((ts - EVMNET.info.genesis_time) / EVMNET.info.period) + 1);
      assert.equal(round, expected + DELAY);
      assert.equal(await prod.roundTime(round), BigInt(EVMNET.info.genesis_time) + (round - 1n) * 3n);
      assert.equal(await prod.phaseOf(packId), BigInt(PHASE.Waiting));
      await tick(18);
      assert.equal(await prod.phaseOf(packId), BigInt(PHASE.Ready));
    });

    it("never binds a round at or below the latest one proven here: a keeper's fresh round overrides a lagging clock", async () => {
      await shop.setRound(1000);   // the chain clock says round 1000 ...
      await (await shop.connect(stranger).deal(0, [5000n], [fakeSig(5000)])).wait();   // ... but round 5000 is already public
      assert.equal(await shop.latestRound(), 5000n);
      const { round } = await buy(alice);
      assert.equal(round, 5000n + DELAY);
    });

    it("takes the exact price only, counts toward the daily limit, and holds it as liability", async () => {
      await rejects(shop.connect(alice).buyPack({ value: PRICE - 1n }), "WrongPayment");
      await rejects(shop.connect(alice).buyPack({ value: PRICE + 1n }), "WrongPayment");
      await (await shop.connect(owner).setDailyLimit(2)).wait();
      await buy(alice);
      await buy(alice);
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "DailyLimitReached");
      await buy(bob);
      assert.equal(await shop.liability(), PRICE * 3n);
      assert.equal(await shop.packsSold(), 3n);
    });

    it("refuses to sell without the MINTER role, so no paid pack is undeliverable", async () => {
      await (await studio.minter.setMinter(await shop.getAddress(), false)).wait();
      assert.equal(await shop.ready(), false);
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "NotMinter");
    });

    it("a price change never touches packs already sold", async () => {
      const { packId } = await buy(alice);
      await (await shop.connect(owner).setPrice(PRICE * 10n)).wait();
      const p = await shop.packOf(packId);
      assert.equal(p.paid, PRICE);
    });
  });

  describe("dealing and opening", () => {
    it("cannot open before the round is proven; then deals from the deck and mints 5 cards with finishes", async () => {
      const { packId, round } = await buy(alice);
      await rejects(shop.connect(alice).openPack(packId, ...NONE), "BeaconMissing");
      await prove(round);
      const before = flat(await shop.deckRemaining());
      const { tokenIds, templateIds, finishes, rc } = await open(packId, stranger);   // anyone may open
      assert.equal(tokenIds.length, 5);
      for (const id of tokenIds) assert.equal(await studio.cards.ownerOf(id), alice.address);   // always to the buyer
      for (let i = 0; i < 5; i++) assert.equal(Number(await shop.finishOf(tokenIds[i])), finishes[i]);
      assert.ok(finishes.every((f) => f >= FINISH.Normal && f <= FINISH.Gold));

      // the deck lost exactly these five cards, cell by cell
      const after = flat(await shop.deckRemaining());
      const taken = before.map((n, c) => n - after[c]);
      const expected = Array(15).fill(0);
      for (let i = 0; i < 5; i++) expected[POOL[templateIds[i]].kind * 3 + finishes[i] - 1]++;
      assert.deepEqual(taken, expected);
      assert.equal(await shop.cardsLeft(), 883n);
      assert.equal(await shop.liability(), 0n);
      assert.equal(await shop.phaseOf(packId), BigInt(PHASE.Opened));
      assert.deepEqual([...await shop.tokensOf(packId)], tokenIds);   // a client whose pack a keeper opened finds its tokens
      assert.deepEqual([...await shop.tokensOf(packId + 1n)], []);
      assert.equal(events(rc, shop, "PackDealt").length, 1);
      await rejects(shop.connect(alice).openPack(packId, ...NONE), "NotDealt");   // never twice
      console.log(`      openPack gas (mock beacon, 5 mints): ${rc.gasUsed}`);
    });

    it("deals strictly in purchase order: opening a later pack deals the earlier ones first", async () => {
      const a = await buy(alice);
      const b = await buy(bob);
      await prove(a.round);
      if (b.round !== a.round) await prove(b.round);
      const { rc } = await open(b.packId, bob);
      const dealt = events(rc, shop, "PackDealt").map((e) => e.args.packId);
      assert.deepEqual(dealt, [a.packId, b.packId]);
      assert.equal(await shop.phaseOf(a.packId), BigInt(PHASE.Dealt));
      const p = await shop.packOf(a.packId);
      const minted = await open(a.packId, stranger);   // alice's dealt cards are exactly what she gets
      assert.deepEqual(minted.templateIds, p.templateIds.map(Number));
      assert.deepEqual(minted.finishes, p.finishes.map(Number));
    });

    it("the result does not depend on who opens or when: dealt cards are fixed once the round is proven", async () => {
      const { packId, round } = await buy(alice);
      await prove(round);
      const s1 = await rpc("evm_snapshot");
      const first = await open(packId, alice);
      await rpc("evm_revert", [s1]);
      await tick(86400);
      await (await shop.connect(owner).setPrice(1n)).wait();
      const second = await open(packId, stranger);
      assert.deepEqual(second.templateIds, first.templateIds);
      assert.deepEqual(second.finishes, first.finishes);
    });

    it("deal() lets a keeper fix packs in bulk and stops quietly at the first unproven round", async () => {
      await shop.setRound(1000);
      const a = await buy(alice);
      const b = await buy(bob);
      await shop.setRound(2000);
      const c = await buy(stranger);
      assert.deepEqual((await shop.pendingRounds(c.packId, 8)).map(Number), [1005, 2005]);
      await (await shop.connect(stranger).deal(10, [1005n], [fakeSig(1005)])).wait();
      assert.equal(await shop.nextToDeal(), c.packId);
      assert.equal(await shop.phaseOf(a.packId), BigInt(PHASE.Dealt));
      assert.equal(await shop.phaseOf(b.packId), BigInt(PHASE.Dealt));
      assert.deepEqual((await shop.pendingRounds(c.packId, 8)).map(Number), [2005]);
      await rejects(shop.connect(stranger).deal(1, [2005n], []), "BadProof");
      await open(c.packId, stranger, shop, [[2005n], [fakeSig(2005)]]);
    });

    it("sells out exactly: the last sale queues the reserve, and the whole deck comes out cell for cell", async () => {
      // 2 packs + a 3-card reserve: 13 cards, every Kind and finish represented
      const deck = [[3, 1, 1], [2, 0, 1], [1, 1, 0], [1, 0, 0], [0, 1, 1]];
      const s = await stock(await deployShop(), { deck });
      assert.equal(await s.packsTotal(), 2n);
      const a = await buy(alice, s);
      const b = await buy(bob, s);
      const queued = events(b.rc, s, "ReserveQueued")[0];
      assert.equal(queued.args.to, team.address);
      assert.equal(queued.args.count, 3n);
      await rejects(s.connect(stranger).buyPack({ value: PRICE }), "SoldOut");
      assert.equal(await s.ready(), false);

      await prove(a.round);
      if (b.round !== a.round) await prove(b.round);
      const out = Array(15).fill(0);
      for (const [id, who] of [[a.packId, alice], [b.packId, bob], [queued.args.packId, team]]) {
        const r = await open(id, stranger, s);
        for (const t of r.tokenIds) assert.equal(await studio.cards.ownerOf(t), who.address);
        r.templateIds.forEach((tid, i) => out[POOL[tid].kind * 3 + r.finishes[i] - 1]++);
      }
      assert.deepEqual(out, deck.flat());
      assert.equal(await s.cardsLeft(), 0n);
    });

    it("dealing the full ARC 1 deck gives exactly its counts, with designs spread evenly inside each Kind", async () => {
      const { cells, perTemplate } = await shop.drawAll(7);
      assert.deepEqual(cells.map(Number), ARC1.counts.flat());
      const kindTotals = ARC1.counts.map((r) => sum(r));
      for (let k = 0; k < 5; k++) {
        const counts = perTemplate.slice(k * 10, k * 10 + 10).map(Number);
        assert.equal(sum(counts), kindTotals[k]);
        const mean = kindTotals[k] / 10;
        for (const n of counts) assert.ok(Math.abs(n - mean) < 4 * Math.sqrt(mean) + 2, `Kind ${k} template count ${n} vs mean ${mean}`);
      }
    });
  });

  describe("real drand evmnet signatures", () => {
    let registry;
    before(async () => {
      registry = await (await ethers.getContractFactory("EvmnetRegistry")).deploy();
      await registry.waitForDeployment();
    });

    it("EvmnetRegistry verifies real rounds and stores sha256(signature), drand's own randomness", async () => {
      for (const { round, signature } of EVMNET.rounds.slice(0, 3)) {
        const rc = await (await registry.proveRound(signature, round)).wait();
        const expected = "0x" + createHash("sha256").update(Buffer.from(signature.slice(2), "hex")).digest("hex");
        assert.equal(await registry.roundRandomness(round), expected);
        if (round === EVMNET.rounds[0].round) console.log(`      proveRound gas: ${rc.gasUsed}`);
      }
    });

    it("rejects a signature for another round and a tampered signature", async () => {
      const [r0, r1] = EVMNET.rounds;
      await assert.rejects(registry.proveRound(r0.signature, r1.round), /Invalid signature|reverted/);
      const bytes = ethers.getBytes(r0.signature);
      bytes[63] ^= 1;
      await assert.rejects(registry.proveRound(bytes, r0.round), /Invalid signature|reverted/);
      assert.equal(await registry.roundRandomness(r1.round), ethers.ZeroHash);
    });

    it("end to end: a pack bound to a real evmnet round opens with that round's signature", async () => {
      const s = await stock(await deployShop({ registry }));
      const target = EVMNET.rounds[5];
      await s.setRound(BigInt(target.round) - DELAY);
      const { packId, round } = await buy(alice, s);
      assert.equal(round, BigInt(target.round));
      await rejects(s.connect(alice).openPack(packId, [round], [EVMNET.rounds[4].signature]), "reverted");
      const r = await open(packId, alice, s, [[round], [target.signature]]);
      assert.equal(r.tokenIds.length, 5);
      console.log(`      openPack gas (real BLS proof + deal + 5 mints): ${r.rc.gasUsed}`);
    });
  });

  describe("money, shutdown and refunds", () => {
    it("withdraw only reaches revenue above unopened packs' liability", async () => {
      const a = await buy(alice);
      await buy(bob);
      await rejects(shop.connect(owner).withdraw(owner.address, 1n), "Insufficient");
      await prove(a.round);
      await open(a.packId);
      await rejects(shop.connect(owner).withdraw(owner.address, PRICE + 1n), "Insufficient");
      const before = await ethers.provider.getBalance(stranger.address);
      await (await shop.connect(owner).withdraw(stranger.address, PRICE)).wait();
      assert.equal(await ethers.provider.getBalance(stranger.address), before + PRICE);
    });

    it("pause stops sales but never opening", async () => {
      const { packId, round } = await buy(alice);
      await (await shop.connect(owner).pause()).wait();
      await rejects(shop.connect(bob).buyPack({ value: PRICE }), "EnforcedPause");
      await prove(round);
      await open(packId, alice);
    });

    it("there is no refund while the shop runs: nothing to skip once a pull is decided", async () => {
      const { packId } = await buy(alice);
      await tick(30 * 86400);
      await rejects(shop.connect(alice).refund(packId), "NotRefundable");
    });

    it("after shutdown: only the buyer refunds, and only a pack that cannot be delivered", async () => {
      await shop.setRound(100);
      const a = await buy(alice);
      await shop.setRound(200);
      const b = await buy(bob);
      const c = await buy(stranger);
      await (await shop.connect(owner).shutdown()).wait();
      await rejects(shop.connect(owner).shutdown(), "IsShutdown");
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "IsShutdown");
      await rejects(shop.connect(alice).refund(a.packId), "NotRefundable");   // grace not over
      await tick(GRACE + 60);
      await rejects(shop.connect(stranger).refund(a.packId), "NotRefundable");   // not the buyer

      // b's round is proven: b is deliverable, so it deals instead of refunding, even sealed
      await (await shop.connect(stranger).deal(0, [b.round], [fakeSig(b.round)])).wait();
      await rejects(shop.connect(bob).refund(b.packId), "NotRefundable");

      // a's round never proven (say drand is down): alice may take her price back
      const before = await ethers.provider.getBalance(alice.address);
      const rc = await (await shop.connect(alice).refund(a.packId)).wait();
      assert.equal(await ethers.provider.getBalance(alice.address), before + PRICE - rc.gasUsed * rc.gasPrice);
      await rejects(shop.connect(alice).refund(a.packId), "NotRefundable");   // once

      // a dealt pack refunds only once the shop can no longer mint
      await (await shop.connect(stranger).deal(10, [a.round], [fakeSig(a.round)])).wait();
      assert.equal(await shop.phaseOf(c.packId), BigInt(PHASE.Dealt));
      await rejects(shop.connect(stranger).refund(c.packId), "NotRefundable");
      await (await studio.minter.setMinter(await shop.getAddress(), false)).wait();
      await (await shop.connect(stranger).refund(c.packId)).wait();
      await (await studio.minter.setMinter(await shop.getAddress(), true)).wait();
      await open(b.packId, bob);   // b still opens normally
      await rejects(shop.connect(bob).refund(b.packId), "NotRefundable");   // opened
      assert.equal(await shop.liability(), 0n);
    });

    it("a sealed pack refunded after shutdown is still drawn: later packs get exactly the cards they would have", async () => {
      await shop.setRound(100);
      const a = await buy(alice);
      await shop.setRound(200);
      const b = await buy(bob);
      const beacons = [[a.round, b.round], [fakeSig(a.round), fakeSig(b.round)]];
      const s1 = await rpc("evm_snapshot");
      const honest = await open(b.packId, bob, shop, beacons);
      await rpc("evm_revert", [s1]);
      await (await shop.connect(owner).shutdown()).wait();
      await tick(GRACE + 60);
      await (await shop.connect(alice).refund(a.packId)).wait();
      const after = await open(b.packId, bob, shop, beacons);
      assert.deepEqual(after.templateIds, honest.templateIds);
      assert.deepEqual(after.finishes, honest.finishes);
      assert.equal(await shop.phaseOf(a.packId), BigInt(PHASE.Refunded));
      assert.equal(await shop.cardsLeft(), 878n);   // a's five cards left the deck unminted
    });

    it("a refund cannot be re-entered", async () => {
      const attacker = await (await ethers.getContractFactory("ReentrantBuyerV2")).deploy(shop);
      await (await attacker.buy({ value: PRICE })).wait();
      await (await shop.connect(owner).shutdown()).wait();
      await tick(GRACE + 100);
      await (await attacker.arm()).wait();
      await (await attacker.refund()).wait();
      assert.equal(await attacker.reenterSucceeded(), false);
      assert.equal(await ethers.provider.getBalance(await attacker.getAddress()), PRICE);
    });
  });
});
