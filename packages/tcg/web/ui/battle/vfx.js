// Battle VFX primitives: 2D flash-style effects in a layer over the battle (starburst flashes, rings, slash streaks,
// a spell's bolt, a fallen unit's copy burning away), each flash paired with a particle burst on the 3D table under it
// (ui/arena.js → the arena worker), or 2D sparks where the 3D arena isn't running or the point is off the table.
// Unit animations use the individual `translate` / `scale` properties, composited additively, so they stack on each
// token's own 3D transform (its stance on the tilted board) and on each other. Reduced motion: flashes, no movement.
// What to play for a change of state is ui/battle/fx.js's to decide.

/** Each element's colour, for flashes and bursts. */
export const ELEMENT_HEX = { lava: 0xff6a2a, water: 0x4fb0ff, earth: 0x6fe08a, metal: 0xd8dde6, neutral: 0xffd27a };
export const HIT_HEX = 0xff5a3a, HEAL_HEX = 0x6fe08a, SHIELD_HEX = 0xfff0b0, FROST_HEX = 0xa8e8ff, SILENCE_HEX = 0xb9a4ff;
// the 3D table's bursts know the first five kinds; the rest throw the nearest one
const BURST_KIND = { frost: "spell", silence: "heal", bounce: "play" };
const css = (hex) => `#${hex.toString(16).padStart(6, "0")}`;
export const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
/** Where a standing unit meets the table (its base), for a burst on the 3D table. */
export const base = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height * 0.86 });
export const later = (ms, fn) => (ms > 0 ? setTimeout(fn, ms) : fn());

export function createVfx(root, arena) {
  const layer = document.createElement("div");
  layer.className = "vfx-layer";
  layer.setAttribute("aria-hidden", "true");
  root.append(layer);
  arena?.mountFx?.(layer);   // the 3D bursts' canvas, over the board
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  // positions inside the layer (it covers the battle screen, which may not start at the window's corner)
  const local = (p) => { const b = layer.getBoundingClientRect(); return { x: p.x - b.left, y: p.y - b.top }; };
  const spawn = (cls, p, style = "", ms = 900) => {
    const q = local(p), e = document.createElement("i");
    e.className = cls;
    e.style.cssText = `left:${q.x}px;top:${q.y}px;${style}`;
    layer.append(e);
    setTimeout(() => e.remove(), ms);
    return e;
  };

  /** 2D sparks, for when there's no 3D table under the point. */
  function sparks(p, hex, n = 12) {
    if (still()) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = 26 + Math.random() * 64;
      spawn("vfx-spark", p, `--c:${css(hex)};--dx:${(Math.cos(a) * d).toFixed(1)}px;--dy:${(Math.sin(a) * d - 18).toFixed(1)}px;animation-delay:${Math.round(Math.random() * 60)}ms`, 820);
    }
  }

  /**
   * A flash at a point (CSS px): kind 'hit' | 'spell' | 'death' | 'play' | 'heal' | 'frost' | 'silence' | 'bounce'.
   * `table` is the point on the 3D table to throw the matching particle burst from (a unit's base); without one (a
   * portrait, a plate) the sparks are 2D.
   */
  function pop(p, hex, kind = "hit", { size = 1, table = null } = {}) {
    if (!p) return;
    spawn(`vfx-flash k-${kind}`, p, `--c:${css(hex)};--s:${size}`, kind === "death" ? 900 : 700);
    if (kind === "play" || kind === "death" || kind === "spell" || kind === "frost") spawn("vfx-ring", p, `--c:${css(hex)};--s:${size}`, 800);
    if (!(table && arena?.burst?.(table.x, table.y, hex, BURST_KIND[kind] ?? kind)) && kind !== "play" && kind !== "bounce") sparks(p, hex, kind === "hit" ? 14 : 9);
  }

  /** A slash across a point, at an angle (radians): the cut an attack leaves on what it struck. */
  function slash(p, hex, angle, len = 120) {
    spawn("vfx-slash", p, `--c:${css(hex)};width:${len}px;transform:translate(-50%,-50%) rotate(${angle.toFixed(3)}rad)`, 380);
  }

  /** A spell's bolt: a comet from one point to another, arriving after `delay + ms`. */
  function bolt(from, to, hex, delay, ms) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const e = spawn("vfx-bolt", from, `--c:${css(hex)};transform:translate(-100%,-50%) rotate(${Math.atan2(dy, dx).toFixed(3)}rad);opacity:0`, delay + ms + 60);
    e.animate([{ translate: "0 0", opacity: 1 }, { translate: `${dx}px ${dy}px`, opacity: 1 }], { duration: ms, delay, easing: "cubic-bezier(.5,0,.9,.6)", fill: "both" });
  }

  /** A still copy of a fallen unit where it stood (the lanes have already redrawn without it); burn() burns it away. */
  function ghost(node, rect) {
    if (!node || !rect?.width) return null;
    const q = local({ x: rect.left, y: rect.top }), g = node.cloneNode(true);
    g.classList.remove("can", "picked", "target", "ally", "stay");
    g.classList.add("vfx-ghost");
    g.removeAttribute("title");
    g.style.cssText += `;left:${q.x}px;top:${q.y}px;width:${rect.width}px;height:${rect.height}px;--u:${rect.width}px;`;
    layer.append(g);
    const gone = setTimeout(() => g.remove(), 4000);
    g.burn = () => { g.classList.add("go"); clearTimeout(gone); setTimeout(() => g.remove(), 850); };
    /** A bounced unit: it lifts off the board and shrinks away into its owner's hand (`to`, a rect), or fades. */
    g.recall = (to) => {
      clearTimeout(gone);
      const from = center(rect), end = to?.width ? center(to) : { x: from.x, y: from.y - 60 };
      const frames = still() ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ translate: "0 0", scale: "1", opacity: 1 }, { translate: "0 -26px", scale: "1.08", opacity: 1, offset: 0.3 },
          { translate: `${(end.x - from.x).toFixed(1)}px ${(end.y - from.y).toFixed(1)}px`, scale: "0.35", opacity: 0 }];
      g.animate(frames, { duration: 560, easing: "cubic-bezier(.45,0,.3,1)", fill: "forwards" });
      setTimeout(() => g.remove(), 600);
    };
    return g;
  }

  /**
   * The attacker throws itself at its target and back, reaching it after ~45% of `ms`. `tilt` stretches the vertical
   * move for a token on the tilted board (its translate runs along the table, foreshortened on screen); 1 for a ghost.
   */
  function lunge(el, fromRect, toRect, { tilt = 1.25, ms = 440 } = {}) {
    if (!el || !fromRect || !toRect || still()) return;
    const a = center(fromRect), b = center(toRect);
    const dx = (b.x - a.x) * 0.7, dy = (b.y - a.y) * 0.7 * tilt;
    const timing = { duration: ms, easing: "cubic-bezier(.35,.6,.3,1)" };
    // the move adds to any other (a gap closing under it); the scale replaces (adding scales isn't multiplying them)
    el.animate([{ translate: "0 0" }, { translate: `${(-dx * 0.08).toFixed(1)}px ${(-dy * 0.08).toFixed(1)}px`, offset: 0.22 },
      { translate: `${dx.toFixed(1)}px ${dy.toFixed(1)}px`, offset: 0.45 }, { translate: "0 0" }], { ...timing, composite: "add" });
    el.animate([{ scale: "1" }, { scale: "1.05", offset: 0.22 }, { scale: "1.1", offset: 0.45 }, { scale: "1" }], timing);
  }

  /** A token that moved (a gap closed): it holds its old place until `delay`, then slides to its new one. */
  function flip(el, oldRect, delay, tilt = 1.25) {
    if (!el || !oldRect || still()) return;
    const r = el.getBoundingClientRect(), dx = oldRect.left - r.left, dy = (oldRect.top - r.top) * tilt;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ translate: `${dx.toFixed(1)}px ${dy.toFixed(1)}px` }, { translate: "0 0" }], { duration: 300, delay, easing: "cubic-bezier(.2,.8,.3,1)", fill: "backwards", composite: "add" });
  }

  /** A struck unit shakes and flashes red. */
  function shake(el) {
    if (!el?.isConnected) return;
    el.classList.remove("vfx-hurt"); void el.offsetWidth; el.classList.add("vfx-hurt");
    setTimeout(() => el.classList.remove("vfx-hurt"), 560);
    if (!still()) el.animate([{ translate: "0 0" }, { translate: "-7px 0" }, { translate: "6px 0" }, { translate: "-3px 0" }, { translate: "0 0" }], { duration: 320, composite: "add" });
  }

  /** A healed, strengthened, frozen or silenced unit glows: kind 'heal' | 'buff' | 'frost' | 'silence'. */
  function glow(el, kind) {
    if (!el?.isConnected) return;
    const cls = `vfx-${kind}`;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 950);
  }

  /** A played unit flies in from where its card was (the hand, or the foe's fan) and lands at `ms`. */
  function arrive(el, fromRect, { ms = 450, tilt = 1.25 } = {}) {
    if (!el || !fromRect?.width || still()) return;
    const to = el.getBoundingClientRect(), f = center(fromRect), c = center(to);
    const timing = { duration: ms, easing: "cubic-bezier(.25,.75,.35,1)" };
    el.animate([{ translate: `${(f.x - c.x).toFixed(1)}px ${((f.y - c.y) * tilt).toFixed(1)}px` }, { translate: "0 -22px", offset: 0.78 }, { translate: "0 0" }], { ...timing, composite: "add" });
    el.animate([{ scale: Math.min(1.4, Math.max(0.5, fromRect.width / Math.max(1, to.width))).toFixed(2), opacity: 0.5 }, { scale: "1.14", opacity: 1, offset: 0.78 }, { scale: "1", opacity: 1 }], timing);
  }

  /** A unit that joins the board mid-move (summoned): hidden until `delay`, then it rises in. */
  function appear(el, delay) {
    if (!el) return;
    const frames = still() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, scale: "0.6" }, { opacity: 1, scale: "1" }];
    el.animate(frames, { duration: 320, delay, easing: "cubic-bezier(.2,.9,.3,1.15)", fill: "backwards" });
  }

  return { pop, slash, bolt, ghost, lunge, flip, shake, glow, arrive, appear, still };
}
