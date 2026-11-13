import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = (...argv: string[]) => spawnSync(process.execPath, [tsx, join(ROOT, 'src', 'cli.ts'), ...argv], { encoding: 'utf8', cwd: ROOT });

test('help lists every command; unknown commands fail', () => {
  const help = cli('--help');
  assert.equal(help.status, 0);
  for (const c of ['create', 'new', 'snapshot', 'import', 'sim', 'title', 'web', 'dev', 'relay']) assert.match(help.stdout, new RegExp(`\\b${c}\\b`));
  assert.equal(cli('nope').status, 1);
});

test('create scaffolds a playable project with the skill and a built site', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tessaract-'));
  try {
    const target = join(dir, 'Space Duel');
    const r = cli('create', target, '--title', 'Space Duel', '--sdk', 'file:../tessaract');
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['games/space-duel.game.json', 'web/index.html', 'web/app.js', 'web/arena3d.js', 'web/ui/screens/match.js', 'web/styles/theme.css', 'web/lib/wallet.js', 'web/engine/tessaract.js', 'web/data/game.json', 'web/data/collection.json', 'vercel.json', 'gauntlet.json', '.claude/skills/tcg/SKILL.md', 'README.md']) {
      assert.ok(existsSync(join(target, f)), f);
    }
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies.tessaract, 'file:../tessaract');
    assert.equal(pkg.scripts.sim, 'tessaract sim games/space-duel.game.json --matches 300');
    const game = JSON.parse(readFileSync(join(target, 'games/space-duel.game.json'), 'utf8'));
    assert.equal(game.litnode.rulesetId, 'space-duel.v1');
    assert.equal(cli('create', target).status, 1, 'refuses a non-empty folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create --template board copies the board-game template, renamed, and builds nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rapture-board-'));
  try {
    const target = join(dir, 'Space Chess');
    const r = cli('create', target, '--template', 'board', '--title', "Space Chess: Captain's Cut");
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['board.config.ts', 'src/game/rules.ts', 'src/game/pieces.ts', 'src/kit/match.ts', 'src/vendor/tcg/wallet.js', 'relay/server.mts', 'gauntlets/gauntlet.json', 'vendor/litnode/MANIFEST.json', 'scripts/build-title.mjs', 'test/title.test.ts', 'pnpm-lock.yaml', 'index.html', '.gitignore', 'README.md']) {
      assert.ok(existsSync(join(target, f)), f);
    }
    for (const f of ['node_modules', 'dist', '.check', 'rulesets', 'titles', 'public/draco', '.relay-key.json']) assert.ok(!existsSync(join(target, f)), `${f} is not copied`);
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'space-chess');
    assert.equal(pkg.private, true);
    assert.equal(pkg.repository, undefined);
    assert.ok(pkg.scripts.check && pkg.dependencies.three);
    const cfg = readFileSync(join(target, 'board.config.ts'), 'utf8');
    assert.match(cfg, /rulesetId: 'space-chess\.v1',/);
    assert.match(cfg, /title: 'Space Chess: Captain\\'s Cut',/);
    assert.match(cfg, /storageKey: 'space-chess',/);
    assert.match(readFileSync(join(target, 'README.md'), 'utf8'), /^# Space Chess: Captain's Cut/);
    assert.equal(cli('create', join(dir, 'x'), '--template', 'checkers').status, 1, 'unknown templates fail');
    assert.equal(cli('create', join(dir, 'y'), '--template', 'board', '--from', dir).status, 1, 'a folder that is not the template fails');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
