/**
 * YOUR PIECES. The sample's chess set is procedural: turned (lathe) bodies with a few added parts, no textures and no
 * downloads. Replace `makePiece` with your own meshes, or give board.config.ts `pieces.models` GLBs per kind (the kit
 * loads those instead and falls back to this for any kind left out). One unit is one square; stand pieces on y = 0,
 * facing +z (the kit turns side 1's pieces round).
 */
import * as THREE from 'three';
import type { Side } from '../kit/game';

type Profile = Array<[number, number]>;
const lathe = (profile: Profile, segments = 40): THREE.LatheGeometry => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);

/** A shared base (foot, collar) every piece stands on. */
const BASE: Profile = [[0, 0], [0.34, 0], [0.36, 0.04], [0.34, 0.08], [0.28, 0.1], [0.3, 0.13], [0.24, 0.16]];

const BODIES: Record<string, Profile> = {
  p: [...BASE, [0.15, 0.24], [0.11, 0.38], [0.17, 0.42], [0.1, 0.45], [0.14, 0.5], [0.16, 0.58], [0.13, 0.66], [0.06, 0.7], [0, 0.71]],
  r: [...BASE, [0.22, 0.24], [0.2, 0.52], [0.25, 0.56], [0.27, 0.6], [0.27, 0.76], [0, 0.76]],
  n: [...BASE, [0.2, 0.22], [0.17, 0.36], [0.22, 0.4], [0, 0.4]],
  b: [...BASE, [0.16, 0.26], [0.12, 0.52], [0.19, 0.56], [0.11, 0.59], [0.16, 0.66], [0.18, 0.76], [0.14, 0.86], [0.07, 0.92], [0.04, 0.95], [0, 0.96]],
  q: [...BASE, [0.2, 0.26], [0.14, 0.62], [0.23, 0.66], [0.15, 0.7], [0.2, 0.82], [0.25, 0.92], [0.18, 0.95], [0, 0.95]],
  k: [...BASE, [0.21, 0.26], [0.15, 0.66], [0.24, 0.7], [0.16, 0.74], [0.21, 0.88], [0.24, 0.98], [0.17, 1.01], [0, 1.01]],
};

const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(color: THREE.Color): THREE.MeshStandardMaterial {
  const key = color.getHexString();
  let m = materials.get(key);
  if (!m) {
    const dark = color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.4;
    m = new THREE.MeshStandardMaterial({ color, roughness: dark ? 0.32 : 0.4, metalness: 0.05, envMapIntensity: dark ? 1.1 : 0.7 });
    materials.set(key, m);
  }
  return m;
}

const geometries = new Map<string, THREE.BufferGeometry>();
const bodyOf = (kind: string): THREE.BufferGeometry => {
  let g = geometries.get(kind);
  if (!g) { g = lathe(BODIES[kind] ?? BODIES.p); geometries.set(kind, g); }
  return g;
};

export function makePiece(kind: string, _side: Side, color: THREE.Color): THREE.Object3D {
  const mat = material(color);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(bodyOf(kind), mat));
  if (kind === 'r') {
    // battlements: four merlons on the rim
    const merlon = new THREE.BoxGeometry(0.11, 0.1, 0.11);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const m = new THREE.Mesh(merlon, mat);
      m.position.set(Math.cos(a) * 0.2, 0.81, Math.sin(a) * 0.2);
      m.rotation.y = -a;
      root.add(m);
    }
  } else if (kind === 'n') {
    // a horse's head: a tilted neck and a muzzle, facing +z
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, 0.46, 20), mat);
    neck.position.set(0, 0.58, -0.02);
    neck.rotation.x = -0.32;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.17, 0.36), mat);
    head.position.set(0, 0.8, 0.1);
    head.rotation.x = 0.5;
    const mane = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.12), mat);
    mane.position.set(0, 0.66, -0.14);
    mane.rotation.x = -0.3;
    const ear = new THREE.ConeGeometry(0.04, 0.1, 8);
    for (const x of [-0.06, 0.06]) { const e = new THREE.Mesh(ear, mat); e.position.set(x, 0.92, -0.02); root.add(e); }
    root.add(neck, head, mane);
  } else if (kind === 'b') {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), mat);
    ball.position.y = 0.99;
    root.add(ball);
  } else if (kind === 'q') {
    // a coronet of beads and a ball on top
    const bead = new THREE.SphereGeometry(0.04, 12, 8);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const b = new THREE.Mesh(bead, mat);
      b.position.set(Math.cos(a) * 0.2, 0.96, Math.sin(a) * 0.2);
      root.add(b);
    }
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), mat);
    top.position.y = 1.0;
    root.add(top);
  } else if (kind === 'k') {
    // a cross
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.06), mat);
    v.position.y = 1.12;
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.06), mat);
    h.position.y = 1.15;
    root.add(v, h);
  }
  return root;
}
