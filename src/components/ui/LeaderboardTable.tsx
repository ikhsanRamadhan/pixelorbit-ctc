'use client';
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useWalletStore } from "@/stores/wallet-store";
import { LiaClipboardListSolid } from "react-icons/lia";
import { useLeaderboard } from "@/hooks/useLeaderboard";
import LeaderboardModal, { SkeletonBar, isSamePlayer } from "@/components/ui/LeaderboardModal";
import { useShipLeaderboards } from "@/hooks/useShipLeaderboards";
import { buildAllLeaderboard } from "@/services/shipScores";

function LeaderboardTable({ delay }: { delay: number; }) {
    const { leaderboard, totalUser, isLoading } = useLeaderboard();
    const { accountId } = useWalletStore();
    const [isExpanded, setIsExpanded] = useState(false);

    const {
        shipLeaderboards,
    } = useShipLeaderboards(true);

    // Every (player, ship) pair, so one pilot can hold several ALL-board rows.
    // While the fan-out loads — or if it fails — this degrades to the flat
    // one-row-per-player board instead of blanking.
    const allData = useMemo(
        () => buildAllLeaderboard(leaderboard, shipLeaderboards),
        [leaderboard, shipLeaderboards],
    );

    return (
        <>
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay, duration: 0.8 }}
                onClick={() => setIsExpanded(true)}
                className="relative p-6 rounded-xl border border-cyan-500/20 bg-black/60 backdrop-blur-xl flex flex-col overflow-hidden transition-all duration-500 cursor-pointer hover:border-cyan-400 group h-full shadow-lg hover:shadow-cyan-500/10"
            >
                <div className="absolute inset-0 bg-linear-to-b from-transparent via-cyan-500/5 to-transparent -translate-y-full group-hover:translate-y-full transition-transform duration-2000 ease-in-out" />
                
                <div className="flex justify-between items-start mb-6 z-10">
                    <div>
                        <h3 className="text-cyan-400 font-black uppercase tracking-[0.25em] text-xs">
                            Global Rankings
                        </h3>
                        <p className="text-[9px] text-cyan-500/60 font-mono italic">Sector: Creditcoin_CC3</p>
                    </div>
                    <div className="w-8 h-8 rounded border border-cyan-500/30 flex items-center justify-center group-hover:bg-cyan-500/20 transition-colors">
                        <span className="text-cyan-400 text-lg"><LiaClipboardListSolid /></span>
                    </div>
                </div>

                <div className="grow flex flex-col gap-4 z-10">
                    {isLoading ? (
                        Array.from({ length: 5 }).map((_, idx) => (
                            <div key={idx} className="group space-y-1">
                                <div className="flex justify-between items-center text-[10px] font-mono">
                                    <div className="flex items-center gap-6 w-32">
                                        <SkeletonBar className="h-3 w-4" />
                                        <SkeletonBar className="h-3 w-16" />
                                    </div>
                                    <SkeletonBar className="h-3 w-12" />
                                    <SkeletonBar className="h-3 w-14 ml-auto" />
                                </div>
                                <div className="w-full h-px bg-cyan-500/20" />
                            </div>
                        ))
                    ) : (
                        allData.slice(0, 5).map((user, idx) => {
                            const isCurrentUser = isSamePlayer(user.player, accountId);

                            return (
                                <div key={idx} className="group space-y-1">
                                    <div className="flex justify-between items-center text-[10px] font-mono">

                                        <div className="flex items-center gap-6 w-32">
                                            <span className={idx === 0 ? "text-yellow-400 font-bold" : "text-cyan-500/60"}>
                                                {String(idx + 1).padStart(2, '0')}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-cyan-100 group-hover:text-white transition-colors">
                                                    {user.player.slice(0, 5)}...{user.player.slice(-3)}
                                                </span>
                                                {isCurrentUser && (
                                                    <span className="text-[7px] bg-cyan-500 text-black px-1 font-black rounded-sm leading-tight">
                                                        YOU
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <span className="text-cyan-400 text-[9px] uppercase tracking-tighter truncate max-w-15">
                                            {user.ship}
                                        </span>

                                        <span className="text-cyan-400 font-bold tracking-tighter w-16 text-right">
                                            {user.score.toLocaleString()}
                                        </span>
                                    </div>

                                    <div className="w-full h-px bg-cyan-500/20 group-hover:bg-cyan-500/40 transition-colors" />
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="mt-6 flex items-center justify-between z-10">
                    <div className="flex -space-x-2">
                        {isLoading ? (
                            <>
                                {Array.from({ length: 3 }).map((_, i) => (
                                    <SkeletonBar key={i} className="w-4 h-4 rounded-full" />
                                ))}
                                <SkeletonBar className="h-3 w-16 ml-4" />
                            </>
                        ) : (
                            <>
                                {[...Array(3)].map((_, i) => (
                                    <div key={i} className="w-4 h-4 rounded-full border border-black bg-cyan-900 flex items-center justify-center text-[6px] text-cyan-300">
                                        P
                                    </div>
                                ))}
                                <span className="pl-4 text-[9px] text-cyan-500/60 self-center">+{totalUser} Online</span>
                            </>
                        )}
                    </div>
                    <span className="text-[9px] text-cyan-500/60 font-mono group-hover:text-cyan-400 transition-colors uppercase tracking-widest">
                        Expand [↗]
                    </span>
                </div>

                <div className="absolute bottom-0 left-0 w-full h-px bg-cyan-500 opacity-20 group-hover:opacity-100 transition-opacity" />
            </motion.div>

            <LeaderboardModal isExpanded={isExpanded} onClose={() => setIsExpanded(false)} />
        </>
    );
}

export default LeaderboardTable;