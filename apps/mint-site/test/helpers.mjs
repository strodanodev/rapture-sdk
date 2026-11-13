// Shared test fixtures: ethers (the independent oracle), the compiled PackShopV2 ABI, a mock EIP-1193 wallet, a mock
// EIP-6963 window, a fake Liteforge/PackShopV2 chain that speaks JSON-RPC over a fake fetch, and a fake drand evmnet
// beacon on the same virtual clock. Not a test file.
import { readFileSync } from "node:fs";
import * as ethers from "ethers";

export { ethers };

// ------------------------------------------------------------------ ABI (the compiled contracts are the source of truth)
// test/abi/ holds the ABIs of the mint package's build; its tests (test/site-abi.test.js) keep them equal to it.
const ABIS = new URL("./abi/", import.meta.url);
export const loadAbi = (rel) => JSON.parse(readFileSync(new URL(rel, ABIS), "utf8"));
export const shopIface = new ethers.Interface(loadAbi("PackShopV2.json"));
export const fixedIface = new ethers.Interface(loadAbi("FixedPriceMinter.json"));
/** The reference collection the minters mint into (StudioMinter, CardDesign, the ERC-721). */
export const otherIfaces = ["reference/StudioMinter.json", "reference/CardDesign.json", "reference/RaptureCards.json"].map((p) => new ethers.Interface(loadAbi(p)));

// ------------------------------------------------------------------ constants
export const q = (n) => "0x" + BigInt(n).toString(16);                       // JSON-RPC quantity
const addr = (h) => ethers.getAddress(h);
export const SHOP = addr("0x5fbdb2315678afecb367f032d93f642f64180aa3");      // checksummed on purpose: mixed case must work
export const ALICE = addr("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
export const BOB = addr("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
export const REGISTRY = addr("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
export const MINTER = addr("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0");   // the StudioMinter the fake shop mints through
export const RPC = "https://rpc.test.invalid/http";
export const ETH = 10n ** 18n;
/** drand evmnet as packshop.json names it. */
export const DRAND = Object.freeze({
  genesis: 1727521075, period: 3, chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
  urls: ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"],
});
/** The fake shop's deck: every Kind x Finish cell non-empty, 72 cards = 14 packs of 5 (+ 2 left over). */
export const TEST_DECK = Object.freeze([[20, 3, 1], [15, 2, 1], [10, 2, 1], [8, 1, 1], [5, 1, 1]].map((r) => Object.freeze(r)));
export const KIND_NAMES = ["Mortal", "King", "Demigod", "Titan", "God"];
/** A shop config as packConfig() returns it (plus a deck for the fake chain). */
export const FAUCET = "https://faucet.test.invalid";
export const cfgFor = (extra = {}) => ({
  network: "liteforge", chainId: 4441, chainName: "LitVM Liteforge", rpc: RPC, explorer: "https://explorer.test.invalid", faucet: FAUCET,
  currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 }, version: 2, packShop: SHOP, cards: BOB,
  beacon: { registry: REGISTRY, ...DRAND, urls: [...DRAND.urls] },
  deck: { kinds: KIND_NAMES, finishes: ["Normal", "Shiny", "Gold"], counts: TEST_DECK.map((r) => [...r]), total: 72 },
  templates: [], ...extra,
});

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Let every already-queued promise continuation run (microtasks only: no timer fires). */
export const flushMicrotasks = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
/** Record (and silence) console output for the duration of a test: const c = captureConsole(); try {...} finally { c.restore(); } */
export function captureConsole(methods = ["debug", "warn", "error"]) {
  const logs = [];
  const orig = {};
  for (const m of methods) { orig[m] = console[m]; console[m] = (...a) => logs.push([m, ...a]); }
  return { logs, restore() { for (const m of methods) console[m] = orig[m]; } };
}

// ------------------------------------------------------------------ errors in the two wire formats
/** What an EIP-1193 provider throws. */
export const providerError = (code, message, data) => Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
/** What a JSON-RPC node answers (converted to `{error}` by jsonRpcFetch). */
export const rpcError = (code, message, data) => Object.assign(new Error(message), { rpcError: { code, message, ...(data !== undefined ? { data } : {}) } });
export function revertData(name, args = []) {
  for (const i of [shopIface, fixedIface, ...otherIfaces]) {
    const f = i.getError(name);
    if (f) return i.encodeErrorResult(name, args);
  }
  throw new Error(`unknown error ${name}`);
}
export const revertRpcError = (name, args) => rpcError(3, "execution reverted", revertData(name, args));

// ------------------------------------------------------------------ fake fetch
/** A fetch that answers JSON-RPC via handler(method, params, body). handler may return a result, throw rpcError(...), or
 *  return a Response to take over the HTTP layer. Records every call in fetch.calls. */
export function jsonRpcFetch(handler) {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    f.calls.push({ url, init, body });
    const out = await handler(body.method, body.params, body, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: out }), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = [];
  const wrapped = async (url, init) => {
    try { return await f(url, init); }
    catch (e) {
      if (e?.rpcError) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: e.rpcError }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw e;
    }
  };
  wrapped.calls = f.calls;
  return wrapped;
}
/** A fetch that never answers until its AbortSignal fires (then rejects like the real one). */
export function hangingFetch() {
  const f = (url, init) => new Promise((_, reject) => {
    f.calls.push({ url, init });
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  f.calls = [];
  return f;
}

// ------------------------------------------------------------------ mock wallet (EIP-1193)
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), _map: m };
}

/**
 * A MetaMask-shaped provider. Knows chains `known` (unknown ones answer 4902 to a switch). `chain` (a fake chain) receives
 * eth_sendTransaction and answers eth_getBalance. p.once(method, behaviour) queues a one-shot: an Error is thrown,
 * a function is called with the params, anything else is returned.
 */
export function createMockProvider({ accounts = [ALICE], chainId = 4441, known = [1, 4441], chain = null, permitted = false } = {}) {
  const listeners = new Map();
  const queue = new Map();
  const p = {
    isMetaMask: true,
    calls: [],
    accounts,
    chainId,
    known: new Set(known),
    permitted,
    on(evt, fn) { (listeners.get(evt) ?? listeners.set(evt, new Set()).get(evt)).add(fn); return p; },
    removeListener(evt, fn) { listeners.get(evt)?.delete(fn); return p; },
    emit(evt, ...args) { for (const fn of [...(listeners.get(evt) ?? [])]) fn(...args); },
    listenerCount(evt) { return listeners.get(evt)?.size ?? 0; },
    once(method, behaviour) { (queue.get(method) ?? queue.set(method, []).get(method)).push(behaviour); },
    methods(name) { return p.calls.filter((c) => c.method === name); },
    async request({ method, params }) {
      p.calls.push({ method, params });
      const b = queue.get(method)?.shift();
      if (b !== undefined) {
        if (b instanceof Error) throw b;
        return typeof b === "function" ? b(params) : b;
      }
      switch (method) {
        case "eth_accounts": return p.permitted ? [...p.accounts] : [];
        case "eth_requestAccounts": p.permitted = true; return [...p.accounts];
        case "eth_chainId": return q(p.chainId);
        case "wallet_switchEthereumChain": {
          const id = parseInt(params[0].chainId, 16);
          if (!p.known.has(id)) throw providerError(4902, `Unrecognized chain ID "${params[0].chainId}". Try adding the chain using wallet_addEthereumChain first.`);
          p.chainId = id;
          p.emit("chainChanged", q(id));
          return null;
        }
        case "wallet_addEthereumChain": p.known.add(parseInt(params[0].chainId, 16)); return null;
        case "wallet_revokePermissions": p.permitted = false; return null;
        case "personal_sign": return "0x" + "ab".repeat(65);
        case "eth_getBalance": if (chain) return q(chain.balanceOf(params[0])); break;
        case "eth_sendTransaction": if (chain) return chain.sendTransaction(params[0]); break;
      }
      throw providerError(-32601, `The method ${method} does not exist / is not available`);
    },
  };
  return p;
}

/** A window-like EventTarget whose installed wallets answer eip6963:requestProvider, as real ones do. */
export function createMockWindow(wallets = [], ethereum) {
  const win = new EventTarget();
  win.addEventListener("eip6963:requestProvider", () => {
    for (const w of wallets) {
      win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: w.info, provider: w.provider }) }));
    }
  });
  if (ethereum) win.ethereum = ethereum;
  return win;
}
export const walletInfo = (name, rdns, uuid = `uuid-${rdns}`) => ({ uuid, name, icon: `data:image/svg+xml;base64,${name}`, rdns });

// ------------------------------------------------------------------ fake chain: PackShopV2 semantics over JSON-RPC
/** The fake beacon's signature for a round: 64 deterministic bytes (the real ones are BLS on BN254). */
export const sigFor = (round) => ethers.concat([ethers.id(`sig-a-${round}`), ethers.id(`sig-b-${round}`)]);
/** Error("Invalid signature"): what EvmnetRegistry reverts with for a bad proof. */
export const invalidSignatureData = () => "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Invalid signature"]).slice(2);
const GRACE = 7 * 86400;

/**
 * The fake keeps just enough PackShopV2 state (packs, the deck, drand proofs, FIFO dealing, finishes, daily limits,
 * shutdown) to drive the client end to end, encoding every answer and log with ethers (so the client's decoders are
 * checked against an independent encoder). Time is virtual: st.now (unix seconds) is block.timestamp AND the fake drand
 * beacon's clock; chain.advance(s) moves it. Knobs on `st`:
 *   st.cfg {price, packSize, dailyLimit, paused, locked, minter, templateCount}   st.shutdownAt   st.deck (remaining)
 *   st.balances   st.gasPrice   st.estimate(tx, result) -> bigint   st.receiptDelay (null polls)
 *   st.failNext = { name } | { outOfGas: true }   st.hooks[method] = (params) => result | undefined (override or throw)
 * chain.drand: a fetch for https://api*.drand.sh/v2/beacons/evmnet/rounds/N (425 until the round's time; .down = Set of
 * hosts that fail, .calls). The templates are 12, Kind i % 5.
 */
export function createFakeChain({ chainId = 4441, now = 1_790_000_000, deck = TEST_DECK } = {}) {
  const st = {
    chainId,
    now,
    l2Block: 100_000,
    gasPrice: 200_000_000n,
    balances: new Map(),
    cfg: { price: ETH / 10n, packSize: 5, dailyLimit: 3, paused: false, locked: true, minter: true, templateCount: 12 },
    shutdownAt: 0,
    deckInitial: deck.map((r) => [...r]),
    deck: deck.map((r) => [...r]),
    packs: new Map(),
    packsOf: new Map(),          // address -> every pack id it bought, oldest first (the contract's per-buyer index)
    bought: new Map(),           // address -> packs bought "today"
    nextPackId: 1n,
    nextToDeal: 1n,
    packsSold: 0,
    proven: new Map(),           // drand round -> randomness (the EvmnetRegistry)
    latestRound: 0n,             // the newest round ever proven here (buyPack binds past it)
    finishOf: new Map(),         // token id -> 1 | 2 | 3
    tokenCounter: 0n,
    logs: [],
    receipts: new Map(),
    polls: new Map(),
    receiptDelay: 0,
    txs: [],                     // every eth_sendTransaction the fake accepted
    calls: [],                   // every JSON-RPC request, in order
    hooks: {},
    estimate: (tx, result) => result.gas,
    failNext: null,
    simOverride: null,
  };
  const lc = (a) => String(a).toLowerCase();
  st.balances.set(lc(ALICE), 10n * ETH);
  const byKind = [0, 1, 2, 3, 4].map((k) => Array.from({ length: st.cfg.templateCount }, (_, i) => i).filter((i) => i % 5 === k));
  const ts = () => Math.floor(st.now);
  const currentRound = () => BigInt(Math.floor((ts() - DRAND.genesis) / DRAND.period) + 1);
  const roundTime = (round) => DRAND.genesis + (Number(round) - 1) * DRAND.period;
  const total = (d) => d.flat().reduce((a, b) => a + b, 0);
  const maxSupply = () => total(st.deckInitial);
  const packsTotal = () => Math.floor(maxSupply() / st.cfg.packSize);
  const ready = () => st.cfg.locked && !st.shutdownAt && st.packsSold < packsTotal() && st.cfg.minter;

  const leftFor = (from) => (st.cfg.dailyLimit === 0 ? Infinity : Math.max(0, st.cfg.dailyLimit - (st.bought.get(from) ?? 0)));
  function phaseOf(id) {
    const p = st.packs.get(id);
    if (!p) return 0;
    if (p.state === "opened") return 4;
    if (p.state === "refunded") return 5;
    if (p.state === "dealt") return 3;
    return ts() < roundTime(p.round) ? 1 : 2;
  }
  const event = (name, args) => ({ address: lc(SHOP), ...shopIface.encodeEventLog(shopIface.getEvent(name), args) });
  const Revert = (name, args = []) => Object.assign(new Error(name), { revert: name, args });

  function prove(rounds, sigs) {
    if (rounds.length !== sigs.length) throw Revert("BadProof");
    rounds.forEach((r, i) => {
      if (r > st.latestRound) st.latestRound = r;
      if (st.proven.has(r)) return;
      if (lc(ethers.hexlify(sigs[i])) !== lc(sigFor(r))) throw Revert("InvalidSignature");
      st.proven.set(r, ethers.sha256(sigs[i]));
    });
  }
  /** The contract's _draw: without replacement, each card a cell weighted by what is left, a template uniform in its Kind. */
  function draw(randomness, packId, buyer, count) {
    const seed = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address"], [randomness, packId, buyer]));
    const cells = st.deck.flat();
    let left = cells.reduce((a, b) => a + b, 0);
    const cards = [];
    for (let i = 0; i < count; i++) {
      const r = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [seed, i])));
      let x = Number(r % BigInt(left));
      let c = 0;
      while (x >= cells[c]) x -= cells[c++];
      cells[c]--; left--;
      const pool = byKind[Math.floor(c / 3)];
      cards.push({ templateId: pool[Number((r >> 128n) % BigInt(pool.length))], finish: (c % 3) + 1 });
    }
    st.deck = [0, 1, 2, 3, 4].map((k) => cells.slice(k * 3, k * 3 + 3));
    return cards;
  }
  /** Deal pack nextToDeal. A pack refunded while sealed is drawn all the same (its cards discarded, it stays Refunded),
   *  so a refund never changes a later pull. Unproven round: revert (strict) or false. */
  function dealNext(strict, logs) {
    const id = st.nextToDeal;
    const p = st.packs.get(id);
    const randomness = st.proven.get(p.round);
    if (!randomness) { if (strict) throw Revert("BeaconMissing", [p.round]); return false; }
    p.cards = draw(randomness, id, p.buyer, p.count);
    if (p.state === "sealed") p.state = "dealt";
    st.nextToDeal = id + 1n;
    logs.push(event("PackDealt", [id, p.round, p.cards.map((c) => c.templateId), p.cards.map((c) => c.finish)]));
    return true;
  }
  const snapshot = () => structuredClone({
    packs: st.packs, packsOf: st.packsOf, bought: st.bought, nextPackId: st.nextPackId, nextToDeal: st.nextToDeal, packsSold: st.packsSold,
    proven: st.proven, latestRound: st.latestRound, finishOf: st.finishOf, tokenCounter: st.tokenCounter, deck: st.deck, balances: st.balances,
  });

  /** Execute (commit) or dry-run one PackShopV2 call; a revert undoes everything, like the EVM. -> { revert, args } | { logs, gas } */
  function run(tx, commit) {
    const saved = snapshot();
    try {
      const r = exec(tx);
      if (!commit) Object.assign(st, saved);
      return r;
    } catch (e) {
      Object.assign(st, saved);
      if (e.revert) return { revert: e.revert, args: e.args };
      throw e;
    }
  }
  function exec(tx) {
    const from = lc(tx.from);
    const value = BigInt(tx.value ?? 0);
    const d = shopIface.parseTransaction({ data: tx.data, value });
    if (!d) throw new Error(`fake chain: cannot parse calldata ${tx.data}`);
    const logs = [];
    switch (d.name) {
      case "buyPack": {
        if (st.cfg.paused) throw Revert("EnforcedPause");
        if (!st.cfg.locked) throw Revert("NotLocked");
        if (st.shutdownAt) throw Revert("IsShutdown");
        if (st.packsSold >= packsTotal()) throw Revert("SoldOut");
        if (!st.cfg.minter) throw Revert("NotMinter");
        if (value !== st.cfg.price) throw Revert("WrongPayment");
        if (leftFor(from) <= 0) throw Revert("DailyLimitReached");
        const id = st.nextPackId++;
        const now = currentRound();
        const round = (st.latestRound > now ? st.latestRound : now) + 5n;   // past every round already public, by 5
        st.packs.set(id, { buyer: from, round, state: "sealed", count: st.cfg.packSize, paid: value, cards: [] });
        st.packsOf.set(from, [...(st.packsOf.get(from) ?? []), id]);
        st.bought.set(from, (st.bought.get(from) ?? 0) + 1);
        st.packsSold++;
        logs.push(event("PackBought", [id, from, value, round]));
        return { logs, gas: 180_000n };
      }
      case "openPack": {
        const [id, rounds, sigs] = d.args;
        prove([...rounds], [...sigs]);
        const p = st.packs.get(id);
        let dealt = 0;
        if (p?.state === "sealed") while (st.nextToDeal <= id) { dealNext(true, logs); dealt++; }
        if (!p || p.state !== "dealt") throw Revert("NotDealt");
        const tokenIds = p.cards.map((_, i) => (7n << 32n) + st.tokenCounter + BigInt(i));
        st.tokenCounter += BigInt(p.cards.length);
        p.tokenIds = tokenIds;
        tokenIds.forEach((t, i) => st.finishOf.set(t, p.cards[i].finish));
        p.state = "opened";
        logs.push(event("PackOpened", [id, p.buyer, tokenIds, p.cards.map((c) => c.templateId), p.cards.map((c) => c.finish)]));
        return { logs, gas: 4_500_000n + 251_000n * BigInt(rounds.length) + 42_000n * BigInt(dealt) };
      }
      case "deal": {
        const [max, rounds, sigs] = d.args;
        prove([...rounds], [...sigs]);
        let dealt = 0n;
        while (dealt < max && st.nextToDeal < st.nextPackId && dealNext(false, logs)) dealt++;
        return { logs, gas: 60_000n + 251_000n * BigInt(rounds.length) + 42_000n * dealt };
      }
      case "refund": {
        const [id] = d.args;
        const p = st.packs.get(id);
        if (!st.shutdownAt || !p || from !== p.buyer) throw Revert("NotRefundable");                       // the buyer only
        if (p.state === "sealed" ? st.proven.has(p.round) : p.state === "dealt" ? st.cfg.minter : true) throw Revert("NotRefundable");
        if (ts() < Math.max(roundTime(p.round), st.shutdownAt) + GRACE) throw Revert("NotRefundable");
        p.state = "refunded";
        st.balances.set(p.buyer, (st.balances.get(p.buyer) ?? 0n) + p.paid);
        logs.push(event("PackRefunded", [id, p.buyer, p.paid]));
        return { logs, gas: 90_000n };
      }
      default: throw new Error(`fake chain: unsupported call ${d.name}`);
    }
  }
  const revertWith = (r) => {
    if (r.revert === "InvalidSignature") throw rpcError(3, "execution reverted: Invalid signature", invalidSignatureData());
    throw revertRpcError(r.revert, r.args);
  };
  const simulate = (tx) => {
    if (st.simOverride && tx.data === st.simOverride.data) throw revertRpcError(st.simOverride.name, st.simOverride.args);
    const r = run(tx, false);
    if (r.revert) revertWith(r);
    return r;
  };

  function ethCall(tx) {
    if (lc(tx.to) === lc(MINTER)) {                                // the StudioMinter: only minters(address) is asked
      const sm = otherIfaces[0];
      const [who] = sm.decodeFunctionData("minters", tx.data);
      return sm.encodeFunctionResult("minters", [lc(who) === lc(SHOP) && st.cfg.minter]);
    }
    if (lc(tx.to) !== lc(SHOP)) return "0x";                       // no contract there
    const sel = String(tx.data).slice(0, 10);
    const f = shopIface.getFunction(sel);
    if (!f) throw new Error(`fake chain: unknown selector ${sel}`);
    const args = () => shopIface.decodeFunctionData(f.name, tx.data);
    const out = (vals) => shopIface.encodeFunctionResult(f.name, vals);
    switch (f.name) {
      case "config": {
        const c = st.cfg;
        return out([c.price, c.packSize, c.dailyLimit, c.paused, ready(), maxSupply(), packsTotal(), st.packsSold, total(st.deck), c.templateCount]);
      }
      case "phaseOf": return out([phaseOf(args()[0])]);
      case "packOf": {
        const id = args()[0];
        const p = st.packs.get(id);
        const cards = p && (p.state === "dealt" || p.state === "opened") ? p.cards : [];
        return out([p ? p.buyer : ethers.ZeroAddress, p ? p.round : 0n, phaseOf(id), p ? p.paid : 0n, cards.map((c) => c.templateId), cards.map((c) => c.finish)]);
      }
      case "pendingRounds": {                                  // the contract's view: distinct unproven rounds, oldest first
        let [upTo, max] = args();
        if (upTo >= st.nextPackId) upTo = st.nextPackId - 1n;
        const rounds = [];
        let last = 0n;
        for (let id = st.nextToDeal; id <= upTo && BigInt(rounds.length) < max; id++) {
          const p = st.packs.get(id);                          // every one of them is undealt, refunded or not
          if (p.round === last) continue;
          last = p.round;
          if (!st.proven.has(p.round)) rounds.push(p.round);
        }
        return out([rounds]);
      }
      case "packsLeftToday": {
        const left = leftFor(lc(args()[0]));
        return out([left === Infinity ? ethers.MaxUint256 : BigInt(left)]);
      }
      case "packCountOf": return out([BigInt((st.packsOf.get(lc(args()[0])) ?? []).length)]);
      case "recentPacks": {                                    // same semantics as the contract: n capped at 16, oldest first
        const [who, n0] = args();
        const all = st.packsOf.get(lc(who)) ?? [];
        const n = Math.min(Number(n0 < 16n ? n0 : 16n), all.length);
        const ids = all.slice(all.length - n);
        return out([ids, ids.map(phaseOf), ids.map((id) => st.packs.get(id).round)]);
      }
      case "finishOf": return out([st.finishOf.get(args()[0]) ?? 0]);
      case "tokensOf": { const p = st.packs.get(args()[0]); return out([p?.state === "opened" ? p.tokenIds : []]); }
      case "minter": return out([MINTER]);
      case "finishesOf": return out([[...args()[0]].map((t) => st.finishOf.get(t) ?? 0)]);
      case "deckRemaining": return out([st.deck]);
      case "deckInitial": return out([st.deckInitial]);
      case "shutdownAt": return out([BigInt(st.shutdownAt)]);
      case "currentRound": return out([currentRound()]);
      case "latestRound": return out([st.latestRound]);
      case "roundTime": return out([BigInt(roundTime(args()[0]))]);
      case "buyPack": case "openPack": case "deal": case "refund": {
        simulate(tx);
        return "0x";
      }
      default: throw new Error(`fake chain: unsupported eth_call ${f.name}`);
    }
  }

  /** eth_sendTransaction as the wallet would submit it. Returns the tx hash; the receipt is served by eth_getTransactionReceipt. */
  function sendTransaction(tx) {
    st.txs.push(tx);
    const hash = ethers.id(`tx-${st.txs.length}-${tx.data}`);
    const fail = st.failNext;
    st.failNext = null;
    st.l2Block += 1;
    let receipt;
    if (fail) {
      if (fail.name) st.simOverride = { data: tx.data, name: fail.name, args: fail.args };
      const limit = BigInt(tx.gas ?? 0);
      receipt = { status: "0x0", gasUsed: q(fail.outOfGas ? limit : 60_000n), logs: [] };
    } else {
      const r = run(tx, true);
      if (r.revert) throw new Error(`fake chain: ${r.revert} on send; use failNext to model a reverted receipt`);
      const value = BigInt(tx.value ?? 0);
      st.balances.set(lc(tx.from), (st.balances.get(lc(tx.from)) ?? 0n) - value);
      const logs = r.logs.map((l, i) => ({ ...l, blockNumber: q(st.l2Block), transactionHash: hash, logIndex: q(i) }));
      logs.forEach((l) => st.logs.push({ ...l, blockNumberNum: st.l2Block }));
      receipt = { status: "0x1", gasUsed: q(r.gas), logs };
    }
    st.receipts.set(hash, { transactionHash: hash, blockNumber: q(st.l2Block), from: lc(tx.from), to: lc(tx.to), ...receipt });
    return hash;
  }

  function rpc(method, params) {
    st.calls.push({ method, params });
    const h = st.hooks[method];
    if (h) { const r = h(params, st); if (r !== undefined) return r; }
    switch (method) {
      case "eth_chainId": return q(st.chainId);
      case "eth_blockNumber": return q(st.l2Block);
      case "eth_gasPrice": return q(st.gasPrice);
      case "eth_getBalance": return q(st.balances.get(lc(params[0])) ?? 0n);
      case "eth_call": return ethCall(params[0]);
      case "eth_estimateGas": {
        const r = simulate(params[0]);
        return q(st.estimate(params[0], r));
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0];
        const n = (st.polls.get(hash) ?? 0) + 1;
        st.polls.set(hash, n);
        if (n <= st.receiptDelay) return null;
        return st.receipts.get(hash) ?? null;
      }
      default: throw rpcError(-32601, `The method ${method} does not exist`);
    }
  }

  // the beacon: a round is out once the virtual clock reaches its time
  const drand = async (url, init) => {
    const u = new URL(String(url));
    drand.calls.push(String(url));
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (drand.down.has(u.host)) throw new TypeError("Failed to fetch");
    const m = /^\/v2\/beacons\/evmnet\/rounds\/(\d+)$/.exec(u.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const round = Number(m[1]);
    if (roundTime(round) > ts()) return new Response("Requested future beacon", { status: 425 });
    return new Response(JSON.stringify({ round, signature: sigFor(round).slice(2) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  drand.calls = [];
  drand.down = new Set();

  const fetch = jsonRpcFetch((method, params) => rpc(method, params));
  return {
    st,
    fetch,
    drand,
    rpc,
    sendTransaction,
    phaseOf,
    currentRound: () => Number(currentRound()),
    roundTime,
    balanceOf: (a) => st.balances.get(lc(a)) ?? 0n,
    setBalance: (a, v) => st.balances.set(lc(a), BigInt(v)),
    /** Move the virtual clock (block.timestamp and the beacon) forward. */
    advance(seconds) { st.now += seconds; st.l2Block += Math.max(1, Math.round(seconds * 4)); },
    /** Mark rounds proven on the registry directly (as if a keeper proved them in another transaction). */
    proveRound(round) { st.proven.set(BigInt(round), ethers.sha256(sigFor(round))); if (BigInt(round) > st.latestRound) st.latestRound = BigInt(round); },
    /** A keeper's deal(max) with every pending round proven: fixes packs' cards without minting them. */
    keeperDeal(max = 1000) { const logs = []; let n = 0; while (n < max && st.nextToDeal < st.nextPackId) { this.proveRound(st.packs.get(st.nextToDeal).round); dealNext(true, logs); n++; } return logs; },
    /** A keeper opening someone's pack (all its rounds proven): what a buyer finds afterwards is an Opened pack. */
    keeperOpen(id) { this.keeperDeal(); return run({ from: BOB, to: SHOP, data: shopIface.encodeFunctionData("openPack", [BigInt(id), [], []]) }, true); },
    methods: (name) => st.calls.filter((c) => c.method === name),
  };
}

/** The chain object createWallet() wants, from a shop config (what lib/config.js walletChain does for a site config). */
export function chainFromConfig(cfg) {
  const chain = { chainId: cfg.chainId, name: cfg.chainName || `Chain ${cfg.chainId}`, nativeCurrency: cfg.currency, rpcUrls: [cfg.rpc] };
  if (cfg.explorer) chain.explorer = cfg.explorer;
  if (cfg.faucet) chain.faucet = cfg.faucet;
  return chain;
}
