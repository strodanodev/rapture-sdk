// The mint site template (sdk/apps/mint-site) hard-codes selectors, topics and error ids for both minters and checks
// them against ABI copies in its test/abi folder. Those copies must be this build's, so a contract change cannot leave
// the site speaking an old ABI. To refresh them: UPDATE_SITE_ABI=1 npx hardhat test test/site-abi.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { artifacts } = require("hardhat");

const SITE = path.join(__dirname, "..", "..", "..", "apps", "mint-site", "test", "abi");
const COPIES = {
  "FixedPriceMinter.json": "FixedPriceMinter",
  "PackShopV2.json": "PackShopV2",
  "reference/StudioMinter.json": "StudioMinter",
  "reference/CardDesign.json": "CardDesign",
  "reference/RaptureCards.json": "RaptureCards",
};

describe("mint site ABI copies", function () {
  before(function () { if (!fs.existsSync(SITE)) this.skip(); });   // the package on its own, without the site next to it

  for (const [file, name] of Object.entries(COPIES)) {
    it(`apps/mint-site/test/abi/${file} is this build's ${name} ABI`, async () => {
      const abi = (await artifacts.readArtifact(name)).abi;
      const target = path.join(SITE, file);
      if (process.env.UPDATE_SITE_ABI) fs.writeFileSync(target, JSON.stringify(abi, null, 2) + "\n");
      assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), abi, `run UPDATE_SITE_ABI=1 npx hardhat test test/site-abi.test.js`);
    });
  }
});
