# Rapture SDK

An open-source kit for building a Web3 game around an NFT collection, in five steps:

1. **Collection:** an ERC-721 with ERC-6699 stats, and its art (Blender or Meshy).
2. **Mint site:** a fixed-price mint or packs, on Vercel.
3. **Game:** a trading card game or a board game, from a template.
4. **LitNode:** conformance checks, a bundled ruleset, registration and hosting.
5. **Your existing game:** bring it to LitNode as an attested title.

Rapture TCG, Rapture Chess, 22 GODS and The Forge are the reference products built with it.

## What is here today

| Package | Folder | Status |
|---|---|---|
| `@rapture-sdk/tcg`: the TCG kit (formerly Tessaract): rules, bots and balance sims, web client, relay, LitNode rulesets, the `rapture` command | [`packages/tcg`](packages/tcg) | ready |
| Rapture Studio (formerly Tessaract Studio): build a card game visually | [`apps/studio`](apps/studio) | ready |
| The `rapture-sdk` Claude Code plugin (marketplace in [`.claude-plugin`](.claude-plugin)) | [`packages/tcg/plugin`](packages/tcg/plugin) | ready: the `tcg` skill |
| `@rapture-sdk/collection`, `@rapture-sdk/mint`, `@rapture-sdk/board`, the mint-site template, and the `rapture` CLI for every step | | planned |

The `tessaract` and `deckwright` commands still run the TCG kit, for one release. The last Tessaract release stays at
https://github.com/strodanodev/tessaract, frozen.

## License

Apache-2.0 (`LICENSE`). Rapture characters, names and artwork are © LitVM Games and are not part of this kit.
