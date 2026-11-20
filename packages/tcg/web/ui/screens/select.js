// Champion select: the collection as framed cards, the chosen champion's numbers and hero power, the battlefield, and
// (practice) the bot's strength. The arena behind previews the champion's realm. With unlocks on (app.progression),
// champions the mode doesn't let the player use are drawn locked, and a new player first picks a starter here.
import { h, icon, stagger } from "../dom.js";
import { pageHead } from "../router.js";
import { REALMS, realmFor } from "../arena.js";
import { shopLink, unitAttackText, walletChip } from "../widgets.js";

const LEVELS = [[1, "Easy"], [2, "Normal"], [3, "Hard"]];
const MODE_COPY = {
  practice: ["Choose your champion", "Practice · against the house bot", "Enter the arena"],
  gauntlet: ["Choose your champion", "Gauntlet · a new run", "Begin the run"],
  relay: ["Choose your champion", "Two-player match", "Take your seat"],
  ranked: ["Choose your champion", "Ranked · on the LitNode ladder", "Find a match"],
  starter: ["Choose your first champion", "Your first champion", "Make it yours"],
};

export function selectScreen(app) {
  let mode = "practice", next = "practice", filter = "all", chosen = null;
  // a champion this mode won't let the player field (the starter pick shows only starters, all open)
  const locked = (c) => !!c && mode !== "starter" && !app.canUse(c.tokenId, mode);
  const grid = h("div", { class: "champ-grid" });
  const filters = h("div", { class: "seg filter-seg", role: "group", aria: { label: "Show" } });
  const detail = h("div", { class: "champ-detail panel frame" });
  const title = h("h1", { class: "display" });
  const kicker = h("span", { class: "kicker" });
  const confirm = h("button", { class: "btn primary lg block pulse", type: "button", on: { click: () => {
    if (mode === "starter") { app.flows.pickStarter(chosen, next); return; }
    // Ranked with a champion the wallet doesn't hold plays the base champion, as the relay would
    if (locked(chosen) && mode !== "ranked") return;
    void app.flows.confirmChampion(locked(chosen) ? null : chosen, { realm: app.prefs.realm, level: app.prefs.level, mode });
  } } });

  const stats = (c) => {
    const ch = app.rules.champion(app.statsOf(c));
    const m = app.game.champion;
    const reach = unitAttackText(app.game, ch.unitAttack);
    const row = (label, value, map, accent, title) => {
      const span = Math.max(1, map.max - map.min);
      // a stat that only counts to a few reads as pips (1 of 3), not a bar that is full at 1
      const scale = map.max <= 8
        ? h("div", { class: "pips", style: `--accent:${accent}`, aria: { label: `${value} of ${map.max}` } }, ...Array.from({ length: map.max }, (_, i) => h("i", { class: i < value ? "on" : "" })))
        : h("div", { class: "meter", style: `--accent:${accent}` }, h("i", { style: `--v:${Math.round(((value - map.min) / span) * 100)}%` }));
      return h("div", { class: "stat-row", title }, h("span", { class: "sr-k", text: label }), h("b", { class: "tabnum", text: value }), scale);
    };
    return h("div", { class: "stat-rows" },
      row("Life", ch.life, m.life, "var(--danger)"),
      row("Spell power", ch.spellPower, m.spellPower, "var(--mana)"),
      // with unitAttack.minCost the bonus skips cheap units: the label says so ("Unit attack, cost 4+")
      reach.minCost ? row(`Unit attack, cost ${reach.minCost}+`, ch.unitAttack, m.unitAttack, "var(--gold-2)", reach.text) : row("Unit attack", ch.unitAttack, m.unitAttack, "var(--gold-2)"),
      row("Opening hand", ch.openingHand, m.openingHand, "var(--ok)"));
  };

  const seg = (options, current, onPick) => h("div", { class: "seg" }, ...options.map(([v, label]) => h("button", { type: "button", class: current === v ? "on" : "", text: label, on: { click: () => onPick(v) } })));

  function renderDetail() {
    const c = chosen;
    const realmChoice = app.prefs.realm;
    const shownRealm = realmChoice === "auto" ? realmFor(c) : realmChoice;
    app.arena.setRealm(shownRealm);
    const power = c ? app.heroPowerOf(c) : null;
    detail.replaceChildren(h("div", { class: "cd-scroll" },
      h("div", { class: "cd-card" }, c ? app.cards.championCard(c, { owned: app.owned.has(String(c.tokenId)), locked: locked(c), eager: true, tilted: true }) : h("div", { class: "ccard base" }, h("div", { class: "inner" }, icon("emblem")))),
      h("div", { class: "cd-body" },
        h("span", { class: "eyebrow", text: c ? [c.element, c.kind].filter(Boolean).join(" · ") : "No champion" }),
        h("h2", { class: "display cd-name", text: c ? c.name : "The base champion" }),
        locked(c) ? h("p", { class: "hint locked-note" }, icon("lock"), h("span", { text: mode === "ranked" ? "Ranked fields the champions your wallet holds. Without this one you play the base champion." : "Locked. Win stages in the Gauntlet to unlock new champions, or hold this one's NFT." })) : null,
        c?.epithet ? h("p", { class: "epithet", text: c.epithet }) : h("p", { class: "hint", text: "Every stat at zero: the floor of each range." }),
        stats(c),
        power ? h("div", { class: "cd-power" }, h("span", { class: "eyebrow" }, "Hero power"), h("p", null, h("b", { text: `${power.name} · ${power.cost}` }), h("span", { text: power.text }))) : null,
        h("div", { class: "field" }, h("span", { text: `Battlefield · ${REALMS[shownRealm].name}${realmChoice === "auto" ? " (auto)" : ""}` }),
          seg([["auto", "Auto"], ["valhalla", REALMS.valhalla.name], ["underworld", REALMS.underworld.name]], realmChoice, (v) => { app.setPref("realm", v); renderDetail(); })),
        mode !== "relay" && mode !== "ranked" && mode !== "starter" ? h("div", { class: "field" }, h("span", { text: mode === "gauntlet" ? "Foes get stronger each stage" : "House bot" }),
          mode === "practice" ? seg(LEVELS, app.prefs.level, (v) => { app.setPref("level", v); renderDetail(); }) : null) : null)),
      h("div", { class: "cta-dock" }, confirm));
    const blocked = locked(c) && mode !== "ranked";
    confirm.disabled = blocked || (mode === "starter" && !c);
    confirm.classList.toggle("pulse", !blocked);
    confirm.replaceChildren(icon(blocked ? "lock" : "swords"), blocked ? "Locked" : locked(c) ? `${MODE_COPY[mode][2]} · base champion` : MODE_COPY[mode][2]);
  }

  function renderGrid() {
    filters.replaceChildren(...[["all", "All"], ["owned", `Held (${app.owned.size})`]].map(([v, label]) => h("button", { type: "button", class: filter === v ? "on" : "", text: label, on: { click: () => { filter = v; renderGrid(); } } })));
    filters.hidden = !app.hasWallet || mode === "starter";
    const starters = mode === "starter" ? new Set(app.progression?.starters ?? []) : null;
    // the champions the player can field first, the locked ones after them
    const list = app.snap.cards.filter((c) => (starters ? starters.has(String(c.tokenId)) : filter === "all" || app.owned.has(String(c.tokenId))))
      .map((c, i) => [c, i]).sort((a, b) => locked(a[0]) - locked(b[0]) || a[1] - b[1]).map(([c]) => c);
    grid.replaceChildren(...(list.length ? list : []).map((c) => {
      const b = app.cards.championCard(c, { tag: "button", owned: app.owned.has(String(c.tokenId)), locked: locked(c) });
      if (chosen === c) b.classList.add("chosen");
      b.addEventListener("click", () => { chosen = c; for (const x of grid.children) x.classList.toggle("chosen", x === b); renderDetail(); });
      return b;
    }));
    if (!list.length) {
      grid.append(h("p", { class: "lede empty", text: app.snap.cards.length ? `No ${app.snap.collection.name} cards in this wallet yet. Pick any champion under All.` : "This game has no NFT collection yet, so both sides fight with the base champion." }));
      if (app.shop && app.snap.cards.length) grid.append(shopLink(app, "btn empty-shop", icon("gem"), `Get packs at ${app.shop.label}`, icon("external")));
    }
    stagger(grid);
  }

  const el = h("section", { class: "page select" },
    h("div", { class: "page-scrim" }),
    pageHead("", "", walletChip(app)),
    h("div", { class: "select-wrap" },
      h("div", { class: "select-list" }, filters, grid),
      detail));
  el.querySelector(".page-title").replaceChildren(kicker, title);
  app.onWallet(() => { if (!el.hidden) renderGrid(); });

  return {
    id: "select", el,
    /** Open for a mode: "practice", "gauntlet", "ranked" or "relay"; or "starter", then `then` once one is picked. */
    setMode(m, then = "practice") { mode = m; next = then; },
    enter() {
      app.arena.setMood("menu");
      [title.textContent, kicker.textContent] = MODE_COPY[mode];
      if (mode === "starter") kicker.textContent = `Pick one ${app.progression?.kind ?? "champion"} to begin`;
      const pool = mode === "starter" ? app.snap.cards.filter((c) => app.progression?.starters.includes(String(c.tokenId))) : app.snap.cards;
      if (chosen && (!pool.includes(chosen) || locked(chosen))) chosen = null;
      chosen ??= pool.find((c) => !locked(c) && app.owned.has(String(c.tokenId))) ?? pool.find((c) => !locked(c)) ?? pool[0] ?? null;
      renderGrid();
      renderDetail();
    },
  };
}
