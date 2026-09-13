'use client';
import { useState } from 'react';
import Image from 'next/image';
import { motion } from "motion/react";
import { toast } from 'sonner';
import { Items, ListItem, rarityColors, isAuctionListing } from '@/components/utils/Items';
import { listItem, cancelListing, updatePrice, finalizeAuction } from '@/services/marketplace';
import { useNow } from '@/hooks/useNow';
import { formatAuctionEnd, isAuctionEnded } from '@/lib/auction';

interface ItemActionPanelProps {
    activeTab: 'inventory' | 'listings';
    selectedItem: Items | ListItem;
    /** Clears the parent's selection; also used as the success handler. */
    onClose: () => void;
};

/**
 * Owns every write path for a single selected asset — listing, price updates,
 * finalizing and cancelling — so the inventory grid stays presentational.
 */
const ItemActionPanel = ({ activeTab, selectedItem, onClose }: ItemActionPanelProps) => {
    const [listPrice, setListPrice] = useState<string>("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Tracked separately so only the cancel button shows its own pending label
    // while isSubmitting blocks every action in the panel.
    const [isCancelling, setIsCancelling] = useState(false);
    const [asAuction, setAsAuction] = useState(false);
    const [auctionDuration, setAuctionDuration] = useState<string>("3600");

    // Read once per render so every auction label in this pass agrees on "now".
    const nowMs = useNow();

    const handleAction = async () => {
        if (!listPrice || parseFloat(listPrice) <= 0) {
            toast.error("Invalid price");
            return;
        }

        setIsSubmitting(true);
        const toastId = toast.loading("Processing...");
        const priceNum = parseFloat(listPrice);

        let success = false;
        if (activeTab === 'inventory') {
            // Duration is only sent for an auction; the contract rejects a
            // fixed-price listing that carries one, so stale dropdown state
            // cannot silently turn a sale into an auction.
            success = await listItem(
                selectedItem as Items,
                priceNum,
                asAuction,
                asAuction ? parseInt(auctionDuration, 10) : 0,
                toastId as string
            ) as boolean;
        } else {
            success = await updatePrice((selectedItem as ListItem).listingId, priceNum, toastId as string) as boolean;
        }

        if (success) {
            setListPrice("");
            setAsAuction(false);
            onClose();
        }
        setIsSubmitting(false);
    };

    /**
     * Pull a listing back.
     *
     * Fixed-price listings can always be cancelled by the seller. Auctions only
     * while zero bids exist — once a bid escrows Stars against the listing the
     * seller cannot pull the NFT until `finalizeAuction` settles it.
     */
    const handleCancelListing = async (item: ListItem) => {
        setIsSubmitting(true);
        setIsCancelling(true);
        const toastId = toast.loading("Cancelling listing...");
        const success = await cancelListing(item.listingId, toastId as string);
        if (success) onClose();
        setIsCancelling(false);
        setIsSubmitting(false);
    };

    const handleFinalize = async (item: ListItem) => {
        setIsSubmitting(true);
        const toastId = toast.loading("Finalizing auction...");
        const success = await finalizeAuction(item, toastId as string);
        if (success) onClose();
        setIsSubmitting(false);
    };

    const isAuctionView = activeTab === 'listings' && 'listingType' in selectedItem && isAuctionListing(selectedItem as ListItem);

    // A finalized auction has no highest bidder recorded on an inactive
    // listing... in practice finalized auctions leave the board, so a listing
    // shown here with bids still owes its finalize.
    const biddingClosed = isAuctionView && isAuctionEnded((selectedItem as ListItem).endTime, nowMs);
    const auctionHasBids = isAuctionView && (selectedItem as ListItem).winner !== '';

    // The contract only accepts cancelling a bid-less auction, so the button
    // defers to that rather than trying to enumerate the revert states.
    const canCancelAuction = isAuctionView && !auctionHasBids;

    // Why cancel is unavailable right now, for the states where it is worth
    // saying. An empty panel reads as a bug; "finalize it instead" does not.
    const cancelBlockedReason = !isAuctionView || canCancelAuction
        ? null
        : 'Bids are escrowed against this auction — finalize it below instead of cancelling.';

    return (
        <motion.div initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className={`w-full md:w-72 border rounded-xl p-6 flex flex-col gap-4 ${activeTab === 'inventory' ? 'bg-cyan-500/5 border-cyan-500/30' : 'bg-orange-500/5 border-orange-500/30'}`}>
            <h3 className="font-mono text-xs uppercase border-b border-white/10 pb-2">
                {activeTab === 'inventory' ? 'List Asset' : 'Manage Listing'}
            </h3>

            <div className="aspect-square w-24 mx-auto relative bg-black/40 rounded-lg border border-white/5">
                <Image src={selectedItem.image} alt="preview" fill className="object-contain p-2" unoptimized />
            </div>

            <div className="space-y-1 text-center md:text-left">
                <p className="text-white font-black uppercase text-sm">{selectedItem.name}</p>
                <p className="text-[10px] text-white/40 font-mono">ID: {selectedItem.serialNumber}</p>
                <p className="text-[10px] text-white/40 font-mono">Rarity: <b className={`${rarityColors[selectedItem.rarity]}`}>{selectedItem.rarity}</b></p>
            </div>

            <div className="space-y-2">
                <label className="text-[10px] text-white/50 uppercase font-mono mb-1 block">
                    {activeTab === 'inventory'
                        ? (asAuction ? 'Reserve Price (Stars)' : 'Fixed Price (Stars)')
                        : (isAuctionView ? 'Reserve Price' : 'Update Price (Stars)')
                    }
                </label>
                <input
                    type="number"
                    value={listPrice}
                    onChange={(e) => setListPrice(e.target.value)}
                    disabled={isAuctionView}
                    placeholder={'price' in selectedItem ? String(selectedItem.price) : "0.00"}
                    className="w-full bg-black border border-white/20 rounded-lg px-3 py-2 text-white font-mono text-sm outline-hidden focus:border-cyan-500 disabled:opacity-50"
                />

                {isAuctionView && (
                    <div className="space-y-3 pt-2 border-t border-white/5">
                        <label className="text-[10px] text-white/50 uppercase font-mono block">
                            Ascending Auction
                        </label>

                        {(() => {
                            const listing = selectedItem as ListItem;
                            const closed = isAuctionEnded(listing.endTime, nowMs);
                            const { dateStr, timeLeftStr } = formatAuctionEnd(listing.endTime, nowMs);

                            return (
                                <div className="space-y-2">
                                    <div className="bg-black/50 border border-purple-500/30 rounded-lg p-3 space-y-1.5">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] text-gray-400 font-mono uppercase">Closes At:</span>
                                            <span className="text-[10px] text-white font-mono font-bold">{dateStr}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] text-gray-400 font-mono uppercase">Remaining:</span>
                                            <span className={`text-[10px] font-bold font-mono ${timeLeftStr === "Ended" ? 'text-red-500' : 'text-purple-400'}`}>
                                                {timeLeftStr}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center border-t border-white/5 pt-1.5">
                                            <span className="text-[9px] text-gray-400 font-mono uppercase">Highest Bid:</span>
                                            <span className="text-[10px] text-amber-400 font-mono font-bold">
                                                {listing.clearingPrice > 0 ? `${listing.clearingPrice} Stars` : 'None yet'}
                                            </span>
                                        </div>
                                    </div>

                                    {/* A count plus the public leading amount. Bids are
                                        open on-chain — even the seller sees them. */}
                                    <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-lg p-3 space-y-1.5">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] text-cyan-500/60 font-mono uppercase">Bids:</span>
                                            <span className="text-[11px] text-yellow-400 font-mono font-black">
                                                {listing.bidCount > 0 ? listing.bidCount : "No Bids"}
                                            </span>
                                        </div>
                                        {listing.winner !== '' && (
                                            <div className="flex justify-between items-center border-t border-white/5 pt-1.5">
                                                <span className="text-[9px] text-gray-400 font-mono uppercase">Leading:</span>
                                                <span className="text-[10px] text-green-400 font-mono font-black">
                                                    {listing.winner.slice(0, 5)}...{listing.winner.slice(-3)}
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    {closed && listing.winner !== '' && (
                                        <button
                                            disabled={isSubmitting}
                                            onClick={() => handleFinalize(listing)}
                                            className="w-full py-2.5 bg-purple-500 text-black font-black uppercase text-[10px] rounded-lg cursor-pointer hover:bg-purple-400 hover:shadow-[0_0_15px_rgba(168,85,247,0.4)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            {isSubmitting ? "Finalizing..." : "Finalize Auction"}
                                        </button>
                                    )}
                                </div>
                            );
                        })()}

                        <p className="text-[8px] text-orange-400/70 italic mt-1 leading-tight">
                            *Bids are public and escrowed in Stars. Outbid losers are refunded
                            automatically; the winner pays on finalize.
                        </p>
                    </div>
                )}
            </div>

            {activeTab === 'inventory' && (
                <div className="space-y-3 pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-white uppercase font-mono">Ascending Auction</span>
                        <button
                            onClick={() => setAsAuction(!asAuction)}
                            className={`w-10 h-5 rounded-full relative transition-colors ${asAuction ? 'bg-cyan-500' : 'bg-gray-700'}`}
                        >
                            <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${asAuction ? 'left-6' : 'left-1'}`} />
                        </button>
                    </div>

                    {asAuction && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="space-y-2 overflow-hidden">
                            <label className="text-[10px] text-white/50 uppercase font-mono block">Duration</label>
                            <select
                                value={auctionDuration}
                                onChange={(e) => setAuctionDuration(e.target.value)}
                                className="w-full bg-black border border-white/20 rounded-lg px-2 py-1.5 text-[11px] text-white font-mono outline-hidden"
                            >
                                <option value="300">5 Minute</option>
                                <option value="3600">1 Hour</option>
                                <option value="86400">24 Hours</option>
                                <option value="259200">3 Days</option>
                                <option value="604800">7 Days</option>
                            </select>

                            {/* No deposit to set: every bid escrows its full Stars
                                amount, so there is no separate bond. */}
                            <p className="text-[8px] text-white/40 leading-tight">
                                Bidders escrow their full bid in Stars and are refunded
                                automatically when outbid. The first bid must meet your reserve.
                            </p>
                        </motion.div>
                    )}
                </div>
            )}

            <div className="mt-auto space-y-2">
                {/* An auction's reserve is fixed once listed, so the list/update
                    action is dropped entirely for those listings. */}
                {!isAuctionView && (
                    <button
                        disabled={isSubmitting}
                        onClick={handleAction}
                        className={`w-full py-3 font-black uppercase text-xs rounded-lg transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none ${activeTab === 'inventory' ? 'bg-cyan-500 text-black hover:shadow-[0_0_15px_rgba(6,182,212,0.4)]' : 'bg-orange-500 text-black hover:shadow-[0_0_15px_rgba(249,115,22,0.4)]'}`}
                    >
                        {isSubmitting ? "Processing..." : activeTab === 'inventory' ? (asAuction ? "Start Auction" : "Confirm List") : "Update Price"}
                    </button>
                )}

                {/* Both listing kinds can be pulled, but an auction only while no
                    bid escrows Stars against it — handleCancelListing defers to
                    canCancelAuction rather than trying to enumerate the states
                    that would revert. */}
                {activeTab === 'listings' && 'listingId' in selectedItem && (isAuctionView ? canCancelAuction : true) && (
                    <button
                        disabled={isSubmitting}
                        onClick={() => handleCancelListing(selectedItem as ListItem)}
                        className="w-full py-2 bg-red-500/10 text-red-500 border border-red-500/30 font-black uppercase text-[10px] rounded-lg cursor-pointer hover:bg-red-500 hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-red-500/10 disabled:hover:text-red-500"
                    >
                        {isCancelling ? "Cancelling..." : isAuctionView ? "Reclaim Asset" : "Cancel Listing"}
                    </button>
                )}

                {/* The auction is not cancellable and the reason is one the
                    seller can act on. Saying nothing where the button used to
                    be reads as a bug — say why and what comes next. */}
                {cancelBlockedReason && (
                    <p className="text-[8px] text-orange-400/70 font-mono text-center leading-relaxed italic">
                        {cancelBlockedReason}
                    </p>
                )}

                {/* Closed with bids, still owing its finalize. Anyone may run it —
                    seller included — so the button is here and not gated. */}
                {isAuctionView && biddingClosed && auctionHasBids && (
                    <button
                        disabled={isSubmitting}
                        onClick={() => handleFinalize(selectedItem as ListItem)}
                        className="w-full py-2 bg-purple-500/10 text-purple-300 border border-purple-500/30 font-black uppercase text-[10px] rounded-lg cursor-pointer hover:bg-purple-500 hover:text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {isSubmitting ? "Finalizing..." : "Finalize Auction"}
                    </button>
                )}

                {/* Closed with no bids: the NFT can come home straight away. */}
                {isAuctionView && biddingClosed && !auctionHasBids && (
                    <p className="text-[9px] text-white/40 font-mono text-center leading-relaxed">
                        Closed with no bids — reclaim it above.
                    </p>
                )}
                <button onClick={onClose} className="w-full text-gray-500 text-[10px] hover:text-white uppercase font-mono py-1 cursor-pointer transition-colors text-center block">
                    [ Close Preview ]
                </button>
            </div>
        </motion.div>
    );
};

export default ItemActionPanel;
