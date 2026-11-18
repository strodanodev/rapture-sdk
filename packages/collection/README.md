# @rapture-sdk/collection

Step 1 of the Rapture SDK: launch an NFT collection whose tokens are **playable champions**. Every token is an
ERC-721 that carries ERC-6699 CoreStats (strength, agility, resilience, intelligence), and its twin is mirrored
into the chain's **canonical ERC6699Registry**. That is where LitNode, Rapture TCG and Rapture Chess find champions.

What is in the package:

| | |
|---|---|
| `contracts/` | `ChampionCollection` (ERC-721 + ERC-6699 + the minting ABI PackShop calls), `ChampionMetadata` (on-chain character.json), `ChampionJson` (its stateless pieces) |
| `src/` | the metadata pipeline: collection config → design hashes, mint tuples, metadata JSON; IPFS pinning; Blockscout verification |
| `scripts/` | Hardhat deploy, mint and verify scripts, and a local-chain registry stand-in |
| `blender/` | a Blender harness: card renders, avatar GLB export with Draco, scene export, HDR grading, alpha keying |
| `tools/meshy_gen.py` | an optional Meshy text-to-3D generator (your API key) |
| `examples/` | `starter` (a complete example with SVG placeholder art) and `rapture` (Rapture ARC 1's configuration, by reference) |

The guide walks through it end to end: [docs/guide/01-collection.md](../../docs/guide/01-collection.md).

## Install and check

Requires Node 22+, pnpm 12, Python 3 (for the harness's checks) and, for the harness itself, Blender (tested with 5.2).

```bash
cd packages/collection
pnpm install
pnpm check          # compile, typecheck, contract + pipeline tests, py_compile + unit tests of the Python scripts
```

`pnpm check` runs offline once dependencies and the solc compiler are cached. Nothing in it calls a network, a
pinning service, an explorer or Meshy: those calls go to mocks.

## The registry, and who approves a collection

A collection never deploys its own registry. Its constructor takes the address of an **existing**
ERC6699Registry and refuses one without code. A collection with a private registry is invisible to LitNode, which
reads a single registry for the whole fleet. That is exactly the mismatch Rapture hit: its cards were mirrored into a
registry LitNode never reads.

Two ERC6699Registry (v2) deployments exist on Liteforge (chain 4441):

| Registry | Address | Admin (approves collections) | Holds |
|---|---|---|---|
| **LitNode's** (`ERC6699RegistryV2` in LitNode's `contracts/deployed.testnet.json`) | `0x38DF2543e039E775D3f674f7414df43e4eF2f883` | `0x04bE2b954346324Ee54c4B4c0189DF5bb577a378` (LitNode deployer) | what LitNode nodes read today |
| **Rapture's** (deployed with Rapture's cards) | `0xBeEe6cFAD12346124eb3d51b716fce00B7f11949` | `0x869790B388299FA1E73B8Ad3f188d1f10d4087b5` | Rapture's ~9,700 card twins |

Use the registry LitNode reads, which today is LitNode's. If a LitNode release points the fleet at Rapture's
registry instead (the fix the Rapture SDK plan recommends), Rapture's becomes the canonical one. Check
`ERC6699RegistryV2` in LitNode's `deployed.testnet.json` before you deploy.

**Approval.** Only a registry MINTER can forge twins. After you deploy, the **registry's admin** must run, once:

```bash
cast send <registry> "setMinter(address,bool)" <your ChampionCollection> true \
  --rpc-url https://rpc.testnet.liteforge.zeeve.net/ --private-key <registry admin key>
```

The deploy script prints this command with your addresses filled in, and records in
`deployments/liteforge.json` whether the approval has happened. You don't have to wait for it. Until the approval,
mints succeed and each token is left **MirrorPending** (`pendingMirrors()` counts them). Afterwards anyone runs
`collection.mirror([ids])`, or `pnpm run mint-cards` with `MIRROR_ONLY=1`, and the twins appear.

## Quick start on a local chain

```bash
pnpm run chain                                             # terminal 1: Hardhat chain on 127.0.0.1:8549
pnpm run local-registry --network local                    # a registry stand-in (local chains only)
COLLECTION_CONFIG=examples/starter/collection.json pnpm run deploy-collection --network local
node src/cli.js build examples/starter/collection.json --out out
pnpm run mint-cards --network local                        # mints out/cards.json, mirrored
node scripts/verify.mjs local --package-only               # the verification package, no explorer needed
```

On the local chain, the deploy script approves the collection in the stand-in registry itself, because its admin
is your local account. On Liteforge the registry admin does it.

## Deploy to Liteforge

These steps need your own key and network access; nothing in this package runs them for you.

```bash
# 1. art -> metadata, then pin the files and rebuild with the image base the pin returned
node src/cli.js build my/collection.json --out out
PINATA_JWT=... node src/cli.js pin out/upload              # or IPFS_API_URL=http://127.0.0.1:5001 (Kubo)
#    put the printed ipfs://<CID>/ in "images.base", then rebuild:
node src/cli.js build my/collection.json --out out

# 2. deploy (the registry comes from the config's "registry".liteforge, or ERC6699_REGISTRY)
COLLECTION_CONFIG=my/collection.json DEPLOYER_KEY=0x... pnpm run deploy-collection --network liteforge

# 3. the registry admin approves the collection (command printed by step 2; see above)

# 4. verify on Blockscout (set the explorer's URL: there is no default)
BLOCKSCOUT_URL=https://<liteforge blockscout> node scripts/verify.mjs liteforge

# 5. mint (a MINTER key; the deployer is one by default)
MINT_TO=0x<wallet> DEPLOYER_KEY=0x... pnpm run mint-cards --network liteforge
```

Liteforge's RPC (`https://rpc.testnet.liteforge.zeeve.net/`, override with `LITEFORGE_RPC_URL`) is slow and keeps no
historical state. The scripts make only plain calls and transactions, with no log scans.

Keys only come from the environment (`DEPLOYER_KEY`, `PINATA_JWT`, `MESHY_API_KEY`). `.env` files are git-ignored, and
no file in this package may hold a key.

## The contracts

### ChampionCollection

An ERC-721 with the proposed ERC-6699 character interface (`coreStats`, `manifestOf`, `equip`/`unequip`,
`equipped`), generalised from Rapture's `RaptureCards` + `StudioMinter` + `CardDesign` with no Rapture constants.

- **Token ids** are `setId << 32 | index`, as Rapture's are. They are readable, unique across your collections, never 0,
  and the forge site and mint-site template derive a token's position from them.
- **Minting** uses the `IStudioMinter` ABI that PackShop v1/v2 and the SDK's fixed-price minter call, copied verbatim
  from PackShop (`contracts/interfaces/IStudioMinter.sol`):
  - `mintStudio(StudioCard)` mints one card;
  - `mintBatch(StudioCard[])` mints several;
  - `minters(address)` and `bandOf(kind)` are the views PackShop checks.

  A `StudioCard` is `{to, kind, traits, styleSource, design}`, with `Traits`, `Origin` and `Design` exactly as in
  Rapture's `interfaces/Rapture.sol`. The collection's admin grants the MINTER role with `setMinter(who, true)`:
  to a team key, a PackShop, or a fixed-price minter.
- **Rules.** `Rules` gives every field of the tuple a range:
  - Kinds 0..kinds-1, each with its own stat band;
  - faction, alignment (optionally 255 = sealed), element and frame maxima;
  - four body-part bytes;
  - which Kinds must name a kit;
  - whether an avatar is required.

  A collection with extra rules (Rapture ARC 1 ties body parts to Kinds) overrides `_checkCard`.
- **The mirror.** At mint, the twin is forged at `registryIdOf(tokenId) = keccak256(collection, tokenId)`:
  - its owner is the collection, so the ERC-721 is what trades;
  - its controller is the holder, or the holder's proxy when an identity link is set;
  - it carries the same stats and the image-free character.json hash.

  Every transfer re-points the controller, and `setSoul`/`setController` keep the twin in step.
- **Fixed for good.** No stat or trait changes after mint: there is no progressor, no admin write path and no upgrade.
  `maxSupply` caps the supply (0 = no cap).

PackShop v1 sells these tokens unchanged: `test/packshop-compat.test.js` buys and opens a pack with the PackShop
contract compiled verbatim. PackShop v1's own template checks hardcode Rapture ARC 1's ranges, so it accepts a
collection configured like `examples/rapture`. A collection with other ranges needs a PackShop that reads
`bandOf` and the collection's `rules()` (the mint package's PackShop v2).

### ChampionMetadata and ChampionJson

Each token's character.json is built on chain from its record, with no metadata server:

- `tokenURI` returns the full JSON as a `data:` URI.
- `agentConfig` returns the CAIP-19 `eip155:<chain>/erc721:<collection>/<id>` and `keccak256` of the
  **location-free** form. That form is the full JSON minus `image`, `animation_url` and `external_url`, so the hash the
  registry twin holds never changes when the files move.
- Files are addressed by content hash under one image base:
  - `<base><sha256(art)>.<ext>` for the art;
  - `<base><sha256(avatar)>.glb` for the avatar;
  - `<base><designHash>.json` for the design document, which carries the per-game `overrides`.

The admin sets the trait vocabulary with `setTrait`, `setLabels` and `setLists`. It is locked once the first token
exists, because it is part of every hash. The image base can move with `setImageBase` until `freezeImages()`.
`ChampionJson` is stateless and can be shared by many collections (pass `"json": "<address>"` in the config).
The JSON's `collection` block (schema `rapture-sdk/champion/1`) carries every raw field, so a game reads numbers
instead of parsing attribute names.

## The collection config

One JSON file, read by both the deploy script and the pipeline. `examples/starter/collection.json` is complete:

| Key | |
|---|---|
| `name`, `symbol`, `setId`, `maxSupply` | the ERC-721; token ids are `setId << 32 \| index` |
| `registry` | `{ "<network>": "0x..." }`: the existing ERC6699Registry per network (or `ERC6699_REGISTRY`) |
| `admin`, `minters`, `identity`, `json` | optional: the collection admin (default: the deployer), MINTER grants (default `["deployer"]`), an identity link, a shared ChampionJson |
| `images` | `{ "base": "ipfs://<CID>/", "ext": "webp" }` |
| `info` | contract-level `description`, `image`, `externalLink` (contractURI) |
| `tagline` | the bio after a token's epithet |
| `traits.kind` | `label`, value names, and one `[min, max]` stat band per Kind |
| `traits.faction`, `alignment`, `element`, `frame` | `label` (empty = hidden) and value names; `alignment.sealed` names value 255 |
| `traits.kit` | value names (kit 1 = first) and `kinds` that must name one |
| `traits.parts` | up to four `{ "label", "max" }` body-part bytes |
| `avatar` | `required`, and the glTF extensions the GLBs need (`requires`) |
| `equipmentSlots` | ERC-6699 equipment slots |
| `tokens` | the tokens, inline or a file: `name`, `epithet`, `kind`, traits by name, `parts`, `kit`, `stats`, `art`, `avatar`, `avatarPlain`, `turntable`, `soul`, `styleSource`, `overrides`, `to` |

Text that lands in on-chain JSON is checked before any transaction. Names and epithets use letters, digits, space and
`' , - . : _`; labels and URLs use printable ASCII without `"` or `\`.

## The metadata pipeline

```bash
node src/cli.js check my/collection.json                     # validate everything the contract would
node src/cli.js build my/collection.json --out out [--image-base ipfs://<CID>/] [--chain-id 4441 --collection 0x...]
node src/cli.js pin out/upload [--provider pinata|kubo]      # PINATA_JWT or IPFS_API_URL
```

`build` writes:

| File | |
|---|---|
| `out/upload/` | the files to publish as one directory, named by content hash: art, avatars, turntables, souls (`keccak256`), design documents |
| `out/cards.json` | the `StudioCard` tuples in mint order, as `mintBatch` and PackShop's `addTemplates` take them |
| `out/metadata/<id>.json` | each token's full character.json, byte for byte what `tokenURI` will encode |
| `out/manifest.json` | each token's id, design hash and `characterConfigHash`, plus the list of upload files |

The design document is the canonical JSON of the token's design: sorted keys, no whitespace. Its keccak256 is the
on-chain `designHash`, so anyone can check it. The tests deploy the contracts and compare `tokenURI` with the
pipeline's output for every token of both examples.

The library API is `import { loadConfig, buildCollection, characterJson, agentConfig, pinDirectory } from
'@rapture-sdk/collection'`.

## The Blender harness

Every script runs the same way and reads a JSON config. Relative paths resolve against the config's folder.

```bash
blender --background --python blender/<script>.py -- --config <file.json> [--only a,b] [--dry-run]
```

| Script | Does | Generalised from |
|---|---|---|
| `render_cards.py` | one card render per token: a template .blend driven by token fields (`bind.text`, `show`, `images`, `colors`), or a built-in card | The Forge's render scripts |
| `export_avatars.py` | avatars → GLB with Draco (plain fallback), keeping the listed clips, dropping helpers; writes the uncompressed `avatarPlain` twin and sha256s | Rapture Chess `export-avatars.py`, `build-set.py` |
| `export_scene.py` | part of a .blend (a collection, name prefixes, objects) → one web GLB, WebP textures, optional check render | `export_web.py`, `build-set.py` |
| `grade.py` | linear EXR/HDR/NPZ → display PNG/WebP through Blender's own view transform and look (AgX, "AgX - Punchy") after an exposure / white balance / saturation / contrast / lift grade | `grade_cinematic.py` |
| `key_alpha.py` | key art off black or a green screen into cropped transparent WebPs | `title_assets.py` |

Each script's header lists its config keys. The harness needs nothing beyond Blender (numpy ships with it). Scripts
that build a scene start from factory settings and never save the .blend, so a user's open scenes are not touched.

Examples: `examples/starter/blender/cards.json` renders the starter's three cards with the built-in card, as PNGs:
point the tokens' `art` at the renders and set `images.ext` to `"png"`. The configs
in `examples/rapture/blender/` point at Rapture's sources (champion avatars, the forge hall, its bakes, the Chess
logo) by monorepo path.

## Optional: Meshy

```bash
python tools/meshy_gen.py --config examples/rapture/meshy.json --dry-run      # prints the requests
MESHY_API_KEY=... python tools/meshy_gen.py --config my/meshy.json --only anvil
```

Text-to-3D, preview then refine, downloading `<name>.glb`. It spends your Meshy credits, reads the key from the
environment only, and skips assets already downloaded. Tests and `pnpm check` only compile it and test its request
builders.

## Rapture as the worked example

`examples/rapture/collection.json` is Rapture ARC 1 expressed as this template's configuration:
- Kinds Mortal through God, with the Studio set's stat bands;
- factions, alignments (including sealed), elements, frames;
- head, facet, circuit and body-type parts;
- the five God kits;
- avatars required.

It points at Rapture's registry and references two cards' art and avatars by path inside the theforge monorepo.
Rapture's names, art, avatars and models are © LitVM Games and are not part of this package or its license. The
live Rapture collection is `RaptureCards` at `0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721`, the source this
template was generalised from, not a deployment of it.

## License

Apache-2.0 (see LICENSE). `contracts/vendor/rapture/interfaces/IERC6699.sol` and the test-only registry stand-in
are MIT, as LitNode publishes them.
