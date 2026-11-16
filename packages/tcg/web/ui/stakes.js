// The stakes panel (Rapture Chess's src/wager/index.ts): put zkLTC at stake under this browser's LitNode player key
// (escrow `stake`), play ranked, then claim a settled match with the host node's own signed delta (`claim`). Every
// transaction goes through the game's wallet; every dynamic string goes through textContent.
import { h, icon } from "./dom.js";
import {
  claimProblem, deltaClaimBytes, deltaWinner, encodeClaim, encodeClaimWithWinner, encodeRequestUnstake, encodeStake, encodeUnstake, encodeWithdraw,
  formatZkLtc, parseZkLtc, readClaimed, readPending, readRulesetId, readStake, readUnstakeDelay, readWalletOf, winnerSignature,
} from "../lib/wager.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a ?? "");
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Returns { el, refresh() }. Draws nothing interactive when the build names no escrow. */
export function stakesPanel(app, wallet) {
  const online = app.online, chain = online.chain, contract = online.wager;
  const note = h("p", { class: "hint stakes-note", aria: { live: "polite" } });
  const body = h("div", { class: "stack" });
  const el = h("div", { class: "panel frame meta-panel stakes" },
    h("div", { class: "panel-head" }, h("h2", { text: "zkLTC stakes" }), h("span", { class: "badge outline", text: contract ? "Escrow" : "Off" })),
    h("div", { class: "panel-body stack" }, body, note));
  const say = (text, err = false) => { note.textContent = text; note.classList.toggle("err", err); };

  let stake = null, pending = 0n, delay = 0, delta = null, claimedAlready = false, wrongGame = null, tick = null, retry = null, retries = 0;

  const needWallet = () => {
    const a = wallet.snapshot().address;
    if (!a) { say("Connect your wallet first.", true); return null; }
    return a;
  };
  async function send(data, value) {
    await wallet.ensureChain();
    const hash = await wallet.sendTransaction({ to: contract, data, value });
    say(`Sent ${short(hash)}, waiting for the chain…`);
    const rc = await chain.waitForReceipt(hash);
    if (Number(rc.status) !== 1) throw new Error("The transaction reverted");
    return hash;
  }
  const act = (btn, fn) => async () => {
    if (!needWallet()) return;
    btn.disabled = true;
    try { await fn(); } catch (e) { say(e?.message ?? String(e), true); btn.disabled = false; }
  };

  // ------------------------------------------------------------------ views
  function render() {
    body.replaceChildren();
    if (!contract) {
      body.append(h("p", { class: "lede", text: "Stakes are off in this build: no escrow is set for this ruleset yet. Ranked matches still count on the ladder." }));
      return;
    }
    if (wrongGame) { say(`The escrow in this build pays ${wrongGame}, not ${online.rulesetId}: stakes are off.`, true); return; }
    renderStake();
    if (online.state.last) renderClaim(online.state.last);
  }

  function renderStake() {
    const address = wallet.snapshot().address;
    const key = online.key();
    body.append(h("p", { class: "lede", text:
      !address ? "Connect a wallet to put zkLTC at stake."
      : !stake ? "Reading your stake…"
      : stake.amount === 0n ? "Nothing at stake yet."
      : `${formatZkLtc(stake.amount)} zkLTC at stake under key ${short(stake.key ?? "")}.` }));
    if (pending > 0n) {
      const w = h("button", { class: "btn ghost block", type: "button" }, icon("gem"), `Withdraw ${formatZkLtc(pending)} zkLTC held for you`);
      w.addEventListener("click", act(w, async () => { await send(encodeWithdraw()); say("Withdrawn."); await refresh(); }));
      body.append(w);
    }
    body.append(h("p", { class: "hint", text: `A stake pays out on any ranked ${online.title} match against another staked player: twice the smaller stake goes to the winner, a draw moves nothing. The result is LitNode's own: the host node's signed delta, final on MatchBook.` }));

    const amount = h("input", { class: "input", placeholder: "zkLTC, e.g. 0.05", inputMode: "decimal", aria: { label: "Amount to stake in zkLTC" } });
    const go = h("button", { class: "btn primary", type: "button" }, icon("gem"), "Stake");
    body.append(h("div", { class: "stake-row" }, amount, go));
    const boundKey = stake?.key ?? null;
    const useKey = boundKey ?? key;
    if (!useKey) {
      go.disabled = true;
      body.append(h("p", { class: "hint", text: "This browser can't hold a LitNode key (it needs https and a current browser), so it can't stake." }));
    } else if (boundKey && key && boundKey !== key) {
      body.append(h("p", { class: "hint err", text: `Your stake is bound to key ${short(boundKey)}, but this browser plays as ${short(key)}. Unstake and stake again here, or play from the browser that holds the bound key.` }));
    }
    go.addEventListener("click", act(go, async () => {
      let wei;
      try { wei = parseZkLtc(amount.value); if (wei <= 0n) throw new Error("A stake must be above zero"); } catch (e) { go.disabled = false; return say(e.message, true); }
      if (!boundKey) {
        const holder = await readWalletOf(chain, contract, useKey);
        if (holder !== ZERO && holder.toLowerCase() !== (wallet.snapshot().address ?? "").toLowerCase()) throw new Error(`Key ${short(useKey)} is staked by another wallet`);
      }
      await send(encodeStake(useKey), wei);
      say(`${formatZkLtc(wei)} zkLTC staked.`);
      await refresh();
    }));

    if (stake && stake.amount > 0n) {
      if (!stake.unstakeAt) {
        const req = h("button", { class: "btn ghost", type: "button" }, icon("back"), "Request unstake");
        req.addEventListener("click", act(req, async () => { await send(encodeRequestUnstake()); say(`Unstake requested: available in ${mmss(delay)}. A match settled meanwhile can still be claimed.`); await refresh(); }));
        body.append(req);
      } else {
        const left = Math.max(0, stake.unstakeAt - Math.floor(Date.now() / 1000));
        const un = h("button", { class: "btn ghost", type: "button", disabled: left > 0 }, icon("back"), left > 0 ? `Unstake in ${mmss(left)}` : "Unstake");
        un.addEventListener("click", act(un, async () => { await send(encodeUnstake()); say("Stake returned."); await refresh(); }));
        body.append(un);
        if (left > 0 && !tick) tick = setInterval(() => { if (!el.isConnected || !stake?.unstakeAt) { clearInterval(tick); tick = null; return; } render(); }, 1000);
      }
    }
  }

  function renderClaim(last) {
    const info = h("p", { class: "hint" });
    const check = h("button", { class: "btn ghost", type: "button" }, icon("refresh"), "Check settlement");
    const claim = h("button", { class: "btn primary", type: "button", disabled: true }, icon("trophy"), "Claim");
    const dismiss = h("button", { class: "link-btn", type: "button" }, icon("close"), "Dismiss");
    body.append(h("div", { class: "claim-box" },
      h("span", { class: "eyebrow", text: "Your last ranked match" }),
      h("p", { class: "run-line tabnum", text: `Match ${short(last.matchId)} · ${new Date(last.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` }),
      info, h("div", { class: "stake-actions" }, check, claim, dismiss)));

    const describe = () => {
      if (!delta) { info.textContent = "Ask the host node whether it has settled this match."; return; }
      const problem = claimProblem(delta, last.matchId, online.rulesetId, last.signatures ?? {});
      const who = deltaWinner(delta);
      const me = online.key();
      const outcome = who === 2 ? "a draw" : delta.participants[who] === me ? "you won" : "your opponent won";
      const label = delta.official ? "official" : (delta.verification ?? delta.attestation);
      claim.disabled = true;
      if (claimedAlready) info.textContent = `Settled: ${outcome} (${label}). The stakes were already paid out.`;
      else if (problem) info.textContent = `Settled (${label}): ${outcome}, but it can't pay out: ${problem}.`;
      else { info.textContent = `Settled: ${outcome} (${label}). Claim pays the stakes out as LitNode's result says.`; claim.disabled = false; }
    };
    describe();

    check.addEventListener("click", async () => {
      check.disabled = true;
      try {
        const r = await fetch(`${last.hostUrl.replace(/\/+$/, "")}/delta/${encodeURIComponent(last.matchId)}`);
        if (r.status === 404) throw new Error("The node hasn't settled this match yet: try again in a moment");
        if (!r.ok) throw new Error(`The node answered ${r.status}`);
        const d = await r.json();
        delta = d.delta ?? d;
        claimedAlready = await readClaimed(chain, contract, last.matchId).catch(() => false);
        say("Settlement read from the host node.");
      } catch (e) { say(e?.message ?? String(e), true); }
      check.disabled = false;
      describe();
    });
    claim.addEventListener("click", act(claim, async () => {
      if (!delta) return;
      const { json, hostSig } = deltaClaimBytes(delta);
      await send(delta.attestation === "players" ? encodeClaim(last.matchId, json, hostSig) : encodeClaimWithWinner(last.matchId, json, hostSig, winnerSignature(delta, last.signatures ?? {})));
      claimedAlready = true;
      say("Claimed: the stakes are paid out.");
      await refresh();
    }));
    dismiss.addEventListener("click", () => { delta = null; claimedAlready = false; online.forgetMatch(); });
  }

  // ------------------------------------------------------------------ state
  async function refresh() {
    clearTimeout(retry); retry = null;
    const address = wallet.snapshot().address;
    if (!contract) { render(); return; }
    try {
      if (wrongGame === null) { const id = await readRulesetId(chain, contract); wrongGame = id === online.rulesetId ? false : id || "another ruleset"; }
      if (address && !wrongGame) {
        const [s, p, d] = await Promise.all([readStake(chain, contract, address), readPending(chain, contract, address), delay ? delay : readUnstakeDelay(chain, contract)]);
        stake = s; pending = p; delay = d;
      } else { stake = null; pending = 0n; }
      if (retries) { retries = 0; say(""); }
    } catch (e) {
      // a busy RPC is not a dead end: read again shortly, backing off
      if (retries < 6 && /429|bandwidth|rate|timeout|fetch|network|did not answer/i.test(e?.message ?? "")) {
        const ms = 3000 * 2 ** retries++;
        say(`The Liteforge RPC is busy: reading your stake again in ${Math.round(ms / 1000)} s…`);
        retry = setTimeout(() => void refresh(), ms);
      } else say(`Couldn't read the escrow: ${e?.message ?? e}`, true);
    }
    render();
  }

  wallet.subscribe(() => { if (el.isConnected) void refresh(); });
  // a new ranked match to claim (not every queue tick) redraws the panel
  let shownMatch = online.state.last?.matchId ?? null;
  online.onChange((st) => {
    const id = st.last?.matchId ?? null;
    if (id === shownMatch) return;
    shownMatch = id; delta = null; claimedAlready = false;
    if (el.isConnected) render();
  });
  render();
  return { el, refresh: () => void refresh() };
}
