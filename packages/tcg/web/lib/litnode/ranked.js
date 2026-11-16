// Ranked play from the game itself, no arcade in between (Rapture Chess's src/litnode/standalone.ts). This page holds
// the player's LitNode key (ed25519, in this origin's storage, as the arcade keeps its own), finds the mesh in
// NodeDirectory on chain, queues, and verifies the placement the way the arcade does: the host must be the one the
// placement rule produces from a snapshot rebuilt from signed heartbeats, and the beacon must be the chain block it
// names. The seat challenge and the match ledger are signed here by a CabinetShell of our own, under the same checks
// the arcade applies before it signs.
//
// The protocol code is LitNode's own (./mesh, vendored by scripts/vendor-litnode.mjs).
import { createClient, loadPlayer } from "./mesh/client.js";
import { checkChallenge, newNonce, NONCE_RE, signSeat } from "./mesh/protocol/challenge.js";
import { decodeEntry, entryOfCall, liveSeeds, mapLimit, readDirectoryKeys, READ_CONCURRENCY } from "./mesh/protocol/directory.js";
import { hasWebCrypto } from "./mesh/protocol/keys.js";
import { chainHead, ledgerBody, signLedger } from "./mesh/protocol/log.js";
import { roomCodeFor } from "./mesh/protocol/pairing.js";
import { decodeStanding, standingCall } from "./mesh/protocol/staking.js";

const NODE_KEY = "tessaract.mesh.node";
/** The LitNode contract set the arcade publishes (CORS open); the generation-3 addresses stand in when it is down. */
const CONTRACTS_URL = "https://arcade.litvm.games/contracts.json";
const FALLBACK = { NodeDirectory: "0xac0C73008028E3eAA05Bc5C72f0C233F94b4E3df", NodeStake: "0x3CFe2D006d946A1E0E5Cf6B3E0958aFc3fF73717" };
const QUEUE_MS = 5 * 60_000;

const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };
const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

/** Ed25519 in WebCrypto: every current browser on https (and localhost); absent on plain http from a network address. */
export const canHoldKey = () => hasWebCrypto() && globalThis.isSecureContext === true;

let key = null;
/** This browser's LitNode player key: made once, then kept. */
export function playerKey() {
  key ??= loadPlayer(globalThis.localStorage).catch((e) => { key = null; throw e; });
  return key;
}
let keyId = null;
void (canHoldKey() ? playerKey().then((k) => { keyId = k.publicKey; }, () => {}) : null);
/** The key's public half once loaded (sync, for the ladder and the stakes panel), else null. */
export const playerKeyId = () => keyId;

let nodeUrl = load(NODE_KEY);
/** The node this page last queued through (the mesh entry point), if any. */
export const meshNode = () => nodeUrl;

async function contracts() {
  try {
    const j = await (await fetch(CONTRACTS_URL, { signal: timeout(5000) })).json();
    const dir = j.contracts?.NodeDirectory?.address, stake = j.contracts?.NodeStake?.address;
    if (dir && stake) return { NodeDirectory: dir, NodeStake: stake };
  } catch { /* the fallback */ }
  return FALLBACK;
}

/**
 * The live, bonded nodes NodeDirectory announces (freshest first), with their https address. Reading the directory is
 * a few dozen eth_calls through a public RPC, so the result is kept for a minute.
 */
let seedCache = null, seedRead = null;
export function meshSeeds(chain) {
  if (seedCache && Date.now() - seedCache.at < 60_000) return Promise.resolve(seedCache.seeds);
  // the Ranked page and the Leaderboard may both ask at once: one read serves both
  seedRead ??= readSeeds(chain).finally(() => { seedRead = null; });
  return seedRead;
}
async function readSeeds(chain) {
  const c = await contracts();
  const call = (payload) => chain.request("eth_call", [payload, "latest"]);
  const keys = await readDirectoryKeys(call, c.NodeDirectory);
  const entries = {}, stakes = {};
  await mapLimit(keys, Math.max(1, READ_CONCURRENCY / 2), async (k) => {
    try {
      const [e, s] = await Promise.all([call(entryOfCall(c.NodeDirectory, k)), call(standingCall(c.NodeStake, k))]);
      entries[k] = decodeEntry(e); stakes[k] = decodeStanding(s);
    } catch { /* this node is skipped */ }
  });
  const seeds = liveSeeds(entries, stakes).filter((s) => /^https:/.test(s.url));
  seedCache = { at: Date.now(), seeds };
  return seeds;
}

const answers = async (url) => {
  try { return (await fetch(`${url}/health`, { signal: timeout(5000) })).ok; } catch { return false; }
};

/**
 * A node to queue through: the last one that worked, else the freshest bonded node announced in NodeDirectory that
 * proves it holds the key its entry names (it signs our nonce: anyone can answer /health). Https only.
 */
export async function findNode(chain, say) {
  if (nodeUrl && await answers(nodeUrl)) return nodeUrl;
  say("Finding the LitNode mesh on chain…");
  const seeds = await meshSeeds(chain);
  say(`Reaching a node (${seeds.length} announced)…`);
  for (const s of seeds) {
    try {
      const nonce = newNonce();
      const r = await fetch(`${s.url}/whoami?nonce=${nonce}`, { signal: timeout(6000) });
      if (!r.ok) continue;
      const proof = await checkChallenge(await r.json(), { expectNodeId: s.nodeId, nonce });
      if (!proof.ok) continue;
      nodeUrl = s.url.replace(/\/+$/, "");
      store(NODE_KEY, nodeUrl);
      return nodeUrl;
    } catch { /* the next one */ }
  }
  throw new Error("No LitNode node answers right now. Try again in a minute.");
}

/**
 * A CabinetShell of our own: signs only the seat and the ledger of the match this page queued for, as the arcade.
 * `onLedger(sig)` is told this player's ledger signature (escrow v2 pays a match the loser never signed on it).
 */
export function localShell(kp, node, m, onLedger = () => {}) {
  return {
    init: { player: { id: kp.publicKey, guest: true }, node: { url: node, online: true }, match: { matchId: m.matchId, wsAddr: m.wsAddr, participants: m.participants, mode: "ranked", buildHash: m.buildHash ?? undefined, rulesetId: m.rulesetId } },
    async signSeat(c) {
      const ok = c.matchId === m.matchId && c.room === roomCodeFor(m.matchId) && c.player === kp.publicKey && typeof c.nonce === "string" && NONCE_RE.test(c.nonce);
      if (!ok) throw new Error("not a seat in the match this game queued for");
      return signSeat(c, kp.privateKey);
    },
    async signLedger(matchId, buildHash, entries) {
      if (matchId !== m.matchId) throw new Error("not the match this game queued for");
      if (m.buildHash && buildHash && buildHash !== m.buildHash) throw new Error("the relay names another build");
      let head = null;
      try { head = chainHead(entries); } catch { /* a gap or a reorder */ }
      if (!head || !entries.length) throw new Error("the log has a gap or a reorder");
      const sig = await signLedger(ledgerBody({ matchId, ticks: entries.length, head, buildHash: m.buildHash ?? buildHash ?? null }), kp);
      onLedger(sig);
      return sig;
    },
    exit: () => {},
    close: () => {},
  };
}

/**
 * Queue for a ranked match of `rulesetId` and wait (re-entering every 2 s bucket, up to five minutes) until the mesh
 * pairs this key. Resolves with { launch, shell, matchId, host, hostUrl, me, opponent, ledgerSig() }, or null when
 * stopped or nobody came. `onLedger(matchId, sig)` is told this player's ledger signature once the match is signed.
 */
export async function findRanked({ chain, rulesetId, title, signal, say, onLedger = () => {} }) {
  const kp = await playerKey();
  const node = await findNode(chain, say);
  if (signal.aborted) return null;
  const rpc = (method, params) => chain.request(method, params);
  const client = createClient({ nodeUrl: node, player: kp, rpc });
  const region = await client.health().then((h) => h.region ?? null, () => null);
  const entry = { rulesetId, mode: "ranked", region };
  say("Signing your queue entry…");
  let bucket;
  try { ({ bucket } = await client.queue(entry)); } catch (e) {
    // a node that went away since the last visit: forget it, so the next try reads the directory again
    if (/fetch|network|failed/i.test(e.message)) { nodeUrl = null; store(NODE_KEY, null); }
    throw e;
  }
  const t0 = Date.now();
  const r = await client.waitForMatch({
    timeoutMs: QUEUE_MS, sinceBucket: bucket, requeue: entry, signal,
    onTick: (m) => { if (!m) say(`Searching for an opponent… ${Math.round((Date.now() - t0) / 1000)} s`); },
    onPaired: () => say("Opponent found. Checking the placement and the host…"),
  });
  if (!r) return null;
  if (!r.check.ok) throw new Error(`The placement did not check out (${r.check.reason ?? "unknown"}): not joining.`);
  const m = r.match;
  // the relay both players join: the host's, else the arcade's fallback (the lowest-keyed bonded peer serving this build)
  const host = r.snapshot.peers.find((p) => p.nodeId === m.host) ?? null;
  const relay = host?.wsAddr || r.snapshot.peers.filter((p) => p.wsAddr && p.buildHashes?.[m.rulesetId] && p.standing !== 0).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))[0]?.wsAddr || null;
  if (!relay) throw new Error(`The host runs no match server for ${title}.`);
  const buildHash = m.buildHash ?? null;
  // claims read the delta from the host, where the relay settles it
  const hostUrl = host?.addr?.replace(/\/+$/, "") ?? node;
  let mySig = null;
  const shell = localShell(kp, hostUrl, { matchId: m.matchId, buildHash, wsAddr: relay, participants: m.participants, rulesetId: m.rulesetId }, (sig) => { mySig = sig; onLedger(m.matchId, sig); });
  const launch = { ws: relay, room: roomCodeFor(m.matchId), player: kp.publicKey, matchId: m.matchId, buildHash, placed: true };
  return { launch, shell, matchId: m.matchId, host: m.host, hostUrl, me: kp.publicKey, opponent: m.participants.find((p) => p !== kp.publicKey) ?? "", ledgerSig: () => mySig };
}

/**
 * Take the seat the mesh placed this player in and join the relay: the same steps as the engine's
 * RelaySession.placed(), with the shell and launch this page made instead of an arcade iframe's.
 */
export async function seatPlaced(RelaySession, rules, placement, champion) {
  const { launch, shell } = placement;
  const you = shell.init.player.id;
  const base = `${launch.ws.replace(/^ws/, "http").replace(/\/+$/, "")}/${launch.room}/ticket?player=${encodeURIComponent(you)}`;
  // First ask returns a one-time nonce (401); the second carries the player key's signature over it.
  const first = await fetch(base).then((r) => r.json());
  if (!first.challenge) throw new Error(first.error ?? "seat: no challenge");
  const sig = await shell.signSeat(first.challenge);
  const seat = await fetch(`${base}&nonce=${first.challenge.nonce}&sig=${sig}`).then((r) => r.json());
  if (!seat.ticket || !seat.ws) throw new Error(seat.error ?? "seat: no ticket");
  // The engine's constructor and open() are TypeScript-private only: this is RelaySession.placed() minus connectShell().
  const s = new RelaySession(rules, you, shell);
  s.open(seat.ws, { t: "hello", ticket: seat.ticket, champion: champion ? { tokenId: champion.tokenId } : undefined });
  return s;
}
