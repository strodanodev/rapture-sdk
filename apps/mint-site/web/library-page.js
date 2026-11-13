// My cards: every card the connected wallet holds of the collection, newest first.
import { boot, el, cardFace } from "./app.js";
import { createHoldings } from "./lib/holdings.js";

const ctx = await boot("library");
if (ctx) {
  const { site, wallet, main, say } = ctx;
  const lead = el("p", { class: "lead" });
  const grid = el("div", { class: "grid" });
  main.replaceChildren(el("section", {}, el("h1", { text: "My cards" }), lead, grid));
  if (!site.mint.collection) {
    lead.textContent = "The collection is not set in site.config.json yet (mint.collection).";
  } else {
    const holdings = createHoldings({ site });
    let run = 0;
    async function draw() {
      const mine = ++run;
      grid.replaceChildren();
      if (!wallet.connected) {
        lead.replaceChildren("Connect your wallet to see your cards. ",
          el("button", { type: "button", class: "button primary", text: "Connect wallet", onclick: () => wallet.connect().catch((e) => say(e.message, "error")) }));
        return;
      }
      lead.textContent = "Reading your cards from the chain…";
      try {
        const r = await holdings.read(wallet.address);
        if (mine !== run) return;
        lead.textContent = r.balance === 0 ? "No cards yet."
          : `${r.balance} card${r.balance === 1 ? "" : "s"}${r.complete ? "" : ` (found ${r.tokens.length}: the rest are older than this page searches)`}`;
        grid.replaceChildren(...r.tokens.map((t) => cardFace(site, t.templateId, { finish: t.finish, caption: `Token ${t.tokenId}` })));
      } catch (e) { if (mine === run) { lead.textContent = ""; say(e.message, "error"); } }
    }
    wallet.subscribe(draw);
    draw();
  }
}
