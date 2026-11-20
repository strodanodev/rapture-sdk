// Card renderers: the game card (hand, deck forge, rewards), the unit token on the board, and the champion card (a
// collection token: Rapture Chess's framed card with its foil). Colours: rarity frames the card, the element tints it.
import { describeCard, KEYWORDS, TRIGGERS } from "../engine/tessaract.js";
import { h, icon } from "./dom.js";
import { sigil } from "./sigil.js";

const KIND_RARITY = { God: "legendary", Titan: "epic", Demigod: "rare", King: "uncommon", Mortal: "common" };
const RARITY_NAME = { legendary: "Legendary", epic: "Epic", rare: "Rare", uncommon: "Uncommon", common: "Common" };
// Rules text: keywords and trigger labels are picked out (the text still goes in through textContent).
const TRIGGER_LABELS = Object.values(TRIGGERS).sort((a, b) => b.length - a.length);
const RICH = new RegExp(`(${[...TRIGGER_LABELS, ...Object.keys(KEYWORDS)].join("|")})`, "gi");
function richLine(text) {
  return text.split(RICH).filter(Boolean).map((part) => {
    if (TRIGGER_LABELS.some((t) => t.toLowerCase() === part.toLowerCase())) return h("b", { class: "trig", text: part });
    if (Object.keys(KEYWORDS).includes(part.toLowerCase())) return h("b", { class: "kw", text: part });
    return part;
  });
}

const finePointer = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

/** Pointer-follow tilt and foil: transform only, so it stays on the compositor. */
export function tilt(el, max = 10) {
  if (!finePointer) return el;
  let raf = 0;
  el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      el.style.transform = `perspective(700px) rotateY(${(x - 0.5) * max}deg) rotateX(${(0.5 - y) * max}deg) translateZ(0)`;
      el.style.setProperty("--fx", `${x * 100}%`);
      el.style.setProperty("--fy", `${y * 100}%`);
      el.classList.add("tilt");
    });
  });
  el.addEventListener("pointerleave", () => { cancelAnimationFrame(raf); el.style.transform = ""; el.classList.remove("tilt"); });
  return el;
}

/**
 * What a unit on the board is now, beyond its numbers: frozen (it can't attack until it thaws), silenced (its printed
 * keywords, abilities and aura are gone), and the part of its attack and health an aura lends it (gone with the aura).
 * Pure, so the tests read it from real match states. `label` is the token's accessible name.
 */
export function unitState(def, u) {
  const frozen = u.frozen !== undefined, silenced = !!u.silenced;
  const keywords = silenced ? [] : (def.keywords ?? []).map(String);
  const [auraAtk, auraHp] = u.aura ?? [0, 0];
  const notes = [
    frozen ? "Frozen: it can't attack until it thaws." : null,
    auraAtk || auraHp ? `Aura: ${[auraAtk ? `+${auraAtk} attack` : null, auraHp ? `+${auraHp} health` : null].filter(Boolean).join(", ")} while the aura lasts` : null,
  ].filter(Boolean);
  const label = `${def.name}, ${u.atk} attack, ${u.hp} health${keywords.length ? `, ${keywords.join(", ")}` : ""}`
    + `${auraAtk || auraHp ? `, ${[auraAtk ? `${auraAtk} attack` : null, auraHp ? `${auraHp} health` : null].filter(Boolean).join(" and ")} from an aura` : ""}`
    + `${frozen ? ", frozen" : ""}${silenced ? ", silenced" : ""}${u.ready || frozen ? "" : ", exhausted"}`;
  return { frozen, silenced, aura: [auraAtk, auraHp], keywords, notes, label };
}

/**
 * @param {object} app  game, artOf(def), elementColor(id), nameOf(id), byToken
 */
export function createCards(app) {
  const { game } = app;
  const tokenCard = new Map(game.cards.filter((c) => c.token).map((c) => [String(c.token.tokenId), c]));
  const describe = (def) => describeCard(def, app.nameOf);
  const keywordHelp = (def) => (def.keywords ?? []).map((k) => `${k}: ${KEYWORDS[k] ?? ""}`).join("\n");
  const elementName = (id) => game.elements.find((e) => e.id === id)?.name ?? id;
  const typeLine = (def) => [def.type === "unit" ? def.kind ?? "Unit" : def.type === "spell" ? "Spell" : "Relic", def.element && def.element !== "neutral" ? elementName(def.element) : null].filter(Boolean).join(" · ");
  const artBox = (def, cls) => {
    const art = app.artOf(def);
    // rendered illustrations (assets/cards) are framed on their centre; NFT busts on the head
    return h("div", { class: cls }, art ? h("img", { src: art, alt: "", loading: "lazy", decoding: "async", draggable: false, class: art.includes("/assets/cards/") ? "render" : null }) : sigil(def));
  };

  // Long names and rules step their type down by length. The classes add up: "long" (a name past 12 characters, rules
  // past 34) and "xlong" (rules past 52) are the drawn card's steps; a painted frame (cards.css, :root.card-frame) has a
  // narrower name plate and rules window, so it also reads "mid" (a name past 9) and the name's "xlong" (past 13), and
  // the rules' "xxlong" (past 92). The drawn card ignores those, and looks as it always did.
  const nameSize = (n) => `${n > 9 ? " mid" : ""}${n > 12 ? " long" : ""}${n > 13 ? " xlong" : ""}`;
  const textSize = (n) => `${n > 52 ? " xlong" : n > 34 ? " long" : ""}${n > 92 ? " xxlong" : ""}`;

  /** A full card. `tag` "button" makes it clickable; `small` is the relic size. */
  function cardFace(def, { tag = "div", small = false, cost = def.cost } = {}) {
    const text = describe(def);
    const el = h(tag, { class: `tcard t-${def.type}${small ? " small" : ""}`, data: { rarity: def.rarity ?? "common", el: def.element ?? "neutral", ...(def.kind ? { kind: def.kind } : {}) }, style: `--el:${app.elementColor(def.element)}`, title: keywordHelp(def) || undefined, ...(tag === "button" ? { type: "button" } : {}) },
      h("div", { class: "tc-frame" },
        artBox(def, "tc-art"),
        h("div", { class: `tc-name${nameSize(def.name.length)}`, text: def.name }),
        h("div", { class: "tc-type", text: typeLine(def) }),
        // long rules text steps down a size or two rather than clipping ("…the enemy champio")
        h("div", { class: `tc-text${textSize(text.join(" ").length)}` }, ...text.map((t) => h("p", null, ...richLine(t))))),
      h("span", { class: "tc-cost tabnum", text: cost }),
      def.type === "unit" ? h("span", { class: "tc-atk tabnum", text: def.attack }) : null,
      def.type === "unit" ? h("span", { class: "tc-hp tabnum", text: def.health }) : null,
      h("span", { class: "tc-gem" }),
      h("span", { class: "foil" }));
    el.setAttribute("aria-label", `${def.name}, costs ${def.cost}${def.type === "unit" ? `, ${def.attack} attack, ${def.health} health` : ""}${text.length ? `. ${text.join(". ")}` : ""}`);
    return el;
  }

  /** A unit on the board: its portrait, attack and health, and its keywords and states as frame states. */
  function unitToken(def, u) {
    const st = unitState(def, u);
    // Guard and Shield are drawn on the token from its state (frame and emblem, dome), so they get no text tag: the
    // printed keyword's tag outlived a popped shield, and two stacked tags covered the portrait. A silenced unit shows
    // its printed keywords struck through: it has none of them now.
    const tags = (def.keywords ?? []).filter((k) => !/^(guard|shield)$/i.test(String(k)));
    const [auraAtk, auraHp] = u.aura ?? [0, 0];
    const cls = ["unit", u.guard && "guard", u.shield && "shielded", !u.ready && "tired", st.frozen && "frozen", st.silenced && "silenced", ...st.keywords.map((k) => `kw-${String(k).toLowerCase().replace(/[^a-z]+/g, "-")}`)];
    const help = st.silenced ? "Silenced: it has lost its keywords, abilities and aura." : keywordHelp(def);
    const el = h("button", { type: "button", class: cls.filter(Boolean).join(" "), data: { rarity: def.rarity ?? "common" }, style: `--el:${app.elementColor(def.element)}`, title: [def.name, ...st.notes, ...(st.silenced ? [] : describe(def)), help].filter(Boolean).join("\n") },
      h("div", { class: "u-ring" }, artBox(def, "u-art")),
      st.frozen ? h("span", { class: "u-ice" }) : null,
      st.silenced ? h("span", { class: "u-mute" }, icon("mute")) : null,
      h("span", { class: `u-atk tabnum${u.atk > (def.attack ?? 0) ? " up" : ""}${auraAtk ? " aura" : ""}`, text: u.atk }),
      h("span", { class: `u-hp tabnum${u.hp < (def.health ?? 0) ? " hurt" : u.hp > (def.health ?? 0) ? " up" : ""}${auraHp ? " aura" : ""}`, text: u.hp }),
      auraAtk ? h("span", { class: "u-aura a" }) : null,
      auraHp ? h("span", { class: "u-aura h" }) : null,
      h("span", { class: "u-name", text: def.name }),
      tags.length ? h("span", { class: "u-kw" }, ...tags.slice(0, 2).map((k) => h("i", { class: st.silenced ? "off" : null, text: k }))) : null);
    el.setAttribute("aria-label", st.label);
    return el;
  }

  /** A collection token as a champion: Rapture Chess's framed card, rarity by Kind, element gem and foil. */
  function championCard(c, { tag = "div", owned = false, locked = false, eager = false, tilted = false } = {}) {
    const def = tokenCard.get(String(c.tokenId));
    const rarity = def?.rarity ?? KIND_RARITY[c.kind] ?? "common";
    const el = h(tag, { class: "ccard", data: { rarity }, style: `--el:${app.elementColor(String(c.element ?? "").toLowerCase())}`, ...(tag === "button" ? { type: "button", title: c.name } : {}) },
      h("div", { class: "inner" },
        h("div", { class: "art" }, c.art ? h("img", { src: c.art, alt: c.name, loading: eager ? "eager" : "lazy", decoding: "async", draggable: false, on: { load: (e) => { const img = e.currentTarget; Promise.resolve(img.decode?.()).catch(() => {}).then(() => { img.dataset.loaded = "1"; }); } } }) : icon("user"),
          h("span", { class: "kind", text: c.kind ?? RARITY_NAME[rarity] }), h("span", { class: "gem", title: c.element ?? "" })),
        h("div", { class: "cplate" }, h("div", { class: "name", text: c.name }), h("div", { class: "sub", text: [c.element, c.faction].filter(Boolean).join(" · ") }))),
      h("span", { class: "foil" }),
      owned ? h("span", { class: "badge owned" }, icon("check"), "Held") : null,
      locked ? h("span", { class: "lock", title: "Locked" }, icon("lock")) : null);
    if (locked) { el.classList.add("locked"); el.setAttribute("aria-label", `${c.name}, locked`); }
    if (tilted || tag === "button") tilt(el);
    return el;
  }

  return { cardFace, unitToken, championCard, describe, RARITY_NAME, rarityOf: (c) => tokenCard.get(String(c.tokenId))?.rarity ?? KIND_RARITY[c.kind] ?? "common" };
}
