import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

function collectSolFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSolFiles(full));
    } else if (entry.endsWith(".sol")) {
      out.push(full);
    }
  }
  return out;
}

// Bridge contracts live in <root>/attestcoin, beside the default
// <root>/contracts sources dir.
// Hardhat compiles a single sources dir, so include attestcoin/*.sol here;
// artifacts and typechain typings are emitted exactly like game contracts.
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_, { config }, runSuper) => {
  const paths = (await runSuper()) as string[];
  const attestcoinDir = join(config.paths.root, "attestcoin");
  if (!existsSync(attestcoinDir)) {
    return paths;
  }
  return [...paths, ...collectSolFiles(attestcoinDir)];
});

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      // The linked EvmV1Decoder library inlines a large type-2 decode
      // (common + type-specific + receipt) into the ASC/oracle wrappers.
      // The legacy non-IR codegen hits "stack too deep" on 0.8.26; the
      // compiler-suggested via-IR pipeline resolves it with no logic change.
      viaIR: true,
    },
  },
  networks: {
    hardhat: {},
    creditcoinTestnet: {
      url: "https://rpc.cc3-testnet.creditcoin.network",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 102031,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 11155111,
    },
  },
};

export default config;
