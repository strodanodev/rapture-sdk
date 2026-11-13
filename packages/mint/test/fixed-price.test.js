// FixedPriceMinter against the reference collection (the Studio contracts the live Rapture collection runs).
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { deployStudio } = require("./helpers/deployStudio.js");
const { template, POOL } = require("./helpers/templates.js");

const PRICE = ethers.parseEther("0.002");
const SUPPLY = 3;

async function rejects(promise, error) {
  const selector = ethers.id(`${error}()`).slice(0, 10);
  await assert.rejects(promise, (e) => {
    const msg = String(e.message) + JSON.stringify(e.data ?? "");
    assert.ok(msg.includes(error) || msg.includes(selector), `expected ${error}, got: ${msg.slice(0, 240)}`);
    return true;
  });
}
const rpc = (method, params = []) => ethers.provider.send(method, params);

describe("FixedPriceMinter", function () {
  let deployer, owner, alice, bob, stranger;
  let studio, shop, snap;

  async function deploy({ price = PRICE, limit = 0 } = {}) {
    const f = await ethers.getContractFactory("FixedPriceMinter");
    const s = await f.deploy(studio.minter, owner.address, price, limit);
    await s.waitForDeployment();
    return s;
  }
  async function stock(s, { pool = POOL.slice(0, 10), supply = SUPPLY, grant = true, open = true } = {}) {
    await (await s.connect(owner).addTemplates(pool, pool.map(() => supply))).wait();
    if (grant) await (await studio.minter.setMinter(await s.getAddress(), true)).wait();
    if (open) await (await s.connect(owner).unpause()).wait();
    return s;
  }
  const minted = async (rc, s = shop) => {
    const ev = rc.logs.map((l) => { try { return s.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Minted");
    return { tokenIds: [...ev.args.tokenIds], templateId: Number(ev.args.templateId), paid: ev.args.paid, to: ev.args.to };
  };
  const buy = async (templateId = 0, quantity = 1, who = alice, value = PRICE * BigInt(quantity)) =>
    minted(await (await shop.connect(who).mint(templateId, quantity, { value })).wait());

  before(async () => {
    [deployer, owner, alice, bob, stranger] = await ethers.getSigners();
    studio = await deployStudio(ethers, { minters: [deployer.address] });
    shop = await stock(await deploy());
  });
  beforeEach(async () => { snap = await rpc("evm_snapshot"); });
  afterEach(async () => { await rpc("evm_revert", [snap]); });

  describe("setup", () => {
    it("deploys paused and unlocked, owned by the given owner", async () => {
      const s = await deploy();
      assert.equal(await s.paused(), true);
      assert.equal(await s.locked(), false);
      assert.equal(await s.owner(), owner.address);
      assert.equal(await s.ready(), false);   // no MINTER role yet
      await rejects(s.connect(alice).mint(0, 1, { value: PRICE }), "EnforcedPause");
    });

    it("rejects a zero or code-less minter", async () => {
      const f = await ethers.getContractFactory("FixedPriceMinter");
      await rejects(f.deploy(ethers.ZeroAddress, owner.address, PRICE, 0), "ZeroAddress");
      await rejects(f.deploy(stranger.address, owner.address, PRICE, 0), "BadMinter");
    });

    it("loads templates with edition sizes; rejects empty designs, zero sizes, duplicates and a length mismatch", async () => {
      const s = await deploy();
      await rejects(s.connect(owner).addTemplates([template(0, 0)], []), "BadTemplate");
      await rejects(s.connect(owner).addTemplates([template(0, 0)], [0]), "BadTemplate");
      const empty = template(0, 1);
      empty.design = { ...empty.design, designHash: ethers.ZeroHash };
      await rejects(s.connect(owner).addTemplates([empty], [5]), "BadTemplate");
      await (await s.connect(owner).addTemplates([template(0, 0), template(4, 2)], [5, 1])).wait();
      await rejects(s.connect(owner).addTemplates([template(0, 0)], [5]), "DuplicateDesign");
      assert.equal(await s.templateCount(), 2n);
      assert.equal((await s.templateOf(1)).design.name, template(4, 2).design.name);
      const e = await s.editionOf(1);
      assert.deepEqual([e.maxSupply, e.minted, e.retired], [1n, 0n, false]);
      const c = await s.config();
      assert.equal(c.maxSupply_, 6n);
      await rejects(s.templateOf(2), "UnknownTemplate");
    });

    it("only the owner configures; ownership is two-step and cannot be renounced", async () => {
      const s = await deploy();
      await rejects(s.connect(alice).addTemplates([template(0, 0)], [1]), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).unpause(), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).setPrice(1), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).setMaxPerWallet(1), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).lock(), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).ownerMint(alice.address, 0, 1), "OwnableUnauthorizedAccount");
      await rejects(s.connect(alice).withdraw(alice.address, 0), "OwnableUnauthorizedAccount");
      await rejects(s.connect(owner).renounceOwnership(), "RenounceDisabled");
      await (await s.connect(owner).transferOwnership(bob.address)).wait();
      assert.equal(await s.owner(), owner.address);
      await (await s.connect(bob).acceptOwnership()).wait();
      assert.equal(await s.owner(), bob.address);
    });
  });

  describe("minting", () => {
    it("mints new tokens of the chosen design straight to the buyer, with the design record", async () => {
      const { tokenIds, templateId, paid, to } = await buy(3, 2);
      assert.equal(tokenIds.length, 2);
      assert.equal(templateId, 3);
      assert.equal(paid, PRICE * 2n);
      assert.equal(to, alice.address);
      for (const id of tokenIds) {
        assert.equal(await studio.cards.ownerOf(id), alice.address);
        assert.equal((await studio.design.designOf(id)).designHash, POOL[3].design.designHash);
      }
      assert.deepEqual([...(await shop.templatesOf([...tokenIds, 12345n]))], [4n, 4n, 0n]);
      assert.equal((await shop.editionOf(3)).minted, 2n);
      assert.equal(await shop.totalMinted(), 2n);
      assert.equal(await shop.mintedBy(alice.address), 2n);
      assert.equal(await ethers.provider.getBalance(await shop.getAddress()), PRICE * 2n);
    });

    it("takes the exact price only, and 1..MAX_PER_TX cards", async () => {
      await rejects(shop.connect(alice).mint(0, 1, { value: PRICE - 1n }), "WrongPayment");
      await rejects(shop.connect(alice).mint(0, 1, { value: PRICE + 1n }), "WrongPayment");
      await rejects(shop.connect(alice).mint(0, 2, { value: PRICE }), "WrongPayment");
      await rejects(shop.connect(alice).mint(0, 0, { value: 0 }), "BadQuantity");
      const max = await shop.MAX_PER_TX();
      await rejects(shop.connect(alice).mint(0, max + 1n, { value: PRICE * (max + 1n) }), "BadQuantity");
      await rejects(shop.connect(alice).mint(99, 1, { value: PRICE }), "UnknownTemplate");
    });

    it("never sells past an edition's size", async () => {
      await buy(0, SUPPLY);
      await rejects(shop.connect(bob).mint(0, 1, { value: PRICE }), "SoldOut");
      await buy(1, SUPPLY - 1, bob);
      await rejects(shop.connect(bob).mint(1, 2, { value: PRICE * 2n }), "SoldOut");
      await buy(1, 1, bob);
      const page = await shop.editionsOf(0, 3);
      assert.deepEqual(page.minted.map(Number), [SUPPLY, SUPPLY, 0]);
      assert.deepEqual(page.maxSupply.map(Number), [SUPPLY, SUPPLY, SUPPLY]);
    });

    it("enforces the per-wallet limit across transactions (owner mints do not count)", async () => {
      await (await shop.connect(owner).setMaxPerWallet(3)).wait();
      assert.equal(await shop.mintableBy(alice.address), 3n);
      await buy(0, 2);
      assert.equal(await shop.mintableBy(alice.address), 1n);
      await rejects(shop.connect(alice).mint(1, 2, { value: PRICE * 2n }), "WalletLimitReached");
      await buy(1, 1);
      assert.equal(await shop.mintableBy(alice.address), 0n);
      await (await shop.connect(owner).ownerMint(alice.address, 2, 2)).wait();
      assert.equal(await shop.mintedBy(alice.address), 3n);
      await (await shop.connect(owner).setMaxPerWallet(0)).wait();
      assert.equal(await shop.mintableBy(alice.address), ethers.MaxUint256);
    });

    it("refuses to sell without the MINTER role, so no payment can be taken for a card that cannot mint", async () => {
      await (await studio.minter.setMinter(await shop.getAddress(), false)).wait();
      assert.equal(await shop.ready(), false);
      await rejects(shop.connect(alice).mint(0, 1, { value: PRICE }), "NotMinter");
      assert.equal((await shop.config()).ready_, false);
    });

    it("a template the collection rejects reverts the whole mint: the buyer keeps the price", async () => {
      const bad = template(0, 7);
      bad.design = { ...bad.design, designHash: ethers.id("off-band"), kit: 3 };   // kind 0 may not carry a kit
      await (await shop.connect(owner).addTemplates([bad], [5])).wait();
      const id = (await shop.templateCount()) - 1n;
      await assert.rejects(shop.connect(alice).mint(id, 1, { value: PRICE }));
      assert.equal(await ethers.provider.getBalance(await shop.getAddress()), 0n);
      assert.equal((await shop.editionOf(id)).minted, 0n);
    });

    it("pausing stops sales; the owner can still mint within the caps", async () => {
      await (await shop.connect(owner).pause()).wait();
      await rejects(shop.connect(alice).mint(0, 1, { value: PRICE }), "EnforcedPause");
      const rc = await (await shop.connect(owner).ownerMint(bob.address, 0, SUPPLY)).wait();
      const m = await minted(rc);
      assert.equal(m.paid, 0n);
      assert.equal(await studio.cards.ownerOf(m.tokenIds[0]), bob.address);
      await rejects(shop.connect(owner).ownerMint(bob.address, 0, 1), "SoldOut");
      await rejects(shop.connect(owner).ownerMint(ethers.ZeroAddress, 1, 1), "ZeroAddress");
    });

    it("a price change applies to the next mint", async () => {
      await (await shop.connect(owner).setPrice(0)).wait();
      await buy(0, 1, alice, 0n);
      await (await shop.connect(owner).setPrice(PRICE * 3n)).wait();
      await rejects(shop.connect(alice).mint(0, 1, { value: PRICE }), "WrongPayment");
      await buy(0, 1, alice, PRICE * 3n);
    });
  });

  describe("catalogue lock", () => {
    it("retiring a template stops its sales; lock() freezes the catalogue for good", async () => {
      await buy(4, 1);
      await (await shop.connect(owner).retireTemplate(4)).wait();
      await rejects(shop.connect(alice).mint(4, 1, { value: PRICE }), "UnknownTemplate");
      await rejects(shop.connect(owner).retireTemplate(4), "UnknownTemplate");
      assert.equal((await shop.config()).maxSupply_, BigInt(9 * SUPPLY));
      assert.deepEqual([...(await shop.templatesOf([]))], []);

      await (await shop.connect(owner).lock()).wait();
      await rejects(shop.connect(owner).addTemplates([template(4, 9)], [1]), "IsLocked");
      await rejects(shop.connect(owner).retireTemplate(5), "IsLocked");
      await rejects(shop.connect(owner).lock(), "IsLocked");
      await buy(5, 1);   // sales go on
    });
  });

  describe("money", () => {
    it("the owner withdraws revenue, never more than the balance", async () => {
      await buy(0, 2);
      const before = await ethers.provider.getBalance(stranger.address);
      await rejects(shop.connect(owner).withdraw(stranger.address, PRICE * 2n + 1n), "Insufficient");
      await rejects(shop.connect(owner).withdraw(ethers.ZeroAddress, 1n), "ZeroAddress");
      await (await shop.connect(owner).withdraw(stranger.address, PRICE * 2n)).wait();
      assert.equal(await ethers.provider.getBalance(stranger.address), before + PRICE * 2n);
      assert.equal(await ethers.provider.getBalance(await shop.getAddress()), 0n);
    });

    it("a withdrawal to a contract that refuses payment reverts as TransferFailed", async () => {
      await buy(0, 1);
      await rejects(shop.connect(owner).withdraw(await studio.design.getAddress(), PRICE), "TransferFailed");
    });
  });
});
