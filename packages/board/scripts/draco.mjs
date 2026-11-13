/**
 * Copy three.js's Draco decoders to public/draco (gitignored), where the model loader looks for them, so Draco-compressed
 * arena and piece GLBs load from your own site (the CSP allows 'self' only). Runs before `dev` and `build`.
 */
import { cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const three = join(root, 'node_modules', 'three');
const from = join(three, 'examples', 'jsm', 'libs', 'draco', 'gltf');
const to = join(root, 'public', 'draco');
if (!existsSync(join(to, 'draco_decoder.wasm'))) cpSync(from, to, { recursive: true });
