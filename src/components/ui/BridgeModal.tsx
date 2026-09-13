'use client';
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from 'sonner';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';

import { useModalA11y } from "@/hooks/useModalA11y";
import { MODAL_OVERLAY, MODAL_PADDING, modalPanel, modalHeaderRow, modalTitle, modalCaption, modalCloseBtn } from "@/lib/ui-tokens";
import { DASHBOARD_URL, SOURCE_ADDRESS, STARS_DECIMALS } from "@/lib/contracts";
import {
    ascTxUrl,
    checkBridgeNow,
    dashboardUrl,
    lockStars,
    retryBridgeWatch,
    sepoliaTxUrl,
} from "@/services/bridge";
import {
    BRIDGE_PHASE_LABELS,
    BRIDGE_TIMELINE,
    clearBridge,
    getBridgeFailureKind,
    useBridges,
    type BridgePhase,
    type BridgeState,
} from "@/services/bridge-store";
import { useWalletStore } from "@/stores/wallet-store";
import { CC3PoolBanner, CC3SalePanel, CC3TwoWayPanel, SepoliaPoolBanner, SepoliaSalePanel } from "@/components/ui/BuyStarsPanels";

interface BridgeModalProps {
    isOpen: boolean;
    onClose: () => void;
};

const BridgeModal = ({ isOpen, onClose }: BridgeModalProps) => (
    <AnimatePresence>
        {isOpen && <BridgeModalContent onClose={onClose} />}
    </AnimatePresence>
);

const BridgeModalContent = ({ onClose }: Omit<BridgeModalProps, 'isOpen'>) => {
    const { address, isConnected } = useAccount();
    const { sepoliaStarsBalance, sepoliaEthBalance } = useWalletStore();
    const bridges = useBridges();
    const [amount, setAmount] = useState('');
    const [recipient, setRecipient] = useState('');
    const [isLocking, setIsLocking] = useState(false);
    // Shared pool-refresh tick for the sale doors below: every successful
    // write in this modal bumps it so shelf, escrow, and pool figures
    // re-read without reopening the modal.
    const [refreshTick, setRefreshTick] = useState(0);
    const handleMutated = useCallback(() => setRefreshTick((t) => t + 1), []);

    // The recipient defaults to the connected wallet: most players bridge to
    // themselves, and an empty field would invite a zero-address revert.
    useEffect(() => {
        if (address) setRecipient((prev) => prev === '' ? address : prev);
    }, [address]);

    const dismiss = useCallback(() => {
        onClose();
        toast.dismiss();
    }, [onClose]);

    const panelRef = useModalA11y<HTMLDivElement>(dismiss);

    const handleLock = async () => {
        if (!isConnected) {
            toast.error('Connect your wallet to bridge Stars');
            return;
        }
        if (!amount || Number(amount) <= 0) {
            toast.error('Enter a Stars amount above zero');
            return;
        }
        setIsLocking(true);
        try {
            const result = await lockStars(amount, recipient.trim());
            if (result) {
                setAmount('');
                handleMutated();
            }
        } finally {
            setIsLocking(false);
        }
    };

    const finished = bridges.filter((b) => b.phase === 'minted' || b.phase === 'failed');

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={MODAL_OVERLAY}
            onClick={dismiss}
        >
            <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="bridge-title"
                tabIndex={-1}
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className={`${modalPanel('cyan', 'xl')} ${MODAL_PADDING} overflow-y-auto`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={modalHeaderRow('cyan', { nowrap: true })}>
                    <div className="min-w-0">
                        <h2 id="bridge-title" className={modalTitle('cyan')}>
                            Bridge Stars
                        </h2>
                        <p className={modalCaption('cyan')}>Sepolia → Creditcoin CC3 · Attestcoin rail</p>
                    </div>
                    <button onClick={dismiss} className={modalCloseBtn('cyan')}>[X]</button>
                </div>

                {/* Six grid items with responsive ordering: on desktop the
                    two pool banners share the top row side by side, then one
                    form per cell (Lock | Buy CC3, Buy Sepolia | Sell &
                    consign) so both columns stay balanced. On mobile the lock
                    form leads, followed by each chain's banner and panels. */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <SepoliaPoolBanner refreshTick={refreshTick} orderClass="order-2 md:order-1" />
                    <CC3PoolBanner refreshTick={refreshTick} orderClass="order-4 md:order-2" />
                    {/* Lock form */}
                    <div className="bg-white/5 rounded-xl p-4 border border-white/10 space-y-3 min-w-0 order-1 md:order-3">
                        <p className="text-[10px] text-cyan-500 font-mono uppercase tracking-widest">
                            Lock on Sepolia
                        </p>
                        <label className="block">
                            <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">Amount (Stars, Sepolia)</span>
                            <input
                                type="number"
                                min="0"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="10.00"
                                disabled={isLocking}
                                className="w-full bg-black border border-cyan-500/30 rounded px-3 py-2 text-white font-mono text-sm outline-none focus:border-cyan-400 disabled:opacity-50"
                            />
                        </label>
                        <p className="text-[11px] text-white/70 font-mono tabular-nums" aria-live="polite">
                            {isConnected
                                ? `Your Sepolia balance: ${parseFloat(sepoliaStarsBalance).toFixed(2)} Stars · ${parseFloat(sepoliaEthBalance).toFixed(4)} ETH`
                                : 'Connect your wallet to check your Sepolia balance'}
                        </p>
                        <label className="block">
                            <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">Creditcoin recipient</span>
                            <input
                                type="text"
                                value={recipient}
                                onChange={(e) => setRecipient(e.target.value)}
                                placeholder="0x..."
                                disabled={isLocking}
                                spellCheck={false}
                                className="w-full bg-black border border-cyan-500/30 rounded px-3 py-2 text-white font-mono text-xs outline-none focus:border-cyan-400 disabled:opacity-50"
                            />
                        </label>
                        <button
                            onClick={handleLock}
                            disabled={isLocking || !isConnected}
                            className="w-full py-3 bg-cyan-600 hover:bg-cyan-400 text-black font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isLocking ? (
                                <span className="flex items-center justify-center gap-2">
                                    <span className="animate-spin h-3 w-3 border border-black border-t-transparent rounded-full" />
                                    Locking...
                                </span>
                            ) : 'Lock Stars on Sepolia'}
                        </button>
                        <p className="text-[8px] text-gray-500 leading-relaxed">
                            Your wallet will ask to switch to Sepolia for the lock, then back to
                            Creditcoin for play. If Sepolia is not in your wallet yet you will be
                            asked to add it first (chain ID 11155111). The bridge worker picks the
                            lock up automatically (~8–10 min attestation) — you may close this modal
                            while it works.
                        </p>
                    </div>
                    <CC3SalePanel refreshTick={refreshTick} onMutated={handleMutated} orderClass="order-5 md:order-4" />
                    <SepoliaSalePanel refreshTick={refreshTick} onMutated={handleMutated} orderClass="order-3 md:order-5" />
                    <CC3TwoWayPanel refreshTick={refreshTick} onMutated={handleMutated} orderClass="order-6" />
                </div>

                {/* Tracked bridges */}
                <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-[10px] text-cyan-500 font-mono uppercase tracking-widest">
                            Track ({bridges.length})
                        </p>
                        {finished.length > 0 && (
                            <button
                                onClick={() => finished.forEach((b) => clearBridge(b.key))}
                                className="text-[9px] text-gray-500 hover:text-white uppercase font-mono cursor-pointer"
                            >
                                [ Clear finished ]
                            </button>
                        )}
                    </div>
                    {bridges.length === 0 && (
                        <p className="text-[10px] text-gray-600 font-mono uppercase text-center py-4">
                            No bridges yet — lock Stars above to start one
                        </p>
                    )}
                    {bridges.map((bridge) => (
                        <BridgeCard key={bridge.key} bridge={bridge} />
                    ))}
                </div>

                <div className="mt-4 pt-3 border-t border-cyan-950 space-y-1">
                    <p className="text-[8px] text-gray-500 font-mono leading-relaxed">
                        Source: {SOURCE_ADDRESS === '0x' ? 'not configured' : SOURCE_ADDRESS} (Sepolia)
                    </p>
                    <a
                        href={DASHBOARD_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-[9px] text-cyan-400 hover:text-cyan-200 font-mono uppercase"
                    >
                        Creditcoin dashboard [↗]
                    </a>
                </div>
            </motion.div>
        </motion.div>
    );
};

/** One tracked lock: amount, timeline, links, and the honest failure state. */
function BridgeCard({ bridge }: { bridge: BridgeState }) {
    const [isRetrying, setIsRetrying] = useState(false);
    const [isRelocking, setIsRelocking] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    // Lock failures never left Sepolia and need a fresh lock (new nonce);
    // only watch timeouts may re-poll the same key.
    const failureKind = bridge.phase === 'failed' ? getBridgeFailureKind(bridge) : null;

    const handleRetry = async () => {
        setIsRetrying(true);
        try {
            await retryBridgeWatch(bridge.key);
        } finally {
            setIsRetrying(false);
        }
    };

    const handleCheckNow = async () => {
        setIsChecking(true);
        try {
            await checkBridgeNow(bridge.key);
        } finally {
            setIsChecking(false);
        }
    };

    const handleRelock = async () => {
        setIsRelocking(true);
        try {
            const result = await lockStars(
                formatUnits(bridge.amount, STARS_DECIMALS),
                bridge.recipient,
            );
            // A fresh lock mints under a new nonce — drop the dead entry so
            // the list does not accumulate one failure per attempt.
            if (result) clearBridge(bridge.key);
        } finally {
            setIsRelocking(false);
        }
    };

    return (
        <div className="bg-black/40 rounded-xl p-4 border border-white/10 space-y-3">
            <div className="flex justify-between items-center">
                <span className="text-sm font-black text-white font-mono">
                    {formatUnits(bridge.amount, STARS_DECIMALS)} Stars
                </span>
                <PhaseBadge phase={bridge.phase} />
            </div>

            <Timeline current={bridge.phase} failed={bridge.phase === 'failed'} />

            {bridge.error && (
                <p className="text-[9px] text-red-400 font-mono leading-relaxed">{bridge.error}</p>
            )}

            {bridge.phase === 'waiting-attestation' && (
                <>
                    <p className="text-[8px] text-gray-500 leading-relaxed">
                        Proving and submitting run on the offchain bridge worker and
                        the explorer needs minutes to index the mint — a healthy
                        bridge typically takes a dozen minutes end to end. The lock
                        stays provable until it is picked up.
                    </p>
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-[9px] text-cyan-500/70 font-mono">
                            {bridge.lastCheckedAt === null
                                ? 'First check pending…'
                                : `Last checked ${Math.max(0, Math.floor((Date.now() - bridge.lastCheckedAt) / 1000))}s ago · ${bridge.pollCount} checks`}
                        </p>
                        <button
                            onClick={handleCheckNow}
                            disabled={isChecking}
                            className="px-3 py-1 bg-white/10 hover:bg-white/20 text-white font-black uppercase text-[9px] rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isChecking ? 'Checking…' : 'Check now'}
                        </button>
                    </div>
                </>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1">
                {bridge.sepoliaTxHash && (
                    <a
                        href={sepoliaTxUrl(bridge.sepoliaTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[9px] text-cyan-400 hover:text-cyan-200 font-mono uppercase"
                    >
                        Sepolia lock tx [↗]
                    </a>
                )}
                {bridge.ascTxHash && (
                    <a
                        href={ascTxUrl(bridge.ascTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[9px] text-cyan-400 hover:text-cyan-200 font-mono uppercase"
                    >
                        ASC mint tx [↗]
                    </a>
                )}
                <a
                    href={dashboardUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[9px] text-cyan-400 hover:text-cyan-200 font-mono uppercase"
                >
                    Dashboard [↗]
                </a>
            </div>

            {bridge.phase === 'failed' && failureKind === 'watch' && (
                <button
                    onClick={handleRetry}
                    disabled={isRetrying}
                    className="w-full py-2 bg-white/10 hover:bg-white/20 text-white font-black uppercase text-[10px] rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isRetrying ? 'Watching...' : 'Retry watch'}
                </button>
            )}

            {bridge.phase === 'failed' && failureKind === 'lock' && (
                <button
                    onClick={handleRelock}
                    disabled={isRelocking}
                    className="w-full py-2 bg-white/10 hover:bg-white/20 text-white font-black uppercase text-[10px] rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isRelocking ? 'Locking...' : 'Try lock again'}
                </button>
            )}
        </div>
    );
}

const PHASE_DOT: Record<BridgePhase, string> = {
    idle: 'bg-gray-700',
    locking: 'bg-cyan-400',
    'waiting-attestation': 'bg-amber-400',
    proving: 'bg-purple-400',
    submitting: 'bg-blue-400',
    minted: 'bg-green-500',
    failed: 'bg-red-500',
};

function PhaseBadge({ phase }: { phase: BridgePhase }) {
    return (
        <span className={`text-[8px] px-1.5 py-0.5 rounded text-black font-black uppercase tracking-tighter ${PHASE_DOT[phase]}`}>
            {BRIDGE_PHASE_LABELS[phase]}
        </span>
    );
}

/** Five ordered steps; the current one pulses, past ones are lit, the rest dim. */
function Timeline({ current, failed }: { current: BridgePhase; failed: boolean }) {
    const currentIdx = failed ? -1 : BRIDGE_TIMELINE.indexOf(current as (typeof BRIDGE_TIMELINE)[number]);
    return (
        <ol className="flex items-center gap-1" aria-label={`Bridge status: ${BRIDGE_PHASE_LABELS[current]}`}>
            {BRIDGE_TIMELINE.map((phase, idx) => {
                const done = currentIdx >= 0 && idx < currentIdx;
                const active = idx === currentIdx;
                return (
                    <li key={phase} className="flex-1 flex flex-col items-center gap-1" title={BRIDGE_PHASE_LABELS[phase]}>
                        <span
                            className={`h-1.5 w-full rounded-full ${done ? 'bg-green-500' : active ? 'bg-cyan-400 animate-pulse' : 'bg-white/10'}`}
                        />
                        <span className={`text-[7px] font-mono uppercase text-center leading-tight ${done || active ? 'text-white/80' : 'text-white/30'}`}>
                            {SHORT_LABELS[phase]}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

const SHORT_LABELS: Record<(typeof BRIDGE_TIMELINE)[number], string> = {
    locking: 'Lock',
    'waiting-attestation': 'Attest',
    proving: 'Prove',
    submitting: 'Submit',
    minted: 'Minted',
};

export default BridgeModal;
