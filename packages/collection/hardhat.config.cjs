require("@nomicfoundation/hardhat-ethers");

/**
 * Liteforge (LitVM testnet, chain 4441) is an Arbitrum Nitro chain with EVM Shanghai: no Cancun opcodes, so
 * OpenZeppelin is pinned to 5.0.2 (later releases use mcopy) and evmVersion is shanghai. The compiler settings are the
 * ones Rapture's contracts and PackShop were deployed with, so the vendored compatibility test compiles them as live.
 *
 * Keys come from the environment only (DEPLOYER_KEY); nothing in this folder may hold one.
 */
const LITEFORGE_RPC = process.env.LITEFORGE_RPC_URL || "https://rpc.testnet.liteforge.zeeve.net/";

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    // `pnpm node` runs this chain on port 8547 as chain 31338, so it never collides with another local chain.
    hardhat: { chainId: 31338 },
    local: { url: "http://127.0.0.1:8547", chainId: 31338 },
    liteforge: {
      url: LITEFORGE_RPC,
      chainId: 4441,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      timeout: 120_000,
    },
  },
  mocha: { timeout: 120_000 },
};
