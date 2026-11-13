// Verify a deployed minter: prove the code on chain is this package's build, write the explorer package, and (only
// when asked) submit it to the network's Blockscout explorer.
//
//   pnpm compile && node scripts/verify.mjs --config my-drop/mint.config.json [--network local]
//   VERIFY_CONFIRM=liteforge node scripts/verify.mjs --config my-drop/mint.config.json          (submits)
//
// For the shop (and any helper contract the deploy created and listed in alsoVerify) it reads eth_getCode and compares it with the
// compiled runtime code, immutables masked and the metadata hash included, so a match means the sources and settings
// are exactly these. It checks the ABI-encoded constructor arguments against the creation transaction, then writes
// verification/<network>/<Contract>.standard-input.json, .constructor-args.txt and result.json: the minimal standard
// JSON input anyone can recompile. Read-only unless VERIFY_CONFIRM names the network and an explorer is configured
// (scripts/lib/networks.json, or EXPLORER_URL). Blockscout's Etherscan-compatible API returns a job id, polled here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers, parseArgs, networkInfo, provider, loadConfigOrExit, deploymentOrExit } from "./lib/chain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** artifacts/<source path>/<Name>.json for a contract name, wherever its source lives. */
function artifactOf(name) {
  const root = path.join(ROOT, "artifacts");
  const hits = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((f) => path.basename(f) === `${name}.json`) : [];
  if (hits.length !== 1) throw new Error(hits.length ? `${name} is ambiguous in artifacts/` : `no artifact for ${name}: run pnpm compile first`);
  return path.join(root, hits[0]);
}

const args = parseArgs();
const cfg = loadConfigOrExit(args.config || process.env.MINT_CONFIG || "mint.config.json");
const NET = args.network || cfg.network;
const dep = deploymentOrExit(cfg, NET);
const net = networkInfo(NET);
const p = provider(net);
const submit = process.env.VERIFY_CONFIRM === NET;
const outDir = path.join(ROOT, "verification", NET);

function build(name) {
  const art = artifactOf(name);
  const source = JSON.parse(fs.readFileSync(art, "utf8")).sourceName;
  const dbg = JSON.parse(fs.readFileSync(art.replace(/\.json$/, ".dbg.json"), "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(path.dirname(art), dbg.buildInfo), "utf8"));
  const out = bi.output.contracts[source][name];
  return { source, name, abi: out.abi, bi, deployed: out.evm.deployedBytecode, creation: out.evm.bytecode.object, metadata: JSON.parse(out.metadata) };
}

/** Zero the immutable slots (their values are set by the constructor) so runtime code can be compared. */
function mask(hex, refs) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  for (const list of Object.values(refs ?? {})) for (const { start, length } of list) b.fill(0, start, start + length);
  return b.toString("hex");
}

async function verifyOne(name, address, ctorArgs, txHash) {
  const b = build(name);
  const code = await p.getCode(address);
  if (code === "0x") throw new Error(`${name}: no code at ${address} on ${NET}`);
  const same = mask(code, b.deployed.immutableReferences) === mask(b.deployed.object, b.deployed.immutableReferences);
  if (!same) throw new Error(`${name} at ${address}: the code on chain is not this build (other sources or settings). Check out the commit it was deployed from.`);
  const encoded = new ethers.Interface(b.abi).encodeDeploy(ctorArgs).slice(2);
  if (txHash) {
    const tx = await p.getTransaction(txHash);
    if (tx && !tx.data.toLowerCase().endsWith(encoded.toLowerCase())) throw new Error(`${name}: the creation transaction ${txHash} has other constructor arguments than the record`);
  }
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(Object.keys(b.metadata.sources).map((s) => [s, b.bi.input.sources[s]])),
    settings: b.bi.input.settings,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, name);
  fs.writeFileSync(`${base}.standard-input.json`, JSON.stringify(input));
  fs.writeFileSync(`${base}.constructor-args.txt`, encoded + "\n");
  const result = { contract: `${b.source}:${name}`, address, network: NET, chainId: net.chainId, compiler: `v${b.bi.solcLongVersion}`, sources: Object.keys(input.sources).length, codeMatches: true, checkedAt: new Date().toISOString() };
  console.log(`${name} ${address}: the code on chain matches this build (${result.compiler}, ${result.sources} sources)`);
  if (!submit) return result;
  if (!net.explorer) throw new Error(`no explorer configured for ${NET}: set it in scripts/lib/networks.json or EXPLORER_URL`);
  result.submission = await submitToBlockscout(net.explorer, { address, contract: result.contract, compiler: result.compiler, args: encoded, input });
  return result;
}

async function submitToBlockscout(explorer, { address, contract, compiler, args: ctor, input }) {
  const api = `${explorer.replace(/\/+$/, "")}/api`;
  const form = new URLSearchParams({
    module: "contract", action: "verifysourcecode", codeformat: "solidity-standard-json-input", contractaddress: address,
    contractname: contract, compilerversion: compiler, licenseType: "apache_2_0", sourceCode: JSON.stringify(input),
    constructorArguments: ctor, constructorArguements: ctor,   // explorers differ on which spelling they read
  });
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(api, { method: "POST", body: form, signal: AbortSignal.timeout(30000) }).then((x) => x.json()).catch((e) => ({ status: "0", result: e.message }));
    if (r.status === "1") {
      console.log(`submitted ${contract}: job ${r.result}`);
      for (let i = 0; i < 24; i++) {
        await new Promise((ok) => setTimeout(ok, 5000));
        const s = await fetch(`${api}?module=contract&action=checkverifystatus&guid=${encodeURIComponent(r.result)}`).then((x) => x.json()).catch(() => null);
        if (s?.result && !/pending|queue/i.test(s.result)) { console.log(`explorer: ${s.result}`); return { guid: r.result, status: s.result }; }
      }
      return { guid: r.result, status: "still pending: post it again in a few minutes" };
    }
    if (/already verified/i.test(String(r.result))) { console.log("explorer: already verified"); return { status: "already verified" }; }
    if (attempt >= 3) throw new Error(`explorer refused the submission: ${r.result}`);
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}

const results = [await verifyOne(dep.contract, dep.shop, dep.shopArgs, dep.shopTx)];
for (const x of dep.alsoVerify ?? []) results.push(await verifyOne(x.contract, x.address, x.args ?? [], x.tx));
fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), outDir)}${submit ? "" : `  (read-only: set VERIFY_CONFIRM=${NET} to submit to the explorer)`}`);
