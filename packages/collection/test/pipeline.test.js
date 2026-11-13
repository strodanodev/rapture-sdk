// The metadata pipeline, pinning and verification, offline: every network call goes to a mock fetch.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCollection, buildTokens } from '../src/build.js';
import { canonicalJson, keccak256, sha256 } from '../src/hash.js';
import { characterJson } from '../src/metadata.js';
import { pinDirectory } from '../src/pin.js';
import { standardInput, verifyOnBlockscout } from '../src/blockscout.js';
import { example, fakeRead } from './helpers.js';

/** A recording fetch that answers from a list of handlers, in order. */
function mockFetch(/** @type {Array<(url: string, init?: RequestInit) => Response>} */ answers) {
  /** @type {{ url: string, init?: RequestInit }[]} */
  const calls = [];
  const f = async (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next(url, init);
  };
  return { f, calls };
}
const json = (/** @type {unknown} */ v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('metadata pipeline', function () {
  it('hashes canonical JSON independently of key order', function () {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 'x', c: null }] }), '{"a":[2,{"c":null,"d":"x"}],"b":1}');
    assert.equal(keccak256(canonicalJson({ x: 1, y: 2 })), keccak256(canonicalJson({ y: 2, x: 1 })));
    assert.equal(sha256('abc'), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('builds cards whose design hash is the keccak256 of the published design document', function () {
    const cfg = example('starter');
    const [t] = buildTokens(cfg, { read: fakeRead });
    const doc = t.files.find((f) => f.name.endsWith('.json'));
    assert.ok(doc);
    assert.equal(keccak256(doc.data), t.card.design.designHash);
    assert.equal(doc.name, `${t.card.design.designHash.slice(2)}.json`);
    const art = t.files.find((f) => f.name.endsWith('.png'));
    assert.equal(art?.name, `${sha256(fakeRead('ser-brightwall.png')).slice(2)}.png`);
    assert.equal(t.card.design.overridesHash, keccak256('{"tcg":{"cost":4}}'));
    assert.equal(t.card.traits.bodyparts, 2 + (1 << 8));   // Helm 2, Cloak 1
  });

  it('rejects what the contract would reject, before any transaction', function () {
    const bad = (/** @type {(raw: any) => void} */ edit, /** @type {RegExp} */ msg) => {
      assert.throws(() => buildTokens(example('starter', edit), { read: fakeRead }), msg);
    };
    bad((r) => { r.tokens[0].stats.strength = 9999; }, /outside the Knight band/);
    bad((r) => { r.tokens[0].element = 'Water'; }, /not one of/);
    bad((r) => { delete r.tokens[1].kit; }, /must name a kit/);
    bad((r) => { r.tokens[0].kit = 'Horn'; }, /names no kit/);
    bad((r) => { r.tokens[0].name = 'Ser <b>'; }, /may only use/);
    bad((r) => { r.tokens[0].art = 'art/x.webp'; }, /must be a \.png file/);
    bad((r) => { r.tokens[0].parts = { Helm: 3 }; }, /outside 0\.\.2/);
    bad((r) => { r.tokens[0].alignment = 255; }, /alignment: out of range/);
    assert.throws(() => example('starter', (r) => { r.setId = 0; }), /setId/);
    assert.throws(() => example('starter', (r) => { r.traits.kit.values = []; }), /kit\.kinds/);
    assert.throws(() => example('starter', (r) => { r.traits.kind.bands.pop(); }), /one \[min, max\]/);
    assert.throws(() => example('starter', (r) => { r.tagline = 'say "hi"'; }), /without "/);
    assert.throws(() => example('starter', (r) => { r.registry = { liteforge: '0x1234' }; }), /not an address/);
  });

  it('writes the upload folder, per-token metadata and the manifest', function () {
    const cfg = example('starter');
    const dir = mkdtempSync(join(tmpdir(), 'rapture-collection-'));
    try {
      const { tokens, manifest } = buildCollection(cfg, dir, { read: fakeRead, imageBase: 'ipfs://bafytest/', chainId: 4441, collection: '0x00000000000000000000000000000000000000Cc' });
      const upload = readdirSync(join(dir, 'upload')).sort();
      assert.deepEqual(upload, manifest.upload);
      assert.equal(upload.length, 3 + 3 + 1);   // 3 art, 3 design documents, 1 soul
      for (const t of tokens) {
        const written = readFileSync(join(dir, 'metadata', `${t.tokenId}.json`), 'utf8');
        assert.equal(written, characterJson(cfg, t, true, { imageBase: 'ipfs://bafytest/' }));
        assert.ok(written.includes(`"image":"ipfs://bafytest/`));
      }
      assert.equal(manifest.tokens[0].characterConfigURI, `eip155:4441/erc721:0x00000000000000000000000000000000000000cc/${1n << 32n}`);
      const cards = JSON.parse(readFileSync(join(dir, 'cards.json'), 'utf8'));
      assert.equal(cards.length, 3);
      assert.equal(cards[1].card.design.kit, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('IPFS pinning (mocked)', function () {
  /** @type {string} */
  let dir;
  beforeEach(function () {
    dir = join(mkdtempSync(join(tmpdir(), 'rapture-pin-')), 'upload');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.png'), 'A');
    writeFileSync(join(dir, 'b.json'), '{}');
  });

  it('pins a folder with Pinata and returns the image base', async function () {
    const { f, calls } = mockFetch([() => json({ IpfsHash: 'bafypinata' })]);
    const r = await pinDirectory(dir, { env: { PINATA_JWT: 'test-jwt' }, fetch: f });
    assert.deepEqual(r, { cid: 'bafypinata', imageBase: 'ipfs://bafypinata/', provider: 'pinata', files: 2 });
    assert.equal(calls[0].url, 'https://api.pinata.cloud/pinning/pinFileToIPFS');
    assert.equal(/** @type {Record<string, string>} */ (calls[0].init?.headers).Authorization, 'Bearer test-jwt');
    const form = /** @type {FormData} */ (calls[0].init?.body);
    assert.deepEqual(form.getAll('file').map((x) => /** @type {File} */ (x).name), ['upload/a.png', 'upload/b.json']);
  });

  it('pins with a Kubo node and finds the folder CID in its answer', async function () {
    const lines = [{ Name: 'upload/a.png', Hash: 'bafya' }, { Name: 'upload/b.json', Hash: 'bafyb' }, { Name: 'upload', Hash: 'bafyfolder' }];
    const { f, calls } = mockFetch([() => new Response(lines.map((l) => JSON.stringify(l)).join('\n'))]);
    const r = await pinDirectory(dir, { env: { IPFS_API_URL: 'http://127.0.0.1:5001/' }, fetch: f });
    assert.equal(r.cid, 'bafyfolder');
    assert.ok(calls[0].url.startsWith('http://127.0.0.1:5001/api/v0/add?cid-version=1'));
  });

  it('needs a provider key from the environment', async function () {
    await assert.rejects(pinDirectory(dir, { env: {}, fetch: mockFetch([]).f }), /PINATA_JWT/);
    await assert.rejects(pinDirectory(dir, { env: { PINATA_JWT: 'x' }, fetch: mockFetch([() => json({ error: 'no' }, 401)]).f }), /401/);
  });
});

describe('Blockscout verification (mocked)', function () {
  const build = {
    solcLongVersion: '0.8.28+commit.7893614a',
    input: { language: 'Solidity', sources: { 'contracts/A.sol': { content: 'contract A {}' }, 'contracts/B.sol': { content: 'contract B {}' } }, settings: { optimizer: { enabled: true, runs: 200 } } },
    output: { contracts: { 'contracts/A.sol': { A: { metadata: JSON.stringify({ sources: { 'contracts/A.sol': {} } }) } } } },
  };

  it('sends only the sources the contract was compiled from', function () {
    const { input, compilerVersion } = standardInput(build, 'contracts/A.sol', 'A');
    assert.deepEqual(Object.keys(input.sources), ['contracts/A.sol']);
    assert.equal(compilerVersion, 'v0.8.28+commit.7893614a');
  });

  it('submits, polls and reports success', async function () {
    const { f, calls } = mockFetch([
      () => json({ status: '0', result: [{ SourceCode: '' }] }),
      () => json({ status: '1', result: 'guid-1' }),
      () => json({ status: '0', result: 'Pending in queue' }),
      () => json({ status: '1', result: 'Pass - Verified' }),
    ]);
    const r = await verifyOnBlockscout({ explorer: 'https://explorer.test/', address: '0xabc', sourceName: 'contracts/A.sol', contractName: 'A', build, constructorArgs: '0x00ff', fetch: f, pollMs: 0 });
    assert.equal(r.status, 'verified');
    const sent = new URLSearchParams(String(calls[1].init?.body));
    assert.equal(calls[1].url, 'https://explorer.test/api');
    assert.equal(sent.get('codeformat'), 'solidity-standard-json-input');
    assert.equal(sent.get('contractname'), 'contracts/A.sol:A');
    assert.equal(sent.get('constructorArguements'), '00ff');
  });

  it('skips a contract that is already verified', async function () {
    const { f } = mockFetch([() => json({ status: '1', result: [{ SourceCode: 'contract A {}' }] })]);
    const r = await verifyOnBlockscout({ explorer: 'https://explorer.test', address: '0xabc', sourceName: 'contracts/A.sol', contractName: 'A', build, constructorArgs: '', fetch: f, pollMs: 0 });
    assert.equal(r.status, 'already');
  });
});
