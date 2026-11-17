// The built site (web/): the engine bundle and the game it ships with (the starter template; no collection).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { compileGame, createRules, greedyBot, validateGame } from "../web/engine/tessaract.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const GAME = read("../web/data/game.json");
const SNAP = read("../web/data/collection.json");
const toStats = (s) => (s ? { strength: s.str, agility: s.agi, resilience: s.res, intelligence: s.int } : {});

test("the site's game is valid and every unit maps to a collection card with local art", () => {
  assert.deepEqual(validateGame(GAME), []);
  const byToken = new Map(SNAP.cards.map((c) => [String(c.tokenId), c]));
  for (const u of GAME.cards.filter((c) => c.type === "unit" && c.token)) {
    const c = byToken.get(String(u.token.tokenId));
    assert.ok(c, `${u.id} maps to a collection card`);
    assert.ok(c.art.startsWith("./assets/art/") && existsSync(new URL(`../web/${c.art.slice(2)}`, import.meta.url)), `${u.id} art exists`);
  }
});

test("the site's engine plays the shipped game to the end", () => {
  const rules = createRules(compileGame(GAME));
  const bot = greedyBot(rules);
  const [a, b] = SNAP.cards;
  let s = rules.init("web-test", ["you", "bot"], { agents: { you: { stats: toStats(a?.stats) }, bot: { stats: toStats(b?.stats) } } });
  while (!rules.done(s)) s = rules.step(s, { you: 0, bot: 0, [s.p[s.turn].id]: bot(s) });
  assert.ok(s.winner >= 0);
});

test("index.html preloads every client module, so they load in parallel instead of one import level at a time", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const preloaded = new Set([...html.matchAll(/rel="modulepreload" href="\.\/([^"]+)"/g)].map((m) => m[1]));
  const walk = (dir) => readdirSync(new URL(`../web/${dir}/`, import.meta.url), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith(".js") ? [`${dir}/${d.name}`] : []));
  const modules = new Set(["app.js", "engine/tessaract.js", ...walk("ui"), ...walk("lib")]);
  assert.deepEqual([...preloaded].sort(), [...modules].sort());
});

test("the board reads 0.10 unit states from real matches: frozen, silenced, aura, and bounced units", async () => {
  const { unitState } = await import("../web/ui/cards.js");
  const { bouncedOf, alignBoards, suspects } = await import("../web/ui/battle/fx.js");
  const DEMO = read("./fixtures/synergy-duel.game.json");
  const rules = createRules(compileGame(DEMO));
  const bot = greedyBot(rules);
  const seen = { frozen: 0, silenced: 0, aura: 0, bounced: 0 };
  for (let m = 0; m < 16; m++) {
    let s = rules.init(`board-${m}`, ["a", "b"], {});
    while (!s.over) {
      const before = s;
      s = rules.step(s, s.phase === "decks" ? { a: bot(s, 0), b: bot(s, 1) } : { [s.p[s.turn].id]: bot(s) });
      for (const p of s.p) for (const u of p.board) {
        const def = DEMO.cards[u.c], st = unitState(def, u);
        assert.ok(st.label.startsWith(`${def.name}, ${u.atk} attack, ${u.hp} health`));
        if (u.frozen !== undefined) { seen.frozen++; assert.ok(st.frozen && st.label.includes(", frozen") && !st.label.includes("exhausted")); }
        if (u.silenced) { seen.silenced++; assert.ok(st.silenced && st.label.includes(", silenced")); assert.deepEqual(st.keywords, []); }
        else assert.deepEqual(st.keywords, (def.keywords ?? []).map(String));
        if (u.aura) { seen.aura++; assert.match(st.label, / from an aura/); assert.ok(st.notes.some((n) => n.startsWith("Aura: +"))); }
        else assert.ok(!/aura/i.test(st.label));
      }
      if (before.phase === "decks") continue;
      // a bounced unit leaves the board and its card is back in its owner's hand
      for (const i of [0, 1]) {
        const aligned = alignBoards(before.p[i].board, s.p[i].board, suspects(before, s)[i]);
        seen.bounced += bouncedOf(before, s, i, aligned?.dead).size;
      }
    }
  }
  assert.ok(seen.frozen && seen.silenced && seen.aura && seen.bounced, `the demo shows every state: ${JSON.stringify(seen)}`);
  // an old-style unit reads as before
  assert.equal(unitState({ name: "Imp", keywords: ["rush"] }, { c: 0, atk: 1, hp: 2, ready: false }).label, "Imp, 1 attack, 2 health, rush, exhausted");
});
