/* ------------------------------------------------------------------ *
 * PerformanceMonitor — the [F3] debug overlay
 *
 * GameEngine.render() accumulates time and runs up to MAX_STEPS_PER_FRAME
 * fixed 60Hz update() steps before drawing once. That means wall-clock frame
 * pacing alone does not describe a stall: a frame that consumed 5 simulation
 * steps was already 83ms behind. So the overlay reports both real frame time
 * *and* the step count each frame burned, because a step-count spike is the
 * earliest visible tell that the loop is falling behind.
 *
 * Wiring: GameEngine calls beginFrame/endFrame/toggle/reset, HudRenderer calls
 * draw(). Nothing here reads or writes any file — every counter lives in a
 * preallocated in-memory ring buffer.
 * ------------------------------------------------------------------ */

/* ---------------- tuning constants ---------------- */

/** Rolling sample window. 120 frames is ~2s at 60fps: long enough for a
 *  meaningful 1% low, short enough to still feel live. */
const WINDOW_SIZE = 120;

/** Derived stats and display strings are rebuilt at most this often (ms). */
const RECOMPUTE_INTERVAL = 250;

/** Frame budget at 60fps / 30fps, in milliseconds. */
const BUDGET_60_MS = 1000 / 60;
const BUDGET_30_MS = 1000 / 30;

/** Smoothing factor for the displayed FPS. Low alpha = calm, readable number. */
const FPS_ALPHA = 0.1;

/** A delta larger than this is a tab-switch or a breakpoint, not a slow frame.
 *  Clamping keeps one pathological sample from poisoning min/max/avg. */
const MAX_PLAUSIBLE_DELTA_MS = 1000;

/** FPS colour thresholds. */
const FPS_GOOD = 55;
const FPS_WARN = 30;

/* ---------------- palette (matches the game HUD) ---------------- */

const COLOR_PRIMARY = "#22d3ee";
const COLOR_GOOD = "#4ade80";
const COLOR_WARN = "#facc15";
const COLOR_BAD = "#ef4444";
const COLOR_DIM = "rgba(255, 255, 255, 0.55)";
const COLOR_PANEL = "rgba(0, 0, 0, 0.6)";
const COLOR_BORDER = "rgba(34, 211, 238, 0.4)";
const COLOR_GRAPH_BG = "rgba(255, 255, 255, 0.06)";
const COLOR_GRAPH_LINE = "rgba(255, 255, 255, 0.25)";

/* ---------------- panel geometry ---------------- */

const PANEL_WIDTH = 200;
const PANEL_MARGIN = 15;
/** The HUD strip is 170px tall; sit just below it so nothing overlaps. */
const PANEL_TOP = 180;
const PANEL_PADDING = 10;
const HEADER_HEIGHT = 14;
const FPS_HEIGHT = 20;
const LINE_HEIGHT = 13;
const GRAPH_GAP = 8;
const GRAPH_WIDTH = 160;
const GRAPH_HEIGHT = 40;

/** 1%LOW / FRAME / MIN-MAX / AVG / STEPS / [HEAP] / 4 entity rows. */
const MAX_LINES = 10;

/* ------------------------------------------------------------------ *
 * performance.memory is a non-standard Chrome extension and is absent from
 * lib.dom. Declaring it as an optional member of the real Performance
 * interface means the read below needs no cast at all: the type says
 * "maybe here", which is exactly the runtime truth, and every other browser
 * degrades silently.
 * ------------------------------------------------------------------ */

interface JsHeapMemory {
    readonly usedJSHeapSize: number;
    readonly totalJSHeapSize: number;
    readonly jsHeapSizeLimit: number;
}

declare global {
    interface Performance {
        /** Present only on Chromium; absent everywhere else. */
        readonly memory?: JsHeapMemory;
    }
}

const readHeap = (): JsHeapMemory | undefined => {
    if (typeof performance === "undefined") return undefined;
    return performance.memory;
};

/* ------------------------------------------------------------------ *
 * Entity counts, sampled once per frame by the engine.
 * ------------------------------------------------------------------ */

export interface PerfCounts {
    enemies: number;
    projectiles: number;
    hostile: number;
    particles: number;
    items: number;
    powerUps: number;
    waves: number;
    bosses: number;
}

/* ---------------- string helpers (only run on the 250ms cadence) ---------------- */

const ms = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "--");
const fps = (value: number): string => (Number.isFinite(value) ? value.toFixed(1) : "--");

const pair = (labelA: string, a: number, labelB: string, b: number): string =>
    `${labelA.padEnd(6)}${String(a).padStart(4)}  ${labelB.padEnd(5)}${String(b).padStart(3)}`;

/* ------------------------------------------------------------------ *
 * PerformanceMonitor
 * ------------------------------------------------------------------ */

export class PerformanceMonitor {
    /* ---------------- state ---------------- */

    private isEnabled = false;

    /*
     * Ring buffers, preallocated once. beginFrame/endFrame run 60x/second, so
     * a push/shift array (or a fresh sample object) would hand the GC ~7200
     * allocations per second and the monitor would become the very stutter it
     * is supposed to be measuring. Fixed typed arrays plus a wrapping cursor
     * make the per-frame cost two indexed writes and nothing else.
     */
    private readonly frameTimes = new Float32Array(WINDOW_SIZE);
    private readonly stepCounts = new Uint16Array(WINDOW_SIZE);
    /** Scratch buffer for the percentile sort; allocated once, reused forever. */
    private readonly scratch = new Float32Array(WINDOW_SIZE);

    private cursor = 0;
    private sampleCount = 0;

    private lastTimestamp = -1;
    private frameValid = false;

    private frameMs = 0;
    private instantFps = 0;
    private smoothedFps = 0;
    private lastSteps = 0;

    /* derived stats, refreshed on the throttle cadence */
    private minFrameMs = 0;
    private maxFrameMs = 0;
    private avgFrameMs = 0;
    private lowOnePercentFps = 0;
    private maxStepsInWindow = 0;
    private graphScaleMs = BUDGET_30_MS;

    /* cached display strings */
    private readonly lines: string[] = new Array<string>(MAX_LINES).fill("");
    private lineCount = 0;
    private fpsText = "--";
    private fpsColor: string = COLOR_DIM;
    private lastRebuild = -Infinity;

    /** Live counts, copied field-by-field so nothing is allocated per frame. */
    private readonly counts: PerfCounts = {
        enemies: 0,
        projectiles: 0,
        hostile: 0,
        particles: 0,
        items: 0,
        powerUps: 0,
        waves: 0,
        bosses: 0,
    };

    /* ---------------- enable / disable ---------------- */

    get enabled(): boolean {
        return this.isEnabled;
    }

    toggle(): boolean {
        this.setEnabled(!this.isEnabled);
        return this.isEnabled;
    }

    setEnabled(on: boolean): void {
        if (on === this.isEnabled) return;
        this.isEnabled = on;
        // Drop the stale timestamp: the gap since the monitor was last on is
        // not a frame time, and would otherwise register as a huge spike.
        this.lastTimestamp = -1;
        this.frameValid = false;
        if (on) this.lastRebuild = -Infinity;
    }

    /* ---------------- sampling ---------------- */

    /** Called at the top of render(). Off state costs exactly one branch. */
    beginFrame(timestamp: number): void {
        if (!this.isEnabled) return;

        const previous = this.lastTimestamp;
        this.lastTimestamp = timestamp;

        // First frame after start/enable has no previous timestamp; recording
        // it would mean a delta of `timestamp` itself and an Infinity FPS.
        if (previous < 0) {
            this.frameValid = false;
            return;
        }

        let delta = timestamp - previous;
        if (delta <= 0) delta = 0.01;
        else if (delta > MAX_PLAUSIBLE_DELTA_MS) delta = MAX_PLAUSIBLE_DELTA_MS;

        this.frameMs = delta;
        this.instantFps = 1000 / delta;
        this.smoothedFps =
            this.smoothedFps > 0
                ? this.smoothedFps + (this.instantFps - this.smoothedFps) * FPS_ALPHA
                : this.instantFps;
        this.frameValid = true;
    }

    /** Called at the end of render(), once the frame's real cost is known. */
    endFrame(steps: number, counts: PerfCounts): void {
        if (!this.isEnabled) return;

        this.counts.enemies = counts.enemies;
        this.counts.projectiles = counts.projectiles;
        this.counts.hostile = counts.hostile;
        this.counts.particles = counts.particles;
        this.counts.items = counts.items;
        this.counts.powerUps = counts.powerUps;
        this.counts.waves = counts.waves;
        this.counts.bosses = counts.bosses;
        this.lastSteps = steps;

        if (!this.frameValid) return;

        this.frameTimes[this.cursor] = this.frameMs;
        this.stepCounts[this.cursor] = steps;
        this.cursor = (this.cursor + 1) % WINDOW_SIZE;
        if (this.sampleCount < WINDOW_SIZE) this.sampleCount++;

        /*
         * Throttle: scanning 120 samples and sorting them for the percentile
         * every single frame is pure waste, and numbers that change 60x/second
         * are unreadable anyway. Recompute four times a second, cache the
         * strings, and let draw() just paint them.
         */
        if (this.lastTimestamp - this.lastRebuild < RECOMPUTE_INTERVAL) return;
        this.lastRebuild = this.lastTimestamp;
        this.recomputeStats();
        this.rebuildStrings();
    }

    reset(): void {
        this.frameTimes.fill(0);
        this.stepCounts.fill(0);
        this.cursor = 0;
        this.sampleCount = 0;
        this.lastTimestamp = -1;
        this.frameValid = false;
        this.frameMs = 0;
        this.instantFps = 0;
        this.smoothedFps = 0;
        this.lastSteps = 0;
        this.minFrameMs = 0;
        this.maxFrameMs = 0;
        this.avgFrameMs = 0;
        this.lowOnePercentFps = 0;
        this.maxStepsInWindow = 0;
        this.graphScaleMs = BUDGET_30_MS;
        this.lineCount = 0;
        this.fpsText = "--";
        this.fpsColor = COLOR_DIM;
        this.lastRebuild = -Infinity;
        this.counts.enemies = 0;
        this.counts.projectiles = 0;
        this.counts.hostile = 0;
        this.counts.particles = 0;
        this.counts.items = 0;
        this.counts.powerUps = 0;
        this.counts.waves = 0;
        this.counts.bosses = 0;
        // Deliberately does NOT touch isEnabled: a player who switched the
        // overlay on expects it to survive a restart.
    }

    /* ---------------- derived stats ---------------- */

    private recomputeStats(): void {
        const count = this.sampleCount;
        if (count === 0) return;

        let min = Infinity;
        let max = 0;
        let total = 0;
        let maxSteps = 0;

        for (let i = 0; i < count; i++) {
            const value = this.frameTimes[i];
            if (value < min) min = value;
            if (value > max) max = value;
            total += value;

            const steps = this.stepCounts[i];
            if (steps > maxSteps) maxSteps = steps;

            this.scratch[i] = value;
        }

        // Pad the unused tail with Infinity so a full-array sort still leaves
        // the real samples packed at the front — cheaper than a subarray view.
        for (let i = count; i < WINDOW_SIZE; i++) this.scratch[i] = Infinity;
        this.scratch.sort();

        // 1% low = the 99th-percentile *worst* frame time. Average FPS hides
        // stutter; this is the number that exposes it.
        const percentileIndex = Math.min(count - 1, Math.floor(count * 0.99));
        const worst = this.scratch[percentileIndex];

        this.minFrameMs = min;
        this.maxFrameMs = max;
        this.avgFrameMs = total / count;
        this.lowOnePercentFps = worst > 0 ? 1000 / worst : 0;
        this.maxStepsInWindow = maxSteps;
        this.graphScaleMs = Math.min(200, Math.max(BUDGET_30_MS, max * 1.1));
    }

    private rebuildStrings(): void {
        const counts = this.counts;
        const smoothed = this.smoothedFps;

        this.fpsText = fps(smoothed);
        this.fpsColor = smoothed >= FPS_GOOD ? COLOR_GOOD : smoothed >= FPS_WARN ? COLOR_WARN : COLOR_BAD;

        let index = 0;
        this.lines[index++] = `NOW ${fps(this.instantFps).padStart(5)}  1% LOW ${fps(this.lowOnePercentFps).padStart(5)}`;
        this.lines[index++] = `FRAME   ${ms(this.frameMs).padStart(6)} ms`;
        this.lines[index++] = `MIN ${ms(this.minFrameMs)}  MAX ${ms(this.maxFrameMs)}`;
        this.lines[index++] = `AVG ${ms(this.avgFrameMs)} ms  /${this.sampleCount}f`;
        this.lines[index++] = `STEPS   ${String(this.lastSteps).padStart(6)}  MAX ${this.maxStepsInWindow}`;

        const heap = readHeap();
        if (heap) {
            this.lines[index++] = `HEAP    ${(heap.usedJSHeapSize / 1048576).toFixed(1).padStart(6)} MB`;
        }

        this.lines[index++] = pair("ENEMY", counts.enemies, "BOSS", counts.bosses);
        this.lines[index++] = pair("PROJ", counts.projectiles, "HOSTL", counts.hostile);
        this.lines[index++] = pair("PART", counts.particles, "ITEM", counts.items);
        this.lines[index++] = pair("POWER", counts.powerUps, "WAVE", counts.waves);

        this.lineCount = index;
    }

    /* ---------------- drawing ---------------- */

    draw(context: CanvasRenderingContext2D, viewWidth: number): void {
        if (!this.isEnabled) return;

        const panelHeight =
            PANEL_PADDING +
            HEADER_HEIGHT +
            FPS_HEIGHT +
            this.lineCount * LINE_HEIGHT +
            GRAPH_GAP +
            GRAPH_HEIGHT +
            PANEL_PADDING;

        const x = viewWidth - PANEL_WIDTH - PANEL_MARGIN;
        const y = PANEL_TOP;

        /*
         * The engine draws entities immediately before this overlay, and the
         * whole panel mutates fillStyle, font, textAlign, globalAlpha and
         * shadowBlur. save()/restore() fences all of it — a leaked
         * globalAlpha would silently fade the next frame's sprites.
         */
        context.save();

        context.globalAlpha = 1;
        context.shadowBlur = 0;
        context.textAlign = "left";
        context.textBaseline = "alphabetic";

        context.fillStyle = COLOR_PANEL;
        context.beginPath();
        context.roundRect(x, y, PANEL_WIDTH, panelHeight, 10);
        context.fill();
        context.strokeStyle = COLOR_BORDER;
        context.lineWidth = 1;
        context.stroke();

        const textX = x + PANEL_PADDING;
        let cursorY = y + PANEL_PADDING + 10;

        context.font = "bold 11px 'Courier New', monospace";
        context.fillStyle = COLOR_PRIMARY;
        context.fillText("PERF", textX, cursorY);
        context.fillStyle = COLOR_DIM;
        context.textAlign = "right";
        context.fillText("[F3]", x + PANEL_WIDTH - PANEL_PADDING, cursorY);
        context.textAlign = "left";
        cursorY += HEADER_HEIGHT;

        context.font = "bold 18px 'Courier New', monospace";
        context.fillStyle = this.fpsColor;
        context.fillText(this.fpsText, textX, cursorY + 6);
        context.font = "10px 'Courier New', monospace";
        context.fillStyle = COLOR_DIM;
        context.fillText("fps", textX + 52, cursorY + 6);
        cursorY += FPS_HEIGHT;

        context.fillStyle = "rgba(255, 255, 255, 0.85)";
        for (let i = 0; i < this.lineCount; i++) {
            cursorY += LINE_HEIGHT;
            context.fillText(this.lines[i], textX, cursorY);
        }

        this.drawSparkline(context, textX, cursorY + GRAPH_GAP);

        context.restore();
    }

    /** Frame-time history, oldest on the left, with the 60fps budget marked. */
    private drawSparkline(context: CanvasRenderingContext2D, x: number, y: number): void {
        context.fillStyle = COLOR_GRAPH_BG;
        context.fillRect(x, y, GRAPH_WIDTH, GRAPH_HEIGHT);

        const scale = this.graphScaleMs;
        const budgetY = y + GRAPH_HEIGHT - (BUDGET_60_MS / scale) * GRAPH_HEIGHT;

        context.strokeStyle = COLOR_GRAPH_LINE;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, Math.round(budgetY) + 0.5);
        context.lineTo(x + GRAPH_WIDTH, Math.round(budgetY) + 0.5);
        context.stroke();

        context.fillStyle = COLOR_DIM;
        context.font = "8px 'Courier New', monospace";
        context.fillText("16.7", x + GRAPH_WIDTH - 20, Math.max(y + 8, budgetY - 2));

        const count = this.sampleCount;
        if (count === 0) return;

        const barWidth = GRAPH_WIDTH / WINDOW_SIZE;
        // Oldest sample: the buffer is chronological until it wraps, after
        // which the write cursor is sitting on the oldest entry.
        const oldest = count < WINDOW_SIZE ? 0 : this.cursor;
        const offset = WINDOW_SIZE - count;

        // Three colour passes so fillStyle is set 3x instead of up to 120x.
        this.drawBars(context, x, y, barWidth, oldest, count, offset, 0, BUDGET_60_MS, COLOR_PRIMARY);
        this.drawBars(context, x, y, barWidth, oldest, count, offset, BUDGET_60_MS, BUDGET_30_MS, COLOR_WARN);
        this.drawBars(context, x, y, barWidth, oldest, count, offset, BUDGET_30_MS, Infinity, COLOR_BAD);
    }

    private drawBars(
        context: CanvasRenderingContext2D,
        x: number,
        y: number,
        barWidth: number,
        oldest: number,
        count: number,
        offset: number,
        lowMs: number,
        highMs: number,
        color: string
    ): void {
        context.fillStyle = color;
        const scale = this.graphScaleMs;

        for (let i = 0; i < count; i++) {
            const value = this.frameTimes[(oldest + i) % WINDOW_SIZE];
            if (value <= lowMs || value > highMs) continue;

            const height = Math.max(1, Math.min(GRAPH_HEIGHT, (value / scale) * GRAPH_HEIGHT));
            context.fillRect(x + (offset + i) * barWidth, y + GRAPH_HEIGHT - height, barWidth, height);
        }
    }
}
