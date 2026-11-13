/**
 * Wallet seating, through the TCG kit's wallet and holdings layer (src/vendor/tcg, copied from packages/tcg/web/lib):
 * connect a Liteforge wallet, read which tokens of the configured collection it holds, and seat them on the board
 * first. Nothing here signs or sends; holdings are read through the collection's own RPC, never the wallet.
 * Generalised from Rapture Chess (src/web3/wallet.ts, src/roster.ts).
 */
import { createWallet, LITEFORGE } from '../vendor/tcg/wallet.js';
import { createHoldings } from '../vendor/tcg/holdings.js';
import type { CollectionConfig } from './config';

/** LitVM Liteforge (chain 4441) public RPC. The old Caldera endpoints are dead and must not come back. */
export const LITEFORGE_RPC = 'https://rpc.testnet.liteforge.zeeve.net/';

/** A token of the collection, as a snapshot names it (or just its id). */
export interface Token { tokenId: string; name?: string; [k: string]: unknown }

export interface Web3Link {
  /** The configured collection, or null: then connecting does nothing but show the address. */
  collection: CollectionConfig | null;
  /** Token ids the connected wallet holds; empty until connected. */
  owned: Set<string>;
  /** The snapshot's tokens (collection.cards), or the owned ids alone. */
  tokens: Token[];
  address(): string | null;
  shortAddress(): string;
  onChange(fn: () => void): void;
  toggle(): Promise<void>;
  restore(): Promise<void>;
}

export function createWeb3Link(collection: CollectionConfig | null): Web3Link {
  const rpc = collection?.rpc || LITEFORGE_RPC;
  // (the vendored JS infers literal option types; the options are the documented ones)
  const wallet = createWallet({ chain: { ...LITEFORGE, rpcUrls: [rpc], ...(collection?.explorer ? { explorer: collection.explorer } : {}) } } as never);
  const listeners: Array<() => void> = [];
  let snapshot: Token[] = [];
  const holdings = collection && /^0x[0-9a-fA-F]{40}$/.test(collection.address)
    ? createHoldings({ collection: { name: collection.name, address: collection.address, chainId: collection.chainId, rpc, explorer: collection.explorer, setId: collection.setId ?? 1, cards: [] } } as never)
    : null;

  const link: Web3Link = {
    collection,
    owned: new Set(),
    get tokens() { return snapshot.length ? snapshot : [...link.owned].map((tokenId) => ({ tokenId })); },
    address: () => wallet.snapshot().address,
    shortAddress() { const a = wallet.snapshot().address; return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''; },
    onChange: (fn) => { listeners.push(fn); },
    async toggle() {
      if (wallet.snapshot().address) await wallet.disconnect();
      else { await wallet.connect(); await wallet.ensureChain().catch(() => {}); }
    },
    async restore() { await wallet.restore?.().catch(() => null); },
  };

  if (collection?.cards) {
    fetch(`${import.meta.env.BASE_URL}${collection.cards.replace(/^\/+/, '')}`).then((r) => r.json())
      .then((j: { cards?: Token[] }) => { snapshot = (j.cards ?? []).map((c) => ({ ...c, tokenId: String(c.tokenId) })); for (const fn of listeners) fn(); })
      .catch((e) => console.warn('[board] collection snapshot failed', e));
  }

  let gen = 0;
  async function refresh(): Promise<void> {
    const my = ++gen;
    const { address } = wallet.snapshot();
    let owned = new Set<string>();
    if (address && holdings) {
      try { owned = new Set((await holdings.read(address)).tokens.map(String)); } catch (e) { console.warn('[board] could not read holdings', e); }
    }
    if (my !== gen) return;
    link.owned = owned;
    for (const fn of listeners) fn();
  }
  wallet.subscribe(() => { void refresh(); });
  return link;
}

/** A seeded generator (xorshift over a string hash): the same seed seats the same tokens on every screen. */
function seeded(seed: string): () => number {
  let s = 2166136261;
  for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 16777619) >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const shuffled = <T>(items: T[], rnd: () => number): T[] => {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

/**
 * Deal tokens onto squares (in the order given: most important piece first). Owned tokens lead, the rest follow, each
 * group in a seeded order so boards vary between matches but agree between players. Cosmetic: the rules never see it.
 */
export function seatTokens(squares: number[], tokens: Token[], owned: Set<string>, seed: string): Map<number, Token> {
  const rnd = seeded(seed);
  const order = [...shuffled(tokens.filter((t) => owned.has(t.tokenId)), rnd), ...shuffled(tokens.filter((t) => !owned.has(t.tokenId)), rnd)];
  const out = new Map<number, Token>();
  squares.forEach((sq, i) => { if (order[i]) out.set(sq, order[i]); });
  return out;
}
