/**
 * The contract between the template and a board game. A game is two plain objects, both pure (no DOM, no clock, no
 * randomness, no network) and both written by the builder in `src/game/rules.ts`:
 *
 *   BoardGame   the rules: a position, whose turn it is, the legal moves, playing one, the end. The match layer
 *               (match.ts) wraps it with everything every two-player board game shares (concession, draw offers, the
 *               clock in the log, the move limit), and the result is bundled into the LitNode ruleset. Keep it small:
 *               every byte of it is in the artifact the mesh pins by hash.
 *   BoardView   what the 3D board needs to draw a position and animate a move. The client imports it; the ruleset
 *               does not (esbuild leaves it out of the bundle).
 *
 * Squares are numbered `file + rank * files`, rank 0 being side 0's home row (for chess: a1 = 0, h1 = 7, h8 = 63).
 * A move is a code from 0 to MAX_MOVE_CODE (28 bits): the game chooses the encoding, the log carries it as is.
 */

/** 0 moves first (White in chess), 1 second. */
export type Side = 0 | 1;

/** A finished game: 0 or 1 won, 2 is a draw; `reason` is shown to players and kept in the state ("checkmate"). */
export interface Outcome { winner: 0 | 1 | 2; reason: string }

/** The largest move code a log word carries (bits 3-30 of the word). */
export const MAX_MOVE_CODE = 0x0fffffff;

export interface BoardGame<P = unknown> {
  /** A short name for logs and the input schema ("chess"). */
  name: string;
  /** How a move code is laid out, for the manifest's inputSchema ("from6,to6,promo3"). Change it, change the rulesetId. */
  moveSchema: string;
  /** The starting position. Plain JSON: it is serialised into the state the mesh hashes. `seed` is the match's beacon seed. */
  setup(seed: string): P;
  /** The side to move in a position. */
  turn(p: P): Side;
  /** Every legal move for the side to move. An empty list with no outcome is a stuck game: the move limit ends it. */
  moves(p: P): number[];
  /**
   * Play a legal move (the match layer has checked it against moves()). Return a NEW position (never mutate `p`), the
   * move's notation for the move list, and the outcome when this move ended the game.
   */
  play(p: P, move: number): { position: P; notation: string; outcome: Outcome | null };
  /** Whether `side` could still win by any sequence of legal moves. A flag against a side that cannot win is a draw (chess: FIDE 6.9). Default: true. */
  canWin?(p: P, side: Side): boolean;
}

/** A piece on the board, as the 3D view sees it. `kind` is the game's own name for it ("k", "q", "man", "king"). */
export interface BoardPiece { square: number; kind: string; side: Side }

/** What a move does on the board, for the animation and the highlights. */
export interface MoveSketch {
  from: number;
  to: number;
  /** The square of the piece this move takes, when it takes one (en passant: not `to`). */
  captured?: number;
  /** The kind the moving piece becomes (a promotion). */
  becomes?: string;
  /** Other pieces this move carries along (castling's rook). */
  also?: Array<{ from: number; to: number }>;
  /** The piece jumps (a knight): it travels in a high arc. */
  leap?: boolean;
}

/** A sample game the main menu replays on the board: every move a code from the starting position. */
export interface ShowcaseGame { name: string; where: string; moves: number[] }

export interface BoardView<P = unknown> {
  /** The pieces standing in a position. */
  pieces(p: P): BoardPiece[];
  /** How a legal move plays out. Called with the position before the move. */
  sketch(p: P, move: number): MoveSketch;
  /** A square to warn about (the king in check), or null. */
  alert?(p: P): number | null;
  /** The bot's evaluation of a position, from the point of view of the side to move (higher is better). Default: 0. */
  evaluate?(p: P): number;
  /** The name of a square for the HUD ("e4"). Default: file letter + rank number. */
  squareName?(square: number): string;
  /** Pieces' display names by kind, for the HUD. */
  names?: Record<string, string>;
  /** The kinds a move can promote to, best first, when one choice has to be made for the player. */
  promotions?: string[];
}
