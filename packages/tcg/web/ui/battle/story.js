// What a move says and sounds like, read from the action against the state before it: the narration line under the
// medallion, and the battle's sound cues. Names as the HUD shows them, too.
import { decode, Op, ENEMY_CHAMPION } from "../../engine/tessaract.js";
import { landOf } from "./fx.js";

const shortId = (id) => (/^[0-9a-f]{64}$/i.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);
/** A player as the HUD names them: "You", "House bot", or a shortened address. */
export const playerName = (id) => (id === "you" ? "You" : id === "bot" ? "House bot" : shortId(String(id)));
/** "You" in your own replays reads "Your turn", "You win": English needs its own forms for it. */
export const possessive = (name) => (name === "You" ? "Your" : `${name}'s`);

/** One line about what just happened ("" if nothing to say). watching: told as a spectator, by the players' names. */
export function narration(game, before, s, meIdx, watching) {
  const x = s.last;
  if (!before || !x) return "";
  const cardName = (c) => game.cards[c]?.name ?? "a card";
  const { op, a, target } = decode(x);
  const actor = before.turn, P = before.p[actor], E = before.p[actor === 0 ? 1 : 0];
  const who = watching ? playerName(P.id) : actor === meIdx ? "You" : "Opponent";
  const enemyChampion = watching ? `${possessive(playerName(E.id))} champion` : actor === meIdx ? "the enemy champion" : "your champion";
  const theirs = watching ? possessive(playerName(E.id)) : actor === meIdx ? "their" : "your";
  const tgt = () => (target === ENEMY_CHAMPION ? enemyChampion : target < 10 ? `${theirs} ${cardName(E.board[target - 1]?.c)}` : target === 10 ? "" : cardName(P.board[target - 11]?.c));
  if (op === Op.Play) return `${who} played ${cardName(P.hand[a])}${target ? ` → ${tgt()}` : ""}`;
  if (op === Op.Power) return `${who} used ${game.champion.powers?.[P.power]?.name ?? "a power"}${target ? ` → ${tgt()}` : ""}`;
  if (op === Op.Attack) return `${possessive(who)} ${cardName(P.board[a]?.c)} attacked ${tgt()}`;
  if (op === Op.End) return `${who} ended the turn`;
  if (op === Op.Concede) return watching ? `${playerName(s.p[s.winner === 0 ? 1 : 0].id)} conceded` : `${s.winner === meIdx ? "Opponent" : "You"} conceded`;
  return "";
}

/** The battle's sounds for a move: the action, the blow or the healing it caused, the fallen (died: how many), cards drawn. */
export function playCues(app, game, before, s, meIdx, died) {
  const snd = app.sound;
  if (!snd) return;
  const x = s.last ? decode(s.last) : null;
  const land = landOf(before, s, game) / 1000;   // when the action's effect lands, after its own sound (and with its VFX)
  if (x) {
    const P = before.p[before.turn];
    if (x.op === Op.Play) {
      const type = game.cards[P.hand[x.a]]?.type;
      snd.play("card-play");
      snd.play(type === "unit" ? "summon" : type === "relic" ? "relic" : "spell", { delay: 0.1 });
    } else if (x.op === Op.Power) snd.play("power");
    else if (x.op === Op.Attack) snd.play("strike");
    else if (x.op === Op.End) snd.play("end-turn");
  }
  let hurt = x?.op === Op.Attack, healed = false;
  for (const p of [0, 1]) { const d = s.p[p].life - before.p[p].life; if (d < 0) hurt = true; else if (d > 0) healed = true; }
  if (hurt) snd.play("hit", { delay: land });
  if (healed) snd.play("heal", { delay: land });
  if (died) snd.play("death", { delay: land + 0.12 });
  // cards drawn into your hand (a card played from it doesn't count against the draw)
  const drawn = s.p[meIdx].hand.length - before.p[meIdx].hand.length + (x?.op === Op.Play && before.turn === meIdx ? 1 : 0);
  for (let k = 0; k < Math.min(3, drawn); k++) setTimeout(() => snd.play("card-draw"), 150 + k * 130);
}
