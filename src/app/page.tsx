"use client";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";

import PixelorbitLogo from "@/components/layout/Logo";
import { useGameStore } from "@/stores/game-store";
import { useWalletStore } from "@/stores/wallet-store";
import PageWrapper from "@/components/layout/PageWrapper";
import SpaceBackground from "@/components/layout/SpaceBackground";
import spaceships, { MySpaceships } from "@/components/utils/Spaceships";
import items from "@/components/utils/Items";
import { aliens, bosses } from "@/components/utils/Enemy";
import { SalvageCrate } from "@/components/utils/Items";
import GameOver from "@/components/layout/Gameover";
import FeatureCardSpaceships from "@/components/ui/FeatureCardSpaceships";
import LeaderboardTable from "@/components/ui/LeaderboardTable";
import PilotProfile from "@/components/ui/PilotProfile";
import FeatureCardMarketplace from "@/components/ui/FeatureCardMarketplace";
import HowToPlayModal from "@/components/ui/HowToPlayModal";
import AppHeader from "@/components/layout/AppHeader";
const GameCanvas = dynamic(() => import("@/game/Canvas"), { ssr: false });

export default function Home() {
  return (
    <PageWrapper>
      <HomeContent />
    </PageWrapper>
  );
}

function HomeContent() {
  const userHighscores = useGameStore((s) => s.userHighscores);
  const mySpaceships = useGameStore((s) => s.mySpaceships);
  const {
    accountId,
    isConnected,
    connect,
    connectError: walletConnectError,
    disconnect,
    connectModalOpen,
  } = useWalletStore();
  const [scores, setScores] = useState(0);
  const [selectedShip, setSelectedShip] = useState<MySpaceships | null>(null);
  const [, setHp] = useState<number>();
  const [collectedItems, setCollectedItems] = useState<SalvageCrate[]>([]);
  const [connectRequested, setConnectRequested] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [howToPlayOpen, setHowToPlayOpen] = useState(false);

  const bestRecord = useMemo(() => {
    if (!userHighscores || userHighscores.length === 0) return null;

    return [...userHighscores].sort((a, b) => b.score - a.score)[0];
  }, [userHighscores]);

  const profileData = useMemo(
    () => ({
      highScore: bestRecord?.score || 0,
      highScoreShipName: bestRecord?.ship || null,
      shipsCount: mySpaceships.length,
      itemsCount: items.length,
      // `items` is a module-level constant, not state or a prop, so its length can
      // never change between renders and is not a valid dependency.
    }),
    [bestRecord, mySpaceships.length],
  );

  // Derived rather than stored: the button is "transmitting" exactly while a
  // connect request of ours still has the RainbowKit modal open and has neither
  // succeeded nor failed. `openConnectModal()` opens the modal in the same batch
  // as `setConnectRequested`, so this is true from the first render after click.
  const isLoading =
    connectRequested && connectModalOpen && !isConnected && !walletConnectError;

  const handleConnect = () => {
    if (!isConnected || !accountId) {
      setConnectRequested(true);
      connect?.();
    }
  };

  const handleStartGame = () => {
    setScores(0);
    setCollectedItems([]);
    setIsGameOver(false);
    setIsPlaying(true);
  };

  const handleRestart = () => {
    handleStartGame();
  };

  const handleGameOver = () => {
    setIsPlaying(false);
    setIsGameOver(true);
  };

  return (
    <main className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden pt-12">
      <AppHeader />
      <AnimatePresence mode="wait">
        {/* Game Over */}
        {isGameOver && selectedShip ? (
          <GameOver
            key="gameover"
            score={scores}
            ship={selectedShip}
            collectedItems={collectedItems}
            onRestart={handleRestart}
            onBack={() => {
              setIsPlaying(false);
              setIsGameOver(false);
            }}
            setCollectedItems={setCollectedItems}
          />
        ) : isPlaying ? (
          /* GAMEPLAY */
          <GameCanvas
            key="game"
            mySpaceships={mySpaceships}
            selectedShip={selectedShip}
            setSelectedShip={setSelectedShip}
            aliens={aliens}
            bosses={bosses}
            setScores={setScores}
            setHp={(newHp) => {
              setHp(newHp);
              if (typeof newHp === "number" && newHp <= 0) {
                handleGameOver();
              }
            }}
            setCollectedItems={setCollectedItems}
            collectedItems={collectedItems}
            handleGameOver={handleGameOver}
          />
        ) : (
          /* MAIN MENU */
          <motion.main
            key="ui"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.1, filter: "blur(20px)" }}
            transition={{ duration: 0.8, ease: "circIn" }}
            className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 sm:px-6 py-12 sm:py-20 overflow-hidden"
          >
            <SpaceBackground />

            <section className="flex flex-col items-center justify-center text-center space-y-8 sm:space-y-12 mb-12 sm:mb-20 w-full max-w-screen-2xl px-4">
              <PixelorbitLogo />

              <div className="w-full">
                <AnimatePresence mode="wait">
                  {!isConnected ? (
                    <motion.div
                      key="unconnected"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="flex flex-col items-center gap-3"
                    >
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={handleConnect}
                        disabled={isLoading}
                        className="relative group p-0.5 overflow-hidden rounded-xl w-64 cursor-pointer"
                      >
                        {isLoading && (
                          <motion.div
                            animate={{ rotate: 360 }}
                            transition={{
                              repeat: Infinity,
                              duration: 2,
                              ease: "linear",
                            }}
                            className="absolute -inset-[200%] bg-[conic-gradient(from_0deg,transparent,transparent,#22d3ee)]"
                          />
                        )}
                        <div className="relative px-8 py-4 bg-black border border-cyan-500/50 rounded-xl text-cyan-400 font-bold tracking-widest uppercase">
                          {isLoading ? "Transmitting..." : "Connect Wallet"}
                        </div>
                      </motion.button>
                      {walletConnectError && (
                        <p className="max-w-xs text-center text-sm text-red-300">
                          {walletConnectError}
                        </p>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="connected-ui"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full items-stretch"
                    >
                      <div className="relative flex flex-col justify-between p-4 sm:p-6 md:p-8 rounded-2xl border border-cyan-500/30 bg-black/40 backdrop-blur-xl overflow-hidden group">
                        <div className="absolute top-0 left-0 w-full h-1 bg-linear-to-r from-transparent via-cyan-500 to-transparent opacity-20" />
                        <div className="absolute -right-16 -top-16 w-32 h-32 bg-cyan-500/10 blur-3xl rounded-full" />

                        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.02),rgba(0,255,0,0.01),rgba(0,0,255,0.02))] bg-size-[100%_2px,3px_100%]" />

                        <div className="relative z-10">
                          <div className="flex justify-between items-start mb-6">
                            <div>
                              <h2 className="text-2xl sm:text-3xl font-black text-white italic tracking-tighter uppercase leading-none">
                                Ready for{" "}
                                <span className="text-cyan-400">Mission?</span>
                              </h2>
                              <div className="flex items-center gap-2 mt-2">
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                                </span>
                                <p className="text-[10px] text-cyan-400/80 font-mono uppercase tracking-[0.2em]">
                                  System: Optimal
                                </p>
                              </div>
                            </div>
                            <div className="hidden sm:block text-right font-mono">
                              <p className="text-[8px] text-cyan-500/60 uppercase">
                                Auth Protocol
                              </p>
                              <p className="text-[10px] text-white/60">
                                CREDITCOIN_CC3
                              </p>
                            </div>
                          </div>

                          <div className="space-y-4">
                            <motion.button
                              onClick={handleStartGame}
                              whileHover={{ scale: 1.02 }}
                              whileTap={{ scale: 0.98 }}
                              className="relative w-full py-4 sm:py-5 bg-cyan-500 hover:bg-cyan-400 text-black font-black rounded-xl uppercase tracking-[0.2em] sm:tracking-[0.3em] text-base sm:text-xl transition-all cursor-pointer shadow-[0_0_20px_rgba(6,182,212,0.3)] group-hover:shadow-[0_0_40px_rgba(6,182,212,0.5)] overflow-hidden"
                            >
                              <span className="relative z-10">Launch Game</span>
                              <motion.div
                                initial={{ x: "-100%" }}
                                whileHover={{ x: "100%" }}
                                transition={{ duration: 0.5 }}
                                className="absolute inset-0 bg-linear-to-r from-transparent via-white/30 to-transparent"
                              />
                            </motion.button>

                            <button
                              onClick={() => setHowToPlayOpen(true)}
                              className="w-full py-2.5 px-4 rounded-lg border border-cyan-500/40 bg-cyan-500/5 hover:bg-cyan-500/15 hover:border-cyan-500/70 text-[10px] sm:text-[11px] text-cyan-300 uppercase transition-all font-bold tracking-widest cursor-pointer"
                            >
                              How To Play
                            </button>

                            <button
                              onClick={() => disconnect?.()}
                              className="w-full py-2 px-4 rounded-lg border border-red-500/10 bg-red-500/5 hover:bg-red-500/10 hover:border-red-500/30 text-[9px] text-red-400/60 uppercase transition-all font-bold tracking-widest cursor-pointer"
                            >
                              Terminate Session (Disconnect)
                            </button>
                          </div>
                        </div>

                        <div className="mt-6 pt-4 border-t border-cyan-500/10">
                          <div className="flex justify-between font-mono text-[8px] text-cyan-500/60">
                            <span>
                              CHAIN: 102031
                            </span>
                            <span>SECTOR: CREDITCOIN</span>
                          </div>
                        </div>
                      </div>

                      <PilotProfile
                        spaceships={spaceships}
                        profileData={profileData}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </section>

            {/* Feature Grid — public preview; buy flows stay gated by wallet */}
            <section className="w-full max-w-screen-2xl mb-12 sm:mb-20 px-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 sm:gap-6 items-stretch">
                <div className="md:col-span-2 h-full">
                  <LeaderboardTable delay={0.2} />
                </div>

                <div className="md:col-span-1 h-full">
                  <FeatureCardSpaceships
                    title="NFT Spaceships"
                    data={spaceships}
                    delay={0.4}
                  />
                </div>

                <div className="md:col-span-1 h-full">
                  <FeatureCardMarketplace title="Epic Loot Drops" delay={0.6} />
                </div>
              </div>
            </section>
          </motion.main>
        )}
      </AnimatePresence>
      <HowToPlayModal
        isOpen={howToPlayOpen}
        onClose={() => setHowToPlayOpen(false)}
      />
    </main>
  );
}
