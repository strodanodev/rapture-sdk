// The battle menu (Esc, or the menu button): resume, sound, concede (a second click confirms), copy a watch link
// (online), and leave. Spectators and replays get only Leave.
import { h, icon } from "../dom.js";
import { soundButton } from "../widgets.js";

/** session, ctx: getters for the match's current ones; viewing: whether it is watched rather than played; blocked:
 *  true while the menu must not open (the result is up). */
export function createBattleMenu(app, root, { session, ctx, viewing, blocked }) {
  let menu = null;
  const close = () => { menu?.remove(); menu = null; };
  function open() {
    if (menu || blocked()) return;
    const c = ctx();
    let armed = false;
    const concede = h("button", { class: "btn danger block", type: "button" }, icon("flag"), "Concede");
    concede.addEventListener("click", () => {
      if (!armed) { armed = true; concede.lastChild.textContent = "Really concede?"; return; }
      close(); session()?.concede();
    });
    const rows = viewing()
      ? [h("button", { class: "btn ghost block", type: "button", on: { click: () => { close(); void app.flows.exitView(); } } }, icon("close"), "Leave")]
      : [
        c.kind === "relay" ? h("button", { class: "btn ghost block", type: "button", on: { click: () => void app.flows.copyViewLink(session()) } }, icon("eye"), "Copy watch link") : null,
        c.kind !== "puzzle" && !session().state?.over ? concede : null,
        h("button", { class: "btn ghost block", type: "button", on: { click: () => { close(); void app.flows.leaveMatch(); } } }, icon("back"), c.kind === "relay" || c.kind === "ranked" ? "Leave the match" : c.kind === "gauntlet" && !session().state?.over ? "Leave (counts as a loss)" : "Leave to the menu"),
      ];
    menu = h("div", { class: "pause", on: { pointerdown: (e) => { if (e.target === menu) close(); } } },
      h("div", { class: "pause-panel panel frame" },
        h("div", { class: "panel-head" }, icon("swords"), h("h2", { text: "Battle menu" }), h("button", { class: "icon-btn sm close", type: "button", aria: { label: "Resume" }, on: { click: close } }, icon("close"))),
        h("div", { class: "panel-body pause-body" },
          h("button", { class: "btn primary block", type: "button", on: { click: close } }, icon("play"), "Resume"),
          app.sound ? soundButton(app, { block: true }) : null,
          h("hr", { class: "pause-gap" }),
          ...rows,
          h("p", { class: "hint", text: `${c.label ?? "Match"} · ${app.game.title}` }))));
    root.append(menu);
  }
  return { open, close, get isOpen() { return !!menu; } };
}
