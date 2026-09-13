/* ------------------------------------------------------------------ *
 * Tuning constants.
 *
 * Kept in their own module so entities.ts and GameEngine.ts can both read
 * them without importing each other at runtime — the entity classes only
 * need `Game` as a type, and a type-only import is erased at compile time.
 * ------------------------------------------------------------------ */

/** Simulation runs at a fixed 60Hz so physics no longer varies with FPS. */
export const FIXED_STEP = 1000 / 60;
/** Ceiling on catch-up steps: a long stall must not freeze the tab. */
export const MAX_STEPS_PER_FRAME = 5;
export const SPRITE_INTERVAL = 100;
export const PARTICLES_PER_BURST = 15;
/** Bounds worst-case particle cost; bursts past this are dropped. */
export const MAX_PARTICLES = 400;
/**
 * Raised from 10. multiShot adds two extra lanes per volley, and a 3-bullet
 * ship firing at the rapid-fire interval could otherwise starve the pool and
 * silently drop volleys.
 */
export const PROJECTILE_POOL_SIZE = 24;
export const ENEMY_SIZE = 80;

/* ---------------- weapons ---------------- */

/** Minimum gap between volleys, in simulation ms. */
export const FIRE_INTERVAL = 180;
/** Gap while rapidFire is active — also enables auto-repeat on a held key. */
export const RAPID_FIRE_INTERVAL = 80;

/* ---------------- enemy fire ---------------- */

/*
 * Enemy and boss fire are rolled per simulation step, so a chance of C is
 * C * 60 shots per second at the fixed 60Hz step. Every alien used to share
 * one flat 0.0002 roll, which made a 6-HP Alien6 no more threatening than a
 * 1-HP Alien1 — it just took longer to kill.
 */

/** Alien1–Alien4. 0.0006 * 60 ≈ 0.036 shots/sec each. */
export const ENEMY_SHOOT_CHANCE = 0.0006;
/** Above this max HP an alien counts as elite: Alien5 (5 HP) and Alien6 (6 HP). */
export const ELITE_ENEMY_HP_THRESHOLD = 4;
/** Elite aliens fire ~4x as often as the rest: 0.0025 * 60 ≈ 0.15 shots/sec. */
export const ELITE_ENEMY_SHOOT_CHANCE = 0.0025;

/** 0.03 * 60 ≈ 1.8 volleys/sec, before the cooldown below trims clusters. */
export const BOSS_SHOOT_CHANCE = 0.03;
/**
 * Floor on the gap between boss volleys, in simulation ms. A volley is 2–6
 * projectiles; without this, two independent rolls on adjacent steps stack
 * into a wall with no gap to fly through.
 */
export const BOSS_SHOOT_MIN_INTERVAL = 350;

/* ---------------- boss HP ---------------- */

/**
 * Base HP for a fresh run. Was `50` at construction but `20` in restart(), so
 * the real baseline was 20 — the first boss rolled at 0.5x could die to ~10
 * primary hits. One constant, used in both places.
 */
export const BASE_BOSS_HP = 40;
/** Each boss kill feeds the next boss this much extra HP. */
export const BOSS_HP_GROWTH = 15;

/* ---------------- movement ---------------- */

export const BASE_SPEED = 5;
export const BOOSTED_SPEED = 8.5;

/* ---------------- power-up drops ---------------- */

export const POWER_UP_SIZE = 30;
export const POWER_UP_FALL_SPEED = 2;
/** Chance a slain enemy yields a buff. Bosses always drop one. */
export const POWER_UP_DROP_CHANCE = 0.03;

/* ---------------- screen shake ---------------- */

/** Shake magnitudes in pixels, paired with a duration in simulation ms. */
export const SHAKE = {
    enemyDeath: { intensity: 2.5, duration: 120 },
    playerHit: { intensity: 9, duration: 320 },
    shieldBlock: { intensity: 4, duration: 160 },
    bossHit: { intensity: 2, duration: 90 },
    bossDeath: { intensity: 16, duration: 700 },
    gameOver: { intensity: 20, duration: 900 },
} as const;
