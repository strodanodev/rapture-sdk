# Rapture SDK

An open-source kit for building a Web3 game around an NFT collection, in five steps:

1. **Collection:** an ERC-721 with ERC-6699 stats, and its art (Blender or Meshy).
2. **Mint site:** a fixed-price mint, on Vercel (packs later).
3. **Game:** a trading card game or a board game, from a template.
4. **LitNode:** conformance checks, a bundled ruleset, registration and hosting.
5. **Your existing game:** bring it to LitNode as an attested title.

Rapture TCG, Rapture Chess, 22 GODS and The Forge are the reference products built with it.

## What is here today

| Step | Package | Folder | Guide |
|---|---|---|---|
| 1 | `@rapture-sdk/collection`: an ERC-721 whose tokens mirror their ERC-6699 stats into the canonical registry, the metadata and IPFS pipeline, the Blender harness and an optional Meshy generator | [`packages/collection`](packages/collection) | [01](docs/guide/01-collection.md) |
| 2 | `@rapture-sdk/mint`: a fixed-price minter with capped editions. PackShop v2 packs: private until launch | [`packages/mint`](packages/mint) | [02](docs/guide/02-mint-site.md) |
| 2 | The mint-site template: a static Vercel site driven by one config file | [`apps/mint-site`](apps/mint-site) | [02](docs/guide/02-mint-site.md) |
| 3 | `@rapture-sdk/tcg`: the TCG kit (formerly Tessaract): rules, bots and balance sims, web client, relay, LitNode rulesets, the `rapture` command | [`packages/tcg`](packages/tcg) | [03](docs/guide/03-game.md) |
| 3 | `@rapture-sdk/board`: the board-game template, with chess as the sample (`rapture create <dir> --template board`) | [`packages/board`](packages/board) | [03](docs/guide/03-game.md) |
| 3 | Rapture Studio (formerly Tessaract Studio): build a card game visually | [`apps/studio`](apps/studio) | |
| 4 | LitNode: conformance, bundle, register, host | the `title` tools in `tcg` and `board` | [04](docs/guide/04-litnode.md) |
| 5 | Bring your existing game, with 22 GODS as the case study | | [05](docs/guide/05-bring-your-game.md) |
| | The `rapture-sdk` Claude Code plugin (marketplace in [`.claude-plugin`](.claude-plugin)): the `tcg` skill so far | [`packages/tcg/plugin`](packages/tcg/plugin) | |

Still planned: one `rapture` CLI for every step (`packages/cli`), a skill per step in the plugin, and npm packages
(they need an npm org, `rapture-sdk`). Each package checks itself with `pnpm run check`.

The `tessaract` and `deckwright` commands still run the TCG kit, for one release. The last Tessaract release stays at
https://github.com/strodanodev/tessaract, frozen.

## License

Apache-2.0 (`LICENSE`). Rapture characters, names and artwork are © LitVM Games and are not part of this kit.
