# Mint site template

Step 2 of the Rapture SDK: the website that sells your collection. A static site (plain HTML, CSS and JavaScript
modules, no build step, no framework) for Vercel or any static host:

| Page | |
|---|---|
| `index.html` | the collection: hero art, name, price, how many are left, the way in |
| `mint.html` | fixed price: every card with its edition count, a quantity and a Mint button |
| `library.html` | the cards the connected wallet holds, named and with their finish |

The header's wallet button connects MetaMask or any EIP-1193 wallet, switches it to the chain (adding the chain if
the wallet has never seen it) and remembers the choice. The pages read the chain through its public RPC, not the
wallet, so they show prices and supply before anyone connects. The contracts are the mint package's
([`packages/mint`](../../packages/mint)); the full walk from a deployed collection to a live site is
[`docs/guide/02-mint-site.md`](../../docs/guide/02-mint-site.md).

It is built from forge.litvm.games' shop (the wallet and RPC clients and the transaction path) with Rapture's 3D hall,
branding and art taken out, plus a fixed-price page and a library that works for any collection.

A pack page exists too (sealed packs with drand reveals, for PackShop v2), but it isn't published in this kit yet: it
stays in Rapture's private build until Rapture launches the pack shop. A config with `mint.mode: "packs"` is refused
with that reason.

## One config file

Everything about your drop is in [`web/site.config.json`](web/site.config.json):

| Field | |
|---|---|
| `name`, `tagline`, `description` | the words on the home page and in the title |
| `chain` | `id`, `name`, `rpc`, `explorer` (a Blockscout URL or null), `faucet` (or null), `currency` |
| `mint.mode` | `"fixed"` (FixedPriceMinter) |
| `mint.address` | the minter; null until it is deployed (the pages then say "Not open yet") |
| `mint.collection`, `mint.tokenIdBase` | the ERC-721 and its first token id, for the library |
| `mint.designRecords` | the collection's design records (the reference CardDesign), to name any token; optional |
| `branding.logo`, `branding.favicon` | paths inside `web/` |
| `branding.colors` | `background`, `surface`, `text`, `muted`, `accent`, `accentText`, `shiny`, `gold` (#hex) |
| `art` | `hero`, `cardBack`, `placeholder`, and `cards`: a pattern with `{id}`, e.g. `art/cards/{id}.svg` (`pack` is for a pack page) |
| `kinds`, `finishes` | the names of the 5 kinds (in contract order) and the 3 finishes |
| `cards` | `{ id, name, epithet, kind, designHash, art? }` per template, in the minter's order |
| `ipfsGateway` | `https://<gateway>/ipfs/` if your token metadata points at IPFS, else null |

The mint package writes `chain`, `mint` and `cards` for you after a deploy, and checks the shop on chain first:

```bash
cd ../../packages/mint
node scripts/site-config.mjs --config my-drop/mint.config.json --site ../../apps/mint-site/web/site.config.json
```

The rest (words, colours, logo, art) is yours. `pnpm placeholder-art` redraws the plain SVG placeholders (logo, hero,
pack, card back, one card per entry in `cards`) from the config's names and colours; replace any of them with your own
art at the same paths, or point the config at other files. Keep card art 5:7 (250 x 350 or larger).

## Security headers

`vercel.json` sends a strict Content-Security-Policy: everything same-origin, no inline script or style, no other
origin's script, and `connect-src` lists exactly the RPC and the IPFS gateway (when set). It is generated from the config:

```bash
pnpm csp     # after changing chain.rpc or ipfsGateway
```

`pnpm run check` fails when `vercel.json` and the config disagree, when an art path is missing, or when a page would
need something the CSP forbids (an inline script, an inline style, a resource from another origin, HTML written from a
string).

## Local development

```bash
pnpm install
pnpm dev            # http://localhost:5180, with the same headers Vercel sends
```

To try it against a local chain, rehearse a deploy in the mint package (its README: "Rehearse it on a local chain"),
then point a local copy of the config at it. The dev server serves `web/site.config.local.json` (git-ignored, never
deployed) in place of `site.config.json` when it exists:

```bash
cp web/site.config.json web/site.config.local.json
cd ../../packages/mint
node scripts/site-config.mjs --config examples/fixed/mint.config.json --network local --site ../../apps/mint-site/web/site.config.local.json
```

Add the local chain to MetaMask (RPC `http://127.0.0.1:8547`, chain id 31338) and import one of Hardhat's test accounts
(`npx hardhat node` prints them; they are public test keys, never use them anywhere else).

## Tests

`pnpm run check` runs offline: `scripts/check.mjs`, then `node --test`, then a public-only pass
(`scripts/public-check.mjs`: the template without Rapture's private pack page, checked and tested in a temp folder;
it does nothing where that page is absent):

| Suite | |
|---|---|
| `abi.test.mjs` | every hard-coded selector, topic and error id equals ethers' for the compiled ABIs in `test/abi/` (the mint package keeps those equal to its build); encoders and decoders match ethers byte for byte |
| `chain.test.mjs`, `wallet.test.mjs` | the RPC client (retries, timeouts, receipts) and the EIP-1193/EIP-6963 wallet layer |
| `fixed.test.mjs` | the fixed-price client end to end against a fake FixedPriceMinter |
| `holdings.test.mjs` | the library: the ownerOf scan, remembered tokens, ERC721Enumerable, design records |
| `config.test.mjs` | config validation (a `"packs"` config is refused where the pack page is absent), the CSP, and that the committed `vercel.json` matches the template config |

## Deploy

See [DEPLOY.md](DEPLOY.md).

## License

Apache-2.0. The placeholder art in `web/art` is drawn by `scripts/placeholder-art.mjs` and is part of the template.
Rapture characters, names and artwork are © LitVM Games and are not part of this kit.
