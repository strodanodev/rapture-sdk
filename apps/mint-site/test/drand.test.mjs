// drand.js: the evmnet beacon client, on an injected fetch and a virtual clock (no network, no real waiting).
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cspFor } from "../web/lib/config.js";
import { EVMNET, BeaconError, normalizeBeacon, roundTime, roundAt, fetchRound, waitForSignature, waitForSignatures, clearSignatureCache } from "../web/lib/drand.js";
import { isAbort } from "../web/lib/chain.js";
import { captureConsole } from "./helpers.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/evmnet-rounds.json", import.meta.url), "utf8"));
const REAL = FIXTURE.rounds[0];                               // a real evmnet round and its BLS signature
beforeEach(() => clearSignatureCache());

/**
 * A fake set of mirrors on a virtual clock. published(round) decides what is out; per-host behaviour:
 * "ok" | "down" (network error) | "500" | "hang" (never answers until aborted) | "lag" (always 425) | (url, round) => Response.
 */
function mirrors({ now = 1_800_000_000_000, hosts = {}, sig = (r) => (r === REAL.round ? REAL.signature.slice(2) : "ab".repeat(64)) } = {}) {
  const m = { t: now, calls: [] };
  m.clock = { now: () => m.t, sleep: async (ms, signal) => { if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); m.t += ms; } };
  m.published = (round) => roundTime(round) * 1000 <= m.t;
  m.fetch = async (url, init) => {
    const u = new URL(url);
    m.calls.push({ url, at: m.t, init });
    const round = Number(/\/v2\/beacons\/evmnet\/rounds\/(\d+)$/.exec(u.pathname)?.[1]);
    const how = hosts[u.host] ?? "ok";
    if (typeof how === "function") return how(url, round, init);
    if (how === "down") throw new TypeError("Failed to fetch");
    if (how === "500") return new Response("boom", { status: 500 });
    if (how === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    if (how === "lag" || !m.published(round)) return new Response("Requested future beacon", { status: 425 });
    return new Response(JSON.stringify({ round, signature: sig(round) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  m.hosts = () => m.calls.map((c) => new URL(c.url).host);
  return m;
}
const nowRound = (m) => roundAt(m.t / 1000);
const beaconErr = (code, extra = () => true) => (e) => e instanceof BeaconError && e.code === code && Boolean(extra(e));

test("EVMNET matches drand's own chain info, and the CSP lets the page reach every mirror", () => {
  assert.equal(EVMNET.genesis, FIXTURE.info.genesis_time);
  assert.equal(EVMNET.period, FIXTURE.info.period);
  assert.equal(EVMNET.chainHash, FIXTURE.info.chain_hash);
  assert.equal(EVMNET.id, FIXTURE.info.beacon_id);
  assert.deepEqual([...EVMNET.urls], ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"]);
  // a packs site's CSP (lib/config.js cspFor) lets the page reach exactly these mirrors
  const site = JSON.parse(readFileSync(new URL("../web/site.config.json", import.meta.url), "utf8"));
  const csp = cspFor({ ...site, mint: { ...site.mint, mode: "packs" } });
  const connect = /connect-src ([^;]*)/.exec(csp)[1].split(/\s+/);
  for (const u of EVMNET.urls) assert.ok(connect.includes(u), `connect-src allows ${u}`);
  assert.ok(!connect.includes("https://drand.cloudflare.com"), "cloudflare does not serve evmnet, so it is not allowed either");
});

test("roundTime / roundAt follow the contract: round 1 at genesis, one every period, and they invert", () => {
  assert.equal(roundTime(1), EVMNET.genesis);
  assert.equal(roundTime(2), EVMNET.genesis + 3);
  assert.equal(roundTime(REAL.round), EVMNET.genesis + (REAL.round - 1) * 3);
  assert.equal(roundTime(5n), EVMNET.genesis + 12, "a bigint round works");
  assert.equal(roundAt(EVMNET.genesis), 1);
  assert.equal(roundAt(EVMNET.genesis + 2), 1);
  assert.equal(roundAt(EVMNET.genesis + 3), 2);
  for (const r of [1, 2, 1000, REAL.round, 30_000_000]) assert.equal(roundAt(roundTime(r)), r);
  assert.equal(roundTime(10, { genesis: 100, period: 30 }), 370, "another beacon's schedule");
  for (const bad of [0, -1, 1.5, "7", null, 2 ** 60]) assert.throws(() => roundTime(bad), beaconErr("bad_round"), String(bad));
});

test("normalizeBeacon: defaults to evmnet, takes the config's fields, refuses broken ones", () => {
  assert.equal(normalizeBeacon(undefined), EVMNET);
  assert.equal(normalizeBeacon(null), EVMNET);
  const b = normalizeBeacon({ registry: "0xabc", chainHash: "0x" + EVMNET.chainHash.toUpperCase(), genesis: EVMNET.genesis, period: 3, urls: ["https://api2.drand.sh/", "https://mirror.example/drand"] });
  assert.deepEqual([...b.urls], ["https://api2.drand.sh", "https://mirror.example/drand"], "trailing slashes trimmed, order kept");
  assert.equal(b.chainHash, EVMNET.chainHash, "0x and case normalised");
  assert.equal(b.registry, "0xabc");
  assert.ok(Object.isFrozen(b));
  assert.deepEqual([...normalizeBeacon({}).urls], [...EVMNET.urls], "an empty section is the defaults");
  for (const bad of [
    "evmnet", { urls: [] }, { urls: "https://api.drand.sh" }, { urls: ["http://api.drand.sh"] }, { urls: ["https://api.drand.sh?x=1"] },
    { genesis: 0 }, { genesis: "1727521075" }, { period: -3 }, { chainHash: "1234" },
  ]) assert.throws(() => normalizeBeacon(bad), TypeError, JSON.stringify(bad));
});

test("fetchRound: one GET to the first mirror, the exact v2 path, and a validated 0x signature", async () => {
  const m = mirrors();
  const sig = await fetchRound(REAL.round, { fetch: m.fetch });
  assert.equal(sig, REAL.signature, "the published signature, 0x-prefixed lowercase: 64 bytes");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, `https://api.drand.sh/v2/beacons/evmnet/rounds/${REAL.round}`);
  assert.equal(m.calls[0].init.headers.accept, "application/json");
  assert.ok(m.calls[0].init.signal instanceof AbortSignal, "every request can be cut off");
  assert.equal(await fetchRound(REAL.round, { fetch: m.fetch }), REAL.signature);
  assert.equal(m.calls.length, 1, "a published signature never changes: the second ask is served from memory");
});

test("fetchRound falls back mirror by mirror on network errors, HTTP errors, timeouts and bad answers", async () => {
  const cases = [
    [{ "api.drand.sh": "down" }, ["api.drand.sh", "api2.drand.sh"]],
    [{ "api.drand.sh": "500", "api2.drand.sh": "down" }, ["api.drand.sh", "api2.drand.sh", "api3.drand.sh"]],
    [{ "api.drand.sh": "hang" }, ["api.drand.sh", "api2.drand.sh"]],
    [{ "api.drand.sh": () => new Response(JSON.stringify({ round: REAL.round + 1, signature: "ab".repeat(64) })) }, ["api.drand.sh", "api2.drand.sh"]],
    [{ "api.drand.sh": () => new Response(JSON.stringify({ round: REAL.round, signature: "ab".repeat(63) })) }, ["api.drand.sh", "api2.drand.sh"]],
    [{ "api.drand.sh": () => new Response(JSON.stringify({ round: REAL.round, signature: "zz".repeat(64) })) }, ["api.drand.sh", "api2.drand.sh"]],
    [{ "api.drand.sh": () => new Response("<html>gateway</html>", { status: 200 }) }, ["api.drand.sh", "api2.drand.sh"]],
  ];
  for (const [hosts, asked] of cases) {
    clearSignatureCache();
    const m = mirrors({ hosts });
    assert.equal(await fetchRound(REAL.round, { fetch: m.fetch, timeoutMs: 20 }), REAL.signature, JSON.stringify(Object.keys(hosts)));
    assert.deepEqual(m.hosts(), asked);
  }
  // a mirror that sends "0x"-prefixed or upper-case hex, or the round as a string, is fine
  const m = mirrors({ hosts: { "api.drand.sh": () => new Response(JSON.stringify({ round: String(REAL.round), signature: REAL.signature.toUpperCase().replace("0X", "0x") })) } });
  clearSignatureCache();
  assert.equal(await fetchRound(REAL.round, { fetch: m.fetch }), REAL.signature);
});

test("fetchRound: a round that is not out is not_yet (one request), unless every mirror should be asked", async () => {
  const m = mirrors();
  const future = nowRound(m) + 10;
  await assert.rejects(fetchRound(future, { fetch: m.fetch }), beaconErr("not_yet", (e) => e.round === future && e.failures.length === 1));
  assert.deepEqual(m.hosts(), ["api.drand.sh"], "a 425 is believed: no need to triple the requests while waiting");
  m.calls.length = 0;
  await assert.rejects(fetchRound(future, { fetch: m.fetch, allMirrors: true }), beaconErr("not_yet"));
  assert.deepEqual(m.hosts(), ["api.drand.sh", "api2.drand.sh", "api3.drand.sh"]);
  // a lagging first mirror is skipped once every mirror is asked
  const lag = mirrors({ hosts: { "api.drand.sh": "lag" } });
  const past = nowRound(lag) - 5;
  await assert.rejects(fetchRound(past, { fetch: lag.fetch }), beaconErr("not_yet"));
  assert.match(await fetchRound(past, { fetch: lag.fetch, allMirrors: true }), /^0x[0-9a-f]{128}$/);
  // 404 (a mirror without the round, or without evmnet) counts as not out yet too
  const nf = mirrors({ hosts: { "api.drand.sh": () => new Response("no", { status: 404 }) } });
  await assert.rejects(fetchRound(REAL.round, { fetch: nf.fetch }), beaconErr("not_yet"));
});

test("fetchRound: every mirror failing is unavailable (or bad_response), with each failure kept", async () => {
  const m = mirrors({ hosts: { "api.drand.sh": "down", "api2.drand.sh": "500", "api3.drand.sh": "hang" } });
  await assert.rejects(fetchRound(REAL.round, { fetch: m.fetch, timeoutMs: 15 }), beaconErr("unavailable", (e) =>
    e.failures.length === 3 && e.failures.every((f) => f.code === "unavailable") && /Check your connection/.test(e.message) && /did not answer within 15 ms/.test(e.failures[2].message)));
  const bad = mirrors({ hosts: Object.fromEntries(EVMNET.urls.map((u) => [new URL(u).host, () => new Response(JSON.stringify({ round: 1, signature: "00" }))])) });
  await assert.rejects(fetchRound(REAL.round, { fetch: bad.fetch }), beaconErr("bad_response", (e) => e.failures.length === 3));
  await assert.rejects(fetchRound(REAL.round, { fetch: null }), beaconErr("unavailable"));
  await assert.rejects(fetchRound("nope", { fetch: m.fetch }), beaconErr("bad_round"));
});

test("fetchRound: an abort is an abort, before or during a request, never a fallback", async () => {
  const m = mirrors({ hosts: { "api.drand.sh": "hang" } });
  const ctl = new AbortController();
  const p = fetchRound(REAL.round, { fetch: m.fetch, signal: ctl.signal, timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  await assert.rejects(p, (e) => beaconErr("aborted")(e) && isAbort(e));
  assert.deepEqual(m.hosts(), ["api.drand.sh"], "no other mirror was asked after the abort");
  await assert.rejects(fetchRound(REAL.round, { fetch: m.fetch, signal: ctl.signal }), beaconErr("aborted"));
  assert.equal(m.calls.length, 1, "already aborted: nothing sent");
});

test("waitForSignature: asks at once, then every 4 s while the round is ahead, ticks every second, returns when it is out", async () => {
  const m = mirrors();
  const round = nowRound(m) + 5;                               // what buyPack binds a pack to: 13-15 s ahead
  const due = roundTime(round) * 1000;
  const ticks = [];
  const sig = await waitForSignature(round, { fetch: m.fetch, ...m.clock, onTick: (t) => ticks.push(t) });
  assert.match(sig, /^0x[0-9a-f]{128}$/);
  assert.ok(m.t >= due && m.t < due + 1000, "returned within a second of the round's time");
  const asks = m.calls.map((c) => Math.round((due - c.at) / 1000));
  assert.ok(asks.length >= 3 && asks.length <= 5, `a handful of requests, not one per second (asked at ${asks.join(", ")} s before due)`);
  assert.ok(asks.at(-1) <= 0, "the last ask is at the due time");
  assert.ok(new Set(m.hosts()).size === 1, "while early, only the first mirror is asked");
  const left = ticks.map((t) => t.secondsLeft);
  assert.deepEqual(left, [...left].sort((a, b) => b - a), "the countdown only goes down");
  assert.ok(left[0] >= 9 && left.at(-1) === 0, `counts down to zero (${left.join(" ")})`);
  assert.ok(ticks.every((t) => t.round === round));
  // the next wait for the same round costs nothing
  m.calls.length = 0;
  assert.equal(await waitForSignature(round, { fetch: m.fetch, ...m.clock }), sig);
  assert.equal(m.calls.length, 0);
});

test("waitForSignature copes with a wrong local clock: slow (still finds it) and fast (keeps polling past 'due')", async () => {
  // the player's clock runs 60 s slow: by it the round is a minute away, but drand already has it
  const real = mirrors();
  const round = nowRound(real) - 1;
  const slowClock = { now: () => real.t - 60_000, sleep: real.clock.sleep };
  const t0 = real.t;
  assert.match(await waitForSignature(round, { fetch: real.fetch, ...slowClock }), /^0x/);
  assert.equal(real.t, t0, "asked at once, no waiting for the local countdown");
  // the player's clock runs 20 s fast: by it the round is due, drand says 425 until real time catches up
  clearSignatureCache();
  const fast = mirrors();
  const r2 = nowRound(fast) + 4;
  const fastClock = { now: () => fast.t + 20_000, sleep: fast.clock.sleep };
  const sig = await waitForSignature(r2, { fetch: fast.fetch, ...fastClock, retryMs: 1000 });
  assert.match(sig, /^0x/);
  assert.ok(fast.t >= roundTime(r2) * 1000, "it arrived once the round was really out");
  assert.ok(fast.hosts().includes("api2.drand.sh"), "overdue by the local clock: every mirror was asked");
});

test("waitForSignature gives up graceMs after the round is due, with the last error", async () => {
  const m = mirrors({ hosts: { "api.drand.sh": "down", "api2.drand.sh": "down", "api3.drand.sh": "down" } });
  const round = nowRound(m) + 2;
  const due = roundTime(round) * 1000;
  await assert.rejects(waitForSignature(round, { fetch: m.fetch, ...m.clock, graceMs: 10_000 }), beaconErr("unavailable"));
  assert.ok(m.t >= due + 10_000 && m.t < due + 12_000, "about graceMs past due, not forever");
  const never = mirrors({ hosts: { "api.drand.sh": "lag", "api2.drand.sh": "lag", "api3.drand.sh": "lag" } });
  await assert.rejects(waitForSignature(nowRound(never) - 3, { fetch: never.fetch, ...never.clock, graceMs: 5_000 }), beaconErr("not_yet"));
  await assert.rejects(waitForSignature(0, { fetch: m.fetch, ...m.clock }), beaconErr("bad_round"));
});

test("waitForSignature can be cancelled while waiting, and a throwing onTick cannot derail it", async () => {
  const m = mirrors();
  const ctl = new AbortController();
  let n = 0;
  const sleep = async (ms, signal) => { if (++n === 3) ctl.abort(); return m.clock.sleep(ms, signal); };
  await assert.rejects(waitForSignature(nowRound(m) + 4, { fetch: m.fetch, now: m.clock.now, sleep, signal: ctl.signal }), (e) => beaconErr("aborted")(e) && isAbort(e));
  const c = captureConsole();
  try {
    const sig = await waitForSignature(nowRound(m) + 2, { fetch: m.fetch, ...m.clock, onTick() { throw new Error("UI bug"); } });
    assert.match(sig, /^0x/);
  } finally { c.restore(); }
  assert.ok(c.logs.some(([lvl, msg]) => lvl === "error" && /onTick callback threw/.test(msg)));
});

test("waitForSignatures returns every round's signature in order, a few requests at a time", async () => {
  const m = mirrors({ sig: (r) => (r % 256).toString(16).padStart(2, "0").repeat(64) });
  const base = nowRound(m) - 40;
  const rounds = Array.from({ length: 17 }, (_, i) => base + i * 2);
  let inFlight = 0, peak = 0;
  const f = async (url, init) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 2)); try { return await m.fetch(url, init); } finally { inFlight--; } };
  const sigs = await waitForSignatures(rounds, { fetch: f, ...m.clock });
  assert.deepEqual(sigs, rounds.map((r) => "0x" + (r % 256).toString(16).padStart(2, "0").repeat(64)));
  assert.ok(peak > 1 && peak <= 4, `bounded concurrency (peak ${peak})`);
  assert.deepEqual(await waitForSignatures([], { fetch: f, ...m.clock }), []);
});
