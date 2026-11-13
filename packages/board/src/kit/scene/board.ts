/**
 * The board: a grid of `files` x `ranks` squares from board.config.ts (one unit per square, centred, side 0's home rank
 * nearest the default camera), a frame, and the highlights (selection, legal targets, the last move, the alert square
 * and hover). Generalised from Rapture Chess's BoardView, which dressed a Blender-built 8x8 board.
 */
import * as THREE from 'three';
import type { BoardConfig } from '../config';
import { softParticleTexture } from './assets';

type Marker = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial };

export class BoardMesh {
  readonly group = new THREE.Group();
  readonly pickPlane: THREE.Mesh;
  readonly files: number;
  readonly ranks: number;
  private readonly targets: Marker[] = [];
  private readonly disc = new THREE.CircleGeometry(0.17, 32);
  private readonly ring = new THREE.RingGeometry(0.36, 0.44, 48);
  private readonly selected: Marker;
  private readonly hover: Marker;
  private readonly last: [Marker, Marker];
  private readonly alert: Marker;
  private t = 0;

  constructor(cfg: BoardConfig['board']) {
    this.files = cfg.files;
    this.ranks = cfg.ranks;
    const n = cfg.files * cfg.ranks;
    const tile = new THREE.BoxGeometry(1, 0.12, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05, envMapIntensity: 0.5 });
    const squares = new THREE.InstancedMesh(tile, mat, n);
    const light = new THREE.Color(cfg.light), dark = new THREE.Color(cfg.dark), m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      m.setPosition(this.squareToWorld(i, -0.06));
      squares.setMatrixAt(i, m);
      squares.setColorAt(i, ((i % cfg.files) + Math.floor(i / cfg.files)) % 2 === 0 ? dark : light);
    }
    squares.receiveShadow = true;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(cfg.files + 0.7, 0.24, cfg.ranks + 0.7), new THREE.MeshStandardMaterial({ color: cfg.frame, roughness: 0.5, metalness: 0.3 }));
    frame.position.y = -0.135;
    frame.receiveShadow = frame.castShadow = true;
    this.group.add(frame, squares);

    this.pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(cfg.files, cfg.ranks), new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.rotation.x = -Math.PI / 2;
    this.pickPlane.position.y = 0.001;
    this.group.add(this.pickPlane);

    const square = new THREE.PlaneGeometry(0.96, 0.96);
    const mk = (geo: THREE.BufferGeometry, color: number, opacity = 0.8): Marker => {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.012;
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      return { mesh, mat };
    };
    for (let i = 0; i < Math.min(64, n); i++) this.targets.push(mk(this.disc, 0xffd27a, 0.75));
    this.selected = mk(square, 0xffc455, 0.35);
    this.hover = mk(square, 0xffc455, 0.1);
    this.hover.mat.blending = THREE.NormalBlending;
    this.last = [mk(square, 0x6ea0ff, 0.16), mk(square, 0x6ea0ff, 0.22)];
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), new THREE.MeshBasicMaterial({ map: softParticleTexture(), color: 0xff3030, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.015; glow.visible = false; glow.renderOrder = 2;
    this.group.add(glow);
    this.alert = { mesh: glow, mat: glow.material as THREE.MeshBasicMaterial };
  }

  /** The world position of a square's centre (square = file + rank * files). */
  squareToWorld(square: number, y = 0): THREE.Vector3 {
    const f = square % this.files, r = Math.floor(square / this.files);
    return new THREE.Vector3(f - (this.files - 1) / 2, y, (this.ranks - 1) / 2 - r);
  }
  worldToSquare(p: THREE.Vector3): number | null {
    const f = Math.round(p.x + (this.files - 1) / 2), r = Math.round((this.ranks - 1) / 2 - p.z);
    return f >= 0 && f < this.files && r >= 0 && r < this.ranks ? f + r * this.files : null;
  }

  /** Legal destinations for the selected piece; `captures` are drawn as rings instead of discs. */
  showTargets(squares: number[], captures: Set<number>): void {
    this.targets.forEach((m, i) => {
      const sq = squares[i];
      m.mesh.visible = sq !== undefined;
      if (sq === undefined) return;
      m.mesh.position.copy(this.squareToWorld(sq, 0.012));
      m.mesh.geometry = captures.has(sq) ? this.ring : this.disc;
      m.mat.color.set(captures.has(sq) ? 0xff6a4a : 0xffd27a);
    });
  }
  clearTargets(): void { for (const m of this.targets) m.mesh.visible = false; }
  setSelected(sq: number | null): void { this.place(this.selected, sq); }
  setHover(sq: number | null): void { this.place(this.hover, sq); }
  setLastMove(from: number | null, to: number | null): void { this.place(this.last[0], from); this.place(this.last[1], to); }
  setAlert(sq: number | null): void { this.place(this.alert, sq); }
  private place(m: Marker, sq: number | null): void {
    m.mesh.visible = sq !== null;
    if (sq !== null) { const y = m.mesh.position.y; m.mesh.position.copy(this.squareToWorld(sq, y)); }
  }

  update(dt: number): void {
    this.t += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    for (const m of this.targets) if (m.mesh.visible) m.mat.opacity = 0.55 + 0.3 * pulse;
    this.selected.mat.opacity = 0.28 + 0.14 * pulse;
    this.alert.mat.opacity = 0.45 + 0.45 * pulse;
    this.alert.mesh.scale.setScalar(1 + 0.08 * pulse);
  }
}
