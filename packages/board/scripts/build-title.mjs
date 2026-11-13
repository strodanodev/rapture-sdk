/**
 * Build the LitNode title artifact for your board game.
 *
 *   node scripts/build-title.mjs [--out rulesets] [--litnode <LitNode checkout>]
 *
 * 1. esbuild inlines src/litnode/title.entry.ts (the match layer, your rules from src/game/rules.ts, board.config.ts
 *    and, for the chess sample, chess.js) into one import-free ES module: titles/<rulesetId>.mjs.
 * 2. LitNode's own tools/bundle-title.mjs takes that file, runs the conformance suite every node runs (the static
 *    checks, then the title in LitNode's sandbox: a child process with no filesystem, network, clock or randomness),
 *    and writes <out>/<rulesetId>.js + .json with the buildHash TitleRegistry and the nodes pin.
 *
 * Step 2 runs the copy in vendor/litnode (LitNode 0.12.1, see vendor/litnode/MANIFEST.json), so it needs no LitNode
 * checkout and no network; --litnode <dir> or LITNODE_DIR runs a checkout's own copy instead (a newer LitNode).
 * Register the exact <out>/<rulesetId>.js a node loads: it is written with LF, and CRLF would change its hash.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one-module title source (step 1), and the config's rulesetId. */
export async function bundleTitle() {
  const r = await build({
    entryPoints: [join(root, 'src/litnode/title.entry.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    mainFields: ['module', 'main'], write: false, minify: false, treeShaking: true, legalComments: 'none', logLevel: 'silent', charset: 'utf8',
    absWorkingDir: root, // path comments relative to the package, wherever the script is run from
  });
  const source = r.outputFiles[0].text.replace(/\/\/# sourceMappingURL=.*$/m, '');
  const cfg = await build({ entryPoints: [join(root, 'board.config.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' });
  const config = (await import(`data:text/javascript;base64,${Buffer.from(cfg.outputFiles[0].text).toString('base64')}`)).default;
  return { source, rulesetId: config.rulesetId };
}

/** Steps 1 and 2. Returns { rulesetId, title, artifact, sidecar, status } (status 0: conformant and written). */
export async function buildTitle({ out = join(root, 'rulesets'), titles = join(root, 'titles'), litnode = process.env.LITNODE_DIR, stdio = 'inherit' } = {}) {
  const { source, rulesetId } = await bundleTitle();
  mkdirSync(titles, { recursive: true });
  const title = join(titles, `${rulesetId}.mjs`);
  writeFileSync(title, source);
  const lit = litnode ? resolve(litnode) : join(root, 'vendor', 'litnode');
  const bundler = join(lit, 'tools', 'bundle-title.mjs');
  if (!existsSync(bundler)) throw new Error(`no LitNode bundler at ${bundler}`);
  const run = spawnSync(process.execPath, [bundler, title, '--out', resolve(out)], { cwd: lit, stdio, encoding: 'utf8' });
  return { rulesetId, title, artifact: join(resolve(out), `${rulesetId}.js`), sidecar: join(resolve(out), `${rulesetId}.json`), status: run.status ?? 1, output: `${run.stdout ?? ''}${run.stderr ?? ''}`, lit };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const r = await buildTitle({ out: opt('out') ?? join(root, 'rulesets'), litnode: opt('litnode') ?? process.env.LITNODE_DIR });
  if (r.status === 0) {
    const { buildHash, bytes } = JSON.parse(readFileSync(r.sidecar, 'utf8'));
    console.log(`\n${r.rulesetId}: conformant (${r.lit === join(root, 'vendor', 'litnode') ? 'vendored LitNode suite' : r.lit}), ${bytes} bytes, buildHash ${buildHash}`);
  }
  process.exit(r.status);
}
