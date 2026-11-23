// Tessaract — the game client. One JSON file is the game (engine/tessaract.js and data/, built by `tessaract web`);
// the rules here are the same code the relay and the LitNode ruleset run, so every match replays identically.
//
//   ./                                   title screen: practice, ranked, Gauntlet, daily puzzle, profile
//   ?relay=ws://127.0.0.1:7830&name=a    a two-player match on a dev relay (`TCG_DEV=1 tessaract relay`)
//   ?relay=…&watch=1                     spectate it
//   #replay=<code>                       replay a shared match (the code is the whole match record)
//
// This file wires the data, the wallet, the profile and the flows between screens. The screens are in ui/screens,
// the level behind them in ui/arena.js, the design in styles/. Every name on the page goes in through textContent.
import {
  decode, Op, compileGame, createRules, LocalBotSession, RelaySession, ReplaySession, PuzzleSession, encodeRecord, decodeRecord, REPLAY_PARAM,
  statsFromCore, describeEffect, createGauntlet, createPuzzles, loadProfile, saveProfile, addMatch, summarize, utcDate,
  loadUnlocks, saveUnlocks, starterChoices, pickStarter, addUnlock, unlockedTokens, mergeUnlocks, practiceDeck, seededRandom,
} from "./engine/tessaract.js";
import { createAccount } from "./lib/account.js";
import { createWallet, LITEFORGE } from "./lib/wallet.js";
import { createChain } from "./lib/chain.js";
import { seatPlaced } from "./lib/litnode/ranked.js";
import { createHoldings } from "./lib/holdings.js";
import { createSound } from "./lib/sound.js";
import { shortAddress } from "./lib/util.js";
import { onToast, toast, wait } from "./ui/dom.js";
import { go, onWipe, register, resetStack } from "./ui/router.js";
import { createArena, REALMS, realmFor } from "./ui/arena.js";
import { createCards } from "./ui/cards.js";
import { homeScreen } from "./ui/screens/home.js";
import { selectScreen } from "./ui/screens/select.js";
import { deckScreen } from "./ui/screens/deck.js";
import { gauntletScreen, puzzleScreen, profileScreen } from "./ui/screens/meta.js";
import { forgeScreen } from "./ui/screens/forge.js";
import { rankedScreen, ladderScreen } from "./ui/screens/online.js";
import { createOnline } from "./ui/online.js";
import { versusScreen } from "./ui/screens/versus.js";
import { matchScreen } from "./ui/screens/match.js";

// ------------------------------------------------------------------ boot
const bootBar = document.getElementById("boot-bar"), bootText = document.getElementById("boot-text");
const boot = (p, text) => { if (bootBar) bootBar.style.transform = `scaleX(${p})`; if (bootText && text) bootText.textContent = text; };
const bootDone = () => document.getElementById("boot")?.classList.add("done");

const q = new URLSearchParams(location.search);
const RELAY = q.get("relay");
const WATCH = !!RELAY && q.get("watch") === "1";
const RELAY_OWNED = !!RELAY && q.get("owned") === "1";
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

boot(0.15, "Reading the game");
// assets/cards/art.json (optional) names an illustration for cards with no painting: { "<card id>": "<file>" }
// data/progression.json (optional) turns on character unlocks: { "starterKind": "<Kind>", "starters"?: ["<card id>", …], "stock": { "<card id>": copies } }
const [game, snap, cardArt, progressionCfg] = await Promise.all([fetch("./data/game.json").then((r) => r.json()), fetch("./data/collection.json").then((r) => r.json()),
  fetch("./assets/cards/art.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  fetch("./data/progression.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
boot(0.45, "Forging the rules");
const rules = createRules(compileGame(game));
const byToken = new Map(snap.cards.map((c) => [String(c.tokenId), c]));
document.title = game.title;

// Element accents come from the game config (elements[].color), else the theme's defaults (styles/theme.css).
const ELEMENT_COLOR = Object.fromEntries(game.elements.filter((e) => /^#[0-9a-f]{3,8}$/i.test(e.color ?? "")).map((e) => [e.id, e.color]));
const elementColor = (id) => ELEMENT_COLOR[id] ?? `var(--${/^[a-z]+$/.test(id ?? "") ? id : "neutral"}, var(--neutral))`;
// A card's art: its token's painting from the collection snapshot, else a local image the game names in "art", else
// one from assets/cards/art.json (the CSP serves same-origin images only, so remote and ipfs:// URLs are skipped).
// No art at all: the card draws a generated sigil (ui/sigil.js).
const localArt = (src) => (typeof src === "string" && src && !/^[a-z]+:/i.test(src) && !src.startsWith("//") && !src.includes("..") ? src : null);
const artOf = (def) => (def.token ? byToken.get(String(def.token.tokenId))?.art : null) ?? localArt(def.art) ?? (localArt(cardArt[def.id]) ? `./assets/cards/${cardArt[def.id]}` : null);
const nameOf = (id) => game.cards.find((c) => c.id === id)?.name ?? id;
const statsOf = (c) => (c ? statsFromCore(c.stats) : undefined);
const claimOf = (c) => (c ? { tokenId: String(c.tokenId), stats: statsOf(c) } : undefined);

// ------------------------------------------------------------------ preferences, profile, wallet
const store = (() => { try { return window.localStorage; } catch { return null; } })();
// The practice bot starts on Easy where unlocks are on (a new player holds one champion), else Normal; a choice sticks.
const defaultLevel = progressionCfg ? 1 : 2;
const prefs = (() => { try { return { realm: "auto", level: defaultLevel, ...JSON.parse(store?.getItem("deckwright.prefs") ?? "{}") }; } catch { return { realm: "auto", level: defaultLevel }; } })();
let profile = loadProfile(store, game.litnode.rulesetId);
const saveProf = () => saveProfile(store, profile);
const gauntlet = createGauntlet(rules);
const puzzles = createPuzzles(rules);

// Character unlocks (data/progression.json; off without it, or without a collection): a new player picks one starter of
// `starterKind`, wins more in the Gauntlet, and plays practice and the Gauntlet with those, the support cards and the
// collection cards their wallet holds. The Gauntlet deals a new player's deck from the stock list. Ranked is the wallet's
// cards either way (the relay checks them on chain).
const progression = (() => {
  if (!progressionCfg || !snap.cards.length) return null;
  const kind = String(progressionCfg.starterKind ?? "");
  // `starters` narrows the pick to a few cards of that kind (one per element, say); without it, every one is offered
  const ofKind = starterChoices(rules.game, kind);
  const listed = Array.isArray(progressionCfg.starters)
    ? progressionCfg.starters.map((id) => String(rules.game.cards[rules.game.cardIndex[id]]?.token?.tokenId ?? "")).filter((t) => ofKind.includes(t))
    : [];
  if (Array.isArray(progressionCfg.starters) && listed.length !== progressionCfg.starters.length) console.warn(`[tessaract] progression.json: some starters are not collection cards of kind "${kind}"`);
  const starters = listed.length ? listed : ofKind;
  if (!starters.length) { console.warn(`[tessaract] progression.json: no collection card of kind "${kind}" to start with; unlocks are off`); return null; }
  const stock = Object.entries(progressionCfg.stock ?? {}).flatMap(([id, n]) => {
    const i = rules.game.cardIndex[id];
    if (i === undefined) { console.warn(`[tessaract] progression.json: unknown stock card ${id}`); return []; }
    return Array.from({ length: Math.max(0, Math.min(10, Math.floor(Number(n) || 0))) }, () => i);
  });
  return { kind, starters, stock };
})();
let unlocks = loadUnlocks(store, game.litnode.rulesetId);
// Unlocks follow the player's arcade sign-in when the page names an account API (lib/account.js); a guest's stay here.
const account = progression ? createAccount() : null;
const accountListeners = new Set();
const accountChanged = () => { for (const fn of accountListeners) fn(); };
let pushTimer = null;
/** Keep the record here and, once someone is signed in on the arcade, in their account too. */
const saveUnl = () => {
  saveUnlocks(store, unlocks);
  if (!account?.state().signedIn) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    account.push(unlocks).then((back) => { if (back) { unlocks = mergeUnlocks(unlocks, back); saveUnlocks(store, unlocks); } })
      .catch((e) => console.warn("[tessaract] could not save unlocks to the account", e));
  }, 400);
};
/** Signed in on the arcade: bring the account's unlocks here, and this browser's (a guest's progress) up to it. */
async function syncAccount() {
  if (!account?.framed) return;
  try {
    const s = await account.session();
    if (s.signedIn) {
      const remote = await account.pull();
      if (remote) {
        unlocks = mergeUnlocks(unlocks, remote);
        const back = await account.push(unlocks);
        if (back) unlocks = mergeUnlocks(unlocks, back);
        saveUnlocks(store, unlocks);
      }
    }
  } catch (e) { console.warn("[tessaract] could not reach the account", e); }
  accountChanged();
}
let todaysPuzzle;   // undefined until generated; null when the day has none
let puzzleBusy = false;

const wallet = createWallet();
// A game built without a collection has no contract to read: no wallet, base champions only.
const holdings = /^0x[0-9a-fA-F]{40}$/.test(snap.collection.address ?? "") ? createHoldings({ collection: { ...snap.collection, cards: snap.cards } }) : null;
const walletListeners = [];
const owned = new Set();
async function refreshOwned() {
  const { address } = wallet.snapshot();
  owned.clear();
  if (address && holdings) {
    try {
      const read = await holdings.read(address);
      for (const c of (await holdings.identify(read.tokens)).values()) if (c) owned.add(String(c.tokenId));
    } catch (e) { console.warn("[tessaract] could not read holdings", e); }
  }
  for (const fn of walletListeners) fn();
}
wallet.subscribe(() => { void refreshOwned(); });

// Where the game's cards are sold, if anywhere: <meta name="tessaract-shop" content="https://…" data-label="…"> in
// index.html. The shop is its own site and opens in a new tab; the wallet is read again when the player comes back.
const shop = (() => {
  const m = document.querySelector('meta[name="tessaract-shop"]');
  try {
    const url = new URL(m?.content ?? "");
    return url.protocol === "https:" ? { url: url.href, label: m.dataset.label?.trim() || url.hostname } : null;
  } catch { return null; }
})();
let shopVisit = false;

// The game's own brand, all optional, in index.html: <meta name="tessaract-logo" content="./assets/brand/…" data-alt="…"
// data-sub="…"> is a title image shown in place of the game's name (with an optional line under it), <meta
// name="tessaract-presenter" content="…"> reads "… presents" above it, and <meta name="tessaract-mark" content="…"
// data-alt="…"> is a small mark beside the season badge. <meta name="tessaract-card-frame" content="…"> lays the game
// cards out on the game's own painted frame (cards.css, :root.card-frame: a 5:7 image drawn to that geometry, with a
// transparent art window), and <meta name="tessaract-card-back" content="…"> (or the game config's cardBack) is the back
// on the deck piles and the foe's hand; without them the cards and backs are drawn as before. Images come from this
// site only.
const brand = (() => {
  const meta = (n) => document.querySelector(`meta[name="${n}"]`);
  const local = (m) => { try { const u = new URL(m?.content ?? "", location.href); return m?.content && u.origin === location.origin ? u.href : null; } catch { return null; } };
  const l = meta("tessaract-logo"), m = meta("tessaract-mark"), logo = local(l), mark = local(m);
  return {
    logo: logo ? { src: logo, alt: l.dataset.alt?.trim() || game.title, sub: l.dataset.sub?.trim() || "" } : null,
    mark: mark ? { src: mark, alt: m.dataset.alt?.trim() || "" } : null,
    presenter: meta("tessaract-presenter")?.content?.trim() || null,
    cardFrame: local(meta("tessaract-card-frame")),
    cardBack: local(meta("tessaract-card-back")) ?? local({ content: game.cardBack }),
  };
})();
for (const [cls, url] of [["card-frame", brand.cardFrame], ["card-back", brand.cardBack]]) {
  if (!url) continue;
  document.documentElement.classList.add(cls);
  document.documentElement.style.setProperty(`--${cls}`, `url("${url}")`);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && shopVisit) { shopVisit = false; void refreshOwned(); } });

// ------------------------------------------------------------------ the app: what every screen reads
const arena = createArena(document.getElementById("arena"));
const app = {
  game, rules, snap, byToken, arena, prefs, owned, gauntlet, puzzles, toast,
  // requireOwned: the deck builder offers only held collection cards (a ranked match, or ?owned=1 on a dev relay)
  relay: !!RELAY, watch: WATCH, requireOwned: RELAY_OWNED,
  funnel: !!document.querySelector('meta[name="tessaract-funnel"]'),
  hasWallet: !!holdings,
  shop, leftForShop: () => { shopVisit = true; }, brand,
  elementColor, artOf, nameOf, statsOf,
  champName: (tokenId) => (tokenId ? byToken.get(String(tokenId))?.name ?? `#${tokenId}` : "Base champion"),
  // ---- unlocks: what a mode lets the player field (see `progression` above)
  progression,
  /** The collection token ids `mode` lets this player use, or null when every card is open. */
  unlockedIn(mode) {
    if (mode === "ranked") return app.hasWallet ? new Set(owned) : null;
    if (mode === "relay") return RELAY_OWNED ? new Set(owned) : null;
    return progression ? unlockedTokens(unlocks, owned) : null;
  },
  /** May this collection token be used in `mode`? (Support cards have no token and are always open.) */
  canUse(tokenId, mode) { const open = app.unlockedIn(mode); return !open || open.has(String(tokenId)); },
  needsStarter: () => !!progression && !unlocks.starter,
  /** The arcade account behind the unlocks: null without one; else { signedIn, email, framed }. */
  account: () => (account ? { signedIn: account.state().signedIn, email: account.state().user?.email ?? null, framed: account.framed } : null),
  onAccount: (fn) => { accountListeners.add(fn); },
  /** Keep unlocks on every device: sign in through the arcade (inside it), or open the game there (outside it). */
  async signIn() {
    if (!account) return;
    if (!account.framed) { location.assign(account.signInUrl); return; }
    await account.login();
    await syncAccount();
    if (account.state().signedIn) toast("Signed in: your champions are saved to your account");
  },
  /** { unlocked, total } collection cards, for the profile; null without unlocks. */
  unlockCount: () => (progression ? { unlocked: [...unlockedTokens(unlocks, owned)].filter((id) => byToken.has(id)).length, total: snap.cards.length } : null),
  heroPowerOf(c) {
    const p = rules.heroPower(claimOf(c) ?? {});
    return p ? { name: p.name, cost: p.cost, text: describeEffect(p.effect, nameOf) } : null;
  },
  setPref(k, v) { prefs[k] = v; try { store?.setItem("deckwright.prefs", JSON.stringify(prefs)); } catch { /* not remembered */ } },
  profile: () => profile,
  summary: () => summarize(profile),
  puzzleSolvedToday: () => !!profile.puzzles[utcDate(Date.now())],
  todaysPuzzle: () => todaysPuzzle,
  ensurePuzzle(done) {
    // Generating takes a moment (a seeded bot match plus difficulty playouts): the page draws first.
    if (puzzleBusy || todaysPuzzle !== undefined) return;
    puzzleBusy = true;
    setTimeout(() => { todaysPuzzle = puzzles.daily(utcDate(Date.now())); puzzleBusy = false; done(); }, 40);
  },
  onWallet: (fn) => { walletListeners.push(fn); },
  walletShort: () => { const a = wallet.snapshot().address; return a ? shortAddress(a) : ""; },
  async toggleWallet() { if (wallet.snapshot().address) await wallet.disconnect(); else await wallet.connect(); await refreshOwned(); },
};
app.cards = createCards(app);
// Ranked play, the ladder and stakes on the LitNode mesh (ui/online.js); reads go through the game's own Liteforge RPC.
app.online = createOnline({ game, chain: createChain(LITEFORGE.rpcUrls[0]), wallet });

// ------------------------------------------------------------------ sound: the realm's ambience, menu or battle music, the battle's effects
// The library is audio/ (audio.json lists it). Three settings: everything, effects only, or silence (S toggles).
const SOUND_MODES = { on: { muted: false, music: 0.6 }, fx: { muted: false, music: 0 }, off: { muted: true, music: 0.6 } };
const soundListeners = new Set();
const sound = createSound({ base: "./audio/", prefs: SOUND_MODES[prefs.sound] ?? SOUND_MODES.on });
sound.bindUi(document);
onWipe(() => sound.play("ui-wipe"));
onToast((kind) => { if (kind === "err") sound.play("ui-error"); });
const syncBeds = () => {
  const realm = arena.realm === "underworld" ? "underworld" : "valhalla";
  sound.ambience(realm === "underworld" ? "amb-abyss" : "amb-hall");
  sound.music(arena.mood === "battle" ? `battle-${realm}` : "menu");
};
for (const k of ["setRealm", "setMood"]) { const f = arena[k]; arena[k] = (v) => { f.call(arena, v); syncBeds(); }; }
syncBeds();
app.sound = sound;
app.soundMode = () => (SOUND_MODES[prefs.sound] ? prefs.sound : "on");
app.setSoundMode = (mode) => {
  app.setPref("sound", mode);
  sound.set(SOUND_MODES[mode]);
  if (mode !== "off") sound.play("ui-click");
  for (const fn of soundListeners) fn(mode);
};
app.onSound = (fn) => { soundListeners.add(fn); return () => soundListeners.delete(fn); };
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "s" || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  app.setSoundMode(app.soundMode() === "off" ? "on" : "off");
  toast(app.soundMode() === "off" ? "Sound off (S)" : "Sound on (S)");
});

// ------------------------------------------------------------------ screens
const home = homeScreen(app);
const select = selectScreen(app);
const deck = game.deckRules?.mode === "declared" ? deckScreen(app) : null;
const gauntletPage = gauntletScreen(app);
const puzzlePage = puzzleScreen(app);
const profilePage = profileScreen(app);
const versus = versusScreen(app);
const match = matchScreen(app);
const rankedPage = rankedScreen(app, wallet);
const ladderPage = ladderScreen(app);
for (const s of [home, select, deck, gauntletPage, puzzlePage, profilePage, rankedPage, ladderPage, app.funnel ? forgeScreen(app) : null, versus, match]) if (s) register(s);

// ------------------------------------------------------------------ flows
let last = null;   // the last practice or two-player setup, for Rematch: { champion, deck, opts }
let context = { kind: "practice" };
let recorded = false;

const realmName = (realm) => REALMS[realm]?.name ?? realm;
const pickRealm = (champion, choice = prefs.realm) => (choice === "auto" ? realmFor(champion) : choice);

/** Show the versus screen, wait for `ready` (and at least its animation), then wipe into the battle. */
async function versusInto(session, ctx, { names, subs, champs, realm }, ready = () => true) {
  context = ctx; recorded = false;
  versus.show({ names, subs, champs, realm: realmName(realm), kind: ctx.kind });
  await go("versus", { wipe: true, before: () => arena.setRealm(realm) });
  const t0 = performance.now();
  for (;;) {
    const p = Math.min(1, (performance.now() - t0) / 1700);
    const ok = ready();
    versus.progress(ok ? p : Math.min(p, 0.82), ok ? (p < 1 ? "Raising the banners" : "To battle") : session.status || "Waiting for the opponent");
    if (p >= 1 && ok) break;
    await wait(60);
  }
  await go("match", { wipe: true, before: () => match.attach(session, ctx) });
}

/** Start a practice match (or a two-player one on the relay) with a champion and, for declared decks, a deck. */
async function startMatch(champion, declaredDeck, opts = {}) {
  last = { champion, deck: declaredDeck, opts };
  const realm = pickRealm(champion, opts.realm);
  if (RELAY) {
    const session = RelaySession.dev(rules, RELAY, q.get("name") ?? `player-${randomSeed().slice(0, 6)}`, claimOf(champion), wallet.snapshot().address ?? undefined);
    if (declaredDeck) session.declareDeck(declaredDeck);
    await versusInto(session, { kind: "relay", label: "Two-player match", opponent: "Opponent", mine: champion },
      { names: [champion?.name ?? "Base champion", "Opponent"], subs: ["You", "Joining…"], champs: [champion, null], realm },
      () => !!session.state);
    return;
  }
  const others = snap.cards.filter((c) => c !== champion);
  const foe = others.length ? others[Math.floor(Math.random() * others.length)] : null;
  const level = opts.level ?? prefs.level;
  const seed = randomSeed();
  // With unlocks on, the bot brings a deck like the player's: its champion and as many characters as the player may
  // use, then the stock list. Without them it plays the game's suggested deck, as before.
  const usable = progression ? [...app.unlockedIn("practice")].filter((id) => byToken.has(id)).length : 0;
  const foeDeck = progression && foe
    ? practiceDeck(rules.game, { champion: String(foe.tokenId), usable: Math.max(1, usable), stock: progression.stock, rnd: seededRandom(`${seed}|practice-foe`) })
    : undefined;
  const session = new LocalBotSession(rules, seed, claimOf(champion), claimOf(foe), { level, foeDeck });
  if (declaredDeck) session.declareDeck(declaredDeck);
  await versusInto(session, { kind: "practice", label: "Practice", opponent: foe?.name ?? "House bot", foeLabel: "House bot", mine: champion, foe },
    { names: [champion?.name ?? "Base champion", foe?.name ?? "House bot"], subs: ["You", `${["", "Easy", "Normal", "Hard"][level]} bot`], champs: [champion, foe], realm });
}

/**
 * Queue for a ranked match on the LitNode mesh (from the Ranked page, which shows the search), then take the seat the
 * mesh placed and wipe into the battle. The champion and the deck are checked on chain by the match's relay.
 */
async function startRanked(champion, declaredDeck) {
  const online = app.online;
  if (online.state.searching) return;
  resetStack();
  await go("ranked", { wipe: true, push: false });
  const placement = await online.queue();
  if (!placement) return;
  let session;
  try { session = await seatPlaced(RelaySession, rules, placement, claimOf(champion)); }
  catch (e) { online.say(`Couldn't take the seat: ${e?.message ?? e}`, true); return; }
  if (declaredDeck) session.declareDeck(declaredDeck);
  // the opponent's LitNode profile name, if they have one; never hold the match up for it
  const foeName = (await Promise.race([online.keyName(placement.opponent), wait(1500).then(() => "")])) || `Player ${placement.opponent.slice(0, 6)}`;
  last = { champion, deck: declaredDeck, opts: { mode: "ranked" } };
  await versusInto(session, { kind: "ranked", label: "Ranked match", opponent: foeName, foeLabel: foeName, mine: champion, placement },
    { names: [champion?.name ?? "Base champion", foeName], subs: ["You", "Ranked · LitNode"], champs: [champion, null], realm: pickRealm(champion) },
    () => !!session.state);
}

function closeRun() {
  const run = profile.gauntlet.current;
  if (run && !run.counted) {
    profile.gauntlet.runs++;
    profile.gauntlet.bestStage = Math.max(profile.gauntlet.bestStage, run.wins);
    if (run.cleared) profile.gauntlet.cleared++;
    if (run.locked) { unlocks = { ...unlocks, heat: gauntlet.heatAfter(run, unlocks.heat) }; saveUnl(); }
  }
  profile.gauntlet.current = null;
  saveProf();
}

async function startReplay(record, code) {
  let session;
  try { session = new ReplaySession(rules, record); }
  catch (e) { toast(`Can't play this replay: ${e.message}`, "err"); await go("home"); return; }
  const c0 = byToken.get(String(record.agents[record.participants[0]]?.tokenId)) ?? null;
  shareCode = code;
  context = { kind: "replay", label: "Replay" };
  await go("match", { wipe: true, before: () => { arena.setRealm(pickRealm(c0, "auto")); match.attach(session, context); } });
}
let shareCode = null;

async function loadReplayFromHash() {
  const m = new RegExp(`^#${REPLAY_PARAM}=([A-Za-z0-9_-]+)$`).exec(location.hash);
  if (!m) return false;
  try { await startReplay(await decodeRecord(m[1]), m[1]); return true; }
  catch (e) { toast(`Couldn't open that replay link: ${e.message}`, "err"); return false; }
}

const replayUrl = (code) => `${location.origin}${location.pathname}#${REPLAY_PARAM}=${code}`;
const watchUrl = () => `${location.origin}${location.pathname}?relay=${encodeURIComponent(RELAY)}&watch=1`;

app.flows = {
  /** Open champion select for a mode; a game without a collection skips straight on with the base champion. */
  async choose(mode) {
    // unlocks on, no starter yet: practice and the Gauntlet begin with picking one
    if (!RELAY && app.needsStarter() && (mode === "practice" || mode === "gauntlet")) { select.setMode("starter", mode); await go("select"); return; }
    select.setMode(RELAY ? "relay" : mode);
    if (!snap.cards.length) { await app.flows.confirmChampion(null, { mode: RELAY ? "relay" : mode }); return; }
    await go("select");
  },
  /** The starter pick: keep it, then carry on to champion select for the mode the player came for. */
  pickStarter(champion, next) {
    if (!progression || !champion) return;
    unlocks = pickStarter(unlocks, String(champion.tokenId), progression.starters);
    saveUnl();
    toast(`${champion.name} is yours. Win in the Gauntlet to unlock more champions.`);
    select.setMode(next);
    select.enter();
  },
  async confirmChampion(champion, opts = {}) {
    // a ranked match's relay accepts only collection cards the wallet holds
    app.requireOwned = opts.mode === "ranked" || RELAY_OWNED;
    if (opts.mode === "ranked") {
      if (deck) { deck.open((list) => void startRanked(champion, list), "ranked"); await go("deck"); }
      else await startRanked(champion, null);
      return;
    }
    if (opts.mode === "gauntlet") {
      const locked = progression ? { unlocked: app.unlockedIn("gauntlet"), heat: unlocks.heat, stock: progression.stock } : undefined;
      profile.gauntlet.current = gauntlet.start(randomSeed(), claimOf(champion), undefined, locked);
      saveProf();
      resetStack();
      await go("gauntlet", { push: false });
      return;
    }
    if (deck) {
      deck.open((list) => void startMatch(champion, list, opts), RELAY ? "relay" : "practice");
      await go("deck");
      return;
    }
    await startMatch(champion, null, opts);
  },
  async gauntletFight() {
    const run = profile.gauntlet.current;
    if (!run || run.over || run.offers.length) return;
    const opp = gauntlet.opponent(run), me = gauntlet.player(run);
    const mine = me.tokenId ? byToken.get(me.tokenId) ?? null : null;
    const foe = opp.tokenId ? byToken.get(opp.tokenId) ?? null : null;
    const session = new LocalBotSession(rules, `${run.seed}-stage-${opp.stage}`, { tokenId: me.tokenId, stats: me.stats }, { tokenId: opp.tokenId, stats: opp.stats }, { level: opp.level, foeDeck: opp.deck });
    if (deck) session.declareDeck(me.deck);
    // One life: the match is on the record before it starts, so leaving it or closing the page counts as a loss.
    profile.gauntlet.current = gauntlet.fight(run);
    saveProf();
    await versusInto(session, { kind: "gauntlet", label: `Gauntlet · stage ${opp.stage}`, opponent: opp.name, foeLabel: opp.name, detail: `stage ${opp.stage}`, mine, foe },
      { names: [mine?.name ?? "Base champion", opp.name], subs: ["You", `Stage ${opp.stage} of ${gauntlet.stages}`], champs: [mine, foe], realm: opp.stage >= gauntlet.stages ? "underworld" : pickRealm(foe, "auto") });
  },
  /** Take reward `i`; for a card, `replaces` is the deck card to give up (else the suggested one). */
  gauntletChoose(i, replaces) { profile.gauntlet.current = gauntlet.choose(profile.gauntlet.current, i, replaces); saveProf(); gauntletPage.render(); },
  gauntletAbandon() { closeRun(); gauntletPage.render(); },
  /** Settle a Gauntlet match that started and never reported a result as a loss; true if there was one. */
  settleGauntlet() {
    const run = profile.gauntlet.current;
    if (!run?.fighting || run.over) return false;
    const opp = gauntlet.opponent(run), lost = gauntlet.forfeit(run);
    profile.gauntlet.current = lost;
    closeRun();
    profile.gauntlet.current = { ...lost, counted: true };
    profile = addMatch(profile, { at: Date.now(), mode: "gauntlet", result: "loss", turns: 0, ruleset: game.litnode.rulesetId, ...(run.champion.tokenId ? { champion: run.champion.tokenId } : {}), opponent: opp.name, detail: `stage ${opp.stage} · left unfinished` });
    saveProf();
    toast(`Stage ${opp.stage} was left unfinished, so it counts as a loss.`, "err");
    return true;
  },
  async puzzlePlay() {
    const p = todaysPuzzle;
    if (!p) return;
    const session = new PuzzleSession(rules, p);
    const mine = byToken.get(String(p.agents[p.participants[p.side]].tokenId)) ?? null;
    const foe = byToken.get(String(p.agents[p.participants[1 - p.side]].tokenId)) ?? null;
    await versusInto(session, { kind: "puzzle", label: "Daily puzzle", opponent: "Rival", detail: p.date, mine, foe },
      { names: ["You", "Rival"], subs: ["Win this turn", p.date], champs: [mine, foe], realm: pickRealm(mine, "auto") });
  },
  async watchCode(code) {
    try { history.replaceState(null, "", `${location.pathname}#${REPLAY_PARAM}=${code}`); await startReplay(await decodeRecord(code), code); }
    catch (e) { toast(`Couldn't open that replay: ${e.message}`, "err"); }
  },
  async copyViewLink(session) {
    const url = session?.role === "replay" ? replayUrl(shareCode ?? await encodeRecord(session.record())) : watchUrl();
    try { await navigator.clipboard.writeText(url); toast(session?.role === "replay" ? "Replay link copied" : "Watch link copied"); }
    catch { toast("Couldn't copy the link", "err"); }
  },
  async exitView() {
    match.detach();
    // A spectator URL would rejoin the relay on reload: leave it for the plain page.
    if (WATCH) { location.assign(location.pathname); return; }
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    resetStack();
    await go("home", { wipe: true });
  },
  async leaveMatch() {
    match.detach();
    resetStack();
    const to = context.kind === "gauntlet" ? "gauntlet" : context.kind === "puzzle" ? "puzzle" : context.kind === "ranked" ? "ranked" : "home";
    await go(to, { wipe: true });
  },

  /** A match ended: record it in the profile (with its replay) and show the result screen. */
  async finished({ session, state: s, meIdx, puzzleState, tally, outcome, watching, champion, foe: foeChamp, foeLabel, mineLabel }) {
    const kind = context.kind;
    let replay = null;
    if (!watching && !recorded) {
      recorded = true;
      if (kind === "puzzle") {
        // Attempts aren't matches: a solve counts once per day, toward the puzzle streak.
        if (puzzleState === "solved" && !profile.puzzles[session.puzzle.date]) { profile.puzzles[session.puzzle.date] = { at: Date.now(), actions: session.actions }; saveProf(); }
      } else {
        const won = s.winner === meIdx;
        if (kind === "gauntlet" && profile.gauntlet.current) {
          const before = profile.gauntlet.current.unlock;
          const run = gauntlet.result(profile.gauntlet.current, won, app.unlockedIn("gauntlet") ?? []);
          profile.gauntlet.current = run;
          if (run.unlock && run.unlock !== before) { unlocks = addUnlock(unlocks, run.unlock); saveUnl(); toast(`New champion unlocked: ${app.champName(run.unlock)}`); }
          if (run.over) { closeRun(); profile.gauntlet.current = { ...run, counted: true }; }
          saveProf(); // now, not after the replay encodes: a reload in between must not forfeit a finished match
        }
        try { replay = await encodeRecord(session.record()); } catch { /* the result still counts without a replay */ }
        profile = addMatch(profile, { at: Date.now(), mode: kind, result: s.winner === 2 ? "draw" : won ? "win" : "loss", turns: s.turnNo, ruleset: game.litnode.rulesetId, ...(champion ? { champion: String(champion.tokenId) } : {}), opponent: context.opponent, ...(replay ? { replay } : {}), ...(context.detail ? { detail: context.detail } : {}) });
        saveProf();
      }
    }
    const me = s.p[meIdx], foe = s.p[meIdx === 0 ? 1 : 0];
    const conceded = s.winner !== 2 && decode(s.last ?? 0).op === Op.Concede;
    const name = (id) => (id === "you" ? "You" : id === "bot" ? "House bot" : String(id).slice(0, 10));
    const headline = puzzleState ? (puzzleState === "solved" ? "Solved" : "Not this time")
      : s.winner === 2 ? "Draw" : watching ? (name(s.p[s.winner].id) === "You" ? "You win" : `${name(s.p[s.winner].id)} wins`) : s.winner === meIdx ? "Victory" : "Defeat";
    const sub = puzzleState
      ? (puzzleState === "solved" ? `${session.actions} actions. The bot needed ${session.puzzle.par}.` : "Your turn ended without a win. Try another line.")
      : conceded ? (watching ? `${name(s.p[s.winner === 0 ? 1 : 0].id)} conceded` : s.winner === meIdx ? "Your opponent conceded" : "You conceded")
      : `${watching ? `${name(me.id)} ${Math.max(0, me.life)} life · ${name(foe.id)} ${Math.max(0, foe.life)} life` : `${Math.max(0, me.life)} life left`}${(kind === "relay" || kind === "ranked") && !watching ? ` · ${session.status}` : ""}${kind === "gauntlet" ? ` · ${context.detail}` : ""}`;
    const watchReplay = { text: "Watch replay", icon: "replay", onClick: async () => { const rec = session.record(); const code = await encodeRecord(rec); history.replaceState(null, "", `${location.pathname}${location.search}#${REPLAY_PARAM}=${code}`); await startReplay(rec, code); } };
    const menu = { text: "Menu", icon: "back", link: true, onClick: () => void app.flows.leaveMatch() };
    let buttons;
    if (watching) buttons = [watchReplay, { text: "Leave", icon: "close", onClick: () => void app.flows.exitView() }];
    else if (kind === "puzzle") buttons = puzzleState === "solved" ? [{ text: "Back to the puzzle", icon: "puzzle", primary: true, onClick: () => void app.flows.leaveMatch() }] : [{ text: "Retry", icon: "refresh", primary: true, onClick: () => { recorded = false; match.retry(); } }, menu];
    else if (kind === "gauntlet") {
      const run = profile.gauntlet.current;
      buttons = [{ text: run?.over ? (run.cleared ? "Gauntlet cleared" : "Run over") : "Choose your reward", icon: "gauntlet", primary: true, onClick: () => void app.flows.leaveMatch() }, watchReplay];
    } else if (kind === "relay") buttons = [watchReplay, menu];
    else if (kind === "ranked") {
      buttons = [{ text: app.online.wager ? "Stakes and ranked" : "Ranked", icon: "trophy", primary: true, onClick: () => void app.flows.leaveMatch() },
        { text: "Leaderboard", icon: "crown", onClick: async () => { match.detach(); resetStack(); await go("ladder", { wipe: true }); } }, watchReplay, menu];
    }
    else buttons = [{ text: "Rematch", icon: "swords", primary: true, onClick: () => void startMatch(last.champion, last.deck, last.opts) }, watchReplay, { text: "New champion", icon: "user", onClick: async () => { match.detach(); resetStack(); await go("home", { push: false }); await app.flows.choose("practice"); } }, menu];
    match.result.show({
      outcome, headline, sub,
      numbers: puzzleState ? [[session.actions ?? 0, "actions"], [tally.dealt, "dealt to champion"], [tally.played, "cards played"], [tally.kills, "foes felled"]]
        : [[s.turnNo, "turns"], [tally.dealt, "dealt to champion"], [tally.played, "cards played"], [tally.kills, "foes felled"]],
      // a face-off when both champions are known (spectators see both players'); a puzzle has no foe champion
      champion: watching && !foeChamp ? null : champion,
      championNote: kind === "gauntlet" ? context.detail : undefined,
      foe: puzzleState ? null : foeChamp ?? null, foeLabel, mineLabel,
      victor: puzzleState || s.winner === 2 || s.winner < 0 ? null : s.winner === meIdx ? "mine" : "foe",
      buttons,
      shareLink: kind === "puzzle" ? null : async () => replayUrl(replay ?? await encodeRecord(session.record())),
    });
  },
};

// ------------------------------------------------------------------ start
boot(0.75, "Lighting the braziers");
// Warm only the art the title screen shows first (the featured champion), so it doesn't pop in; never wait long.
const featured = home.firstFeature()?.art;
if (featured) await Promise.race([new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = featured; }), wait(800)]);
boot(1, "Ready");
wallet.restore?.().catch(() => {});
void refreshOwned();
window.addEventListener("hashchange", () => { void loadReplayFromHash(); });
// A replay fragment wins over ?watch=1: "Watch replay" from the spectator view keeps the relay query in the URL.
const opened = location.hash.startsWith(`#${REPLAY_PARAM}=`) && (await loadReplayFromHash());
setTimeout(bootDone, 150);
// The page closed during a Gauntlet match last time: that match is a loss, as leaving it would have been.
app.flows.settleGauntlet();
// inside the arcade: the account's unlocks join this browser's, and follow the arcade's sign-in and sign-out
account?.onChange(() => { void syncAccount(); });
void syncAccount();
if (!opened) {
  if (WATCH) {
    const session = RelaySession.watch(rules, RELAY);
    void versusInto(session, { kind: "watch", label: "Spectating" }, { names: ["Player one", "Player two"], subs: ["Spectating", "Live"], champs: [null, null], realm: "valhalla" }, () => !!session.state);
  } else void go("home").then(() => performance.mark("tessaract:title"));   // time to the title screen, for profiling
}
// Rapture Chess's real 3D arena loads after the first screen is up, so it never delays it (the CSS arena stays as the
// fallback). Its frame rate and draw calls are on window.tessaract.arenaStats(), for profiling.
// Measured (scripts/profile-web.mjs --gpu --detail): about 0.3-0.45 s of main-thread work, once, so it waits for an
// idle moment rather than landing on the player's first click.
const upgradeArena = () => { void arena.upgrade().then((ok) => { if (ok) performance.mark("tessaract:arena3d"); }); };
// ?arena=css keeps the CSS arena (for comparisons, and for players who prefer it).
if (q.get("arena") === "css") document.getElementById("arena").dataset.fallback = "turned off (?arena=css)";
else setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(upgradeArena, { timeout: 2000 }) : upgradeArena()), 400);
// Champion select is most players' first click: warm its portraits (about 2 MB) at low priority once the title is up,
// so the grid doesn't open on empty frames over a cold cache. Skipped under data saver.
const warmed = [];   // held so the requests aren't dropped with their images
if (!navigator.connection?.saveData) setTimeout(() => { for (const c of snap.cards) { const src = localArt(c.art); if (src) { const i = new Image(); i.decoding = "async"; i.fetchPriority = "low"; i.src = src; warmed.push(i); } } }, 1200);
window.tessaract = { arenaStats: () => arena.stats() };
