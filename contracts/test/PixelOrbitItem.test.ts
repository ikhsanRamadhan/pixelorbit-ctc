import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { PixelOrbitItem } from "../typechain-types";

/**
 * Mirrors `_pickItemType`, so the tests assert the real distribution rather than
 * just "some item was minted". Weights and per-index rarities come from the
 * contract's own table.
 */
const RARITY_WEIGHTS = [100n, 36n, 12n, 4n, 2n];
const RARITY_OF_INDEX = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 4];

function expectedItemIndex(seed: bigint): number {
  const total = RARITY_WEIGHTS.reduce((a, b) => a + b, 0n);
  const roll = seed % total;
  let cumulative = 0n;
  let tier = 0;
  for (let r = 0; r < 5; r++) {
    cumulative += RARITY_WEIGHTS[r];
    if (roll < cumulative) {
      tier = r;
      break;
    }
  }

  const inTier = RARITY_OF_INDEX.filter((r) => r === tier).length;
  let offset = (seed >> 128n) % BigInt(inTier);
  for (let i = 0; i < RARITY_OF_INDEX.length; i++) {
    if (RARITY_OF_INDEX[i] !== tier) continue;
    if (offset === 0n) return i;
    offset--;
  }
  throw new Error("pick failed");
}

/** How the contract derives the per-mint seed from prevrandao, nonce, recipient and time. */
async function seedForMint(nonce: bigint, to: string, blockNumber: number): Promise<bigint> {
  // `block.prevrandao` is the block's mixHash, which the typed Block view
  // reports as null — read it from the raw RPC payload instead.
  const raw: unknown = await ethers.provider.send("eth_getBlockByNumber", [
    "0x" + blockNumber.toString(16),
    false,
  ]);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("block unavailable");
  }
  const { mixHash, timestamp } = raw as { mixHash: unknown; timestamp: unknown };
  if (typeof mixHash !== "string" || typeof timestamp !== "string") {
    throw new Error("block unavailable");
  }
  return BigInt(
    ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "address", "uint256"],
      [mixHash, nonce, to, BigInt(timestamp)],
    ),
  );
}

describe("PixelOrbitItem", function () {
  let item: PixelOrbitItem;
  let player: SignerWithAddress;
  let asc: SignerWithAddress;

  const NONCE = 7n;

  beforeEach(async function () {
    [, player, asc] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("PixelOrbitItem");
    item = await Factory.deploy();
    await item.setAsc(asc.address);
  });

  it("should deploy with 12 item types", async function () {
    expect(await item.getItemTypeCount()).to.equal(12);
  });

  it("should have correct rarities at key indices", async function () {
    expect((await item.itemTypes(0)).rarity).to.equal(0);
    expect((await item.itemTypes(5)).rarity).to.equal(1);
    expect((await item.itemTypes(8)).rarity).to.equal(2);
    expect((await item.itemTypes(10)).rarity).to.equal(3);
    expect((await item.itemTypes(11)).rarity).to.equal(4);
  });

  it("should mint item as owner", async function () {
    await item.mintItem(player.address, 0);
    expect(await item.ownerOf(0)).to.equal(player.address);
    expect(await item.tokenItemType(0)).to.equal(0);
  });

  it("should revert if non-owner calls mintItem", async function () {
    await expect(
      item.connect(player).mintItem(player.address, 11)
    ).to.be.revertedWithCustomError(item, "OwnableUnauthorizedAccount");
  });

  it("should revert for invalid item type index", async function () {
    await expect(
      item.mintItem(player.address, 99)
    ).to.be.revertedWith("Invalid item type index");
  });

  it("should return token rarity", async function () {
    await item.mintItem(player.address, 11);
    expect(await item.getTokenRarity(0)).to.equal(4);
  });

  it("should return metadata URI containing ipfs", async function () {
    await item.mintItem(player.address, 0);
    expect(await item.tokenURI(0)).to.include("ipfs");
  });

  it("should revert mintBridged when caller is not the ASC", async function () {
    await expect(
      item.connect(player).mintBridged(player.address, NONCE)
    ).to.be.revertedWith("Only ASC");
  });

  it("should let the ASC mintBridged and emit ItemMinted", async function () {
    const tx = await item.connect(asc).mintBridged(player.address, NONCE);
    const receipt = await tx.wait();
    if (receipt === null) {
      throw new Error("receipt unavailable");
    }
    const expected = expectedItemIndex(
      await seedForMint(NONCE, player.address, receipt.blockNumber),
    );
    await expect(tx)
      .to.emit(item, "ItemMinted")
      .withArgs(
        player.address,
        0,
        expected,
        RARITY_OF_INDEX[expected],
      );
    expect(await item.ownerOf(0)).to.equal(player.address);
    expect(await item.tokenItemType(0)).to.equal(expected);
    expect(await item.usedNonces(NONCE)).to.equal(true);
  });

  it("should reject a replayed nonce", async function () {
    await item.connect(asc).mintBridged(player.address, NONCE);
    await expect(
      item.connect(asc).mintBridged(player.address, NONCE)
    ).to.be.revertedWith("Nonce already used");
  });

  it("should follow the configured rarity distribution", async function () {
    // 200 bridged mints with distinct nonces: enough to show Commons
    // dominate and Legendaries stay rare, without asserting exact counts.
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 200; i++) {
      await item.connect(asc).mintBridged(player.address, BigInt(i));
      counts[RARITY_OF_INDEX[Number(await item.tokenItemType(i))]]++;
    }

    expect(counts[0]).to.be.greaterThan(counts[1]);
    expect(counts[1]).to.be.greaterThan(counts[3]);
    expect(counts[0] + counts[1]).to.be.greaterThan(150);
    expect(counts[4]).to.be.lessThan(20);
  });

  it("should set the ASC and emit AscUpdated", async function () {
    const Factory = await ethers.getContractFactory("PixelOrbitItem");
    const fresh = await Factory.deploy();
    await expect(fresh.setAsc(asc.address))
      .to.emit(fresh, "AscUpdated")
      .withArgs(asc.address);
    expect(await fresh.asc()).to.equal(asc.address);
  });

  it("should revert setAsc for the zero address", async function () {
    await expect(item.setAsc(ethers.ZeroAddress)).to.be.revertedWith("Invalid ASC");
  });

  it("should revert setAsc when called by a non-owner", async function () {
    await expect(item.connect(player).setAsc(asc.address)).to.be.reverted;
  });
});

describe("PixelOrbitItem — run-crate claims", function () {
  let item: PixelOrbitItem;
  let owner: SignerWithAddress;
  let player: SignerWithAddress;
  let other: SignerWithAddress;
  let asc: SignerWithAddress;

  type TxReturn = ReturnType<PixelOrbitItem["mintBridged"]>;
  type ClaimCratesContract = PixelOrbitItem & {
    runSigner: () => Promise<string>;
    usedRunNonces: (nonce: string) => Promise<boolean>;
    setRunSigner: (signer: string) => TxReturn;
    claimCrates: (runNonce: string, crateCount: number, signature: string) => TxReturn;
  };

  const CHAIN_ID = 31337;
  const DUMMY_SIG = "0x" + "00".repeat(65);

  function asClaim(c: PixelOrbitItem): ClaimCratesContract {
    return c as unknown as ClaimCratesContract;
  }

  async function claimDigest(
    itemAddr: string,
    playerAddr: string,
    runNonce: string,
    crateCount: number,
  ): Promise<string> {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address", "bytes32", "uint8"],
      [itemAddr, CHAIN_ID, playerAddr, runNonce, crateCount],
    );
    return ethers.keccak256(encoded);
  }

  async function claimSignature(
    signer: SignerWithAddress,
    itemAddr: string,
    playerAddr: string,
    runNonce: string,
    crateCount: number,
  ): Promise<string> {
    const digest = await claimDigest(itemAddr, playerAddr, runNonce, crateCount);
    return signer.signMessage(ethers.getBytes(digest));
  }

  function nonceFor(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  beforeEach(async function () {
    [owner, player, other, asc] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PixelOrbitItem");
    item = await Factory.deploy();
    await item.setAsc(asc.address);
  });

  it("initially has zero runSigner", async function () {
    expect(await asClaim(item).runSigner()).to.equal(ethers.ZeroAddress);
  });

  it("initially reports usedRunNonces as false", async function () {
    expect(await asClaim(item).usedRunNonces(nonceFor("fresh-run"))).to.equal(false);
  });

  it("owner can setRunSigner and emits RunSignerUpdated", async function () {
    await expect(asClaim(item).setRunSigner(owner.address))
      .to.emit(item, "RunSignerUpdated")
      .withArgs(owner.address);
    expect(await asClaim(item).runSigner()).to.equal(owner.address);
  });

  it("non-owner cannot setRunSigner", async function () {
    const connected = asClaim(item.connect(player) as unknown as PixelOrbitItem);
    await expect(connected.setRunSigner(owner.address)).to.be.reverted;
  });

  it("setRunSigner reverts for zero address", async function () {
    await expect(asClaim(item).setRunSigner(ethers.ZeroAddress)).to.be.revertedWith(
      "Bad signer",
    );
  });

  it("claimCrates reverts when signer not configured", async function () {
    const runNonce = nonceFor("unconfigured-run");
    await expect(
      asClaim(item).claimCrates(runNonce, 1, DUMMY_SIG),
    ).to.be.revertedWith("Claim not configured");
  });

  it("claimCrates reverts on count 0", async function () {
    await asClaim(item).setRunSigner(owner.address);
    await expect(
      asClaim(item).claimCrates(nonceFor("zero-crates"), 0, DUMMY_SIG),
    ).to.be.revertedWith("No crates");
  });

  it("claimCrates reverts on count 26", async function () {
    await asClaim(item).setRunSigner(owner.address);
    await expect(
      asClaim(item).claimCrates(nonceFor("too-many"), 26, DUMMY_SIG),
    ).to.be.revertedWith("Too many crates");
  });

  it("claimCrates reverts on wrong-signer signature", async function () {
    await asClaim(item).setRunSigner(owner.address);
    const runNonce = nonceFor("wrong-signer-run");
    const itemAddr = await item.getAddress();
    const badSig = await claimSignature(other, itemAddr, player.address, runNonce, 2);
    const connected = asClaim(item.connect(player) as unknown as PixelOrbitItem);
    await expect(connected.claimCrates(runNonce, 2, badSig)).to.be.revertedWith("Bad claim");
  });

  it("claimCrates reverts on tampered count", async function () {
    await asClaim(item).setRunSigner(owner.address);
    const runNonce = nonceFor("tampered-count-run");
    const itemAddr = await item.getAddress();
    const sigFor2 = await claimSignature(owner, itemAddr, player.address, runNonce, 2);
    const connected = asClaim(item.connect(player) as unknown as PixelOrbitItem);
    await expect(connected.claimCrates(runNonce, 3, sigFor2)).to.be.revertedWith("Bad claim");
  });

  it("claimCrates reverts when a different player reuses the signature", async function () {
    await asClaim(item).setRunSigner(owner.address);
    const runNonce = nonceFor("player-binding-run");
    const itemAddr = await item.getAddress();
    const sigForPlayer = await claimSignature(owner, itemAddr, player.address, runNonce, 2);
    const connected = asClaim(item.connect(other) as unknown as PixelOrbitItem);
    await expect(connected.claimCrates(runNonce, 2, sigForPlayer)).to.be.revertedWith(
      "Bad claim",
    );
  });

  it("happy path count=3 mints sequentially and marks nonce used", async function () {
    await asClaim(item).setRunSigner(owner.address);
    const runNonce = nonceFor("happy-run-3");
    const itemAddr = await item.getAddress();
    const sig = await claimSignature(owner, itemAddr, player.address, runNonce, 3);
    const beforeSupply = await item.totalSupply();
    const beforeBalance = await item.balanceOf(player.address);
    const connected = asClaim(item.connect(player) as unknown as PixelOrbitItem);
    const tx = await connected.claimCrates(runNonce, 3, sig);
    await expect(tx)
      .to.emit(item, "CratesClaimed")
      .withArgs(player.address, runNonce, 3);
    await expect(tx).to.emit(item, "ItemMinted");
    expect(await item.balanceOf(player.address)).to.equal(beforeBalance + 3n);
    for (let i = 0n; i < 3n; i++) {
      expect(await item.ownerOf(beforeSupply + i)).to.equal(player.address);
    }
    expect(await asClaim(item).usedRunNonces(runNonce)).to.equal(true);
  });

  it("replays the same runNonce but allows a different nonce", async function () {
    await asClaim(item).setRunSigner(owner.address);
    const runNonce = nonceFor("replay-run");
    const itemAddr = await item.getAddress();
    const sig = await claimSignature(owner, itemAddr, player.address, runNonce, 1);
    const connected = asClaim(item.connect(player) as unknown as PixelOrbitItem);
    await connected.claimCrates(runNonce, 1, sig);
    await expect(connected.claimCrates(runNonce, 1, sig)).to.be.revertedWith(
      "Claim replayed",
    );
    const otherNonce = nonceFor("replay-run-next");
    const otherSig = await claimSignature(owner, itemAddr, player.address, otherNonce, 1);
    await expect(connected.claimCrates(otherNonce, 1, otherSig)).to.emit(
      item,
      "CratesClaimed",
    );
  });
});
