require("@nomicfoundation/hardhat-ethers");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

/**
 * LitVM Liteforge (chain 4441) is an Arbitrum Nitro chain with EVM Shanghai: no Cancun opcodes, so OpenZeppelin is
 * pinned to 5.0.2 (5.6 uses mcopy). Compiler settings match the Rapture contracts and the verified PackShop v1.
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
    local: { url: "http://127.0.0.1:8547", chainId: 31338 },
    liteforge: {
      url: process.env.LITVM_RPC_URL || "https://rpc.testnet.liteforge.zeeve.net/",
      chainId: 4441,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
  mocha: { timeout: 900000 },
};
