// Home: the collection, what it costs, how much is left, and the way in (mint or packs).
import { boot, el } from "./app.js";
import { fixedConfig, readMinter } from "./lib/fixed.js";
import { packConfig, readShop, formatAmount } from "./lib/packshop.js";

const ctx = await boot("index");
if (ctx) {
  const { site, main, say } = ctx;
  const packs = site.mint.mode === "packs";
  const stats = el("dl", { class: "stats" });
  const stat = (label, value) => stats.append(el("div", {}, el("dt", { text: label }), el("dd", { text: value })));
  main.replaceChildren(el("section", { class: "hero" },
    site.art?.hero ? el("img", { class: "hero-art", src: site.art.hero, alt: "", width: 640, height: 400 }) : null,
    el("div", { class: "hero-text" },
      el("h1", { text: site.name }),
      site.tagline ? el("p", { class: "tagline", text: site.tagline }) : null,
      site.description ? el("p", { text: site.description }) : null,
      stats,
      el("p", { class: "actions" },
        el("a", { class: "button primary", href: packs ? "packs.html" : "mint.html", text: packs ? "Open packs" : "Mint cards" }),
        el("a", { class: "button", href: "library.html", text: "My cards" })))));

  const sym = site.chain.currency.symbol;
  if (!site.mint.address) stat("Status", "Not open yet");
  else {
    try {
      if (packs) {
        const s = await readShop(packConfig(site));
        stat("Pack", `${formatAmount(s.price, 4, "ceil")} ${sym} · ${s.packSize} cards`);
        stat("Cards left", `${s.cardsLeft} of ${s.maxSupply}`);
        stat("Sales", s.soldOut ? "Sold out" : s.paused ? "Paused" : "Open");
      } else {
        const s = await readMinter(fixedConfig(site));
        stat("Price", `${formatAmount(s.price, 4, "ceil")} ${sym} a card`);
        stat("Minted", `${s.totalMinted} of ${s.maxSupply}`);
        stat("Sales", s.soldOut ? "Sold out" : s.paused ? "Paused" : "Open");
      }
    } catch (e) { say(e.message, "error"); }
  }
}
