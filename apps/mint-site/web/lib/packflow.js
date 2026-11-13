// Mint site — buying and opening a PackShopV2 pack, as the pack page sees it (forge-site's v2 shop flow, minus its 3D
// hall). Nothing here draws anything.
//
// buy() binds the pack to a drand round 13-15 s ahead (PackBought says which). waitOpenable() waits for drand to
// publish it. open() proves whatever rounds are still pending ahead of the pack (its own, plus those of earlier packs
// nobody has dealt yet: packs are dealt strictly in purchase order), then mints. When the backlog is too big for one
// transaction (pendingRounds comes back full, or the open's gas estimate is over its cap), it is dealt first in
// chunks with deal(), and the pack opened with no proofs. Opening is permissionless, so a keeper may have dealt or even
// opened the pack first: a Dealt pack opens with no proofs, and an Opened one is read back and revealed as it is.
import { WalletError } from "./wallet.js";
import { DEAL_PACKS, DEAL_ROUNDS, MAX_PROOFS, PHASE, buyPack, dealPacks, openPack, pendingRounds, phaseError, readPack, readTokens } from "./packshop.js";
import { waitForSignature, waitForSignatures } from "./drand.js";
import { sleep } from "./chain.js";

const NONE_GRACE = 4, NONE_RETRY_MS = 1500;   // right after a purchase a load-balanced RPC node may not know the pack yet
const MAX_DEAL_TXS = 30;

export const BUY_TEXT = { signing: "Confirm the purchase in your wallet…", pending: "Purchase sent. Waiting for the chain to confirm it…", confirmed: "Purchase confirmed. The pack is sealed." };
export const OPEN_TEXT = { signing: "Confirm the second transaction in your wallet to open the pack…", pending: "Opening: minting your cards on chain…", confirmed: "Minted! The cards are in your wallet." };
const DEAL_TEXT = {
  signing: "Older packs ahead of yours are still sealed. Confirm an extra transaction to deal them first (no money moves)…",
  pending: "Dealing the older packs on chain…",
  confirmed: "Dealt. Now your own pack.",
};
/** An open that failed for its size, not for the pack: the backlog ahead of it must be dealt first. */
const tooBig = (e) => e?.code === "too_much_gas"
  || (e?.code === "reverted" && e.reason == null && !e.txHash)
  || (e?.code === "rpc" && /gas/i.test(`${e.detail ?? ""} ${e.message ?? ""}`));
/** The pack was opened by someone else between our read and our transaction. */
const lostRace = (e) => e?.code === "pack_opened" || e?.reason === "NotDealt";

/**
 * createPackFlow(wallet, cfg, { now, sleep }) -> { buy, waitOpenable, open }. cfg: packshop.js packConfig(site).
 * The clock hooks let tests run the drand wait on virtual time.
 */
export function createPackFlow(wallet, cfg, clock = {}) {
  const pause = clock.sleep ?? sleep;
  const drandOpts = (signal) => ({ beacon: cfg.beacon, signal, ...(clock.now ? { now: clock.now } : {}), ...(clock.sleep ? { sleep: clock.sleep } : {}) });

  async function settledPack(packId) {
    for (let i = 0; ; i++) {
      const p = await readPack(cfg, packId);
      if (p.phase !== PHASE.None || i >= NONE_GRACE) {
        if (p.phase === PHASE.None || p.phase === PHASE.Refunded) throw phaseError(p.phase);
        return p;
      }
      await pause(NONE_RETRY_MS);
    }
  }

  async function dealUpTo(packId, signal, say) {
    for (let i = 0; i < MAX_DEAL_TXS; i++) {
      const p = await readPack(cfg, packId);
      if (p.phase !== PHASE.Waiting && p.phase !== PHASE.Ready) return p;
      const rounds = await pendingRounds(cfg, packId, DEAL_ROUNDS);
      if (rounds.length) say("Older packs ahead of yours are still sealed. Fetching their drand rounds…");
      const sigs = await waitForSignatures(rounds, drandOpts(signal));
      await dealPacks(wallet, cfg, DEAL_PACKS, rounds, sigs, { onStage: (s) => say(DEAL_TEXT[s]) });
    }
    throw new WalletError("rpc", "Too many older packs are still sealed ahead of yours to deal them all now. Your pack is safe: try again in a few minutes.");
  }

  return {
    /** Connect if needed (in the click that asked), then buy one pack. Resolves { packId, round, txHash }. */
    async buy({ onStage } = {}) {
      if (!wallet.connected) await wallet.connect();
      return buyPack(wallet, cfg, { onStage: (s) => onStage?.(BUY_TEXT[s] ?? "") });
    },

    /** Resolve once drand has published the pack's round. onTick({ secondsLeft }) drives a countdown. A pack a keeper
     *  already dealt or opened needs no signature, so a drand outage does not block it. */
    async waitOpenable({ packId, round }, { onTick, signal } = {}) {
      try { await waitForSignature(round, { ...drandOpts(signal), onTick }); }
      catch (e) {
        if (e?.code === "aborted") throw e;
        const p = await readPack(cfg, packId).catch(() => null);
        if (p?.phase !== PHASE.Dealt && p?.phase !== PHASE.Opened) throw e;
      }
    },

    /** Open the pack (the second transaction). Resolves { tokenIds, templateIds, finishes, txHash, openedElsewhere }. */
    async open(packId, { onStage, signal } = {}) {
      const say = (text) => { if (text) onStage?.(text); };
      const openedFor = async (p) => {
        say("This pack was opened for you on chain already. Its cards are in your wallet.");
        const tokens = await readTokens(cfg, packId).catch(() => null);
        return { tokenIds: tokens?.length === p.templateIds.length ? tokens : [], templateIds: p.templateIds, finishes: p.finishes, txHash: null, openedElsewhere: true };
      };
      let pack = await settledPack(packId);
      if (pack.phase === PHASE.Opened) return openedFor(pack);
      const tryOpen = async (rounds, signatures, backlog) => {
        try { return await openPack(wallet, cfg, packId, { rounds, signatures, onStage: (s) => say(OPEN_TEXT[s]) }); }
        catch (e) {
          if (lostRace(e)) {
            const p = await readPack(cfg, packId).catch(() => null);
            if (p?.phase === PHASE.Opened) return { openedBy: p };
          }
          if (tooBig(e) && backlog) return null;
          throw e;
        }
      };
      let r = null;
      const rounds = pack.phase === PHASE.Dealt ? [] : await pendingRounds(cfg, packId, MAX_PROOFS);
      if (rounds.length < MAX_PROOFS) {
        if (rounds.length) say(rounds.length > 1 ? `Fetching ${rounds.length} drand signatures (yours and older packs')…` : `Fetching drand round ${rounds[0]}…`);
        r = await tryOpen(rounds, await waitForSignatures(rounds, drandOpts(signal)), pack.phase !== PHASE.Dealt);
      }
      if (!r) {
        pack = await dealUpTo(packId, signal, say);
        r = pack.phase === PHASE.Opened ? { openedBy: pack } : await tryOpen([], [], false);
      }
      if (r.openedBy) return openedFor(r.openedBy);
      return { ...r, openedElsewhere: false };
    },
  };
}
