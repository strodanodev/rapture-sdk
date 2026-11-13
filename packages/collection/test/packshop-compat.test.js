// PackShop v1, compiled verbatim from apps/forge-site/packshop (only its import path changed), sells packs of a
// ChampionCollection with no change: the collection implements the IStudioMinter ABI PackShop calls. PackShop v1's
// own template checks are Rapture ARC 1's rules, so the collection here is the Rapture example configuration.
import assert from 'node:assert/strict';
import hre from 'hardhat';

import { cardTo, deploy, example, reverts } from './helpers.js';

const { ethers } = hre;

describe('PackShop v1 against ChampionCollection', function () {
  it('sells a sealed pack, opens it and mints mirrored champions to the buyer', async function () {
    const cfg = example('rapture');
    const { collection, registry, tokens, deployer, others } = await deploy(ethers, cfg);
    const [buyer] = others;
    const price = ethers.parseEther('0.001');
    const shop = await (await ethers.getContractFactory('PackShop')).deploy(await collection.getAddress(), deployer.address, price, 3, [1, 0, 0, 0, 1], 0);
    const shopAddr = await shop.getAddress();
    const templates = tokens.map((t) => ({ kind: t.card.kind, traits: t.card.traits, styleSource: t.card.styleSource, design: t.card.design }));
    await (await shop.addTemplates(templates)).wait();
    await (await shop.unpause()).wait();
    await reverts(shop.connect(buyer).buyPack({ value: price }), 'NotMinter');   // the shop checks its role first

    await (await collection.setMinter(shopAddr, true)).wait();
    await (await shop.connect(buyer).buyPack({ value: price })).wait();
    await ethers.provider.send('hardhat_mine', ['0x2']);
    const rc = await (await shop.openPack(1)).wait();
    const opened = rc.logs.map((/** @type {any} */ l) => { try { return shop.interface.parseLog(l); } catch { return null; } }).find((/** @type {any} */ e) => e?.name === 'PackOpened');
    const ids = /** @type {bigint[]} */ ([...opened.args.tokenIds]);
    assert.equal(ids.length, 3);
    for (const id of ids) {
      assert.equal(await collection.ownerOf(id), buyer.address);
      assert.equal((await collection.championOf(id)).minter, shopAddr);
      const twin = await registry.manifestOf(await collection.registryIdOf(id));
      assert.equal(twin.agentController, buyer.address);
    }
    // the same design can be printed again: editions are separate tokens
    assert.equal(await collection.totalSupply(), 3n);
  });

  it('exposes the exact IStudioMinter selectors PackShop calls', async function () {
    const cfg = example('rapture');
    const { collection, tokens, others } = await deploy(ethers, cfg);
    const shopAbi = (await hre.artifacts.readArtifact('contracts/test/compat/PackShop.sol:IStudioMinter')).abi;
    const i = new ethers.Interface(shopAbi);
    for (const name of ['mintBatch', 'minters', 'bandOf']) {
      assert.ok(collection.interface.getFunction(i.getFunction(name).selector), `${name} missing`);
    }
    // a raw mintBatch call built from PackShop's ABI lands on the collection
    const data = i.encodeFunctionData('mintBatch', [[cardTo(tokens[0], others[0].address)]]);
    await (await others[0].provider.getSigner(0)).sendTransaction({ to: await collection.getAddress(), data });
    assert.equal(await collection.totalSupply(), 1n);
  });
});
