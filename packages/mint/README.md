# @rapture-sdk/mint

Step 2 of the Rapture SDK: sell your collection's cards on LitVM with **FixedPriceMinter**. It holds a catalogue of
cards, each with a capped edition. A buyer picks a card, pays a fixed price per copy, and the cards are minted to their
wallet in the same transaction. Nothing is random, so there is nothing to preview, grind or refund.

It mints through the collection's minter, so the collection needs no change. The site that sells it is the template in
[`apps/mint-site`](../../apps/mint-site), and the walkthrough is [`docs/guide/02-mint-site.md`](../../docs/guide/02-mint-site.md).

A pack option exists too (PackShop v2: sealed packs from a fixed print run, with drand randomness), but it isn't
published in this kit yet: it stays in Rapture's private build until Rapture launches it. A config with
`"mode": "packs"` is refused with that reason.

## How it fits a collection

The minter calls the collection through Rapture's existing minting interface (`IStudioMinter`, vendored unchanged
from `apps/forge-site/packshop/contracts`): `mintBatch(StudioCard[])`, `minters(address)` and `bandOf(kind)`. A
collection made with `@rapture-sdk/collection` exposes the same interface, and so does the live Rapture collection
on Liteforge. The one piece of wiring is that **the collection minter's admin grants the shop the MINTER role**:

```solidity
StudioMinter(collectionMinter).setMinter(shopAddress, true);   // only the minter's admin can send this
```

A **template** is a card the shop can mint: its kind, traits and stats, style source and design record (exactly what
`mintBatch` takes, minus the recipient). Every sale mints a new token from a template, so one design can sit in many
wallets, each copy its own token.

## The mint config

One JSON file says which collection to sell, how, and who owns the shop. Paths are relative to the file.

```json
{
  "network": "liteforge",
  "collection": { "minter": "0x…", "cards": "0x…", "tokenIdBase": "0" },
  "templates": "templates.json",
  "mode": "fixed",
  "owner": "0x… (a Safe) or null",
  "fixed": { "price": "0.001", "maxPerWallet": 20, "supply": 100, "lock": true }
}
```

| Field | Meaning |
|---|---|
| `collection.minter` | the collection's minter (`IStudioMinter`) |
| `collection.cards` | the ERC-721, for the mint site's library |
| `collection.tokenIdBase` | the first token id of the set (Rapture: `setId << 32` = `4294967296`), for the library |
| `templates` | a JSON array of templates, or `{ "templates": [{ "template": {…}, "supply": n }] }` (what `export-templates` writes) |
| `owner` | offered ownership after setup (two-step: it calls `acceptOwnership()`); use a Safe |
| `fixed.price` | the price of one card, in the native token (zkLTC on LitVM) |
| `fixed.maxPerWallet` | cards one wallet may buy, ever (0 = no limit) |
| `fixed.supply` | the default edition size; a template's own `supply` overrides it |
| `fixed.lock` | freeze the catalogue and edition sizes after stocking (irreversible) |

`pnpm run check-config my-drop/mint.config.json` checks a config offline: shapes, addresses, amounts, and every
template against the reference collection's rules (kinds 0-4, trait ranges, kits, design hashes, CardDesign's name
charset). [`examples/fixed`](examples/fixed) is a complete one: ten placeholder cards, 100 copies each (the last one 10),
0.001 a card, 20 per wallet.

## Rehearse it on a local chain

Everything below runs on your machine; nothing touches Liteforge.

```bash
pnpm install
pnpm test                       # contracts, scripts, the deploy stages
pnpm run node                   # terminal 1: a Hardhat node on port 8547, chain 31338, a block every 3 s
```

```bash
# terminal 2. On a local chain the deploy sends right away, and since the config's minter has no code there it first
# deploys the reference collection to sell.
MINT_CONFIG=examples/fixed/mint.config.json pnpm run deploy:local
node scripts/verify.mjs --config examples/fixed/mint.config.json --network local
```

Addresses go to `deployments/<network>.json` next to the config (`local.json` is git-ignored). To see the site against
this chain, see "Local development" in the [mint-site README](../../apps/mint-site/README.md).

## Deploy on Liteforge

These steps send real transactions and need your keys. Run them yourself; never paste a key into a file.

1. Write your config (copy the example) and your templates, and check it: `pnpm run check-config my-drop/mint.config.json`.
2. **Dry run** (read-only: prints the plan, the signer's balance and who administers the collection minter):

   ```bash
   MINT_CONFIG=my-drop/mint.config.json DEPLOYER_KEY=0x… pnpm run deploy:liteforge
   ```

3. **For real.** The signer deploys and owns the shop while it stocks it. If the signer is also the collection minter's
   admin, the run grants the MINTER role itself. Otherwise it stops before opening sales and prints the exact
   `setMinter(<shop>, true)` call the admin (for example a Safe) must make; then re-run it.

   ```bash
   MINT_CONFIRM=liteforge MINT_CONFIG=my-drop/mint.config.json DEPLOYER_KEY=0x… pnpm run deploy:liteforge
   ```

   Every stage reads the chain first, so a failed run can simply be re-run. `STAGE=<name>` runs one stage:
   `shop grant stock preflight lock open handover`. The `preflight` stage proves, with static calls, that every
   template mints on the collection before sales open.
4. With `"owner"` set, the Safe accepts ownership: `acceptOwnership()` on the shop, from the Safe.
5. Verify the source on the explorer (below), then point the site at the shop (`pnpm run site-config`).

Gas, measured on the local rehearsal (multiply by Liteforge's gas price, ~0.2 gwei, for the cost): the deploy is 2.1M
and stocking 0.28M per template. A buyer pays about 1M gas per card minted.

### Verify

```bash
pnpm compile
node scripts/verify.mjs --config my-drop/mint.config.json                       # read-only: proves the code on chain is this build
EXPLORER_URL=https://<liteforge blockscout> VERIFY_CONFIRM=liteforge node scripts/verify.mjs --config my-drop/mint.config.json
```

The first command compares the code at the shop's address with this build, immutables masked, and checks the
constructor arguments against the creation transaction. It writes the explorer package to `verification/<network>/`:
the minimal standard JSON input, the ABI-encoded constructor arguments and `result.json`. The second submits it to
Blockscout's Etherscan-compatible API and polls the job. The Liteforge explorer URL is not filled in
(`scripts/lib/networks.json` has `explorer: null`): the old Caldera explorer is gone. Set it there, or pass
`EXPLORER_URL`, once you know it.

## FixedPriceMinter

| | |
|---|---|
| Buy | `mint(templateId, quantity)`: exactly `price * quantity`, 1 to 10 cards, minted to the caller in the same transaction |
| Owner, before `lock()` | `addTemplates(templates, maxSupplies)`, `retireTemplate(id)` |
| Owner, always | `setPrice`, `setMaxPerWallet`, `pause`/`unpause`, `ownerMint(to, id, n)` within the edition caps (also while paused), `withdraw(to, amount)` |
| Views | `config()` (one call for the page), `editionsOf(from, n)`, `templateOf(id)`, `templatesOf(tokenIds)` (template id + 1 per token, 0 = not minted here), `mintableBy(wallet)` |

It deploys paused. It refuses to sell without the MINTER role (`NotMinter`), so no payment is taken for a card that
cannot mint, and a template the collection rejects reverts the whole mint, so the buyer keeps the price. `lock()`
freezes the catalogue and every edition size for good. Ownership is two-step and cannot be renounced (it would strand
the revenue).

## Tests

`pnpm run check` runs everything offline: `hardhat test` (the compiler is the `solc` npm package, so nothing is
downloaded), `check-config` over the examples, and a public-only pass (`scripts/public-check.mjs`: the package
without Rapture's private parts, compiled and tested in a temp folder; it does nothing where they are absent).

| Suite | |
|---|---|
| `test/fixed-price.test.js` | FixedPriceMinter: catalogue, payment, edition caps, wallet limit, MINTER role, a rejected template, lock, money, ownership |
| `test/deploy.test.js` | the deploy stages, idempotent re-runs, a non-admin signer, the preflight, the config checks, and a refused `"packs"` config |
| `test/site-abi.test.js` | the mint site's ABI copies equal this build (`UPDATE_SITE_ABI=1` refreshes them) |

## Layout

```
contracts/FixedPriceMinter.sol           the minter
contracts/interfaces/IStudioMinter.sol   the minting interface it calls (StudioCard, mintBatch, minters, bandOf)
contracts/vendor/rapture/interfaces/     Rapture's shared types, vendored unchanged
contracts/test/reference/                the deployed Rapture collection contracts the tests mint into (a copy of what
                                         forge-hall publishes; test-only)
scripts/deploy.js                        deploy the minter from a mint config (dry run off local chains)
scripts/verify.mjs                       prove the on-chain code is this build; submit to Blockscout on request
scripts/site-config.mjs                  point a mint site at the shop (checks it on chain first)
scripts/export-templates.mjs             read finished cards from a collection into a templates file
scripts/check-config.mjs                 check mint configs offline
scripts/public-check.mjs                 the public kit's own check (see Tests)
scripts/lib/                             config, deploy stages, networks (networks.json), shared helpers
examples/fixed/                          a complete fixed-price drop with placeholder cards
```

## License

Apache-2.0. Rapture characters, names and artwork are © LitVM Games and are not part of this kit.
