/**
 * YOUR RULESET MODULE. The sample is chess (chess.js does the chess). Replace this file to make your own game: export
 * a `game` (the rules, bundled into the LitNode ruleset) and a `view` (what the 3D board draws). The contract is in
 * src/kit/game.ts; the match layer (concession, draw offers, the clock, the move limit) is the template's.
 *
 * Move code: bits 0-5 from, 6-11 to (a1 = 0 … h8 = 63), 12-14 promotion (0 none, 1 n, 2 b, 3 r, 4 q).
 * The position is the FEN plus the repetition keys since the last capture or pawn move (FIDE 9.2: placement, side to
 * move, castling rights, and the en passant square only when a capture there is legal, which is what chess.js prints).
 */
import { Chess, type Square } from 'chess.js';
import type { BoardGame, BoardPiece, BoardView, MoveSketch, Side } from '../kit/game';

export interface ChessPosition {
  fen: string;
  /** Repetition keys from the last irreversible move (a capture or a pawn move) up to this position. */
  keys: string[];
}

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
const PROMO = ['', 'n', 'b', 'r', 'q'] as const;
export const FILES = 'abcdefgh';
export const squareIndex = (sq: string): number => FILES.indexOf(sq[0]) + (Number(sq[1]) - 1) * 8;
export const squareName = (i: number): Square => `${FILES[i & 7]}${(i >> 3) + 1}` as Square;

/** The move code for a chess move. */
export const chessMove = (from: string, to: string, promotion = ''): number =>
  squareIndex(from) | (squareIndex(to) << 6) | (Math.max(0, PROMO.indexOf(promotion as never)) << 12);
export const decodeChessMove = (code: number): { from: Square; to: Square; promotion: string } =>
  ({ from: squareName(code & 63), to: squareName((code >>> 6) & 63), promotion: PROMO[(code >>> 12) & 7] ?? '' });

const repetitionKey = (fen: string): string => fen.split(' ').slice(0, 4).join(' ');

/**
 * True when `side` cannot checkmate by any legal sequence: a bare king, a lone knight against a bare king, or only
 * bishops on one square colour against nothing but bishops on that same colour (FIDE 6.9: a flag against it is a draw).
 */
export function cannotMate(c: Chess, side: Side): boolean {
  const own = side === 0 ? 'w' : 'b';
  const mine: Array<{ type: string; light: boolean }> = [];
  const theirs: Array<{ type: string; light: boolean }> = [];
  const board = c.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = board[r][f];
    if (!p || p.type === 'k') continue;
    (p.color === own ? mine : theirs).push({ type: p.type, light: (r + f) % 2 === 0 });
  }
  if (mine.length === 0) return true;
  if (mine.length === 1 && mine[0].type === 'n') return theirs.length === 0;
  if (!mine.every((p) => p.type === 'b')) return false;
  const light = mine[0].light;
  return mine.every((p) => p.light === light) && theirs.every((p) => p.type === 'b' && p.light === light);
}

export const game: BoardGame<ChessPosition> = {
  name: 'chess',
  moveSchema: 'from6,to6,promo3',
  setup() {
    const fen = new Chess().fen();
    return { fen, keys: [repetitionKey(fen)] };
  },
  turn: (p) => (p.fen.split(' ')[1] === 'w' ? 0 : 1),
  moves: (p) => new Chess(p.fen).moves({ verbose: true }).map((m) => chessMove(m.from, m.to, m.promotion ?? '')),
  play(p, code) {
    const c = new Chess(p.fen);
    const { from, to, promotion } = decodeChessMove(code);
    const m = c.move({ from, to, ...(promotion ? { promotion } : {}) });
    const fen = c.fen();
    const key = repetitionKey(fen);
    const keys = m.captured || m.piece === 'p' ? [key] : [...p.keys, key];
    const mover: Side = m.color === 'w' ? 0 : 1;
    let outcome: { winner: 0 | 1 | 2; reason: string } | null = null;
    if (c.isCheckmate()) outcome = { winner: mover, reason: 'checkmate' };
    else if (c.isStalemate()) outcome = { winner: 2, reason: 'stalemate' };
    else if (keys.filter((k) => k === key).length >= 3) outcome = { winner: 2, reason: 'threefold repetition' };
    else if (c.isInsufficientMaterial()) outcome = { winner: 2, reason: 'insufficient material' };
    else if (c.isDrawByFiftyMoves()) outcome = { winner: 2, reason: 'fifty-move rule' };
    return { position: { fen, keys }, notation: m.san, outcome };
  },
  canWin: (p, side) => !cannotMate(new Chess(p.fen), side),
};

// ---------------------------------------------------------------- what the board draws (not in the ruleset)

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// piece-square tables from White's point of view, a8 first (index 0) to h1 (index 63)
const PST: Record<string, number[]> = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};

export const view: BoardView<ChessPosition> = {
  pieces(p) {
    const out: BoardPiece[] = [];
    for (const row of new Chess(p.fen).board()) for (const sq of row) {
      if (sq) out.push({ square: squareIndex(sq.square), kind: sq.type, side: sq.color === 'w' ? 0 : 1 });
    }
    return out;
  },
  sketch(p, code) {
    const c = new Chess(p.fen);
    const { from, to, promotion } = decodeChessMove(code);
    const m = c.move({ from, to, ...(promotion ? { promotion } : {}) });
    const s: MoveSketch = { from: squareIndex(m.from), to: squareIndex(m.to), leap: m.piece === 'n' };
    if (m.captured) s.captured = m.flags.includes('e') ? squareIndex(`${m.to[0]}${m.from[1]}`) : squareIndex(m.to);
    if (m.promotion) s.becomes = m.promotion;
    const rank = m.from[1];
    if (m.flags.includes('k')) s.also = [{ from: squareIndex(`h${rank}`), to: squareIndex(`f${rank}`) }];
    if (m.flags.includes('q')) s.also = [{ from: squareIndex(`a${rank}`), to: squareIndex(`d${rank}`) }];
    return s;
  },
  alert(p) {
    const c = new Chess(p.fen);
    if (!c.inCheck()) return null;
    const king = c.findPiece({ type: 'k', color: c.turn() })[0];
    return king ? squareIndex(king) : null;
  },
  evaluate(p) {
    const c = new Chess(p.fen);
    let score = 0;
    const board = c.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const q = board[r][f];
      if (!q) continue;
      const idx = q.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
      const v = VALUE[q.type] + PST[q.type][idx];
      score += q.color === 'w' ? v : -v;
    }
    return c.turn() === 'w' ? score : -score;
  },
  squareName: (i) => squareName(i),
  names: { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' },
  promotions: ['q', 'r', 'b', 'n'],
};
