/**
 * The sample client: the 3D board (stage, arena, board, pieces), a small HUD, and three ways to play: against the
 * practice bot, two players on one screen, or over the relay (a dev room, or a match the LitNode arcade placed).
 * Everything game-specific comes from board.config.ts and src/game/; this file only wires the kit together.
 */
import * as THREE from 'three';
import config from '../board.config';
import { view } from './game/rules';
import { makePiece } from './game/pieces';
import { showcase } from './game/showcase';
import { encodeMove, entryAction, moveCode } from './kit/match';
import { Arena } from './kit/scene/arena';
import { BoardMesh } from './kit/scene/board';
import { PieceSet, pieceOf, type PieceView } from './kit/scene/pieces';
import { Stage, QUALITIES, type Quality } from './kit/scene/stage';
import { LocalMatch, newRules, type LogEntry, type Match, type MatchEvents, type State } from './kit/session';
import { RelayMatch } from './kit/relay-client';
import { createWeb3Link, seatTokens } from './kit/wallet';
import './style.css';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const nameOf = (sq: number): string => view.squareName?.(sq) ?? `${config.board.fileNames[sq % config.board.files] ?? '?'}${Math.floor(sq / config.board.files) + 1}`;
const sideName = (s: number): string => config.sides[s]?.name ?? `Side ${s}`;

document.title = config.title;
$('#title').textContent = config.title;

// ------------------------------------------------------------------ the scene
const stage = new Stage($<HTMLCanvasElement>('#stage'), config.storageKey);
stage.setBoardSize(config.board.files, config.board.ranks);
stage.setAccentColors(config.sides[0].light, config.sides[1].light);
const arena = new Arena(stage);
const board = new BoardMesh(config.board);
const pieces = new PieceSet(board, makePiece, config);
stage.scene.add(board.group, pieces.group);
stage.onUpdate((dt) => board.update(dt));

// ------------------------------------------------------------------ wallet seating
const web3 = createWeb3Link(config.collection);
const walletBtn = $<HTMLButtonElement>('#wallet');
walletBtn.hidden = !config.collection;
walletBtn.onclick = () => { void web3.toggle().catch((e) => status((e as Error).message)); };
web3.onChange(() => { walletBtn.textContent = web3.address() ? `${web3.shortAddress()} · ${web3.owned.size} held` : 'Connect wallet'; seat(); });
void web3.restore();

/** Badge your side's pieces with the collection's tokens, the ones your wallet holds first (cosmetic only). */
function seat(): void {
  if (!config.collection) return;
  const order = Object.keys(view.names ?? {});
  const mine = pieces.all().filter((p) => p.side === (match?.you ?? 0)).sort((a, b) => rank(a) - rank(b));
  function rank(p: PieceView): number { const i = order.indexOf(p.kind); return i < 0 ? order.length : i; }
  const seated = seatTokens(mine.map((p) => p.square), web3.tokens, web3.owned, match?.seed ?? 'menu');
  for (const p of pieces.all()) {
    const t = seated.get(p.square);
    p.setBadge(t ? String(t.name ?? `#${t.tokenId}`) : null, !!t && web3.owned.has(t.tokenId));
  }
}

// ------------------------------------------------------------------ HUD
const statusEl = $('#status'), movesEl = $('#moves'), clocksEl = $('#clocks');
const status = (t: string): void => { statusEl.textContent = t; };
function hud(): void {
  if (!match) return;
  const s = match.state;
  if (s.over) status(s.winner === 2 ? `Draw: ${s.reason}` : `${sideName(s.winner)} wins: ${s.reason}`);
  else if (match.yourTurn) status(`${sideName(s.turn)} to move: your move`);
  else status(`${sideName(s.turn)} to move`);
  movesEl.innerHTML = '';
  for (let i = 0; i < s.notes.length; i += 2) {
    const li = document.createElement('li');
    li.textContent = `${s.notes[i]}${s.notes[i + 1] ? `  ${s.notes[i + 1]}` : ''}`;
    movesEl.append(li);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
  $<HTMLButtonElement>('#concede').disabled = s.over;
  const offer = $<HTMLButtonElement>('#offer'), accept = $<HTMLButtonElement>('#accept'), decline = $<HTMLButtonElement>('#decline');
  offer.hidden = !match.drawOffers || s.over;
  accept.hidden = decline.hidden = !match.drawOffers || s.over || s.offer !== (match.you === 0 ? 1 : 0);
  offer.disabled = !match.rules.canDraw(s, match.you, 3);
}
const fmt = (ms: number): string => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
setInterval(() => {
  const c = match instanceof RelayMatch ? match.clock : null;
  if (!c || !match || match.state.over) { clocksEl.textContent = ''; return; }
  const run = Math.max(0, c.deadline - Date.now());
  if (!c.timed || c.firstMove) { clocksEl.textContent = `${sideName(c.side)}: ${fmt(run)} to move`; return; }
  const left: [number, number] = [c.left[0], c.left[1]];
  left[c.side] = run;
  clocksEl.textContent = `${sideName(0)} ${fmt(left[0])} · ${sideName(1)} ${fmt(left[1])}`;
}, 200);

// ------------------------------------------------------------------ the match
let match: Match | null = null;
let busy: Promise<void> = Promise.resolve();
let attract = false;

const events: MatchEvents = {
  onStep(entry: LogEntry, prev: State, state: State) {
    busy = busy.then(async () => {
      if (entry.k < 0) faceYou(); // a relay match started: now this screen knows its side
      if (state.plies > prev.plies && entry.k >= 0) {
        const sketch = view.sketch(prev.pos, moveCode(entryAction(entry.inputs)));
        await pieces.play(sketch);
        board.setLastMove(sketch.from, sketch.to);
      }
      pieces.sync(view.pieces(state.pos));
      board.setAlert(view.alert?.(state.pos) ?? null);
      seat();
      hud();
      match?.poke();
    });
  },
  onStatus: status,
};

/** Look from your own side of the board (a relay match learns the side on `start`). */
function faceYou(): void {
  const span = Math.max(config.board.files, config.board.ranks) / 8;
  void stage.flyTo(new THREE.Vector3(0, 9.5 * span, ((match?.you ?? 0) === 1 ? -11.5 : 11.5) * span), 1.2);
}

function begin(m: Match): void {
  stopAttract();
  match?.close();
  match = m;
  select(null);
  board.setLastMove(null, null);
  board.setAlert(null);
  pieces.sync(view.pieces(m.state.pos));
  faceYou();
  $('#menu').hidden = true;
  $('#panel').hidden = false;
  seat();
  hud();
  m.poke();
}

$<HTMLButtonElement>('#play-0').onclick = () => begin(new LocalMatch(randomSeed(), 0, events, true));
$<HTMLButtonElement>('#play-1').onclick = () => begin(new LocalMatch(randomSeed(), 1, events, true));
$<HTMLButtonElement>('#hotseat').onclick = () => begin(new LocalMatch(randomSeed(), 0, events, false));
$<HTMLButtonElement>('#concede').onclick = () => match?.concede();
$<HTMLButtonElement>('#offer').onclick = () => match?.offerDraw();
$<HTMLButtonElement>('#accept').onclick = () => match?.acceptDraw();
$<HTMLButtonElement>('#decline').onclick = () => match?.declineDraw();
$<HTMLButtonElement>('#leave').onclick = () => { match?.close(); match = null; $('#panel').hidden = true; $('#menu').hidden = false; void startAttract(); };
function randomSeed(): string { const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }

// ------------------------------------------------------------------ input: pick a piece, then a target
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let selected: number | null = null;
let targets = new Map<number, number[]>(); // to-square -> legal move words (several: a promotion choice)

function squareAt(ev: PointerEvent): number | null {
  const r = stage.canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, stage.camera);
  const hit = ray.intersectObjects([...pieces.pickables(), board.pickPlane], true)[0];
  if (!hit) return null;
  const piece = pieceOf(hit.object);
  return piece ? piece.square : board.worldToSquare(hit.point);
}

function select(sq: number | null): void {
  selected = sq;
  targets = new Map();
  board.setSelected(sq);
  if (sq === null || !match) { board.clearTargets(); return; }
  for (const x of match.rules.legalActions(match.state)) {
    const s = view.sketch(match.state.pos, moveCode(x));
    if (s.from !== sq) continue;
    targets.set(s.to, [...(targets.get(s.to) ?? []), x]);
  }
  const captures = new Set([...targets.keys()].filter((to) => !!pieces.at(to)));
  board.showTargets([...targets.keys()], captures);
}

stage.canvas.addEventListener('pointermove', (ev) => { if (match && !attract) board.setHover(squareAt(ev)); });
stage.canvas.addEventListener('pointerup', (ev) => {
  if (!match || attract || !match.yourTurn) return;
  const sq = squareAt(ev);
  if (sq === null) return select(null);
  const words = targets.get(sq);
  if (selected !== null && words) {
    const word = words.length > 1 ? promotionChoice(words) : words[0];
    select(null);
    if (word !== undefined) match.act(word);
    return;
  }
  const p = pieces.at(sq);
  select(p && p.side === match.state.turn ? sq : null);
});

/** Several moves to one square: the kinds a piece can become. The first of view.promotions that is legal wins. */
function promotionChoice(words: number[]): number | undefined {
  const st = match!.state;
  const by = new Map(words.map((w) => [view.sketch(st.pos, moveCode(w)).becomes ?? '', w]));
  for (const kind of view.promotions ?? []) if (by.has(kind)) return by.get(kind);
  return words[0];
}

// ------------------------------------------------------------------ the menu board: showcase games on loop
const games = showcase();
/** Bumped whenever the menu board stops: a showcase loop that wakes up under an older generation does nothing. */
let attractGen = 0;
async function startAttract(): Promise<void> {
  const gen = ++attractGen;
  const live = (): boolean => gen === attractGen;
  attract = true;
  stage.setAttract(true);
  const rules = newRules();
  if (!games.length) { pieces.sync(view.pieces(rules.init('menu', ['a', 'b']).pos)); return; }
  for (let g = 0; live(); g = (g + 1) % games.length) {
    const game = games[g];
    $('#showcase').textContent = `${game.name}: ${game.where}`;
    let s = rules.init('menu', ['a', 'b']);
    pieces.sync(view.pieces(s.pos));
    board.setLastMove(null, null); board.setAlert(null);
    for (const code of game.moves) {
      await new Promise((r) => setTimeout(r, 650));
      if (!live()) return;
      const sketch = view.sketch(s.pos, code);
      s = rules.step(s, { [s.p[s.turn]]: encodeMove(code), [s.p[s.turn ^ 1]]: 0 });
      await pieces.play(sketch);
      if (!live()) return;
      pieces.sync(view.pieces(s.pos));
      board.setLastMove(sketch.from, sketch.to);
      board.setAlert(view.alert?.(s.pos) ?? null);
    }
    await new Promise((r) => setTimeout(r, 3500));
  }
}
function stopAttract(): void { attractGen++; attract = false; stage.setAttract(false); $('#showcase').textContent = ''; }

// ------------------------------------------------------------------ quality
const qualitySel = $<HTMLSelectElement>('#quality');
for (const q of ['auto', ...QUALITIES.slice().reverse()]) qualitySel.add(new Option(q, q));
qualitySel.value = stage.auto ? 'auto' : stage.quality;
qualitySel.onchange = () => stage.choose(qualitySel.value as Quality | 'auto');
stage.onQuality((q, fps) => { $('#fps').textContent = `${q} · ${Math.round(fps)} fps`; });

// ------------------------------------------------------------------ start
const params = new URLSearchParams(location.search);
await arena.load(config.arena, config.board.files, config.board.ranks);
await pieces.load();
stage.start();
if (params.get('match')) {
  RelayMatch.placed(events).then(begin).catch((e) => { status((e as Error).message); void startAttract(); });
} else if (params.get('relay')) {
  begin(RelayMatch.dev(events, params.get('relay')!, params.get('room') ?? 'lobby', params.get('name') ?? `player-${Math.floor(Math.random() * 1e4)}`));
} else {
  void startAttract();
}
// for the console: the finished log, as a relay or a LitNode ruleset would replay it
(window as unknown as { boardLog: () => unknown }).boardLog = () => ({ seed: match?.seed, entries: match?.log });
