// The battle's overlays: the cinematic banner across the screen (turns, the outcome), the victory or defeat flash, and
// the fallen feed down the side.
import { h, icon } from "../dom.js";

export function createOverlays(app) {
  const feed = h("div", { class: "killfeed", aria: { live: "polite" } });
  const cineWord = h("b", { class: "display" });
  const cineSub = h("span");
  const cine = h("div", { class: "cine", aria: { hidden: "true" } }, cineWord, h("div", { class: "cine-line" }), cineSub);
  const fx = h("div", { class: "screen-fx", aria: { hidden: "true" } });
  return {
    feed, cine, fx,
    /** A word across the screen, with a smaller line under it; kind: "" (gold), "red" or "foe". */
    banner(word, sub = "", kind = "") {
      cine.dataset.kind = kind;
      cineWord.textContent = word; cineSub.textContent = sub;
      cine.classList.remove("show"); void cine.offsetWidth; cine.classList.add("show");
    },
    /** kind: "victory" or "defeat" */
    flash(kind) {
      const i = h("i", { class: `fx-${kind}` });
      fx.append(i);
      setTimeout(() => i.remove(), 1700);
    },
    /** A unit fell: a line in the feed (the newest on top, four at most), gone after a few seconds. */
    fallen(def, foeSide) {
      const e = h("div", { class: `kf${foeSide ? "" : " mine"}` }, app.artOf(def) ? h("img", { src: app.artOf(def), alt: "" }) : icon("sword"), icon("skull"), h("span", null, h("b", { text: def.name }), " fell"));
      feed.prepend(e);
      while (feed.children.length > 4) feed.lastChild.remove();
      setTimeout(() => { e.classList.add("gone"); setTimeout(() => e.remove(), 500); }, 3600);
    },
    clear() { feed.replaceChildren(); },
  };
}
