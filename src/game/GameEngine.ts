import type { MySpaceships } from "@/components/utils/Spaceships";
import type { AlienData, BossData } from "@/components/utils/Enemy";

import type {
  Collidable,
  GameCallbacks,
  ImageSource,
  PowerUpType,
} from "./types";
import { POWER_UP_TYPES } from "./types";
import { compact, loadImage } from "./utils";
import {
  BASE_BOSS_HP,
  BOSS_SHOOT_CHANCE,
  ENEMY_SIZE,
  FIXED_STEP,
  MAX_PARTICLES,
  MAX_STEPS_PER_FRAME,
  PARTICLES_PER_BURST,
  POWER_UP_DROP_CHANCE,
  PROJECTILE_POOL_SIZE,
  SHAKE,
  SPRITE_INTERVAL,
} from "./constants";
import { HudBridge } from "./HudBridge";
import { AudioManager } from "./AudioManager";
import { PerformanceMonitor } from "./PerformanceMonitor";
import { Physics } from "./Physics";
import { pointerRole, type PointerRole } from "./pointer-role";
import { Renderer } from "./Renderer";
import { HudRenderer } from "./HudRenderer";
import {
  Boss,
  BossProjectile,
  EnemyProjectile,
  Particle,
  Player,
  PowerUpDrop,
  Projectile,
  SalvageCrateDrop,
  Wave,
} from "./entities";

/* ------------------------------------------------------------------ *
 * Game — lifecycle, input, entity ownership, and the fixed-step loop.
 *
 * Everything else has moved out: entities to entities.ts, collision to
 * Physics, world drawing to Renderer, the HUD to HudRenderer, React
 * communication to HudBridge. What remains is the part that genuinely has to
 * be central — which entities exist, when they tick, and what the keyboard
 * does.
 * ------------------------------------------------------------------ */

export class Game {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  ship: MySpaceships;

  /** Set beats the old string[] + indexOf on every movement check. */
  keys: Set<string> = new Set();

  /**
   * Where a held touch wants the ship, in canvas pixels, or null when nothing
   * is down. Steering is a target rather than a direction because a finger
   * gives an absolute position — translating it into left/right presses would
   * throw that away and then have to re-derive it.
   *
   * Null is what hands control back to the keyboard, so it must be cleared on
   * pointer release and on pause.
   */
  pointerTargetX: number | null = null;

  /** A held touch fires. Nothing else fits: the finger is already steering. */
  isPointerDown = false;

  /**
   * Second-finger laser: this and `laserPointerId` are the whole state.
   * The first touch pointer owns steering + primary fire; any pointer that
   * arrives while it is down fires the laser instead of stealing the target.
   */
  private laserPointerId: number | null = null;

  player: Player;
  items: SalvageCrateDrop[] = [];
  powerUps: PowerUpDrop[] = [];
  projectiles: Projectile[] = [];
  enemyProjectiles: EnemyProjectile[] = [];
  bossProjectiles: BossProjectile[] = [];
  waves: Wave[] = [];
  bosses: Boss[] = [];
  particles: Particle[] = [];

  columns = 2;
  rows = 2;
  enemySize = ENEMY_SIZE;
  waveCount = 1;
  score = 0;
  bossLives = BASE_BOSS_HP;
  gameOver = false;
  isPaused = false;
  spriteUpdate = false;
  spriteTimer = 0;

  /** Config snapshot: read once instead of touching the bridge per spawn. */
  alienConfig: AlienData[];
  bossConfig: BossData[];

  readonly hud: HudBridge;
  readonly audio: AudioManager;
  readonly perf: PerformanceMonitor;
  readonly physics: Physics;
  readonly renderer: Renderer;
  readonly hudRenderer: HudRenderer;

  private freeParticles: Particle[] = [];
  private accumulator = 0;
  private nextProjectile = 0;

  /** Reused by the perf overlay so a sampled frame allocates nothing. */
  private perfCounts = {
    enemies: 0,
    projectiles: 0,
    hostile: 0,
    particles: 0,
    items: 0,
    powerUps: 0,
    waves: 0,
    bosses: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    ship: MySpaceships,
    callbacks: GameCallbacks = {},
  ) {
    this.canvas = canvas;
    this.ship = ship;
    this.width = canvas.width;
    this.height = canvas.height;

    this.hud = new HudBridge(callbacks);
    this.audio = new AudioManager();
    this.perf = new PerformanceMonitor();

    this.alienConfig = this.hud.getAliens();
    this.bossConfig = this.hud.getBosses();

    this.player = new Player(this, ship);

    for (let i = 0; i < PROJECTILE_POOL_SIZE; i++) {
      this.projectiles.push(new Projectile());
    }

    this.physics = new Physics(this);
    this.renderer = new Renderer(this);
    this.hudRenderer = new HudRenderer(this);

    this.preloadImages();
    this.restart();
  }

  /* ---------------- input ---------------- */

  setupInput(): void {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    // Pointer events on the canvas rather than the window: a tap on the Pause
    // button must not also steer the ship. Touch is the reason this exists,
    // but pointer events cover mouse and stylus for free.
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    // A finger dragged off the canvas never produces pointerup on it, so
    // without this the ship would keep firing at a stale target.
    this.canvas.addEventListener("pointerleave", this.handlePointerUp);
  }

  cleanup(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("pointerleave", this.handlePointerUp);
    this.audio.dispose();
    this.hud.dispose();
  }

  /**
   * The canvas backing store is sized to the viewport in CSS pixels, but its
   * on-screen box can still differ (a scrollbar, a zoom level), so the ratio is
   * applied instead of assuming they match.
   */
  private toCanvasX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return clientX;
    return (clientX - rect.left) * (this.canvas.width / rect.width);
  }

  private isLaserPointerDown(): boolean {
    return this.laserPointerId !== null;
  }

  private getActivePointerRole(): PointerRole {
    return pointerRole(this.isPointerDown);
  }

  private handlePointerDown = (e: PointerEvent): void => {
    // Same reason as keydown: this may be the first gesture of the session.
    this.audio.unlock();
    if (this.isPaused) return;

    // Stops a touch-drag from scrolling or triggering browser gestures. The
    // canvas also sets touch-action: none, which covers the cases where
    // preventDefault on a passive listener would be ignored.
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    if (this.getActivePointerRole() === "laser") {
      this.laserPointerId = e.pointerId;
      return;
    }

    this.isPointerDown = true;
    this.pointerTargetX = this.toCanvasX(e.clientX);

    if (this.gameOver) this.restart();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.laserPointerId) return;
    if (!this.isPointerDown || this.isPaused) return;
    e.preventDefault();
    this.pointerTargetX = this.toCanvasX(e.clientX);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.laserPointerId) {
      this.laserPointerId = null;
      return;
    }
    this.isPointerDown = false;
    // Back to the keyboard; leaving a target set would pin the ship there.
    this.pointerTargetX = null;
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    // An AudioContext created before a user gesture starts suspended, so
    // the first keypress is where the synth actually becomes audible.
    this.audio.unlock();

    if (e.key === "m" || e.key === "M") {
      this.hud.setMuted(this.audio.toggleMuted());
      return;
    }

    if (e.key === "F3") {
      e.preventDefault();
      this.perf.toggle();
      return;
    }

    // Pause is owned by Canvas's gameState; ignore gameplay input while
    // held. Mute and the perf toggle stay live above so they still work
    // from the pause screen.
    if (this.isPaused) return;

    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
    }

    // Shooting is no longer fired from this handler. The key is recorded
    // and Player.updateFiring decides, so cadence comes from the fixed step
    // instead of the OS key-repeat rate.
    this.keys.add(e.key);

    if ((e.key === "r" || e.key === "R") && this.gameOver) this.restart();
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key);
  };

  isFiringPrimary(): boolean {
    // A held touch fires, because there is no second finger to spare for a
    // fire button while the first one is steering.
    return this.keys.has(" ") || this.isPointerDown;
  }

  isFiringLaser(): boolean {
    return this.keys.has("Control") || this.isLaserPointerDown();
  }

  pause(): void {
    this.isPaused = true;
    // Drop held keys so the ship doesn't drift the moment play resumes.
    this.keys.clear();
    // Same for touch: a finger still down when the pause landed would
    // otherwise resume both steering and firing.
    this.isPointerDown = false;
    this.pointerTargetX = null;
    this.laserPointerId = null;
  }

  resume(): void {
    this.isPaused = false;
    // Discard time owed, otherwise resuming replays the whole pause.
    this.accumulator = 0;
  }

  isGamePaused(): boolean {
    return this.isPaused;
  }

  /** Keeps the viewport, the ship and the collision grid in agreement. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.player.y = height - this.player.height - 20;
    this.physics.resize(width, height);
    this.hudRenderer.invalidate();
  }

  /* ---------------- frame ---------------- */

  /**
   * Advances the simulation in fixed steps, then draws once. Movement,
   * energy regen, fire rate, buff duration and shake decay no longer scale
   * with frame rate.
   */
  render(
    context: CanvasRenderingContext2D,
    deltaTime: number,
    timestamp = 0,
  ): void {
    if (this.isPaused) return;

    this.perf.beginFrame(timestamp);

    this.accumulator += deltaTime;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= FIXED_STEP;
      steps++;
      this.update(FIXED_STEP);
    }

    // Too far behind to catch up: drop the debt rather than stack frames.
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.renderer.draw(context);

    // DOM HUD feeds. setEnergy is throttled inside the bridge and
    // setPowerUps only fires on structural change, so this is cheap.
    this.hud.setEnergy(
      this.player.energy,
      this.player.maxEnergy,
      this.player.cooldown,
    );
    this.hud.setPowerUps(this.player.activePowerUps);

    this.perf.endFrame(steps, this.collectCounts());
  }

  private update(step: number): void {
    if (this.spriteTimer > SPRITE_INTERVAL) {
      this.spriteUpdate = true;
      this.spriteTimer = 0;
    } else {
      this.spriteUpdate = false;
      this.spriteTimer += step;
    }

    if (this.gameOver || this.player.lives < 1) {
      this.player.frameX++;
      if (this.player.frameX > this.player.maxFrame) {
        this.hud.setScore(this.score);
        this.hud.setHp(0);
      }
      this.renderer.updateShake(step);
      return;
    }

    this.hud.setHp(this.player.lives);
    this.hud.setWave(this.waveCount);

    for (let i = 0; i < this.projectiles.length; i++) {
      this.projectiles[i].update();
    }

    // Physics moves the hostile projectiles as part of its pass, so the
    // retirement sweep has to come after it rather than before.
    this.physics.update(step);
    compact(this.enemyProjectiles, (entry) => entry.markedForDeletion);
    compact(this.bossProjectiles, (entry) => entry.markedForDeletion);

    for (let i = 0; i < this.items.length; i++) this.items[i].update(step);
    compact(this.items, (entry) => entry.markedForDeletion);

    for (let i = 0; i < this.powerUps.length; i++)
      this.powerUps[i].update(step);
    compact(this.powerUps, (entry) => entry.markedForDeletion);

    this.player.update(step, this.ship);

    for (let i = 0; i < this.bosses.length; i++) {
      const boss = this.bosses[i];
      boss.update();
      // Cooldown first: it must tick even on steps where the boss cannot
      // fire, and && would short-circuit past it.
      const offCooldown = boss.tickShootCooldown(step);
      if (
        offCooldown &&
        boss.lives >= 1 &&
        boss.y >= 0 &&
        Math.random() < BOSS_SHOOT_CHANCE
      ) {
        boss.shoot(this.bossProjectiles);
      }
    }
    compact(this.bosses, (boss) => boss.markedForDeletion);

    for (let i = 0; i < this.waves.length; i++) {
      const wave = this.waves[i];
      wave.update();

      if (wave.enemies.length < 1 && !wave.nextWaveTrigger && !this.gameOver) {
        this.newWave();
        wave.nextWaveTrigger = true;
      }
    }
    compact(this.waves, (wave) => wave.markedForDeletion);

    this.updateParticles();
    this.renderer.updateShake(step);
  }

  private updateParticles(): void {
    const particles = this.particles;

    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.update();

      if (particle.opacity <= 0) {
        particle.active = false;
        this.freeParticles.push(particle);
        // Swap-and-pop: draw order is irrelevant for particles.
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
  }

  private collectCounts() {
    const counts = this.perfCounts;

    let enemies = 0;
    for (let i = 0; i < this.waves.length; i++)
      enemies += this.waves[i].enemies.length;

    let live = 0;
    for (let i = 0; i < this.projectiles.length; i++) {
      if (!this.projectiles[i].free) live++;
    }

    counts.enemies = enemies;
    counts.projectiles = live;
    counts.hostile = this.enemyProjectiles.length + this.bossProjectiles.length;
    counts.particles = this.particles.length;
    counts.items = this.items.length;
    counts.powerUps = this.powerUps.length;
    counts.waves = this.waves.length;
    counts.bosses = this.bosses.length;
    return counts;
  }

  /* ---------------- effects ---------------- */

  triggerShake(intensity: number, duration: number): void {
    this.renderer.trigger(intensity, duration);
  }

  /**
   * Recycles particles through a free list. The old version allocated 15
   * Particle instances plus 30 object literals on every single hit.
   */
  createParticles(object: Collidable, color: string, fades: boolean): void {
    const x = object.x + object.width / 2;
    const y = object.y + object.height / 2;
    const budget = Math.min(
      PARTICLES_PER_BURST,
      MAX_PARTICLES - this.particles.length,
    );

    for (let i = 0; i < budget; i++) {
      const particle = this.freeParticles.pop() ?? new Particle();
      particle.init(
        x,
        y,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        Math.random() * 3,
        color || "red",
        fades,
      );
      this.particles.push(particle);
    }
  }

  /** Claims a pooled bullet, or null when the pool is exhausted. */
  getProjectile(): Projectile | null {
    const pool = this.projectiles;
    const size = pool.length;

    // Resume scanning where the last claim left off instead of restarting
    // from 0, so a full volley is O(n) rather than O(n * lanes).
    for (let i = 0; i < size; i++) {
      const index = (this.nextProjectile + i) % size;
      const projectile = pool[index];
      if (projectile.free) {
        projectile.free = false;
        this.nextProjectile = (index + 1) % size;
        return projectile;
      }
    }
    return null;
  }

  invalidateHud(): void {
    this.hudRenderer.invalidate();
  }

  /**
   * Called by Player.takeDamage on the killing blow. The old code never set
   * gameOver to true anywhere, which left the r-to-restart path unreachable.
   */
  endRun(): void {
    if (this.gameOver) return;
    this.gameOver = true;
    this.audio.play("gameOver", 1);
    this.renderer.trigger(SHAKE.gameOver.intensity, SHAKE.gameOver.duration);
  }

  /* ---------------- spawning ---------------- */

  newWave(): void {
    this.waveCount++;
    this.invalidateHud();
    this.audio.play("waveStart", 0.5);

    if (this.waveCount % 4 === 0) {
      const roll = Math.random();
      // [threshold, bossConfig index, lives multiplier], rarest first.
      // Floor is 1.0: the 0.5x "common" boss died to half the baseline's
      // worth of hits, which is what made bosses feel paper-thin.
      const table: Array<[number, number, number]> = [
        [0.1, 2, 1.5],
        [0.3, 1, 1.0],
        [1.0, 0, 1.0],
      ];

      for (let i = 0; i < table.length; i++) {
        const [threshold, configIndex, multiplier] = table[i];
        if (roll < threshold) {
          const config = this.bossConfig[configIndex] ?? this.bossConfig[0];
          if (config) {
            this.bosses.push(
              new Boss(this, this.bossLives * multiplier, config),
            );
          }
          break;
        }
      }
    } else {
      if (Math.random() < 0.5 && this.columns * ENEMY_SIZE < this.width * 0.8) {
        this.columns++;
      } else if (this.rows * ENEMY_SIZE < this.height * 0.08) {
        this.rows++;
      }

      this.waves.push(new Wave(this));
    }

    compact(this.waves, (wave) => wave.markedForDeletion);
  }

  /**
   * Drop a sealed crate.
   *
   * There is no loot-table pick here any more. The engine used to choose the
   * item with a weighted `Math.random()` roll, which meant the client decided
   * what a drop was worth and the chain merely recorded it. The rarity weights
    * now live in `PixelOrbitItem`, and the roll happens from a
    * prevrandao-mixed seed when the crate is claimed.
   */
  spawnDrop(x: number, y: number): void {
    this.items.push(new SalvageCrateDrop(this, x, y));
  }

  /** Unconditional — used for the guaranteed boss reward. */
  spawnPowerUp(x: number, y: number, type?: PowerUpType): void {
    const chosen =
      type ?? POWER_UP_TYPES[Math.floor(Math.random() * POWER_UP_TYPES.length)];
    this.powerUps.push(new PowerUpDrop(this, x, y, chosen));
  }

  /** Weighted coin flip on a regular enemy death. */
  maybeSpawnPowerUp(x: number, y: number): void {
    if (Math.random() >= POWER_UP_DROP_CHANCE) return;
    this.spawnPowerUp(x, y);
  }

  /* ---------------- lifecycle ---------------- */

  restart(): void {
    this.hud.resetCache();
    this.player.restart(this.ship);

    this.columns = 2;
    this.rows = 2;
    this.waves.length = 0;
    this.bosses.length = 0;
    this.enemyProjectiles.length = 0;
    this.bossProjectiles.length = 0;
    this.items.length = 0;
    this.powerUps.length = 0;
    this.waveCount = 1;
    this.score = 0;
    this.bossLives = BASE_BOSS_HP;
    this.gameOver = false;
    this.accumulator = 0;
    this.spriteTimer = 0;
    this.nextProjectile = 0;

    for (let i = 0; i < this.projectiles.length; i++) {
      this.projectiles[i].reset();
    }
    for (let i = 0; i < this.particles.length; i++) {
      this.particles[i].active = false;
      this.freeParticles.push(this.particles[i]);
    }
    this.particles.length = 0;

    // All four used to survive a restart: the grid kept last run's buckets,
    // the shake kept ticking, the HUD kept its stale cache key, and the
    // perf history mixed two runs together.
    this.physics.reset();
    this.renderer.reset();
    this.hudRenderer.reset();
    this.perf.reset();

    this.waves.push(new Wave(this));
    this.hud.setScore(0);
    this.hud.setCollectedItems([]);
    this.hud.setWave(this.waveCount);
    // Energy/powerup snapshots only leave the bridge when `playing` ticks
    // run, so a fresh Game pushes its resting state once at construction.
    this.hud.setEnergy(
      this.player.energy,
      this.player.maxEnergy,
      this.player.cooldown,
    );
    this.hud.setPowerUps(this.player.activePowerUps);
    this.hud.setMuted(this.audio.isMuted());
  }

  /**
   * Warms the image cache so the first spawn of each sprite isn't blank.
   *
   * Crates are not listed: they are drawn procedurally, and the item sprites
   * they turn into are only ever shown by React after the claim reveals them.
   */
  private preloadImages(): void {
    for (let i = 0; i < this.alienConfig.length; i++) {
      loadImage(this.alienConfig[i].image as ImageSource);
    }
    for (let i = 0; i < this.bossConfig.length; i++) {
      loadImage(this.bossConfig[i].image as ImageSource);
    }
    loadImage(this.ship.images as ImageSource);
  }
}

/* ------------------------------------------------------------------ *
 * Barrel.
 *
 * Canvas.tsx imports `{ Game, GameCallbacks }` from this module, and every
 * engine internal was reachable from here before the split. Re-exporting keeps
 * all pre-split import paths valid.
 * ------------------------------------------------------------------ */

export type {
  ActivePowerUp,
  Collidable,
  GameCallbacks,
  ParticleOptions,
  Position,
  PowerUpSpec,
  PowerUpType,
} from "./types";
export { POWER_UP_SPECS, POWER_UP_TYPES } from "./types";
export { clamp, compact, intersects, isDrawable, loadImage } from "./utils";
export {
  Boss,
  BossProjectile,
  Enemy,
  EnemyProjectile,
  LaserConfig,
  Particle,
  Player,
  PowerUpDrop,
  Projectile,
  SalvageCrateDrop,
  Wave,
} from "./entities";
export { AudioManager } from "./AudioManager";
export type { SoundKey } from "./AudioManager";
export { HudBridge } from "./HudBridge";
export { SpatialGrid } from "./SpatialGrid";
export { Physics } from "./Physics";
export { Renderer } from "./Renderer";
export { HudRenderer } from "./HudRenderer";
export { PerformanceMonitor } from "./PerformanceMonitor";
export type { PerfCounts } from "./PerformanceMonitor";
