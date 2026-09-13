import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract } from "ethers";

// Chainlink Sepolia ETH/USD proxy (8 decimals). The oracle starts allowlisted
// with this emitter; aggregator rotation is covered by setFeedEmitter tests.
const PROXY = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const SOURCE_CHAIN_KEY = 1n;
const PROVEN_HEIGHT = 11686603n;
const ZERO_HASH = ethers.ZeroHash;

// AnswerUpdated(int256,uint256,uint256): answer and roundId are indexed
// topics, updatedAt is the log data. Matches the Chainlink aggregator event.
const ANSWER_UPDATED_SIG = ethers.id("AnswerUpdated(int256,uint256,uint256)");

function topic32(value: bigint): string {
  if (value >= 0n) {
    return ethers.zeroPadValue(ethers.toBeHex(value), 32);
  }
  return ethers.toBeHex((1n << 256n) + value, 32);
}

function answerLog(emitter: string, answer: bigint, roundId: bigint, updatedAt: bigint) {
  return {
    address_: emitter,
    topics: [ANSWER_UPDATED_SIG, topic32(answer), topic32(roundId)],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [updatedAt]),
  };
}

interface PriceLog {
  address_: string;
  topics: string[];
  data: string;
}

function buildPriceTxBytes(
  from: string,
  to: string,
  logs: PriceLog[],
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const chunk0 = coder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [0, 0, from, to === ethers.ZeroAddress, to, 0, "0x"],
  );
  const chunk1 = coder.encode(
    ["uint64", "uint128", "uint128", "tuple(address account,bytes32[] storageKeys)[]", "uint8", "bytes32", "bytes32"],
    [11155111, 0, 0, [], 0, ethers.ZeroHash, ethers.ZeroHash],
  );
  const logTuples = logs.map((l) => [l.address_, l.topics, l.data]);
  const chunk2 = coder.encode(
    ["uint8", "uint64", "tuple(address addr,bytes32[] topics,bytes data)[]", "bytes"],
    [1, 0, logTuples, "0x"],
  );
  return coder.encode(["uint8", "bytes[]"], [2, [chunk0, chunk1, chunk2]]);
}

describe("PixelOrbitPriceOracle", function () {
  let prover: Contract;
  let oracle: Contract;
  let ownerAddr: string;
  let otherAddr: string;

  async function deployOracle(initialEmitter: string): Promise<Contract> {
    const ProverFactory = await ethers.getContractFactory("MockBlockProver");
    const proverContract = await ProverFactory.deploy();
    await proverContract.waitForDeployment();
    prover = proverContract as unknown as Contract;
    const OracleFactory = await ethers.getContractFactory("PixelOrbitPriceOracle");
    const oracleContract = await OracleFactory.deploy(
      await (proverContract as unknown as Contract).getAddress(),
      SOURCE_CHAIN_KEY,
      initialEmitter,
    );
    await oracleContract.waitForDeployment();
    return oracleContract as unknown as Contract;
  }

  function priceTx(
    emitter: string,
    answer: bigint,
    roundId: bigint,
    updatedAt: bigint,
  ): string {
    return buildPriceTxBytes(otherAddr, emitter, [answerLog(emitter, answer, roundId, updatedAt)]);
  }

  function emptyTx(emitter: string): string {
    return buildPriceTxBytes(otherAddr, emitter, []);
  }

  async function updatePrice(chainKey: bigint, txBytes: string, action = 0) {
    return oracle.getFunction("updatePrice")(
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

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    ownerAddr = signers[0]?.address ?? "";
    otherAddr = signers[1]?.address ?? "";
    oracle = await deployOracle(PROXY);
  });

  it("starts with the proxy allowlisted and zero price state", async function () {
    expect(await oracle.getFunction("feedEmitters")(PROXY)).to.equal(true);
    expect(await oracle.getFunction("answer")()).to.equal(0);
    expect(await oracle.getFunction("roundId")()).to.equal(0);
  });

  it("stores a proven AnswerUpdated and emits PriceUpdated on the happy path", async function () {
    const updatedAt = 1_700_000_000n;
    const txBytes = priceTx(PROXY, 3000_00000000n, 1n, updatedAt);
    await expect(updatePrice(SOURCE_CHAIN_KEY, txBytes))
      .to.emit(oracle, "PriceUpdated")
      .withArgs(3000_00000000n, 1n, updatedAt);
    expect(await oracle.getFunction("answer")()).to.equal(3000_00000000n);
    expect(await oracle.getFunction("roundId")()).to.equal(1n);
    expect(await oracle.getFunction("updatedAt")()).to.equal(updatedAt);
  });

  it("reverts on an unknown emitter", async function () {
    const txBytes = priceTx(otherAddr, 3000_00000000n, 1n, 1_700_000_000n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith(
      "Unknown emitter",
    );
  });

  it("reverts when the receipt carries no AnswerUpdated log", async function () {
    const txBytes = emptyTx(PROXY);
    await expect(updatePrice(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("No answer");
  });

  it("reverts on an unknown action discriminator", async function () {
    const txBytes = priceTx(PROXY, 3000_00000000n, 1n, 1_700_000_000n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, txBytes, 1)).to.be.revertedWith("Bad action");
  });

  it("reverts on a non-increasing roundId", async function () {
    const first = priceTx(PROXY, 3000_00000000n, 5n, 1_700_000_000n);
    await updatePrice(SOURCE_CHAIN_KEY, first);
    const sameRound = priceTx(PROXY, 3100_00000000n, 5n, 1_700_000_001n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, sameRound)).to.be.revertedWith("Stale round");
    const olderRound = priceTx(PROXY, 3100_00000000n, 4n, 1_700_000_002n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, olderRound)).to.be.revertedWith("Stale round");
  });

  it("reverts on a non-positive answer", async function () {
    const zeroAnswer = priceTx(PROXY, 0n, 1n, 1_700_000_000n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, zeroAnswer)).to.be.revertedWith("Bad answer");
    const negAnswer = priceTx(PROXY, -100n, 2n, 1_700_000_001n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, negAnswer)).to.be.revertedWith("Bad answer");
  });

  it("supports emitter rotation: add then remove", async function () {
    const newEmitterTx = priceTx(otherAddr, 3000_00000000n, 1n, 1_700_000_000n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, newEmitterTx)).to.be.revertedWith(
      "Unknown emitter",
    );
    await expect(oracle.getFunction("setFeedEmitter")(otherAddr, true))
      .to.emit(oracle, "PriceFeedUpdated")
      .withArgs(otherAddr, true);
    await expect(updatePrice(SOURCE_CHAIN_KEY, newEmitterTx))
      .to.emit(oracle, "PriceUpdated")
      .withArgs(3000_00000000n, 1n, 1_700_000_000n);
    await expect(oracle.getFunction("setFeedEmitter")(otherAddr, false))
      .to.emit(oracle, "PriceFeedUpdated")
      .withArgs(otherAddr, false);
    const secondTx = priceTx(otherAddr, 3100_00000000n, 2n, 1_700_000_001n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, secondTx)).to.be.revertedWith(
      "Unknown emitter",
    );
    expect(await oracle.getFunction("feedEmitters")(otherAddr)).to.equal(false);
  });

  it("rejects setFeedEmitter from non-owners and zero addresses", async function () {
    const signers = await ethers.getSigners();
    const nonOwner = signers[1];
    if (nonOwner === undefined) throw new Error("missing signer");
    await expect(
      (oracle.connect(nonOwner) as Contract).getFunction("setFeedEmitter")(otherAddr, true),
    ).to.be.reverted;
    await expect(oracle.getFunction("setFeedEmitter")(ethers.ZeroAddress, true)).to.be.revertedWith(
      "Bad emitter",
    );
  });

  it("reverts when the prover returns false", async function () {
    const txBytes = priceTx(PROXY, 3000_00000000n, 1n, 1_700_000_000n);
    await prover.getFunction("setResult")(false);
    await expect(updatePrice(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Invalid proof");
  });

  it("reverts on a proof for the wrong chain", async function () {
    const txBytes = priceTx(PROXY, 3000_00000000n, 1n, 1_700_000_000n);
    await expect(updatePrice(2n, txBytes)).to.be.revertedWith("Wrong chain");
  });

  it("rejects zero prover, zero chainkey, and zero emitter in the constructor", async function () {
    const OracleFactory = await ethers.getContractFactory("PixelOrbitPriceOracle");
    const proverAddr = await prover.getAddress();
    await expect(
      OracleFactory.deploy(ethers.ZeroAddress, SOURCE_CHAIN_KEY, PROXY),
    ).to.be.revertedWith("BlockProver required");
    await expect(OracleFactory.deploy(proverAddr, 0, PROXY)).to.be.revertedWith(
      "Bad chainkey",
    );
    await expect(
      OracleFactory.deploy(proverAddr, SOURCE_CHAIN_KEY, ethers.ZeroAddress),
    ).to.be.revertedWith("Emitter required");
  });

  it("reverts on a zero updatedAt timestamp", async function () {
    const txBytes = priceTx(PROXY, 3000_00000000n, 1n, 0n);
    await expect(updatePrice(SOURCE_CHAIN_KEY, txBytes)).to.be.revertedWith("Bad timestamp");
  });

  it("exposes the owner-set sourceChainKey and blockProver", async function () {
    expect(await oracle.getFunction("sourceChainKey")()).to.equal(SOURCE_CHAIN_KEY);
    expect(await oracle.getFunction("blockProver")()).to.equal(await prover.getAddress());
    expect(ownerAddr).to.not.equal("");
  });
});
