/**
 * The model loader for arenas and pieces (Draco and meshopt GLBs, a cache per path), and a soft sprite for glows.
 * Paths are under public/ (served from the site root). Draco decoders are copied to public/draco by scripts/draco.mjs.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<GLTF>>();

/** Load a GLB under public/ once; a failed load is forgotten so it can be retried. */
export function loadModel(path: string): Promise<GLTF> {
  let p = cache.get(path);
  if (!p) {
    p = loader.loadAsync(`${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`);
    cache.set(path, p);
    p.catch(() => cache.delete(path));
  }
  return p;
}

/** Load a list of models with a progress callback; failures are logged and skipped. */
export async function preloadModels(paths: string[], onProgress: (done: number, total: number) => void = () => {}): Promise<void> {
  const unique = [...new Set(paths)];
  let done = 0;
  onProgress(0, unique.length);
  await Promise.all(unique.map((p) => loadModel(p).catch((e) => console.warn('[board] model failed', p, e)).then(() => onProgress(++done, unique.length))));
}

let soft: THREE.Texture | null = null;
/** A soft radial sprite for glows and pools. */
export function softParticleTexture(): THREE.Texture {
  if (soft) return soft;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  soft = new THREE.CanvasTexture(c);
  soft.colorSpace = THREE.SRGBColorSpace;
  return soft;
}
