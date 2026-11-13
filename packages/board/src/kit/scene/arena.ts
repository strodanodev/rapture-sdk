/**
 * The arena loader, generalised from Rapture Chess's realms: one lighting, sky, fog, rays, atmosphere and grade preset
 * from board.config.ts, applied to the stage, and either your own arena model (a GLB under public/, built in Blender
 * or anywhere else) or a neutral procedural dais. The sample ships no arena art: the dais is built here.
 */
import * as THREE from 'three';
import type { ArenaConfig } from '../config';
import { loadModel } from './assets';
import type { Stage } from './stage';

const hex = (c: string): number => new THREE.Color(c).getHex();

export class Arena {
  readonly group = new THREE.Group();

  constructor(private readonly stage: Stage) {
    this.group.name = 'Arena';
    stage.scene.add(this.group);
  }

  /** Apply the preset, then build or load the arena round a board of `files` x `ranks` squares. */
  async load(cfg: ArenaConfig, files: number, ranks: number): Promise<void> {
    const s = this.stage;
    s.setSky({ top: cfg.sky.top, bottom: cfg.sky.bottom, glow: cfg.sky.glow, fog: cfg.sky.fog, fogDensity: cfg.sky.fogDensity }, 0, cfg.stars, {});
    s.setGrade(cfg.grade);
    s.setPool(cfg.pool, cfg.key.position);
    s.keyLight.color.set(cfg.key.color);
    s.keyLight.intensity = cfg.key.intensity;
    s.keyLight.position.set(...cfg.key.position);
    s.rimLight.color.set(cfg.rim.color);
    s.rimLight.intensity = cfg.rim.intensity;
    s.hemi.color.set(cfg.hemi.sky);
    s.hemi.groundColor.set(cfg.hemi.ground);
    s.hemi.intensity = cfg.hemi.intensity;
    s.setFloorRadius(cfg.floorRadius);
    s.setRays({ ...cfg.rays, color: cfg.rays.color });
    s.atmosphere.apply({
      shafts: { ...cfg.atmosphere.shafts, color: hex(cfg.atmosphere.shafts.color) },
      mist: { ...cfg.atmosphere.mist, color: hex(cfg.atmosphere.mist.color) },
      motes: { ...cfg.atmosphere.motes, color: hex(cfg.atmosphere.motes.color) },
    }, new THREE.Vector3(...cfg.key.position));
    this.group.clear();
    if (cfg.model) {
      const gltf = await loadModel(cfg.model).catch((e) => { console.warn('[board] arena failed, using the neutral dais', e); return null; });
      if (gltf) {
        gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.receiveShadow = true; o.castShadow = false; } });
        this.group.add(gltf.scene);
        return;
      }
    }
    this.neutral(files, ranks);
  }

  /** A stone dais under the board, a low ring round it and eight short posts with soft lamps: no textures, a few draw calls. */
  private neutral(files: number, ranks: number): void {
    const span = Math.max(files, ranks);
    const stone = new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.88, metalness: 0.06, envMapIntensity: 0.3 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.4, metalness: 0.8, envMapIntensity: 0.8 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffd9a0, emissiveIntensity: 2.2 });
    const r = span * 0.78 + 2.4;
    const dais = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.4, 0.5, 72), stone);
    dais.position.y = -0.42;
    dais.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.15, 0.06, 8, 96), trim);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.16;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(r * 3.2, 64), new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.95, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.68;
    floor.receiveShadow = true;
    this.group.add(dais, ring, floor);
    const post = new THREE.CylinderGeometry(0.22, 0.28, 1.6, 12), cap = new THREE.SphereGeometry(0.16, 16, 12);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8, pr = r + 1.6;
      const p = new THREE.Mesh(post, stone);
      p.position.set(Math.cos(a) * pr, 0.12, Math.sin(a) * pr);
      p.castShadow = true;
      const c = new THREE.Mesh(cap, glow);
      c.position.set(p.position.x, 1.02, p.position.z);
      this.group.add(p, c);
    }
  }
}
