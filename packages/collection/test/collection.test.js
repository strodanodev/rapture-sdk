import assert from 'node:assert/strict';
import hre from 'hardhat';

import { agentConfig, characterJson, contractJson, stripLocations } from '../src/metadata.js';
import { keccak256 } from '../src/hash.js';
import { buildTokens } from '../src/build.js';
import { collectionArgs } from '../scripts/lib/deploy.js';
import { REGISTRY, cardTo, decodeDataUri, deploy, example, fakeRead, reverts } from './helpers.js';

const { ethers } = hre;

describe('ChampionCollection', function () {
  it('never deploys a registry: the constructor refuses an address without code', async function () {
    const cfg = example('starter');
    const [me] = await ethers.getSigners();
    const json = await (await ethers.getContractFactory('ChampionJson')).deploy();
    const metadata = await (await ethers.getContractFactory('ChampionMetadata')).deploy(me.address, await json.getAddress(), '', 'png');
    const f = await ethers.getContractFactory('ChampionCollection');
    const args = collectionArgs(cfg, { registry: me.address, metadata: await metadata.getAddress(), admin: me.address });
    await reverts(f.deploy(...args), 'NoCode');
  });

  it('mints through the IStudioMinter ABI and mirrors each token into the registry', async function () {
    const cfg = example('starter');
    const { collection, registry, metadata, tokens, others } = await deploy(ethers, cfg);
    const [alice] = others;
    const ids = await collection.mintBatch.staticCall(tokens.map((t) => cardTo(t, alice.address)));
    await (await collection.mintBatch(tokens.map((t) => cardTo(t, alice.address)))).wait();
    assert.deepEqual(ids.map(String), tokens.map((t) => t.tokenId));
    assert.equal(await collection.totalSupply(), 3n);
    assert.equal(tokens[0].tokenId, String(1n << 32n)); // setId 1 << 32 | index 0

    const where = { chainId: (await ethers.provider.getNetwork()).chainId, collection: await collection.getAddress() };
    for (const t of tokens) {
      const regId = await collection.registryIdOf(t.tokenId);
      assert.equal(await registry.ownerOf(regId), where.collection);
      const s = await registry.coreStats(regId);
      assert.deepEqual([s.strength, s.agility, s.resilience, s.intelligence, s.level, s.experience].map(Number),
        [t.card.traits.strength, t.card.traits.agility, t.card.traits.resilience, t.card.traits.intelligence, 1, 0]);
      const m = await registry.manifestOf(regId);
      const expected = agentConfig(cfg, t, where);
      assert.equal(m.agentController, alice.address);
      assert.equal(m.characterConfigURI, expected.uri);
      assert.equal(m.characterConfigHash, expected.hash);
      assert.equal(m.soulManifestHash, t.card.design.soul);
      assert.equal(await collection.isMirrored(t.tokenId), true);
      // the collection's own ERC-6699 view agrees with its twin
      const own = await collection.manifestOf(t.tokenId);
      assert.equal(own.characterConfigHash, expected.hash);
    }
    assert.equal(await metadata.contractURI(), `data:application/json;base64,${Buffer.from(contractJson(cfg)).toString('base64')}`);
  });

  it('builds character.json on chain byte for byte as the pipeline does (both example vocabularies)', async function () {
    for (const name of ['starter', 'rapture']) {
      const cfg = example(name, (raw) => {
        raw.images.base = 'ipfs://bafyexample/';
      });
      const { collection, metadata, tokens, others } = await deploy(ethers, cfg);
      await (await collection.mintBatch(tokens.map((t) => cardTo(t, others[0].address)))).wait();
      for (const t of tokens) {
        const full = decodeDataUri(await collection.tokenURI(t.tokenId));
        assert.equal(full, characterJson(cfg, t, true), `${name} ${t.card.design.name}: tokenURI`);
        JSON.parse(full);
        const bare = await metadata.characterJson(t.tokenId, false);
        assert.equal(bare, characterJson(cfg, t, false));
        assert.equal(stripLocations(full), bare, 'the hashed form is the full form minus its locations');
        const [, hash] = await metadata.agentConfig(t.tokenId);
        assert.equal(hash, keccak256(bare));
      }
    }
  });

  it('renders sealed alignment, kits, origins and part labels as configured', async function () {
    const cfg = example('rapture', (raw) => {
      raw.tokens[1].styleSource = { chainId: 1, collection: '0x00000000000000000000000000000000000000AA', tokenId: 7 };
    });
    const { collection, tokens, others } = await deploy(ethers, cfg);
    await (await collection.mintBatch(tokens.map((t) => cardTo(t, others[0].address)))).wait();
    const god = JSON.parse(decodeDataUri(await collection.tokenURI(tokens[0].tokenId)));
    const mortal = JSON.parse(decodeDataUri(await collection.tokenURI(tokens[1].tokenId)));
    const attr = (/** @type {any} */ j, /** @type {string} */ k) => j.attributes.find((/** @type {any} */ a) => a.trait_type === k)?.value;
    assert.equal(attr(god, 'Kind'), 'God');
    assert.equal(attr(god, 'Kit'), 'Riki');
    assert.equal(attr(god, 'Epithet'), 'Halo of the Sinking Throne');
    assert.equal(god.bio, 'Halo of the Sinking Throne. The Rapture has begun.');
    assert.deepEqual(god.avatar.requires, ['EXT_meshopt_compression', 'KHR_mesh_quantization']);
    assert.equal(attr(mortal, 'Alignment'), 'Sealed');
    assert.equal(attr(mortal, 'Head'), 2);
    assert.equal(attr(mortal, 'Origin'), 'eip155:1/erc721:0x00000000000000000000000000000000000000aa/7');
    assert.equal(mortal.collection.alignment, 255);
    assert.equal(mortal.bio, 'The Rapture has begun.');
  });

  it('leaves tokens MirrorPending until the registry admin approves, then mirror() catches up', async function () {
    const cfg = example('starter');
    const { collection, registry, tokens, others } = await deploy(ethers, cfg, { approve: false });
    const [alice] = others;
    const tx = await collection.mintBatch(tokens.map((t) => cardTo(t, alice.address)));
    const rc = await tx.wait();
    const pending = rc.logs.map((/** @type {any} */ l) => collection.interface.parseLog(l)).filter((/** @type {any} */ e) => e?.name === 'MirrorPending');
    assert.equal(pending.length, 3);
    assert.equal(await collection.pendingMirrors(), 3n);
    const ids = tokens.map((t) => t.tokenId);
    await reverts(collection.mirror(ids), 'NotApproved');

    await (await registry.setMinter(await collection.getAddress(), true)).wait();
    await (await collection.connect(others[1]).mirror(ids)).wait();   // anyone may call
    assert.equal(await collection.pendingMirrors(), 0n);
    const m = await registry.manifestOf(await collection.registryIdOf(ids[0]));
    assert.equal(m.agentController, alice.address);
    await reverts(collection.mirror([ids[0]]), 'AlreadyMirrored');
  });

  it('re-points the registry controller on transfer and clears equipment', async function () {
    const cfg = example('starter');
    const { collection, registry, tokens, others } = await deploy(ethers, cfg);
    const [alice, bob] = others;
    await (await collection.mintStudio(cardTo(tokens[0], alice.address))).wait();
    const id = tokens[0].tokenId;
    const items = await (await ethers.getContractFactory('TestItems')).deploy();
    await (await items.mint(alice.address, 9)).wait();
    const slot = ethers.encodeBytes32String('mainhand');
    await (await collection.connect(alice).equip(id, slot, await items.getAddress(), 9)).wait();
    assert.equal((await collection.equipped(id, slot))[1], 9n);
    await reverts(collection.connect(bob).equip(id, slot, await items.getAddress(), 9), 'NotController');

    await (await collection.connect(alice).transferFrom(alice.address, bob.address, id)).wait();
    const m = await registry.manifestOf(await collection.registryIdOf(id));
    assert.equal(m.agentController, bob.address);
    assert.equal((await collection.equipped(id, slot))[0], ethers.ZeroAddress);

    // the owner may hand control to a play wallet, and commit a soul; the twin follows
    await (await collection.connect(bob).setController(id, alice.address)).wait();
    assert.equal((await registry.manifestOf(await collection.registryIdOf(id))).agentController, alice.address);
    const soul = keccak256('# a new soul');
    await (await collection.connect(alice).setSoul(id, soul)).wait();
    assert.equal((await registry.manifestOf(await collection.registryIdOf(id))).soulManifestHash, soul);
    assert.equal((await collection.manifestOf(id)).manifestNonce, 1n);
  });

  it('gives a linked signer\'s tokens to its proxy as controller (optional identity link)', async function () {
    const [, signer, proxy] = await ethers.getSigners();
    const identity = await (await ethers.getContractFactory('TestIdentity')).deploy(signer.address, proxy.address);
    const cfg = example('starter', (raw) => {
      raw.identity = null;
    });
    cfg.identity = await identity.getAddress();
    const { collection, registry, tokens } = await deploy(ethers, cfg);
    await (await collection.mintStudio(cardTo(tokens[0], signer.address))).wait();
    const m = await registry.manifestOf(await collection.registryIdOf(tokens[0].tokenId));
    assert.equal(m.agentController, proxy.address);
  });

  it('enforces the collection rules on every card', async function () {
    const cfg = example('starter');
    const { collection, tokens, others } = await deploy(ethers, cfg);
    const to = others[0].address;
    const base = cardTo(tokens[0], to);   // a Knight
    const hero = cardTo(tokens[1], to);
    const with_ = (/** @type {any} */ c, /** @type {(c: any) => void} */ f) => {
      const x = JSON.parse(JSON.stringify(c));
      f(x);
      return x;
    };
    await reverts(collection.connect(others[1]).mintStudio(base), 'NotMinter');
    await reverts(collection.mintBatch([]), 'EmptyBatch');
    await reverts(collection.mintStudio(with_(base, (c) => { c.kind = 3; })), 'BadKind');
    await reverts(collection.mintStudio(with_(base, (c) => { c.traits.element = 3; })), 'BadTraits');
    await reverts(collection.mintStudio(with_(base, (c) => { c.traits.alignment = 255; })), 'BadTraits');   // no sealed alignment here
    await reverts(collection.mintStudio(with_(base, (c) => { c.traits.bodyparts = 3; })), 'BadParts');      // Helm max 2
    await reverts(collection.mintStudio(with_(base, (c) => { c.traits.bodyparts = 1 << 16; })), 'BadParts'); // unused slot
    await reverts(collection.mintStudio(with_(base, (c) => { c.traits.strength = 900; })), 'OutOfBand');
    await reverts(collection.mintStudio(with_(base, (c) => { c.design.kit = 1; })), 'BadKit');               // a Knight names no relic
    await reverts(collection.mintStudio(with_(hero, (c) => { c.design.kit = 0; })), 'BadKit');               // a Hero must
    await reverts(collection.mintStudio(with_(hero, (c) => { c.design.kit = 3; })), 'BadKit');
    await reverts(collection.mintStudio(with_(base, (c) => { c.design.name = 'Bad "quote"'; })), 'BadName');
    await reverts(collection.mintStudio(with_(base, (c) => { c.design.art = ethers.ZeroHash; })), 'BadDesign');
    await reverts(collection.mintStudio(with_(base, (c) => { c.design.avatarPlain = ethers.id('x'); })), 'BadDesign');
    await reverts(collection.mintStudio(with_(base, (c) => { c.to = ethers.ZeroAddress; })), 'ZeroAddress');
    assert.deepEqual((await collection.bandOf(1)).map(Number), [250, 550]);
    assert.deepEqual((await collection.bandOf(7)).map(Number), [0, 0]);
  });

  it('caps supply, locks the vocabulary after the first mint and keeps admin roles', async function () {
    const third = buildTokens(example('starter'), { read: fakeRead })[2];
    const cfg = example('starter', (raw) => {
      raw.maxSupply = 2;
      raw.tokens = raw.tokens.slice(0, 2);   // the pipeline refuses more tokens than maxSupply too
    });
    const { collection, metadata, tokens, others } = await deploy(ethers, cfg);
    const to = others[0].address;
    await (await metadata.setTrait(3, 'Element', ['Fire', 'Frost', 'Storm'])).wait();   // still open
    await (await collection.mintBatch([cardTo(tokens[0], to), cardTo(tokens[1], to)])).wait();
    await reverts(collection.mintStudio(cardTo(third, to)), 'SoldOut');
    await reverts(metadata.setTrait(3, 'Element', ['A']), 'Locked');
    await reverts(metadata.setLabels('x', '', ['', '', '', '']), 'Locked');
    // the image base may still move (it is outside the hashed form) until frozen
    await (await metadata.setImageBase('ipfs://bafynew/', 'png')).wait();
    await (await metadata.freezeImages()).wait();
    await reverts(metadata.setImageBase('https://elsewhere/', 'png'), 'Frozen');
    await reverts(collection.connect(others[1]).setMinter(others[1].address, true), 'NotAdmin');
    await (await collection.transferAdmin(others[1].address)).wait();
    await (await collection.connect(others[1]).setMinter(others[2].address, true)).wait();
    assert.equal(await collection.minters(others[2].address), true);
  });

  it('declares ERC-721 and ERC-6699', async function () {
    const cfg = example('starter');
    const { collection } = await deploy(ethers, cfg);
    assert.equal(await collection.supportsInterface('0x80ac58cd'), true);   // ERC-721
    const i6699 = new ethers.Interface([
      'function coreStats(uint256) view returns ((uint16,uint16,uint16,uint16,uint32,uint64))',
      'function manifestOf(uint256) view returns ((string,bytes32,address,bytes32,uint64,uint64))',
      'function equipped(uint256,bytes32) view returns (address,uint256)',
      'function equip(uint256,bytes32,address,uint256)',
      'function unequip(uint256,bytes32)',
    ]);
    let id = 0n;
    i6699.forEachFunction((f) => { id ^= BigInt(f.selector); });
    assert.equal(await collection.supportsInterface(ethers.toBeHex(id, 4)), true);
    assert.ok(REGISTRY.includes('test/'), 'the registry stand-in is test-only');
  });
});
