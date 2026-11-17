// A champion's plate (Rapture Chess's player plate): the portrait with its life orb and the damage floaters, the name,
// the chips, the energy pips, the hero power and the relics. Beside it, on wider screens, the table furniture of that
// side: the deck as a pile with its count, the foe's hand as a fan of card backs, and your energy as a crystal (with
// the aim prompt over your plate).
import { Op, ENEMY_CHAMPION, describeEffect } from "../../engine/tessaract.js";
import { h, icon } from "../dom.js";
import { unitAttackText } from "../widgets.js";

/** side: "top" (the foe's) or "bottom" (yours). inspectable(node, def) makes a relic open full size. */
export function createPlate(app, side, { inspectable }) {
  const { game } = app;
  const portrait = h("button", { class: "pl-face", type: "button" });
  const life = h("div", { class: "pl-life tabnum" });
  const name = h("span", { class: "pl-name" });
  const sub = h("span", { class: "pl-chips" });
  const energy = h("div", { class: "pl-energy" });
  const power = h("div", { class: "pl-power" });
  const relics = h("div", { class: "pl-relics" });
  const floats = h("div", { class: "pl-floats", aria: { hidden: "true" } });
  const el = h("div", { class: `plate ${side}` }, h("i", { class: "pl-orn", aria: { hidden: "true" } }), h("div", { class: "pl-hero" }, portrait, life, floats), h("div", { class: "pl-id" }, name, sub, energy), power, relics);
  // the table furniture (styled for wider screens only)
  const deck = h("div", { class: "deck-pile", aria: { hidden: "true" } }, h("i"), h("i"), h("i"), h("b", { class: "tabnum" }));
  const fan = side === "top" ? h("div", { class: "foe-hand", aria: { hidden: "true" } }) : null;
  const mana = side === "top" ? null : h("div", { class: "mana-bar", aria: { hidden: "true" } });
  const prompt = side === "top" ? null : h("p", { class: "aim-prompt", aria: { hidden: "true" } });
  if (fan) el.append(fan, deck); else el.append(deck, mana, prompt);

  return {
    el, portrait, power, relics, prompt,
    /**
     * Draw the plate for player state p. champ: their champion card (or null); label: who plays it ("You", "House bot", …).
     * mine: your plate; foe: the plate you can target; moves and targets: your legal moves and, for the current pick, its
     * targets (target code -> action); powerPicked: your hero power is the pick; act(x) plays an action; onPower() picks or
     * unpicks the hero power.
     */
    render(p, champ, label, { mine, foe, moves, targets, powerPicked, act, onPower }) {
      el.dataset.el = champ ? String(champ.element ?? "").toLowerCase() : "neutral";
      el.style.setProperty("--el", app.elementColor(String(champ?.element ?? "neutral").toLowerCase()));
      portrait.replaceChildren(champ?.art ? h("img", { src: champ.art, alt: "" }) : icon(mine ? "you" : "foe"));
      const aim = foe ? targets.get(ENEMY_CHAMPION) : undefined;
      portrait.classList.toggle("target", aim !== undefined);
      portrait.onclick = aim !== undefined ? () => act(aim) : null;
      portrait.setAttribute("aria-label", `${label}: ${p.life} life`);
      life.textContent = String(p.life);
      life.classList.toggle("low", p.life <= Math.max(5, Math.round(p.maxLife * 0.25)));
      name.replaceChildren(...(champ ? [champ.name, h("span", { class: "pl-who", text: label })] : [label]));
      const ua = unitAttackText(game, p.unitAttack);   // with unitAttack.minCost, only units that cost that much get it
      sub.replaceChildren(...[
        h("span", { class: "chip-mini c-deck", title: `${p.deck.length} cards left in the deck` }, h("i", { class: "cardback" }), h("b", { class: "tabnum", text: p.deck.length })),
        h("span", { class: "chip-mini c-hand", title: `${p.hand.length} cards in hand` }, icon("cards"), h("b", { class: "tabnum", text: p.hand.length })),
        p.spellPower ? h("span", { class: "chip-mini buff", title: `Spell power +${p.spellPower}` }, icon("spark"), h("b", { text: `+${p.spellPower}` })) : null,
        p.unitAttack ? h("span", { class: "chip-mini buff", title: ua.minCost ? ua.text : `Unit attack +${p.unitAttack}` }, icon("sword"), h("b", { text: `+${p.unitAttack}` })) : null].filter(Boolean));
      const n = Math.max(p.energyCap, p.energy);
      // energy past the cap is a bonus for this turn: gold pips, and the count alone rather than a "2/1"
      const bonus = Math.max(0, p.energy - p.energyCap);
      energy.replaceChildren(...Array.from({ length: n }, (_, i) => h("i", { class: i >= p.energyCap ? "full bonus" : i < p.energy ? "full" : "" })), h("span", { class: "tabnum", text: `${Math.min(p.energy, p.energyCap)}/${p.energyCap}` }), bonus ? h("span", { class: "tabnum bonus", text: `+${bonus}` }) : "");
      energy.title = bonus ? `energy ${p.energy} (${bonus} bonus this turn)` : `energy ${p.energy}/${p.energyCap}`;
      // the hero power
      const pw = p.power >= 0 ? game.champion.powers?.[p.power] : null;
      power.replaceChildren();
      if (pw) {
        const uses = mine ? moves.filter((m) => m.op === Op.Power) : [];
        const b = h("button", { class: `power${p.powerUsed ? " used" : ""}${powerPicked ? " picked" : ""}`, type: "button", disabled: !uses.length, title: `${pw.name} (${pw.cost}): ${describeEffect(pw.effect, app.nameOf)}` },
          h("span", { class: "pw-cost tabnum", text: pw.cost }), icon("bolt"), h("span", { class: "pw-name", text: pw.name }));
        b.addEventListener("click", () => {
          if (uses.length === 1 && uses[0].target === 0) { act(uses[0].x); return; }
          onPower();
        });
        power.append(b);
      }
      relics.replaceChildren(...p.relics.map((c) => inspectable(app.cards.cardFace(game.cards[c], { small: true }), game.cards[c])));
    },
    /** The table furniture for player state p: the deck's count, the foe's hand as card backs, your energy crystal. */
    table(p) {
      if (fan) {
        const backs = Math.min(p.hand.length, 10);
        fan.replaceChildren(...Array.from({ length: backs }, (_, i) => h("i", { style: `--i:${i - (backs - 1) / 2}` })));
      }
      deck.lastElementChild.textContent = String(p.deck.length);
      deck.classList.toggle("low", p.deck.length > 0 && p.deck.length <= 5);
      deck.classList.toggle("empty", p.deck.length === 0);
      if (mana) {
        const cap = Math.max(p.energyCap, p.energy);
        mana.replaceChildren(h("b", { class: "tabnum" }, `${Math.min(p.energy, p.energyCap)}/${p.energyCap}`, p.energy > p.energyCap ? h("span", { class: "bonus", text: ` +${p.energy - p.energyCap}` }) : ""),
          h("span", { class: "mana-gems" }, ...Array.from({ length: cap }, (_, i) => h("i", { class: i >= p.energyCap ? "full bonus" : i < p.energy ? "full" : "" }))));
      }
    },
    /** A number floats up from the portrait (kind "dmg" or "heal"), and the portrait flashes red or green. */
    floater(text, kind) {
      const f = h("span", { class: `float ${kind}`, text });
      floats.append(f);
      setTimeout(() => f.remove(), 1300);
      // restarted on every hit
      portrait.classList.remove("hit", "healed"); void portrait.offsetWidth; portrait.classList.add(kind === "dmg" ? "hit" : "healed");
    },
    /** the foe's hand, for the battle VFX (a card the foe plays comes from it) */
    fan,
  };
}
