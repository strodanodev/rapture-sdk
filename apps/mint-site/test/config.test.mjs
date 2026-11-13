// lib/config.js: the one config file (validation, CSP, wallet chain, art paths) and the committed template's state.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateSiteConfig, cspFor, walletChain, cardArt, loadSiteConfig, DRAND_HOSTS } from "../web/lib/config.js";
import { vercelConfig } from "../scripts/vercel.mjs";

const TEMPLATE = JSON.parse(readFileSync(new URL("../web/site.config.json", import.meta.url), "utf8"));
const clone = () => structuredClone(TEMPLATE);
const ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

test("the committed template is valid and not deployed yet (mint.address null: the pages say so)", () => {
  const { problems, warnings } = validateSiteConfig(TEMPLATE);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => /mint.address is not set/.test(w)));
  assert.equal(TEMPLATE.mint.address, null);
  assert.equal(TEMPLATE.chain.id, 4441);
  assert.equal(TEMPLATE.chain.rpc, "https://rpc.testnet.liteforge.zeeve.net/");
  assert.ok(!JSON.stringify(TEMPLATE).includes("caldera"), "the Caldera endpoints are gone");
});

test("the committed vercel.json is the one the template config needs", () => {
  const committed = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, vercelConfig(TEMPLATE));
  assert.equal(committed.outputDirectory, "web");
});

test("validation names every problem instead of guessing", () => {
  const c = clone();
  c.name = "";
  c.chain.rpc = "http://rpc.example.com";          // plain http is for a local node only
  c.mint.mode = "auction";
  c.mint.address = "0x123";
  c.branding.colors.accent = "blue";
  c.art.cards = "art/cards/card.svg";              // no {id}
  c.art.hero = "https://cdn.example.com/hero.png"; // not same-origin
  c.kinds = ["one"];
  c.cards.push({ ...c.cards[0] });                 // duplicate id
  c.ipfsGateway = "https://ipfs.io/ipfs";          // no trailing slash
  const { problems } = validateSiteConfig(c);
  for (const want of [/^name/, /chain.rpc/, /mint.mode/, /mint.address/, /colors.accent/, /art.cards must contain \{id\}/, /art.hero must be a path inside/, /^kinds/, /listed twice/, /ipfsGateway/]) {
    assert.ok(problems.some((p) => want.test(p)), `${want} in:\n${problems.join("\n")}`);
  }
  assert.deepEqual(validateSiteConfig(null).problems, ["the site config is not a JSON object"]);
  const local = clone();
  local.chain.rpc = "http://127.0.0.1:8547";
  assert.deepEqual(validateSiteConfig(local).problems, [], "a local node over plain http is fine");
  const traversal = clone();
  traversal.branding.logo = "../secrets.svg";
  assert.ok(validateSiteConfig(traversal).problems.some((p) => /branding.logo/.test(p)));
});

test("cspFor: same-origin everything plus exactly the RPC, the drand mirrors (packs only) and the IPFS gateway", () => {
  const fixed = cspFor(TEMPLATE);
  assert.match(fixed, /script-src 'self';/);
  assert.match(fixed, /style-src 'self';/);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(fixed), "nothing inline, no wildcard");
  assert.match(fixed, /connect-src 'self' https:\/\/rpc\.testnet\.liteforge\.zeeve\.net;/);
  assert.ok(!fixed.includes("drand"), "a fixed-price site never talks to drand");

  const packs = clone();
  packs.mint.mode = "packs";
  const p = cspFor(packs);
  for (const h of DRAND_HOSTS) assert.ok(p.includes(h), h);
  packs.mint.beacon = { urls: ["https://drand.example.org/"] };
  assert.match(cspFor(packs), /connect-src 'self' https:\/\/rpc\.testnet\.liteforge\.zeeve\.net https:\/\/drand\.example\.org;/);

  const ipfs = clone();
  ipfs.ipfsGateway = "https://gateway.example.net/ipfs/";
  const i = cspFor(ipfs);
  assert.match(i, /img-src 'self' data: blob: https:\/\/gateway\.example\.net;/);
  assert.match(i, /connect-src 'self' https:\/\/rpc\.testnet\.liteforge\.zeeve\.net https:\/\/gateway\.example\.net;/);
  for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(i.includes(d), d);
});

test("walletChain and cardArt follow the config", () => {
  const c = clone();
  assert.deepEqual(walletChain(c), { chainId: 4441, name: "LitVM Liteforge", nativeCurrency: c.chain.currency, rpcUrls: [c.chain.rpc] });
  c.chain.explorer = "https://explorer.example.org";
  assert.equal(walletChain(c).explorer, "https://explorer.example.org");
  assert.equal(cardArt(c, c.cards[3]), "art/cards/3.svg");
  assert.equal(cardArt(c, { ...c.cards[3], art: "art/special.webp" }), "art/special.webp");
  assert.equal(cardArt(c, null), c.art.placeholder);
});

test("loadSiteConfig refuses a broken config with every problem listed", async () => {
  const serve = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const good = { ...clone(), mint: { ...TEMPLATE.mint, address: ADDR } };
  assert.equal((await loadSiteConfig("x", { fetch: serve(good) })).mint.address, ADDR);
  await assert.rejects(loadSiteConfig("x", { fetch: serve({}, 404) }), /HTTP 404/);
  await assert.rejects(loadSiteConfig("x", { fetch: serve({ ...good, kinds: [] }) }), /kinds must name the 5 kinds/);
});
