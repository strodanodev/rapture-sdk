// The LitNode ruleset: built from src/litnode/title.entry.ts and checked by LitNode's own conformance suite (the copy
// in vendor/litnode, so no checkout and no network), then replayed by LitNode's sandbox to the same state the
// TypeScript rules reach. The id is the config's own: never rapture-chess.*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../board.config';
import { game, chessMove } from '../src/game/rules';
import { createMatchRules, encodeClock, encodeControl, encodeMove } from '../src/kit/match';
import { buildTitle } from '../scripts/build-title.mjs';
import { createSandbox } from '../vendor/litnode/node/sandbox.js';
import { h } from '../vendor/litnode/protocol/canonical.js';

const P = ['1'.repeat(64), '2'.repeat(64)];
const SCHOLARS: Array<[string, string]> = [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']];
/** A timed scholar's mate as the relay logs it: the control first, then every move stamped in the other slot. */
const entries = [{ k: 0, inputs: [encodeControl(60, 1), 0] }, ...SCHOLARS.map(([f, t], i) => {
  const inputs = [0, 0];
  inputs[i % 2] = encodeMove(chessMove(f, t));
  inputs[(i + 1) % 2] = encodeClock(1_500);
  return { k: i + 1, inputs };
})];

test('the sample ruleset builds, passes LitNode conformance and replays in the sandbox', async () => {
  assert.match(config.rulesetId, /^[a-z0-9][a-z0-9-]*\.v\d+$/);
  assert.ok(!config.rulesetId.startsWith('rapture-chess'), 'the template must not claim Rapture Chess\'s id');
  const dir = mkdtempSync(join(tmpdir(), 'board-title-'));
  try {
    const r = await buildTitle({ out: join(dir, 'rulesets'), titles: join(dir, 'titles'), litnode: '', stdio: 'pipe' });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.rulesetId, config.rulesetId);
    const source = readFileSync(r.artifact, 'utf8');
    const sidecar = JSON.parse(readFileSync(r.sidecar, 'utf8'));
    assert.equal(sidecar.rulesetId, config.rulesetId);
    assert.equal(sidecar.kind, 'replayable');
    assert.equal(sidecar.buildHash, h('ruleset', source));   // what TitleRegistry and every node pin
    assert.ok(!source.includes('\r\n'));

    // the built artifact, imported, matches the TypeScript rules entry for entry
    const title = (await import(pathToFileURL(r.title).href)).default;
    assert.equal(title.manifest.rulesetId, config.rulesetId);
    assert.equal(title.manifest.maxTicks, config.maxBeats);
    const rules = createMatchRules(game, { maxBeats: config.maxBeats });
    let a = title.init('seed', P), b = rules.init('seed', P);
    for (const e of entries) {
      const inputs = { [P[0]]: e.inputs[0], [P[1]]: e.inputs[1] };
      a = title.step(a, inputs); b = rules.step(b, inputs);
    }
    assert.deepEqual(title.serialize(a), JSON.parse(JSON.stringify(b)));
    assert.equal(a.reason, 'checkmate');
    assert.deepEqual(a.left, [58_000, 58_500]);   // four and three moves at 1.5 s each, 1 s back per move

    // LitNode's sandbox (the process a node settles in) replays the clocked log to the same result
    const sandbox = createSandbox() as unknown as { one(source: string, job: Record<string, unknown>): Promise<{ done: boolean; scores: Record<string, number>; serialized: string }> };
    const replay = await sandbox.one(source, { kind: 'replay', seed: 'd'.repeat(64), participants: P, entries, maxTicks: config.maxBeats });
    assert.equal(replay.done, true);
    assert.deepEqual(replay.scores, { [P[0]]: 1, [P[1]]: 0 });
    const final = JSON.parse(replay.serialized);
    assert.equal(final.reason, 'checkmate');
    assert.deepEqual(final.tc, { base: 60_000, inc: 1_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
