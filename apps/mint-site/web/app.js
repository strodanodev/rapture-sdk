// Mint site — the shell every page shares: load site.config.json, apply its branding, draw the header (logo, name,
// navigation for the mint mode, wallet button) and the footer, and give the page a wallet and a status line.
import { loadSiteConfig, walletChain, cardArt } from "./lib/config.js";
import { createWallet } from "./lib/wallet.js";

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** document.createElement with attributes, text and children. Text is always text: nothing is parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

/** CSS custom properties from branding.colors (CSSOM, so the strict CSP needs no inline style). */
function applyBranding(site) {
  const css = { background: "--bg", surface: "--surface", text: "--text", muted: "--muted", accent: "--accent", accentText: "--accent-text", shiny: "--shiny", gold: "--gold" };
  for (const [k, v] of Object.entries(site.branding?.colors ?? {})) if (css[k]) document.documentElement.style.setProperty(css[k], v);
  const fav = site.branding?.favicon ?? site.branding?.logo;
  if (fav) document.head.append(el("link", { rel: "icon", href: fav }));
}

/** A card's display data: name, epithet, kind name and art path (a token with no known card gets the placeholder). */
export function cardView(site, templateId) {
  const card = (site.cards ?? []).find((c) => c.id === templateId) ?? null;
  return {
    card,
    name: card?.name ?? (templateId == null ? "Unknown card" : `Card ${templateId}`),
    epithet: card?.epithet ?? "",
    kind: card ? site.kinds[card.kind] : "",
    art: card ? cardArt(site, card) : site.art?.placeholder ?? "",
  };
}

/** The face of one card: art, name, kind, and an optional finish badge and caption. */
export function cardFace(site, templateId, { finish = null, caption = null } = {}) {
  const v = cardView(site, templateId);
  const fin = finish ? site.finishes[finish - 1] : null;
  return el("figure", { class: `card${finish ? ` finish-${finish}` : ""}` },
    el("div", { class: "card-art" }, el("img", { src: v.art, alt: v.name, loading: "lazy", width: 250, height: 350 })),
    el("figcaption", {},
      el("strong", { text: v.name }),
      v.epithet ? el("span", { class: "epithet", text: v.epithet }) : null,
      el("span", { class: "meta" }, v.kind, fin && finish > 1 ? el("span", { class: "badge", text: fin }) : null),
      caption ? el("span", { class: "caption", text: caption }) : null));
}

function header(site, page, wallet, say) {
  const nav = [["index", "Home", "index.html"]];
  if (site.mint.mode === "fixed") nav.push(["mint", "Mint", "mint.html"]);
  else nav.push(["packs", "Packs", "packs.html"]);
  nav.push(["library", "My cards", "library.html"]);
  const button = el("button", { class: "wallet-button", type: "button" });
  const menu = el("div", { class: "wallet-menu", hidden: true },
    el("button", { type: "button", text: "Disconnect", onclick: () => { menu.hidden = true; wallet.disconnect(); } }));
  const draw = () => {
    if (!wallet.connected) button.textContent = "Connect wallet";
    else if (!wallet.onCorrectChain) button.textContent = `Switch to ${site.chain.name}`;
    else button.textContent = shortAddress(wallet.address);
    button.classList.toggle("connected", wallet.connected && wallet.onCorrectChain);
  };
  button.addEventListener("click", async () => {
    try {
      if (!wallet.connected) { await wallet.connect(); await wallet.ensureChain(); }
      else if (!wallet.onCorrectChain) await wallet.ensureChain();
      else menu.hidden = !menu.hidden;
    } catch (e) { say(e.message, "error"); }
    draw();
  });
  wallet.subscribe(draw);
  draw();
  return el("header", { class: "site-header" },
    el("a", { class: "brand", href: "index.html" },
      site.branding?.logo ? el("img", { src: site.branding.logo, alt: "", width: 36, height: 36 }) : null,
      el("span", { text: site.name })),
    el("nav", { "aria-label": "Main" }, nav.map(([id, label, href]) => el("a", { href, "aria-current": id === page ? "page" : null, text: label }))),
    el("div", { class: "wallet" }, button, menu));
}

function footer(site) {
  return el("footer", { class: "site-footer" },
    el("span", { text: `${site.name} · on ${site.chain.name}` }),
    site.mint.address && site.chain.explorer ? el("a", { href: `${site.chain.explorer}/address/${site.mint.address}`, rel: "noopener", target: "_blank", text: "Contract" }) : null,
    el("a", { href: "https://github.com/strodanodev/rapture-sdk", rel: "noopener", target: "_blank", text: "Made with the Rapture SDK" }));
}

/**
 * Boot a page: config, branding, header, footer, wallet (restored quietly when the visitor connected before).
 * Resolves { site, wallet, main, say }, or null after showing the config's problems.
 */
export async function boot(page) {
  const main = document.querySelector("main");
  const status = el("p", { class: "status", role: "status", "aria-live": "polite" });
  const say = (text, kind = "info") => { status.textContent = text ?? ""; status.dataset.kind = kind; };
  let site;
  try { site = await loadSiteConfig(); }
  catch (e) {
    main.replaceChildren(el("section", { class: "panel error" }, el("h1", { text: "This site is not set up yet" }), el("pre", { text: e.message })));
    return null;
  }
  applyBranding(site);
  document.title = page === "index" ? site.name : `${document.title} · ${site.name}`;
  const wallet = createWallet({ chain: walletChain(site) });
  document.body.prepend(header(site, page, wallet, say));
  main.before(status);
  document.body.append(footer(site));
  wallet.restore().catch((e) => console.debug("[wallet] restore skipped", e?.message ?? e));
  return { site, wallet, main, say };
}
