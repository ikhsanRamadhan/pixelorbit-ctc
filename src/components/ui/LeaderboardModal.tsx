'use client';
import { useState, useMemo, useRef } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "motion/react";
import { Pagination } from "@mui/material";
import { useWalletStore } from "@/stores/wallet-store";
import { useLeaderboard } from "@/hooks/useLeaderboard";
import { useShipLeaderboards } from "@/hooks/useShipLeaderboards";
import { buildAllLeaderboard } from "@/services/shipScores";
import spaceships, { MySpaceships } from "@/components/utils/Spaceships";
import { useModalA11y } from "@/hooks/useModalA11y";
import { MODAL_OVERLAY, MODAL_PADDING, modalPanel, modalHeaderRow, modalTitle, modalCaption, modalCloseBtn } from "@/lib/ui-tokens";

export const SkeletonBar = ({ className }: { className?: string }) => (
    <div className={`bg-white/10 rounded animate-pulse ${className}`} />
);

const ALL_TAB = 'ALL';

// Contract addresses come back checksummed while accountId may not be, so every
// player comparison has to be case-insensitive.
export const isSamePlayer = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Typed alias of the ship registry so a new entry in Spaceships.ts adds a tab.
const shipTabs: MySpaceships[] = spaceships;

interface LeaderboardModalProps {
    isExpanded: boolean;
    onClose: () => void;
};

/**
 * Split from the content so the panel only exists while open, which is what lets
 * `useModalA11y` arm its focus trap on mount — and matches every other modal here.
 */
const LeaderboardModal = ({ isExpanded, onClose }: LeaderboardModalProps) => (
    <AnimatePresence>
        {isExpanded && <LeaderboardModalContent onClose={onClose} />}
    </AnimatePresence>
);

function LeaderboardModalContent({ onClose }: Omit<LeaderboardModalProps, 'isExpanded'>) {
    const { leaderboard, totalUser } = useLeaderboard();
    const { accountId, isConnected } = useWalletStore();
    const tableContainerRef = useRef<HTMLDivElement>(null);
    const [page, setPage] = useState(1);
    const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
    const rowsPerPage = 15;

    const isAllTab = activeTab === ALL_TAB;

    // The content only exists while the modal is open, so the fan-out is
    // unconditionally live here — the old `isExpanded` gate was this component
    // being mounted at all.
    const {
        shipLeaderboards,
        isLoading: shipsLoading,
        error: shipsError,
        mutate,
    } = useShipLeaderboards(true);

    // Every (player, ship) pair, so one pilot can hold several ALL-board rows.
    // While the fan-out loads — or if it fails — this degrades to the flat
    // one-row-per-player board instead of blanking.
    const allData = useMemo(
        () => buildAllLeaderboard(leaderboard, shipLeaderboards),
        [leaderboard, shipLeaderboards],
    );

    const activeData = useMemo(() => {
        return isAllTab ? allData : (shipLeaderboards[activeTab] ?? []);
    }, [isAllTab, activeTab, allData, shipLeaderboards]);

    const paginatedData = useMemo(() => {
        const startIndex = (page - 1) * rowsPerPage;
        return activeData.slice(startIndex, startIndex + rowsPerPage);
    }, [activeData, page]);

    const handleChangePage = (event: React.ChangeEvent<unknown>, value: number) => {
        setPage(value);
        if (tableContainerRef.current) {
            tableContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const handleChangeTab = (tab: string) => {
        setActiveTab(tab);
        setPage(1);
        if (tableContainerRef.current) {
            tableContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const userRank = useMemo(() => {
        if (!accountId || activeData.length === 0) return null;
        const index = activeData.findIndex(user => isSamePlayer(user.player, accountId));
        return index !== -1 ? index + 1 : null;
    }, [activeData, accountId]);

    const showShipLoading = !isAllTab && shipsLoading;
    // Only take over the table when there is nothing to show. A failed 30s
    // background refresh keeps the cached rows visible and degrades to the
    // footer retry instead of blanking a good board.
    const showShipError = !isAllTab && !shipsLoading && !!shipsError && activeData.length === 0;
    // Not gated on the tab: a failed fan-out silently drops the ALL board back
    // to one row per player, which is worth disclosing there too.
    const showStaleWarning = !shipsLoading && !!shipsError && activeData.length > 0;
    const showShipEmpty = !isAllTab && !shipsLoading && !shipsError && activeData.length === 0;

    const panelRef = useModalA11y<HTMLDivElement>(onClose);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={MODAL_OVERLAY}
            onClick={onClose}
        >
            <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="leaderboard-title"
                tabIndex={-1}
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className={`${modalPanel('cyan', 'xl')} ${MODAL_PADDING} flex flex-col`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={modalHeaderRow('cyan')}>
                    <div className="min-w-0">
                        <h2 id="leaderboard-title" className={modalTitle('cyan')}>
                            PIXELORBIT Global Leaderboard
                        </h2>
                        <p className={modalCaption('cyan')}>Real-time data synchronization active</p>
                    </div>
                    <button onClick={onClose} className={modalCloseBtn('cyan')}>[X]</button>
                </div>

                {/* SHIP TABS */}
                <div className="flex flex-wrap items-center gap-2 mb-4 pb-1 overflow-x-auto custom-scrollbar shrink-0">
                    <button
                        onClick={() => handleChangeTab(ALL_TAB)}
                        className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded border font-mono text-[10px] uppercase tracking-wider cursor-pointer transition-colors ${
                            isAllTab
                                ? "border-cyan-500 bg-cyan-500/10 text-cyan-300"
                                : "border-cyan-500/20 text-cyan-500/60 hover:border-cyan-500/50 hover:text-cyan-300"
                        }`}
                    >
                        All
                    </button>
                    {shipTabs.map((ship) => (
                        <button
                            key={ship.name}
                            onClick={() => handleChangeTab(ship.name)}
                            className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded border font-mono text-[10px] uppercase tracking-wider cursor-pointer transition-colors ${
                                activeTab === ship.name
                                    ? "border-cyan-500 bg-cyan-500/10 text-cyan-300"
                                    : "border-cyan-500/20 text-cyan-500/60 hover:border-cyan-500/50 hover:text-cyan-300"
                            }`}
                        >
                            <Image src={ship.icon} alt={ship.name} width={16} height={16} className="object-contain" />
                            {ship.name}
                        </button>
                    ))}
                </div>

                <div ref={tableContainerRef} className="overflow-y-auto grow min-h-0 pr-2 custom-scrollbar font-mono text-xs">
                    <table className="w-full text-left border-separate border-spacing-y-1.5">
                        <thead className="sticky top-0 bg-[#050505] z-10 text-[10px] text-cyan-500/60 uppercase">
                            <tr>
                                <th className="pb-3 pl-4">Rank</th>
                                <th className="pb-3">Commander</th>
                                {isAllTab && <th className="pb-3">Ship</th>}
                                <th className="pb-3 text-right pr-4">Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {showShipLoading && (
                                Array.from({ length: 8 }).map((_, idx) => (
                                    <tr
                                        key={idx}
                                        className={idx % 2 === 0 ? "bg-white/3" : "bg-transparent"}
                                    >
                                        <td className="py-3 pl-4 rounded-l border-y border-l border-cyan-500/10">
                                            <SkeletonBar className="h-3 w-8" />
                                        </td>
                                        <td className="py-3 border-y border-cyan-500/10">
                                            <SkeletonBar className="h-3 w-24" />
                                        </td>
                                        <td className="py-3 pr-4 rounded-r border-y border-r border-cyan-500/10">
                                            <SkeletonBar className="h-3 w-16 ml-auto" />
                                        </td>
                                    </tr>
                                ))
                            )}

                            {showShipError && (
                                <tr>
                                    <td colSpan={3} className="py-10 text-center">
                                        <div className="flex flex-col items-center justify-center gap-3">
                                            <span className="font-mono text-[10px] text-cyan-500/60 uppercase tracking-wider">SYNC FAILED</span>
                                            <button onClick={() => mutate()} className="text-cyan-500 hover:text-white transition-colors font-mono text-[10px] cursor-pointer">[RETRY]</button>
                                        </div>
                                    </td>
                                </tr>
                            )}

                            {showShipEmpty && (
                                <tr>
                                    <td colSpan={3} className="py-10 text-center">
                                        <span className="font-mono text-[10px] text-cyan-500/60 uppercase tracking-wider">NO RECORDS FOR THIS SHIP YET</span>
                                    </td>
                                </tr>
                            )}

                            {!showShipLoading && !showShipError && paginatedData.map((user, idx) => {
                                const globalRank = (page - 1) * rowsPerPage + idx + 1;
                                const isCurrentUser = isSamePlayer(user.player, accountId);

                                return (
                                    <tr
                                        key={`${user.player}-${user.ship}`}
                                        className={`group transition-all duration-300 ${
                                        idx % 2 === 0
                                            ? "bg-white/3"
                                            : "bg-transparent"
                                        } hover:bg-cyan-500/10`}
                                    >
                                        <td className="py-3 pl-4 rounded-l border-y border-l border-cyan-500/10 text-cyan-500/80">
                                            #{globalRank}
                                        </td>

                                        <td className="py-3 border-y border-cyan-500/10">
                                        <div className="flex items-center gap-2">
                                            <span className="text-cyan-100 group-hover:text-white transition-colors">
                                                {user.player.length > 10
                                                    ? `${user.player.slice(0, 5)}...${user.player.slice(-3)}`
                                                    : user.player}
                                            </span>
                                            {isCurrentUser && (
                                                <span className="text-[7px] bg-cyan-500 text-black px-1.5 py-0.5 font-black rounded-sm leading-none animate-pulse">
                                                    YOU
                                                </span>
                                            )}
                                        </div>
                                        </td>

                                        {/* SHIP */}
                                        {isAllTab && (
                                            <td className="py-3 border-y border-cyan-500/10">
                                                <span className="text-cyan-500/60 text-[9px] uppercase tracking-wider font-bold group-hover:text-cyan-300 transition-colors">
                                                    {user.ship}
                                                </span>
                                            </td>
                                        )}

                                        {/* SCORE */}
                                        <td className="py-3 pr-4 text-right rounded-r border-y border-r border-cyan-500/10">
                                            <span className="text-white font-bold tracking-tighter tabular-nums">
                                                {user.score.toLocaleString()}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="mt-6 flex flex-col md:flex-row justify-between items-center gap-4 border-t border-cyan-950 pt-4 shrink-0">
                    <div className="text-[10px] text-cyan-400 flex flex-col items-s">
                        {isAllTab
                            ? (isConnected && userRank ? `CURRENT STATUS: RANKED #${userRank}` : 'CURRENT STATUS: UNRANKED')
                            : (isConnected && userRank ? `${activeTab.toUpperCase()} RANK #${userRank}` : 'UNRANKED — NO RUNS WITH THIS SHIP')}
                        <span className="text-[10px] text-cyan-500/60 font-mono uppercase">
                            TOTAL PILOTS: {totalUser}
                        </span>
                        {showStaleWarning && (
                            <span className="text-[10px] text-amber-400/80 font-mono uppercase flex items-center gap-2">
                                SYNC FAILED — SHOWING CACHED
                                <button onClick={() => mutate()} className="text-cyan-500 hover:text-white transition-colors font-mono cursor-pointer">[RETRY]</button>
                            </span>
                        )}
                    </div>
                    <Pagination
                        count={Math.ceil(activeData.length / rowsPerPage)}
                        page={page}
                        onChange={handleChangePage}
                        size="small"
                        sx={{
                            '& .MuiPaginationItem-root': { color: '#22d3ee', borderColor: 'rgba(34,211,238,0.2)', fontSize: '10px' },
                            '& .Mui-selected': { backgroundColor: 'rgba(34,211,238,0.1) !important' }
                        }}
                    />
                </div>
            </motion.div>
        </motion.div>
    );
}

export default LeaderboardModal;
