// The battle's choreography: what a change of state looks like. Read before the lanes redraw (where every unit, card
// and portrait is on screen), played after (the redrawn tokens animate, the fallen leave burning copies behind):
// a played unit flies in from the card, an attacker lunges and its blow lands with a slash, a spell's bolt flies to
// its target, struck units shake, healed ones glow, frozen ones ice over, silenced ones hush, bounced ones fly back to
// their owner's hand, gaps close. Effects land when the action's sound does (landOf).
// The primitives are ui/battle/vfx.js's; the rules are untouched: everything here is read from two states.
import { decode, Op, ENEMY_CHAMPION, OWN_CHAMPION } from "../../engine/tessaract.js";
import { createVfx, ELEMENT_HEX, HIT_HEX, HEAL_HEX, SHIELD_HEX, FROST_HEX, SILENCE_HEX, center, base, later } from "./vfx.js";

/** When an action's blow lands after it starts (ms): attacks quickly, cards as they arrive, hero powers after a charge. */
export function landOf(before, s, game) {
  const x = s.last ? decode(s.last) : null;
  if (!before || !x) return 0;
  if (x.op === Op.Attack) return 200;
  if (x.op === Op.Play) return game.cards[before.p[before.turn].hand[x.a]]?.type === "unit" ? 450 : 440;
  if (x.op === Op.Power) return 720;
  return 0;
}

/** The units an action most likely destroyed (its attacker, its target), per side: to tell two copies of a card apart. */
export function suspects(before, s) {
  const out = [new Set(), new Set()];
  const x = s.last ? decode(s.last) : null;
  if (!before || !x || before.turn > 1) return out;
  const actor = before.turn, other = 1 - actor;
  if (x.op === Op.Attack) out[actor].add(x.a);
  if (x.op === Op.Attack || x.op === Op.Play || x.op === Op.Power) {
    if (x.target > ENEMY_CHAMPION && x.target < OWN_CHAMPION) out[other].add(x.target - 1);
    else if (x.target > OWN_CHAMPION) out[actor].add(x.target - OWN_CHAMPION - 1);
  }
  return out;
}

/**
 * One side's board before and after a change: which units left it, where each of the rest went, and where the new
 * ones start. The rules keep the board in order (the dead are filtered out, new units join at the end); between two
 * copies of a card, the suspects and the most hurt fell first. Null when the boards don't fit that (a jump in a replay).
 */
export function alignBoards(before, after, prefer = new Set()) {
  const gone = new Map();
  for (const u of before) gone.set(u.c, (gone.get(u.c) ?? 0) + 1);
  for (const u of after) gone.set(u.c, (gone.get(u.c) ?? 0) - 1);
  const order = before.map((_, i) => i).sort((i, j) => Number(prefer.has(j)) - Number(prefer.has(i)) || before[i].hp - before[j].hp || i - j);
  const dead = new Set();
  for (const i of order) { const c = before[i].c; if (gone.get(c) > 0) { dead.add(i); gone.set(c, gone.get(c) - 1); } }
  const to = new Map();
  let j = 0;
  for (let i = 0; i < before.length; i++) {
    if (dead.has(i)) continue;
    if (after[j]?.c !== before[i].c) return null;
    to.set(i, j++);
  }
  return { dead, to, born: j };
}

/**
 * Which of a side's fallen units were bounced to its hand instead (a Set of before-board indices): the copies of a card
 * that its hand gained, beyond the card it played. The rules don't say which; a draw of the same card can look like one,
 * so callers ask only in games that can bounce.
 */
export function bouncedOf(before, s, side, dead) {
  const out = new Set();
  if (!dead?.size) return out;
  const x = s.last ? decode(s.last) : null;
  const count = (hand, c) => hand.reduce((n, h) => n + (h === c ? 1 : 0), 0);
  const played = x?.op === Op.Play && before.turn === side ? before.p[side].hand[x.a] : undefined;
  const back = new Map();
  for (const k of dead) {
    const c = before.p[side].board[k].c;
    if (!back.has(c)) back.set(c, count(s.p[side].hand, c) - count(before.p[side].hand, c) + (played === c ? 1 : 0));
    if (back.get(c) > 0) { out.add(k); back.set(c, back.get(c) - 1); }
  }
  return out;
}

export function createBattleFx(root, arena, game) {
  const vfx = createVfx(root, arena);
  const bounces = JSON.stringify(game).includes('"op":"bounce"');
  const elHex = (def) => ELEMENT_HEX[def?.element] ?? ELEMENT_HEX.neutral;
  const hexOf = (c) => elHex(game.cards[c]);
  const units = (lane) => [...lane.children].filter((n) => n.classList.contains("unit"));
  const seen = (r) => (r && r.width > 0 ? r : null);
  const rectOf = (n) => seen(n?.getBoundingClientRect());

  /**
   * Before the lanes redraw: read where things are. `view` has lane(side), plate(side), mine(side) and the hand / foe
   * hand nodes. Returns the show to run once they have redrawn, or null when the screen isn't drawing `before`.
   */
  function capture(before, s, aligned, view) {
    if (!root.getClientRects().length) return null;
    const x = s.last ? decode(s.last) : null;
    const actor = before.turn, other = 1 - actor;
    const old = [0, 1].map((i) => units(view.lane(i)).map((node) => ({ node, rect: node.getBoundingClientRect() })));
    if (old.some((o, i) => o.length !== before.p[i].board.length)) return null;
    const oldHand = [...view.hand.children].map((n) => n.getBoundingClientRect());
    const portrait = (i) => rectOf(view.plate(i).portrait);
    const unitRect = (i, k) => seen(old[i][k]?.rect);
    const lifeDrop = (i) => s.p[i].life < before.p[i].life;
    const land = landOf(before, s, game);

    // the action: its card, where it came from, and what it aimed at
    let card = null, from = null, aim = null;
    if (x?.op === Op.Play) {
      card = game.cards[before.p[actor].hand[x.a]] ?? null;
      from = view.mine(actor) ? rectOf(view.hand.children[x.a]) : rectOf(view.foeHand) ?? portrait(actor);
    } else if (x?.op === Op.Power) from = rectOf(view.plate(actor).power.firstElementChild) ?? portrait(actor);
    if (x && (x.op === Op.Attack || x.op === Op.Play || x.op === Op.Power)) {
      const t = x.target;
      // 0 is both "the enemy champion" and "no target": the champion only when its life fell (or it was attacked)
      aim = t > ENEMY_CHAMPION && t < OWN_CHAMPION ? { side: other, unit: t - 1, rect: unitRect(other, t - 1) }
        : t > OWN_CHAMPION ? { side: actor, unit: t - OWN_CHAMPION - 1, rect: unitRect(actor, t - OWN_CHAMPION - 1) }
          : t === OWN_CHAMPION ? { side: actor, rect: portrait(actor) }
            : x.op === Op.Attack || lifeDrop(other) ? { side: other, rect: portrait(other) } : null;
      if (aim && !aim.rect) aim = null;
    }

    return function show() {
      const now = [0, 1].map((i) => units(view.lane(i)));
      const struck = new Set();   // "side:unit" (or "side:champ") already flashed by the action itself
      const key = (a) => `${a.side}:${a.unit ?? "champ"}`;

      // the fallen: still copies where they stood, burnt away when the blow lands. The survivors close the gaps after
      // that; on a side that only gained a unit they make room for it at once.
      const ghosts = [[], []];
      const wait = [0, 1].map((i) => (aligned[i]?.dead.size ? land + 160 : 0));
      const bounced = [0, 1].map((i) => (bounces ? bouncedOf(before, s, i, aligned[i]?.dead) : new Set()));
      for (const i of [0, 1]) {
        for (const k of aligned[i]?.dead ?? []) ghosts[i][k] = vfx.ghost(old[i][k]?.node, old[i][k]?.rect);
        for (const [k, j] of aligned[i]?.to ?? []) vfx.flip(now[i][j], old[i][k]?.rect, wait[i]);
      }
      // the hand closes round a played card, or spreads for drawn ones (those are dealt in by their own entrance)
      const played = x?.op === Op.Play && view.mine(actor) ? x.a : -1;
      const kept = Math.min(view.hand.children.length, oldHand.length - (played >= 0 ? 1 : 0));
      for (let i = 0; i < kept; i++) vfx.flip(view.hand.children[i], oldHand[played >= 0 && i >= played ? i + 1 : i], 0, 1);

      if (x?.op === Op.Attack && aim) {
        const k = x.a, j = aligned[actor]?.to.get(k), hex = hexOf(before.p[actor].board[k]?.c);
        // a dead attacker lunges as its ghost (flat, over the board), a live one as its token
        if (j !== undefined) vfx.lunge(now[actor][j], old[actor][k]?.rect, aim.rect);
        else vfx.lunge(ghosts[actor][k], old[actor][k]?.rect, aim.rect, { tilt: 1 });
        const a = center(old[actor][k]?.rect ?? aim.rect), b = center(aim.rect);
        later(land, () => {
          vfx.slash(b, hex, Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2 + 0.45, Math.max(90, aim.rect.width * 1.3));
          vfx.pop(b, HIT_HEX, "hit", { size: 1.1, table: aim.unit !== undefined ? base(aim.rect) : null });
        });
        struck.add(key(aim));
      } else if (x?.op === Op.Play && card?.type === "unit") {
        // the played unit is the first new one on the actor's side: from the card to its slot, landing with a ring
        const n = now[actor][aligned[actor]?.born ?? -1];
        if (n) {
          vfx.arrive(n, from, { ms: land });
          later(vfx.still() ? 0 : land, () => { const r = rectOf(n); if (r) vfx.pop(base(r), elHex(card), "play", { size: 1.1, table: base(r) }); });
          struck.add(`${actor}:new`);
        }
        // its on-play effect, aimed: a bolt from the card to the target as the unit lands
        if (aim && from) {
          vfx.bolt(center(from), center(aim.rect), elHex(card), 80, land - 80);
          later(land, () => vfx.pop(center(aim.rect), elHex(card), "spell", { size: 1, table: aim.unit !== undefined ? base(aim.rect) : null }));
          struck.add(key(aim));
        }
      } else if (x && (x.op === Op.Play || x.op === Op.Power)) {
        // a spell or a power: a bolt from the card (or the power) to the target, or a burst over the table
        const hex = x.op === Op.Power ? ELEMENT_HEX[view.plate(actor).el.dataset.el] ?? ELEMENT_HEX.neutral : elHex(card);
        const start = x.op === Op.Power ? 300 : 80;
        if (x.op === Op.Power && from) vfx.pop(center(from), hex, "spell", { size: 0.7 });
        if (card?.type === "relic") later(land, () => { const r = rectOf(view.plate(actor).relics.lastElementChild); if (r) vfx.pop(center(r), hex, "play", { size: 0.8 }); });
        else if (aim && from) {
          vfx.bolt(center(from), center(aim.rect), hex, start, land - start);
          later(land, () => vfx.pop(center(aim.rect), hex, "spell", { size: 1.1, table: aim.unit !== undefined ? base(aim.rect) : null }));
          struck.add(key(aim));
        } else {
          const m = rectOf(view.mat);
          if (m) later(land, () => vfx.pop(center(m), hex, "spell", { size: 1.8, table: center(m) }));
        }
      }

      // units summoned by the move (beyond the one played): hidden until the gaps have closed, then they rise in a ring
      for (const i of [0, 1]) for (let j = aligned[i]?.born ?? now[i].length; j < now[i].length; j++) {
        if (i === actor && j === aligned[i].born && struck.has(`${actor}:new`)) continue;
        const n = now[i][j], at = Math.max(land, wait[i] + 140);
        vfx.appear(n, at);
        later(at, () => { const r = rectOf(n); if (r) vfx.pop(base(r), hexOf(s.p[i].board[j].c), "play", { size: 0.9, table: base(r) }); });
      }

      later(land, () => {
        // the fallen burn; the bounced fly back to their owner's hand
        for (const i of [0, 1]) for (const k of aligned[i]?.dead ?? []) {
          const g = ghosts[i][k], r = old[i][k]?.rect;
          if (!g || !r) continue;
          if (bounced[i].has(k)) {
            g.recall(view.mine(i) ? rectOf(view.hand) : rectOf(view.foeHand));
            vfx.pop(center(r), hexOf(before.p[i].board[k].c), "bounce", { size: 1, table: base(r) });
            continue;
          }
          g.burn();
          vfx.pop(center(r), hexOf(before.p[i].board[k].c), "death", { size: 1.2, table: base(r) });
        }
        // the survivors: hurt, healed, strengthened, shields broken
        for (const i of [0, 1]) for (const [k, j] of aligned[i]?.to ?? []) {
          const a = before.p[i].board[k], b = s.p[i].board[j], n = now[i][j], r = rectOf(n);
          if (!a || !b || !r) continue;
          if (b.hp < a.hp) { vfx.shake(n); if (!struck.has(`${i}:${k}`)) vfx.pop(center(r), HIT_HEX, "hit", { size: 0.75, table: base(r) }); }
          else if (b.hp > a.hp) { vfx.glow(n, "heal"); vfx.pop(center(r), HEAL_HEX, "heal", { size: 0.8, table: base(r) }); }
          if (b.atk > a.atk) vfx.glow(n, "buff");
          if (a.shield && !b.shield) vfx.pop(center(r), SHIELD_HEX, "hit", { size: 0.9 });
          // frozen (or frozen for longer), silenced
          if (b.frozen !== undefined && (a.frozen === undefined || b.frozen > a.frozen)) { vfx.glow(n, "frost"); vfx.pop(center(r), FROST_HEX, "frost", { size: 0.9, table: base(r) }); }
          if (b.silenced && !a.silenced) { vfx.glow(n, "silence"); vfx.pop(center(r), SILENCE_HEX, "silence", { size: 0.9, table: base(r) }); }
        }
        // the champions: a blow or a healing on the portrait (off the table: 2D sparks)
        for (const i of [0, 1]) {
          const d = s.p[i].life - before.p[i].life, r = portrait(i);
          if (!d || !r || struck.has(`${i}:champ`)) continue;
          vfx.pop(center(r), d < 0 ? HIT_HEX : HEAL_HEX, d < 0 ? "hit" : "heal", { size: d < 0 ? 1.2 : 1 });
        }
      });
    };
  }

  return { capture, vfx };
}
