// Shared test fixtures: ethers (the independent oracle), the compiled ABIs, a mock EIP-1193 wallet, a mock EIP-6963
// window and a fake JSON-RPC fetch. The pack module's own (a fake PackShopV2 chain, a fake drand beacon) are in
// test/packs/helpers-packs.mjs. Not a test file.
import { readFileSync } from "node:fs";
import * as ethers from "ethers";

export { ethers };

// ------------------------------------------------------------------ ABI (the compiled contracts are the source of truth)
// test/abi/ holds the ABIs of the mint package's build; its tests (test/site-abi.test.js) keep them equal to it.
const ABIS = new URL("./abi/", import.meta.url);
export const loadAbi = (rel) => JSON.parse(readFileSync(new URL(rel, ABIS), "utf8"));
export const fixedIface = new ethers.Interface(loadAbi("FixedPriceMinter.json"));
/** The reference collection the minters mint into (StudioMinter, CardDesign, the ERC-721). */
export const otherIfaces = ["reference/StudioMinter.json", "reference/CardDesign.json", "reference/RaptureCards.json"].map((p) => new ethers.Interface(loadAbi(p)));

// ------------------------------------------------------------------ constants
export const q = (n) => "0x" + BigInt(n).toString(16);                       // JSON-RPC quantity
const addr = (h) => ethers.getAddress(h);
export const SHOP = addr("0x5fbdb2315678afecb367f032d93f642f64180aa3");      // checksummed on purpose: mixed case must work
export const ALICE = addr("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
export const BOB = addr("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
export const RPC = "https://rpc.test.invalid/http";
export const ETH = 10n ** 18n;
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
/** Interfaces revertData looks errors up in; the pack helpers add PackShopV2's. */
export const errorIfaces = [fixedIface, ...otherIfaces];
export function revertData(name, args = []) {
  for (const i of errorIfaces) {
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
