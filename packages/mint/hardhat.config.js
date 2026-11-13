require("@nomicfoundation/hardhat-ethers");
const fs = require("node:fs");
const path = require("node:path");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, TASK_TEST_GET_TEST_FILES,
} = require("hardhat/builtin-tasks/task-names");
const NETWORKS = require("./scripts/lib/networks.json");

/**
 * packs/ is PackShop v2 (the pack option): Rapture's private build carries it, the public kit does not (the mirror drops
 * the folder until the pack shop launches). When it is here, its contracts compile and its tests run with the rest.
 */
const PACKS = path.join(__dirname, "packs");
const files = (dir, ext) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f))
  : []);
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (args, hre, runSuper) => [
  ...(await runSuper(args)), ...files(path.join(PACKS, "contracts"), ".sol"),
]);
subtask(TASK_TEST_GET_TEST_FILES, async (args, hre, runSuper) => {
  const tests = await runSuper(args);
  return args.testFiles?.length ? tests : [...tests, ...files(path.join(PACKS, "test"), ".test.js")];
});

/**
 * LitVM Liteforge (chain 4441) is an Arbitrum Nitro chain with EVM Shanghai: no Cancun opcodes, so OpenZeppelin is
 * pinned to 5.0.2 (5.6 uses mcopy). Compiler settings match the Rapture contracts and Rapture's verified PackShop.
 * The compiler is the `solc` npm package (solc-js 0.8.28, the same compiler as the native build, same bytecode), so
 * `pnpm run check` compiles offline once dependencies are installed.
 */
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion !== "0.8.28" || process.env.RAPTURE_NATIVE_SOLC) return runSuper();
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: "0.8.28+commit.7893614a" };
});

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    // `pnpm node` sets HARDHAT_TICK_MS so blocks also arrive on a timer. Chain 31338 on port 8547, so this dev chain
    // never collides with another local chain in the wallet or on the machine.
    hardhat: { chainId: 31338, ...(process.env.HARDHAT_TICK_MS ? { mining: { auto: true, interval: Number(process.env.HARDHAT_TICK_MS) } } : {}) },
    local: { url: NETWORKS.local.rpc, chainId: NETWORKS.local.chainId },
    liteforge: {
      url: process.env.LITVM_RPC_URL || NETWORKS.liteforge.rpc,
      chainId: NETWORKS.liteforge.chainId,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
  mocha: { timeout: 900000 },
};
