'use client';
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from "motion/react";

import { valuePortfolio, type PortfolioValuation } from '@/services/portfolio';
import { fetchCC3Stock, type CC3ShelfStock } from '@/services/sale';
import { resolveSepoliaStars } from '@/services/bridge';
import {
    createSepoliaSupplyReader,
    readSepoliaStarsSupply,
} from '@/services/sepolia-balance';
import { SEPOLIA_RPC_URL } from '@/lib/contracts';
import { usePilotProfile } from '@/hooks/usePilotProfile';
import { useWalletStore } from '@/stores/wallet-store';
import { useModalA11y } from '@/hooks/useModalA11y';
import { MODAL_OVERLAY, MODAL_PADDING, modalPanel } from '@/lib/ui-tokens';

interface AssetDashboardModalProps {
    isOpen: boolean;
    onClose: () => void;
    onBridge?: () => void;
};

/**
 * Mounted through AnimatePresence so each open re-prices against live Stars
 * readings; the parent only owns the open flag. Matches the other modals.
 */
const AssetDashboardModal = ({ isOpen, onClose, onBridge }: AssetDashboardModalProps) => (
    <AnimatePresence>
        {isOpen && <AssetDashboardModalContent onClose={onClose} onBridge={onBridge} />}
    </AnimatePresence>
);

export default AssetDashboardModal;

/**
 * Holdings view: where the pilot's Stars are, in one place.
 *
 * Stars arrive via the Sepolia bridge, sit in a spendable balance, and become
 * ships and items. So the layout follows that path rather than grouping by
 * asset type. The bridge handoff arrives with the bridge UI in Task 9.
 */
const AssetDashboardModalContent = ({
    onClose,
    onBridge,
}: Omit<AssetDashboardModalProps, 'isOpen'>) => {
    const { tctcBalance, starsBalance, sepoliaStarsBalance, accountId } = useWalletStore();
    const { mySpaceships, ownedItems, userListings } = usePilotProfile();
    const [valuation, setValuation] = useState<PortfolioValuation | null>(null);
    const panelRef = useModalA11y<HTMLDivElement>(onClose);

    // Priced on every open so the Stars values shown are never stale. State
    // lands after the await, which keeps this clear of the
    // no-setState-during-effect rule; the flag drops a late result from a
    // modal the user already closed.
    useEffect(() => {
        let stale = false;
        void (async () => {
            const fresh = await valuePortfolio({
                fleet: mySpaceships,
                items: ownedItems,
                listings: userListings,
            });
            if (!stale) setValuation(fresh);
        })();
        return () => { stale = true; };
    }, [mySpaceships, ownedItems, userListings]);

    const liquidStars = parseFloat(starsBalance) || 0;
    const sepoliaStars = parseFloat(sepoliaStarsBalance) || 0;

    // Everything the pilot holds that is denominated in Stars. Deliberately
    // excludes tCTC: that is gas, not part of the game economy.
    const totalStars = valuation
        ? liquidStars + valuation.fleetStars + valuation.listedStars
        : liquidStars;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className={MODAL_OVERLAY}
        >
            <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="asset-dashboard-title"
                tabIndex={-1}
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                onClick={(e) => e.stopPropagation()}
                className={`${modalPanel('cyan', 'md')} ${MODAL_PADDING} overflow-y-auto space-y-4`}
            >
                <div>
                    <h3 id="asset-dashboard-title" className="text-cyan-400 font-black uppercase tracking-tight">Asset Dashboard</h3>
                    <p className="text-[10px] text-white font-mono mt-0.5">
                        Your Stars on Creditcoin Testnet
                    </p>
                </div>

                <TotalValue totalStars={totalStars} />

                <Holdings
                    liquidStars={liquidStars}
                    sepoliaStars={sepoliaStars}
                    valuation={valuation}
                    onBridge={onBridge}
                />

                <MarketSummary />

                <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5 text-[11px] font-mono">
                    <Row label="Gas (tCTC)" value={`${parseFloat(tctcBalance).toFixed(2)}`} />
                    {accountId && (
                        <a
                            href={`https://creditcoin-testnet.blockscout.com/address/${accountId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-[9px] text-cyan-400/70 hover:text-cyan-300 underline pt-0.5"
                        >
                            View all transactions on Blockscout
                        </a>
                    )}
                </div>

                <button
                    onClick={onClose}
                    className="w-full py-2 bg-white/5 text-gray-400 border border-white/10 font-black uppercase text-[10px] rounded-lg cursor-pointer hover:bg-white/10 transition-all"
                >
                    Close
                </button>
            </motion.div>
        </motion.div>
    );
};

/**
 * Market-wide figures, not personal holdings: the CC3 sale shelf (buyable
 * Stars split into treasury and consignor escrow) plus total Sepolia Stars
 * minted so far. StarsSepolia has no max-supply cap, so the supply is shown
 * as minted-so-far, never as a cap. Both reads fail soft to '…' so a down
 * RPC degrades one box, not the modal.
 */
const MarketSummary = () => {
    const [stock, setStock] = useState<CC3ShelfStock | null>(null);
    const [minted, setMinted] = useState<string | null>(null);

    useEffect(() => {
        let stale = false;
        void (async () => {
            const [freshStock, stars] = await Promise.all([
                fetchCC3Stock(),
                resolveSepoliaStars(),
            ]);
            let supply: string | null = null;
            if (stars) {
                try {
                    supply = await readSepoliaStarsSupply(
                        stars,
                        createSepoliaSupplyReader(SEPOLIA_RPC_URL),
                    );
                } catch {
                    supply = null;
                }
            }
            if (!stale) {
                setStock(freshStock);
                setMinted(supply);
            }
        })();
        return () => { stale = true; };
    }, []);

    return (
        <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5 text-[11px] font-mono">
            <p className="text-[10px] text-cyan-500/60 uppercase font-mono tracking-widest border-b border-cyan-500/20 pb-1">
                Market
            </p>
            <Row
                label="Sale shelf (CC3)"
                value={
                    stock === null
                        ? '…'
                        : `${Number(formatStock(stock.total)).toFixed(2)} Stars`
                }
                sub={
                    stock === null
                        ? undefined
                        : `${Number(formatStock(stock.treasury)).toFixed(2)} treasury · ${Number(formatStock(stock.escrowed)).toFixed(2)} consigned`
                }
            />
            <Row
                label="Sepolia minted"
                value={minted === null ? '…' : `${Number(minted).toFixed(2)} STARS`}
                sub="Minted so far — no max-supply cap"
            />
        </div>
    );
};

/** Token units to a plain decimal string for display math. */
function formatStock(units: bigint): string {
    return (Number(units) / 1e18).toString();
}

/** One label/value line. */
const Row = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="flex justify-between items-baseline gap-3">
        <dt className="text-gray-500 uppercase">{label}</dt>
        <dd className="text-white text-right">
            {value}
            {sub && <span className="block text-[9px] text-gray-500">{sub}</span>}
        </dd>
    </div>
);

/** Headline figure, in Stars. */
const TotalValue = ({
    totalStars,
}: {
    totalStars: number;
}) => (
    <div className="border border-cyan-500/30 bg-cyan-500/10 rounded-xl p-3">
        <p className="text-[9px] text-cyan-500/70 uppercase font-mono">Total holdings</p>
        <p className="text-cyan-300 font-mono font-black text-2xl leading-tight">
            {totalStars.toFixed(2)} <span className="text-sm">Stars</span>
        </p>
    </div>
);

/**
 * The positions Stars can be in: spendable balance, ships, escrowed listings,
 * and held items. The bridge entry ramp attaches here once Task 9 lands it.
 */
const Holdings = ({
    liquidStars,
    sepoliaStars,
    valuation,
    onBridge,
}: {
    liquidStars: number;
    sepoliaStars: number;
    valuation: PortfolioValuation | null;
    onBridge?: () => void;
}) => {
    return (
        <div className="space-y-2">
            <p className="text-[10px] text-cyan-500/60 uppercase font-mono tracking-widest border-b border-cyan-500/20 pb-1">
                Holdings
            </p>

            <div className="border border-white/10 rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-[11px] text-white font-mono font-bold">Spendable Stars (Creditcoin)</p>
                        <p className="text-[9px] text-gray-500 font-mono">Bridged from Sepolia, ready to spend</p>
                    </div>
                    <div className="text-right shrink-0">
                        <p className="text-cyan-300 font-mono font-bold text-sm">{liquidStars.toFixed(2)}</p>
                    </div>
                </div>

                {onBridge && (
                    <button
                        onClick={onBridge}
                        className="w-full py-1.5 bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-black uppercase text-[9px] rounded-md cursor-pointer hover:bg-cyan-500 hover:text-black transition-all"
                    >
                        Bridge Stars
                    </button>
                )}
            </div>

            <div className="border border-white/10 rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-[11px] text-white font-mono font-bold">Sepolia Stars</p>
                        <p className="text-[9px] text-gray-500 font-mono">Needs bridging to Creditcoin to spend</p>
                    </div>
                    <div className="text-right shrink-0">
                        <p className="text-cyan-300 font-mono font-bold text-sm">{sepoliaStars.toFixed(2)}</p>
                    </div>
                </div>
            </div>

            <dl className="border border-white/10 rounded-lg p-2.5 space-y-1.5 text-[11px] font-mono">
                {valuation === null ? (
                    <p className="text-[10px] text-gray-500">Pricing your assets...</p>
                ) : (
                    <>
                        <Row
                            label="Fleet"
                            value={`${valuation.fleetStars.toFixed(2)} Stars`}
                            sub={`${valuation.fleetPricedCount} ships`}
                        />
                        <Row
                            label="Listed for sale"
                            value={`${valuation.listedStars.toFixed(2)} Stars`}
                            sub={`${valuation.listedCount} in escrow`}
                        />
                        <Row label="Items held" value={`${valuation.unlistedItemCount}`} />
                    </>
                )}
            </dl>
        </div>
    );
};
