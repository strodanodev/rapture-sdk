// Inspect: hold a card (touch) or right-click it to read it full size; a tap anywhere closes it.
import { h } from "../dom.js";

export function createInspector(root, app) {
  let open = null;
  function show(def) {
    open?.remove();
    const big = app.cards.cardFace(def);
    big.classList.add("inspect-card");
    open = h("div", { class: "inspect", role: "dialog", aria: { label: def.name }, on: { pointerdown: () => { open?.remove(); open = null; } } },
      big, h("p", { class: "hint", text: "Tap anywhere to close" }));
    root.append(open);
  }
  return {
    /** Close the card if one is open; true if it was. */
    close() {
      if (!open) return false;
      open.remove(); open = null;
      return true;
    },
    /** Make a card's node open it on a right-click or a hold; returns the node. */
    inspectable(node, def) {
      node.addEventListener("contextmenu", (e) => { e.preventDefault(); show(def); });
      let timer = 0, held = false;
      node.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        held = false;
        timer = setTimeout(() => { held = true; show(def); }, 450);
      });
      const cancel = () => clearTimeout(timer);
      node.addEventListener("pointerup", cancel);
      node.addEventListener("pointerleave", cancel);
      node.addEventListener("pointercancel", cancel);
      // a hold opens the card; the click that ends it must not also play or pick it
      node.addEventListener("click", (e) => { if (held) { held = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
      return node;
    },
  };
}
