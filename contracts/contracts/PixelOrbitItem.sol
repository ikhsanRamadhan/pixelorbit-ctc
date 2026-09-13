// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract PixelOrbitItem is ERC721Enumerable, Ownable {

    enum Rarity {
        Common,
        Uncommon,
        Rare,
        Epic,
        Legendary
    }

    struct ItemType {
        string name;
        string imageURI;
        string metadataURI;
        Rarity rarity;
    }

    ItemType[] public itemTypes;
    mapping(uint256 => uint256) public tokenItemType;

    /**
     * Attestcoin Smart Contract allowed to mint bridged items. Set by the
     * owner after deploy; zero until then, so no bridged mint can happen
     * before wiring.
     */
    address public asc;

    /// Spent bridge nonces, guarding `mintBridged` against replay.
    mapping(uint256 => bool) public usedNonces;

    /**
     * Server run-signer allowed to authorize crate claims. Set by the owner
     * after deploy; zero until then, so no claim can verify before wiring.
     * Same key as the score run-token signer: one server identity for runs.
     */
    address public runSigner;

    /// Spent run nonces, guarding `claimCrates` against double-claims.
    mapping(bytes32 => bool) public usedRunNonces;

    /// Upper bound per claim: matches the game-over tile cap and bounds gas.
    uint256 public constant MAX_CRATES_PER_CLAIM = 25;

    /**
     * Relative likelihood of each rarity tier, indexed by `Rarity`.
     *
     * These reproduce the drop table the client used to apply on its own
     * (5 Common items at weight 20 each = 100, 3 Uncommon at 12 = 36, and so
     * on), so moving the roll on-chain did not change what players see. Within a
     * tier every item is equally likely, which is what the old table did too.
     */
    uint256[5] public rarityWeights = [100, 36, 12, 4, 2];

    event ItemMinted(address indexed to, uint256 indexed tokenId, uint256 itemTypeIndex, Rarity rarity);
    event AscUpdated(address asc);
    event RunSignerUpdated(address runSigner);
    event CratesClaimed(address indexed player, bytes32 indexed runNonce, uint256 crateCount);

    constructor() ERC721("PixelOrbit Item", "POITEM") Ownable(msg.sender) {

        _addItem("Base", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmcreEXpatXqcc54b8NzARJyqmkzxW1RmMBvQ7jYvL9yaz", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreiaz4svrta5ce3vnh3zrjir5ch72ihyuat2w2s75a5hjepvt2xzzvi", Rarity.Common);
        _addItem("Burst", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/Qmcm3gcExwoFnA4VGifqP6MUE8JijnayddXeDhSvtboWJ7", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreialnbt5q22vqojdb636i5mitwi453q6srmzmtnbwmkqx4w7lfxija", Rarity.Common);
        _addItem("Supercharged", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmNV2qPchjt7UZM3fVHtdQpGm5cyLyCUzDpZnNDEzyUi9v", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreia3twdchykf64lcc5xktzb4lovhxhc3nvscg7cbqdzxzpg7jkj4qq", Rarity.Common);
        _addItem("Big Pulse", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmXKvqAigvN9CYQJLiFiUSoskXR4KTYCBS5Z6i5PiPftVv", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreib7wfsgfathtmqkpb5yh3x5hg2gmqoc2mflqs7kxopfv32zkiqlru", Rarity.Common);
        _addItem("Front Shield", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmRdWGGLjY6KtPR8u4b2YVSQC5n9cYK2bqL1jeLPaZjcZ4", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreiaff6bns6uyo5kze55sxdeycae72b5jn27x52ea6u353jt7hpzqwa", Rarity.Common);
        _addItem("Side Shield", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmQkAQ5jU6K2K5aYNFdhjnxPNFs9Kohe84GhHdGzRWQFWB", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreicbnsm2ovdxio4g3oya3brbp3nr7w6timbkmggcquyl2r4jonpufi", Rarity.Uncommon);
        _addItem("Shield", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmQFvpkKCPC1NyeutqvkEZU45XRcB5k1C1KJb7f3zpo2YD", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreib2ipqubvq2zxxuvpn6oyaa3rphwd7ouuxl327irczwvb55npd6om", Rarity.Uncommon);
        _addItem("Stars", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmW3z6CFtd7xTro6qX3JDbJVUmFc3Q9FfnV6nTvHepG81V", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreia5ba3xmpgykmwlflvvonrkmh2sijjsidqiwdpolw5imupgvt4wme", Rarity.Uncommon);
        _addItem("Rocket", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmQSdBAf4czpaEtRjTsGTPbH9uSYiKXaXbV9FiC2kFP56J", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreienmjege32r6ts2l3nozalb2v2il4wak6x7jnrwzqpkqxx7cuamnq", Rarity.Rare);
        _addItem("Auto Cannons", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmQZxdMogqxCMnyHN4zdhzGj7LLrkxM2stTr859YfB8Shg", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreih65erlgv6kp2z2z6civgokaj7f6e4s43ph4cmvijcq22gsowpx4u", Rarity.Rare);
        _addItem("Space Gun 2000", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmcsJXFjtAH3NrjJWaYcn9RBTqHsMMax5zd9hrfpp1ByQd", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreiefsxeolasng6gh7ioy2swiqlm3iqbbqjj4iurd2vnjftarcpgszy", Rarity.Epic);
        _addItem("Zapper", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmQAJQFi5BVcvsq2XoJ7GAg9HzpV3oUz3BDBXy8V34LFrC", "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/bafkreig2kgnzbf3opbledvuqptv6tc6o7iyld4wqwx6ekqi3i2dkjj6tly", Rarity.Legendary);
    }

    function _addItem(string memory name, string memory imageURI, string memory metadataURI, Rarity rarity) internal {
        itemTypes.push(ItemType({name: name, imageURI: imageURI, metadataURI: metadataURI, rarity: rarity}));
    }

    /// Point the contract at the Attestcoin Smart Contract allowed to mint.
    function setAsc(address _asc) external onlyOwner {
        require(_asc != address(0), "Invalid ASC");
        asc = _asc;
        emit AscUpdated(_asc);
    }

    /// Point the contract at the server run-signer allowed to authorize
    /// crate claims. Zero until set, so no claim verifies before wiring.
    function setRunSigner(address _runSigner) external onlyOwner {
        require(_runSigner != address(0), "Bad signer");
        runSigner = _runSigner;
        emit RunSignerUpdated(_runSigner);
    }

    /**
     * Open run-earned salvage crates into items. The caller proves the run
     * with a server signature over (this contract, chain, player, run nonce,
     * crate count); rarity rolls from a `prevrandao`-mixed seed per crate,
     * reusing the same weighted table as `mintBridged`.
     *
     * Trust model matches the score run-token: the signature stops casual
     * forgery (a client cannot mint without a run through the server), not a
     * determined cheater — the server never sees gameplay, so the count is
     * client-reported up to the per-claim cap. One run nonce claims once.
     */
    function claimCrates(bytes32 runNonce, uint8 crateCount, bytes calldata signature) external {
        require(crateCount > 0, "No crates");
        require(crateCount <= MAX_CRATES_PER_CLAIM, "Too many crates");
        require(runSigner != address(0), "Claim not configured");
        require(!usedRunNonces[runNonce], "Claim replayed");
        bytes32 digest = keccak256(
            abi.encode(address(this), block.chainid, msg.sender, runNonce, crateCount)
        );
        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
        require(recovered == runSigner, "Bad claim");
        usedRunNonces[runNonce] = true;

        for (uint256 i = 0; i < crateCount; ) {
            uint256 seed = uint256(
                keccak256(abi.encodePacked(block.prevrandao, runNonce, msg.sender, block.timestamp, i))
            );
            uint256 itemTypeIndex = _pickItemType(seed);
            uint256 tokenId = totalSupply();
            _safeMint(msg.sender, tokenId);
            tokenItemType[tokenId] = itemTypeIndex;
            emit ItemMinted(msg.sender, tokenId, itemTypeIndex, itemTypes[itemTypeIndex].rarity);
            unchecked {
                ++i;
            }
        }
        emit CratesClaimed(msg.sender, runNonce, crateCount);
    }

    /**
     * Mint a bridged item to `to`. The caller must be the ASC, which only
     * calls this after verifying a Sepolia lock proof — that is the only
    * authorisation. Rarity is rolled from a `prevrandao`-mixed seed: honest
    * about being weaker than a VRF-grade beacon, and stated as such.
     */
    function mintBridged(address to, uint256 nonce) external returns (uint256 tokenId) {
        require(msg.sender == asc, "Only ASC");
        require(!usedNonces[nonce], "Nonce already used");
        usedNonces[nonce] = true;

        uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao, nonce, to, block.timestamp)));
        uint256 itemTypeIndex = _pickItemType(seed);

        tokenId = totalSupply();
        _safeMint(to, tokenId);
        tokenItemType[tokenId] = itemTypeIndex;
        emit ItemMinted(to, tokenId, itemTypeIndex, itemTypes[itemTypeIndex].rarity);
    }

    /**
     * Weighted pick of a rarity tier, then a uniform pick within it.
     *
     * Two passes over `itemTypes` rather than a precomputed table: 12 item types
     * is small, and the alternative is duplicated state that can fall out of
     * sync with the array whenever an item is added.
     */
    function _pickItemType(uint256 seed) internal view returns (uint256) {
        uint256 totalWeight;
        for (uint256 r = 0; r < 5; r++) {
            // A tier with no items must not absorb any probability.
            if (_countOfRarity(Rarity(r)) > 0) totalWeight += rarityWeights[r];
        }
        require(totalWeight > 0, "No items configured");

        uint256 roll = seed % totalWeight;
        uint256 cumulative;
        Rarity chosen = Rarity.Common;
        for (uint256 r = 0; r < 5; r++) {
            if (_countOfRarity(Rarity(r)) == 0) continue;
            cumulative += rarityWeights[r];
            if (roll < cumulative) {
                chosen = Rarity(r);
                break;
            }
        }

        uint256 count = _countOfRarity(chosen);
        // A second, independent slice of the seed so the tier pick does not
        // correlate with the item pick inside it.
        uint256 offset = (seed >> 128) % count;
        for (uint256 i = 0; i < itemTypes.length; i++) {
            if (itemTypes[i].rarity != chosen) continue;
            if (offset == 0) return i;
            offset--;
        }

        revert("Pick failed");
    }

    function _countOfRarity(Rarity rarity) internal view returns (uint256 count) {
        for (uint256 i = 0; i < itemTypes.length; i++) {
            if (itemTypes[i].rarity == rarity) count++;
        }
    }

    /**
     * Owner escape hatch: mint a specific item outright.
     *
     * Kept for seeding demo inventory and for support. `onlyOwner`, so it is not
     * the hole that the old public `mintItem` was.
     */
    function mintItem(address to, uint256 itemTypeIndex) external onlyOwner {
        require(itemTypeIndex < itemTypes.length, "Invalid item type index");
        uint256 tokenId = totalSupply();
        _safeMint(to, tokenId);
        tokenItemType[tokenId] = itemTypeIndex;
        emit ItemMinted(to, tokenId, itemTypeIndex, itemTypes[itemTypeIndex].rarity);
    }

    function getItemType(uint256 index) external view returns (ItemType memory) {
        require(index < itemTypes.length, "Invalid item type index");
        return itemTypes[index];
    }

    function getItemTypeCount() external view returns (uint256) {
        return itemTypes.length;
    }

    function getTokenRarity(uint256 tokenId) external view returns (Rarity) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return itemTypes[tokenItemType[tokenId]].rarity;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return itemTypes[tokenItemType[tokenId]].metadataURI;
    }
}
