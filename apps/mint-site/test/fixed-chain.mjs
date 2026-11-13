// A fake chain with a FixedPriceMinter, its collection minter and the collection (a non-enumerable ERC-721 with
// set-based ids, like the reference collection), speaking JSON-RPC over a fake fetch. Every result and log is encoded
// by ethers from the compiled ABIs, so the client's decoders are checked against an independent encoder. Not a test.
import { ethers, fixedIface, q, ETH, ALICE } from "./helpers.mjs";

export const MINTER = ethers.getAddress("0x00000000000000000000000000000000000f1ed1");   // the FixedPriceMinter
export const NFT = ethers.getAddress("0x00000000000000000000000000000000000c0de1");      // the ERC-721
export const STUDIO = ethers.getAddress("0x00000000000000000000000000000000000057d1");   // the collection minter
export const DESIGNS = ethers.getAddress("0x00000000000000000000000000000000000de511");  // design records
export const BASE = 1n << 32n;                                                            // tokenIdBase (set 1)

const nftIface = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function minters(address) view returns (bool)",
  "function designOf(uint256) view returns (tuple(bytes32 designHash, bytes32 art, bytes32 turntable, bytes32 overridesHash, bytes32 avatar, bytes32 avatarPlain, bytes32 soul, uint8 kit, string name, string epithet))",
]);
const revert = (iface, name, args = []) => Object.assign(new Error("execution reverted"), { rpcError: { code: 3, message: "execution reverted", data: iface.encodeErrorResult(name, args) } });

export function createFixedChain({ editions = [[5, 0], [3, 3], [10, 0]], price = ETH / 100n, maxPerWallet = 0, enumerable = false } = {}) {
  const st = {
    chainId: 4441, gasPrice: 200_000_000n, price, maxPerWallet, paused: false, ready: true, locked: true,
    editions: editions.map(([max, minted]) => ({ max, minted, retired: false })),
    mintedBy: new Map(), owners: new Map(), templateOf: new Map(), designOf: new Map(), supply: 0n,
    balances: new Map([[ALICE.toLowerCase(), 10n * ETH]]), receipts: new Map(), txs: [], calls: [], enumerable,
    designHashes: editions.map((_, i) => ethers.id(`design-${i}`)),
  };
  const lc = (a) => String(a).toLowerCase();
  /** Mint `n` tokens of template t to `to` (also used to seed the chain). */
  function mintTo(to, t, n) {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = BASE + st.supply++;
      st.owners.set(id, lc(to));
      st.templateOf.set(id, t + 1);
      st.designOf.set(id, st.designHashes[t]);
      ids.push(id);
    }
    return ids;
  }
  const tokensOf = (who) => [...st.owners].filter(([, o]) => o === lc(who)).map(([id]) => id);

  function call(tx) {
    const to = lc(tx.to);
    if (to === lc(MINTER)) {
      const p = fixedIface.parseTransaction({ data: tx.data });
      const enc = (v) => fixedIface.encodeFunctionResult(p.name, v);
      switch (p.name) {
        case "config": {
          const cap = st.editions.reduce((a, e) => a + (e.retired ? 0 : e.max), 0);
          const minted = st.editions.reduce((a, e) => a + e.minted, 0);
          return enc([st.price, st.maxPerWallet, st.paused, st.ready, st.locked, st.editions.length, minted, cap]);
        }
        case "editionsOf": {
          const from = Number(p.args[0]), n = Math.min(Number(p.args[1]), 256, Math.max(0, st.editions.length - from));
          const page = st.editions.slice(from, from + n);
          return enc([page.map((e) => e.max), page.map((e) => e.minted), page.map((e) => e.retired)]);
        }
        case "templatesOf": return enc([p.args[0].map((id) => BigInt(st.templateOf.get(id) ?? 0))]);
        case "mintableBy": {
          if (!st.maxPerWallet) return enc([ethers.MaxUint256]);
          return enc([BigInt(Math.max(0, st.maxPerWallet - (st.mintedBy.get(lc(p.args[0])) ?? 0)))]);
        }
        case "mint": return mintCheck(tx, p) ?? enc([[]]);
        default: throw new Error(`fake minter: ${p.name} not implemented`);
      }
    }
    if (to === lc(NFT) || to === lc(STUDIO) || to === lc(DESIGNS)) {
      const p = nftIface.parseTransaction({ data: tx.data });
      const enc = (v) => nftIface.encodeFunctionResult(p.name, v);
      switch (p.name) {
        case "balanceOf": return enc([BigInt(tokensOf(p.args[0]).length)]);
        case "ownerOf": { const o = st.owners.get(p.args[0]); if (!o) throw revert(new ethers.Interface(["error ERC721NonexistentToken(uint256)"]), "ERC721NonexistentToken", [p.args[0]]); return enc([o]); }
        case "totalSupply": return enc([st.supply]);
        case "supportsInterface": return enc([st.enumerable && p.args[0] === "0x780e9d63"]);
        case "tokenOfOwnerByIndex": return enc([tokensOf(p.args[0])[Number(p.args[1])]]);
        case "minters": return enc([st.ready]);
        case "designOf": {
          const h = st.designOf.get(p.args[0]) ?? ethers.ZeroHash;
          return enc([[h, h, ethers.ZeroHash, ethers.ZeroHash, h, h, h, 0, "Name", "Epithet"]]);
        }
        default: throw new Error(`fake nft: ${p.name} not implemented`);
      }
    }
    return "0x";
  }
  /** The contract's checks for mint(templateId, quantity), as reverts. */
  function mintCheck(tx, p) {
    const [t, n] = p.args.map(Number);
    const e = st.editions[t];
    if (st.paused) throw revert(fixedIface, "EnforcedPause");
    if (n < 1 || n > 10) throw revert(fixedIface, "BadQuantity");
    if (BigInt(tx.value ?? 0) !== st.price * BigInt(n)) throw revert(fixedIface, "WrongPayment");
    if (st.maxPerWallet && (st.mintedBy.get(lc(tx.from)) ?? 0) + n > st.maxPerWallet) throw revert(fixedIface, "WalletLimitReached");
    if (!e || e.retired) throw revert(fixedIface, "UnknownTemplate");
    if (e.minted + n > e.max) throw revert(fixedIface, "SoldOut");
    return null;
  }

  async function handle(method, params) {
    st.calls.push(method);
    switch (method) {
      case "eth_chainId": return q(st.chainId);
      case "eth_gasPrice": return q(st.gasPrice);
      case "eth_maxPriorityFeePerGas": return "0x0";
      case "eth_getBalance": return q(st.balances.get(lc(params[0])) ?? 0n);
      case "eth_call": return call(params[0]);
      case "eth_estimateGas": call(params[0]); return q(1_200_000);
      case "eth_getTransactionReceipt": return st.receipts.get(params[0]) ?? null;
      default: throw new Error(`fake chain: ${method} not implemented`);
    }
  }
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    try {
      const result = await handle(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    } catch (e) {
      if (!e.rpcError) throw e;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: e.rpcError }), { status: 200 });
    }
  };

  return {
    st, fetch, mintTo,
    balanceOf: (a) => st.balances.get(lc(a)) ?? 0n,
    /** What the mock wallet's eth_sendTransaction does: run mint(), record a receipt with the Minted log. */
    sendTransaction(tx) {
      st.txs.push(tx);
      const p = fixedIface.parseTransaction({ data: tx.data });
      const hash = ethers.id(`tx-${st.txs.length}`);
      mintCheck(tx, p);
      const [t, n] = p.args.map(Number);
      st.editions[t].minted += n;
      st.mintedBy.set(lc(tx.from), (st.mintedBy.get(lc(tx.from)) ?? 0) + n);
      const ids = mintTo(tx.from, t, n);
      const log = fixedIface.encodeEventLog("Minted", [tx.from, tx.from, t, ids, BigInt(tx.value)]);
      st.receipts.set(hash, { transactionHash: hash, status: "0x1", blockNumber: "0x10", gasUsed: q(900_000 * n), logs: [{ address: MINTER, topics: log.topics, data: log.data }] });
      return hash;
    },
  };
}

/** A site config for the fake chain. */
export const siteFor = (mint = {}) => ({
  name: "Test", chain: { id: 4441, name: "LitVM Liteforge", rpc: "https://rpc.test.invalid/http", explorer: null, faucet: null, currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 } },
  mint: { mode: "fixed", address: MINTER, collection: NFT, tokenIdBase: BASE.toString(), designRecords: null, ...mint },
  kinds: ["A", "B", "C", "D", "E"], finishes: ["Normal", "Shiny", "Gold"],
  cards: [0, 1, 2].map((id) => ({ id, name: `Card ${id}`, kind: id, designHash: ethers.id(`design-${id}`) })),
});
