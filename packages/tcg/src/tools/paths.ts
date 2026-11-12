/**
 * Where the TCG kit's package lives, whether running from source (tsx) or from the bundled CLI (dist/). It is
 * `@rapture-sdk/tcg`; releases before the Rapture SDK were named `tessaract`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = new Set(['@rapture-sdk/tcg', 'tessaract']);

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && NAMES.has((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name ?? '')) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('rapture: cannot find the @rapture-sdk/tcg package root');
    dir = up;
  }
}

export const PKG_ROOT = findRoot();
export const pkgPath = (...parts: string[]): string => join(PKG_ROOT, ...parts);
export const PKG_VERSION = (JSON.parse(readFileSync(pkgPath('package.json'), 'utf8')) as { version: string }).version;
