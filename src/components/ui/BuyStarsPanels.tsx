'use client';
import { useCallback, useEffect, useState } from "react";
import { formatEther } from 'viem';
import { useAccount } from 'wagmi';

import { CC_SALE_ADDRESS, SALE_ADDRESS } from "@/lib/contracts";
import { useWalletStore } from "@/stores/wallet-store";
import {
    buyCC3Stars,
    buySepoliaStars,
    cancelCC3Consignment,
    depositCC3Stars,
    fetchCC3Consigned,
    fetchCC3Pool,
    fetchCC3Proceeds,
    fetchCC3ProceedsOwed,
    fetchCC3SalePrice,
    fetchCC3SellPrice,
    fetchCC3Stock,
    fetchMyCC3Lots,
    fetchSepoliaEthPool,
    fetchSepoliaSalePrice,
    fetchSepoliaStock,
    sellCC3Stars,
    withdrawCC3Proceeds,
    type CC3Lot,
    type CC3ShelfStock,
} from "@/services/sale";
import {
    SEPOLIA_SALE_MAX_PER_TX,
    maxSellableStars,
} from "@/services/sale-logic";

/**
 * Dual-sale Buy Stars panels, rendered inside the Bridge modal below the
 * lock form. One column per purchase door: Sepolia ETH and Creditcoin tCTC.
 * Neither door mints — both sell from pre-funded inventory at nominal
 * testnet prices, so no bridging wait is involved.
 *
 * Cross-panel auto-refresh: every panel re-reads whenever `refreshTick`
 * changes, and every successful write calls `onMutated` to bump the tick in
 * the parent. A buy on one door therefore refreshes the shelf, escrow, and
 * pool figures on the other door without reopening the modal.
 */
export interface PanelRefresh {
    /** Bumped by the parent after any successful sale/bridge write. */
    refreshTick: number;
    /** Bump the parent tick so every panel re-reads. */
    onMutated: () => void;
}

/**
 * Optional extra classes on a panel root. The Bridge modal renders every
 * door piece as a direct grid item and passes responsive `order-*` classes
 * here so the pool banners sit side by side on top on desktop while the
 * mobile stack keeps the lock form first.
 */
export interface PanelOrder {
    orderClass?: string;
}

/** Sepolia door pieces: pool banner plus the Sepolia buy panel. */
export function SepoliaPoolBanner({ refreshTick, orderClass }: { refreshTick: number } & PanelOrder) {
    const [stock, setStock] = useState<bigint | null | undefined>(undefined);
    const [pool, setPool] = useState<bigint | null | undefined>(undefined);
    const configured = SALE_ADDRESS !== '0x';

    const refresh = useCallback(() => {
        if (!configured) return;
        fetchSepoliaStock().then(setStock).catch(() => setStock(null));
        fetchSepoliaEthPool().then(setPool).catch(() => setPool(null));
    }, [configured]);

    useEffect(() => {
        refresh();
    }, [refresh, refreshTick]);

    return (
        <div className={`rounded-xl p-3 border-2 border-cyan-400/50 bg-cyan-500/10 space-y-1.5 min-w-0${orderClass ? ` ${orderClass}` : ''}`} aria-live="polite">
            <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] text-cyan-200 font-mono uppercase tracking-widest font-bold">
                    Sepolia door pools
                </p>
                <button
                    onClick={refresh}
                    title="Re-read Sepolia pools"
                    className="text-[9px] text-cyan-300 hover:text-white uppercase font-mono cursor-pointer px-2 py-1"
                >
                    [ Refresh ]
                </button>
            </div>
            <p className="text-white font-black font-mono text-xl leading-tight tabular-nums">
                {stock === undefined
                    ? 'Loading shelf…'
                    : stock === null
                        ? (configured ? 'Shelf unreachable' : 'Shelf unavailable')
                        : `${Number(formatEther(stock)).toFixed(2)} Stars shelf`}
            </p>
            <p className="text-cyan-100 font-bold font-mono text-sm tabular-nums">
                {pool === undefined
                    ? 'Loading pool…'
                    : pool === null
                        ? (configured ? 'Pool unreachable' : 'Pool unavailable')
                        : `${formatEther(pool)} ETH pool`}
            </p>
            {stock !== undefined && stock !== null && stock === BigInt(0) && (
                <p className="text-[10px] text-amber-300 font-mono font-bold">
                    Empty — the owner must restock before buys can land
                </p>
            )}
        </div>
    );
}

/**
 * Bold pool banner for the Creditcoin door: buyable shelf split into free
 * treasury versus consignor escrow, plus the tCTC pool that funds
 * sell-backs. Same heavy-weight treatment as the Sepolia banner.
 */
export function CC3PoolBanner({ refreshTick, orderClass }: { refreshTick: number } & PanelOrder) {
    const [stock, setStock] = useState<CC3ShelfStock | null | undefined>(undefined);
    const [pool, setPool] = useState<bigint | null | undefined>(undefined);
    const configured = CC_SALE_ADDRESS !== '0x';

    const refresh = useCallback(() => {
        if (!configured) return;
        fetchCC3Stock().then(setStock).catch(() => setStock(null));
        fetchCC3Pool().then(setPool).catch(() => setPool(null));
    }, [configured]);

    useEffect(() => {
        refresh();
    }, [refresh, refreshTick]);

    const treasury = stock !== undefined && stock !== null
        ? `${Number(formatEther(stock.treasury)).toFixed(2)} treasury`
        : null;
    const escrowed = stock !== undefined && stock !== null
        ? `${Number(formatEther(stock.escrowed)).toFixed(2)} consigned`
        : null;

    return (
        <div className={`rounded-xl p-3 border-2 border-green-400/50 bg-green-500/10 space-y-1.5 min-w-0${orderClass ? ` ${orderClass}` : ''}`} aria-live="polite">
            <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] text-green-200 font-mono uppercase tracking-widest font-bold">
                    Creditcoin door pools
                </p>
                <button
                    onClick={refresh}
                    title="Re-read Creditcoin pools"
                    className="text-[9px] text-green-300 hover:text-white uppercase font-mono cursor-pointer px-2 py-1"
                >
                    [ Refresh ]
                </button>
            </div>
            <p className="text-white font-black font-mono text-xl leading-tight tabular-nums">
                {stock === undefined
                    ? 'Loading shelf…'
                    : stock === null
                        ? (configured ? 'Shelf unreachable' : 'Shelf unavailable')
                        : `${Number(formatEther(stock.total)).toFixed(2)} Stars shelf`}
            </p>
            <p className="text-green-100 font-bold font-mono text-xs tabular-nums">
                {stock === undefined
                    ? (configured ? 'Loading split…' : '')
                    : stock === null
                        ? (configured ? 'Split unavailable' : '')
                        : `${treasury} · ${escrowed}`}
            </p>
            <p className="text-white font-black font-mono text-sm tabular-nums">
                {pool === undefined
                    ? 'Loading pool…'
                    : pool === null
                        ? (configured ? 'Pool unreachable' : 'Pool unavailable')
                        : `${formatEther(pool)} tCTC sell-back pool`}
            </p>
            {pool !== undefined && pool !== null && pool === BigInt(0) && (
                <p className="text-[10px] text-amber-300 font-mono font-bold">
                    Pool dry — the next buy refills it; sells revert until then
                </p>
            )}
            {stock !== undefined && stock !== null && stock.treasury === BigInt(0) && (
                <p className="text-[10px] text-amber-300 font-mono font-bold">
                    Treasury empty — buys draw consigned lots first
                </p>
            )}
        </div>
    );
}

const inputClass =
    "w-full bg-black border border-cyan-500/30 rounded px-3 py-2 text-white font-mono text-sm outline-none focus:border-cyan-400 disabled:opacity-50";

export function SepoliaSalePanel({ refreshTick, onMutated, orderClass }: PanelRefresh & PanelOrder) {
    const { isConnected } = useAccount();
    const { sepoliaStarsBalance, sepoliaEthBalance } = useWalletStore();
    const [amount, setAmount] = useState('');
    const [price, setPrice] = useState<bigint | null>(null);
    const [isBuying, setIsBuying] = useState(false);
    const configured = SALE_ADDRESS !== '0x';

    const refresh = useCallback(() => {
        if (!configured) return;
        fetchSepoliaSalePrice().then(setPrice).catch(() => setPrice(null));
    }, [configured]);

    useEffect(() => {
        refresh();
    }, [refresh, refreshTick]);

    const handleBuy = async () => {
        setIsBuying(true);
        try {
            const ok = await buySepoliaStars(amount);
            if (ok) {
                setAmount('');
                onMutated();
            }
        } finally {
            setIsBuying(false);
        }
    };

    const disabledReason = !configured
        ? 'Sale not deployed on this deployment'
        : !isConnected
            ? 'Connect your wallet to buy'
            : price === null
                ? 'Sale price unreachable'
                : null;

    return (
        <div className={`bg-white/5 rounded-xl p-4 border border-white/10 space-y-3 min-w-0${orderClass ? ` ${orderClass}` : ''}`}>
            <p className="text-[10px] text-cyan-500 font-mono uppercase tracking-widest">
                Sepolia door · pay Sepolia ETH
            </p>
            <p className="text-[11px] text-white/70 font-mono">
                {price === null
                    ? (configured ? 'Loading price…' : 'Price unavailable')
                    : `${formatEther(price)} ETH per Star — nominal testnet price`}
            </p>
            <p className="text-[11px] text-white/70 font-mono tabular-nums" aria-live="polite">
                {!isConnected
                    ? 'Your Sepolia Stars: connect to check'
                    : `Your Sepolia Stars: ${parseFloat(sepoliaStarsBalance).toFixed(2)} · ${parseFloat(sepoliaEthBalance).toFixed(4)} ETH`}
            </p>
            <label className="block">
                <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">
                    Amount (whole Stars, max {SEPOLIA_SALE_MAX_PER_TX} per buy)
                </span>
                <input
                    type="number"
                    min="1"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="1"
                    disabled={isBuying || !configured}
                    className={inputClass}
                />
            </label>
            <button
                onClick={handleBuy}
                disabled={isBuying || disabledReason !== null}
                title={disabledReason ?? 'Buy Stars on Sepolia'}
                className="w-full py-3 bg-cyan-600 hover:bg-cyan-400 text-black font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {isBuying ? (
                    <span className="flex items-center justify-center gap-2">
                        <span className="animate-spin h-3 w-3 border border-black border-t-transparent rounded-full" />
                        Buying...
                    </span>
                ) : 'Buy Stars on Sepolia'}
            </button>
            {disabledReason && (
                <p className="text-[9px] text-gray-500 font-mono">{disabledReason}</p>
            )}
            <p className="text-[8px] text-gray-500 leading-relaxed">
                Your wallet will ask to switch to Sepolia for the purchase, then
                back to Creditcoin for play. Payment must be exact — the sale
                keeps no change logic. Sale: {configured ? SALE_ADDRESS : 'not configured'} (Sepolia)
            </p>
        </div>
    );
}

export function CC3SalePanel({ refreshTick, onMutated, orderClass }: PanelRefresh & PanelOrder) {
    const { isConnected } = useAccount();
    const [amount, setAmount] = useState('');
    const [price, setPrice] = useState<bigint | null>(null);
    const [isBuying, setIsBuying] = useState(false);
    const configured = CC_SALE_ADDRESS !== '0x';

    const refresh = useCallback(() => {
        if (!configured) return;
        fetchCC3SalePrice().then(setPrice).catch(() => setPrice(null));
    }, [configured]);

    useEffect(() => {
        refresh();
    }, [refresh, refreshTick]);

    const handleBuy = async () => {
        setIsBuying(true);
        try {
            const ok = await buyCC3Stars(amount);
            if (ok) {
                setAmount('');
                onMutated();
            }
        } finally {
            setIsBuying(false);
        }
    };

    const disabledReason = !configured
        ? 'Sale not deployed on this deployment'
        : !isConnected
            ? 'Connect your wallet to buy'
            : price === null
                ? 'Sale price unreachable'
                : null;

    return (
        <div className={`bg-white/5 rounded-xl p-4 border border-white/10 space-y-3 min-w-0${orderClass ? ` ${orderClass}` : ''}`}>
            <p className="text-[10px] text-cyan-500 font-mono uppercase tracking-widest">
                Creditcoin door · pay tCTC
            </p>
            <p className="text-[11px] text-white/70 font-mono">
                {price === null
                    ? (configured ? 'Loading price…' : 'Price unavailable')
                    : `${formatEther(price)} tCTC per Star — nominal testnet price`}
            </p>
            <p className="text-[11px] text-white/80 font-mono font-bold tabular-nums">
                No buy limit — shelf stock and consignment lots bound the fill
            </p>
            <label className="block">
                <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">
                    Amount (whole Stars)
                </span>
                <input
                    type="number"
                    min="1"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="1"
                    disabled={isBuying || !configured}
                    className={inputClass}
                />
            </label>
            <button
                onClick={handleBuy}
                disabled={isBuying || disabledReason !== null}
                title={disabledReason ?? 'Buy Stars on Creditcoin'}
                className="w-full py-3 bg-green-600 hover:bg-green-400 text-black font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {isBuying ? (
                    <span className="flex items-center justify-center gap-2">
                        <span className="animate-spin h-3 w-3 border border-black border-t-transparent rounded-full" />
                        Buying...
                    </span>
                ) : 'Buy Stars on Creditcoin'}
            </button>
            {disabledReason && (
                <p className="text-[9px] text-gray-500 font-mono">{disabledReason}</p>
            )}
            <p className="text-[8px] text-gray-500 leading-relaxed">
                No per-address limit. Stock comes from real bridged Stars only — no mint path
                exists on Creditcoin outside the bridge. Sale: {configured ? CC_SALE_ADDRESS : 'not configured'} (CC3)
            </p>
        </div>
    );
}

/**
 * Two-way Creditcoin door: instant sell-back plus FIFO consignment.
 *
 * Sell-back pays the onchain sell price from the buyer-funded pool (the
 * buy/sell spread refills it); consignment escrows Stars and accrues tCTC
 * proceeds as buyers fill the lots, pulled via Redeem. Unfilled escrow is
 * reclaimable per lot id.
 */
export function CC3TwoWayPanel({ refreshTick, onMutated, orderClass }: PanelRefresh & PanelOrder) {
    const { address, isConnected } = useAccount();
    const [sellAmount, setSellAmount] = useState('');
    const [depositAmount, setDepositAmount] = useState('');
    const [lotId, setLotId] = useState('');
    const [sellPrice, setSellPrice] = useState<bigint | null>(null);
    const [pool, setPool] = useState<bigint | null | undefined>(undefined);
    const [owed, setOwed] = useState<bigint | null | undefined>(undefined);
    const [consigned, setConsigned] = useState<bigint | null>(null);
    const [proceeds, setProceeds] = useState<bigint | null>(null);
    const [myLots, setMyLots] = useState<CC3Lot[] | null | undefined>(undefined);
    const [isWorking, setIsWorking] = useState(false);
    const configured = CC_SALE_ADDRESS !== '0x';

    const refresh = useCallback(() => {
        if (!configured) return;
        fetchCC3SellPrice().then(setSellPrice).catch(() => setSellPrice(null));
        fetchCC3Pool().then(setPool).catch(() => setPool(null));
        fetchCC3ProceedsOwed().then(setOwed).catch(() => setOwed(null));
        if (address) {
            fetchCC3Consigned(address).then(setConsigned).catch(() => setConsigned(null));
            fetchCC3Proceeds(address).then(setProceeds).catch(() => setProceeds(null));
            fetchMyCC3Lots(address).then(setMyLots).catch(() => setMyLots(null));
        } else {
            setConsigned(null);
            setProceeds(null);
            setMyLots(undefined);
        }
    }, [configured, address]);

    useEffect(() => {
        refresh();
    }, [refresh, refreshTick]);

    const runAction = async (action: () => Promise<boolean>, clear: () => void) => {
        setIsWorking(true);
        try {
            if (await action()) {
                clear();
                onMutated();
            }
        } finally {
            setIsWorking(false);
        }
    };

    const disabledReason = !configured
        ? 'Sale not deployed on this deployment'
        : !isConnected
            ? 'Connect your wallet to continue'
            : sellPrice === null
                ? 'Sale state unreachable'
                : null;

    // Sell-back spends only the pool above owed consignor proceeds, mirroring
    // the onchain guard. Consign/redeem/cancel never touch the pool, so only
    // the Sell button observes this reason. The pool is shared: each buy adds
    // the buy price (10 tCTC) and each sell removes the sell price (8 tCTC),
    // so the panel shows how many whole Stars the pool currently covers.
    const freePool = pool === undefined || pool === null || owed === undefined || owed === null
        ? null
        : pool >= owed ? pool - owed : BigInt(0);
    const maxSellable = freePool !== null && sellPrice !== null
        ? maxSellableStars(freePool, sellPrice)
        : null;
    const sellDisabledReason = disabledReason ?? (freePool !== null && sellPrice !== null && freePool < sellPrice
        ? 'Sell-back pool dry — each buy refills it before you can sell'
        : null);

    return (
        <div className={`bg-white/5 rounded-xl p-4 border border-white/10 space-y-3 min-w-0${orderClass ? ` ${orderClass}` : ''}`}>
            <p className="text-[10px] text-cyan-500 font-mono uppercase tracking-widest">
                Creditcoin door · sell & consign
            </p>
            <p className="text-[11px] text-white/70 font-mono">
                {sellPrice === null
                    ? (configured ? 'Loading…' : 'Price unavailable')
                    : `Sell-back pays ${formatEther(sellPrice)} tCTC per Star — pool-funded, spread-kept`}
            </p>
            <p className="text-[11px] text-white/80 font-mono font-bold tabular-nums" aria-live="polite">
                {maxSellable === null || !configured
                    ? 'Pool cover: loading…'
                    : `Pool covers up to ${maxSellable.toString()} Star${maxSellable === BigInt(1) ? '' : 's'} — 1 buy refills ~1 sell, so larger sells wait for more buys`}
            </p>
            <p className="text-[11px] text-white/80 font-mono font-bold tabular-nums">
                {consigned === null || !isConnected
                    ? 'Escrow: connect to check'
                    : `Your escrow: ${consigned.toString()} Stars`}
            </p>
            <label className="block">
                <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">
                    Sell Stars back now (whole Stars)
                </span>
                <div className="flex gap-2">
                    <input
                        type="number"
                        min="1"
                        step="1"
                        value={sellAmount}
                        onChange={(e) => setSellAmount(e.target.value)}
                        placeholder="1"
                        disabled={isWorking || !configured}
                        className={inputClass}
                    />
                    <button
                        onClick={() => runAction(() => sellCC3Stars(sellAmount), () => setSellAmount(''))}
                        disabled={isWorking || sellDisabledReason !== null}
                        title={sellDisabledReason ?? 'Sell Stars for tCTC'}
                        className="px-4 py-2 bg-amber-600 hover:bg-amber-400 text-black font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isWorking ? '…' : 'Sell'}
                    </button>
                </div>
                {sellDisabledReason && disabledReason === null && (
                    <p className="text-[9px] text-amber-300 font-mono font-bold pt-1">{sellDisabledReason}</p>
                )}
                {disabledReason === null && maxSellable !== null && /^\d+$/.test(sellAmount.trim()) && (() => {
                    try {
                        return BigInt(sellAmount.trim()) > maxSellable;
                    } catch {
                        return false;
                    }
                })() && (
                    <p className="text-[9px] text-amber-300 font-mono font-bold pt-1">
                        Pool covers only {maxSellable.toString()} Star{maxSellable === BigInt(1) ? '' : 's'} — lower the amount or buy first to refill it
                    </p>
                )}
            </label>
            <label className="block">
                <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">
                    Consign Stars for later buyers (whole Stars)
                </span>
                <div className="flex gap-2">
                    <input
                        type="number"
                        min="1"
                        step="1"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        placeholder="1"
                        disabled={isWorking || !configured}
                        className={inputClass}
                    />
                    <button
                        onClick={() => runAction(() => depositCC3Stars(depositAmount), () => setDepositAmount(''))}
                        disabled={isWorking || disabledReason !== null}
                        title={disabledReason ?? 'Consign Stars'}
                        className="px-4 py-2 bg-violet-600 hover:bg-violet-400 text-black font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isWorking ? '…' : 'Consign'}
                    </button>
                </div>
            </label>
            <div className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <p className="text-[11px] text-white/80 font-mono font-bold tabular-nums">
                    {proceeds === null || !isConnected
                        ? 'Proceeds: connect to check'
                        : `Proceeds ready: ${formatEther(proceeds)} tCTC`}
                </p>
                <button
                    onClick={() => runAction(() => withdrawCC3Proceeds(), () => undefined)}
                    disabled={isWorking || disabledReason !== null || proceeds === BigInt(0)}
                    title={disabledReason ?? 'Withdraw earned tCTC proceeds'}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-400 text-black font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Redeem proceeds
                </button>
            </div>
            <div className="border-t border-white/10 pt-3 space-y-2">
                <p className="text-[10px] text-red-400/70 font-mono uppercase tracking-widest">
                    Danger zone · cancel a lot
                </p>
                {isConnected && (
                    <div className="space-y-1.5" aria-live="polite">
                        {myLots === undefined ? (
                            <p className="text-[10px] text-gray-500 font-mono">Loading your lots…</p>
                        ) : myLots === null ? (
                            <p className="text-[10px] text-amber-300 font-mono">
                                Lot list unreachable — enter the id manually below
                            </p>
                        ) : myLots.length === 0 ? (
                            <p className="text-[10px] text-gray-500 font-mono">
                                No open lots — nothing escrowed
                            </p>
                        ) : (
                            myLots.map((lot) => (
                                <div
                                    key={lot.lotId.toString()}
                                    className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
                                >
                                    <span className="text-[11px] text-white/80 font-mono tabular-nums">
                                        Lot #{lot.lotId.toString()} · {lot.remaining.toString()} Stars unfilled
                                    </span>
                                    <button
                                        onClick={() => runAction(() => cancelCC3Consignment(lot.lotId.toString()), () => undefined)}
                                        disabled={isWorking || disabledReason !== null}
                                        title={disabledReason ?? `Cancel lot ${lot.lotId.toString()} and reclaim escrow`}
                                        className="px-3 py-1 border border-red-500/50 hover:bg-red-500/10 text-red-400 font-black uppercase text-[10px] rounded transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isWorking ? '…' : 'Cancel'}
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                )}
                <label className="block">
                    <span className="text-[10px] text-white/50 uppercase font-mono mb-1 block">
                        Lot id to cancel (unfilled escrow returns to you)
                    </span>
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={lotId}
                        onChange={(e) => setLotId(e.target.value)}
                        placeholder="0"
                        disabled={isWorking || !configured}
                        className={inputClass}
                    />
                </label>
                <button
                    onClick={() => runAction(() => cancelCC3Consignment(lotId), () => setLotId(''))}
                    disabled={isWorking || disabledReason !== null}
                    title={disabledReason ?? 'Cancel a lot and reclaim escrow'}
                    className="w-full py-2 border border-red-500/50 hover:bg-red-500/10 text-red-400 font-black uppercase text-xs rounded transition-all tracking-widest active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Cancel lot
                </button>
            </div>
            {disabledReason && (
                <p className="text-[9px] text-gray-500 font-mono">{disabledReason}</p>
            )}
            <p className="text-[8px] text-gray-500 leading-relaxed">
                Oldest lots sell first. Proceeds accrue per fill and are pulled
                here — the owner can never sweep them. Unfilled escrow is always
                reclaimable by lot id.
            </p>
        </div>
    );
}
