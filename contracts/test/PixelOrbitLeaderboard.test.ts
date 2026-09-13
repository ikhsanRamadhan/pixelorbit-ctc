import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { PixelOrbitLeaderboard } from "../typechain-types";

describe("PixelOrbitLeaderboard", function () {
  let leaderboard: PixelOrbitLeaderboard;
  let owner: SignerWithAddress;
  let player1: SignerWithAddress;
  let player2: SignerWithAddress;
  let player3: SignerWithAddress;
  let asc: SignerWithAddress;

  beforeEach(async function () {
    [owner, player1, player2, player3, asc] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PixelOrbitLeaderboard");
    leaderboard = await Factory.deploy();
  });

  describe("submitScore", function () {
    it("should store score and emit ScoreSubmitted event for new user", async function () {
      const tx = await leaderboard.connect(player1).submitScore(1500, "Fighter");
      const receipt = await tx.wait();
      const log = leaderboard.interface.parseLog(receipt!.logs[0])!;
      expect(log.name).to.equal("ScoreSubmitted");
      expect(log.args.player).to.equal(player1.address);
      expect(log.args.score).to.equal(1500n);
      expect(log.args.shipName).to.equal("Fighter");
      expect(log.args.timestamp).to.be.greaterThan(0n);
    });

    it("should store best score in user stats", async function () {
      await leaderboard.connect(player1).submitScore(1500, "Fighter");
      const [gamesPlayed, bestScore, spaceship] = await leaderboard.getUserStats(player1.address);
      expect(gamesPlayed).to.equal(1n);
      expect(bestScore).to.equal(1500n);
      expect(spaceship).to.equal("Fighter");
    });

    it("should update best score when new score is higher", async function () {
      await leaderboard.connect(player1).submitScore(1500, "Fighter");
      await leaderboard.connect(player1).submitScore(3000, "Fighter");
      const [gamesPlayed, bestScore, spaceship] = await leaderboard.getUserStats(player1.address);
      expect(gamesPlayed).to.equal(2n);
      expect(bestScore).to.equal(3000n);
      expect(spaceship).to.equal("Fighter");
    });

    it("should not overwrite best score when new score is lower", async function () {
      await leaderboard.connect(player1).submitScore(3000, "Fighter");
      await leaderboard.connect(player1).submitScore(1000, "Fighter");
      const [, bestScore,] = await leaderboard.getUserStats(player1.address);
      expect(bestScore).to.equal(3000n);
    });

    it("should track per-ship best scores independently", async function () {
      await leaderboard.connect(player1).submitScore(1500, "Fighter");
      await leaderboard.connect(player1).submitScore(2000, "Bomber");
      await leaderboard.connect(player1).submitScore(1200, "Fighter");

      const fighterBest = await leaderboard.getShipBestScore(player1.address, "Fighter");
      const bomberBest = await leaderboard.getShipBestScore(player1.address, "Bomber");

      expect(fighterBest).to.equal(1500n);
      expect(bomberBest).to.equal(2000n);
    });

    it("should update spaceship field to latest ship name", async function () {
      await leaderboard.connect(player1).submitScore(1500, "Fighter");
      await leaderboard.connect(player1).submitScore(2000, "Bomber");
      const [, , spaceship] = await leaderboard.getUserStats(player1.address);
      expect(spaceship).to.equal("Bomber");
    });

    it("should not update spaceship field when score is not a new best", async function () {
      await leaderboard.connect(player1).submitScore(2000, "Fighter");
      await leaderboard.connect(player1).submitScore(500, "Bomber");
      const [, , spaceship] = await leaderboard.getUserStats(player1.address);
      expect(spaceship).to.equal("Fighter");
    });

    it("should revert if score is 0", async function () {
      await expect(
        leaderboard.connect(player1).submitScore(0, "Fighter")
      ).to.be.revertedWith("Score must be positive");
    });

    it("should revert if ship name is empty", async function () {
      await expect(
        leaderboard.connect(player1).submitScore(100, "")
      ).to.be.revertedWith("Empty ship name");
    });
  });

  describe("getShipBestScore", function () {
    it("should return 0 for unregistered ship", async function () {
      const score = await leaderboard.getShipBestScore(player1.address, "Fighter");
      expect(score).to.equal(0n);
    });

    it("should return correct best score after multiple submissions", async function () {
      await leaderboard.connect(player1).submitScore(100, "Fighter");
      await leaderboard.connect(player1).submitScore(500, "Fighter");
      await leaderboard.connect(player1).submitScore(300, "Fighter");
      const score = await leaderboard.getShipBestScore(player1.address, "Fighter");
      expect(score).to.equal(500n);
    });
  });

  describe("getPlayerShipScores", function () {
    it("should return empty array for player with no scores", async function () {
      const scores = await leaderboard.getPlayerShipScores(player1.address);
      expect(scores.length).to.equal(0);
    });

    it("should return all ship scores for a player", async function () {
      await leaderboard.connect(player1).submitScore(100, "Fighter");
      await leaderboard.connect(player1).submitScore(200, "Bomber");
      await leaderboard.connect(player1).submitScore(300, "Scout");

      const scores = await leaderboard.getPlayerShipScores(player1.address);
      expect(scores.length).to.equal(3);
    });
  });

  describe("getAllUserStats", function () {
    it("should return empty array when no scores submitted", async function () {
      const allStats = await leaderboard.getAllUserStats();
      expect(allStats.length).to.equal(0);
    });

    it("should return all registered users", async function () {
      await leaderboard.connect(player1).submitScore(1500, "Fighter");
      await leaderboard.connect(player2).submitScore(3000, "Bomber");
      await leaderboard.connect(player3).submitScore(500, "Scout");

      const allStats = await leaderboard.getAllUserStats();
      expect(allStats.length).to.equal(3);

      const p1 = allStats.find((s) => s.addr === player1.address)!;
      expect(p1.gamesPlayed).to.equal(1n);
      expect(p1.bestScore).to.equal(1500n);
      expect(p1.spaceship).to.equal("Fighter");
    });

    it("should not duplicate users on multiple submissions", async function () {
      await leaderboard.connect(player1).submitScore(100, "Fighter");
      await leaderboard.connect(player1).submitScore(200, "Fighter");
      await leaderboard.connect(player1).submitScore(300, "Bomber");

      const allStats = await leaderboard.getAllUserStats();
      expect(allStats.length).to.equal(1);
      expect(allStats[0].gamesPlayed).to.equal(3n);
      expect(allStats[0].bestScore).to.equal(300n);
    });
  });

  describe("getTotalPlayers", function () {
    it("should return 0 initially", async function () {
      expect(await leaderboard.getTotalPlayers()).to.equal(0n);
    });

    it("should return correct count after submissions", async function () {
      await leaderboard.connect(player1).submitScore(100, "Fighter");
      await leaderboard.connect(player2).submitScore(200, "Bomber");
      expect(await leaderboard.getTotalPlayers()).to.equal(2n);
    });

    it("should not count duplicate players", async function () {
      await leaderboard.connect(player1).submitScore(100, "Fighter");
      await leaderboard.connect(player1).submitScore(200, "Fighter");
      expect(await leaderboard.getTotalPlayers()).to.equal(1n);
    });
  });

  describe("setUsername / getUsername", function () {
    it("should set and get username", async function () {
      await leaderboard.connect(player1).setUsername("CosmicAce");
      expect(await leaderboard.getUsername(player1.address)).to.equal("CosmicAce");
    });

    it("should emit UsernameSet event", async function () {
      const tx = await leaderboard.connect(player1).setUsername("CosmicAce");
      const receipt = await tx.wait();
      const log = leaderboard.interface.parseLog(receipt!.logs[0])!;
      expect(log.name).to.equal("UsernameSet");
      expect(log.args.player).to.equal(player1.address);
      expect(log.args.username).to.equal("CosmicAce");
    });

    it("should revert if username is empty", async function () {
      await expect(
        leaderboard.connect(player1).setUsername("")
      ).to.be.revertedWith("Empty username");
    });

    it("should revert if username is too long", async function () {
      const longName = "A".repeat(33);
      await expect(
        leaderboard.connect(player1).setUsername(longName)
      ).to.be.revertedWith("Username too long");
    });

    it("should allow max 32 char username", async function () {
      const name = "A".repeat(32);
      await leaderboard.connect(player1).setUsername(name);
      expect(await leaderboard.getUsername(player1.address)).to.equal(name);
    });
  });

  describe("Ownership", function () {
    it("should set owner to deployer", async function () {
      expect(await leaderboard.owner()).to.equal(owner.address);
    });
  });

  describe("setAsc", function () {
    it("starts unset", async function () {
      expect(await leaderboard.asc()).to.equal(ethers.ZeroAddress);
    });

    it("is owner-only", async function () {
      await expect(
        leaderboard.connect(player1).setAsc(asc.address)
      ).to.be.revertedWithCustomError(leaderboard, "OwnableUnauthorizedAccount");
    });

    it("sets ASC and emits AscUpdated", async function () {
      await expect(leaderboard.connect(owner).setAsc(asc.address))
        .to.emit(leaderboard, "AscUpdated")
        .withArgs(asc.address);
      expect(await leaderboard.asc()).to.equal(asc.address);
    });

    it("reverts on zero address", async function () {
      await expect(
        leaderboard.connect(owner).setAsc(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid ASC");
    });
  });

  describe("markAttested", function () {
    beforeEach(async function () {
      await leaderboard.connect(owner).setAsc(asc.address);
    });

    it("defaults to unattested", async function () {
      expect(await leaderboard.attestedPlayer(player1.address)).to.equal(false);
    });

    it("marks a player attested when called by ASC", async function () {
      await leaderboard.connect(asc).markAttested(player1.address);
      expect(await leaderboard.attestedPlayer(player1.address)).to.equal(true);
    });

    it("reverts when called by non-ASC", async function () {
      await expect(
        leaderboard.connect(player1).markAttested(player1.address)
      ).to.be.revertedWith("Only ASC");
      await expect(
        leaderboard.connect(owner).markAttested(player1.address)
      ).to.be.revertedWith("Only ASC");
    });

    it("reverts on zero player address", async function () {
      await expect(
        leaderboard.connect(asc).markAttested(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid player");
    });

    it("keeps open submitScore working after ASC is set", async function () {
      await leaderboard.connect(player1).submitScore(1500, "Fighter");
      const [, bestScore] = await leaderboard.getUserStats(player1.address);
      expect(bestScore).to.equal(1500n);
      await leaderboard.connect(asc).markAttested(player1.address);
      expect(await leaderboard.attestedPlayer(player1.address)).to.equal(true);
    });
  });
});
