import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  toEventSelector,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { loadConfig } from "./config.js";
import {
  CHAINLINK_SEPOLIA_ETH_USD_PROXY,
  DEFAULT_PRICE_DEVIATION_BPS,
  DEFAULT_PRICE_FEEDS,
  DEFAULT_PRICE_MAX_AGE_MS,
  answerUpdatedEventAbi,
  priceOracleAbi,
  parsePriceFeeds,
  shouldSubmitPrice,
  parseAnswerUpdatedLog,
  isDeterministicPriceRevertError,
  submitPriceWithRetry,
  emptyPriceState,
  loadPriceState,
  savePriceState,
} from "./price.js";
import { adaptProof } from "./prover.js";
import { singleProofResponse } from "./fixtures/proofs.js";

const VALID_ENV: Record<string, string> = {
  CREDITCOIN_RPC_URL: "https://rpc.cc3-testnet.creditcoin.network",
  CREDITCOIN_PROOF_BUILDER_URL: "https://prover.cc3-testnet.creditcoin.network/",
  SOURCE_CHAIN_KEY: "1",
  SOURCE_RPC_URL: "https://sepolia.example/rpc",
  SOURCE_ADDRESS: "0x1111111111111111111111111111111111111111",
  ASC_ADDRESS: "0x2222222222222222222222222222222222222222",
  WORKER_PRIVATE_KEY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function makeAnswerUpdatedLog(args: {
  emitter: string;
  answer: bigint;
  roundId: bigint;
  updatedAt: bigint;
}): Record<string, unknown> {
  const selector = keccak256(toHex("AnswerUpdated(int256,uint256,uint256)"));
  const encodeInt256Topic = (v: bigint): Hex => {
    if (v >= 0n) return `0x${v.toString(16).padStart(64, "0")}` as Hex;
    const mod = (1n << 256n) + v;
    return `0x${mod.toString(16).padStart(64, "0")}` as Hex;
  };
  return {
    address: args.emitter,
    topics: [
      selector,
      encodeInt256Topic(args.answer),
      `0x${args.roundId.toString(16).padStart(64, "0")}`,
    ],
    data: encodeAbiParameters(parseAbiParameters("uint256 updatedAt"), [args.updatedAt]),
    blockNumber: 9000n,
    transactionHash: "0xprice",
  };
}

describe("price feeds config", () => {
  it("defaults to the Chainlink Sepolia proxy", () => {
    assert.equal(
      CHAINLINK_SEPOLIA_ETH_USD_PROXY.toLowerCase(),
      "0x694aa1769357215de4fac081bf1f309adc325306",
    );
    assert.deepEqual(DEFAULT_PRICE_FEEDS, [CHAINLINK_SEPOLIA_ETH_USD_PROXY]);
    assert.deepEqual(parsePriceFeeds(undefined), [CHAINLINK_SEPOLIA_ETH_USD_PROXY]);
    assert.deepEqual(parsePriceFeeds(""), [CHAINLINK_SEPOLIA_ETH_USD_PROXY]);
  });

  it("parses a comma-separated allowlist", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const feeds = parsePriceFeeds(
      `${CHAINLINK_SEPOLIA_ETH_USD_PROXY}, ${a}`,
    );
    assert.equal(feeds.length, 2);
    assert.equal(feeds[0]?.toLowerCase(), CHAINLINK_SEPOLIA_ETH_USD_PROXY.toLowerCase());
    assert.equal(feeds[1]?.toLowerCase(), a.toLowerCase());
  });

  it("rejects invalid feed addresses", () => {
    assert.throws(() => parsePriceFeeds("not-an-address"), /PRICE_FEEDS/);
    assert.throws(() => parsePriceFeeds(`${CHAINLINK_SEPOLIA_ETH_USD_PROXY}, 0x123`), /PRICE_FEEDS/);
  });

  it("exposes deviation and max-age defaults (1 percent / 6h)", () => {
    assert.equal(DEFAULT_PRICE_DEVIATION_BPS, 100);
    assert.equal(DEFAULT_PRICE_MAX_AGE_MS, 6 * 60 * 60 * 1000);
  });

  it("loads price defaults through loadConfig", () => {
    const config = loadConfig({ ...VALID_ENV });
    assert.equal(config.priceOracleAddress, "");
    assert.deepEqual(config.priceFeeds, [CHAINLINK_SEPOLIA_ETH_USD_PROXY]);
    assert.equal(config.priceDeviationBps, 100);
    assert.equal(config.priceMaxAgeMs, 6 * 60 * 60 * 1000);
  });

  it("honors explicit price overrides and rejects bad values", () => {
    const oracle = "0x3333333333333333333333333333333333333333";
    const config = loadConfig({
      ...VALID_ENV,
      PRICE_ORACLE_ADDRESS: oracle,
      PRICE_FEEDS: `${CHAINLINK_SEPOLIA_ETH_USD_PROXY},0x1111111111111111111111111111111111111111`,
      PRICE_DEVIATION_BPS: "250",
      PRICE_MAX_AGE_MS: "3600000",
    });
    assert.equal(config.priceOracleAddress.toLowerCase(), oracle.toLowerCase());
    assert.equal(config.priceFeeds.length, 2);
    assert.equal(config.priceDeviationBps, 250);
    assert.equal(config.priceMaxAgeMs, 3600000);
    assert.throws(() => loadConfig({ ...VALID_ENV, PRICE_ORACLE_ADDRESS: "nope" }), /PRICE_ORACLE_ADDRESS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, PRICE_DEVIATION_BPS: "-1" }), /PRICE_DEVIATION_BPS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, PRICE_MAX_AGE_MS: "0" }), /PRICE_MAX_AGE_MS/);
  });
});

describe("price submission cadence", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 60 * 60 * 1000;

  it("submits the first-ever price", () => {
    assert.equal(
      shouldSubmitPrice({
        lastAnswer: null,
        lastRoundId: null,
        lastSubmittedAtMs: null,
        currentAnswer: 3000_00000000n,
        currentRoundId: 1n,
        nowMs: NOW,
        deviationBps: 100,
        maxAgeMs: 6 * HOUR,
      }),
      true,
    );
  });

  it("submits on deviation >= 1 percent", () => {
    assert.equal(
      shouldSubmitPrice({
        lastAnswer: 3000_00000000n,
        lastRoundId: 1n,
        lastSubmittedAtMs: NOW - HOUR,
        currentAnswer: 3030_00000000n,
        currentRoundId: 2n,
        nowMs: NOW,
        deviationBps: 100,
        maxAgeMs: 6 * HOUR,
      }),
      true,
    );
  });

  it("skips small moves inside the heartbeat window", () => {
    assert.equal(
      shouldSubmitPrice({
        lastAnswer: 3000_00000000n,
        lastRoundId: 1n,
        lastSubmittedAtMs: NOW - HOUR,
        currentAnswer: 3005_00000000n,
        currentRoundId: 2n,
        nowMs: NOW,
        deviationBps: 100,
        maxAgeMs: 6 * HOUR,
      }),
      false,
    );
  });

  it("submits on 6h heartbeat even without deviation", () => {
    assert.equal(
      shouldSubmitPrice({
        lastAnswer: 3000_00000000n,
        lastRoundId: 1n,
        lastSubmittedAtMs: NOW - 6 * HOUR,
        currentAnswer: 3001_00000000n,
        currentRoundId: 2n,
        nowMs: NOW,
        deviationBps: 100,
        maxAgeMs: 6 * HOUR,
      }),
      true,
    );
  });

  it("never submits non-positive answers", () => {
    for (const bad of [0n, -100n]) {
      assert.equal(
        shouldSubmitPrice({
          lastAnswer: 3000_00000000n,
          lastRoundId: 1n,
          lastSubmittedAtMs: NOW - 10 * HOUR,
          currentAnswer: bad,
          currentRoundId: 2n,
          nowMs: NOW,
          deviationBps: 100,
          maxAgeMs: 6 * HOUR,
        }),
        false,
      );
    }
  });

  it("skips stale rounds the oracle would revert", () => {
    assert.equal(
      shouldSubmitPrice({
        lastAnswer: 3000_00000000n,
        lastRoundId: 5n,
        lastSubmittedAtMs: NOW - 10 * HOUR,
        currentAnswer: 4000_00000000n,
        currentRoundId: 5n,
        nowMs: NOW,
        deviationBps: 100,
        maxAgeMs: 6 * HOUR,
      }),
      false,
    );
  });
});

describe("AnswerUpdated log parsing", () => {
  it("parses a valid log from an allowlisted emitter", () => {
    const parsed = parseAnswerUpdatedLog(
      makeAnswerUpdatedLog({
        emitter: CHAINLINK_SEPOLIA_ETH_USD_PROXY,
        answer: 3000_00000000n,
        roundId: 7n,
        updatedAt: 1_700_000_000n,
      }),
      [CHAINLINK_SEPOLIA_ETH_USD_PROXY],
    );
    assert.ok(parsed !== null);
    assert.equal(parsed.answer, 3000_00000000n);
    assert.equal(parsed.roundId, 7n);
    assert.equal(parsed.updatedAt, 1_700_000_000n);
  });

  it("returns null for foreign emitters and malformed logs", () => {
    const valid = makeAnswerUpdatedLog({
      emitter: CHAINLINK_SEPOLIA_ETH_USD_PROXY,
      answer: 3000_00000000n,
      roundId: 7n,
      updatedAt: 1_700_000_000n,
    });
    assert.equal(
      parseAnswerUpdatedLog(valid, ["0x9999999999999999999999999999999999999999"]),
      null,
    );
    assert.equal(parseAnswerUpdatedLog(null, [CHAINLINK_SEPOLIA_ETH_USD_PROXY]), null);
    assert.equal(parseAnswerUpdatedLog({}, [CHAINLINK_SEPOLIA_ETH_USD_PROXY]), null);
    assert.equal(
      parseAnswerUpdatedLog({ ...valid, topics: [] }, [CHAINLINK_SEPOLIA_ETH_USD_PROXY]),
      null,
    );
  });

  it("matches the frozen AnswerUpdated signature", () => {
    assert.equal(
      keccak256(toHex("AnswerUpdated(int256,uint256,uint256)")),
      toEventSelector(answerUpdatedEventAbi),
    );
  });
});

describe("price submission ABI", () => {
  it("encodes updatePrice with the compiled oracle artifact selector", () => {
    const artifactPath = resolve(
      __dirname,
      "..",
      "..",
      "..",
      "contracts",
      "artifacts",
      "attestcoin",
      "PixelOrbitPriceOracle.sol",
      "PixelOrbitPriceOracle.json",
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown as {
      abi: readonly unknown[];
    };
    const names = (artifact.abi as { name?: string }[]).map((e) => e.name);
    assert.ok(names.includes("updatePrice"), "artifact must expose updatePrice");
    const proof = adaptProof(singleProofResponse);
    const data = encodeFunctionData({
      abi: priceOracleAbi,
      functionName: "updatePrice",
      args: [
        0,
        BigInt(proof.chainKey),
        BigInt(proof.height),
        proof.txBytes,
        proof.root,
        [...proof.siblings],
        proof.digest,
        [...proof.roots],
      ],
    });
    assert.equal(
      data.slice(0, 10),
      toFunctionSelector(
        "updatePrice(uint8,uint64,uint64,bytes,bytes32,(bytes32,bool)[],bytes32,bytes32[])",
      ),
    );
    const artifactData = encodeFunctionData({
      abi: artifact.abi as unknown as typeof priceOracleAbi,
      functionName: "updatePrice",
      args: [
        0,
        BigInt(proof.chainKey),
        BigInt(proof.height),
        proof.txBytes,
        proof.root,
        [...proof.siblings],
        proof.digest,
        [...proof.roots],
      ],
    });
    assert.equal(data, artifactData);
  });
});

describe("price retry", () => {
  const noSleep = async (_ms: number): Promise<void> => {};

  it("classifies oracle validation reverts as deterministic", () => {
    assert.equal(isDeterministicPriceRevertError("Stale round"), true);
    assert.equal(isDeterministicPriceRevertError("Unknown emitter"), true);
    assert.equal(isDeterministicPriceRevertError("Bad answer"), true);
    assert.equal(isDeterministicPriceRevertError("Wrong chain"), true);
    assert.equal(isDeterministicPriceRevertError("flaky rpc"), false);
    assert.equal(isDeterministicPriceRevertError(""), false);
  });

  it("submits once on success", async () => {
    const outcome = await submitPriceWithRetry({
      proof: adaptProof(singleProofResponse),
      submit: async () => "0xprice",
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "submitted");
    assert.equal(outcome.txHash, "0xprice");
    assert.equal(outcome.attempts, 1);
  });

  it("retries transient failures with backoff then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const outcome = await submitPriceWithRetry({
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        calls += 1;
        if (calls < 3) throw new Error("flaky rpc");
        return "0xok";
      },
      maxRetries: 3,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    assert.equal(outcome.status, "submitted");
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  it("skips deterministic reverts without retry", async () => {
    let calls = 0;
    const outcome = await submitPriceWithRetry({
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        calls += 1;
        throw new Error("Stale round");
      },
      maxRetries: 5,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(calls, 1);
  });

  it("parks the price as failed after exhausting retries", async () => {
    const outcome = await submitPriceWithRetry({
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        throw new Error("always down");
      },
      maxRetries: 2,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.attempts, 2);
  });
});

describe("price state persistence", () => {
  it("round-trips through a separate JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "price-test-"));
    const path = join(dir, "price-state.json");
    const state = emptyPriceState();
    state.lastAnswer = "300000000000";
    state.lastRoundId = "7";
    state.lastSubmittedAt = "2026-09-12T00:00:00.000Z";
    savePriceState(path, state);
    assert.deepEqual(loadPriceState(path), state);
    assert.deepEqual(loadPriceState(join(dir, "missing.json")), emptyPriceState());
  });
});
