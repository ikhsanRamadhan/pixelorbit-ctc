"use client";
import { useEffect, useRef, useState, useCallback } from 'react';
import { Dispatch, SetStateAction } from 'react';
import { motion, AnimatePresence } from "motion/react";
import Image from 'next/image';

import { Game, GameCallbacks } from '@/game/GameEngine';
import { startRun } from '@/services/leaderboard';
import type { EnergySnapshot, PowerUpSnapshot } from '@/game/types';
import GameBackground from '@/components/layout/GameBackground';
import GameHUD from './GameHUD';
import { SalvageCrate } from "@/components/utils/Items";
import { MySpaceships } from "@/components/utils/Spaceships";
import { Alien, BossData } from "@/components/utils/Enemy";

interface CanvasProps {
    setScores: Dispatch<SetStateAction<number>>;
    mySpaceships: MySpaceships[];
    selectedShip: MySpaceships | null;
    aliens: Alien[];
    bosses: BossData[];
    setSelectedShip: Dispatch<SetStateAction<MySpaceships | null>>;
    setHp: Dispatch<SetStateAction<number | undefined>>;
    setCollectedItems: Dispatch<SetStateAction<SalvageCrate[]>>;
    collectedItems: SalvageCrate[];
    handleGameOver: () => void;
};

const Canvas: React.FC<CanvasProps> = (props) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    // Typed rather than `any`: the whole point of replacing the window bridge
    // with a callback object is that the engine's surface is checked here.
    const gameInstance = useRef<Game | null>(null);
    const requestRef = useRef<number | undefined>(undefined);
    const instanceShip = useRef<MySpaceships | null>(null);

    // The engine's callbacks are built once per instance and outlive any single
    // render, so they read props through a ref instead of closing over them.
    // Without this the lifecycle effect would have to list every setter and
    // config array as a dependency, and any new identity would tear the engine
    // down mid-mission. Written in an effect, not during render, so render stays
    // free of side effects.
    const propsRef = useRef(props);
    useEffect(() => {
        propsRef.current = props;
    }, [props]);

    const [gameState, setGameState] = useState<'selecting' | 'counting' | 'playing' | 'paused'>('selecting');

    /* ---- HUD snapshot state (fed by the engine through GameCallbacks) ---- */
    const [score, setScore] = useState(0);
    const [lives, setLives] = useState(0);
    const [maxLives, setMaxLives] = useState(0);
    const [wave, setWave] = useState(1);
    const [energy, setEnergy] = useState<EnergySnapshot>({ energy: 0, maxEnergy: 1, cooldown: false });
    const [powerUps, setPowerUps] = useState<PowerUpSnapshot[]>([]);
    const [muted, setMuted] = useState(false);

    const pauseGame = useCallback(() => setGameState('paused'), []);

    const availableShips = props.mySpaceships;
    // Both states keep the engine alive; only 'playing' drives the render loop.
    const isActive = gameState === 'playing' || gameState === 'paused';

    // Engine lifecycle: one instance per selected ship. Never recreated for a
    // pause/resume, otherwise the constructor's restart() wipes score and wave.
    const selectedShip = props.selectedShip;
    useEffect(() => {
        if (!isActive || !selectedShip) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext("2d");
        if (!context) return;

        const handleResize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            // resize() also rebuilds the collision grid's bucket table. Setting
            // width/height directly left the grid sized for the old viewport,
            // so anything in the newly exposed area stopped colliding.
            gameInstance.current?.resize(canvas.width, canvas.height);
        };

        // Keyboard unlock lives in the engine, but a player who only clicks
        // Pause/Resume would never produce a keydown, and an AudioContext
        // created before any gesture stays suspended.
        const handleGesture = () => gameInstance.current?.audio.unlock();

        window.addEventListener('resize', handleResize);
        window.addEventListener('pointerdown', handleGesture);
        handleResize();

        if (gameInstance.current && instanceShip.current !== selectedShip) {
            gameInstance.current.cleanup();
            gameInstance.current = null;
        }

        if (!gameInstance.current) {
            try {
                // Every callback goes through propsRef so the engine always sees
                // the current setters without this effect depending on them.
                const callbacks: GameCallbacks = {
                    onScoreChange: (next) => {
                        setScore(next);
                        propsRef.current.setScores(next);
                    },
                    onHpChange: (hp) => {
                        setLives(hp);
                        propsRef.current.setHp(hp);
                    },
                    onWaveChange: setWave,
                    onEnergyChange: setEnergy,
                    onPowerUpsChange: setPowerUps,
                    onMuteChange: setMuted,
                    onCollectedItemsChange: (update) => propsRef.current.setCollectedItems(update),
                    getAliens: () => propsRef.current.aliens,
                    getBosses: () => propsRef.current.bosses,
                };

                gameInstance.current = new Game(canvas, selectedShip, callbacks);
                // maxLives never changes for a ship: read it once off the fresh
                // player instead of adding a callback the bridge would gate
                // shut after the first push.
                setMaxLives(gameInstance.current.player.maxLives);
                gameInstance.current.setupInput();
                instanceShip.current = selectedShip;
            } catch (err) {
                console.error("Failed to initialize Game Engine:", err);
            }
        }

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('pointerdown', handleGesture);
        };
    }, [isActive, selectedShip]);

    // The engine is only torn down when the whole canvas goes away.
    useEffect(() => {
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
            if (gameInstance.current) {
                gameInstance.current.cleanup();
                gameInstance.current = null;
                instanceShip.current = null;
            }
        };
    }, []);

    // Render loop. Stopping it freezes the last frame instead of resetting state.
    useEffect(() => {
        if (gameState !== 'playing') return;

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context || !gameInstance.current) return;

        gameInstance.current.resume();

        let lastTime = 0;
        const animate = (timeStamp: number) => {
            if (!lastTime) lastTime = timeStamp;
            // Clamped so a long pause can't produce one huge simulation step.
            const deltaTime = Math.min(timeStamp - lastTime, 50);
            lastTime = timeStamp;

            context.clearRect(0, 0, canvas.width, canvas.height);
            // timeStamp is forwarded so the perf overlay (F3) has a clock; it
            // has no other way to measure a frame boundary.
            gameInstance.current?.render(context, deltaTime, timeStamp);
            requestRef.current = requestAnimationFrame(animate);
        };

        requestRef.current = requestAnimationFrame(animate);

        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
            gameInstance.current?.pause();
        };
    }, [gameState]);

    // Keyboard pause lives here so React state stays the single source of truth.
    useEffect(() => {
        if (!isActive) return;

        const handleKey = (e: KeyboardEvent) => {
            if (e.key !== 'p' && e.key !== 'P' && e.key !== 'Escape') return;
            setGameState((current) => {
                if (current === 'playing') return 'paused';
                if (current === 'paused') return 'playing';
                return current;
            });
        };

        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isActive]);

    // Picking a craft is the run boundary: it happens once per run, before the
    // countdown, and never again for a pause/resume. The run token is requested
    // here so the submission at the end can show the run started fresh — the
    // on-chain `submitScore` itself is open, and the token is the client-side
    // record that this wallet began a run before posting its score.
    //
    // Deliberately not awaited. A player whose token request fails can still
    // play; they only lose the on-chain submission at the end, which
    // `submitHighscore` reports for itself. Blocking the countdown on a network
    // round-trip would make a leaderboard problem look like a broken game.
    const handleSelectShip = (ship: MySpaceships) => {
        void startRun();
        props.setSelectedShip(ship);
        setGameState('counting');
    };

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-[#02020a] flex flex-col items-center justify-center overflow-hidden"
        >
            <GameBackground />

            {isActive && props.selectedShip && (
                <GameHUD
                    pilotName={props.selectedShip.name}
                    score={score}
                    wave={wave}
                    lives={lives}
                    maxLives={maxLives}
                    energy={energy}
                    powerUps={powerUps}
                    muted={muted}
                    collectedItems={props.collectedItems}
                    showHints={gameState === 'playing'}
                    onPause={pauseGame}
                />
            )}

            <AnimatePresence mode="wait">
                {gameState === 'selecting' && (
                    <motion.div 
                        key="selector"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="absolute inset-0 z-55 overflow-y-auto bg-black/10 backdrop-blur-xl p-6 md:p-10"
                    >
                        <div className="min-h-full flex flex-col items-center justify-center gap-4 md:gap-8">
                            <div className='flex flex-col items-center justify-center'>
                            <h2 className="text-cyan-400 font-mono text-base md:text-xl mb-8 tracking-[0.3em] md:tracking-[0.5em] uppercase text-center">Select Your Craft</h2>
                            <div className="flex flex-wrap justify-center gap-4 md:gap-6 max-w-5xl">
                                {props.mySpaceships && availableShips.map((ship, idx) => (
                                    <motion.div
                                        key={idx}
                                        whileHover={{ scale: 1.05, borderColor: 'rgba(6, 182, 212, 0.5)' }}
                                        onClick={() => handleSelectShip(ship)}
                                        className="cursor-pointer bg-cyan-950/20 border border-cyan-500/20 p-4 rounded-lg flex flex-col items-center w-36 md:w-48 transition-colors group"
                                    >
                                        <Image
                                            src={ship.icon}
                                            alt={ship.name}
                                            width={96}
                                            height={96}
                                            unoptimized
                                            className="w-16 h-16 md:w-24 md:h-24 object-contain mb-4 group-hover:drop-shadow-[0_0_15px_rgba(6,182,212,0.5)]"
                                        />
                                        <div className="text-cyan-400 font-mono text-sm mb-1">{ship.name}</div>
                                        <div className="text-cyan-500/50 font-mono text-[10px]">HP: {ship.hp} | EN: {ship.maxEnergy}</div>
                                    </motion.div>
                                ))}
                            </div>
                        </div>

                        <button
                            onClick={props.handleGameOver}
                            className="mt-6 md:mt-8 px-6 py-3 border border-red-500/30 text-red-500 text-sm uppercase tracking-widest hover:bg-red-500/20 transition-all cursor-pointer bg-black/40 backdrop-blur-sm"
                        >
                            [ Cancel Mission ]
                        </button>
                        </div>
                    </motion.div>
                )}

                {gameState === 'counting' && (
                    <motion.div 
                        key="countdown"
                        exit={{ opacity: 0, scale: 2 }}
                        className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-md"
                    >
                        <CountdownTimer onComplete={() => setGameState('playing')} />
                    </motion.div>
                )}

                {gameState === 'paused' && (
                    <motion.div 
                        key="paused"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-md"
                    >
                        <h2 className="text-yellow-400 font-mono text-2xl md:text-4xl mb-8 tracking-[0.3em] md:tracking-[0.5em] uppercase">Paused</h2>
                        <div className="flex flex-col sm:flex-row gap-4">
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => setGameState('playing')}
                                className="px-6 py-3 border border-cyan-500/50 text-cyan-400 text-sm uppercase tracking-widest hover:bg-cyan-500/20 transition-all cursor-pointer bg-black/40 backdrop-blur-sm"
                            >
                                [ Resume ]
                            </motion.button>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={props.handleGameOver}
                                className="px-6 py-3 border border-red-500/30 text-red-500 text-sm uppercase tracking-widest hover:bg-red-500/20 transition-all cursor-pointer bg-black/40 backdrop-blur-sm"
                            >
                                [ Abort Mission ]
                            </motion.button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <div className={`relative w-full h-full ${(gameState !== 'playing' && gameState !== 'paused') ? 'hidden' : 'block'}`}>
                <canvas
                    ref={canvasRef}
                    className="absolute inset-0 block cursor-crosshair z-10"
                    style={{ touchAction: 'none' }}
                />
            </div>

            <div className="pointer-events-none absolute inset-0 z-40 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.03),rgba(0,255,0,0.01),rgba(0,0,118,0.03))] bg-size-[100%_3px,3px_100%]" />
        </motion.div>
    );
};

const CountdownTimer = ({ onComplete }: { onComplete: () => void }) => {
    const [count, setCount] = useState(3);
    
    useEffect(() => {
        if (count > 0) {
            const timer = setTimeout(() => setCount(count - 1), 1000);
            return () => clearTimeout(timer);
        } else {
            onComplete();
        }
    }, [count, onComplete]);

    return (
        <motion.div 
            key={count}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-cyan-400 text-8xl font-black italic font-mono"
        >
            {count > 0 ? count : "LAUNCH"}
        </motion.div>
    );
};

export default Canvas;