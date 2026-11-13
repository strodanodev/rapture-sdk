// Mint site — drand evmnet beacons, the randomness PackShopV2 draws packs from.
//
// buyPack() binds a pack to a future drand round (13-15 s ahead). Once the League of Entropy publishes that round,
// its BLS signature is what openPack() proves on chain, so this module's one job is to get a round's signature as soon
// as it exists: GET <mirror>/v2/beacons/evmnet/rounds/<round> -> {"round": N, "signature": "<64 bytes of hex>"}.
//
// Why it polls instead of trusting the clock: a round is due at genesis + (round - 1) * period, but the player's clock
// can be off by seconds or minutes. Waiting on the local clock alone would open late (clock slow) or ask too early
// (clock fast), so the local clock only paces the polling and drives the countdown; the mirror's answer decides. A round
// that is not out yet answers 425 Too Early (some mirrors 404); a signature never changes once published, so it is
// cached for the page's lifetime. Nothing here is trusted beyond its shape: the chain verifies every signature.
import { isAbort, sleep as defaultSleep } from "./chain.js";

/** drand evmnet (api.drand.sh/v2/beacons/evmnet/info). drand.cloudflare.com does not serve this chain. */
export const EVMNET = Object.freeze({
  id: "evmnet",
  chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
  genesis: 1727521075,
  period: 3,
  urls: Object.freeze(["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"]),
});

const TIMEOUT_MS = 6000;          // per mirror request
const RETRY_MS = 1000;            // poll interval once the round is due by the local clock
const EARLY_POLL_MS = 4000;       // poll interval while the local clock says the round is still ahead (it may be slow)
const TICK_MS = 1000;             // countdown granularity while waiting
const OVERDUE_MS = 3000;          // past due by this much, a "not yet" from one mirror sends us to the others
const GRACE_MS = 120000;          // give up this long after the round is due (or after starting, if later)
const CONCURRENCY = 4;
const CACHE_LIMIT = 256;

/**
 * code: not_yet (the round is not published: 425/404), unavailable (no mirror could answer), bad_response (a mirror
 * answered something that is not this round's signature), aborted (the caller's signal fired; .aborted is set, so
 * chain.js isAbort() recognises it), bad_round (not a round number).
 */
export class BeaconError extends Error {
  constructor(code, message, props = {}) {
    const { cause, ...rest } = props;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BeaconError";
    this.code = code;
    if (code === "aborted") this.aborted = true;
    Object.assign(this, rest);
  }
}
const aborted = (cause) => new BeaconError("aborted", "Cancelled.", { cause });

/**
 * The beacon section of site.config.json (mint.beacon) over the evmnet defaults: { id, chainHash, genesis, period, urls }. A field the
 * config leaves out takes the default; a field it gets wrong throws TypeError (a broken config is not guessed around).
 */
export function normalizeBeacon(b) {
  if (b == null) return EVMNET;
  if (typeof b !== "object") throw new TypeError("beacon must be an object");
  const int = (v, name, fallback) => {
    if (v == null) return fallback;
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`beacon.${name} must be a positive integer`);
    return v;
  };
  let urls = EVMNET.urls;
  if (b.urls != null) {
    if (!Array.isArray(b.urls) || !b.urls.length || !b.urls.every((u) => typeof u === "string" && /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(u))) {
      throw new TypeError("beacon.urls must be a non-empty list of https URLs");
    }
    urls = Object.freeze(b.urls.map((u) => u.replace(/\/+$/, "")));
  }
  const chainHash = b.chainHash == null ? EVMNET.chainHash : String(b.chainHash).replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(chainHash)) throw new TypeError("beacon.chainHash must be 32 bytes of hex");
  return Object.freeze({
    id: EVMNET.id,
    chainHash,
    genesis: int(b.genesis, "genesis", EVMNET.genesis),
    period: int(b.period, "period", EVMNET.period),
    urls,
    ...(b.registry ? { registry: b.registry } : {}),
  });
}

const asRound = (r) => {
  const n = typeof r === "bigint" ? Number(r) : r;
  if (!Number.isSafeInteger(n) || n < 1) throw new BeaconError("bad_round", `Not a drand round: ${String(r)}`);
  return n;
};
/** When drand publishes `round` (unix seconds). */
export const roundTime = (round, beacon = EVMNET) => beacon.genesis + (asRound(round) - 1) * beacon.period;
/** The round published most recently at unix time `seconds` (round 1 is at genesis), as the contract counts it. */
export const roundAt = (seconds, beacon = EVMNET) => Math.floor((seconds - beacon.genesis) / beacon.period) + 1;

// round -> "0x" signature. A published signature is final, so this only saves requests.
const cache = new Map();
const remember = (round, sig) => {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(round, sig);
};

/** A mirror's JSON -> the 0x signature for `round`, or BeaconError(bad_response). */
function parse(j, round, url) {
  const r = typeof j?.round === "string" && /^\d+$/.test(j.round) ? Number(j.round) : j?.round;
  if (r !== round) throw new BeaconError("bad_response", `drand mirror ${url} answered round ${String(j?.round)} for round ${round}`, { url });
  const sig = typeof j?.signature === "string" ? j.signature.replace(/^0x/, "") : "";
  if (!/^[0-9a-fA-F]{128}$/.test(sig)) throw new BeaconError("bad_response", `drand mirror ${url} sent a signature that is not 64 bytes of hex`, { url });
  return "0x" + sig.toLowerCase();
}

/** One GET to one mirror, with a hard timeout. Resolves the signature; rejects BeaconError(not_yet | unavailable | bad_response | aborted). */
async function ask(f, base, round, timeoutMs, signal) {
  const url = `${base}/v2/beacons/${EVMNET.id}/rounds/${round}`;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res;
    try { res = await f(url, { signal: ctl.signal, headers: { accept: "application/json" } }); }
    catch (e) {
      if (signal?.aborted) throw aborted(e);
      throw new BeaconError("unavailable", timedOut ? `drand mirror ${base} did not answer within ${timeoutMs} ms` : `drand mirror ${base} is unreachable`, { url, cause: e });
    }
    if (res.status === 425 || res.status === 404) throw new BeaconError("not_yet", `drand round ${round} is not out yet`, { url, status: res.status });
    if (!res.ok) throw new BeaconError("unavailable", `drand mirror ${base} answered HTTP ${res.status}`, { url, status: res.status });
    let j;
    try { j = await res.json(); }
    catch (e) {
      if (signal?.aborted) throw aborted(e);
      throw new BeaconError(timedOut ? "unavailable" : "bad_response", `drand mirror ${base} sent something that is not JSON`, { url, cause: e });
    }
    return parse(j, round, url);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The signature of a published round, from the first mirror that has it. A mirror saying "not out yet" is believed
 * (asking the others would triple the requests while waiting) unless allMirrors is set, which waitForSignature does once
 * the round is overdue, in case that one mirror is lagging. Rejects BeaconError not_yet, unavailable (every mirror
 * failed), bad_response, or aborted on `signal`. opts: beacon (normalizeBeacon result), fetch, timeoutMs, signal, allMirrors.
 */
export async function fetchRound(round, { beacon = EVMNET, fetch: f = globalThis.fetch, timeoutMs = TIMEOUT_MS, signal, allMirrors = false } = {}) {
  const n = asRound(round);
  if (cache.has(n)) return cache.get(n);
  if (signal?.aborted) throw aborted();
  if (typeof f !== "function") throw new BeaconError("unavailable", "fetch is not available in this environment");
  const failures = [];
  for (const base of beacon.urls) {
    try {
      const sig = await ask(f, base, n, timeoutMs, signal);
      remember(n, sig);
      return sig;
    } catch (e) {
      if (e.code === "aborted") throw e;
      failures.push(e);
      if (e.code === "not_yet" && !allMirrors) break;
    }
  }
  if (failures.some((e) => e.code === "not_yet")) throw new BeaconError("not_yet", `drand round ${n} is not out yet`, { round: n, failures });
  const bad = failures.some((e) => e.code === "bad_response");
  throw new BeaconError(bad ? "bad_response" : "unavailable", `No drand mirror could provide round ${n}. Check your connection and try again.`, { round: n, failures, cause: failures.at(-1) });
}

/**
 * Wait for a round and return its signature. The local clock paces it: onTick({ round, secondsLeft, asks, error })
 * every second for a countdown (secondsLeft is the local estimate, never negative), the mirrors are asked at once and
 * then every EARLY_POLL_MS while the round is still ahead (the clock may be slow), and every retryMs once it is due,
 * until graceMs after it was due (or after the start, if later). opts as fetchRound plus now (ms clock),
 * sleep (ms, signal), graceMs, retryMs.
 */
export async function waitForSignature(round, opts = {}) {
  const n = asRound(round);
  const { beacon = EVMNET, signal, onTick, now = Date.now, sleep = defaultSleep, graceMs = GRACE_MS, retryMs = RETRY_MS } = opts;
  if (cache.has(n)) return cache.get(n);
  const due = roundTime(n, beacon) * 1000;
  const deadline = Math.max(due, now()) + graceMs;
  let error = null, asks = 0, lastAsk = -Infinity;
  for (;;) {
    if (signal?.aborted) throw aborted();
    const t = now(), left = due - t;
    if (typeof onTick === "function") {
      try { onTick({ round: n, secondsLeft: Math.max(0, Math.ceil(left / 1000)), asks, error }); }
      catch (e) { console.error("[drand] onTick callback threw", e); }
    }
    if (left <= 0 || t - lastAsk >= EARLY_POLL_MS) {
      lastAsk = t;
      asks++;
      try { return await fetchRound(n, { ...opts, allMirrors: t >= due + OVERDUE_MS }); }
      catch (e) {
        if (e.code === "aborted" || isAbort(e)) throw e.code === "aborted" ? e : aborted(e);
        if (e.code === "bad_round") throw e;
        error = e;
      }
      if (now() >= deadline) throw error;
    }
    const wait = due - now();
    try { await sleep(wait > 0 ? Math.min(wait, TICK_MS) : retryMs, signal); }
    catch (e) { throw aborted(e); }
  }
}

/** Signatures for several rounds, in the same order (a few requests at a time). opts as waitForSignature, minus onTick. */
export async function waitForSignatures(rounds, opts = {}) {
  const list = rounds.map(asRound);
  const out = new Array(list.length);
  let next = 0;
  const { onTick, ...rest } = opts;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await waitForSignature(list[i], rest);
    }
  }));
  return out;
}

/** Test hook: forget every cached signature. */
export const clearSignatureCache = () => cache.clear();
