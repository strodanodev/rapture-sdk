# @rapture-sdk/board

The Rapture SDK's board-game template, step 3 of the kit for a board game: a 3D two-player board game that seats
wallets, plays over a LitNode gauntlet relay, and bundles its rules into a hash-pinned LitNode ruleset. It is built
from Rapture Chess's reusable parts, and **chess is the sample game**. The pieces are plain procedural ones, the arena
is neutral, and no Rapture art ships with it.

To make your own board game you replace three things:

| File | What it is |
|---|---|
| `src/game/rules.ts` | the ruleset module: your game's rules (`game`) and what the board draws (`view`) |
| `src/game/pieces.ts` | your pieces: procedural meshes, or GLB models named in the config |
| `board.config.ts` | your config: title, ruleset id, board size and colours, arena, clock, wallet collection |

Everything else is the template's engine (`src/kit`), and it works for any two-player, turn-based, perfect-information
game on a grid: the match layer, the 3D stage, the relay, the LitNode title and the wallet seating.

## Start

```bash
rapture create my-board-game --template board --title "My Board Game"   # or copy this folder
cd my-board-game
pnpm install
pnpm dev            # http://127.0.0.1:4175: the menu board replays famous games; play the bot or a friend
pnpm check          # offline: vendored copies, typecheck, tests (the LitNode ruleset built and checked), the site built
```

`rapture create` copies this folder, gives it your name, and sets the ruleset id to `<dir>.v1` and the storage key to
`<dir>`. It builds and fetches nothing.

| Command | Does |
|---|---|
| `pnpm dev` / `pnpm build` | the site (Vite); `dist/` is static, `vercel.json` has the CSP and caching headers |
| `pnpm test` | rules, showcase mates, relay (dev rooms, placed matches, signatures), ruleset build and conformance |
| `pnpm title` | `rulesets/<rulesetId>.js` + `.json` (the artifact TitleRegistry and every node pin) |
| `RELAY_DEV=1 pnpm relay` | a dev relay on `ws://127.0.0.1:7832`; open the site twice with `?relay=ws://127.0.0.1:7832&room=x&name=alice` and `&name=bob` |
| `pnpm relay-key` | the relay's own ed25519 key (`.relay-key.json`, gitignored) and the `RELAY_KEYS=` line for the hosting node |
| `pnpm vendor` | re-copy the vendored LitNode and TCG files (`LITNODE_DIR=<checkout>`) |

## Make your own game

### 1. The rules: `src/game/rules.ts`

Export two objects. Their contract is `src/kit/game.ts`.

```ts
export const game: BoardGame<MyPosition> = {
  name: 'checkers',
  moveSchema: 'from6,to6,jumps8',           // how your 28-bit move code is laid out (goes in the manifest)
  setup(seed) { … },                        // the starting position: plain JSON
  turn(p) { … },                            // 0 or 1: the side to move
  moves(p) { … },                           // every legal move code
  play(p, code) { … },                      // { position (new, never mutate p), notation, outcome | null }
  canWin(p, side) { … },                    // optional: false means a flag against `side`'s opponent is a draw
};
export const view: BoardView<MyPosition> = {
  pieces(p) { … },                          // [{ square, kind, side }]: what stands where
  sketch(p, code) { … },                    // { from, to, captured?, becomes?, also?, leap? }: how a move animates
  alert(p) { … }, evaluate(p) { … },        // optional: a square to warn about, the bot's evaluation
  names: { … }, promotions: [ … ],          // optional: piece names, promotion order
};
```

Squares are numbered `file + rank * files`, with rank 0 being side 0's home row. The rules must be pure: no `Math.random`,
no clock, no network, nothing outside their arguments. LitNode's sandbox removes all of these, and the conformance suite
fails a title that reaches for them. Randomness comes from the `seed` that `setup` receives.

What you do not write is already in the match layer (`src/kit/match.ts`), shared by every game made from the template:
concession, draw offers (once every two plies; moving declines the opponent's offer), the time control and clock
stamps in the log (a flag loses, unless `canWin` says the opponent cannot win), and the move limit (`maxBeats`). A log
entry is `{ k, inputs: [side 0's word, side 1's word] }`; a word is `op | payload << 3` (op 1 move, 2 concede, 3 to 5
draw offers, 6 time control, 7 clock stamp). Any integer replays safely.

### 2. The pieces: `src/game/pieces.ts`

`makePiece(kind, side, color)` returns a three.js object one square wide, standing on y = 0 and facing +z. The kit
turns side 1's pieces round, moves them, fades captures and swaps the mesh on promotion. To use models instead, put
GLBs under `public/models/` and name them per kind in `board.config.ts` (`pieces.models: { k: 'models/king.glb' }`).
Draco and meshopt compression are supported (`scripts/draco.mjs` copies the decoder). Any kind without a model stays
procedural.

### 3. The config: `board.config.ts`

- **`rulesetId`**: your own `name.v1`. TitleRegistry is first come, first served; never reuse another title's id. Every
  change to the rules, the move encoding or the config the ruleset reads (`maxBeats`, `modes`) needs a new `.vN`.
- **`board`**: files, ranks, square and frame colours. The camera, the highlights and picking follow the size.
- **`arena`**: the lighting preset (sky, fog, key/rim/hemi lights, godrays, light shafts, mist, motes, colour grade) and
  either `model: null` (the neutral procedural dais) or a GLB of your own arena under `public/`.
- **`clock`**: the relay's defaults: `control` (`"5+3"` or `"none"`), the first-move window, and the per-move window
  when the game is untimed.
- **`collection`**: wallet seating (below), or `null`.
- **`url`**: where the site is deployed. The arcade launches it in an iframe, so set it before registering.

Also replace `src/game/showcase.ts`, the games the menu board replays (return `[]` for none), and the tests in `test/`
that are chess-specific (`rules.test.ts`, `mates.test.ts`).

## How the parts fit

```
board.config.ts ─┐
src/game/rules.ts ┼─► src/kit/match.ts (match layer) ─┬─► src/kit/title.ts ─► scripts/build-title.mjs ─► rulesets/<id>.js
                  │                                    ├─► relay/server.mts (gauntlet match server)
                  │                                    └─► src/kit/session.ts, relay-client.ts (the client's matches)
src/game/pieces.ts ─► src/kit/scene/ (stage, arena, board, pieces) ◄── src/main.ts (the sample client)
```

- **Stage** (`src/kit/scene/stage.ts`, copied from Rapture Chess): post-processing (N8AO ambient occlusion, godrays,
  bloom, AgX, colour grade, SMAA), quality presets from lite to ultra, and a governor that measures each frame
  (main-thread time, GPU time through timer queries, frame rate) and holds 60 fps. It lowers the render resolution
  first, then the preset, and never flaps between two presets. The quality menu in the top bar overrides it.
- **Arena and piece loaders** (`arena.ts`, `pieces.ts`, `assets.ts`): GLBs with Draco and meshopt, cached per path.
- **Wallet seating** (`src/kit/wallet.ts`): uses the TCG kit's `wallet.js` and `holdings.js`, vendored in
  `src/vendor/tcg`. The player connects a Liteforge wallet, the holdings are read through the collection's RPC
  (Blockscout first, then `ownerOf`), and the tokens the wallet holds are seated on that player's pieces first, as
  badges. Seating is cosmetic and never enters the rules.
- **Arcade seating** (`src/kit/relay-client.ts`, using the TCG kit's `shell.ts`): a page the LitNode arcade launches
  (`?match=&ws=&room=&player=&build=`) claims its seat through the arcade shell (`cabinet:sign-seat`). At the end it
  answers the relay's `sign` request with `cabinet:sign` over the entries it recorded.

## LitNode: build, register, host

The ruleset is built and checked by LitNode's own code. `vendor/litnode` holds LitNode 0.12.1's title bundler, its
conformance suite and the sandbox it runs titles in, pinned by sha256 in `MANIFEST.json`. No LitNode checkout and no
network are needed:

```bash
pnpm title                                   # rulesets/<rulesetId>.js + .json, conformant or nothing is written
pnpm title --litnode ../LITNODE/litnode      # the same with a LitNode checkout's own (newer) copy
```

The buildHash is over the exact bytes. esbuild writes the bundled file's path, relative to the bundler's folder, into
the first line: with the vendored suite that is always `// ../../titles/<rulesetId>.mjs`, so the same source gives the
same hash on any machine (a LitNode checkout elsewhere gives other bytes). Commit `rulesets/<rulesetId>.js` and `.json`
once you register them, and serve those bytes. `.gitattributes` keeps them LF; CRLF would change the hash.

These steps need your keys or your machines. None of them runs here:

1. **Deploy the site** (`vercel deploy --prod`), then set `url` in `board.config.ts` and rebuild the ruleset.
2. **Claim the title** from a LitNode checkout, with the publisher wallet's key in the shell only:
   ```bash
   export PUBLISHER_KEY=0x...
   npm run publish:title -- register /abs/path/to/rulesets/<rulesetId>.js
   npm run publish:title -- status   /abs/path/to/rulesets/<rulesetId>.js
   unset PUBLISHER_KEY
   ```
3. **Host it on a bonded node**. Copy `gauntlets/gauntlet.json`, set its `cwd` to your checkout (with `pnpm install`
   done), and add to the node's `node.env`:
   ```
   RULESETS=/abs/path/to/rulesets/<rulesetId>.js
   GAUNTLETS=<rulesetId>=/abs/path/to/your/gauntlet.json
   RELAY_KEYS=<the public key pnpm relay-key prints>
   ```
   The node spawns `relay/server.mts` per placed match. The relay seats players by the node's HMAC tickets, logs every
   accepted action with the clock, asks both players to sign, and posts the ledger to the node's `/ledger`:
   `players` first, then its own `relay` key, then (casual only) the host's word. The node replays the log in its
   sandbox and settles. The `BOARD_*` variables in the gauntlet config override `board.config.ts`'s clock.

Ranked placement needs four bonded operators carrying the title. Until then matches settle as casual. LitNode has no
stakes or payouts: Rapture Chess's wager escrow (`LitNodeWager.sol`) is not part of this template.

## The worked example

Rapture Chess (`games/rapture-chess` in the Rapture monorepo; live at chess.litvm.games) is this template with its own
pieces (the Rapture ARC 1 champions as rigged avatars), two Blender arenas, and a zkLTC wager escrow. Its ruleset is
`rapture-chess.v2`; the template's sample is `board-chess.v1`. Rapture's art is © LitVM Games and is not part of this kit.

## License

Apache-2.0 (the SDK's `LICENSE`). `vendor/litnode` is LitNode's code (Apache-2.0) and `src/vendor/tcg` is the Rapture
SDK TCG kit's (Apache-2.0); see `NOTICE`.
