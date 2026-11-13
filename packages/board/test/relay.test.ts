// The gauntlet relay (ported from Rapture Chess's relay tests): dev rooms (untimed, draw offers), a placed match with
// HMAC seat tickets as node/gauntlet.js mints them, the time control and clock stamps in the log, flags, the sign
// request with real player keys (LitNode's keys.js and log.js, vendored), and settlement that never waits on the
// loser: players → relay key → host, with the signatures that did arrive broadcast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import config from '../board.config';
import { chessMove } from '../src/game/rules';
import { encodeMove, Op } from '../src/kit/match';
import { chainHead, ledgerBody, signLedger, verifyLedger } from '../vendor/litnode/protocol/log.js';
import { generateKeypair, verify } from '../vendor/litnode/protocol/keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

type Msg = { t: string; [k: string]: any };
type Entry = { k: number; inputs: number[] };
const move = (from: string, to: string): number => encodeMove(chessMove(from, to));
const actionOf = (inputs: number[]): number => inputs.find((w) => w && (w & 7) !== Op.Clock) ?? 0;
const stampOf = (inputs: number[]): number | undefined => inputs.find((w) => (w & 7) === Op.Clock);
const SCHOLARS: Array<[string, string]> = [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']];

function client(url: string, hello: Record<string, unknown>) {
  const ws = new WebSocket(url);
  const inbox: Msg[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => { inbox.push(JSON.parse(String(d))); for (const w of waiters.splice(0)) w(); });
  const next = (t: string, timeoutMs = 8000): Promise<Msg> => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}; got ${inbox.map((m) => m.t).join(',')}`)), timeoutMs);
    const poll = (): void => { const i = inbox.findIndex((m) => m.t === t); if (i >= 0) { clearTimeout(timer); res(inbox.splice(i, 1)[0]); } else waiters.push(poll); };
    poll();
  });
  const send = (m: unknown): void => ws.send(JSON.stringify(m));
  const ready = new Promise((res) => ws.once('open', res));
  return { ws, next, send, inbox, hello: async () => { await ready; send(hello); } };
}

async function startRelay(env: Record<string, string>): Promise<{ port: number; child: ChildProcess; out: string[]; stop: () => void }> {
  const port = 7900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [tsxCli, 'relay/server.mts'], { cwd: root, env: { ...process.env, PORT: String(port), BOARD_RELAY_KEY_FILE: 'no-such-file.json', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = [];
  child.stdout!.on('data', (d) => out.push(String(d)));
  child.stderr!.on('data', (d) => out.push(String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (out.join('').includes('[board relay]')) break;
    if (child.exitCode != null) throw new Error(`relay exited: ${out.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, out, stop: () => child.kill() };
}

/** Play the scholar's mate; `k0` is the first move's entry index (1 when entry 0 sets the time control). */
async function play(a: ReturnType<typeof client>, b: ReturnType<typeof client>, k0 = 0, moves = SCHOLARS): Promise<void> {
  for (let i = 0; i < moves.length; i++) {
    const mover = i % 2 === 0 ? a : b;
    mover.send({ t: 'act', x: move(...moves[i]) });
    const ea = await a.next('entry'), eb = await b.next('entry');
    assert.equal(ea.entry.k, k0 + i);
    assert.deepEqual(ea.entry, eb.entry);
    assert.equal(ea.entry.inputs[i % 2], move(...moves[i]));
    assert.equal(actionOf(ea.entry.inputs), move(...moves[i]));
  }
}

/** A stub LitNode: records /ledger posts; `answer(body, n)` returns [status, json]. */
async function stubNode(answer: (body: any, n: number) => [number, unknown]) {
  const posts: Array<{ url: string; body: any }> = [];
  const node = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const b = JSON.parse(body);
      posts.push({ url: req.url ?? '', body: b });
      const [status, json] = answer(b, posts.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => node.listen(0, '127.0.0.1', r));
  return { posts, url: `http://127.0.0.1:${(node.address() as AddressInfo).port}`, close: () => node.close() };
}

const secret = 'a'.repeat(64);
const matchId = 'c'.repeat(64);
const build = 'b'.repeat(64);
const mint = (claims: Record<string, unknown>): string => { const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`; };
const gauntletEnv = (seats: string[], nodeUrl: string, extra: Record<string, string> = {}): Record<string, string> => ({
  GAUNTLET_SECRET: secret, GAUNTLET_MATCH_ID: matchId, GAUNTLET_SEED: 'd'.repeat(64), GAUNTLET_SEATS: JSON.stringify([{ sub: seats[0], team: 0, slot: 0 }, { sub: seats[1], team: 1, slot: 0 }]),
  GAUNTLET_NODE_URL: nodeUrl, GAUNTLET_BUILD: build, GAUNTLET_PLACED_MODE: 'casual', ...extra,
});
async function seatBoth(url: string, seats: string[]) {
  const exp = Date.now() + 600_000;
  const a = client(url, { t: 'hello', ticket: mint({ sub: seats[0], matchId, team: 0, slot: 0, mode: 'singles', exp }) });
  const b = client(url, { t: 'hello', ticket: mint({ sub: seats[1], matchId, team: 1, slot: 0, mode: 'singles', exp }) });
  await a.hello(); await a.next('seated');
  await b.hello();
  const start = await a.next('start'); await b.next('start');
  return { a, b, start };
}
/** What a player's arcade shell signs at the end: the ledger body over the entries this client recorded. */
const signAs = (kp: { publicKey: string; privateKey: string }, entries: Entry[]): Promise<string> =>
  signLedger(ledgerBody({ matchId, ticks: entries.length, head: chainHead(entries), buildHash: build }), kp);

test('dev room (untimed): turn order, illegal moves, a scholar\'s mate, an unsigned finish', async () => {
  const relay = await startRelay({ RELAY_DEV: '1', BOARD_TC: 'none' });
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const a = client(url, { t: 'hello', room: 'test', player: 'alice' });
    const b = client(url, { t: 'hello', room: 'test', player: 'bob' });
    await a.hello();
    assert.equal((await a.next('seated')).side, 0);
    await b.hello();
    const startA = await a.next('start'), startB = await b.next('start');
    assert.equal(startA.seed, startB.seed);
    assert.equal(startA.rulesetId, config.rulesetId);
    assert.equal(startA.tc, null);
    assert.deepEqual(startA.participants, ['alice', 'bob']);
    b.send({ t: 'act', x: move('e7', 'e5') });
    assert.equal((await b.next('reject')).reason, 'not your turn');
    a.send({ t: 'act', x: move('e2', 'e5') });
    assert.equal((await a.next('reject')).reason, 'illegal');
    await play(a, b);
    const over = await a.next('over');
    assert.equal(over.winner, 0);
    assert.equal(over.reason, 'checkmate');
    await a.next('sign');
    const settled = await a.next('settled');
    assert.equal(settled.dev, true);
    assert.equal(settled.entries.length, 7);
    const view = await fetch(`http://127.0.0.1:${relay.port}/match/test`).then((r) => r.json()) as { over: boolean };
    assert.equal(view.over, true);
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('dev room: a draw offer, a premature accept refused, the acceptance', async () => {
  const relay = await startRelay({ RELAY_DEV: '1', BOARD_TC: 'none' });
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const a = client(url, { t: 'hello', room: 'draw', player: 'alice' });
    const b = client(url, { t: 'hello', room: 'draw', player: 'bob' });
    await a.hello(); await a.next('seated'); await b.hello(); await a.next('start'); await b.next('start');
    b.send({ t: 'act', x: Op.Accept });
    assert.match((await b.next('reject')).reason, /no draw offer/);
    b.send({ t: 'act', x: Op.Offer });                    // out of turn: allowed
    const offered = await a.next('entry'); await b.next('entry');
    assert.equal(offered.entry.inputs[1], Op.Offer);
    a.send({ t: 'act', x: Op.Accept });
    await a.next('entry');
    const over = await a.next('over');
    assert.equal(over.winner, 2);
    assert.equal(over.reason, 'agreement');
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('placed match: bad ticket refused, the clock in the log, real ledger signatures, the players ledger', async () => {
  const [k0, k1] = [await generateKeypair(), await generateKeypair()];
  const seats = [k0.publicKey, k1.publicKey];
  const node = await stubNode(() => [200, { matchId, attestation: 'players', proof: 'verified', placed: true }]);
  const relay = await startRelay(gauntletEnv(seats, node.url, { GAUNTLET_PLACED_MODE: 'ranked', BOARD_TC: '3+2' }));
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const bad = client(url, { t: 'hello', ticket: mint({ sub: seats[0], matchId, exp: Date.now() + 600_000 }).replace(/.$/, 'x') });
    await bad.hello();
    assert.match((await bad.next('error')).message, /bad ticket/);
    const { a, b, start } = await seatBoth(url, seats);
    assert.equal(start.rulesetId, config.rulesetId);
    assert.deepEqual(start.tc, { base: 180_000, inc: 2_000 });
    assert.equal(start.entries.length, 1);
    assert.equal(start.entries[0].inputs[0] & 7, Op.Control);
    assert.equal(start.firstMove, true);
    await play(a, b, 1);
    await a.next('over');
    const signA = await a.next('sign'); await b.next('sign');
    assert.equal(signA.ticks, 8);
    const view = await fetch(`http://127.0.0.1:${relay.port}/match/${matchId}`).then((r) => r.json()) as { entries: Entry[] };
    a.send({ t: 'sig', sig: 'e'.repeat(128) });                       // a signature that does not verify is refused
    assert.match((await a.next('reject')).reason, /does not verify/);
    a.send({ t: 'sig', sig: await signAs(k0, view.entries) });
    b.send({ t: 'sig', sig: await signAs(k1, view.entries) });
    const settled = await a.next('settled');
    assert.equal(settled.delta.attestation, 'players');
    assert.equal(node.posts.length, 1);
    const sub = node.posts[0].body;
    assert.equal(node.posts[0].url, '/ledger');
    assert.equal(sub.rulesetId, config.rulesetId);
    assert.equal(sub.mode, 'ranked');
    assert.equal(sub.entries.length, 8);
    for (const e of sub.entries.slice(1)) assert.notEqual(stampOf(e.inputs), undefined);
    assert.equal(stampOf(sub.entries[1].inputs)! >>> 3, 0);            // first moves are off the clock
    assert.equal(stampOf(sub.entries[2].inputs)! >>> 3, 0);
    // exactly what a node checks before it settles a players ledger
    const v = await verifyLedger({ entries: sub.entries, matchId, participants: seats, buildHash: build, hydrationHash: null, signatures: sub.signatures });
    assert.equal(v.ok, true, v.reason ?? '');
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); node.close(); }
});

test('a flag: the side to move runs out, the bare stamp ends the game', async () => {
  const node = await stubNode(() => [200, { matchId, attestation: 'players', proof: 'verified' }]);
  const seats = ['1'.repeat(64), '2'.repeat(64)];
  const relay = await startRelay(gauntletEnv(seats, node.url, { BOARD_TC: '0.02+0' }));   // 1 s (whole seconds)
  try {
    const { a, b } = await seatBoth(`ws://127.0.0.1:${relay.port}`, seats);
    await play(a, b, 1, SCHOLARS.slice(0, 2));
    const flag = await a.next('entry', 5000);
    assert.equal(actionOf(flag.entry.inputs), 0);
    assert.ok((stampOf(flag.entry.inputs)! >>> 3) >= 1000);
    const over = await a.next('over');
    assert.equal(over.winner, 1);
    assert.equal(over.reason, 'timeout');
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); node.close(); }
});

test('the loser leaves without signing: the relay key, then the host, and the winner\'s signature broadcast', async () => {
  // the node refuses the relay (as one whose RELAY_KEYS does not list it would) and takes the host attestation
  const node = await stubNode((b) => (b.relay ? [400, { error: 'relay is not a relay this host trusts' }] : [200, { matchId, attestation: 'host', proof: 'replayed', placed: true }]));
  const [k0, k1] = [await generateKeypair(), await generateKeypair()];
  const seats = [k0.publicKey, k1.publicKey];
  const relay = await startRelay(gauntletEnv(seats, node.url, { BOARD_TC: '3+2', BOARD_RELAY_KEY: '9'.repeat(64), BOARD_SIGN_MS: '3000' }));
  try {
    const { a, b } = await seatBoth(`ws://127.0.0.1:${relay.port}`, seats);
    await play(a, b, 1);
    await a.next('over');
    b.ws.close();                                          // Black, mated, leaves before signing
    await a.next('sign');
    const view = await fetch(`http://127.0.0.1:${relay.port}/match/${matchId}`).then((r) => r.json()) as { entries: Entry[] };
    const winnerSig = await signAs(k0, view.entries);
    a.send({ t: 'sig', sig: winnerSig });
    const settled = await a.next('settled', 8000);
    assert.equal(settled.delta.attestation, 'host');
    assert.deepEqual(settled.signatures, { [seats[0]]: winnerSig });
    assert.equal(node.posts.length, 2);
    const [viaRelay, viaHost] = node.posts.map((p) => p.body);
    assert.equal(viaRelay.signatures, undefined);         // partial signatures would be refused outright
    assert.match(viaRelay.relay.id, /^[0-9a-f]{64}$/);
    assert.equal(viaHost.relay, undefined);
    assert.equal(viaHost.signatures, undefined);
    // exactly what LitNode's settle.js checks: RELAY_TAG over { matchId, head, ticks, expected } with its own chainHead
    const body = { matchId, head: chainHead(viaRelay.entries), ticks: viaRelay.entries.length, expected: null };
    assert.equal(await verify('relay', body, viaRelay.relay.sig, viaRelay.relay.id), true);
    a.ws.close();
  } finally { relay.stop(); node.close(); }
});
