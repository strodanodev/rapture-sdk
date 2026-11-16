// The ranked ladder, read from the LitNode mesh (Rapture Chess's src/litnode/ladder.ts). Every node folds the same
// table from MatchBook's finalized results (`GET /progress?ruleset=`): an Elo rating per player key (the title's
// services.leaderboard, k from the game's litnode.eloK), wins, losses, draws and streaks. So any live node will do:
// the page tries the node that hosted the player's last match, then the game's own node (index.html's
// tessaract-litnode meta), then races the freshest bonded nodes NodeDirectory announces.
import { meshSeeds } from "./ranked.js";

const progress = async (node, rulesetId) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${node}/progress?ruleset=${encodeURIComponent(rulesetId)}&limit=100`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${node} answered ${r.status}`);
    const j = await r.json();
    return { node, source: j.source ?? "", scope: j.scope ?? "", players: Number(j.players) || 0, ranking: Array.isArray(j.ranking) ? j.ranking : [], finalized: j.counts?.official ?? 0, pending: j.counts?.pending ?? 0 };
  } finally { clearTimeout(t); }
};

/** A ladder line as shown: every number checked, so a node's odd answer can't break the page. */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const lineOf = (l, i) => ({
  rank: num(l.rank) || i + 1, player: String(l.player ?? ""), rating: Math.round(num(l.rating)), level: num(l.level),
  wins: num(l.wins), losses: num(l.losses), draws: num(l.draws), matches: num(l.matches), streak: num(l.streak), bestStreak: num(l.bestStreak),
});

const caches = new Map();
/**
 * The ladder for `rulesetId` from the first node that answers: { node, source, scope, players, ranking, finalized,
 * pending }. `hints` (node origins) are tried first, in order. Kept for a minute unless `fresh`.
 */
export async function readLadder({ chain, rulesetId, hints = [], fresh = false }) {
  const hit = caches.get(rulesetId);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.ladder;
  const tried = new Set();
  const attempt = async (url) => {
    if (!url) return null;
    const u = String(url).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(u) || tried.has(u)) return null;
    tried.add(u);
    try { return await progress(u, rulesetId); } catch { return null; }
  };
  let got = null;
  for (const h of hints) if (!got) got = await attempt(h);
  // the mesh: race the freshest few at once (quick tunnels go stale; a dead one only costs its timeout)
  if (!got) {
    const urls = (await meshSeeds(chain)).map((s) => s.url.replace(/\/+$/, "")).filter((u) => !tried.has(u)).slice(0, 6);
    got = await Promise.any(urls.map((u) => progress(u, rulesetId))).catch(() => null);
  }
  if (!got) throw new Error("No LitNode node answered. The mesh may be restarting: try again in a minute.");
  got.ranking = got.ranking.map(lineOf);
  caches.set(rulesetId, { at: Date.now(), ladder: got });
  return got;
}
