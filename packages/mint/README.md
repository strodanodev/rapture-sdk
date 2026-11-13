# @rapture-sdk/mint

Step 2 of the Rapture SDK: sell your collection's cards on LitVM. This package holds two minters and the scripts
around them:

- **FixedPriceMinter** (the default). A catalogue of cards, each with a capped edition. A buyer picks a card, pays a
  fixed price per copy, and the cards are minted to their wallet in the same transaction. Nothing is random, so there
  is nothing to preview, grind or refund.
- **PackShopV2** (the pack option). Sealed packs dealt from a fixed print run (an exact count per kind and finish:
  Normal, Shiny, Gold), with drand randomness verified on chain. It is Rapture's PackShop v2, generalised.

Both mint through the collection's minter, so neither needs a change to the collection. The site that sells them is
the template in [`apps/mint-site`](../../apps/mint-site), and the walkthrough is
[`docs/guide/02-mint-site.md`](../../docs/guide/02-mint-site.md).

## How it fits a collection

The minters call the collection through Rapture's existing minting interface (`IStudioMinter`, vendored unchanged
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
  "fixed": { "price": "0.001", "maxPerWallet": 20, "supply": 100, "lock": true },
  "packs": { "price": "0.001", "packSize": 5, "dailyLimit": 3, "deck": "deck.json", "reserveTo": null, "beacon": null }
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
| `packs.price`, `packs.packSize` | the price of a pack and its cards (1 to 6) |
| `packs.dailyLimit` | packs one wallet may buy per UTC day (0 = no limit) |
| `packs.deck` | the print run: `{ "counts": [[normal, shiny, gold] x 5 kinds] }`; every kind with cards needs a template |
| `packs.reserveTo` | gets the leftover cards (total mod packSize) after the last pack; default the owner, else the deployer |
| `packs.beacon` | an existing `EvmnetRegistry`, or null to deploy one |

`pnpm run check-config my-drop/mint.config.json` checks a config offline: shapes, addresses, amounts, every template
against the reference collection's rules (kinds 0-4, trait ranges, kits, design hashes, CardDesign's name charset),
and the deck against the templates.

Three examples ship in [`examples/`](examples):

| Example | What it shows |
|---|---|
| [`fixed`](examples/fixed) | the default: ten placeholder cards, 100 copies each (the last one 10), 0.001 a card, 20 per wallet |
| [`packs`](examples/packs) | the same cards sold in packs of 5 from a 79-card print run |
| [`rapture`](examples/rapture) | Rapture's ARC 1 pack drop by reference: the live Liteforge collection's addresses and the 888-card deck. Its templates are read from chain with `export-templates` (they are not shipped) |

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

For packs, deploy `examples/packs` the same way (it deploys the real drand verifier and checks it against a live
drand round, so it needs internet; `SKIP_BEACON_CHECK=1` skips that), then keep it:

```bash
node scripts/keeper.mjs --config examples/packs/mint.config.json --network local
```

Addresses go to `deployments/<network>.json` next to the config (`local.json` is git-ignored). To see the site against
this chain, see "Local development" in the [mint-site README](../../apps/mint-site/README.md).

## Deploy on Liteforge

These steps send real transactions and need your keys. Run them yourself; never paste a key into a file.

1. Write your config (copy an example) and your templates, and check it: `pnpm run check-config my-drop/mint.config.json`.
2. **Dry run** (read-only: prints the plan, the signer's balance, who administers the collection minter and, for packs,
   checks that Liteforge verifies a live drand signature):

   ```bash
   MINT_CONFIG=my-drop/mint.config.json DEPLOYER_KEY=0x… pnpm run deploy:liteforge
   ```

3. **For real.** The signer deploys and owns the shop while it stocks it. If the signer is also the collection minter's
   admin, the run grants the MINTER role itself. Otherwise it stops before opening sales and prints the exact
   `setMinter(<shop>, true)` call the admin (for example a Safe) must make; then re-run it.

   ```bash
   MINT_CONFIRM=liteforge MINT_CONFIG=my-drop/mint.config.json DEPLOYER_KEY=0x… pnpm run deploy:liteforge
   ```

   Every stage reads the chain first, so a failed run can simply be re-run. `STAGE=<name>` runs one stage (fixed:
   `shop grant stock preflight lock open handover`; packs: `beacon shop grant stock deck open handover`). The fixed
   minter's `preflight` stage proves, with static calls, that every template mints on the collection before sales open.
4. With `"owner"` set, the Safe accepts ownership: `acceptOwnership()` on the shop, from the Safe.
5. Verify the source on the explorer (step 3 of the guide), then point the site at the shop (`pnpm run site-config`).

Gas, measured on the local rehearsal (multiply by Liteforge's gas price, ~0.2 gwei, for the cost): a FixedPriceMinter
deploy is 2.1M and stocking 0.28M per template; a PackShopV2 deploy is 4.4M and its EvmnetRegistry 4.2M. A buyer pays
about 1M gas per card minted (fixed), or 0.18M to buy a pack and 4.5-4.6M to open it.

### Verify

```bash
pnpm compile
node scripts/verify.mjs --config my-drop/mint.config.json                       # read-only: proves the code on chain is this build
EXPLORER_URL=https://<liteforge blockscout> VERIFY_CONFIRM=liteforge node scripts/verify.mjs --config my-drop/mint.config.json
```

The first command compares the code at the shop's address (and the EvmnetRegistry's, if the deploy created it) with
this build, immutables masked, and checks the constructor arguments against the creation transaction. It writes the
explorer package to `verification/<network>/`: the minimal standard JSON input, the ABI-encoded constructor arguments
and `result.json`. The second submits it to Blockscout's Etherscan-compatible API and polls the job. The Liteforge
explorer URL is not filled in (`scripts/lib/networks.json` has `explorer: null`): the old Caldera explorer is gone.
Set it there, or pass `EXPLORER_URL`, once you know it.

### The keeper (packs only)

```bash
KEEPER_KEY=0x… node scripts/keeper.mjs --config my-drop/mint.config.json            # any funded wallet: dealing is permissionless
KEEPER_KEY=0x… node scripts/keeper.mjs --config my-drop/mint.config.json --open     # also mints packs left unopened 10 minutes
```

As soon as a sealed pack's drand round is published, the keeper proves it and deals the pack (~0.3M gas per round,
~70k per pack), so every pull is fixed within seconds and no buyer pays to deal someone else's pack. When the chain
clock lags real time it posts drand's latest round through the shop, so new packs never bind to a round that is
already public. Run it on a small always-on machine for as long as the shop sells, and after a `shutdown()`: proving
a round removes that pack's refund option. Settings: `POLL_MS`, `OPEN_AFTER`, `MAX_DEAL`, `RPC_URL`.

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

## PackShopV2

```
buyPack()   --pay the price-->  sealed pack, bound to drand evmnet round  now + 5  (13-15 s ahead; nobody knows it yet)
   ...round published (League of Entropy, BLS on BN254, a round every 3 s)...
deal / openPack(id, rounds, signatures)  -->  signature verified ON CHAIN, pack dealt from the deck, cards minted to the buyer
```

- **Supply is a fixed deck**, locked before the first sale. Packs deal without replacement from what is left, so the
  final distribution is exactly the deck. `deckRemaining()` is public: odds follow the deck as it empties.
- **No refunds while the shop runs.** A drand signature never expires, so a pack's cards are fixed once its round is
  out: there is nothing to skip. Packs are dealt strictly in purchase order.
- **The owner cannot touch a pull.** Templates and deck are frozen by `lock()`. Afterwards the owner can pause new
  sales (never opening), set the price of future packs and the daily limit, withdraw revenue above `liability` (the
  price of unopened packs), and `shutdown()`.
- **Finishes** (1 Normal, 2 Shiny, 3 Gold) are recorded per token in the shop (`finishOf`, `finishesOf`) and emitted in
  `PackDealt` / `PackOpened`. A metadata contract that should show them reads `finishOf`.
- **Kinds and rules.** The deck has five kinds (the interface's `kind` 0-4) and three finishes. `addTemplates` checks
  each template against the rules the reference collection enforces at mint time, so a dealt pack can never hold a
  card that reverts. If your collection's minter enforces other rules, override `_validate`.

**Residual trust, stated plainly.**
1. The round is picked from `block.timestamp`, or from the latest round already proven in the shop if that is later.
   If the chain clock lags real time by more than 5 rounds (13-15 s) and nobody has posted a fresh round, a buyer
   contract could act on a round that is already public. The keeper watches for lag and posts drand's latest round.
2. The collection minter's admin can revoke the shop's MINTER role, which blocks minting. Dealt cards stay recorded.
   After `shutdown()` + 7 days, the buyer can `refund(id)` a pack that cannot be delivered: a sealed pack whose round
   is still unproven, or a dealt pack once minting is gone. A refunded sealed pack is still drawn in its turn, so no
   refund changes anyone else's pull.
3. `EvmnetRegistry` (`contracts/vendor/bls-solidity`, the drand team's library, vendored unmodified, MIT) calls itself
   experimental. zkSecurity reviewed the library in September 2025.

**Known limits** (each pinned by a `FINDING: [info]` test in `test/review/adversarial-v2.test.js`): after a shutdown,
an unproven pack's holder can compute the pull and refund a bad one until a keeper pass proves its round; re-granting
MINTER after a shutdown opens a refund window for dealt packs; a contract buyer that cannot call `refund()` keeps its
price locked if minting is gone for good; a post sent straight to `EvmnetRegistry` does not count as a fresh round
(post through the shop); `latestRound` trusts the beacon, so deploy only against `EvmnetRegistry`; without a keeper,
opening pack N pays ~40k gas per earlier undealt pack and ~250k per distinct pending round (the site deals in chunks
past ~90 pending rounds).

Why drand: LitVM is an Arbitrum Orbit chain. Its proofs show that blocks executed correctly; they cannot make a number
unpredictable. `block.prevrandao` is the constant 1, Arbitrum documents `blockhash` as insecure, and LitVM has no VRF.
drand evmnet is the drand network built for the EVM: BN254 signatures checked with the standard precompiles 0x05-0x08,
which Liteforge supports (the dry run proves it).

## Tests

`pnpm run check` runs everything offline: `hardhat test` (the compiler is the `solc` npm package, so nothing is
downloaded) and `check-config` over the three examples.

| Suite | |
|---|---|
| `test/fixed-price.test.js` | FixedPriceMinter: catalogue, payment, edition caps, wallet limit, MINTER role, a rejected template, lock, money, ownership |
| `test/packshop-v2.test.js` | 26 tests: deck lock, FIFO dealing, sell-out to the exact deck, the full ARC 1 deck dealt cell for cell, real evmnet signatures (valid, wrong round, tampered), the `latestRound` binding, shutdown/refund, re-entrancy |
| `test/review/adversarial-v2.test.js` | 37 tests from an independent adversarial review, in two rounds; every fixed issue has a `blocked:` test |
| `test/deploy.test.js` | the deploy stages for both modes, idempotent re-runs, a non-admin signer, the preflight, and the config checks |
| `test/site-abi.test.js` | the mint site's ABI copies equal this build (`UPDATE_SITE_ABI=1` refreshes them) |

## Layout

```
contracts/FixedPriceMinter.sol           the default minter
contracts/PackShopV2.sol                 the pack shop (from Rapture's PackShop v2)
contracts/interfaces/IStudioMinter.sol   the minting interface both call (StudioCard, mintBatch, minters, bandOf)
contracts/vendor/rapture/interfaces/     Rapture's shared types, vendored unchanged
contracts/vendor/bls-solidity/           drand's BLS library and EvmnetRegistry, vendored unmodified (MIT)
contracts/test/                          test harnesses, and reference/: the deployed Rapture collection contracts the
                                         tests mint into (a copy of what forge-hall publishes; test-only)
scripts/deploy.js                        deploy either minter from a mint config (dry run off local chains)
scripts/verify.mjs                       prove the on-chain code is this build; submit to Blockscout on request
scripts/keeper.mjs                       deal packs as their drand rounds come out
scripts/site-config.mjs                  point a mint site at the shop (checks it on chain first)
scripts/export-templates.mjs             read finished cards from a collection into a templates file
scripts/check-config.mjs                 check mint configs offline
scripts/lib/                             config, deploy stages, networks (networks.json), shared helpers
examples/                                fixed, packs, and Rapture by reference
```

## License

Apache-2.0. `contracts/vendor/bls-solidity` is MIT (its own `LICENSE`). Rapture characters, names and artwork are
© LitVM Games and are not part of this kit.
