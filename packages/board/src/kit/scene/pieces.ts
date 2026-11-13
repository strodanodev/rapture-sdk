/**
 * The piece loader and the pieces on the board, generalised from Rapture Chess's armies: each piece is a model from
 * board.config.ts (pieces.models, a GLB per kind) or, for any kind without one, the procedural mesh src/game/pieces.ts
 * makes. Moves glide (leaps arc high), captures sink and fade, promotions swap the mesh, and castling-style moves carry
 * their companions (MoveSketch.also). Pieces seated from the player's wallet carry a small token badge.
 */
import * as THREE from 'three';
import type { BoardPiece, MoveSketch, Side } from '../game';
import type { BoardConfig } from '../config';
import { loadModel, preloadModels } from './assets';
import type { BoardMesh } from './board';
import { ease, tweens } from './tween';

/** Makes a piece's mesh: the procedural fallback for every kind without a model. Stand it on y = 0, facing +z. */
export type PieceFactory = (kind: string, side: Side, color: THREE.Color) => THREE.Object3D;

export class PieceView {
  readonly group = new THREE.Group();
  private body: THREE.Object3D | null = null;
  private badge: THREE.Sprite | null = null;

  constructor(public kind: string, readonly side: Side, public square: number, private readonly set: PieceSet) {
    this.group.userData.piece = this; // picking climbs from the mesh it hits to here
    this.group.position.copy(set.board.squareToWorld(square));
    this.group.rotation.y = side === 1 ? Math.PI : 0;
    this.setBody(kind);
  }

  setBody(kind: string): void {
    if (this.body) this.group.remove(this.body);
    this.kind = kind;
    this.body = this.set.make(kind, this.side);
    this.body.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(this.body);
  }

  /** A token badge over the piece (wallet seating), or null to remove it. */
  setBadge(text: string | null, owned: boolean): void {
    if (this.badge) { this.group.remove(this.badge); this.badge.material.map?.dispose(); this.badge.material.dispose(); this.badge = null; }
    if (!text) return;
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = owned ? 'rgba(201,164,92,0.92)' : 'rgba(20,22,28,0.8)';
    g.beginPath(); g.roundRect(4, 8, 248, 48, 24); g.fill();
    g.fillStyle = owned ? '#16130c' : '#e8e4da';
    g.font = '600 28px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text.slice(0, 16), 128, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
    this.badge.scale.set(0.9, 0.225, 1);
    this.badge.position.y = 1.55;
    this.group.add(this.badge);
  }

  /** Glide to a square along an arc (a leap arcs higher). */
  async moveTo(square: number, leap = false): Promise<void> {
    const from = this.group.position.clone(), to = this.set.board.squareToWorld(square);
    this.square = square;
    const h = leap ? 1.1 : 0.35, d = from.distanceTo(to);
    await tweens.run(0.42 + Math.min(0.3, d * 0.04), (k) => {
      this.group.position.lerpVectors(from, to, k);
      this.group.position.y = Math.sin(k * Math.PI) * h;
    }, ease.inOutCubic);
    this.group.position.copy(to);
  }

  /** Taken: sink and fade, then gone. */
  async fall(): Promise<void> {
    const mats: THREE.Material[] = [];
    this.body?.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of ([] as THREE.Material[]).concat(m)) { const c = x.clone(); c.transparent = true; c.depthWrite = false; mats.push(c); (o as THREE.Mesh).material = c; } });
    await tweens.run(0.6, (k) => {
      for (const m of mats) (m as THREE.MeshStandardMaterial).opacity = 1 - k;
      this.group.position.y = -0.3 * k;
      this.group.scale.setScalar(1 - 0.2 * k);
    }, ease.inOutCubic);
    for (const m of mats) m.dispose();
    this.dispose();
  }

  /** Promotion: shrink, swap the mesh, grow back. */
  async become(kind: string): Promise<void> {
    await tweens.run(0.35, (k) => { this.group.scale.setScalar(1 - 0.5 * k); }, ease.inOutCubic);
    this.setBody(kind);
    await tweens.run(0.45, (k) => { this.group.scale.setScalar(0.5 + 0.5 * k); }, ease.outBack);
    this.group.scale.setScalar(1);
  }

  dispose(): void { this.group.removeFromParent(); this.setBadge(null, false); }
}

export class PieceSet {
  readonly group = new THREE.Group();
  private readonly pieces = new Map<number, PieceView>();
  private readonly colors: [THREE.Color, THREE.Color];
  private readonly models = new Map<string, THREE.Object3D>();

  constructor(readonly board: BoardMesh, private readonly factory: PieceFactory, private readonly cfg: BoardConfig) {
    this.colors = [new THREE.Color(cfg.sides[0].color), new THREE.Color(cfg.sides[1].color)];
  }

  /** Load the GLB models board.config.ts names (pieces.models); kinds without one stay procedural. */
  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    const entries = Object.entries(this.cfg.pieces.models);
    await preloadModels(entries.map(([, p]) => p), onProgress);
    for (const [kind, path] of entries) {
      const gltf = await loadModel(path).catch(() => null);
      if (gltf) this.models.set(kind, gltf.scene);
    }
  }

  /** A mesh for a piece: a tinted clone of its model, or the procedural one. */
  make(kind: string, side: Side): THREE.Object3D {
    const model = this.models.get(kind);
    if (!model) return this.factory(kind, side, this.colors[side]);
    const root = model.clone(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = (mesh.material as THREE.MeshStandardMaterial).clone();
      if (m.color && !m.map) m.color.lerp(this.colors[side], 0.85);
      mesh.material = m;
    });
    return root;
  }

  /** Put exactly these pieces on the board, no animation (a new match, a replay, a resync after a move). */
  sync(pieces: BoardPiece[]): void {
    const want = new Map(pieces.map((p) => [p.square, p]));
    for (const [sq, v] of this.pieces) {
      const w = want.get(sq);
      if (!w || w.side !== v.side) { v.dispose(); this.pieces.delete(sq); }
      else if (w.kind !== v.kind) v.setBody(w.kind);
    }
    for (const p of pieces) {
      if (this.pieces.has(p.square)) continue;
      const v = new PieceView(p.kind, p.side, p.square, this);
      this.pieces.set(p.square, v);
      this.group.add(v.group);
    }
    for (const v of this.pieces.values()) { v.group.position.copy(this.board.squareToWorld(v.square)); v.group.scale.setScalar(1); }
  }

  /** Play a move out on the board; resolves when the animation is over. Follow it with sync() to be exact. */
  async play(s: MoveSketch): Promise<void> {
    const piece = this.pieces.get(s.from);
    if (!piece) return;
    this.pieces.delete(s.from);
    const victim = s.captured !== undefined ? this.pieces.get(s.captured) : undefined;
    if (victim && s.captured !== undefined) this.pieces.delete(s.captured);
    const companions = (s.also ?? []).map((a) => ({ a, v: this.pieces.get(a.from) })).filter((x) => x.v);
    for (const { a } of companions) this.pieces.delete(a.from);
    this.pieces.set(s.to, piece);
    for (const { a, v } of companions) this.pieces.set(a.to, v!);
    const jobs = [piece.moveTo(s.to, !!s.leap), ...companions.map(({ a, v }) => v!.moveTo(a.to))];
    if (victim) jobs.push(new Promise((r) => setTimeout(r, 250)).then(() => victim.fall()));
    await Promise.all(jobs);
    if (s.becomes) await piece.become(s.becomes);
  }

  at(square: number): PieceView | undefined { return this.pieces.get(square); }
  all(): PieceView[] { return [...this.pieces.values()]; }
  /** The pieces' groups, to raycast recursively against their real meshes (see pieceOf). */
  pickables(): THREE.Object3D[] { return this.all().map((p) => p.group); }
  clear(): void { for (const p of this.pieces.values()) p.dispose(); this.pieces.clear(); }
}

/** The piece a raycast hit belongs to, or undefined (the board). */
export function pieceOf(o: THREE.Object3D | null): PieceView | undefined {
  for (let x = o; x; x = x.parent) if (x.userData.piece) return x.userData.piece as PieceView;
  return undefined;
}
