# Step 3: the game

Your collection exists (step 1) and players can mint it (step 2). Now make the game they play with it. The Rapture
SDK has two templates. Both seat the player's wallet, record every match as a replayable integer log, and build a
LitNode ruleset that step 4 registers and hosts.

| Template | For | Package | Reference product |
|---|---|---|---|
| **TCG** | a trading card game: tokens become cards, ERC-6699 stats make champions | [`packages/tcg`](../../packages/tcg) | Rapture TCG |
| **Board game** | a two-player, turn-based board game on a grid: chess, checkers, your own | [`packages/board`](../../packages/board) | Rapture Chess |

## A trading card game

One JSON file is the whole game: cards, deck, elements and rules. The TCG kit scaffolds a project, imports your
collection as a card set, balances it with bot-against-bot simulations, builds the static site, and bundles the LitNode
ruleset:

```bash
rapture create my-tcg --title "My TCG"
rapture snapshot <collection address> --chain liteforge --out collection
rapture import collection/cards.json --id my-tcg --out games
rapture sim games/my-tcg.game.json --matches 300
rapture title games/my-tcg.game.json
```

The kit's README is the full guide: [`packages/tcg/README.md`](../../packages/tcg/README.md). Its Claude Code plugin
(`rapture-sdk`, skill `tcg`) can build a whole game from one request.

## A board game

The board template is Rapture Chess's reusable parts with chess as the sample game: a 3D stage with quality presets and
a 60 fps governor, arena and piece loaders, wallet seating, the gauntlet match server, and the LitNode ruleset builder.
The pieces are procedural and the arena is neutral, so no Rapture art ships with it.

### 1. Create the project

From a checkout of the Rapture SDK:

```bash
cd packages/tcg && pnpm install
pnpm rapture create /path/to/my-board-game --template board --title "My Board Game"
cd /path/to/my-board-game
pnpm install
pnpm dev        # http://127.0.0.1:4175: play chess against the bot, or two players on one screen
pnpm check      # offline: typecheck, tests, the LitNode ruleset built and checked, the site built
```

The copy gets your name, the ruleset id `my-board-game.v1` and its own storage key. Nothing is built or fetched until
you install it. You can also copy `packages/board` by hand; then set your own `rulesetId` before anything else.

### 2. Make it your game

You replace three files. Everything else is the template's engine (`src/kit/`):

1. **`src/game/rules.ts`**, the ruleset module. Export a `game`: the starting position, whose turn it is, the legal
   moves (each one an integer code you design), playing a move (the new position, its notation, and the outcome when it
   ends the game) and, optionally, whether a side can still win. Also export a `view`: which pieces stand where, how a
   move animates (from, to, captured, promotion, carried pieces like castling's rook), and an optional evaluation for
   the practice bot. The rules must be pure: no randomness except the seed, no clock, no network.
2. **`src/game/pieces.ts`**, the pieces: procedural meshes from `makePiece(kind, side, color)`, or GLB models per kind
   named in the config.
3. **`board.config.ts`**: title, ruleset id, board size and colours, the arena (a lighting preset, plus the neutral
   dais or your own GLB), the clock, the move limit and the wallet collection.

What you do not write is already in the match layer, the same for every game made from the template: concession, draw
offers, the time control and clock stamps in the log, flags (with a draw when the opponent cannot win), and the move
limit. The relay, the client and the LitNode ruleset all replay the same log through it.

Replace the chess-specific tests (`test/rules.test.ts`, `test/mates.test.ts`) and the menu's showcase games
(`src/game/showcase.ts`) along the way. The relay and ruleset tests are generic and keep working.

### 3. Seat the player's wallet

Set `collection` in `board.config.ts` to your ERC-721 on Liteforge (address, chain 4441, the RPC
`https://rpc.testnet.liteforge.zeeve.net/`, and optionally a Blockscout explorer and a snapshot of the tokens). A
player who connects a wallet sees the tokens they hold seated on their pieces first. It uses the TCG kit's own wallet
and holdings layer. Seating is cosmetic; to let tokens change the game, put that in the rules and give it a new
ruleset id.

### 4. Two players, then the arcade

Locally:

```bash
RELAY_DEV=1 pnpm relay
# open the site twice: ?relay=ws://127.0.0.1:7832&room=x&name=alice  and  &name=bob
```

On LitNode, the same relay is the **gauntlet**, the match server a hosting node spawns for each placed match.
`gauntlets/gauntlet.json` is its config. The page the arcade launches seats itself through the arcade shell, both
players sign the log at the end, and the node replays it and settles. If the loser never signs, the relay's own key
(`pnpm relay-key`) settles it.

### 5. Build the ruleset

```bash
pnpm title      # rulesets/<rulesetId>.js + .json: LitNode's own bundler and conformance suite, vendored
```

Step 4 takes it from there: [04-litnode](04-litnode.md) covers registering the title, hosting it on a node and the
arcade listing. The commands that need your publisher key or your node are also at the end of
[`packages/board/README.md`](../../packages/board/README.md).
