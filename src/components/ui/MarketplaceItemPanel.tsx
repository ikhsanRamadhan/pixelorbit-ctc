'use client';
import { useEffect, useState } from "react";
import Image from "next/image";
import { motion } from "motion/react";
import { toast } from 'sonner';
import { rarityColors, ListItem, isFixedPriceListing, isAuctionListing } from "@/components/utils/Items";
import { useWalletStore } from "@/stores/wallet-store";
import { buyItemListing, placeBid, finalizeAuction } from "@/services/marketplace";
import { isAuctionEnded, formatAuctionEnd } from "@/lib/auction";

interface MarketplaceItemPanelProps {
    selectedItem: ListItem;
    /** Clears the parent's selection; also the success handler for every write. */
    onClose: () => void;
    /** Shared "now" so this panel's labels agree with the grid's. */
    nowMs: number;
};

/**
 * Owns the buy / open-bid / finalize writes for one listing, so the overlay
 * grid stays presentational.
 *
 * An ascending auction moves through three states here and each shows a
 * different action: open (place an open bid), closed but not yet finalized
 * (anyone finalizes), and finalized (nothing left to do — payout and refunds
 * happened inside the finalize call).
 */
const MarketplaceItemPanel = ({ selectedItem, onClose, nowMs }: MarketplaceItemPanelProps) => {
    const { accountId } = useWalletStore();
    const [bidAmount, setBidAmount] = useState<string>("");
    const [loadingTransaction, setLoadingTransaction] = useState(false);

    const isFixedPrice = isFixedPriceListing(selectedItem);
    const isAuction = isAuctionListing(selectedItem);
    const biddingClosed = isAuction && isAuctionEnded(selectedItem.endTime, nowMs);
    const isSeller = selectedItem.seller.toLowerCase() === accountId?.toLowerCase();

    // Finalized auctions leave the board, but the bids tab reads them by id —
    // the winner field is how those rows are recognised here.
    const isFinalized = !selectedItem.isActive;
    const hasBids = selectedItem.winner !== '';
    const isWinner = hasBids && selectedItem.winner.toLowerCase() === accountId?.toLowerCase();
    const isLeading = hasBids && !isFinalized && selectedItem.winner.toLowerCase() === accountId?.toLowerCase();

    const canBid = isAuction && !biddingClosed && !isFinalized && !isSeller;
    // Anyone may finalize: the outcome is fully determined by on-chain bids,
    // so the caller pays the gas but cannot bend the result.
    const canFinalize = isAuction && biddingClosed && !isFinalized;

    // Seed the input at the smallest acceptable bid: the reserve before the
    // first bid, the current highest bid once bidding has started. The
    // contract demands strictly more than the highest bid, so the hint says
    // exactly that — a pre-filled value that would revert is a trap.
    useEffect(() => {
        setBidAmount(selectedItem.clearingPrice > 0
            ? selectedItem.clearingPrice.toFixed(2)
            : selectedItem.price.toFixed(2));
    }, [selectedItem]);

    const handleBuy = async (item: ListItem) => {
        if (!accountId) {
            toast.error("Please connect your wallet first");
            return;
        }

        const toastId = toast.loading("Preparing transaction...");
        setLoadingTransaction(true);

        try {
            const success = await buyItemListing(item, toastId as string);
            if (success) onClose();
        } catch (error) {
            console.error(error);
            toast.error("Transaction failed!", { id: toastId });
        } finally {
            setLoadingTransaction(false);
        }
    };

    const handlePlaceBid = async (item: ListItem) => {
        if (!accountId) {
            toast.error("Please connect your wallet first");
            return;
        }

        const toastId = toast.loading("Preparing bid...");
        setLoadingTransaction(true);

        try {
            const amount = parseFloat(bidAmount);
            if (isNaN(amount)) {
                toast.error('Enter a bid amount', { id: toastId });
                return;
            }
            if (item.clearingPrice > 0 && amount <= item.clearingPrice) {
                toast.error(`Bid must exceed the ${item.clearingPrice} Stars highest bid`, { id: toastId });
                return;
            }
            if (item.clearingPrice === 0 && amount < item.price) {
                toast.error(`Bid must be at least the ${item.price} Stars reserve`, { id: toastId });
                return;
            }

            const success = await placeBid(item, amount, toastId as string);
            if (success) onClose();
        } catch (error) {
            console.error(error);
            toast.error("Transaction failed!", { id: toastId });
        } finally {
            setLoadingTransaction(false);
        }
    };

    /** Wrap a one-argument write so every button shares the same pending/close flow. */
    const runWrite = async (
        label: string,
        write: (toastId: string) => Promise<boolean>,
    ) => {
        setLoadingTransaction(true);
        const toastId = toast.loading(label);
        try {
            const success = await write(toastId as string);
            if (success) onClose();
        } catch (error) {
            console.error(error);
            toast.error("Transaction failed!", { id: toastId });
        } finally {
            setLoadingTransaction(false);
        }
    };

    return (
        <motion.div
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="w-full md:w-80 bg-amber-500/5 border border-amber-500/30 rounded-xl p-6 flex flex-col gap-4 h-fit"
        >
            <h3 className="font-mono text-[10px] text-amber-500 uppercase border-b border-amber-500/20 pb-2">Item Details</h3>

            <div className="aspect-square w-32 mx-auto relative bg-black/40 rounded-lg border border-amber-500/20">
                <Image src={selectedItem.image} alt="preview" fill className="object-contain p-3" unoptimized />
            </div>

            <div className="text-center space-y-1">
                <p className="text-white font-black uppercase text-base">{selectedItem.name}</p>
                <p className="text-[10px] text-amber-500/50 font-mono">SERIAL: #{selectedItem.serialNumber}</p>
                <div className={`text-[9px] font-bold px-2 py-0.5 rounded-full inline-block bg-white/5 ${rarityColors[selectedItem.rarity]}`}>
                    {selectedItem.rarity}
                </div>
            </div>

            <div className="bg-black/40 p-4 rounded-lg border border-white/5 space-y-3">
                <div className="flex justify-between items-center">
                    <span className="text-[9px] text-gray-500 uppercase font-mono">
                        {isFinalized || hasBids ? 'Highest Bid' : isAuction ? 'Reserve' : 'Price'}
                    </span>
                    <span className="text-sm font-black text-white font-mono">
                        {hasBids ? selectedItem.clearingPrice : selectedItem.price} Stars
                    </span>
                </div>

                {/* A count plus the public leading amount. Every bid is an
                    on-chain event, so there is nothing hidden to protect. */}
                {isAuction && (
                    <div className="flex justify-between items-center">
                        <span className="text-[9px] text-gray-500 uppercase font-mono">Bids</span>
                        <span className="text-sm font-black text-white font-mono">
                            {selectedItem.bidCount > 0 ? selectedItem.bidCount : 'None yet'}
                        </span>
                    </div>
                )}

                {hasBids && (
                    <div className="flex justify-between items-center">
                        <span className="text-[9px] text-gray-500 uppercase font-mono">
                            {isFinalized ? 'Winner' : 'Leading'}
                        </span>
                        <span className="text-sm font-black text-white font-mono">
                            {isWinner || isLeading ? 'You' : `${selectedItem.winner.slice(0, 5)}...${selectedItem.winner.slice(-3)}`}
                        </span>
                    </div>
                )}

                {isAuction && !isFinalized && selectedItem.endTime > 0 && (() => {
                    const { dateStr, timeLeftStr } = formatAuctionEnd(selectedItem.endTime, nowMs);
                    return (
                        <div className="flex justify-between items-center">
                            <span className="text-[9px] text-gray-500 uppercase font-mono">Bidding Closes</span>
                            <span className="text-right">
                                <span className="block text-[10px] font-mono text-white">{dateStr}</span>
                                <span className={`block text-[9px] font-black uppercase ${biddingClosed ? 'text-red-500' : 'text-amber-500'}`}>
                                    {timeLeftStr}
                                </span>
                            </span>
                        </div>
                    );
                })()}
            </div>

            {/* ============== BUY NOW (Fixed Price primary) ============== */}
            {isFixedPrice && !isFinalized && (
                <button
                    disabled={isSeller || loadingTransaction}
                    onClick={() => handleBuy(selectedItem)}
                    className={`w-full py-3 rounded font-black uppercase text-xs tracking-widest transition-all
                        ${isSeller || loadingTransaction
                            ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                            : 'bg-amber-600 hover:bg-amber-500 text-black shadow-lg shadow-amber-900/40 active:scale-95 cursor-pointer'
                        }`}
                >
                    {loadingTransaction ? 'Processing...' :
                        isSeller ? 'Your Asset' : 'Buy Now'}
                </button>
            )}

            {/* ============== PLACE AN OPEN BID (auction still open) ============== */}
            {canBid && (
                <>
                    <div className="space-y-2 pt-2 border-t border-white/5">
                        <label className="text-[9px] text-amber-500 uppercase font-black block">Your Bid (Stars)</label>
                        <input
                            type="number"
                            value={bidAmount}
                            onChange={(e) => setBidAmount(e.target.value)}
                            className="w-full bg-black border border-amber-500/30 rounded px-3 py-2 text-white font-mono text-sm outline-none focus:border-amber-500 shadow-inner"
                        />
                        {/* The rule that decides whether the transaction reverts,
                            stated before the button: first bid meets the reserve,
                            every later bid beats the highest. Your full bid is
                            escrowed; outbid and it comes straight back. */}
                        <p className="text-[8px] text-gray-400 leading-relaxed">
                            {hasBids
                                ? `Open auction. Bid more than ${selectedItem.clearingPrice} Stars to take the lead.`
                                : `Open auction. First bid must meet the ${selectedItem.price} Stars reserve.`}
                        </p>
                        {isLeading && (
                            <p className="text-[8px] text-green-400 leading-relaxed">
                                You lead this auction. Bid again to raise your own bid.
                            </p>
                        )}
                    </div>
                    <button
                        disabled={loadingTransaction}
                        onClick={() => handlePlaceBid(selectedItem)}
                        className={`w-full py-3 rounded font-black uppercase text-xs tracking-widest transition-all
                            ${loadingTransaction
                                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40 active:scale-95 cursor-pointer'
                            }`}
                    >
                        {loadingTransaction ? 'Processing...' : hasBids ? 'Place Higher Bid' : 'Place Bid'}
                    </button>
                </>
            )}

            {/* ============== FINALIZE (closed, outcome not yet on-chain) ============== */}
            {canFinalize && (
                <>
                    <button
                        disabled={loadingTransaction}
                        onClick={() => runWrite('Finalizing auction...', (id) => finalizeAuction(selectedItem, id))}
                        className={`w-full py-3 rounded font-black uppercase text-xs tracking-widest transition-all
                            ${loadingTransaction
                                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                                : 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/40 active:scale-95 cursor-pointer'
                            }`}
                    >
                        {loadingTransaction ? 'Finalizing...' : 'Finalize Auction'}
                    </button>
                    <p className="text-[8px] text-gray-500 leading-relaxed text-center">
                        {hasBids
                            ? 'Sends the NFT to the highest bidder and the Stars to the seller. Anyone can run it.'
                            : 'No bids came in — finalizing returns the NFT to the seller.'}
                    </p>
                </>
            )}

            {isAuction && biddingClosed && !isFinalized && !hasBids && selectedItem.bidCount === 0 && (
                <p className="text-[9px] text-gray-500 uppercase font-mono text-center py-2">
                    Closed with no bids
                </p>
            )}

            {/* ============== FINALIZED (history rows from the bids tab) ==============
                Nothing left to do: the finalize paid the seller, delivered the
                NFT, and refunded every outbid automatically. */}
            {isFinalized && (
                <p className="text-[9px] text-gray-400 font-mono text-center leading-relaxed py-2">
                    {isWinner
                        ? `Won for ${selectedItem.clearingPrice} Stars. The NFT is yours.`
                        : hasBids
                            ? 'Settled. Your outbid Stars were refunded automatically.'
                            : 'Closed with no bids. The NFT returned to the seller.'}
                </p>
            )}

            <button onClick={onClose} className="text-[9px] text-gray-600 hover:text-white uppercase font-mono transition-colors text-center cursor-pointer">
                [ Cancel Selection ]
            </button>
        </motion.div>
    );
};

export default MarketplaceItemPanel;
