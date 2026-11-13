// Helpers shared by the plain-node scripts (keeper, verify, site-config, export-templates, check-config): ethers, the
// known networks, the mint config and command-line flags. No Hardhat runtime.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const ethers = require("ethers");
export const NETWORKS = require("./networks.json");
export const config = require("./config.js");
export const { DRAND_EVMNET } = require("./deploy.js");

/** --name value pairs and bare --flags -> { name: value | true, _: [positional] }. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

/** A network from networks.json; RPC_URL (or LITVM_RPC_URL for liteforge) overrides its RPC. */
export function networkInfo(name) {
  const n = NETWORKS[name];
  if (!n || typeof n !== "object") throw new Error(`unknown network ${name}: add it to scripts/lib/networks.json`);
  const rpc = process.env.RPC_URL || (name === "liteforge" ? process.env.LITVM_RPC_URL : null) || n.rpc;
  return { ...n, network: name, rpc, explorer: process.env.EXPLORER_URL || n.explorer };
}

export const provider = (net) => new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true, batchMaxCount: 1 });

/** Load a mint config or exit with its problems listed. */
export function loadConfigOrExit(file) {
  const { cfg, problems, warnings } = config.loadConfig(file);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (problems.length) {
    console.error(`${file}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  return cfg;
}

/** The deployment record deploy.js wrote for this config and network, or exit. */
export function deploymentOrExit(cfg, network) {
  const dep = config.readDeployments(cfg, network);
  if (!dep?.shop) {
    console.error(`no deployment for ${network}: run the deploy first (it writes ${config.deploymentsFile(cfg, network)})`);
    process.exit(1);
  }
  return dep;
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Human-readable ABI fragments for the collection reads.
export const ORIGIN_TUPLE = "tuple(uint64 chainId, address collection, uint256 tokenId)";
export const DESIGN_TUPLE = "tuple(bytes32 designHash, bytes32 art, bytes32 turntable, bytes32 overridesHash, bytes32 avatar, bytes32 avatarPlain, bytes32 soul, uint8 kit, string name, string epithet)";
export const CARD_TUPLE = "tuple(address drop, uint64 profileId, uint32 index, uint16 setId, uint8 kind, uint8 faction, uint8 alignment, uint8 element, uint8 frame, uint32 bodyparts, bool revealed, bool custodial, bytes32 entropyCommit, bytes32 sealedCommit)";
export const STATS_TUPLE = "tuple(uint16 strength, uint16 agility, uint16 resilience, uint16 intelligence, uint32 level, uint64 experience)";
