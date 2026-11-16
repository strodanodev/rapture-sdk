// Mint (fixed price): the catalogue, each card with its edition count, a quantity and a Mint button.
import { boot, el, cardFace } from "./app.js";
import { fixedConfig, readMinter, readEditions, mint, MAX_PER_TX } from "./lib/fixed.js";
import { formatAmount } from "./lib/shop.js";
import { createHoldings } from "./lib/holdings.js";

const ctx = await boot("mint");
if (ctx) {
  const { site, wallet, main, say } = ctx;
  const sym = site.chain.currency.symbol;
  if (site.mint.mode !== "fixed") {
    main.replaceChildren(el("section", { class: "panel" }, el("h1", { text: "This drop sells packs" }), el("p", {}, el("a", { href: "packs/index.html", text: "Go to the packs" }))));
  } else if (!site.mint.address) {
    main.replaceChildren(el("section", { class: "panel" }, el("h1", { text: "Not open yet" }), el("p", { text: "Minting opens once the minter is deployed." })));
  } else {
    const cfg = fixedConfig(site);
    const holdings = site.mint.collection ? createHoldings({ site }) : null;
    const summary = el("p", { class: "lead" });
    const grid = el("div", { class: "grid" });
    const minted = el("section", { class: "minted", hidden: true });
    main.replaceChildren(el("section", {}, el("h1", { text: "Mint" }), summary, minted, grid));
    let busy = false;

    async function draw() {
      let s, editions;
      try {
        s = await readMinter(cfg, wallet.address ?? undefined);
        editions = await readEditions(cfg, s.templateCount);
      } catch (e) { say(e.message, "error"); return; }
      const limit = s.mintable === undefined || s.mintable === Infinity ? "" : ` · you may mint ${s.mintable} more`;
      summary.textContent = `${formatAmount(s.price, 4, "ceil")} ${sym} a card · ${s.totalMinted} of ${s.maxSupply} minted${s.paused ? " · minting is paused" : ""}${limit}`;
      grid.replaceChildren(...editions.filter((e) => !e.retired).map((e) => {
        const max = Math.max(1, Math.min(MAX_PER_TX, e.left, s.mintable ?? Infinity));
        const qty = el("input", { type: "number", min: 1, max, value: 1, "aria-label": "How many", class: "qty" });
        const total = () => s.price * BigInt(Math.max(1, Math.min(max, Number(qty.value) || 1)));
        const button = el("button", { type: "button", class: "button primary", disabled: e.left === 0 || s.paused || busy });
        const label = () => { button.textContent = e.left === 0 ? "Sold out" : `Mint · ${formatAmount(total(), 4, "ceil")} ${sym}`; };
        qty.addEventListener("input", label);
        label();
        button.addEventListener("click", async () => {
          const q = Math.max(1, Math.min(max, Number(qty.value) || 1));
          busy = true;
          grid.querySelectorAll("button").forEach((b) => { b.disabled = true; });
          try {
            if (!wallet.connected) await wallet.connect();
            const r = await mint(wallet, cfg, e.id, q, { onStage: (st) => say({ signing: "Confirm the mint in your wallet…", pending: "Minting on chain…", confirmed: "Minted!" }[st]) });
            holdings?.remember(wallet.address, r.tokenIds, r.tokenIds.map(() => ({ templateId: e.id })));
            minted.hidden = false;
            minted.replaceChildren(el("h2", { text: `You minted ${r.tokenIds.length} card${r.tokenIds.length === 1 ? "" : "s"}` }),
              el("div", { class: "grid" }, r.tokenIds.map((t) => cardFace(site, e.id, { caption: `Token ${t}` }))),
              el("p", {}, el("a", { href: "library.html", text: "See all your cards" })));
            say("Minted! The cards are in your wallet.", "ok");
          } catch (err) { say(err.message, "error"); }
          busy = false;
          draw();
        });
        return el("div", { class: "offer" }, cardFace(site, e.id, { caption: `${e.left} of ${e.maxSupply} left` }), el("div", { class: "offer-buy" }, qty, button));
      }));
    }
    wallet.subscribe(() => { if (!busy) draw(); });
    draw();
  }
}
