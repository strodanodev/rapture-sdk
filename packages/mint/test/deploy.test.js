// The deploy stages (scripts/lib/deploy.js) and the config checks (scripts/lib/config.js), run in-process on the
// Hardhat network against the reference collection, as `pnpm deploy:local` runs them on a local node.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers } = hre;
const { loadConfig, templateProblems, parseUnits, PACKS_MISSING } = require("../scripts/lib/config.js");
const { hasPacks } = require("../scripts/lib/packs.js");
const D = require("../scripts/lib/deploy.js");
const { configWith: copyOf } = require("./helpers/configs.js");

const EXAMPLES = path.join(__dirname, "..", "examples");
const configWith = (example, patch) => copyOf(path.join(EXAMPLES, example), patch);
const rpc = (method, params = []) => ethers.provider.send(method, params);
const quiet = () => {};

describe("deploy scripts", function () {
  let signer, buyer, safe, collection, snap;

  before(async () => {
    [signer, buyer, safe] = await ethers.getSigners();
    collection = await D.deployReferenceCollection(ethers, quiet);
  });
  beforeEach(async () => { snap = await rpc("evm_snapshot"); });
  afterEach(async () => { await rpc("evm_revert", [snap]); });

  describe("config", () => {
    it("the shipped fixed-price example is valid", () => {
      const { problems, cfg } = loadConfig(path.join(EXAMPLES, "fixed", "mint.config.json"));
      assert.deepEqual(problems, []);
      assert.deepEqual(cfg.supplies, [100, 100, 100, 100, 100, 100, 100, 100, 100, 10]);
    });

    it("reports what is wrong instead of guessing", () => {
      const file = configWith("fixed", (c) => ({ ...c, mode: "auction", owner: "me", collection: { minter: "0x12" }, fixed: { price: "1e18" } }));
      const { problems } = loadConfig(file);
      for (const want of [/mode must be/, /owner must be/, /collection.minter/]) assert.ok(problems.some((p) => want.test(p)), `${want} in ${problems.join("; ")}`);
    });

    it("mode \"packs\" needs the pack module: where packs/ is missing it is refused with a clear reason", async () => {
      const file = configWith("fixed", (c) => { c.mode = "packs"; c.packs = { price: "0.001", deck: "deck.json" }; });
      const { problems } = loadConfig(file);
      if (hasPacks()) assert.ok(!problems.includes(PACKS_MISSING));
      else {
        assert.deepEqual(problems, [PACKS_MISSING]);
        assert.match(PACKS_MISSING, /PackShop v2 isn't published in this kit yet/);
        await assert.rejects(D.describe(null, "packs"), /isn't published in this kit yet/);
        await assert.rejects(D.runDeploy(hre, { mode: "packs" }, {}, { log: quiet }), /isn't published in this kit yet/);
      }
    });

    it("checks templates against the reference collection's rules", () => {
      const t = JSON.parse(fs.readFileSync(path.join(EXAMPLES, "fixed", "templates.json"), "utf8")).templates[0].template;
      assert.deepEqual(templateProblems(t, 0), []);
      assert.ok(templateProblems({ ...t, design: { ...t.design, kit: 2 } }, 0).some((p) => /kit/.test(p)));
      assert.ok(templateProblems({ ...t, design: { ...t.design, name: "Bad<name>" } }, 0).some((p) => /design.name/.test(p)));
      assert.ok(templateProblems(t, 0, [[0, 1], [0, 1], [0, 1], [0, 1], [0, 1]]).some((p) => /outside kind 0's band/.test(p)));
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
});
