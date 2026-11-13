// Source verification on a Blockscout explorer, through its Etherscan-compatible API (POST <explorer>/api,
// module=contract, action=verifysourcecode, standard JSON input), then polling checkverifystatus.
//
// The standard JSON input carries ONLY the sources the contract was compiled from (from solc's own metadata), so
// the package is small and anyone can recompile it and compare against eth_getCode.

/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */

/**
 * @typedef {{ solcLongVersion: string, input: { language: string, sources: Record<string, { content: string }>, settings: Record<string, unknown> },
 *   output: { contracts: Record<string, Record<string, { metadata: string }>> } }} BuildInfo
 */

/**
 * The minimal standard JSON input for one contract of a Hardhat build.
 * @param {BuildInfo} build
 * @param {string} sourceName  e.g. contracts/ChampionCollection.sol
 * @param {string} contractName e.g. ChampionCollection
 */
export function standardInput(build, sourceName, contractName) {
  const c = build.output.contracts[sourceName]?.[contractName];
  if (!c) throw new Error(`${sourceName}:${contractName} is not in this build`);
  const used = Object.keys(JSON.parse(c.metadata).sources);
  const sources = Object.fromEntries(used.map((p) => [p, { content: build.input.sources[p].content }]));
  const settings = { ...build.input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } };
  return { input: { language: 'Solidity', sources, settings }, compilerVersion: `v${build.solcLongVersion}` };
}

/**
 * @param {{ explorer: string, address: string, sourceName: string, contractName: string, build: BuildInfo,
 *   constructorArgs: string, fetch?: Fetch, pollMs?: number, maxPolls?: number, log?: (m: string) => void }} o
 *   constructorArgs: ABI-encoded constructor arguments (hex, with or without 0x)
 * @returns {Promise<{ status: 'verified' | 'already', message: string }>}
 */
export async function verifyOnBlockscout(o) {
  const f = o.fetch ?? /** @type {Fetch} */ (globalThis.fetch);
  const api = `${o.explorer.replace(/\/+$/, '')}/api`;
  const log = o.log ?? (() => {});

  const existing = await f(`${api}?module=contract&action=getsourcecode&address=${o.address}`);
  if (existing.ok) {
    const j = /** @type {{ result?: Array<{ SourceCode?: string }> }} */ (await existing.json());
    if (j.result?.[0]?.SourceCode) return { status: 'already', message: `${o.address} is already verified` };
  }

  const { input, compilerVersion } = standardInput(o.build, o.sourceName, o.contractName);
  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: o.address,
    sourceCode: JSON.stringify(input),
    codeformat: 'solidity-standard-json-input',
    contractname: `${o.sourceName}:${o.contractName}`,
    compilerversion: compilerVersion,
    constructorArguements: o.constructorArgs.replace(/^0x/, ''),   // sic: the Etherscan API's spelling
  });
  const r = await f(api, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (!r.ok) throw new Error(`Blockscout answered ${r.status}: ${await r.text()}`);
  const sub = /** @type {{ status: string, result: string, message?: string }} */ (await r.json());
  if (sub.status !== '1') {
    if (/already verified/i.test(sub.result)) return { status: 'already', message: sub.result };
    throw new Error(`verification not accepted: ${sub.result ?? sub.message}`);
  }
  const guid = sub.result;
  log(`submitted ${o.contractName} (${guid})`);
  for (let i = 0; i < (o.maxPolls ?? 30); i++) {
    await new Promise((res) => setTimeout(res, o.pollMs ?? 5000));
    const s = await f(`${api}?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`);
    const j = /** @type {{ status: string, result: string }} */ (await s.json());
    if (/pending|queue|in progress/i.test(j.result)) continue;
    if (j.status === '1' || /pass|verified/i.test(j.result)) return { status: 'verified', message: j.result };
    throw new Error(`verification failed: ${j.result}`);
  }
  throw new Error(`verification of ${o.contractName} still pending after ${o.maxPolls ?? 30} polls (guid ${guid})`);
}
