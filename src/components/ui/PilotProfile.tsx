'use client';
import { useState, useMemo, useEffect } from 'react';
import Image from 'next/image';
import { MySpaceships } from '@/components/utils/Spaceships';
import { useWalletStore } from '@/stores/wallet-store';
import { rarityBgColors, rarityOrder } from '@/components/utils/Items';
import { toast } from 'sonner';
import { usePilotProfile } from '@/hooks/usePilotProfile';
import SkeletonBar from '@/components/ui/SkeletonBar';
import InventoryModal from '@/components/ui/InventoryModal';
import AssetDashboardModal from '@/components/ui/AssetDashboardModal';
import BridgeModal from '@/components/ui/BridgeModal';
import { useNow } from '@/hooks/useNow';
import { fetchUserBids, type UserBid } from '@/services/user-bids';
import { fetchAttestedTier } from '@/services/leaderboard';
import { topAssetAlert } from '@/lib/asset-alerts';

/** Module-level so the alert memo sees a stable reference while bids are absent. */
const EMPTY_BIDS: UserBid[] = [];

interface PilotProfileProps {
    spaceships: MySpaceships[];
    profileData: {
        highScore: number;
        highScoreShipName: string | null;
        shipsCount: number;
        itemsCount: number;
    };
};

const PilotProfile = ({ spaceships, profileData }: PilotProfileProps) => {
    const { accountId, tctcBalance, starsBalance, sepoliaStarsBalance } = useWalletStore();
    const { mySpaceships, userHighscores, ownedItems, userListings, isLoading, isFleetLoading } = usePilotProfile();
    const [isInventoryOpen, setIsInventoryOpen] = useState(false);
    const [isDashboardOpen, setIsDashboardOpen] = useState(false);
    const [isBridgeOpen, setIsBridgeOpen] = useState(false);
    // The ASC marks bridged players attested. Keyed by the address it was
    // fetched for, so a wallet switch invalidates by comparison rather than by
    // an eager reset — same pattern as the bid history below. Null while the
    // read is in flight: the badge stays hidden rather than assert either way.
    const [attestedFor, setAttestedFor] = useState<{ address: string; value: boolean } | null>(null);
    const isAttested =
        attestedFor && accountId && attestedFor.address === accountId ? attestedFor.value : null;

    useEffect(() => {
        if (!accountId) return;
        let cancelled = false;
        fetchAttestedTier(accountId as `0x${string}`)
            .then((value) => { if (!cancelled) setAttestedFor({ address: accountId, value }); })
            .catch(() => { if (!cancelled) setAttestedFor({ address: accountId, value: false }); });
        return () => { cancelled = true; };
    }, [accountId]);

    const highScoreShip = useMemo(() => {
        return spaceships.find(ship => ship.name === profileData.highScoreShipName) || spaceships[0];
    }, [spaceships, profileData.highScoreShipName]);

    // The marketplace escrows the NFT while it is listed, so ownedItems and
    // userListings never overlap; the filter guards against a stale snapshot.
    const unlistedItems = useMemo(() => {
        const listedIds = new Set(userListings.map(l => l.serialNumber));
        return ownedItems.filter(item => !listedIds.has(item.serialNumber));
    }, [ownedItems, userListings]);

    // Preview tiles: owned assets lead, active listings fill the leftover slots.
    // Sorted by rarity (Legendary first) so the rarest items surface in the
    // quick-access grid; stable sort keeps the unlisted-then-listed order
    // within a single rarity tier.
    const previewItems = useMemo(
        () =>
            [...unlistedItems, ...userListings]
                .sort((a, b) => {
                    const rarityDiff = (rarityOrder[a.rarity] ?? Infinity) - (rarityOrder[b.rarity] ?? Infinity);
                    return rarityDiff !== 0 ? rarityDiff : a.name.localeCompare(b.name);
                })
                .slice(0, 4),
        [unlistedItems, userListings],
    );

    // Bid history is not in the game store — it comes from the explorer, which is
    // too slow to sit in the 15s polling batch. Loaded once per wallet here so the
    // badge can speak for the buyer side too, not just the listings the store has.
    // Keyed by the address they were fetched for, so a wallet switch invalidates
    // them by comparison rather than by an eager reset — clearing state up front
    // would just be a second render on every reconnect.
    const [bidsFor, setBidsFor] = useState<{ address: string; bids: UserBid[] } | null>(null);
    const userBids =
        bidsFor && accountId && bidsFor.address === accountId ? bidsFor.bids : EMPTY_BIDS;

    useEffect(() => {
        if (!accountId) return;
        let cancelled = false;
        fetchUserBids(accountId as `0x${string}`)
            .then((bids) => { if (!cancelled) setBidsFor({ address: accountId, bids }); })
            .catch(() => { if (!cancelled) setBidsFor({ address: accountId, bids: [] }); });
        return () => { cancelled = true; };
    }, [accountId]);

    // Read once per render so every deadline in this pass agrees on "now".
    const nowMs = useNow();

    // One badge, so the states are ranked and the most pressing one wins. Covers
    // both sides: what this pilot owes on a listing, and what they are owed on a
    // bid. Amounts are never involved — only the states around them.
    const assetAlert = useMemo(
        () => topAssetAlert(userListings, userBids, nowMs),
        [userListings, userBids, nowMs],
    );

    return (
        <div className="flex flex-col gap-6">
            <div className="relative p-4 sm:p-6 md:p-8 rounded-2xl border border-cyan-500/30 bg-black/60 backdrop-blur-xl text-left overflow-hidden group">
                <div className="absolute inset-0 bg-linear-to-br from-cyan-500/5 via-transparent to-transparent opacity-50" />
                <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-40 transition-opacity duration-700">
                    <Image src={highScoreShip.icon || spaceships[0].icon} alt="ship" width={120} height={120} className="rotate-12 blur-[2px] group-hover:blur-0 transition-all" />
                </div>
                <div className="relative z-10 space-y-6">
                    <div className="flex justify-between items-start">
                        <div>
                            <p className="text-[10px] text-cyan-500 uppercase font-mono tracking-widest">Commander ID</p>
                            {isLoading ? (
                                <SkeletonBar className="h-5 w-32 mt-1" />
                            ) : (
                                <div className="flex items-center gap-2">
                                    <h3 className="text-cyan-400 font-bold font-mono truncate max-w-50">{accountId?.substring(0, 5)}...{accountId?.substring(accountId.length - 3)}</h3>
                                    {isAttested === true && (
                                        <span
                                            title="Bridged through the Attestcoin rail — attested leaderboard tier"
                                            className="text-[7px] bg-green-500 text-black px-1 font-black rounded-sm leading-tight"
                                        >
                                            ✓ ATTESTED
                                        </span>
                                    )}
                                    <button
                                        onClick={() => {
                                            if (accountId) {
                                                navigator.clipboard.writeText(accountId);
                                                toast.success("Address copied");
                                            }
                                        }}
                                        className="p-1 rounded border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors cursor-pointer"
                                        title="Copy address"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400">
                                            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                        </svg>
                                    </button>
                                    <a
                                        href={`https://creditcoin-testnet.blockscout.com/address/${accountId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="p-1 rounded border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors"
                                        title="View on Blockscout"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400">
                                            <path d="M15 3h6v6" />
                                            <path d="M10 14 21 3" />
                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                        </svg>
                                    </a>
                                </div>
                            )}
                        </div>
                        <div className="text-right">
                            <p className="text-[9px] text-yellow-500 uppercase font-mono">Personal Best</p>
                            {isLoading ? (
                                <SkeletonBar className="h-6 w-20 mt-1 ml-auto" />
                            ) : (
                                <p className="text-yellow-400 font-black text-xl leading-none">{profileData.highScore.toLocaleString()}</p>
                            )}
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-cyan-500/10 p-3 rounded-lg border border-cyan-500/10 backdrop-blur-sm">
                            <p className="text-[9px] text-cyan-500 uppercase">tCTC Balance</p>
                            {isLoading ? (
                                <SkeletonBar className="h-5 w-16 mt-1" />
                            ) : (
                                <p className="text-white font-bold">{parseFloat(tctcBalance).toFixed(2)} tCTC</p>
                            )}
                        </div>
                        <div className="bg-cyan-500/10 p-3 rounded-lg border border-cyan-500/10 backdrop-blur-sm flex flex-col">
                            <p className="text-[9px] text-cyan-500 uppercase">Stars (Creditcoin)</p>
                            {isLoading ? (
                                <SkeletonBar className="h-5 w-16 mt-1" />
                            ) : (
                                <p className="text-white font-bold">{parseFloat(starsBalance).toFixed(2)} Stars</p>
                            )}
                            {isAttested === false && (
                                <p className="text-[8px] text-cyan-500 font-mono mt-1 leading-tight">
                                    Bridge Sepolia Stars to join the attested tier
                                </p>
                            )}
                        </div>
                        <div className="bg-cyan-500/10 p-3 rounded-lg border border-cyan-500/10 backdrop-blur-sm flex flex-col">
                            <p className="text-[9px] text-cyan-500 uppercase">Stars (Sepolia)</p>
                            {isLoading ? (
                                <SkeletonBar className="h-5 w-16 mt-1" />
                            ) : (
                                <p className="text-white font-bold">{parseFloat(sepoliaStarsBalance).toFixed(2)} Stars</p>
                            )}
                            <p className="text-[8px] text-cyan-500 font-mono mt-1 leading-tight">
                                Bridge to Creditcoin to spend
                            </p>
                        </div>
                        <div className="bg-white/5 p-3 rounded-lg border border-white/5">
                            <p className="text-[9px] text-gray-400 uppercase">Fleet Status</p>
                            {isLoading ? (
                                <SkeletonBar className="h-5 w-16 mt-1" />
                            ) : (
                                <p className="text-white font-bold">{profileData.shipsCount} <span className="text-[10px] text-gray-500 font-normal">Active Units</span></p>
                            )}
                        </div>
                    </div>
                    {/* Sits under the balances because it explains them: where the
                        Stars came from and what they turned into. */}
                    <button
                        onClick={() => setIsDashboardOpen(true)}
                        className="w-full py-2 bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 font-black uppercase text-[10px] rounded-lg cursor-pointer hover:bg-cyan-500 hover:text-black transition-all"
                    >
                        Asset Dashboard — Stars holdings
                    </button>
                    <button
                        onClick={() => setIsBridgeOpen(true)}
                        className="w-full py-2 bg-green-500/10 text-green-300 border border-green-500/30 font-black uppercase text-[10px] rounded-lg cursor-pointer hover:bg-green-500 hover:text-black transition-all"
                    >
                        Bridge Stars — Sepolia → Creditcoin
                    </button>
                    <div className="space-y-3">
                        <p className="text-[10px] text-cyan-500 uppercase font-mono tracking-widest border-b border-cyan-500/20 pb-1">Fleet Records</p>
                        {isFleetLoading ? (
                            <div className="flex gap-4 overflow-x-auto pb-2 custom-scrollbar">
                                {Array.from({ length: 5 }).map((_, idx) => (
                                    <div key={idx} className="shrink-0 flex flex-col items-center gap-2">
                                        <SkeletonBar className="w-14 h-14 rounded-xl" />
                                        <SkeletonBar className="h-3 w-10 rounded" />
                                        <SkeletonBar className="h-3 w-8 rounded" />
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="flex gap-4 overflow-x-auto pb-2 custom-scrollbar">
                                {mySpaceships.map((ship, idx) => {
                                    const shipBest = userHighscores && accountId ? Math.max(...userHighscores.filter((h) => h.ship === ship.name && h.player?.toLowerCase() === accountId.toLowerCase()).map((h) => h.score), 0) : 0;

                                    return (
                                        <div key={idx} className="shrink-0 flex flex-col items-center gap-2 group/ship mt-1">
                                            <div className={`relative p-2 rounded-xl border ${ship.name === highScoreShip.name ? 'border-yellow-500/50 bg-yellow-500/5' : 'border-white/10 bg-white/5'}`}>
                                                <Image src={ship.icon} alt={ship.name} width={45} height={45} className="object-contain group-hover/ship:scale-110 transition-transform" />
                                                {ship.name === highScoreShip.name && <div className="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full shadow-[0_0_8px_#facc15]" />}
                                            </div>
                                            <div className="text-center">
                                                <p className="text-[8px] text-gray-400 uppercase font-bold w-14">{ship.name}</p>
                                                <p className="text-[9px] text-cyan-400 font-mono font-bold">{shipBest > 0 ? shipBest.toLocaleString() : '---'}</p>
                                            </div>
                                        </div>
                                    )})}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {/* Quick Inventory Access */}
            <div
                onClick={() => setIsInventoryOpen(true)}
                className="relative p-6 rounded-2xl border border-cyan-500/30 bg-black/60 backdrop-blur-xl cursor-pointer hover:border-cyan-400 transition-all group/inventory"
            >
                {assetAlert && assetAlert.alert.actionable && (
                    <div className="absolute -top-1 -right-1 flex h-3 w-3 z-20">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500 shadow-[0_0_8px_#facc15]"></span>
                    </div>
                )}

                <div className="flex justify-between items-center mb-4">
                    <div className="flex items-center gap-2">
                        <p className="text-[10px] text-cyan-500 group-hover/inventory:text-cyan-400 transition-colors uppercase font-mono tracking-widest">On-Chain Assets</p>
                        {assetAlert && (
                            <span className={`text-[7px] ${assetAlert.alert.className} px-1.5 py-0.5 rounded font-black uppercase tracking-tight ${assetAlert.alert.actionable ? 'animate-pulse' : ''}`}>
                                {assetAlert.alert.label}
                                {assetAlert.count > 1 && ` (${assetAlert.count})`}
                            </span>
                        )}
                    </div>
                    <span className="text-[8px] text-cyan-500 group-hover/inventory:text-cyan-400 transition-colors uppercase font-mono">[ Open Inventory ]</span>
                </div>

                {isLoading ? (
                    <div className="grid grid-cols-4 gap-4">
                        {Array.from({ length: 4 }).map((_, index) => (
                            <div key={index} className="relative aspect-square rounded-lg border border-white/5 bg-white/5 flex items-center justify-center overflow-hidden">
                                <SkeletonBar className="w-10 h-10 rounded" />
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gray-500" />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-4 gap-4">
                        {previewItems.map((item, index) => {
                            const isListed = 'listingId' in item;
                            return (
                                <div
                                    key={index}
                                    className={`relative aspect-square rounded-lg border flex items-center justify-center overflow-hidden ${isListed ? 'border-orange-500/50 bg-orange-500/5' : 'border-white/5 bg-white/5'}`}
                                    title={isListed ? `Listed for ${item.price} Stars` : item.name}
                                >
                                    {isListed && (
                                        <div className="absolute top-1 left-1 z-10 bg-orange-500 text-black text-[7px] px-1 py-px rounded font-black uppercase tracking-tighter">
                                            Listed
                                        </div>
                                    )}
                                    <Image src={item.image} alt="item" width={40} height={40} className="object-contain" unoptimized />
                                    <div className={`absolute bottom-0 left-0 right-0 h-1 ${rarityBgColors[item.rarity] || 'bg-gray-500'}`} />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <InventoryModal
                isOpen={isInventoryOpen}
                onClose={() => setIsInventoryOpen(false)}
                unlistedItems={unlistedItems}
                userListings={userListings}
            />

            {/* Mint/redeem modals were removed with the old economy; the bridge
                modal below is their replacement for moving value in. */}
            <AssetDashboardModal
                isOpen={isDashboardOpen}
                onClose={() => setIsDashboardOpen(false)}
            />

            <BridgeModal
                isOpen={isBridgeOpen}
                onClose={() => setIsBridgeOpen(false)}
            />
        </div>
    );
};

export default PilotProfile;
