# Changelog

## 0.1.0 (2026-11-13)

First release, extracted from Rapture Chess (which is unchanged):

- the game contract (`src/kit/game.ts`) and the match layer every two-player board game shares (`src/kit/match.ts`):
  moves, concession, draw offers, the time control and clock stamps in the log, the move limit;
- chess as the sample game (`src/game/`), with the ruleset id `board-chess.v1`, procedural pieces and a showcase of
  famous mates;
- the LitNode title (`src/kit/title.ts`), built and checked by LitNode 0.12.1's own bundler, conformance suite and
  sandbox, vendored in `vendor/litnode`;
- the gauntlet relay (`relay/server.mts`): HMAC seat tickets, the clock, ledger signatures checked with LitNode's code,
  and settlement that never waits on the loser (players, then the relay key, then the host);
- the client: the stage with quality presets and the 60 fps governor, the arena and piece loaders, wallet seating
  through the TCG kit's wallet and holdings layer, arcade seating through its shell client, a practice bot, two
  players on one screen, and dev relay rooms;
- `rapture create <dir> --template board` in the TCG kit's CLI.
