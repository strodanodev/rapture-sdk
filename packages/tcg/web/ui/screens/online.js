// The online pages: Ranked (this browser's LitNode seat, the wallet it plays for, the queue, and zkLTC stakes) and
// the Leaderboard (the Elo ladder every LitNode node folds from MatchBook's finalized results). The state lives in
// ui/online.js; these only draw it. Player names come from LitNode profiles and go in through textContent.
import { h, icon, stagger } from "../dom.js";
import { go, pageHead } from "../router.js";
import { tile, walletChip } from "../widgets.js";
import { stakesPanel } from "../stakes.js";
import { NAME_RE } from "../../lib/litnode/profile.js";

const short = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "");
const page = (app, cls, title, kicker, body) => h("section", { class: `page ${cls}` }, h("div", { class: "page-scrim" }), pageHead(title, kicker, walletChip(app)), h("div", { class: "page-wrap" }, body));

export function rankedScreen(app, wallet) {
  const online = app.online;
  const body = h("div", { class: "meta-body" });
  const el = page(app, "ranked-page", "Ranked", "LitNode ladder · zkLTC stakes", body);
  const stakes = stakesPanel(app, wallet);
  const seat = h("div", { class: "panel frame meta-panel ranked-seat" });
  let mine = null;   // this key's ladder line, once read

  function renderSeat() {
    const st = online.state;
    const address = wallet.snapshot().address;
    const head = h("div", { class: "panel-head" }, h("h2", { text: "Your seat" }), h("span", { class: "badge outline live", text: st.searching ? "Searching" : "Ranked" }));
    const rows = [];
    if (!online.canQueue) {
      rows.push(h("p", { class: "lede", text: "Ranked play signs every match with a LitNode key this browser keeps. It needs a secure page (https) and a current browser: open the game's https address, or update the browser." }));
      seat.replaceChildren(head, h("div", { class: "panel-body stack" }, ...rows));
      return;
    }
    const b = st.binding;
    rows.push(h("div", { class: "tiles" },
      tile(mine ? String(mine.rating) : "–", mine ? `rating · rank ${mine.rank}` : "rating"),
      tile(mine ? `${mine.wins}–${mine.losses}` : "–", mine?.draws ? `won–lost · ${mine.draws} drawn` : "won–lost"),
      tile(mine ? String(mine.streak) : "–", mine ? `streak · best ${mine.bestStreak}` : "streak")));
    rows.push(h("p", { class: "ph-who" }, icon("user"),
      h("b", { text: b?.name || short(online.key()) || "…" }),
      h("span", { text: b?.owner ? (b.active ? (b.mine ? "plays for your wallet" : `plays for ${short(b.owner)}`) : "this key was revoked") : "player key on this device" })));

    // the wallet binding: the relay checks the champion and the deck against the wallet a key plays for
    if (app.hasWallet && (!b?.owner || !b.active || (address && !b.mine))) {
      const name = h("input", { class: "input", placeholder: "Profile name (letters, digits, - _ .)", maxLength: 32, aria: { label: "Profile name" } });
      const bind = h("button", { class: "btn ghost", type: "button" }, icon("wallet"), address ? "Bind to my wallet" : "Connect wallet");
      bind.addEventListener("click", async () => {
        if (!address) { await app.toggleWallet().catch((e) => app.toast(e.message, "err")); return; }
        if (name.value && !NAME_RE.test(name.value.trim())) { app.toast("A name is 1 to 32 letters, digits, spaces, dots, dashes or underscores", "err"); return; }
        bind.disabled = true;
        try { await online.bind(name.value.trim() || `player-${online.key().slice(0, 6)}`); app.toast("This device now plays for your wallet"); }
        catch (e) { app.toast(e?.message ?? String(e), "err"); bind.disabled = false; }
      });
      rows.push(h("div", { class: "bind-box" },
        h("p", { class: "hint", text: b?.owner && b.active && !b.mine
          ? "This device's key plays for another wallet. Champions and owned cards are checked against that wallet."
          : "Bind this device to your wallet so your NFT champion and owned cards count in ranked. One transaction; a first-time profile takes a name for the leaderboard." }),
        h("div", { class: "stake-row" }, b?.owner ? null : name, bind)));
    }

    const find = h("button", { class: "btn primary lg block pulse", type: "button", hidden: st.searching, on: { click: () => void app.flows.choose("ranked") } }, icon("swords"), "Find a ranked match");
    const cancel = h("button", { class: "btn ghost block", type: "button", hidden: !st.searching, on: { click: () => online.cancel() } }, icon("close"), "Stop searching");
    const status = h("p", { class: `hint queue-status${st.error ? " err" : ""}`, aria: { live: "polite" }, text: st.status || "Owned-only decks: collection cards must be in your wallet; support cards are always allowed. Turns are timed, and a match counts once both players sign it." });
    rows.push(find, cancel, status);
    seat.replaceChildren(head, h("div", { class: "panel-body stack" }, ...rows));
  }

  async function readMine() {
    const k = online.key();
    if (!k) return;
    try {
      const l = await online.ladder();
      mine = l.ranking.find((r) => r.player === k) ?? null;
    } catch { mine = null; }
    if (!el.hidden) renderSeat();
  }

  online.onChange(() => { if (!el.hidden && !seat.contains(document.activeElement)) renderSeat(); });
  app.onWallet(() => { if (!el.hidden) renderSeat(); });
  const ladderLink = h("button", { class: "link-btn", type: "button", on: { click: () => void go("ladder") } }, icon("trophy"), "Leaderboard");
  body.replaceChildren(h("div", { class: "profile-cols ranked-cols" }, seat, stakes.el), ladderLink);

  return {
    id: "ranked", el,
    render: renderSeat,
    enter() {
      app.arena.setMood("menu");
      renderSeat();
      stagger(body);
      stakes.refresh();
      void online.readBinding();
      void readMine();
    },
  };
}

export function ladderScreen(app) {
  const online = app.online;
  const body = h("div", { class: "meta-body" });
  const el = page(app, "ladder-page", "Leaderboard", `${app.game.title} · ranked on LitNode`, body);
  let busy = false;

  const row = (l, me) => {
    const who = h("span", { class: "lb-who" }, h("b", { class: "lb-mono", text: short(l.player) }));
    // the profile name, when the key is bound to one: read lazily, never blocks the table
    void online.keyName(l.player).then((n) => { if (n) who.replaceChildren(h("b", { text: n }), h("span", { class: "lb-key", text: short(l.player) })); });
    return h("li", { class: `lb-row${me ? " me" : ""}${l.rank <= 3 ? ` top top-${l.rank}` : ""}` },
      h("span", { class: "lb-rank tabnum" }, l.rank <= 3 ? icon("crown") : null, h("span", { text: String(l.rank) })),
      who,
      h("span", { class: "lb-rating tabnum", text: String(l.rating) }),
      h("span", { class: "lb-record tabnum", text: `${l.wins}–${l.losses}${l.draws ? `–${l.draws}` : ""}` }),
      h("span", { class: "lb-streak tabnum", text: l.streak > 1 ? `${l.streak} in a row` : "" }));
  };

  async function render(fresh = false) {
    if (busy) return;
    busy = true;
    const refresh = h("button", { class: "btn ghost sm", type: "button", on: { click: () => void render(true) } }, icon("refresh"), "Refresh");
    body.replaceChildren(h("div", { class: "panel frame meta-panel" }, h("div", { class: "panel-body" }, h("p", { class: "lede", text: "Reading the ladder from the LitNode mesh…" }))));
    try {
      const l = await online.ladder(fresh);
      const me = online.key();
      const head = h("div", { class: "panel-head" }, h("h2", { text: "The ladder" }), refresh);
      const table = l.ranking.length
        ? h("ol", { class: "lb", aria: { label: "Ranked ladder" } },
          h("li", { class: "lb-row lb-head", aria: { hidden: "true" } }, h("span", { text: "#" }), h("span", { text: "Player" }), h("span", { text: "Rating" }), h("span", { text: "W–L–D" }), h("span", { class: "lb-streak", text: "" })),
          ...l.ranking.map((r) => row(r, r.player === me)))
        : h("div", { class: "panel-body stack" },
          h("p", { class: "lede", text: "No ranked matches have finished yet. Play one and take the top spot." }),
          h("button", { class: "btn primary", type: "button", on: { click: () => void go("ranked") } }, icon("swords"), "Play ranked"));
      const mine = me ? l.ranking.find((r) => r.player === me) : null;
      body.replaceChildren(
        stagger(h("div", { class: "tiles" }, tile(String(l.players), l.players === 1 ? "player" : "players"), tile(String(l.finalized), "finalized matches"), tile(String(l.pending), "awaiting finality"), tile(mine ? `#${mine.rank}` : "–", mine ? `you · ${mine.rating}` : "your rank"))),
        h("div", { class: "panel frame meta-panel" }, head, table),
        h("p", { class: "hint lb-source", text: `Elo (k ${app.game.litnode.eloK ?? 24}) from ${new URL(l.node).host}${l.source ? ` · ${l.source}` : ""}. Every node folds the same table from MatchBook, so any node gives the same ladder.` }));
    } catch (e) {
      body.replaceChildren(h("div", { class: "panel frame meta-panel" },
        h("div", { class: "panel-head" }, h("h2", { text: "The ladder" }), refresh),
        h("div", { class: "panel-body stack" }, h("p", { class: "lede", text: e?.message ?? String(e) }))));
    } finally { busy = false; }
  }
  return { id: "ladder", el, render, enter() { app.arena.setMood("menu"); app.arena.setRealm("valhalla"); void render(); } };
}
