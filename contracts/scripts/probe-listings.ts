import { createPublicClient, http } from "viem";

/**
 * Read the live listing table without Hardhat, straight off the public RPC.
 *
 * The ABI is inlined rather than imported so this stays runnable against a
 * deployed marketplace whose fields have since changed in the source tree —
 * which is exactly when you reach for it. Keep the tuple in the same order as
 * `PixelOrbitMarketplace.Listing`: viem decodes tuples positionally, so a
 * reordered field silently shifts every value after it.
 */
const RPC = "https://rpc.cc3-testnet.creditcoin.network";
const MARKET = process.env.MARKETPLACE_ADDR as `0x${string}`;

const ABI = [
  { type: "function", name: "getListingCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getListing", inputs: [{ type: "uint256" }], outputs: [{ type: "tuple", components: [
      { name: "seller", type: "address" }, { name: "nftContract", type: "address" },
      { name: "tokenId", type: "uint256" }, { name: "price", type: "uint256" },
      { name: "listingType", type: "uint8" }, { name: "isActive", type: "bool" },
      { name: "auctionEndTime", type: "uint256" }, { name: "highestBidder", type: "address" },
      { name: "highestBid", type: "uint256" }]}],
    stateMutability: "view" },
] as const;

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  const block = await client.getBlockNumber();
  const count = await client.readContract({ address: MARKET, abi: ABI, functionName: "getListingCount" });
  console.log(`block=${block} listingCount=${count}`);
  for (let i = 0n; i < count; i++) {
    const l = await client.readContract({ address: MARKET, abi: ABI, functionName: "getListing", args: [i] });
    const kind = l.listingType === 0 ? "fixed" : "ascending";
    console.log(`#${i} active=${l.isActive} type=${kind} token=${l.tokenId} end=${l.auctionEndTime} seller=${l.seller.slice(0, 8)}`);
    // Bids are transparent on ascending auctions: the highest bid is right
    // there on the listing, no settlement needed to read it.
    if (l.highestBidder !== "0x0000000000000000000000000000000000000000") {
      console.log(`    highestBidder=${l.highestBidder.slice(0, 8)} highestBid=${l.highestBid}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
