'use client';
import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import Image from "next/image";
import Pagination from "@mui/material/Pagination";
import { ListItem, rarityBgColors, isAuctionListing } from "@/components/utils/Items";
import { SortKey, SortDir, TypeFilter, compareItems, filterByType, parseSortValue } from "@/components/utils/sortItems";
import { MODAL_OVERLAY, MODAL_PADDING, modalPanel, modalCloseBtn, modalSelect } from "@/lib/ui-tokens";
import { isAuctionEnded } from "@/lib/auction";
import { getMarketplaceBadge } from "@/lib/marketplace-badges";
import { useNow } from "@/hooks/useNow";
import SkeletonBar from "@/components/ui/SkeletonBar";
import MarketplaceItemPanel from "@/components/ui/MarketplaceItemPanel";
import { useModalA11y } from "@/hooks/useModalA11y";

interface MarketplaceModalProps {
    isOpen: boolean;
    onClose: () => void;
    allListing: ListItem[];
    isLoading: boolean;
};

const MarketplaceModal = ({ isOpen, onClose, allListing, isLoading }: MarketplaceModalProps) => (
    <AnimatePresence>
        {isOpen && (
            <MarketplaceModalContent onClose={onClose} allListing={allListing} isLoading={isLoading} />
        )}
    </AnimatePresence>
);

const MarketplaceModalContent = ({ onClose, allListing, isLoading }: Omit<MarketplaceModalProps, 'isOpen'>) => {
    const [selectedItem, setSelectedItem] = useState<ListItem | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [sortKey, setSortKey] = useState<SortKey>('rarity');
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
    const itemsPerPage = 8;

    // Read once per render so every auction label in this pass agrees on "now".
    const nowMs = useNow();

    const filteredListings = useMemo(() => {
        if (!allListing || !Array.isArray(allListing)) return [];
        return filterByType(allListing, typeFilter);
    }, [allListing, typeFilter]);

    const totalPages = Math.ceil(filteredListings.length / itemsPerPage);

    const paginatedListing = useMemo(() => {
        const sortedData = [...filteredListings].sort(compareItems(sortKey, sortDir));
        const startIndex = (currentPage - 1) * itemsPerPage;
        return sortedData.slice(startIndex, startIndex + itemsPerPage);
    }, [filteredListings, currentPage, sortKey, sortDir]);

    const dismiss = useCallback(() => {
        setSelectedItem(null);
        onClose();
    }, [onClose]);

    const panelRef = useModalA11y<HTMLDivElement>(dismiss);

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className={MODAL_OVERLAY}
            onClick={dismiss}
        >
            <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="marketplace-title"
                tabIndex={-1}
                initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                className={`${modalPanel('amber', '2xl')} ${MODAL_PADDING} flex flex-col md:flex-row gap-4 md:gap-6`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Main Grid Area */}
                <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
                    <div className="flex justify-between items-start gap-3 mb-4 sm:mb-6 border-b border-amber-950 pb-3 sm:pb-4">
                        <div className="min-w-0">
                            <h2 id="marketplace-title" className="text-lg sm:text-xl md:text-2xl font-black text-amber-500 tracking-tighter uppercase italic">Global Marketplace</h2>
                            <p className="text-[10px] text-amber-500/50 font-mono uppercase tracking-widest">Pixelorbit Decentralized Exchange</p>
                        </div>
                        <button onClick={dismiss} className={modalCloseBtn('amber')}>[X]</button>
                    </div>
                    <div className="flex justify-end gap-2 mb-4 sm:mb-6 -mt-2">
                        <select
                            aria-label="Filter by listing type"
                            value={typeFilter}
                            onChange={(e) => {
                                setTypeFilter(e.target.value as TypeFilter);
                                setCurrentPage(1);
                            }}
                            className={modalSelect('amber')}
                        >
                            <option value="all">All Types</option>
                            <option value="auction">Auctions Only</option>
                            <option value="fixed">Fixed Price Only</option>
                        </select>
                        <select
                            aria-label="Sort listings"
                            value={`${sortKey}-${sortDir}`}
                            onChange={(e) => {
                                const { key, dir } = parseSortValue(e.target.value);
                                setSortKey(key);
                                setSortDir(dir);
                                setCurrentPage(1);
                            }}
                            className={modalSelect('amber')}
                        >
                            <option value="rarity-asc">Rarity: Best First</option>
                            <option value="rarity-desc">Rarity: Common First</option>
                            <option value="name-asc">Name: A → Z</option>
                            <option value="name-desc">Name: Z → A</option>
                            <option value="price-asc">Price: Low → High</option>
                            <option value="price-desc">Price: High → Low</option>
                        </select>
                    </div>

                    {isLoading ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 overflow-y-auto pr-2 custom-scrollbar flex-1 min-h-0">
                            {Array.from({ length: 8 }).map((_, idx) => (
                                <div key={idx} className="bg-white/5 rounded-xl p-3 border border-white/10 flex flex-col gap-2">
                                    <SkeletonBar className="aspect-square w-full rounded-lg" />
                                    <SkeletonBar className="h-3 w-3/4 mx-auto rounded" />
                                    <SkeletonBar className="h-3 w-1/2 mx-auto rounded" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4 overflow-y-auto pr-2 custom-scrollbar flex-1 min-h-0 content-start">
                                {paginatedListing.map((item, idx) => {
                                    const isAuction = isAuctionListing(item);
                                    const closed = isAuction && isAuctionEnded(item.endTime, nowMs);
                                    // The board only holds active listings, so a
                                    // non-empty winner means "has bids", not "sold".
                                    const hasBids = isAuction && item.winner !== '';
                                    const { text: badgeText, className: badgeClass } = getMarketplaceBadge({ isAuction, closed, hasBids });
                                    return (
                                        <div
                                            key={idx}
                                            onClick={() => setSelectedItem(item)}
                                            className={`bg-white/5 rounded-xl p-3 border transition-all cursor-pointer flex flex-col gap-2 ${selectedItem?.serialNumber === item.serialNumber ? 'border-amber-500 bg-amber-500/10' : 'border-white/10 hover:border-amber-500/40'}`}
                                        >
                                            <div className="relative aspect-square w-full rounded-xl border border-white/10 bg-white/5 flex items-center justify-center p-2">
                                                <Image src={item.image} alt={item.name} fill className={`object-contain p-2 ${closed ? 'opacity-40' : ''}`} unoptimized />
                                                <div className={`absolute bottom-0 left-0 right-0 ${rarityBgColors[item.rarity] || 'bg-gray-500'} text-[7px] text-black font-black text-center uppercase`}>
                                                    {item.rarity}
                                                </div>
                                                <div className={`absolute top-1 left-1 ${badgeClass} text-[8px] px-1.5 py-0.5 rounded text-white font-black uppercase tracking-tighter`}>
                                                    {badgeText}
                                                </div>
                                            </div>
                                            <div className="text-center">
                                                <h4 className="text-white font-bold uppercase text-[10px] truncate">{item.name}</h4>
                                                {/* An open auction shows the current highest bid
                                                    once bidding starts, and the reserve before
                                                    that. Everything is on-chain and public. */}
                                                <p className="text-amber-400 font-mono font-bold text-xs">
                                                    {isAuction && item.clearingPrice > 0 ? item.clearingPrice : item.price} Stars
                                                </p>
                                                {isAuction && !closed && (
                                                    <p className="text-[8px] text-white/40 font-mono uppercase">
                                                        {item.bidCount > 0 ? `${item.bidCount} bid${item.bidCount > 1 ? 's' : ''}` : 'reserve · no bids yet'}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="flex justify-center mt-4 pt-3 border-t border-amber-950/50 shrink-0">
                                <Pagination
                                    count={totalPages}
                                    page={currentPage}
                                    onChange={(_, p) => setCurrentPage(p)}
                                    size="small"
                                    sx={{
                                        '& .MuiPaginationItem-root': {
                                            color: '#f59e0b',
                                            fontFamily: 'monospace',
                                            fontSize: '0.75rem',
                                            borderColor: 'rgba(245, 158, 11, 0.3)'
                                        },
                                        '& .Mui-selected': {
                                            backgroundColor: 'rgba(245, 158, 11, 0.2) !important',
                                            color: 'white !important',
                                            fontWeight: 'bold'
                                        }
                                    }}
                                />
                            </div>
                        </>
                    )}
                </div>

                <AnimatePresence mode="wait">
                    {selectedItem && (
                        <div className="shrink-0 md:shrink max-h-[40vh] md:max-h-[calc(100vh-10rem)] overflow-y-auto custom-scrollbar">
                            <MarketplaceItemPanel
                                key={selectedItem.listingId}
                                selectedItem={selectedItem}
                                onClose={() => setSelectedItem(null)}
                                nowMs={nowMs}
                            />
                        </div>
                    )}
                </AnimatePresence>
            </motion.div>
        </motion.div>
    );
};

export default MarketplaceModal;
