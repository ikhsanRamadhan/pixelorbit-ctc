'use client';
import { useState, useMemo, useCallback, useEffect } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from "motion/react";
import Pagination from '@mui/material/Pagination';
import { Items, ListItem, rarityColors, isAuctionListing } from '@/components/utils/Items';
import { SortKey, SortDir, Sortable, compareItems, parseSortValue } from '@/components/utils/sortItems';
import ItemActionPanel from '@/components/ui/ItemActionPanel';
import MarketplaceItemPanel from '@/components/ui/MarketplaceItemPanel';
import { useModalA11y } from '@/hooks/useModalA11y';
import { useWalletStore } from '@/stores/wallet-store';
import { useNow } from '@/hooks/useNow';
import { MODAL_OVERLAY, MODAL_PADDING, modalPanel, modalCloseBtn, modalSelect } from '@/lib/ui-tokens';
import { fetchUserBids, type UserBid } from '@/services/user-bids';

interface InventoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Owned assets not currently escrowed by the marketplace. */
    unlistedItems: Items[];
    userListings: ListItem[];
};

const InventoryModal = ({ isOpen, onClose, unlistedItems, userListings }: InventoryModalProps) => (
    <AnimatePresence>
        {isOpen && (
            <InventoryModalContent
                onClose={onClose}
                unlistedItems={unlistedItems}
                userListings={userListings}
            />
        )}
    </AnimatePresence>
);

type InventoryTab = 'inventory' | 'listings' | 'bids';

/** How each bid outcome reads in the grid: label, colour, and whether it still needs the user. */
const OUTCOME_BADGE: Record<UserBid['outcome'], { label: string; className: string; actionable: boolean }> = {
    'pending': { label: 'Outbid', className: 'bg-blue-600', actionable: false },
    'leading': { label: 'Leading', className: 'bg-green-600', actionable: false },
    'awaiting-settlement': { label: 'Awaiting', className: 'bg-purple-600', actionable: false },
    'won-paid': { label: 'Won', className: 'bg-green-600', actionable: false },
    'lost-settled': { label: 'Lost', className: 'bg-gray-700', actionable: false },
};

const InventoryModalContent = ({ onClose, unlistedItems, userListings }: Omit<InventoryModalProps, 'isOpen'>) => {
    const [activeTab, setActiveTab] = useState<InventoryTab>('inventory');
    const [selectedItem, setSelectedItem] = useState<Items | ListItem | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [sortKey, setSortKey] = useState<SortKey>('rarity');
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [bidState, setBidState] = useState<{ bids: UserBid[]; loading: boolean }>({
        bids: [],
        loading: true,
    });
    const itemsPerPage = 8;

    const { accountId } = useWalletStore();
    // Shared "now" so the bid panel's countdown agrees with the grid's badges.
    const nowMs = useNow();

    // Bid history is not in the game store — it comes from the explorer, which is
    // too slow to sit in the 15s polling batch. Loaded once per wallet here so the
    // badge can speak for the buyer side too, not just the listings the store has.
    // Keyed by the address they were fetched for, so a wallet switch invalidates
    // them by comparison rather than by an eager reset — clearing state up front
    // would just be a second render on every reconnect.
    const [reloadKey, setReloadKey] = useState(0);

    // Loaded on open, not on tab switch: the badge has to be able to say "you
    // have money to claim" before the user thinks to look in the tab.
    useEffect(() => {
        if (!accountId) return;
        let cancelled = false;
        fetchUserBids(accountId as `0x${string}`)
            .then((bids) => { if (!cancelled) setBidState({ bids, loading: false }); })
            .catch(() => { if (!cancelled) setBidState({ bids: [], loading: false }); });
        return () => { cancelled = true; };
    }, [accountId, reloadKey]);

    const actionableBidCount = useMemo(
        () => bidState.bids.filter((b) => OUTCOME_BADGE[b.outcome].actionable).length,
        [bidState.bids],
    );

    const displayItems = useMemo(() => {
        if (activeTab === 'bids') return bidState.bids;
        const targetArray: Sortable[] = activeTab === 'inventory' ? unlistedItems : userListings;
        return [...targetArray].sort(compareItems(sortKey, sortDir));
    }, [unlistedItems, userListings, bidState.bids, activeTab, sortKey, sortDir]);

    const paginatedItems = useMemo(() => {
        const startIndex = (currentPage - 1) * itemsPerPage;
        return displayItems.slice(startIndex, startIndex + itemsPerPage);
    }, [displayItems, currentPage]);

    const totalPages = Math.ceil(displayItems.length / itemsPerPage);

    const switchTab = (tab: InventoryTab) => {
        setActiveTab(tab);
        setCurrentPage(1);
        setSelectedItem(null);
    };

    // The item panel is a nested layer inside this dialog, so while one is open
    // Escape and the backdrop should dismiss that, not the whole inventory.
    const requestClose = useCallback(() => {
        if (selectedItem) {
            setSelectedItem(null);
            return;
        }
        onClose();
    }, [selectedItem, onClose]);

    const panelRef = useModalA11y<HTMLDivElement>(requestClose);

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={MODAL_OVERLAY} onClick={requestClose}>
            <motion.div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="inventory-title" tabIndex={-1} initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }} className={`${modalPanel('cyan', '2xl')} ${MODAL_PADDING} flex flex-col md:flex-row gap-4 md:gap-6`} onClick={(e) => e.stopPropagation()}>

                <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
                    <div className="flex justify-between items-start gap-3 mb-4 sm:mb-6 border-b border-cyan-950 pb-3 sm:pb-4">
                        <div className="flex flex-wrap gap-3 sm:gap-6">
                            <button onClick={() => switchTab('inventory')} className={`text-base sm:text-xl font-black tracking-tighter uppercase italic transition-all cursor-pointer ${activeTab === 'inventory' ? 'text-cyan-400' : 'text-gray-600 hover:text-cyan-800'}`} id="inventory-title">Inventory</button>
                            <button onClick={() => switchTab('listings')} className={`text-base sm:text-xl font-black tracking-tighter uppercase italic transition-all cursor-pointer ${activeTab === 'listings' ? 'text-orange-400' : 'text-gray-600 hover:text-orange-800'}`}>My Listings</button>
                            <button onClick={() => switchTab('bids')} className={`text-base sm:text-xl font-black tracking-tighter uppercase italic transition-all cursor-pointer relative ${activeTab === 'bids' ? 'text-blue-400' : 'text-gray-600 hover:text-blue-800'}`}>
                                My Bids
                                {/* Only the count that needs them — an open bid
                                    is not a to-do, a closable auction is. */}
                                {actionableBidCount > 0 && (
                                    <span className="absolute -top-1 -right-3 bg-amber-500 text-black text-[8px] font-black rounded-full w-4 h-4 flex items-center justify-center">
                                        {actionableBidCount}
                                    </span>
                                )}
                            </button>
                        </div>
                        <button onClick={onClose} className={modalCloseBtn('cyan')}>[X]</button>
                    </div>
                    {/* The bids tab arrives pre-sorted — claimable first, then newest
                        — so offering rarity/name sorting there would be a control
                        that silently does nothing. */}
                    {activeTab !== 'bids' && (
                        <div className="flex justify-end mb-4 sm:mb-6 -mt-2">
                            <select
                                aria-label="Sort items"
                                value={`${sortKey}-${sortDir}`}
                                onChange={(e) => {
                                    const { key, dir } = parseSortValue(e.target.value);
                                    setSortKey(key);
                                    setSortDir(dir);
                                    setCurrentPage(1);
                                }}
                                className={modalSelect('cyan')}
                            >
                                <option value="rarity-asc">Rarity: Best First</option>
                                <option value="rarity-desc">Rarity: Common First</option>
                                <option value="name-asc">Name: A → Z</option>
                                <option value="name-desc">Name: Z → A</option>
                            </select>
                        </div>
                    )}

                    {/* An empty grid while the explorer is still answering would read
                        as "you have never bid", which is the one thing the service
                        goes out of its way not to claim. */}
                    {activeTab === 'bids' && bidState.loading && bidState.bids.length === 0 && (
                        <p className="text-[10px] text-blue-400/60 font-mono uppercase text-center py-8">
                            Loading bid history...
                        </p>
                    )}

                    {activeTab === 'bids' && !bidState.loading && bidState.bids.length === 0 && (
                        <p className="text-[10px] text-gray-600 font-mono uppercase text-center py-8">
                            You have not bid on any auction yet
                        </p>
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4 overflow-y-auto pr-2 custom-scrollbar flex-1 min-h-0 content-start">
                        {paginatedItems.map((item, idx) => {
                            const isAuction = 'listingType' in item && isAuctionListing(item as ListItem);
                            // In the bids tab the outcome is the story, so it replaces
                            // the listing-kind badge — every row there is an auction.
                            const bidBadge = activeTab === 'bids' ? OUTCOME_BADGE[(item as UserBid).outcome] : null;
                            const badgeClass = bidBadge ? bidBadge.className : isAuction ? 'bg-blue-600' : 'bg-red-600';
                            const badgeText = bidBadge ? bidBadge.label : isAuction ? 'Auction' : 'Fixed';
                            const showBadge = activeTab !== 'inventory';
                            return (
                                <div key={idx} onClick={() => setSelectedItem(item)} className={`flex flex-col items-center gap-2 p-2 rounded-xl border transition-all cursor-pointer ${selectedItem?.serialNumber === item.serialNumber ? 'bg-cyan-500/10 border-cyan-500' : 'border-transparent hover:bg-white/5'}`}>
                                    <div className="relative aspect-square w-full rounded-xl border border-white/10 bg-white/5 flex items-center justify-center p-2">
                                        <Image src={item.image} alt="item" fill className="object-contain" unoptimized />
                                        {showBadge && (
                                            <div className={`absolute top-1 left-1 ${badgeClass} text-[8px] px-1.5 py-0.5 rounded text-white font-black uppercase tracking-tighter`}>
                                                {badgeText}
                                            </div>
                                        )}
                                    </div>
                                    <div className="text-center">
                                        <p className="text-[9px] text-white font-bold uppercase w-24">{item.name}</p>
                                        <p className={`text-[8px] font-mono font-bold ${rarityColors[item.rarity] || 'text-cyan-500'}`}>{item.rarity}</p>
                                        {showBadge && 'price' in item && (
                                            <p className="text-[10px] font-mono text-yellow-500 mt-0.5">
                                                {activeTab === 'bids' && (item as UserBid).clearingPrice > 0
                                                    ? `${(item as UserBid).clearingPrice} Stars`
                                                    : `${item.price} Stars`}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="flex justify-center mt-4 pt-3 border-t border-cyan-950 shrink-0">
                        <Pagination count={totalPages} page={currentPage} onChange={(_, p) => setCurrentPage(p)} size="small" sx={{ '& .MuiPaginationItem-root': { color: 'white' }}} />
                    </div>
                </div>

                {selectedItem && (
                    <div className="shrink-0 md:shrink max-h-[40vh] md:max-h-[calc(100vh-10rem)] overflow-y-auto custom-scrollbar">
                        {/* The bids tab reuses the marketplace panel, which already
                            owns the bid and finalize writes for ascending
                            auctions — payouts and refunds happen inside the
                            finalize call, so there is no second flow to grow. */}
                        {activeTab === 'bids' ? (
                            <MarketplaceItemPanel
                                selectedItem={selectedItem as ListItem}
                                onClose={() => {
                                    setSelectedItem(null);
                                    setReloadKey((k) => k + 1);
                                }}
                                nowMs={nowMs}
                            />
                        ) : (
                            <ItemActionPanel
                                activeTab={activeTab as 'inventory' | 'listings'}
                                selectedItem={selectedItem}
                                onClose={() => setSelectedItem(null)}
                            />
                        )}
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
};

export default InventoryModal;
