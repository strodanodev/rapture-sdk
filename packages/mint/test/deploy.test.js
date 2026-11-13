// The deploy stages (scripts/lib/deploy.js) and the config checks (scripts/lib/config.js), run in-process on the
// Hardhat network against the reference collection, as `pnpm deploy:local` runs them on a local node.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const hre = require("hardhat");
const { ethers } = hre;
const { loadConfig, templateProblems, deckProblems, parseUnits } = require("../scripts/lib/config.js");
const D = require("../scripts/lib/deploy.js");

const EXAMPLES = path.join(__dirname, "..", "examples");
const rpc = (method, params = []) => ethers.provider.send(method, params);
const quiet = () => {};

function configWith(example, patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mint-config-"));
  const src = path.join(EXAMPLES, example);
  for (const f of fs.readdirSync(src)) if (f.endsWith(".json")) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "mint.config.json"), "utf8"));
  if (raw.templates.startsWith("../")) {
    fs.copyFileSync(path.resolve(src, raw.templates), path.join(dir, "templates.json"));
    raw.templates = "templates.json";
  }
  const merged = patch(raw) ?? raw;
  fs.writeFileSync(path.join(dir, "mint.config.json"), JSON.stringify(merged));
  return path.join(dir, "mint.config.json");
}

describe("deploy scripts", function () {
  let signer, buyer, safe, collection, snap;

  before(async () => {
    [signer, buyer, safe] = await ethers.getSigners();
    collection = await D.deployReferenceCollection(ethers, quiet);
  });
  beforeEach(async () => { snap = await rpc("evm_snapshot"); });
  afterEach(async () => { await rpc("evm_revert", [snap]); });

  describe("config", () => {
    it("the shipped examples are valid (Rapture's waits for its exported templates)", () => {
      for (const ex of ["fixed", "packs", "rapture"]) {
        const { problems } = loadConfig(path.join(EXAMPLES, ex, "mint.config.json"));
        assert.deepEqual(problems, [], ex);
      }
      const r = loadConfig(path.join(EXAMPLES, "rapture", "mint.config.json"));
      assert.equal(r.cfg.templates, null);
      assert.match(r.warnings[0], /export-templates/);
      assert.deepEqual(r.cfg.deck.counts.flat().reduce((a, b) => a + b, 0), 888);
    });

    it("reports what is wrong instead of guessing", () => {
      const file = configWith("fixed", (c) => ({ ...c, mode: "auction", owner: "me", collection: { minter: "0x12" }, fixed: { price: "1e18" } }));
      const { problems } = loadConfig(file);
      for (const want of [/mode must be/, /owner must be/, /collection.minter/]) assert.ok(problems.some((p) => want.test(p)), `${want} in ${problems.join("; ")}`);
      const packs = configWith("packs", (c) => { c.packs.packSize = 7; c.packs.price = "0.0.1"; });
      const p2 = loadConfig(packs).problems;
      assert.ok(p2.some((p) => /packSize must be 1..6/.test(p)));
      assert.ok(p2.some((p) => /packs.price must be a decimal/.test(p)));
    });

    it("checks templates against the reference collection's rules, and decks against the templates", () => {
      const t = JSON.parse(fs.readFileSync(path.join(EXAMPLES, "fixed", "templates.json"), "utf8")).templates[0].template;
      assert.deepEqual(templateProblems(t, 0), []);
      assert.ok(templateProblems({ ...t, design: { ...t.design, kit: 2 } }, 0).some((p) => /kit/.test(p)));
      assert.ok(templateProblems({ ...t, design: { ...t.design, name: "Bad<name>" } }, 0).some((p) => /design.name/.test(p)));
      assert.ok(templateProblems(t, 0, [[0, 1], [0, 1], [0, 1], [0, 1], [0, 1]]).some((p) => /outside kind 0's band/.test(p)));
      assert.ok(deckProblems({ counts: [[1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] }, 5, [t]).some((p) => /does not fill one pack/.test(p)));
      assert.ok(deckProblems({ counts: [[5, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 9]] }, 5, [t]).some((p) => /no template of that kind/.test(p)));
      assert.equal(parseUnits("0.001"), 10n ** 15n);
      assert.equal(parseUnits("2"), 2n * 10n ** 18n);
    });
  });

  describe("fixed price", () => {
    it("deploys, grants, stocks, preflights, locks, opens and offers ownership; a re-run sends nothing new", async () => {
      const file = configWith("fixed", (c) => { c.collection.minter = collection.minter; c.collection.cards = collection.cards; c.owner = safe.address; });
      const { cfg, problems } = loadConfig(file);
      assert.deepEqual(problems, []);
      const record = {};
      const { shop, granted } = await D.runDeploy(hre, cfg, record, { log: quiet });
      assert.equal(granted, true);
      const s = await D.describe(shop, "fixed");
      assert.equal(s.templates, 10);
      assert.equal(s.locked, true);
      assert.equal(s.paused, false);
      assert.equal(s.maxSupply, 9 * 100 + 10);
      assert.equal(s.owner, signer.address);
      assert.equal(s.pendingOwner, safe.address);
      assert.equal(record.contract, "FixedPriceMinter");

      const nonce = await ethers.provider.getTransactionCount(signer.address);
      await D.runDeploy(hre, cfg, record, { log: quiet });
      assert.equal(await ethers.provider.getTransactionCount(signer.address), nonce);

      const rc = await (await shop.connect(buyer).mint(9, 2, { value: cfg.fixed.price * 2n })).wait();
      assert.equal(rc.status, 1);
      await (await shop.connect(safe).acceptOwnership()).wait();
      assert.equal(await shop.owner(), safe.address);
    });

    it("without the minter admin's key it stops before opening and names the call to make", async () => {
      const file = configWith("fixed", (c) => { c.collection.minter = collection.minter; });
      const { cfg } = loadConfig(file);
      const lines = [];
      const { shop, granted } = await D.runDeploy(hre, cfg, {}, { log: (l) => lines.push(l), signer: buyer });
      assert.equal(granted, false);
      assert.equal(await shop.paused(), true);
      const call = `setMinter(${await shop.getAddress()}, true)`;
      assert.ok(lines.some((l) => l.includes(call)), lines.join("\n"));
    });

    it("a template the collection would reject fails the preflight before sales open", async () => {
      const file = configWith("fixed", (c) => { c.collection.minter = collection.minter; c.fixed.lock = false; });
      const { cfg } = loadConfig(file);
      cfg.templates[3] = { ...cfg.templates[3], traits: { ...cfg.templates[3].traits, strength: 1 } };   // below its band
      await assert.rejects(D.runDeploy(hre, cfg, {}, { log: quiet }), /would not mint[\s\S]*template 3/);
    });
  });

  describe("packs", () => {
    it("deploys PackShopV2 against a given beacon, stocks, locks the deck and opens sales", async () => {
      const mock = await (await ethers.getContractFactory("MockEvmnetRegistry")).deploy();
      const file = configWith("packs", (c) => { c.collection.minter = collection.minter; c.packs.beacon = null; });
      const { cfg, problems } = loadConfig(file);
      assert.deepEqual(problems, []);
      cfg.packs.beacon = await mock.getAddress();
      const record = {};
      const { shop } = await D.runDeploy(hre, cfg, record, { log: quiet, checkBeacon: false });
      const s = await D.describe(shop, "packs");
      assert.equal(s.maxSupply, 79);
      assert.equal(s.packsTotal, 15);
      assert.equal(s.templates, 10);
      assert.equal(s.locked, true);
      assert.equal(s.paused, false);
      assert.equal(s.ready, true);
      assert.equal(await shop.reserveTo(), signer.address);
      assert.equal(record.beacon, await mock.getAddress());

      const buy = await (await shop.connect(buyer).buyPack({ value: cfg.packs.price })).wait();
      const ev = buy.logs.map((l) => { try { return shop.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "PackBought");
      await (await mock.proveRound(ethers.toUtf8Bytes("sig"), ev.args.round)).wait();
      await rpc("evm_increaseTime", [30]);
      const open = await (await shop.connect(buyer).openPack(ev.args.packId, [], [])).wait();
      assert.equal(open.status, 1);

      const nonce = await ethers.provider.getTransactionCount(signer.address);
      await D.runDeploy(hre, cfg, record, { log: quiet, checkBeacon: false });
      assert.equal(await ethers.provider.getTransactionCount(signer.address), nonce);
    });

    it("refuses to re-lock a shop with a different deck", async () => {
      const mock = await (await ethers.getContractFactory("MockEvmnetRegistry")).deploy();
      const { cfg } = loadConfig(configWith("packs", (c) => { c.collection.minter = collection.minter; }));
      cfg.packs.beacon = await mock.getAddress();
      const record = {};
      await D.runDeploy(hre, cfg, record, { log: quiet, checkBeacon: false });
      cfg.deck = { counts: cfg.deck.counts.map((r) => r.map((n) => n + 1)) };
      await assert.rejects(D.runDeploy(hre, cfg, record, { log: quiet, checkBeacon: false }), /locked with another deck/);
    });
  });
});
