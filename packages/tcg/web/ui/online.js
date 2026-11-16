// Online play on the LitNode mesh: the ranked queue, this browser's player key and the wallet it plays for, the
// ladder, and the last ranked match (kept for the stakes claim). The screens in ui/screens/online.js and the stakes
// panel in ui/stakes.js only draw this state; app.js seats the match once the mesh places it.
//
// Optional, in index.html:
//   <meta name="tessaract-wager" content="0x…">            the LitNodeWager escrow for this ruleset (no meta: no stakes)
//   <meta name="tessaract-litnode" content="https://…">    a node to read the ladder from first (the mesh is the fallback)
//
// The last placed match (its id, its host, this player's ledger signature) is kept in localStorage for the claim.
import { canHoldKey, findRanked, meshNode, playerKey, playerKeyId } from "../lib/litnode/ranked.js";
import { readLadder } from "../lib/litnode/ladder.js";
import { encodeBindKey, encodeRegister, ownerOfKey, profileOf, nameOf, keyName, PLAYER_PROFILE } from "../lib/litnode/profile.js";
import { isLitId } from "../lib/wager.js";

const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content?.trim() ?? "";

export function createOnline({ game, chain, wallet }) {
  const rulesetId = game.litnode.rulesetId;
  const LAST = `tessaract.ranked.last.${rulesetId}`;
  const wager = /^0x[0-9a-fA-F]{40}$/.test(meta("tessaract-wager")) ? meta("tessaract-wager") : null;
  const node = /^https:\/\/[^\s/]+/.test(meta("tessaract-litnode")) ? meta("tessaract-litnode").replace(/\/+$/, "") : null;
  const listeners = new Set();
  const state = {
    searching: false, status: "", error: false,
    key: playerKeyId(),
    /** null until read; { owner, active, name, mine } once read (owner null: the key is bound to no wallet) */
    binding: null,
    last: recall(),
  };
  let abort = null;
  const emit = () => { for (const fn of listeners) fn(state); };
  const say = (status, error = false) => { state.status = status; state.error = error; emit(); };

  function recall() {
    try {
      const v = JSON.parse(localStorage.getItem(LAST) ?? "null");
      return v && isLitId(v.matchId) && typeof v.hostUrl === "string" ? v : null;
    } catch { return null; }
  }
  function remember(v) {
    state.last = v;
    try { if (v) localStorage.setItem(LAST, JSON.stringify(v)); else localStorage.removeItem(LAST); } catch { /* private mode */ }
    emit();
  }

  async function readBinding() {
    if (!canHoldKey()) return;
    try {
      const kp = await playerKey();
      state.key = kp.publicKey;
      const o = await ownerOfKey(chain, kp.publicKey);
      const name = o.owner && o.tokenId ? await nameOf(chain, o.tokenId).catch(() => "") : "";
      const address = wallet.snapshot().address;
      state.binding = { owner: o.owner, active: o.active, name, mine: !!address && !!o.owner && o.owner.toLowerCase() === address.toLowerCase() };
    } catch (e) {
      console.warn("[ranked] could not read the key's profile", e);
    }
    emit();
  }

  async function send(data) {
    await wallet.ensureChain();
    const hash = await wallet.sendTransaction({ to: PLAYER_PROFILE, data });
    say("Sent. Waiting for the chain…");
    const rc = await chain.waitForReceipt(hash);
    if (Number(rc.status) !== 1) throw new Error("The transaction reverted");
  }

  wallet.subscribe(() => { void readBinding(); });

  return {
    rulesetId, title: game.title, wager, chain,
    /** False on a page that can't hold an ed25519 key (plain http from a network address, an old browser). */
    canQueue: canHoldKey(),
    state, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    key: () => state.key ?? playerKeyId(),
    readBinding,
    /**
     * Bind this browser's key to the connected wallet's LitNode profile, minting the profile first (with `name`) when
     * the wallet has none. The relay then checks the champion and the deck against this wallet.
     */
    async bind(name) {
      const address = wallet.snapshot().address;
      if (!address) throw new Error("Connect your wallet first");
      const kp = await playerKey();
      const has = await profileOf(chain, address);
      say(has ? "Binding this device to your profile…" : "Creating your profile…");
      await send(has ? encodeBindKey(kp.publicKey) : encodeRegister(kp.publicKey, name));
      say("This device now plays for your wallet.");
      await readBinding();
    },
    /** Queue; resolves the placement, or null when cancelled or nobody came in five minutes. */
    async queue() {
      if (state.searching) return null;
      abort = new AbortController();
      state.searching = true;
      say("Joining the queue…");
      try {
        // the ledger signature arrives at the match's end: kept with the match, for a claim the loser never signed
        const onLedger = (matchId, sig) => { if (state.last?.matchId === matchId) remember({ ...state.last, signatures: { ...state.last.signatures, [state.key]: sig } }); };
        const p = await findRanked({ chain, rulesetId, title: game.title, signal: abort.signal, say: (t) => say(t), onLedger });
        if (!p) { say(abort.signal.aborted ? "Search cancelled." : "Nobody else is queued right now. Try again in a while.", !abort.signal.aborted); return null; }
        state.key = p.me;
        remember({ matchId: p.matchId, hostUrl: p.hostUrl, at: Date.now(), signatures: {} });
        say("Opponent found. Taking your seat…");
        return p;
      } catch (e) {
        say(e?.message ?? String(e), true);
        return null;
      } finally {
        state.searching = false;
        abort = null;
        emit();
      }
    },
    cancel() { abort?.abort(); },
    say,
    forgetMatch() { remember(null); },
    ladder: (fresh = false) => readLadder({ chain, rulesetId, fresh, hints: [state.last?.hostUrl, node, meshNode()].filter(Boolean) }),
    keyName: (k) => keyName(chain, k),
  };
}
