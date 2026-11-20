// Unlocks kept with the player's arcade sign-in, for games with data/progression.json and, in index.html:
//
//   <meta name="tessaract-account" content="./api/unlocks" data-arcade="https://arcade.litvm.games/" data-game="<arcade id>">
//
// Inside the arcade's frame, the arcade lends its AIR session over postMessage (LitNode's cabinet:air; the arcade must
// list the game with login: 'arcade'): a fresh token per request, which the game's own API (content) verifies. Outside
// it the player is a guest: unlocks stay in this browser, and `signInUrl` opens the game on the arcade to sign in.
// No DOM here; app.js decides when to sync and the screens draw the prompt.

/** The account, or null when the page has no tessaract-account meta (or a malformed one). */
export function createAccount(doc = document) {
  const m = doc.querySelector('meta[name="tessaract-account"]');
  let api, arcade;
  try {
    api = new URL(m?.content ?? "", location.href);
    arcade = new URL(m?.dataset.arcade ?? "");
    // https only, but a local arcade (a dev host) may be plain http
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(arcade.hostname);
    if (api.origin !== location.origin || (arcade.protocol !== "https:" && !(local && arcade.protocol === "http:"))) return null;
  } catch { return null; }
  const game = m.dataset.game?.trim() || "";
  // framed by the arcade itself: the browser's record of who framed us, else the referrer
  const framed = (() => {
    if (window.parent === window) return false;
    try {
      const by = location.ancestorOrigins?.length ? location.ancestorOrigins[0] : doc.referrer ? new URL(doc.referrer).origin : null;
      return by === arcade.origin;
    } catch { return false; }
  })();

  let seq = 0, state = { signedIn: false, user: null };
  const waiting = new Map(), listeners = new Set();
  window.addEventListener("message", (e) => {
    if (!framed || e.source !== window.parent || e.origin !== arcade.origin || e.data?.type !== "cabinet:air") return;
    const d = e.data;
    state = { signedIn: !!d.signedIn, user: d.user ?? null };
    const done = d.re ? waiting.get(d.re) : null;
    if (done) { waiting.delete(d.re); done(d); }
    else for (const fn of listeners) fn(state);   // pushed: the session changed on the arcade
  });
  /** Ask the arcade; null when not framed or no answer (an older arcade, or one that doesn't list this game). */
  const ask = (type, extra = {}, ms = 8000) => new Promise((resolve) => {
    if (!framed) { resolve(null); return; }
    const id = `tcg-${++seq}`;
    waiting.set(id, resolve);
    window.parent.postMessage({ type, id, ...extra }, arcade.origin);
    setTimeout(() => { if (waiting.delete(id)) resolve(null); }, ms);
  });
  /** One API call with a fresh token; null when nobody is signed in. Throws when the API fails. */
  async function call(method, body) {
    const r = await ask("cabinet:air", { token: true });
    if (!r?.signedIn || !r.token) return null;
    const res = await fetch(api.href, {
      method, cache: "no-store",
      headers: { authorization: `Bearer ${r.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`unlocks ${res.status}`);
    return res.json();
  }

  return {
    framed,
    /** The game's page on the arcade, where a guest signs in. */
    signInUrl: game ? `${arcade.origin}/#/game/${encodeURIComponent(game)}` : arcade.origin,
    state: () => state,
    /** Who is signed in on the arcade now (asks it; outside the arcade, nobody). */
    async session() { await ask("cabinet:air"); return state; },
    /** Open the arcade's sign-in (inside its frame; the click lends the gesture). */
    async login() { await ask("cabinet:air-login", {}, 180_000); return state; },
    /** The account's unlocks, or null when nobody is signed in. */
    pull: () => call("GET"),
    /** Merge this browser's unlocks into the account; the account's record back, or null. */
    push: (u) => call("PUT", { starter: u.starter, earned: u.earned, heat: u.heat }),
    /** The arcade's session changed (signed in or out there). */
    onChange: (fn) => { listeners.add(fn); },
  };
}
