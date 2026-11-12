// The battle: Rapture Chess's match HUD over the arena. Plates for both champions, the two lanes on the dais, your hand
// fanned along the bottom, the turn medallion and the narration, and the dock; the parts live in ui/battle/ (plates,
// overlays, the battle menu, inspect, the view dock, the VFX, narration and sound cues, the result). This screen holds
// the match's state and draws it. The rules decide everything: the HUD only asks them what is legal and draws the state.
import { decode, Op, enemyUnit, ownUnit, endTurn, PuzzleSession } from "../../engine/tessaract.js";
import { h, icon, toast } from "../dom.js";
import { createResult } from "../battle/result.js";
import { runeRing } from "../battle/runes.js";
import { createAim } from "../battle/aim.js";
import { createBattleFx, alignBoards, suspects, landOf } from "../battle/fx.js";
import { later } from "../battle/vfx.js";
import { createPlate } from "../battle/plate.js";
import { createOverlays } from "../battle/overlays.js";
import { createBattleMenu } from "../battle/menu.js";
import { createInspector } from "../battle/inspect.js";
import { createViewbar } from "../battle/viewbar.js";
import { narration, playCues, playerName, possessive } from "../battle/story.js";

export function matchScreen(app) {
  const { game, rules } = app;
  let session = null, ctx = {}, pick = null, prev = null, recent = [], announcedTurn = null, finishedOnce = false;
  let tally = null;   // this match's numbers for the result screen, counted as states arrive
  let heartbeat = null;   // stops the low-life heartbeat
  const replaying = () => session?.role === "replay";
  const viewing = () => !!session && session.role !== "player";

  // ------------------------------------------------------------------ layout
  // the card inspector opens on the screen's root, which is built after the plates (they need the inspector)
  let el = null;
  const inspector = createInspector({ append: (n) => el.append(n) }, app);
  const { inspectable } = inspector;
  const foeP = createPlate(app, "top", { inspectable }), meP = createPlate(app, "bottom", { inspectable });
  const medallion = h("div", { class: "medallion" }, h("i", { class: "md-ring" }), h("span", { class: "md-text" }));
  const status = h("p", { class: "hud-status", role: "status", aria: { live: "polite" } });
  const foeLane = h("div", { class: "lane foe-lane", aria: { label: "Opponent units" } });
  const myLane = h("div", { class: "lane my-lane", aria: { label: "Your units" } });
  const hand = h("div", { class: "hand", aria: { label: "Your hand" } });
  // phones: the hand scrolls sideways, four cards to a screen; a chip at its edge counts the cards past it (it read as
  // the whole hand), and a tap scrolls to them (styled for phones only)
  const handMore = h("button", { class: "hand-more", type: "button", hidden: true, aria: { label: "More cards in your hand" }, on: { click: () => hand.scrollBy({ left: hand.clientWidth * 0.75, behavior: "smooth" }) } });
  const markHandMore = () => {
    const edge = hand.getBoundingClientRect().right;
    const past = [...hand.children].filter((c) => c.getBoundingClientRect().left + c.offsetWidth / 2 > edge).length;
    handMore.hidden = !past;
    handMore.textContent = past ? `+${past}` : "";
  };
  hand.addEventListener("scroll", markHandMore, { passive: true });
  // phones show only card names in the hand: this strip reads out the picked card's rules (styled for phones only)
  const pickInfo = h("p", { class: "pick-info", aria: { live: "polite" } });
  const endBtn = h("button", { class: "end-turn", type: "button", on: { click: () => act(endTurn()) } }, h("span", { class: "et-ring" }), h("span", { class: "et-label display", text: "End turn" }));
  const menuBtn = h("button", { class: "icon-btn", type: "button", title: "Battle menu (Esc)", aria: { label: "Battle menu" }, on: { click: () => menu.open() } }, icon("menu"));
  const dock = h("div", { class: "dock" }, h("i", { class: "et-gear", aria: { hidden: "true" } }), menuBtn, endBtn);
  // On a phone, End turn sits in your plate and the menu in the enemy's, clear of the board.
  const phone = matchMedia("(max-width: 760px)");
  const placeControls = () => {
    if (phone.matches) { meP.el.append(endBtn); foeP.el.append(menuBtn); } else dock.append(menuBtn, endBtn);
  };
  phone.addEventListener("change", placeControls);
  const overlays = createOverlays(app);
  const result = createResult(app);
  const viewbar = createViewbar(app, { session: () => session, flip: () => flip() });
  const mat = h("div", { class: "table-mat", aria: { hidden: "true" } }, h("i", { class: "tm-ring" }), h("i", { class: "tm-seat foe" }), h("i", { class: "tm-seat you" }));
  // the lanes' extent in the mat's coordinates: layout offsets (untouched by the board's 3D tilt), summed up to the
  // board, since a lane with preserve-3d is its own children's offset parent
  const offsetIn = (node, root) => {
    let x = 0, y = 0;
    for (let n = node; n && n !== root; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return { x, y };
  };
  const laneRect = (lane) => {
    const kids = lane.children;
    if (!kids.length) return null;
    const a = offsetIn(kids[0], board), b = offsetIn(kids[kids.length - 1], board);
    return { x: a.x - mat.offsetLeft, y: a.y - mat.offsetTop, w: b.x + kids[kids.length - 1].offsetWidth - a.x, h: kids[0].offsetHeight };
  };
  const board = h("div", { class: "battlefield" }, mat, foeLane, h("div", { class: "lane-line" }), myLane);
  const ring = runeRing(mat, () => [laneRect(foeLane), laneRect(myLane)]);
  // tell the 3D arena where the board's mat is on screen, so its stone table lies exactly under it (only on change)
  let lastBoard = "";
  const fitBoard = () => {
    const r = mat.getBoundingClientRect(), key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key === lastBoard || !r.width) return;
    lastBoard = key;
    app.arena.setBoard(r);
  };
  addEventListener("resize", () => requestAnimationFrame(() => { fitBoard(); markHandMore(); }));
  el = h("section", { class: "match", aria: { label: "Battle" } },
    overlays.fx, foeP.el, h("div", { class: "hud-center" }, medallion, status), board, meP.el, pickInfo, hand, handMore, dock, overlays.feed, overlays.cine, viewbar.el, result.el);
  const aim = createAim(el);   // the targeting arrow from whatever is picked (see ui/battle/aim.js)
  const bfx = createBattleFx(el, app.arena, game);   // what each move looks like (see ui/battle/fx.js)
  const menu = createBattleMenu(app, el, { session: () => session, ctx: () => ctx, viewing, blocked: () => result.open });

  /** Empty slot plates either side of a side's units (units fill from the centre), so the board shows its shape. */
  const slot = () => h("div", { class: "slot", aria: { hidden: "true" } });
  const framed = (units) => {
    const empty = Math.max(0, (game.rules.boardSlots ?? 5) - units.length);
    return [...Array.from({ length: Math.floor(empty / 2) }, slot), ...units, ...Array.from({ length: Math.ceil(empty / 2) }, slot)];
  };

  // ------------------------------------------------------------------ helpers
  const act = (x) => { pick = null; session?.act(x); };
  const champOf = (id) => app.byToken.get(String(session?.champions?.[id]?.tokenId)) ?? null;
  const cardName = (c) => game.cards[c]?.name ?? "a card";
  /** Add a line about what just happened to the narration (the last two show). */
  function narrate(before, s, meIdx) {
    const line = narration(game, before, s, meIdx, viewing());
    if (line) recent = [...recent, line].slice(-2);
  }

  /** What changed between two states: floaters, a quake on a hit to you, the fallen feed, and the result tally. */
  function effects(before, s, meIdx, live) {
    if (!before || before.p[meIdx].id !== s.p[meIdx].id) return;
    const foeIdx = meIdx === 0 ? 1 : 0;
    const land = live ? landOf(before, s, game) : 0;   // live, the numbers come up when the blow lands
    for (const [idx, p] of [[meIdx, meP], [foeIdx, foeP]]) {
      const d = s.p[idx].life - before.p[idx].life;
      if (d < 0) later(land, () => { p.floater(String(d), "dmg"); if (live && idx === meIdx) app.arena.quake(); });
      else if (d > 0) later(land, () => p.floater(`+${d}`, "heal"));
    }
    // Units that left the board: compare the multiset of cards on each side.
    let died = 0;
    for (const idx of [meIdx, foeIdx]) {
      const after = new Map();
      for (const u of s.p[idx].board) after.set(u.c, (after.get(u.c) ?? 0) + 1);
      for (const u of before.p[idx].board) {
        const n = after.get(u.c) ?? 0;
        if (n > 0) after.set(u.c, n - 1);
        else { died++; if (live) overlays.fallen(game.cards[u.c], idx === foeIdx); if (tally && idx === foeIdx) tally.kills++; }
      }
    }
    if (live) playCues(app, game, before, s, meIdx, died);
    if (tally) {
      tally.dealt += Math.max(0, before.p[foeIdx].life - s.p[foeIdx].life);
      tally.taken += Math.max(0, before.p[meIdx].life - s.p[meIdx].life);
      if (s.last && decode(s.last).op === Op.Play && before.turn === meIdx) tally.played++;
    }
  }

  // ------------------------------------------------------------------ render
  function render() {
    const s = session?.state;
    if (!s) { status.textContent = session?.status ?? ""; medallion.querySelector(".md-text").textContent = "Waiting"; viewbar.render(null); return; }
    const watching = viewing();
    const meIdx = s.p[0].id === session.you ? 0 : 1;
    if (s.phase === "decks") {
      // Two-player: waiting for both declarations (the relay fills a missing deck with the suggested one at its deadline).
      for (const n of [foeLane, myLane, hand, foeP.relics, meP.relics]) n.replaceChildren();
      const [a, b] = watching ? [playerName(s.p[meIdx].id), playerName(s.p[1 - meIdx].id)] : ["You", "Opponent"];
      medallion.querySelector(".md-text").textContent = "Declaring decks";
      status.textContent = `${a} ${s.decl[meIdx].length}/${game.deckRules?.size ?? 0} · ${b} ${s.decl[1 - meIdx].length}/${game.deckRules?.size ?? 0}`;
      endBtn.disabled = true;
      viewbar.render(s);
      return;
    }
    const me = s.p[meIdx], foe = s.p[meIdx === 0 ? 1 : 0];
    foeP.table(foe);
    meP.table(me);
    // A replay can jump anywhere: compare with the state just before the cursor, and narrate the last moves.
    const before = replaying() ? session.states[session.cursor - 1] ?? null : prev;
    // the units on screen (the last state drawn) against this state's: who fell, where the rest went, who is new. A
    // move played live (or a replay playing on) is shown before the lanes redraw: where everything is now.
    const shown = prev && prev.phase !== "decks" && prev.p[meIdx].id === s.p[meIdx].id ? prev : null;
    const doubt = shown ? suspects(shown, s) : null;
    const aligned = [0, 1].map((i) => (shown ? alignBoards(shown.p[i].board, s.p[i].board, doubt[i]) : null));
    const isNew = (i, slot) => (aligned[i] ? slot >= aligned[i].born : !shown || slot >= shown.p[i].board.length);
    const show = shown && s !== shown && (!replaying() || (session.playing && before === shown))
      ? bfx.capture(shown, s, aligned, { lane: (i) => (i === meIdx ? myLane : foeLane), plate: (i) => (i === meIdx ? meP : foeP), mine: (i) => i === meIdx, hand, foeHand: foeP.fan, mat })
      : null;
    if (replaying()) {
      recent = [];
      for (let k = Math.max(session.playStart + 1, session.cursor - 1); k <= session.cursor; k++) narrate(session.states[k - 1], session.states[k], meIdx);
      if (before && session.cursor > session.playStart) effects(before, s, meIdx, session.playing);
    } else if (s !== prev) { narrate(prev, s, meIdx); effects(prev, s, meIdx, true); }
    prev = s;

    const myTurn = !watching && !s.over && s.turn === meIdx;
    const moves = (myTurn ? rules.legalActions(s) : []).map((x) => ({ x, ...decode(x) }));
    const targets = new Map();   // target code -> action, for the current pick
    const pickOp = { hand: Op.Play, unit: Op.Attack, power: Op.Power };
    if (pick) for (const m of moves) if (m.op === pickOp[pick.kind] && m.a === pick.index) targets.set(m.target, m.x);

    const foeChamp = watching ? champOf(foe.id) : ctx.foe ?? champOf(foe.id);
    const myChamp = watching ? champOf(me.id) : ctx.mine ?? null;
    const plays = { moves, targets, act, onPower: () => { pick = pick?.kind === "power" ? null : { kind: "power", index: 0 }; render(); } };
    foeP.render(foe, foeChamp, watching ? playerName(foe.id) : ctx.foeLabel ?? ctx.opponent ?? "Opponent", { ...plays, mine: false, foe: true, powerPicked: false });
    meP.render(me, myChamp, watching ? playerName(me.id) : "You", { ...plays, mine: true, foe: false, powerPicked: pick?.kind === "power" });
    foeP.el.classList.toggle("active", !s.over && s.turn !== meIdx);
    meP.el.classList.toggle("active", !s.over && s.turn === meIdx);
    const low = (p) => !s.over && p.life <= Math.max(5, Math.round(p.maxLife * 0.25));
    foeP.el.classList.toggle("low", low(foe));
    meP.el.classList.toggle("low", low(me));
    const danger = !watching && !replaying() && low(me);
    el.classList.toggle("danger", danger);
    if (danger !== !!heartbeat) { heartbeat?.(); heartbeat = danger ? app.sound?.pulse("heartbeat", 1.3) ?? null : null; }   // your champion's heart, while life is low

    const foeIdx = meIdx === 0 ? 1 : 0;
    foeLane.replaceChildren(...framed(foe.board.map((u, slot) => {
      const b = inspectable(app.cards.unitToken(game.cards[u.c], u), game.cards[u.c]);
      if (!isNew(foeIdx, slot)) b.classList.add("stay");   // only a unit new to the board plays its entrance
      const x = targets.get(enemyUnit(slot));
      if (x !== undefined) { b.classList.add("target"); b.addEventListener("click", () => act(x)); }
      return b;
    })));
    myLane.replaceChildren(...framed(me.board.map((u, slot) => {
      const b = inspectable(app.cards.unitToken(game.cards[u.c], u), game.cards[u.c]);
      if (!isNew(meIdx, slot)) b.classList.add("stay");
      const buff = targets.get(ownUnit(slot));
      const canAttack = moves.some((m) => m.op === Op.Attack && m.a === slot);
      if (buff !== undefined) { b.classList.add("target", "ally"); b.addEventListener("click", () => act(buff)); }
      else if (canAttack) {
        b.classList.add("can");
        if (pick?.kind === "unit" && pick.index === slot) b.classList.add("picked");
        b.addEventListener("click", () => { pick = pick?.kind === "unit" && pick.index === slot ? null : { kind: "unit", index: slot }; render(); });
      }
      return b;
    })));
    const n = me.hand.length;
    // the cards already in hand stay put on a redraw (a move, a pick); only cards new to it are dealt in
    const lx = shown && s !== shown && s.last ? decode(s.last) : null;
    const kept = !shown ? 0 : Math.min(n, shown.p[meIdx].hand.length - (lx?.op === Op.Play && shown.turn === meIdx ? 1 : 0));
    hand.style.setProperty("--n", String(Math.max(1, n)));
    hand.replaceChildren(...me.hand.map((c, index) => {
      const def = game.cards[c];
      const b = inspectable(app.cards.cardFace(def, { tag: "button" }), def);
      b.style.setProperty("--i", String(index - (n - 1) / 2));
      if (index < kept) b.classList.add("stay");
      const plays = moves.filter((m) => m.op === Op.Play && m.a === index);
      if (watching) return b;   // spectators and replays see the hand (open information) but don't play it
      if (!plays.length) { b.classList.add("dead"); b.setAttribute("aria-disabled", "true"); return b; }
      b.classList.add("can");
      if (pick?.kind === "hand" && pick.index === index) b.classList.add("picked");
      // A card needs a target pick when the rules offer more than one, or one that isn't the default (0).
      const aimed = plays.length > 1 || plays[0].target !== 0;
      b.addEventListener("click", () => {
        if (!aimed) { act(plays[0].x); return; }
        pick = pick?.kind === "hand" && pick.index === index ? null : { kind: "hand", index };
        render();
      });
      return b;
    }));
    hand.style.setProperty("--n", String(n));
    show?.();   // the move's VFX, on the redrawn board
    el.classList.toggle("aiming", !!pick);
    const picked = pick?.kind === "hand" ? game.cards[me.hand[pick.index]] : null;
    if (picked) {
      const lines = app.cards.describe(picked);
      pickInfo.replaceChildren(h("b", { text: picked.name }), lines.length ? ` · ${lines.join(" · ")}` : "");
    } else pickInfo.textContent = watching || s.turnNo > 3 ? "" : "Tap a card to play it · hold it to read it";   // a first-turns hint, not a fixture
    requestAnimationFrame(() => { ring.refresh(); fitBoard(); aim.update(pick ? el.querySelector(".hand .tcard.picked, .unit.picked, .power.picked") : null); markHandMore(); });   // after layout: the rune circle, the 3D table, the arrow, the hand's "more" chip

    endBtn.disabled = !myTurn;
    endBtn.classList.toggle("ready", myTurn && !moves.some((m) => m.op !== Op.End));
    const watchingTurn = replaying() ? `Replay · turn ${s.turnNo}` : watching ? `${possessive(playerName(s.p[s.turn].id))} turn` : null;
    const outcome = s.winner === 2 ? "A draw" : s.winner >= 0 ? `${watching ? playerName(s.p[s.winner].id) : s.winner === meIdx ? "You" : "Opponent"} won` : "";
    medallion.querySelector(".md-text").textContent = s.over ? outcome : watchingTurn ?? (myTurn ? `Your turn · ${s.turnNo}` : `Enemy turn · ${s.turnNo}`);
    medallion.classList.toggle("yours", myTurn);
    medallion.dataset.side = s.turn === meIdx ? "0" : "1";
    const hint = !myTurn ? "" : pick?.kind === "hand" ? `Choose a target for ${cardName(me.hand[pick.index])}` : pick?.kind === "power" ? "Choose a target for your hero power" : pick?.kind === "unit" ? "Choose what to attack" : "";
    meP.prompt.textContent = hint;
    status.textContent = hint || recent.join(" · ") || (replaying() ? "" : session.status && !/^practice|^live$|^watching|^puzzle$/.test(session.status) ? session.status : "");

    // Turn banners, live only.
    if (!replaying() && !s.over && announcedTurn !== `${s.turnNo}`) {
      announcedTurn = `${s.turnNo}`;
      if (myTurn) { overlays.banner("Your turn", `Turn ${s.turnNo}`); if (s.turnNo > 1) app.sound?.play("turn-yours", { delay: 0.2 }); }   // turn 1 has the war horn
      else if (!watching && ctx.kind === "relay") { overlays.banner("Enemy turn", "", "foe"); app.sound?.play("turn-foe"); }
    }
    viewbar.render(s);

    // Players and spectators get the result screen; a replay just stops on its last move. A puzzle ends with its turn.
    const puzzleState = session instanceof PuzzleSession ? app.puzzles.status(session.puzzle, s) : null;
    const finished = puzzleState ? puzzleState !== "playing" : s.over;
    if (finished && !replaying() && !finishedOnce) {
      finishedOnce = true;
      const won = puzzleState ? puzzleState === "solved" : s.winner === meIdx;
      const outcomeKind = puzzleState ? (won ? "win" : "loss") : s.winner === 2 ? "draw" : watching ? "win" : won ? "win" : "loss";
      overlays.flash(outcomeKind === "win" ? "victory" : outcomeKind === "loss" ? "defeat" : "victory");
      app.sound?.duck(0.2, 5, 3);
      app.sound?.play(s.winner === 2 && !puzzleState ? "draw" : outcomeKind === "loss" ? "defeat" : "victory", { delay: 0.35 });
      overlays.banner(puzzleState ? (won ? "Solved" : "Not this time") : s.winner === 2 ? "Draw" : watching ? (playerName(s.p[s.winner].id) === "You" ? "You win" : `${playerName(s.p[s.winner].id)} wins`) : won ? "Victory" : "Defeat", "", outcomeKind === "loss" ? "red" : "");
      const foeLabel = watching ? playerName(foe.id) : ctx.foeLabel ?? ctx.opponent ?? "Opponent";
      setTimeout(() => app.flows.finished({ session, state: s, meIdx, puzzleState, tally: { ...tally }, outcome: outcomeKind, watching, champion: myChamp, foe: foeChamp, foeLabel, mineLabel: watching ? playerName(me.id) : "You" }), 1400);
    } else if (s.over && !replaying() && ctx.kind === "relay" && !watching && result.open) {
      result.setDetail(`${s.turnNo} turns · ${me.life} life left · ${session.status}`);   // settlement status updates
    }
  }

  function flip() {
    if (replaying()) { session.flip(); return; }
    const ids = session?.state?.p.map((p) => p.id);
    if (ids) { session.you = ids.find((id) => id !== session.you); prev = null; render(); }
  }

  document.addEventListener("keydown", (e) => {
    if (el.hidden || e.target instanceof HTMLInputElement) return;
    if (e.key === "Escape") { if (inspector.close()) return; if (pick) { pick = null; render(); } else if (menu.isOpen) menu.close(); else menu.open(); return; }
    viewbar.key(e);
  });
  // A click on empty battlefield cancels a pick.
  board.addEventListener("click", (e) => { if (pick && (e.target === board || e.target.classList?.contains("lane"))) { pick = null; render(); } });

  return {
    id: "match", el, noBack: true,
    /** Attach a session. ctx: { kind: practice|gauntlet|puzzle|relay|replay|watch, label, opponent, detail, mine, foe } */
    attach(next, context) {
      session?.close?.();
      session = next; ctx = context; pick = null; prev = null; recent = []; announcedTurn = null; finishedOnce = false;
      tally = { dealt: 0, taken: 0, played: 0, kills: 0 };
      result.hide(); menu.close(); overlays.clear();
      viewbar.el.hidden = !viewing();
      dock.hidden = viewing();
      el.classList.toggle("viewing", viewing());
      session.onChange(render);
      placeControls();
      heartbeat?.(); heartbeat = null;
      if (!viewing()) { app.sound?.duck(0.45, 2, 2.5); app.sound?.play("match-start", { delay: 0.5 }); }
      render();
    },
    detach() { session?.close?.(); session = null; menu.close(); heartbeat?.(); heartbeat = null; },
    get session() { return session; },
    result,
    render,
    /** Retry a puzzle in place. */
    retry() { result.hide(); finishedOnce = false; prev = null; recent = []; tally = { dealt: 0, taken: 0, played: 0, kills: 0 }; session.retry(); },
    enter() { app.arena.setMood("battle"); lastBoard = ""; },   // resend the board: the 3D arena may have started since
    toast,
  };
}
