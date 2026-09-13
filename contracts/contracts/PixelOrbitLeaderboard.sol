// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract PixelOrbitLeaderboard is Ownable {
    event ScoreSubmitted(address indexed player, uint256 score, string shipName, uint256 timestamp);
    event UsernameSet(address indexed player, string username);
    event AscUpdated(address asc);

    struct UserStats {
        uint256 gamesPlayed;
        uint256 bestScore;
        string spaceship;
    }

    struct UserStatsView {
        address addr;
        uint256 gamesPlayed;
        uint256 bestScore;
        string spaceship;
    }

    struct ShipScoreView {
        string shipName;
        uint256 bestScore;
    }

    mapping(address => UserStats) private usersStats;
    mapping(address => mapping(string => uint256)) private shipBestScores;
    mapping(address => string[]) private playerShips;
    mapping(address => mapping(string => bool)) private shipRegistered;
    mapping(address => string) public usernames;
    address[] private userAddresses;

    // ASC-gated attested tier: base score submission stays open, while the
    // ASC marks bridged players as attested.
    address public asc;
    mapping(address => bool) public attestedPlayer;

    constructor() Ownable(msg.sender) {}

    function setAsc(address _asc) external onlyOwner {
        require(_asc != address(0), "Invalid ASC");
        asc = _asc;
        emit AscUpdated(_asc);
    }

    function markAttested(address player) external {
        require(msg.sender == asc, "Only ASC");
        require(player != address(0), "Invalid player");
        attestedPlayer[player] = true;
    }

    function submitScore(uint256 score, string calldata shipName) external {
        require(score > 0, "Score must be positive");
        require(bytes(shipName).length > 0, "Empty ship name");

        _recordScore(msg.sender, score, shipName);
    }

    function _recordScore(address player, uint256 score, string calldata shipName) internal {
        UserStats storage stats = usersStats[player];

        if (stats.gamesPlayed == 0) {
            userAddresses.push(player);
            stats.gamesPlayed = 1;
            stats.bestScore = score;
            stats.spaceship = shipName;
        } else {
            stats.gamesPlayed += 1;
            if (score > stats.bestScore) {
                stats.bestScore = score;
                stats.spaceship = shipName;
            }
        }

        if (score > shipBestScores[player][shipName]) {
            shipBestScores[player][shipName] = score;
        }

        if (!shipRegistered[player][shipName]) {
            shipRegistered[player][shipName] = true;
            playerShips[player].push(shipName);
        }

        emit ScoreSubmitted(player, score, shipName, block.timestamp);
    }

    function setUsername(string calldata username) external {
        require(bytes(username).length > 0, "Empty username");
        require(bytes(username).length <= 32, "Username too long");
        usernames[msg.sender] = username;
        emit UsernameSet(msg.sender, username);
    }

    function getUsername(address player) external view returns (string memory) {
        return usernames[player];
    }

    function getUserStats(address user)
        external
        view
        returns (uint256 gamesPlayed, uint256 bestScore, string memory spaceship)
    {
        UserStats memory stats = usersStats[user];
        return (stats.gamesPlayed, stats.bestScore, stats.spaceship);
    }

    function getShipBestScore(address player, string calldata shipName) external view returns (uint256) {
        return shipBestScores[player][shipName];
    }

    function getPlayerShipScores(address player) external view returns (ShipScoreView[] memory) {
        string[] memory ships = playerShips[player];
        ShipScoreView[] memory scores = new ShipScoreView[](ships.length);

        for (uint256 i = 0; i < ships.length; i++) {
            scores[i] = ShipScoreView({
                shipName: ships[i],
                bestScore: shipBestScores[player][ships[i]]
            });
        }

        return scores;
    }

    function getAllUserStats() external view returns (UserStatsView[] memory) {
        UserStatsView[] memory allStats = new UserStatsView[](userAddresses.length);

        for (uint256 i = 0; i < userAddresses.length; i++) {
            address userAddr = userAddresses[i];
            UserStats memory stats = usersStats[userAddr];

            allStats[i] = UserStatsView({
                addr: userAddr,
                gamesPlayed: stats.gamesPlayed,
                bestScore: stats.bestScore,
                spaceship: stats.spaceship
            });
        }

        return allStats;
    }

    function getTotalPlayers() external view returns (uint256) {
        return userAddresses.length;
    }
}
