import { ethers } from "hardhat";

/**
 * Re-mints ships onto a freshly deployed PixelOrbitShip.
 *
 * A redeploy leaves player-owned tokens stranded on the old address, so the new
 * contract has to be seeded with what they already paid for. Owner-only mintShip
 * takes no Stars, which is the point: the player is not charged twice.
 *
 * Source of truth is `scripts/count-ships.ts` run against the OLD address.
 */

/** owner -> ship type index, transcribed from the old contract's inventory. */
const REMINTS: Array<{ owner: string; typeIndex: number }> = [
    { owner: "0xe9eE885c5F70EDBd39fe7bD488E6503c32e33626", typeIndex: 1 },
];

async function main() {
    const shipAddr = process.env.SHIP_ADDR;
    if (!shipAddr) throw new Error("Set SHIP_ADDR to the NEW ship contract address");

    const [signer] = await ethers.getSigners();
    const ship = await ethers.getContractAt("PixelOrbitShip", shipAddr);

    const owner = await ship.owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(`Signer ${signer.address} is not the owner (${owner}); mintShip would revert`);
    }

    console.log("Ship contract:", shipAddr);
    console.log("Already minted:", (await ship.totalSupply()).toString());

    for (const { owner: to, typeIndex } of REMINTS) {
        const shipType = await ship.getShipType(typeIndex);
        const tx = await ship.mintShip(to, typeIndex);
        console.log(`mintShip(${to}, ${typeIndex}) [${shipType.name}] tx: ${tx.hash}`);
        await tx.wait();
    }

    const supply = Number(await ship.totalSupply());
    console.log("\n=== POST-MINT INVENTORY ===");
    for (let i = 0; i < supply; i++) {
        const tokenId = await ship.tokenByIndex(i);
        const typeIndex = Number(await ship.tokenShipType(tokenId));
        console.log(`  #${tokenId}: owner=${await ship.ownerOf(tokenId)} type=${typeIndex}`);
        console.log(`      tokenURI=${await ship.tokenURI(tokenId)}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
