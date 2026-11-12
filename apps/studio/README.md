# Rapture Studio

> Formerly Tessaract Studio. Part of the [Rapture SDK](../../README.md), next to the TCG kit it edits games for ([`packages/tcg`](../../packages/tcg), formerly Tessaract).

Build a Web3 trading card game visually. Studio edits the one JSON file that is a Rapture SDK card game, checks it as you type, balances it with bot-vs-bot sims in your browser, and exports a file the TCG kit builds into a playable, deployable game.

- **Cards:** units, spells and relics; seven keywords; abilities on play, death, turn start or attack; effects with chosen or automatic targets. A live card preview shows the rules text.
- **Elements, deck and rules:** the element cycle and colours, deck counts and wallet-deck rules, board and energy numbers, how ERC-6699 stats become champion numbers, and hero powers.
- **Always valid:** the SDK's own `validateGame` runs after every change and lists each problem by field.
- **Balance:** the same harness as `rapture sim`, run in a Web Worker. It reports first-player wins, match length, replay determinism, the six fun targets, hero power win rates, and the strongest and weakest cards.
- **Export:** download or copy the game file, then build the site with the TCG kit (until the Rapture SDK repo is published, `npx` installs it from the last Tessaract release):

```bash
npx github:strodanodev/tessaract create my-game
cd my-game && npm install
# replace games/my-game.game.json with the exported file
npm run sim && npm run web && npm run dev
```

Your draft is saved in your browser only. Nothing is sent anywhere.

## Develop

```bash
pnpm install
pnpm run build     # bundles the TCG kit's browser engine into web/engine and copies its starter game
                   # (RAPTURE_TCG_DIR=../../packages/tcg builds from this repo's kit instead of the installed release)
pnpm run dev       # http://127.0.0.1:4180
pnpm test
```

The site is static (`web/` plus the headers in `vercel.json`); deploy it to any static host.

## License

Apache-2.0 (`LICENSE`).
