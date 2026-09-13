import { ethers } from "hardhat";

import { resolveFeeConfig } from "./config";

/**
 * Full Creditcoin CC3 deploy: StarsCC, Ship, Item, Marketplace, Leaderboard,
 * ASC — then the wiring that makes the bridge live.
 *
 * Run with:
 *   npx hardhat run scripts/deploy-creditcoin.ts --network creditcoinTestnet
 *
 * Prerequisites in env:
 *   DEPLOYER_PRIVATE_KEY — funds every deploy, becomes every contract's owner.
 *   SOURCE_ADDRESS       — the Sepolia PixelOrbitSource, printed by
 *                          deploy-sepolia-source.ts. The ASC checks it on every
 *                          proof, so a wrong address here mints nothing.
 *   BLOCK_PROVER_ADDRESS — defaults to the real 0xFD2 precompile. Override
 *                          only for a local mock setup.
 *   MARKETPLACE_FEE_BIPS / MARKETPLACE_FEE_RECIPIENT — see config.ts.
 *
 * The ASC links the vendored EvmV1Decoder library internally (no decoder
 * contract address; the external-decoder path was removed as the live bug).
 *
 * Wiring order matters: the ASC needs the game addresses at construction, and
 * the game contracts need the ASC after. setMinter is last so no mint can
 * happen before every contract points at the same ASC.
 */
const DEFAULT_BLOCK_PROVER = "0x0000000000000000000000000000000000000FD2";
const SEPOLIA_CHAIN_KEY = 1;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying to Creditcoin CC3 with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const source = process.env.SOURCE_ADDRESS;
  if (!source || !ethers.isAddress(source)) {
    throw new Error("Set SOURCE_ADDRESS to the Sepolia PixelOrbitSource before deploying the ASC");
  }
  const blockProver = process.env.BLOCK_PROVER_ADDRESS ?? DEFAULT_BLOCK_PROVER;
  if (!ethers.isAddress(blockProver)) {
    throw new Error(`BLOCK_PROVER_ADDRESS is not an address: "${blockProver}"`);
  }
  const { feeBips, feeRecipient } = resolveFeeConfig(deployer.address);
  console.log("Sepolia source:", source);
  console.log("BlockProver:", blockProver);
  console.log(`Marketplace fee: ${feeBips} bips -> ${feeRecipient}`);

  // 1. OrbitStarsCC — minter wired after the ASC exists.
  const StarsCC = await ethers.getContractFactory("OrbitStarsCC");
  const starsCC = await StarsCC.deploy();
  await starsCC.waitForDeployment();
  const starsAddr = await starsCC.getAddress();
  console.log("OrbitStarsCC deployed to:", starsAddr);

  // 2. PixelOrbitShip(stars).
  const Ship = await ethers.getContractFactory("PixelOrbitShip");
  const ship = await Ship.deploy(starsAddr);
  await ship.waitForDeployment();
  const shipAddr = await ship.getAddress();
  console.log("PixelOrbitShip deployed to:", shipAddr);

  // 3. PixelOrbitItem() — no constructor args; ASC wired after.
  const Item = await ethers.getContractFactory("PixelOrbitItem");
  const item = await Item.deploy();
  await item.waitForDeployment();
  const itemAddr = await item.getAddress();
  console.log("PixelOrbitItem deployed to:", itemAddr);

  // 4. PixelOrbitMarketplace(stars, feeBips, feeRecipient).
  const Marketplace = await ethers.getContractFactory("PixelOrbitMarketplace");
  const marketplace = await Marketplace.deploy(starsAddr, feeBips, feeRecipient);
  await marketplace.waitForDeployment();
  const marketplaceAddr = await marketplace.getAddress();
  console.log("PixelOrbitMarketplace deployed to:", marketplaceAddr);

  // 5. PixelOrbitLeaderboard() — no constructor args; ASC wired after.
  const Leaderboard = await ethers.getContractFactory("PixelOrbitLeaderboard");
  const leaderboard = await Leaderboard.deploy();
  await leaderboard.waitForDeployment();
  const leaderboardAddr = await leaderboard.getAddress();
  console.log("PixelOrbitLeaderboard deployed to:", leaderboardAddr);

  // 6. PixelOrbitASC(blockProver, source, chainKey, starsCC, leaderboard).
  const ASC = await ethers.getContractFactory("PixelOrbitASC");
  const asc = await ASC.deploy(blockProver, source, SEPOLIA_CHAIN_KEY, starsAddr, leaderboardAddr);
  await asc.waitForDeployment();
  const ascAddr = await asc.getAddress();
  console.log("PixelOrbitASC deployed to:", ascAddr);

  // 7. Wire the ASC into every game contract, stage game contracts on the
  // ASC, and hand StarsCC mint authority to the ASC last.
  console.log("\n=== WIRING ===");
  for (const [name, addr] of [["Ship", shipAddr], ["Item", itemAddr], ["Leaderboard", leaderboardAddr]] as const) {
    const contract = await ethers.getContractAt(
      name === "Ship" ? "PixelOrbitShip" : name === "Item" ? "PixelOrbitItem" : "PixelOrbitLeaderboard",
      addr,
    );
    const tx = await contract.setAsc(ascAddr);
    await tx.wait();
    console.log(`setAsc(${ascAddr}) on ${name}: ${tx.hash}`);
  }

  for (const [setter, addr] of [["setShip", shipAddr], ["setItem", itemAddr]] as const) {
    const tx = await asc[setter](addr);
    await tx.wait();
    console.log(`${setter}(${addr}) on ASC: ${tx.hash}`);
  }

  const minterTx = await starsCC.setMinter(ascAddr);
  await minterTx.wait();
  console.log(`setMinter(${ascAddr}) on StarsCC: ${minterTx.hash}`);

  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_STARS_ADDRESS=${starsAddr}`);
  console.log(`NEXT_PUBLIC_SHIP_CONTRACT_ADDRESS=${shipAddr}`);
  console.log(`NEXT_PUBLIC_ITEM_CONTRACT_ADDRESS=${itemAddr}`);
  console.log(`NEXT_PUBLIC_MARKETPLACE_CONTRACT_ADDRESS=${marketplaceAddr}`);
  console.log(`NEXT_PUBLIC_LEADERBOARD_CONTRACT_ADDRESS=${leaderboardAddr}`);
  console.log(`NEXT_PUBLIC_ASC_ADDRESS=${ascAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
