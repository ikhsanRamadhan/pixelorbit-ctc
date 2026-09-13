import { ethers } from "hardhat";

/**
 * Chainlink oracle deploy plus Ship wiring on Creditcoin CC3.
 *
 * Run with:
 *   npx hardhat run scripts/deploy-price-oracle.ts --network creditcoinTestnet
 *
 * Prerequisites in env:
 *   SHIP_ADDRESS           — the PixelOrbitShip from deploy-creditcoin.ts. The
 *                            script wires Ship.setPriceOracle, so it must be set.
 *   BLOCK_PROVER_ADDRESS   — defaults to the real 0xFD2 precompile. Override
 *                            only for a local mock setup.
 *   SEPOLIA_CHAIN_KEY      — defaults to 1 (Sepolia). Must be nonzero.
 *   SEPOLIA_RPC_URL        — optional Sepolia endpoint used only to read the
 *                            live aggregator behind the Chainlink proxy.
 *                            Defaults to a public endpoint. Use a trusted
 *                            SEPOLIA_RPC_URL; cross-check the returned
 *                            aggregator on Sepolia Etherscan; a wrong emitter
 *                            can be revoked via setFeedEmitter(addr, false).
 *
 * Flow: deploy PixelOrbitPriceOracle(blockProver, chainKey, proxy), then
 * allowlist the live aggregator behind the proxy (aggregator rotation would
 * otherwise brick the feed), then point the Ship flash sale at the oracle.
 * The deployer must own the Ship or the final wiring reverts.
 * The oracle links the vendored EvmV1Decoder library internally (no decoder
 * contract address; the external-decoder path was removed as the live bug).
 */
const DEFAULT_BLOCK_PROVER = "0x0000000000000000000000000000000000000FD2";
const DEFAULT_SEPOLIA_CHAIN_KEY = 1;
const DEFAULT_SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// Chainlink Sepolia ETH/USD proxy (8 decimals). Must stay identical to
// CHAINLINK_SEPOLIA_ETH_USD_PROXY in worker/attestcoin-bridge/src/price.ts:
// the worker watches this proxy and the oracle allowlists the same feed.
const CHAINLINK_SEPOLIA_ETH_USD_PROXY = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

// Minimal EACAggregatorProxy read surface: the AnswerUpdated event is emitted
// by the aggregator behind the proxy, so the live address is resolved here.
const PROXY_AGGREGATOR_ABI = ["function aggregator() view returns (address)"];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying price oracle to Creditcoin CC3 with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const blockProver = process.env.BLOCK_PROVER_ADDRESS ?? DEFAULT_BLOCK_PROVER;
  if (!ethers.isAddress(blockProver)) {
    throw new Error(`BLOCK_PROVER_ADDRESS is not an address: "${blockProver}"`);
  }
  if (blockProver === ethers.ZeroAddress) {
    throw new Error("BLOCK_PROVER_ADDRESS must not be the zero address; use the 0xFD2 precompile or a mock address");
  }
  const rawChainKey = process.env.SEPOLIA_CHAIN_KEY;
  const chainKey = rawChainKey === undefined ? DEFAULT_SEPOLIA_CHAIN_KEY : Number(rawChainKey);
  if (!Number.isInteger(chainKey) || chainKey === 0) {
    throw new Error(`SEPOLIA_CHAIN_KEY must be a nonzero integer, got "${rawChainKey}"`);
  }
  const shipAddress = process.env.SHIP_ADDRESS;
  if (!shipAddress || !ethers.isAddress(shipAddress)) {
    throw new Error("Set SHIP_ADDRESS to the deployed PixelOrbitShip address before deploying the price oracle");
  }
  if (shipAddress === ethers.ZeroAddress) {
    throw new Error("SHIP_ADDRESS must not be the zero address; set it to the deployed PixelOrbitShip address");
  }
  console.log("BlockProver:", blockProver);
  console.log("Sepolia chain key:", chainKey);
  console.log("Ship:", shipAddress);
  console.log("Feed proxy:", CHAINLINK_SEPOLIA_ETH_USD_PROXY);

  const Oracle = await ethers.getContractFactory("PixelOrbitPriceOracle");
  const oracle = await Oracle.deploy(blockProver, chainKey, CHAINLINK_SEPOLIA_ETH_USD_PROXY);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log("PixelOrbitPriceOracle deployed to:", oracleAddr);

  // Allowlist the live aggregator behind the proxy. Skipped gracefully when
  // the proxy is unreachable from here; the owner can add it later via
  // setFeedEmitter once the Sepolia state is reachable.
  // Use a trusted SEPOLIA_RPC_URL; cross-check the returned aggregator on
  // Sepolia Etherscan; a wrong emitter can be revoked via setFeedEmitter(addr, false).
  console.log("\n=== FEED EMITTER ===");
  try {
    const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC_URL;
    const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
    const proxy = new ethers.Contract(CHAINLINK_SEPOLIA_ETH_USD_PROXY, PROXY_AGGREGATOR_ABI, sepoliaProvider);
    const reader = proxy as unknown as { aggregator(): Promise<string> };
    const liveAggregator = await reader.aggregator();
    if (
      ethers.isAddress(liveAggregator) &&
      liveAggregator !== ethers.ZeroAddress &&
      liveAggregator.toLowerCase() !== CHAINLINK_SEPOLIA_ETH_USD_PROXY.toLowerCase()
    ) {
      const tx = await oracle.setFeedEmitter(liveAggregator, true);
      await tx.wait();
      console.log(`setFeedEmitter(${liveAggregator}, true): ${tx.hash}`);
    } else {
      console.log(`Live aggregator ${liveAggregator} needs no extra allowlisting; proxy already covered.`);
    }
  } catch {
    console.log("Could not read the live aggregator from the Sepolia proxy; skipping.");
    console.log("Add it later with setFeedEmitter once Sepolia is reachable.");
  }

  // Wire the Ship flash sale at the oracle. Ownership is checked first so a
  // wrong signer fails with a clear message instead of an Ownable revert.
  // owner() plus the setPriceOracle selector is sufficient: a non-Ship
  // address reverts on owner(), so no extra priceOracle() read is needed.
  console.log("\n=== WIRING ===");
  const ship = await ethers.getContractAt("PixelOrbitShip", shipAddress);
  const shipOwner: string = await ship.owner();
  if (shipOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer.address} is not the Ship owner (${shipOwner}); run setPriceOracle from the owner account`,
    );
  }
  const wireTx = await ship.setPriceOracle(oracleAddr);
  await wireTx.wait();
  console.log(`setPriceOracle(${oracleAddr}) on Ship: ${wireTx.hash}`);

  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_PRICE_ORACLE_ADDRESS=${oracleAddr}`);
  console.log("\n=== FOR worker/attestcoin-bridge/.env ===");
  console.log(`PRICE_ORACLE_ADDRESS=${oracleAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
