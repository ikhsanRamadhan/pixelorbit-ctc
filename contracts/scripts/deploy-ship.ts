import { ethers } from "hardhat";

import { resolveStarsAddress } from "./config";

/**
 * Deploys only PixelOrbitShip. Item, Marketplace, and Leaderboard are unchanged,
 * so redeploying them would orphan every player-owned item and reset scores.
 *
 * Metadata URIs are still set in the constructor with a post-deploy check:
 * a transposed CID is invisible in-game, so verify on-chain before trusting it.
 *
 * STARS_ADDRESS must point at the deployed OrbitStarsCC: the constructor takes
 * the Stars token, and the deployer becomes the owner (wire the ASC after with
 * setAsc).
 */

/** Each ship's own pinned JSON, keyed by name — checked post-deploy, not assumed. */
const EXPECTED_CIDS: Record<string, string> = {
    Fighter: "QmYshoECpKXPq2S4XY4NEJWCbnFGzH4oWyGRsQzAZCjWaw",
    Nautolan: "Qmce5XchuEDbFszhxUEnGiSDMMtdXYqjuEg4G4VTv3iVjo",
    Nairan: "QmZ4xFmySfA3yoNX9ah7GWPzrz13jKf9WPdefAHiczaYK5",
    Klaed: "QmcSvBfPKNyJXmEhn2raDJGiivygMbtw7SsF5n32p51V4g",
};

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "tCTC");

    const stars = resolveStarsAddress();
    console.log("Stars:", stars);

    const Ship = await ethers.getContractFactory("PixelOrbitShip");
    const ship = await Ship.deploy(stars);
    await ship.waitForDeployment();
    const addr = await ship.getAddress();
    console.log("\nPixelOrbitShip deployed to:", addr);

    console.log("stars resolved to:", await ship.stars());
    console.log("owner:", await ship.owner());
    console.log("ship type count:", (await ship.getShipTypeCount()).toString());

    // A transposed CID is invisible in-game — the client renders from
    // Spaceships.ts — so verify on-chain before trusting it.
    console.log("\n=== METADATA URI CHECK ===");
    let mismatches = 0;
    const seen = new Set<string>();
    const count = Number(await ship.getShipTypeCount());
    for (let i = 0; i < count; i++) {
        const shipType = await ship.getShipType(i);
        const expected = EXPECTED_CIDS[shipType.name];
        const ok = expected !== undefined && shipType.metadataURI.includes(expected);
        if (!ok) mismatches++;
        seen.add(shipType.metadataURI);
        console.log(`  [${i}] ${shipType.name}: ${ok ? "OK" : "MISMATCH"} -> ${shipType.metadataURI}`);
    }
    if (seen.size !== count) {
        throw new Error(`Only ${seen.size} distinct URIs across ${count} ship types — a CID is duplicated`);
    }
    if (mismatches > 0) {
        throw new Error(`${mismatches} ship type(s) point at the wrong JSON; do not update .env.local`);
    }
    console.log("All ship types point at their own pinned JSON.");

    console.log("\n=== STARS PRICES ===");
    for (let i = 0; i < count; i++) {
        const starsPrice = await ship.getShipStarsPrice(i);
        console.log(`  [${i}] ${ethers.formatUnits(starsPrice, 18)} Stars`);
    }

    console.log("\n=== UPDATE .env.local ===");
    console.log(`NEXT_PUBLIC_SHIP_CONTRACT_ADDRESS=${addr}`);
    console.log("\nThen wire the ASC with setAsc(ascAddress), and re-mint any ships owned on the old contract with mintShip(owner, typeIndex).");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
