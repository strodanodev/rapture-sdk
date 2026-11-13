/**
 * The battle board: the modelled table the HTML units stand on. The page reports where its board is (BoardLayout: the
 * four projected corners of the board's mat on screen, and the mat's own layout in CSS px: its outline, every unit
 * slot, the rune band, the centre line). The realm solves the homography from that layout to the table-top plane as
 * the battle camera sees it, and this file builds the board *through* that mapping: each recess is cut where its
 * HTML slot projects, so the 3D board and the HTML units line up at any viewport, whatever the CSS perspective is.
 *
 * What is built (sizes in "design metres": the board is about 15 x 6.5 of them, whatever its size on screen):
 *   - a stone top with a chamfered edge, a chamfered recess for every slot and, where the page draws its rune band, a
 *     channel under the glyphs;
 *   - a dark under-plate: the floor of the recesses and the channel;
 *   - a forged iron rim round it, bevelled, with studs (Valhalla) or spikes (the Underworld), and a glowing seam
 *     between rim and stone;
 *   - metal inlaid flush in the stone: a hairline inside the rim, two rings round the centre (broken where they
 *     would cross a recess), and the realm's sigil on the centre line with a tapered bar either side;
 *   - a pedestal under it all.
 */
import * as THREE from 'three';

export interface BoardRect { x: number; y: number; w: number; h: number }
export interface BoardLayout {
  /** The mat's corners on screen (CSS px): top-left, top-right, bottom-right, bottom-left. */
  quad: [number, number][];
  /** The mat's size and corner radius (CSS px, before its 3D tilt). */
  w: number; h: number; radius: number;
  /** Every unit slot, in the mat's coordinates. */
  slots: BoardRect[];
  /** The rune band: its centreline's inset from the mat's edge and its width; null where the page draws none. */
  band: { inset: number; width: number } | null;
  /** The centre line between the two rows. */
  line: { y: number; x0: number; x1: number } | null;
}

export interface BoardStyle {
  stone: THREE.Material; under: THREE.Material; iron: THREE.Material; trim: THREE.Material; glow: THREE.Material; base: THREE.Material;
  /** Rim studs: domes or spikes. Sigil: a four-point star or an eight-point sun. */
  spikes: boolean;
}

type P = [number, number];

/** The homography (9 numbers, row-major) taking each src point to its dst point; null if the points are degenerate. */
export function solveHomography(src: P[], dst: P[]): number[] | null {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    a.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X], [0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-10) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [...a.map((row, i) => row[8] / row[i]), 1];
}

export function applyHomography(h: number[], x: number, y: number): P {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** A layout for when the page has sent none yet (the title's altar): a wide table, two rows of five. */
export function defaultLayout(): BoardLayout {
  const w = 1040, h = 440, u = 118, sh = u * 1.12, gap = 16;
  const row = (y: number): BoardRect[] => Array.from({ length: 5 }, (_, i) => ({ x: w / 2 + (i - 2.5) * (u + gap) + gap / 2, y, w: u, h: sh }));
  return { quad: [], w, h, radius: h / 2, slots: [...row(h / 2 - 26 - sh), ...row(h / 2 + 26)], band: { inset: 25, width: 38 }, line: { y: h / 2, x0: w * 0.15, x1: w * 0.85 } };
}

// ------------------------------------------------------------------ outlines (CSS px, y down)
/** A rounded rectangle as a closed polyline. */
function roundRect(x: number, y: number, w: number, h: number, r: number, seg = 24): THREE.Vector2[] {
  r = Math.max(0.01, Math.min(r, w / 2, h / 2));
  const pts: THREE.Vector2[] = [];
  const corner = (cx: number, cy: number, a0: number): void => { for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r)); } };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return dedupe(pts);
}

/** A unit slot's outline, as the page draws it (border-radius 48% 48% 14% 14% / 40% 40% 12% 12%), grown by `grow`. */
function arch(s: BoardRect, grow: number, seg = 10): THREE.Vector2[] {
  const x = s.x - grow, y = s.y - grow, w = s.w + grow * 2, h = s.h + grow * 2;
  const pts: THREE.Vector2[] = [];
  const corner = (cx: number, cy: number, rx: number, ry: number, a0: number): void => { for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; pts.push(new THREE.Vector2(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry)); } };
  const tx = w * 0.48, ty = h * 0.4, bx = w * 0.14, by = h * 0.12;
  corner(x + w - tx, y + ty, tx, ty, -Math.PI / 2); corner(x + w - bx, y + h - by, bx, by, 0); corner(x + bx, y + h - by, bx, by, Math.PI / 2); corner(x + tx, y + ty, tx, ty, Math.PI);
  return dedupe(pts);
}

function dedupe(pts: THREE.Vector2[]): THREE.Vector2[] {
  const out = pts.filter((p, i) => i === 0 || p.distanceToSquared(pts[i - 1]) > 1e-6);
  if (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) < 1e-6) out.pop();
  return out;
}

function inside(poly: THREE.Vector2[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const shapeOf = (outline: THREE.Vector2[], holes: THREE.Vector2[][] = []): THREE.Shape => {
  const s = new THREE.Shape(outline);
  for (const hole of holes) s.holes.push(new THREE.Path(hole));
  return s;
};

// ------------------------------------------------------------------ the board
export function buildBoard(l: BoardLayout, H: number[], top: number, style: BoardStyle): THREE.Group {
  const g = new THREE.Group();
  const { w, h } = l, R = Math.min(l.radius, w / 2, h / 2);
  const at = (x: number, y: number): P => applyHomography(H, x, y);
  // metres per CSS px along the board's middle, and CSS px per design metre
  const [lx, lz] = at(0, h / 2), [rx, rz] = at(w, h / 2);
  const s = Math.hypot(rx - lx, rz - lz) / w;
  const K = Math.min(w / 15, h / 6.5), u = K * s;   // u: world metres per design metre

  /** Map a geometry built in px (x, y on the mat; z = depth below its front face, px) into the world. */
  const place = (geo: THREE.BufferGeometry, yTop: number, z0 = 0): THREE.BufferGeometry => {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute, uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const [X, Z] = at(pos.getX(i), pos.getY(i)), Y = top + yTop - (pos.getZ(i) - z0) * s;
      pos.setXYZ(i, X, Y, Z);
      uv?.setXY(i, X * 0.42, (Z + Y) * 0.42);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    return geo;
  };
  /** Extrude shapes downward from yTop (world m above the table top) by `depth` (world m), chamfered by `bevel`. */
  const block = (shapes: THREE.Shape[], yTop: number, depth: number, bevel: number, mat: THREE.Material, shadow = true): THREE.Mesh => {
    const b = bevel / s;
    const geo = new THREE.ExtrudeGeometry(shapes, { depth: Math.max(0.001, depth / s - 2 * b), bevelEnabled: bevel > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 2, curveSegments: 1 });
    const m = new THREE.Mesh(place(geo, yTop, bevel > 0 ? -b : 0), mat);
    m.castShadow = shadow; m.receiveShadow = true;
    return m;
  };
  /** Flat shapes at a height, facing up; `shade(x, y)` darkens them per vertex (a recess is darkest under its near wall). */
  const sheet = (shapes: THREE.Shape[], yTop: number, mat: THREE.Material, shade?: (x: number, y: number) => number): THREE.Mesh => {
    const geo = new THREE.ShapeGeometry(shapes, 1);
    const xy = geo.getAttribute('position'), col = new Float32Array(xy.count * 3);
    for (let i = 0; i < xy.count; i++) col.fill(shade ? shade(xy.getX(i), xy.getY(i)) : 1, i * 3, i * 3 + 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const idx = geo.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) { const b = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, b); }   // the mapping turns the sheet over
    const m = new THREE.Mesh(place(geo, yTop), mat);
    m.receiveShadow = true;
    return m;
  };
  const inset = (d: number): THREE.Vector2[] => roundRect(d, d, w - 2 * d, h - 2 * d, R - d);

  // the stone top, cut by every slot. Where the page draws its rune band, the stone stops inside it and the band
  // runs in a channel between stone and rim; elsewhere the stone runs out to the seam by the rim
  const seam = 0.07 * K, lip = 0.05 * K, deep = 0.17 * u;
  const cuts = l.slots.map((r) => arch(r, lip));
  const edge = l.band ? Math.max(seam + 0.2 * K, l.band.inset + l.band.width / 2) : seam;
  g.add(block([shapeOf(inset(edge), cuts)], 0, 0.3 * u, 0.02 * u, style.stone));
  // the floor of each recess, darkest under its near wall, and the channel's floor
  const shadow = (x: number, y: number): number => {
    const r = l.slots.find((q) => x > q.x - lip - 2 && x < q.x + q.w + lip + 2 && y > q.y - lip - 2 && y < q.y + q.h + lip + 2);
    return r ? 1 - 0.7 * Math.max(0, Math.min(1, (y - r.y) / r.h)) ** 1.4 : 1;
  };
  if (l.slots.length) g.add(sheet(l.slots.map((r) => shapeOf(arch(r, lip + 1))), -deep, style.under, shadow));
  if (edge > seam) g.add(sheet([shapeOf(inset(seam * 0.5), [inset(edge + 1)])], -0.06 * u, style.under, () => 0.7));
  // the seam between rim and stone, lit from within
  g.add(sheet([shapeOf(inset(-0.5), [inset(seam + 0.5)])], -0.03 * u, style.glow));

  // the forged rim, and its studs
  const rimW = 0.3 * K;
  g.add(block([shapeOf(inset(-rimW), [inset(0)])], 0.06 * u, 0.5 * u, 0.045 * u, style.iron));
  const path = inset(-rimW / 2);
  let length = 0;
  for (let i = 0; i < path.length; i++) length += path[i].distanceTo(path[(i + 1) % path.length]);
  const n = Math.max(12, Math.round(length / (1.05 * K))), step = length / n;
  const stud = style.spikes ? new THREE.ConeGeometry(0.075 * u, 0.2 * u, 6) : new THREE.SphereGeometry(0.07 * u, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const studs = new THREE.InstancedMesh(stud, style.trim, n);
  const m4 = new THREE.Matrix4();
  let walked = step / 2, k = 0;
  for (let i = 0; i < path.length && k < n; i++) {
    const a = path[i], b = path[(i + 1) % path.length], d = a.distanceTo(b);
    while (walked <= d && k < n) {
      const [X, Z] = at(a.x + ((b.x - a.x) * walked) / d, a.y + ((b.y - a.y) * walked) / d);
      studs.setMatrixAt(k++, m4.makeTranslation(X, top + (style.spikes ? 0.15 : 0.055) * u, Z));
      walked += step;
    }
    walked -= d;
  }
  studs.count = k;
  studs.castShadow = true;
  g.add(studs);

  // metal inlaid in the stone
  const inlay: THREE.Shape[] = [];
  const hair = edge + 0.12 * K;
  inlay.push(shapeOf(inset(hair), [inset(hair + 0.05 * K)]));
  // two rings round the centre, broken where they would run through a recess
  const cx = w / 2, cy = l.line?.y ?? h / 2;
  const keep = l.slots.map((r) => arch(r, lip + 0.09 * K));
  const clear = (x: number, y: number): boolean => x > hair + 0.2 * K && x < w - hair - 0.2 * K && y > hair + 0.2 * K && y < h - hair - 0.2 * K && !keep.some((poly) => inside(poly, x, y));
  const ring = (r: number, width: number): void => {
    const N = 240;
    let run: number[] = [];
    const flush = (): void => {
      if (run.length > 14) {
        const outer = run.map((a) => new THREE.Vector2(cx + Math.cos(a) * (r + width / 2), cy + Math.sin(a) * (r + width / 2)));
        const inner = run.map((a) => new THREE.Vector2(cx + Math.cos(a) * (r - width / 2), cy + Math.sin(a) * (r - width / 2))).reverse();
        inlay.push(new THREE.Shape([...outer, ...inner]));
      }
      run = [];
    };
    // start in a gap, if there is one, so no run wraps past the end
    let start = 0;
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; if (!clear(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) { start = i; break; } }
    for (let i = 0; i <= N; i++) {
      const a = ((start + i) / N) * Math.PI * 2;
      if (clear(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) run.push(a); else flush();
    }
    flush();
  };
  const ringR = Math.min(w * 0.17, h * 0.43, 2.6 * K);
  ring(ringR * 1.9, 0.05 * K); ring(ringR * 1.9 - 0.16 * K, 0.02 * K);
  // the sigil on the centre line, in the gap between the rows, with a tapered bar either side
  const up = l.slots.filter((r) => r.y + r.h / 2 < cy), down = l.slots.filter((r) => r.y + r.h / 2 >= cy);
  const gap = up.length && down.length ? Math.min(...down.map((r) => r.y)) - Math.max(...up.map((r) => r.y + r.h)) - 2 * lip : 0.6 * K;
  const ry = Math.max(0.08 * K, Math.min(0.5 * K, gap * 0.48));
  if (style.spikes) {
    const sx = ry * 2.6;
    inlay.push(new THREE.Shape(Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2, k2 = i % 2 ? 0.42 : 1; return new THREE.Vector2(cx + Math.cos(a) * sx * k2, cy + Math.sin(a) * ry * k2); })));
  } else {
    const sx = ry * 3.2, waist = 0.26;
    inlay.push(new THREE.Shape([[sx, 0], [ry * waist, ry * waist], [0, ry], [-ry * waist, ry * waist], [-sx, 0], [-ry * waist, -ry * waist], [0, -ry], [ry * waist, -ry * waist]].map(([x, y]) => new THREE.Vector2(cx + x, cy + y))));
  }
  const x0 = l.line?.x0 ?? w * 0.15, x1 = l.line?.x1 ?? w * 0.85, t = Math.min(ry * 0.3, 0.05 * K), from = ry * 4.2;
  if (cx - from > x0 + K) for (const dir of [-1, 1]) {
    const end = dir < 0 ? x0 : x1;
    inlay.push(new THREE.Shape([new THREE.Vector2(cx + dir * from, cy - t), new THREE.Vector2(end, cy), new THREE.Vector2(cx + dir * from, cy + t)]));
    // a lozenge a third and two thirds of the way along each bar
    for (const f of [0.34, 0.68]) {
      const x = cx + dir * from + (end - cx - dir * from) * f, d = ry * (0.62 - f * 0.4);
      inlay.push(new THREE.Shape([new THREE.Vector2(x - d * 1.7, cy), new THREE.Vector2(x, cy - d), new THREE.Vector2(x + d * 1.7, cy), new THREE.Vector2(x, cy + d)]));
    }
  }
  g.add(block(inlay, 0.012 * u, 0.03 * u, 0, style.trim, false));

  // the pedestal
  const foot = inset(0).map((p) => new THREE.Vector2(w / 2 + (p.x - w / 2) * 0.76, h / 2 + (p.y - h / 2) * 0.62));
  g.add(block([shapeOf(foot)], -0.4 * u, top - 0.4 * u + 0.25, 0, style.base));
  return g;
}

export function disposeBoard(g: THREE.Group): void {
  g.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); });
}
