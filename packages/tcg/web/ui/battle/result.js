// The result screen (Rapture Chess's): rays behind a gilded emblem, the outcome in big gilded letters, the match in
// four numbers, the two champions face to face (the victor lit, the fallen drained), and what to do next. It lives
// inside the battle screen and covers it.
import { h, icon } from "../dom.js";
import { tile } from "../widgets.js";

export function createResult(app) {
  const title = h("h2", { class: "res-title display" });
  const detail = h("p", { class: "res-detail" });
  const emblem = h("div", { class: "res-emblem" });
  const stats = h("div", { class: "res-stats" });
  const mvp = h("div", { class: "res-mvp" });
  // the champions, large behind it all: yours on the left, the foe's mirrored on the right; the victor lit in gold, the
  // fallen drained (styles: .res-hero)
  const hero = h("img", { class: "res-hero", alt: "", decoding: "async", hidden: true });
  const foeHero = h("img", { class: "res-hero foe", alt: "", decoding: "async", hidden: true });
  const actions = h("div", { class: "res-actions" });
  const shareUrl = h("input", { class: "input", type: "text", readOnly: true, aria: { label: "Replay link" } });
  const share = h("div", { class: "share", hidden: true },
    h("label", { class: "hint", text: "Replay link: anyone with it can watch this match, move by move." }),
    h("div", { class: "share-row" }, shareUrl, h("button", { class: "btn ghost sm", type: "button", on: { click: () => void navigator.clipboard?.writeText(shareUrl.value).then(() => app.toast("Link copied"), () => app.toast("Select the link and copy it", "err")) } }, icon("link"), "Copy")));
  const el = h("div", { class: "result", hidden: true, role: "dialog", aria: { modal: "true", label: "Match result" } },
    h("div", { class: "res-rays" }), hero, foeHero,
    h("div", { class: "res-inner" }, emblem, title, detail, stats, mvp, actions, share));

  return {
    el,
    hide() { el.hidden = true; },
    get open() { return !el.hidden; },
    /**
     * outcome: "win" | "loss" | "draw"; headline; sub; numbers: [[value, label]…]; champion (collection card or null);
     * foe (the opponent's collection card, or null) with foeLabel, and victor ("mine" | "foe" | null): with both
     * champions the card row is a face-off; mineLabel names your side ("You", or a player when watching).
     * buttons: [{ text, icon, primary? | link?, onClick }]; shareLink: async () => url (Share replay), or null.
     * The primary action stands alone, the others share one row at equal widths, and links (Menu) sit underneath.
     */
    show({ outcome, headline, sub, numbers, champion, championNote, foe, foeLabel, mineLabel, victor, buttons, shareLink }) {
      el.dataset.outcome = outcome;
      emblem.replaceChildren(icon(outcome === "win" ? "crown" : outcome === "loss" ? "skull" : "shield"));
      title.textContent = headline;
      detail.textContent = sub;
      stats.replaceChildren(...numbers.map(([v, l]) => tile(String(v), l)));
      mvp.hidden = !champion;
      hero.hidden = !champion?.art;
      if (champion?.art) hero.src = champion.art;
      foeHero.hidden = !(champion && foe?.art);
      if (champion && foe?.art) foeHero.src = foe.art;
      el.dataset.victor = victor ?? "";
      mvp.classList.toggle("res-vs", !!(champion && foe));
      if (champion && foe) {
        // face to face: each champion's card, who holds it, and a VS seal between them
        const side = (c, who, label, note) => h("figure", { class: `fo-side ${who}${victor === who ? " won" : victor ? " lost" : ""}` },
          app.cards.championCard(c, { eager: true }),
          h("figcaption", null, h("span", { class: "eyebrow", text: label }), h("b", { class: "display", text: c.name }), note ? h("span", { class: "hint", text: note }) : null));
        mvp.replaceChildren(side(champion, "mine", mineLabel ?? "You", championNote), h("i", { class: "fo-seal display", text: "VS", aria: { hidden: "true" } }), side(foe, "foe", foeLabel ?? "Opponent", null));
      } else if (champion) mvp.replaceChildren(app.cards.championCard(champion, { eager: true }), h("div", null, h("span", { class: "eyebrow", text: "Your champion" }), h("b", { class: "display", text: champion.name }), h("span", { class: "hint", text: championNote ?? champion.epithet ?? "" })));
      share.hidden = true;
      const make = (b) => h("button", { class: b.link ? "link-btn" : `btn ${b.primary ? "primary lg pulse" : "ghost"}`, type: "button", on: { click: b.onClick } }, icon(b.icon), b.text);
      const rest = buttons.filter((b) => !b.primary && !b.link).map(make);
      if (shareLink) rest.unshift(h("button", { class: "btn ghost", type: "button", on: { click: async () => { shareUrl.value = await shareLink(); share.hidden = false; shareUrl.select(); } } }, icon("link"), "Share replay"));
      const row = (cls, items) => (items.length ? [h("div", { class: cls }, ...items)] : []);
      actions.replaceChildren(...row("res-primary", buttons.filter((b) => b.primary).map(make)), ...row("res-secondary", rest), ...row("res-links", buttons.filter((b) => b.link).map(make)));
      el.hidden = false;
    },
    /** Update the line under the title (settlement status in a two-player match). */
    setDetail(text) { detail.textContent = text; },
  };
}
