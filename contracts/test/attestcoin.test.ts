import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { Contract } from "ethers";
import {
  OrbitStarsCC,
  PixelOrbitLeaderboard,
  PixelOrbitSource,
  StarsSepolia,
} from "../typechain-types";

const SOURCE_CHAIN_KEY = 1n;
const PROVEN_HEIGHT = 11686603n;
const ZERO_HASH = ethers.ZeroHash;

// Real pending Sepolia lock values (worker bridge-state pending[0],
// tx 0x944386aa6fcc969ac17d7223d9c1fe69169ae5b54a6ede108c7710883a56e93b).
// The linked library decodes real blobs now, so this pins the REAL app values
// plus REAL Source-ABI calldata through the onchain decode path; the full
// live blob is covered by test/live-blob.test.ts.
const REAL_LOCK = {
  player: "0xe9eE885c5F70EDBd39fe7bD488E6503c32e33626",
  amount: 2000000000000000000n,
  nonce: 82463816781879281029340671069982627780789254357879087259152547709878235164484n,
  recipient: "0xe9eE885c5F70EDBd39fe7bD488E6503c32e33626",
};

function lockCalldata(
  source: PixelOrbitSource,
  amount: bigint,
  nonce: bigint,
  recipient: string,
): string {
  return source.interface.encodeFunctionData("lock", [amount, nonce, recipient]);
}

function buildType2TxBytes(
  from: string,
  to: string,
  value: bigint,
  data: string,
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const chunk0 = coder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [0, 0, from, to === ethers.ZeroAddress, to, value, data],
  );
  const chunk1 = coder.encode(
    ["uint64", "uint128", "uint128", "tuple(address account,bytes32[] storageKeys)[]", "uint8", "bytes32", "bytes32"],
    [11155111, 0, 0, [], 0, ethers.ZeroHash, ethers.ZeroHash],
  );
  const chunk2 = coder.encode(
    ["uint8", "uint64", "tuple(address addr,bytes32[] topics,bytes data)[]", "bytes"],
    [1, 0, [], "0x"],
  );
  return coder.encode(["uint8", "bytes[]"], [2, [chunk0, chunk1, chunk2]]);
}

describe("AttestcoinSource", function () {
  let stars: StarsSepolia;
  let source: PixelOrbitSource;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async function () {
    [owner, user, recipient] = await ethers.getSigners();

    const StarsFactory = await ethers.getContractFactory("StarsSepolia");
    stars = await StarsFactory.deploy();
    await stars.waitForDeployment();

    const SourceFactory = await ethers.getContractFactory("PixelOrbitSource");
    source = await SourceFactory.deploy(await stars.getAddress());
    await source.waitForDeployment();

    await stars.mint(user.address, 1000);
    await stars.connect(user).approve(await source.getAddress(), 1000);
  });

  it("emits StarsLocked with recipient and nonce", async function () {
    await expect(source.connect(user).lock(100, 7, recipient.address))
      .to.emit(source, "StarsLocked")
      .withArgs(user.address, 100, 7, recipient.address);
  });

  it("burns locked Stars so the source holds nothing and supply drops", async function () {
    expect(await stars.totalSupply()).to.equal(1000);
    await source.connect(user).lock(100, 7, recipient.address);
    expect(await stars.balanceOf(await source.getAddress())).to.equal(0);
    expect(await stars.balanceOf(user.address)).to.equal(900);
    expect(await stars.totalSupply()).to.equal(900);
  });

  it("reverts when the same player reuses a nonce", async function () {
    await source.connect(user).lock(100, 7, recipient.address);
    await expect(source.connect(user).lock(100, 7, recipient.address)).to.be.revertedWith(
      "Nonce used",
    );
  });

  it("allows different players to use the same nonce value", async function () {
    await stars.mint(owner.address, 1000);
    await stars.approve(await source.getAddress(), 1000);
    await source.connect(user).lock(100, 7, recipient.address);
    await expect(source.lock(100, 7, recipient.address)).to.emit(source, "StarsLocked");
  });

  it("reverts on zero amount", async function () {
    await expect(source.connect(user).lock(0, 7, recipient.address)).to.be.revertedWith(
      "Zero amount",
    );
  });

  it("reverts on zero recipient", async function () {
    await expect(
      source.connect(user).lock(100, 7, ethers.ZeroAddress),
    ).to.be.revertedWith("Bad recipient");
  });

  it("rejects a zero Stars address in the constructor", async function () {
    const SourceFactory = await ethers.getContractFactory("PixelOrbitSource");
    await expect(SourceFactory.deploy(ethers.ZeroAddress)).to.be.revertedWith("Stars required");
  });
});

describe("AttestcoinStarsCC", function () {
  let starsCC: OrbitStarsCC;
  let minter: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    const minterSigner = signers[1];
    const userSigner = signers[2];
    if (minterSigner === undefined || userSigner === undefined) throw new Error("missing signer");
    minter = minterSigner;
    user = userSigner;

    const StarsCCFactory = await ethers.getContractFactory("OrbitStarsCC");
    starsCC = await StarsCCFactory.deploy();
    await starsCC.waitForDeployment();
  });

  it("lets the owner set the minter", async function () {
    await expect(starsCC.setMinter(minter.address))
      .to.emit(starsCC, "MinterUpdated")
      .withArgs(minter.address);
    expect(await starsCC.minter()).to.equal(minter.address);
  });

  it("reverts setMinter for non-owners", async function () {
    await expect(starsCC.connect(user).setMinter(minter.address)).to.be.reverted;
  });

  it("lets the minter mint Stars", async function () {
    await starsCC.setMinter(minter.address);
    await starsCC.connect(minter).mint(user.address, 250);
    expect(await starsCC.balanceOf(user.address)).to.equal(250);
  });

  it("reverts direct mints by non-minters", async function () {
    await expect(starsCC.connect(user).mint(user.address, 250)).to.be.revertedWith(
      "Only minter",
    );
  });
});

describe("AttestcoinASC", function () {
  let starsCC: OrbitStarsCC;
  let leaderboard: PixelOrbitLeaderboard;
  let prover: Contract;
  let asc: Contract;
  let source: PixelOrbitSource;
  let user: SignerWithAddress;
  let other: SignerWithAddress;

  async function deployStack() {
    const signers = await ethers.getSigners();
    const userSigner = signers[1];
    const otherSigner = signers[2];
    if (userSigner === undefined || otherSigner === undefined) throw new Error("missing signer");
    user = userSigner;
    other = otherSigner;

    const StarsFactory = await ethers.getContractFactory("StarsSepolia");
    const stars = await StarsFactory.deploy();
    await stars.waitForDeployment();

    const SourceFactory = await ethers.getContractFactory("PixelOrbitSource");
    source = await SourceFactory.deploy(await stars.getAddress());
    await source.waitForDeployment();

    const StarsCCFactory = await ethers.getContractFactory("OrbitStarsCC");
    starsCC = await StarsCCFactory.deploy();
    await starsCC.waitForDeployment();

    const LeaderboardFactory = await ethers.getContractFactory("PixelOrbitLeaderboard");
    leaderboard = await LeaderboardFactory.deploy();
    await leaderboard.waitForDeployment();

    const ProverFactory = await ethers.getContractFactory("MockBlockProver");
    const proverContract = await ProverFactory.deploy();
    await proverContract.waitForDeployment();
    prover = proverContract as unknown as Contract;

    const AscFactory = await ethers.getContractFactory("PixelOrbitASC");
    const ascContract = await AscFactory.deploy(
      await proverContract.getAddress(),
      await source.getAddress(),
      SOURCE_CHAIN_KEY,
      await starsCC.getAddress(),
      await leaderboard.getAddress(),
    );
    await ascContract.waitForDeployment();
    asc = ascContract as unknown as Contract;

    await starsCC.setMinter(await ascContract.getAddress());
    await leaderboard.getFunction("setAsc")(await ascContract.getAddress());
  }

  interface LockParams {
    from?: string;
    to?: string;
    value?: bigint;
    amount?: bigint;
    nonce?: bigint;
    recipient?: string;
    data?: string;
  }

  async function makeLockTx(params: LockParams): Promise<string> {
    const sourceAddr = await source.getAddress();
    const data =
      params.data ??
      lockCalldata(
        source,
        params.amount ?? 100n,
        params.nonce ?? 7n,
        params.recipient ?? user.address,
      );
    return buildType2TxBytes(
      params.from ?? user.address,
      params.to ?? sourceAddr,
      params.value ?? 0n,
      data,
    );
  }

  async function execute(chainKey: bigint, txBytes: string, action = 0) {
    return asc.getFunction("execute")(
      action,
      chainKey,
      PROVEN_HEIGHT,
      txBytes,
      ZERO_HASH,
      [],
      ZERO_HASH,
      [],
    );
  }

  beforeEach(deployStack);

  it("executes a proven lock: mints Stars, attests the player, emits BridgeExecuted", async function () {
    const txBytes = await makeLockTx({ amount: 100n, nonce: 7n, recipient: user.address });

    await expect(execute(SOURCE_CHAIN_KEY, txBytes))
      .to.emit(asc, "BridgeExecuted")
      .withArgs(user.address, user.address, 100, 7);

    expect(await starsCC.balanceOf(user.address)).to.equal(100);
    expect(await leaderboard.getFunction("attestedPlayer")(user.address)).to.equal(true);
  });

  it("reverts when the prover returns false", async function () {
    const txBytes = await makeLockTx({});
    await prover.getFunction("setResult")(false);

    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Invalid proof");
  });

  it("reverts on a replayed nonce", async function () {
    const txBytes = await makeLockTx({});
    await execute(SOURCE_CHAIN_KEY, txBytes);
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Nonce used");
  });

  it("reverts on a lock targeting the wrong source", async function () {
    const txBytes = await makeLockTx({ to: other.address });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Wrong source");
  });

  it("reverts on a proof for the wrong chain", async function () {
    const txBytes = await makeLockTx({});
    await expect(execute(2n, txBytes)).to.be.revertedWith("Wrong chain");
  });

  it("reverts on a zero-amount lock", async function () {
    const txBytes = await makeLockTx({ amount: 0n });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Zero amount");
  });

  it("reverts on a zero-recipient lock", async function () {
    const txBytes = await makeLockTx({ recipient: ethers.ZeroAddress });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Bad recipient");
  });

  it("reverts on an unknown action discriminator", async function () {
    const txBytes = await makeLockTx({});
    await expect(execute(SOURCE_CHAIN_KEY, txBytes, 1)).to.be.revertedWith("Bad action");
  });

  it("reverts on a lock carrying native value", async function () {
    const txBytes = await makeLockTx({ value: 1n });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Bad value");
  });

  it("reverts on calldata with an unknown selector", async function () {
    const txBytes = await makeLockTx({
      data: `0xdeadbeef${"00".repeat(96)}`,
    });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Bad selector");
  });

  it("reverts on truncated lock calldata", async function () {
    const full = lockCalldata(source, 100n, 7n, user.address);
    const txBytes = await makeLockTx({ data: full.slice(0, 10) });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Bad calldata");
  });

  it("executes the real pending Sepolia lock values through the real decode path", async function () {
    const data = lockCalldata(source, REAL_LOCK.amount, REAL_LOCK.nonce, REAL_LOCK.recipient);
    const sourceAddr = await source.getAddress();
    const txBytes = buildType2TxBytes(REAL_LOCK.player, sourceAddr, 0n, data);

    await expect(execute(SOURCE_CHAIN_KEY, txBytes))
      .to.emit(asc, "BridgeExecuted")
      .withArgs(REAL_LOCK.player, REAL_LOCK.recipient, REAL_LOCK.amount, REAL_LOCK.nonce);

    expect(await starsCC.balanceOf(REAL_LOCK.recipient)).to.equal(REAL_LOCK.amount);
    expect(await leaderboard.getFunction("attestedPlayer")(REAL_LOCK.recipient)).to.equal(true);
  });

  it("rejects zero addresses and zero chainkey in the constructor", async function () {
    const AscFactory = await ethers.getContractFactory("PixelOrbitASC");
    const proverAddr = await prover.getAddress();
    const sourceAddr = await source.getAddress();
    const starsAddr = await starsCC.getAddress();
    const boardAddr = await leaderboard.getAddress();

    await expect(
      AscFactory.deploy(
        ethers.ZeroAddress,
        sourceAddr,
        SOURCE_CHAIN_KEY,
        starsAddr,
        boardAddr,
      ),
    ).to.be.revertedWith("BlockProver required");
    await expect(
      AscFactory.deploy(proverAddr, ethers.ZeroAddress, SOURCE_CHAIN_KEY, starsAddr, boardAddr),
    ).to.be.revertedWith("Source required");
    await expect(
      AscFactory.deploy(proverAddr, sourceAddr, 0, starsAddr, boardAddr),
    ).to.be.revertedWith("Bad chainkey");
    await expect(
      AscFactory.deploy(
        proverAddr,
        sourceAddr,
        SOURCE_CHAIN_KEY,
        ethers.ZeroAddress,
        boardAddr,
      ),
    ).to.be.revertedWith("StarsCC required");
    await expect(
      AscFactory.deploy(
        proverAddr,
        sourceAddr,
        SOURCE_CHAIN_KEY,
        starsAddr,
        ethers.ZeroAddress,
      ),
    ).to.be.revertedWith("Leaderboard required");
  });

  it("lets the owner stage Ship and Item addresses for future direct-bridge mints", async function () {
    await expect(asc.getFunction("setShip")(other.address))
      .to.emit(asc, "ShipUpdated")
      .withArgs(other.address);
    await expect(asc.getFunction("setItem")(other.address))
      .to.emit(asc, "ItemUpdated")
      .withArgs(other.address);
    expect(await asc.getFunction("ship")()).to.equal(other.address);
    expect(await asc.getFunction("item")()).to.equal(other.address);
  });

  it("reverts Ship and Item staging for non-owners or zero addresses", async function () {
    await expect((asc.connect(user) as Contract).getFunction("setShip")(other.address)).to.be
      .reverted;
    await expect((asc.connect(user) as Contract).getFunction("setItem")(other.address)).to.be
      .reverted;
    await expect(asc.getFunction("setShip")(ethers.ZeroAddress)).to.be.revertedWith("Bad ship");
    await expect(asc.getFunction("setItem")(ethers.ZeroAddress)).to.be.revertedWith("Bad item");
  });

  it("marks the nonce used before minting so no replay can double-mint", async function () {
    const txBytes = await makeLockTx({ amount: 100n, nonce: 7n });
    const sourceAddr = await source.getAddress();
    await execute(SOURCE_CHAIN_KEY, txBytes);
    const key = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256"],
        [sourceAddr, user.address, 7],
      ),
    );
    expect(await asc.getFunction("executedLocks")(key)).to.equal(true);
    expect(await starsCC.balanceOf(user.address)).to.equal(100);
  });

  it("allows different players to bridge the same nonce value", async function () {
    const signers = await ethers.getSigners();
    const alice = signers[1];
    const bob = signers[2];
    if (alice === undefined || bob === undefined) throw new Error("missing signer");

    const txA = await makeLockTx({ from: alice.address, amount: 100n, nonce: 7n, recipient: alice.address });
    await expect(execute(SOURCE_CHAIN_KEY, txA))
      .to.emit(asc, "BridgeExecuted")
      .withArgs(alice.address, alice.address, 100, 7);

    const txB = await makeLockTx({ from: bob.address, amount: 150n, nonce: 7n, recipient: bob.address });
    await expect(execute(SOURCE_CHAIN_KEY, txB))
      .to.emit(asc, "BridgeExecuted")
      .withArgs(bob.address, bob.address, 150, 7);

    expect(await starsCC.balanceOf(alice.address)).to.equal(100);
    expect(await starsCC.balanceOf(bob.address)).to.equal(150);
  });

  it("allows a permissionless executor to submit another player's lock", async function () {
    const signers = await ethers.getSigners();
    const executor = signers[3];
    if (executor === undefined) throw new Error("missing signer");

    const txBytes = await makeLockTx({ amount: 100n, nonce: 8n });
    await expect(
      (asc.connect(executor) as Contract).getFunction("execute")(
        0,
        SOURCE_CHAIN_KEY,
        PROVEN_HEIGHT,
        txBytes,
        ZERO_HASH,
        [],
        ZERO_HASH,
        [],
      ),
    )
      .to.emit(asc, "BridgeExecuted")
      .withArgs(user.address, user.address, 100, 8);
    expect(await starsCC.balanceOf(user.address)).to.equal(100);
  });

  it("reverts on exact replay of the same player and nonce", async function () {
    const txBytes = await makeLockTx({ amount: 100n, nonce: 9n });
    await execute(SOURCE_CHAIN_KEY, txBytes);
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Nonce used");
  });

  it("reverts on a zero-player proof", async function () {
    const txBytes = await makeLockTx({ from: ethers.ZeroAddress, nonce: 11n });
    await expect(execute(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Invalid player");
  });

  it("exposes the canonical batch verify shape on the mock prover", async function () {
    const batchVerify =
      "verify(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))";
    const txA = await makeLockTx({ nonce: 901n });
    const txB = await makeLockTx({ nonce: 902n });
    const txs = [txA, txB];
    const proofs = txs.map(() => ({ root: ZERO_HASH, siblings: [] as string[] }));
    const heights = txs.map(() => PROVEN_HEIGHT);
    const shared = { lowerEndpointDigest: ZERO_HASH, roots: [] as string[] };
    expect(
      await prover.getFunction(batchVerify)(SOURCE_CHAIN_KEY, heights, txs, proofs, shared),
    ).to.equal(true);
    await prover.getFunction("setResultForTx")(txs[1], false);
    expect(
      await prover.getFunction(batchVerify)(SOURCE_CHAIN_KEY, heights, txs, proofs, shared),
    ).to.equal(false);
  });

  describe("executeBatch", function () {
    async function executeBatch(chainKey: bigint, txBytesList: string[], action = 0) {
      const heights = txBytesList.map(() => PROVEN_HEIGHT);
      const proofs = txBytesList.map(() => ({ root: ZERO_HASH, siblings: [] as string[] }));
      return asc.getFunction("executeBatch")(
        action,
        chainKey,
        heights,
        txBytesList,
        proofs,
        ZERO_HASH,
        [],
      );
    }

    async function makeBatchLocks(
      locks: {
        amount: bigint;
        nonce: bigint;
        from?: string;
        recipient?: string;
        to?: string;
        proverOk?: boolean;
      }[],
    ): Promise<string[]> {
      const out: string[] = [];
      for (const lock of locks) {
        const txBytes = await makeLockTx({
          from: lock.from ?? user.address,
          to: lock.to,
          amount: lock.amount,
          nonce: lock.nonce,
          recipient: lock.recipient ?? user.address,
        });
        if (lock.proverOk === false) {
          await prover.getFunction("setResultForTx")(txBytes, false);
        }
        out.push(txBytes);
      }
      return out;
    }

    function reasonBytes(text: string): string {
      return ethers.hexlify(ethers.toUtf8Bytes(text));
    }

    function revertReasonBytes(text: string): string {
      return ethers.concat([
        ethers.dataSlice(ethers.id("Error(string)"), 0, 4),
        ethers.AbiCoder.defaultAbiCoder().encode(["string"], [text]),
      ]);
    }

    it("executes an all-success batch of 3 with per-index success events", async function () {
      const txBytesList = await makeBatchLocks([
        { amount: 100n, nonce: 21n },
        { amount: 200n, nonce: 22n },
        { amount: 300n, nonce: 23n },
      ]);

      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(2, true, "0x");

      expect(await starsCC.balanceOf(user.address)).to.equal(600);
      expect(await leaderboard.getFunction("attestedPlayer")(user.address)).to.equal(true);
    });

    it("isolates a bad proof at index 1: mints 0 and 2, fails only 1", async function () {
      const txBytesList = await makeBatchLocks([
        { amount: 100n, nonce: 31n },
        { amount: 200n, nonce: 32n, proverOk: false },
        { amount: 300n, nonce: 33n },
      ]);

      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, false, reasonBytes("Invalid proof"))
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(2, true, "0x");

      expect(await starsCC.balanceOf(user.address)).to.equal(400);
    });

    it("fails only the replayed index when a batch mixes a replay with a fresh lock", async function () {
      const firstList = await makeBatchLocks([
        { amount: 100n, nonce: 41n },
        { amount: 150n, nonce: 42n },
      ]);
      await executeBatch(SOURCE_CHAIN_KEY, firstList);

      const replayTx = firstList[0] as string;
      const freshTx = await makeLockTx({ amount: 250n, nonce: 43n });
      const secondList = [replayTx, freshTx];
      await expect(executeBatch(SOURCE_CHAIN_KEY, secondList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, false, reasonBytes("Nonce used"))
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, true, "0x");

      expect(await starsCC.balanceOf(user.address)).to.equal(500);
    });

    it("isolates a malformed txBytes entry without reverting the batch", async function () {
      const goodTx = await makeLockTx({ amount: 100n, nonce: 44n });
      const badTx = "0x";
      const txBytesList = [goodTx, badTx];

      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, false, revertReasonBytes("EvmV1Decoder: Empty"));

      expect(await starsCC.balanceOf(user.address)).to.equal(100);
    });

    it("reverts batches with more than 10 locks", async function () {
      const txBytesList: string[] = [];
      for (let i = 0; i < 11; i++) {
        txBytesList.push(await makeLockTx({ amount: 10n, nonce: BigInt(100 + i) }));
      }
      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList)).to.be.revertedWith(
        "Too many locks",
      );
    });

    it("reverts empty batches", async function () {
      await expect(executeBatch(SOURCE_CHAIN_KEY, [])).to.be.revertedWith("No locks");
    });

    it("reverts when heights and txBytes lengths mismatch", async function () {
      const heights = [PROVEN_HEIGHT, PROVEN_HEIGHT];
      const proofs: { root: string; siblings: string[] }[] = [];
      const single = await makeLockTx({ nonce: 999n });
      await expect(
        asc.getFunction("executeBatch")(0, SOURCE_CHAIN_KEY, heights, [single], proofs, ZERO_HASH, []),
      ).to.be.revertedWith("Length mismatch");
    });

    it("reports per-lock validation failures without reverting the batch", async function () {
      const goodTx = await makeLockTx({ amount: 100n, nonce: 51n });
      const badTx = await makeLockTx({ amount: 200n, nonce: 52n, to: other.address });
      const txBytesList = [goodTx, badTx];

      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, false, reasonBytes("Wrong source"));

      expect(await starsCC.balanceOf(user.address)).to.equal(100);
    });

    it("reverts the whole batch on systemic mint failure, leaving no marks (retry-safe)", async function () {
      const txBytesList = await makeBatchLocks([
        { amount: 100n, nonce: 61n },
        { amount: 200n, nonce: 62n },
      ]);
      await starsCC.setMinter(other.address);
      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList)).to.be.revertedWith(
        "Only minter",
      );
      const sourceAddr = await source.getAddress();
      for (const nonce of [61, 62]) {
        const key = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "uint256"],
            [sourceAddr, user.address, nonce],
          ),
        );
        expect(await asc.getFunction("executedLocks")(key)).to.equal(false);
      }
      expect(await starsCC.balanceOf(user.address)).to.equal(0);
      await starsCC.setMinter(await asc.getAddress());
      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, true, "0x");
      expect(await starsCC.balanceOf(user.address)).to.equal(300);
    });

    it("produces identical outcomes via single and batch paths for the same lock set", async function () {
      const singleA = await makeLockTx({ amount: 100n, nonce: 71n });
      await expect(execute(SOURCE_CHAIN_KEY, singleA))
        .to.emit(asc, "BridgeExecuted")
        .withArgs(user.address, user.address, 100, 71);
      const singleB = await makeLockTx({ amount: 200n, nonce: 72n });
      await expect(execute(SOURCE_CHAIN_KEY, singleB))
        .to.emit(asc, "BridgeExecuted")
        .withArgs(user.address, user.address, 200, 72);
      expect(await starsCC.balanceOf(user.address)).to.equal(300);
      const txBytesList = await makeBatchLocks([
        { amount: 100n, nonce: 73n },
        { amount: 200n, nonce: 74n },
      ]);
      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, true, "0x")
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, true, "0x");
      expect(await starsCC.balanceOf(user.address)).to.equal(600);
      expect(await leaderboard.getFunction("attestedPlayer")(user.address)).to.equal(true);
      await expect(execute(SOURCE_CHAIN_KEY, singleA)).to.be.revertedWith("Nonce used");
      const replayA = (txBytesList[0] as string);
      const freshTx = await makeLockTx({ amount: 250n, nonce: 75n });
      const replayList = [replayA, freshTx];
      await expect(executeBatch(SOURCE_CHAIN_KEY, replayList))
        .to.emit(asc, "BridgeBatchExecuted")
        .withArgs(0, false, reasonBytes("Nonce used"))
        .and.to.emit(asc, "BridgeBatchExecuted")
        .withArgs(1, true, "0x");
      expect(await starsCC.balanceOf(user.address)).to.equal(850);
    });

    it("reverts the batch on an unknown action discriminator", async function () {
      const txBytesList = await makeBatchLocks([{ amount: 100n, nonce: 81n }]);
      await expect(executeBatch(SOURCE_CHAIN_KEY, txBytesList, 1)).to.be.revertedWith(
        "Bad action",
      );
    });
  });
});
