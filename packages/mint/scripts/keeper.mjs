// PackShopV2 keeper: as soon as a sealed pack's drand round is out, prove it and deal the pack, so every pull is fixed
// within seconds and no buyer pays to deal someone else's pack. Dealing is cheap (~0.3M gas per drand round proven,
// ~70k per pack). With --open it also mints dealt packs nobody opened after OPEN_AFTER seconds (the costly part,
// ~4.5M gas a pack). When the chain clock lags real time (PackShopV2's one residual trust), it posts drand's latest
// round to the shop: buyPack never binds a round at or below one already proven there.
//
//   KEEPER_KEY=0x… node scripts/keeper.mjs --config my-drop/mint.config.json          the config's network
//   node scripts/keeper.mjs --config my-drop/mint.config.json --network local          local node (unlocked account 9, no key)
//   flags: --once (one pass and exit)  --open (also mint stale dealt packs)  --network <name>
//   env:   POLL_MS (default 3000), OPEN_AFTER (default 600 s), MAX_DEAL (default 20 packs a transaction), RPC_URL
//
// The shop's address comes from deployments/<network>.json next to the config (scripts/deploy.js writes it). The key is
// read from the environment and never printed. Any funded wallet can keep: dealing is permissionless.
import { ethers, parseArgs, networkInfo, provider, loadConfigOrExit, deploymentOrExit, DRAND_EVMNET } from "./lib/chain.mjs";

const args = parseArgs();
const cfg = loadConfigOrExit(args.config || process.env.MINT_CONFIG || "mint.config.json");
if (cfg.mode !== "packs") { console.error("the keeper is for a packs shop (mode \"packs\"); a fixed-price minter needs none"); process.exit(1); }
const NET = args.network || cfg.network;
const LOCAL = NET === "local";
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const OPEN_AFTER = Number(process.env.OPEN_AFTER ?? 600);
const MAX_DEAL = BigInt(process.env.MAX_DEAL ?? 20);
const GENESIS = BigInt(DRAND_EVMNET.genesis);
const PERIOD = BigInt(DRAND_EVMNET.period);
const CLOCK_WARN_S = 6;   // well inside REVEAL_DELAY x period (13-15 s)
const POST_EVERY = 3n;    // rounds (~9 s) between lag posts: a new pack then binds at least 2 rounds past real time
const PHASE_DEALT = 3n;

const ABI = [
  "function nextToDeal() view returns (uint256)",
  "function latestRound() view returns (uint64)",
  "function nextPackId() view returns (uint256)",
  "function phaseOf(uint256) view returns (uint8)",
  "function packOf(uint256) view returns (address buyer, uint64 round, uint8 phase, uint256 paid, uint16[] templateIds, uint8[] finishes)",
  "function pendingRounds(uint256 upTo, uint256 max) view returns (uint64[])",
  "function deal(uint256 maxPacks, uint64[] rounds, bytes[] signatures) returns (uint256)",
  "function openPack(uint256 packId, uint64[] rounds, bytes[] signatures) returns (uint256[])",
];

const roundTime = (r) => Number(GENESIS + (BigInt(r) - 1n) * PERIOD);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function signatureOf(round) {
  for (const base of DRAND_EVMNET.urls) {
    try {
      const r = await fetch(`${base}/v2/beacons/evmnet/rounds/${round}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (BigInt(j.round) === BigInt(round) && /^[0-9a-f]{128}$/i.test(j.signature)) return "0x" + j.signature;
    } catch { /* next mirror */ }
  }
  return null;
}

async function connect() {
  const dep = deploymentOrExit(cfg, NET);
  const net = networkInfo(NET);
  const p = provider(net);
  if (LOCAL) return { shop: new ethers.Contract(dep.shop, ABI, await p.getSigner(9)), p };
  if (!process.env.KEEPER_KEY) throw new Error("set KEEPER_KEY (any funded wallet; dealing is permissionless)");
  return { shop: new ethers.Contract(dep.shop, ABI, new ethers.Wallet(process.env.KEEPER_KEY, p)), p };
}

async function dealPass(shop) {
  const [next, end] = await Promise.all([shop.nextToDeal(), shop.nextPackId()]);
  if (next >= end) return;
  const pending = await shop.pendingRounds(end - 1n, 16);
  const due = [];
  for (const r of pending) {           // oldest first: dealing stops at the first unproven round anyway
    if (roundTime(r) > now()) break;
    const sig = await signatureOf(r);
    if (!sig) break;
    due.push([r, sig]);
  }
  const rounds = due.map(([r]) => r), sigs = due.map(([, s]) => s);
  const n = await shop.deal.staticCall(MAX_DEAL, rounds, sigs);
  if (n === 0n) return;
  const rc = await (await shop.deal(MAX_DEAL, rounds, sigs)).wait();
  log(`dealt ${n} pack(s) from #${next} (${rounds.length} round(s) proven, gas ${rc.gasUsed})`);
}

let openCursor = 1n;
async function openPass(shop) {
  const next = await shop.nextToDeal();
  for (let id = openCursor; id < next; id++) {
    if ((await shop.phaseOf(id)) !== PHASE_DEALT) { if (id === openCursor) openCursor = id + 1n; continue; }
    const p = await shop.packOf(id);
    if (roundTime(p.round) + OPEN_AFTER > now()) break;
    const rc = await (await shop.openPack(id, [], [])).wait();
    log(`opened stale pack #${id} for ${p.buyer} (gas ${rc.gasUsed})`);
  }
}

async function clockCheck(shop, p) {
  const b = await p.getBlock("latest");
  const lag = now() - Number(b.timestamp);
  if (lag <= CLOCK_WARN_S) return;
  log(`WARN chain clock is ${lag}s behind real time (block ${b.number}): posting drand's latest round`);
  const latest = BigInt(Math.floor((now() - Number(GENESIS)) / Number(PERIOD)) + 1) - 1n;   // the one surely published
  if (latest < (await shop.latestRound()) + POST_EVERY) return;
  const sig = await signatureOf(latest);
  if (!sig) return log("WARN no drand mirror answered; new packs stay bound to the lagging clock");
  const rc = await (await shop.deal(0, [latest], [sig])).wait();
  log(`posted round ${latest} (gas ${rc.gasUsed}): new packs bind to round ${latest + 5n} or later`);
}

const { shop, p } = await connect();
log(`keeping PackShopV2 ${await shop.getAddress()} on ${NET}${args.open ? ", minting stale packs" : ""}`);
for (;;) {
  try {
    await dealPass(shop);
    if (args.open) await openPass(shop);
    if (!LOCAL) await clockCheck(shop, p);
  } catch (e) {
    log("pass failed:", e.shortMessage || e.message);
  }
  if (args.once) break;
  await sleep(POLL_MS);
}
