// The view dock, for replays and spectators: step a replay move by move or turn by turn, play it, scrub through it,
// flip whose side is at the bottom, copy a link to it, and exit. Spectating live shows only the status and the extras.
import { h, icon } from "../dom.js";

/** session: a getter for the match's current session; flip: swaps the side shown at the bottom. */
export function createViewbar(app, { session, flip }) {
  const replaying = () => session()?.role === "replay";
  const stepTo = (k) => { if (!replaying()) return; const r = session(); r.pause(); r.seek(k); };
  const vbtn = (ico, label, onClick) => h("button", { class: "icon-btn sm", type: "button", title: label, aria: { label }, on: { click: onClick } }, icon(ico));
  const vb = {
    first: vbtn("first", "Back to the start", () => { const r = session(); stepTo(r.cursor > r.playStart ? r.playStart : 0); }),
    prevTurn: vbtn("prevTurn", "Previous turn", () => stepTo(session().turnStart(session().cursor, -1))),
    prev: vbtn("prev", "Previous move (←)", () => stepTo(session().cursor - 1)),
    play: h("button", { class: "icon-btn vb-play", type: "button", title: "Play (space)", aria: { label: "Play" }, on: { click: () => { if (replaying()) { const r = session(); if (r.playing) r.pause(); else r.play(); } } } }, icon("play")),
    next: vbtn("next", "Next move (→)", () => stepTo(session().cursor + 1)),
    nextTurn: vbtn("nextTurn", "Next turn", () => stepTo(session().turnStart(session().cursor, 1))),
    last: vbtn("last", "Jump to the end", () => stepTo(session().length)),
  };
  const scrub = h("input", { type: "range", class: "vb-scrub", min: "0", max: "0", value: "0", aria: { label: "Move in the match" }, on: { input: (e) => stepTo(Number(e.target.value)) } });
  const pos = h("span", { class: "vb-pos tabnum", aria: { live: "polite" } });
  const badge = h("span", { class: "badge vb-badge" });
  const el = h("div", { class: "viewbar panel", hidden: true },
    badge,
    h("div", { class: "vb-steps" }, vb.first, vb.prevTurn, vb.prev, vb.play, vb.next, vb.nextTurn, vb.last),
    scrub, pos,
    h("div", { class: "vb-more" },
      vbtn("flip", "Flip view", () => flip()),
      vbtn("link", "Copy link", () => void app.flows.copyViewLink(session())),
      vbtn("close", "Exit", () => void app.flows.exitView())));

  return {
    el,
    /** Draw it for the state on screen (null before there is one). */
    render(s) {
      badge.textContent = replaying() ? "Replay" : "Spectating";
      el.classList.toggle("live", !replaying());
      if (!replaying()) { pos.textContent = session()?.status ?? ""; return; }
      const r = session();
      scrub.max = String(r.length);
      scrub.value = String(r.cursor);
      pos.textContent = !s ? "" : s.phase === "decks" ? `deck building · ${r.cursor}/${r.length}` : `turn ${s.turnNo} · move ${r.cursor}/${r.length}`;
      vb.play.replaceChildren(icon(r.playing ? "pause" : r.cursor >= r.length ? "replay" : "play"));
      vb.play.setAttribute("aria-label", r.playing ? "Pause" : "Play");
      vb.first.disabled = vb.prev.disabled = vb.prevTurn.disabled = r.cursor <= 0;
      vb.last.disabled = vb.next.disabled = vb.nextTurn.disabled = r.cursor >= r.length;
    },
    /** A replay's keys: ← and → step, space plays and pauses. */
    key(e) {
      if (!replaying()) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); stepTo(session().cursor - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); stepTo(session().cursor + 1); }
      else if (e.key === " ") { e.preventDefault(); vb.play.click(); }
    },
  };
}
