// Packs (PackShopV2): buy a sealed pack, watch its drand round arrive, open it, and see the cards turn over.
import { boot, el, cardFace, REDUCED_MOTION } from "./app.js";
import { packConfig, readShop, readDeck, readShutdownAt, findMyPacks, refundPack, refundableAt, formatAmount, PHASE } from "./lib/packshop.js";
import { createPackFlow } from "./lib/packflow.js";
import { createHoldings } from "./lib/holdings.js";

const UNOPENED = new Set([PHASE.Waiting, PHASE.Ready, PHASE.Dealt]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await boot("packs");
if (ctx) {
  const { site, wallet, main, say } = ctx;
  const sym = site.chain.currency.symbol;
  if (site.mint.mode !== "packs") {
    main.replaceChildren(el("section", { class: "panel" }, el("h1", { text: "This drop sells cards at a fixed price" }), el("p", {}, el("a", { href: "mint.html", text: "Go to the mint" }))));
  } else if (!site.mint.address) {
    main.replaceChildren(el("section", { class: "panel" }, el("h1", { text: "Not open yet" }), el("p", { text: "Packs go on sale once the shop is deployed." })));
  } else {
    const cfg = packConfig(site);
    const flow = createPackFlow(wallet, cfg);
    const holdings = site.mint.collection ? createHoldings({ site }) : null;
    const facts = el("dl", { class: "stats" });
    const deckTable = el("table", { class: "deck" });
    const buy = el("button", { type: "button", class: "button primary big" });
    const mine = el("section", { class: "my-packs", hidden: true });
    const stage = el("section", { class: "stage", hidden: true });
    main.replaceChildren(
      el("section", { class: "shop" },
        site.art?.pack ? el("img", { class: "pack-art", src: site.art.pack, alt: "A sealed pack", width: 240, height: 340 }) : null,
        el("div", {}, el("h1", { text: "Packs" }), facts, el("p", { class: "actions" }, buy),
          el("p", { class: "fine", text: "Each pack is bound to a drand round about 15 seconds after you buy it. Nobody, not even the shop, can know its cards before that round is published, and they are dealt from a fixed print run." }))),
      stage, mine, el("section", {}, el("h2", { text: "What is left in the print run" }), deckTable));

    let shop = null, shutdownAt = 0, working = false;

    async function refresh() {
      try {
        const [s, deck, shut] = await Promise.all([readShop(cfg, wallet.address ?? undefined), readDeck(cfg), readShutdownAt(cfg)]);
        shop = s; shutdownAt = shut;
        facts.replaceChildren(...[
          ["Price", `${formatAmount(s.price, 4, "ceil")} ${sym}`],
          ["Cards a pack", String(s.packSize)],
          ["Cards left", `${s.cardsLeft} of ${s.maxSupply}`],
          ...(s.packsLeft !== undefined && s.dailyLimit ? [["Your packs left today", s.packsLeft === Infinity ? "no limit" : String(s.packsLeft)]] : []),
        ].map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }))));
        deckTable.replaceChildren(
          el("thead", {}, el("tr", {}, el("th", { text: "" }), site.finishes.map((f) => el("th", { text: f })))),
          el("tbody", {}, deck.map((row, k) => el("tr", {}, el("th", { text: site.kinds[k] }), row.map((n) => el("td", { text: String(n) }))))));
        const closed = shut ? "The shop has closed" : s.soldOut ? "Sold out" : s.paused ? "Sales are paused" : null;
        buy.textContent = closed ?? (wallet.connected ? `Buy a pack · ${formatAmount(s.price, 4, "ceil")} ${sym}` : "Connect & buy a pack");
        buy.disabled = !!closed || working;
        await drawMine();
      } catch (e) { say(e.message, "error"); }
    }

    async function drawMine() {
      if (!wallet.connected) { mine.hidden = true; return; }
      const packs = (await findMyPacks(cfg, wallet.address)).filter((p) => UNOPENED.has(p.phase));
      mine.hidden = !packs.length;
      const now = Date.now() / 1000;
      mine.replaceChildren(el("h2", { text: "Your sealed packs" }), el("ul", {}, packs.map((p) => {
        const refundAt = refundableAt(p.round, shutdownAt);
        return el("li", {}, `Pack #${p.packId} · ${p.phaseName === "Waiting" ? "waiting for its drand round" : p.phaseName === "Dealt" ? "cards dealt, ready to open" : "ready to open"} `,
          el("button", { type: "button", class: "button", disabled: working, text: "Open", onclick: () => run(() => openFlow(p)) }),
          refundAt && refundAt <= now ? el("button", { type: "button", class: "button", disabled: working, text: "Refund", onclick: () => run(() => refund(p)) }) : null);
      })));
    }

    async function run(fn) {
      if (working) return;
      working = true;
      buy.disabled = true;
      mine.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try { await fn(); } catch (e) { say(e.message, "error"); }
      working = false;
      refresh();
    }

    async function openFlow(pack) {
      stage.hidden = false;
      const line = el("p", { class: "lead" });
      stage.replaceChildren(el("h2", { text: `Pack #${pack.packId}` }), line);
      await flow.waitOpenable(pack, { onTick: ({ secondsLeft }) => { line.textContent = secondsLeft > 0 ? `Sealed. drand round ${pack.round} is published in ${secondsLeft}s…` : `Fetching drand round ${pack.round}…`; } });
      line.textContent = "The round is out: your pack can be opened.";
      const open = el("button", { type: "button", class: "button primary big", text: "Open the pack" });
      stage.append(el("p", { class: "actions" }, open));
      await new Promise((resolve) => open.addEventListener("click", resolve, { once: true }));
      open.disabled = true;
      const r = await flow.open(pack.packId, { onStage: (t) => say(t) });
      holdings?.remember(wallet.address, r.tokenIds, r.templateIds.map((t, i) => ({ templateId: t, finish: r.finishes[i] })));
      await reveal(pack.packId, r);
      say(r.openedElsewhere ? "This pack had already been opened for you: here are its cards." : "Minted! The cards are in your wallet.", "ok");
    }

    async function reveal(packId, r) {
      const order = r.templateIds.map((t, i) => ({ t, f: r.finishes[i], token: r.tokenIds[i] })).sort((a, b) => a.f - b.f);   // best last
      const row = el("div", { class: "grid reveal" });
      stage.replaceChildren(el("h2", { text: `Pack #${packId}` }), row, el("p", {}, el("a", { href: "library.html", text: "See all your cards" })));
      for (const c of order) {
        const slot = el("div", { class: "flip" },
          el("div", { class: "back" }, el("img", { src: site.art?.cardBack ?? site.art?.placeholder ?? "", alt: "", width: 250, height: 350 })),
          el("div", { class: "front" }, cardFace(site, c.t, { finish: c.f, caption: c.token ? `Token ${c.token}` : null })));
        row.append(slot);
      }
      for (const slot of row.children) {
        if (!REDUCED_MOTION) await sleep(450);
        slot.classList.add("turned");
      }
    }

    async function refund(p) {
      const r = await refundPack(wallet, cfg, p.packId, { onStage: (s) => say({ signing: "Confirm the refund in your wallet…", pending: "Refunding on chain…", confirmed: "Refunded." }[s]) });
      say(`Refunded ${formatAmount(r.amount)} ${sym}.`, "ok");
    }

    buy.addEventListener("click", () => run(async () => {
      if (!wallet.connected) { await wallet.connect(); await refresh(); if (shop?.packsLeft === 0) return; }
      const bought = await flow.buy({ onStage: (t) => say(t) });
      await openFlow({ packId: bought.packId, round: bought.round });
    }));
    wallet.subscribe(() => { if (!working) refresh(); });
    refresh();
  }
}
