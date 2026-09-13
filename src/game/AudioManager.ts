/* ------------------------------------------------------------------ *
 * AudioManager — procedural WebAudio sound effects
 *
 * Extracted from GameEngine.ts, where the previous implementation was
 * effectively dead: nothing ever called loadSound(), so the buffer map
 * stayed empty and play() always early-returned. There are also no audio
 * assets in public/, so instead of shipping files this version SYNTHESISES
 * every effect from oscillators and a noise buffer. Zero network requests,
 * zero assets, no 404s.
 *
 * loadSound() is kept as an optional override: if a real buffer is ever
 * decoded for a key, play() prefers it over the synth voice.
 *
 * Every public method is a no-op rather than a throw when audio is
 * unavailable (SSR, pre-unlock, post-dispose) — the render loop calls
 * play() dozens of times per second and must never be able to crash.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Tuning constants
 * ------------------------------------------------------------------ */

/**
 * Ceiling on simultaneously sounding source nodes. `shoot` and `laser` can
 * both fire many times per second; uncapped voices sum past 0dB (audible
 * clipping) and burn CPU creating nodes the player cannot distinguish.
 * Requests past the cap are dropped outright rather than queued — a late
 * pew is worse than a missing one.
 */
const MAX_VOICES = 16;

/**
 * exponentialRampToValueAtTime() is undefined for a target of 0 (and silently
 * does nothing if the *current* value is 0), so envelopes ramp between this
 * floor instead. It is ~ -80dB, i.e. inaudible, but keeps the ramp legal and
 * avoids the hard discontinuity that produces a click.
 */
const GAIN_FLOOR = 0.0001;

/** Default attack, short enough to feel percussive without clicking. */
const DEFAULT_ATTACK = 0.005;

/** Seconds of slack after an envelope ends before the node is stopped. */
const STOP_PADDING = 0.02;

/** Ramp length for master gain changes, so volume/mute never clicks. */
const MASTER_RAMP = 0.02;

/** Length of the cached white-noise buffer, in seconds. */
const NOISE_BUFFER_SECONDS = 1;

const DEFAULT_VOLUME = 0.5;

/* ------------------------------------------------------------------ *
 * Public sound keys
 * ------------------------------------------------------------------ */

export type SoundKey =
    | "shoot"
    | "laser"
    | "hit"
    | "enemyDeath"
    | "bossHit"
    | "bossDeath"
    | "playerHit"
    | "shieldBlock"
    | "powerup"
    | "itemPickup"
    | "waveStart"
    | "gameOver";

/* ------------------------------------------------------------------ *
 * Voice specs
 *
 * Each SoundKey maps to a tiny declarative description that render()
 * turns into oscillator / noise nodes plus a gain envelope. Declarative
 * beats twelve hand-written functions: the envelope, voice-cap and
 * cleanup logic lives in exactly one place.
 * ------------------------------------------------------------------ */

interface OscLayer {
    type: OscillatorType;
    /** Frequency at layer start, Hz. */
    from: number;
    /** Frequency at layer end; omit for a steady tone. */
    to?: number;
    /** Detune in cents — two slightly detuned layers read as "thick". */
    detune?: number;
    /** Layer level, 0..1, before master gain. */
    gain?: number;
    /** Start offset from the voice start, seconds (used for arpeggios). */
    delay?: number;
    /** Layer length; defaults to the remainder of the voice. */
    duration?: number;
    /** Attack override, seconds. */
    attack?: number;
}

interface NoiseLayer {
    gain?: number;
    delay?: number;
    duration?: number;
    /** Lowpass cutoff at start, Hz. Omit for unfiltered noise. */
    filterFrom?: number;
    /** Lowpass cutoff at end — sweeping this open reads as an explosion. */
    filterTo?: number;
    attack?: number;
}

interface VoiceSpec {
    /** Total voice length, seconds. Kept short so rapid fire cannot smear. */
    duration: number;
    /** Peak level for the voice, 0..1, before master gain. */
    gain: number;
    oscillators?: OscLayer[];
    noise?: NoiseLayer[];
}

const VOICES: Record<SoundKey, VoiceSpec> = {
    /** Classic arcade pew: square wave falling fast. */
    shoot: {
        duration: 0.08,
        gain: 0.22,
        oscillators: [{ type: "square", from: 880, to: 220 }],
    },

    /**
     * Retriggered every frame the laser is held, so it is deliberately the
     * quietest and among the shortest voices in the table.
     */
    laser: {
        duration: 0.1,
        gain: 0.1,
        oscillators: [
            { type: "sawtooth", from: 140, detune: -8, gain: 0.7 },
            { type: "sawtooth", from: 140, detune: 9, gain: 0.7 },
        ],
    },

    /** Dry noise tick for a non-fatal hit. */
    hit: {
        duration: 0.05,
        gain: 0.18,
        noise: [{ filterFrom: 3200 }],
    },

    /** Small explosion: noise closing down over a falling triangle body. */
    enemyDeath: {
        duration: 0.22,
        gain: 0.3,
        oscillators: [{ type: "triangle", from: 400, to: 80, gain: 0.8 }],
        noise: [{ gain: 0.9, filterFrom: 6000, filterTo: 400 }],
    },

    /** Thick, blunt thud so boss chip damage reads differently from `hit`. */
    bossHit: {
        duration: 0.06,
        gain: 0.28,
        oscillators: [{ type: "square", from: 180 }],
    },

    /** Loudest and longest voice: the lowpass opening up is the "boom". */
    bossDeath: {
        duration: 0.55,
        gain: 0.45,
        oscillators: [{ type: "triangle", from: 90, to: 40, gain: 0.6 }],
        noise: [{ gain: 1, filterFrom: 200, filterTo: 6000, attack: 0.02 }],
    },

    /** Low, ugly square drop — the player should feel this one. */
    playerHit: {
        duration: 0.25,
        gain: 0.3,
        oscillators: [{ type: "square", from: 120, to: 60 }],
    },

    /** Bright metallic ping: damage absorbed, not taken. */
    shieldBlock: {
        duration: 0.15,
        gain: 0.22,
        oscillators: [{ type: "sine", from: 1200, attack: 0.002 }],
    },

    /** Rising major-ish arpeggio, the universal "you got better" signal. */
    powerup: {
        duration: 0.3,
        gain: 0.22,
        oscillators: [
            { type: "sine", from: 440, delay: 0, duration: 0.12 },
            { type: "sine", from: 880, delay: 0.09, duration: 0.12 },
            { type: "sine", from: 1320, delay: 0.18, duration: 0.12 },
        ],
    },

    /** Tiny confirmation blip; fires often, so it stays out of the way. */
    itemPickup: {
        duration: 0.09,
        gain: 0.2,
        oscillators: [{ type: "sine", from: 1000 }],
    },

    /** Two-note fanfare announcing the next wave. */
    waveStart: {
        duration: 0.35,
        gain: 0.25,
        oscillators: [
            { type: "triangle", from: 523, delay: 0, duration: 0.16 },
            { type: "triangle", from: 784, delay: 0.16, duration: 0.19 },
        ],
    },

    /** Long sawtooth slide down — power draining out of the ship. */
    gameOver: {
        duration: 0.9,
        gain: 0.3,
        oscillators: [{ type: "sawtooth", from: 440, to: 110 }],
    },
};

/* ------------------------------------------------------------------ *
 * webkitAudioContext shim
 *
 * Older Safari only exposes the prefixed constructor, which lib.dom does
 * not declare. Augmenting Window teaches TypeScript about it directly, so
 * the lookup below needs no cast at all — neither `any` nor `unknown`.
 * ------------------------------------------------------------------ */

declare global {
    interface Window {
        /** Present only on legacy WebKit; absent everywhere else. */
        webkitAudioContext?: typeof AudioContext;
    }
}

/* ------------------------------------------------------------------ *
 * AudioManager
 * ------------------------------------------------------------------ */

export class AudioManager {
    private audioContext: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private noiseBuffer: AudioBuffer | null = null;

    /** Optional decoded overrides keyed by SoundKey; see loadSound(). */
    private sounds: Map<SoundKey, AudioBuffer> = new Map();

    /** Live source nodes, so dispose() can hard-stop anything sounding. */
    private voices: Set<AudioScheduledSourceNode> = new Set();

    private muted = false;
    private volume = DEFAULT_VOLUME;
    private disposed = false;

    /* ---------------- context lifecycle ---------------- */

    /**
     * The AudioContext is created lazily, never in the constructor: this
     * module is imported during Next's server render, where `window` and
     * `AudioContext` do not exist. Returns null whenever audio is not
     * available so every caller can simply bail.
     */
    private ensureContext(): AudioContext | null {
        if (this.disposed) return null;
        if (this.audioContext) return this.audioContext;
        if (typeof window === "undefined") return null;

        // Both reads are typed: AudioContext comes from lib.dom, the prefixed
        // one from the Window augmentation above. Either can be missing at
        // runtime on old browsers, hence the guard.
        const Ctor: typeof AudioContext | undefined =
            window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) return null;

        try {
            const context = new Ctor();
            const master = context.createGain();
            master.gain.value = this.targetGain();
            master.connect(context.destination);

            this.audioContext = context;
            this.masterGain = master;
            return context;
        } catch (err) {
            // A blocked or exhausted context must not take the game down.
            console.warn("AudioManager: failed to create AudioContext", err);
            this.disposed = true;
            return null;
        }
    }

    /**
     * Chrome's autoplay policy hands back a context in the "suspended" state
     * until a real user gesture resumes it — without this call the game is
     * silent no matter how many voices it schedules. Safe (and cheap) to call
     * on every click/keypress; resume() on a running context is a no-op.
     */
    unlock(): void {
        const context = this.ensureContext();
        if (!context) return;

        if (context.state === "suspended") {
            // Rejects if the gesture requirement is still unmet; ignore it and
            // let the next gesture try again.
            void context.resume().catch(() => undefined);
        }
    }

    /**
     * Closes the context and releases every node. After this the instance is
     * permanently inert; all methods keep working, they just do nothing.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        for (const voice of this.voices) {
            try {
                voice.onended = null;
                voice.stop();
            } catch {
                // Already stopped or never started — nothing to clean up.
            }
        }
        this.voices.clear();
        this.sounds.clear();

        const context = this.audioContext;
        this.audioContext = null;
        this.masterGain = null;
        this.noiseBuffer = null;

        if (context && context.state !== "closed") {
            void context.close().catch(() => undefined);
        }
    }

    /* ---------------- mixer ---------------- */

    /** Master gain target: mute is a gain of 0, not a play()-time branch. */
    private targetGain(): number {
        return this.muted ? 0 : this.volume;
    }

    /**
     * Applied on the shared master node, so a mid-explosion volume change
     * affects voices that are already sounding instead of only new ones.
     */
    private applyMasterGain(): void {
        const context = this.audioContext;
        const master = this.masterGain;
        if (!context || !master) return;

        const now = context.currentTime;
        // Linear (not exponential) is fine here: 0 is a legal target and a
        // 20ms ramp is short enough to feel instant but long enough not to pop.
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(this.targetGain(), now + MASTER_RAMP);
    }

    setMuted(muted: boolean): void {
        this.muted = muted;
        this.applyMasterGain();
    }

    isMuted(): boolean {
        return this.muted;
    }

    /** Flips mute and returns the new state, for direct use in UI handlers. */
    toggleMuted(): boolean {
        this.setMuted(!this.muted);
        return this.muted;
    }

    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        this.applyMasterGain();
    }

    getVolume(): number {
        return this.volume;
    }

    /* ---------------- optional sample override ---------------- */

    /**
     * Decodes a real audio file for `key`. Purely optional: nothing in the
     * game calls this today, but if assets are ever dropped into public/ the
     * decoded buffer takes priority over the synth voice with no other code
     * changes. A failure warns and leaves the synth voice in place.
     */
    async loadSound(key: SoundKey, url: string): Promise<void> {
        if (this.disposed || this.sounds.has(key)) return;

        const context = this.ensureContext();
        if (!context) return;

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await context.decodeAudioData(arrayBuffer);

            // dispose() may have run while we were awaiting.
            if (this.disposed) return;
            this.sounds.set(key, audioBuffer);
        } catch (err) {
            console.warn(`Failed to load sound: ${key}`, err);
        }
    }

    /* ---------------- playback ---------------- */

    /**
     * Plays `key`. `volume` is a per-call scaler (0..1) on top of the master
     * volume, for making an individual effect quieter in context.
     */
    play(key: SoundKey, volume = 1): void {
        if (this.muted || this.disposed) return;

        const context = this.ensureContext();
        const master = this.masterGain;
        if (!context || !master || context.state === "closed") return;

        // A gameplay event is as good a gesture as any: if the context is
        // still suspended, nudge it so the *next* sound lands.
        if (context.state === "suspended") {
            this.unlock();
            return;
        }

        if (this.voices.size >= MAX_VOICES) return;

        const scale = Math.max(0, Math.min(1, volume));
        if (scale === 0) return;

        const override = this.sounds.get(key);
        if (override) {
            this.playBuffer(context, master, override, scale);
            return;
        }

        const spec = VOICES[key];
        if (spec) this.playSpec(context, master, spec, scale);
    }

    /** Straight one-shot playback of a decoded loadSound() buffer. */
    private playBuffer(
        context: AudioContext,
        master: GainNode,
        buffer: AudioBuffer,
        scale: number
    ): void {
        const source = context.createBufferSource();
        source.buffer = buffer;

        const gain = context.createGain();
        gain.gain.value = scale;

        source.connect(gain);
        gain.connect(master);
        this.startSource(source, context.currentTime);
    }

    /** Renders a declarative VoiceSpec into oscillator / noise layers. */
    private playSpec(
        context: AudioContext,
        master: GainNode,
        spec: VoiceSpec,
        scale: number
    ): void {
        const start = context.currentTime;
        const peak = spec.gain * scale;

        for (const layer of spec.oscillators ?? []) {
            if (this.voices.size >= MAX_VOICES) return;

            const delay = layer.delay ?? 0;
            const duration = layer.duration ?? Math.max(spec.duration - delay, 0.01);
            const at = start + delay;

            const osc = context.createOscillator();
            osc.type = layer.type;
            osc.frequency.setValueAtTime(layer.from, at);
            if (layer.to !== undefined && layer.to !== layer.from) {
                // Exponential sweeps track perceived pitch; both endpoints are
                // guaranteed positive Hz values so the ramp is always legal.
                osc.frequency.exponentialRampToValueAtTime(
                    Math.max(layer.to, 1),
                    at + duration
                );
            }
            if (layer.detune) osc.detune.setValueAtTime(layer.detune, at);

            const gain = context.createGain();
            this.envelope(
                gain.gain,
                at,
                duration,
                peak * (layer.gain ?? 1),
                layer.attack ?? DEFAULT_ATTACK
            );

            osc.connect(gain);
            gain.connect(master);
            this.startSource(osc, at, duration);
        }

        for (const layer of spec.noise ?? []) {
            if (this.voices.size >= MAX_VOICES) return;

            const buffer = this.ensureNoiseBuffer(context);
            if (!buffer) continue;

            const delay = layer.delay ?? 0;
            const duration = layer.duration ?? Math.max(spec.duration - delay, 0.01);
            const at = start + delay;

            const source = context.createBufferSource();
            source.buffer = buffer;
            // Random offset so repeated hits do not replay identical samples.
            const offset = Math.random() * Math.max(buffer.duration - duration, 0);

            const gain = context.createGain();
            this.envelope(
                gain.gain,
                at,
                duration,
                peak * (layer.gain ?? 1),
                layer.attack ?? DEFAULT_ATTACK
            );

            if (layer.filterFrom !== undefined) {
                const filter = context.createBiquadFilter();
                filter.type = "lowpass";
                filter.frequency.setValueAtTime(layer.filterFrom, at);
                if (layer.filterTo !== undefined && layer.filterTo !== layer.filterFrom) {
                    filter.frequency.exponentialRampToValueAtTime(
                        Math.max(layer.filterTo, 1),
                        at + duration
                    );
                }
                source.connect(filter);
                filter.connect(gain);
            } else {
                source.connect(gain);
            }

            gain.connect(master);
            this.startSource(source, at, duration, offset);
        }
    }

    /**
     * Standard percussive AD envelope. Both ends ramp to GAIN_FLOOR rather
     * than 0 because exponentialRampToValueAtTime() cannot reach 0, and a
     * plain value jump at either edge is audible as a click.
     */
    private envelope(
        param: AudioParam,
        start: number,
        duration: number,
        peak: number,
        attack: number
    ): void {
        const level = Math.max(peak, GAIN_FLOOR * 2);
        // Never let the attack eat the whole voice on very short sounds.
        const rise = Math.min(Math.max(attack, 0.001), duration * 0.5);

        param.setValueAtTime(GAIN_FLOOR, start);
        param.exponentialRampToValueAtTime(level, start + rise);
        param.exponentialRampToValueAtTime(GAIN_FLOOR, start + duration);
    }

    /**
     * Starts a source, counts it against the voice cap and releases the slot
     * in onended — which the browser fires once the scheduled stop lands, so
     * the count self-corrects even if a voice is cut short.
     */
    private startSource(
        source: AudioScheduledSourceNode,
        at: number,
        duration?: number,
        offset?: number
    ): void {
        this.voices.add(source);
        source.onended = () => {
            source.onended = null;
            this.voices.delete(source);
            try {
                source.disconnect();
            } catch {
                // Already torn down with the context; nothing to do.
            }
        };

        try {
            if (offset !== undefined && source instanceof AudioBufferSourceNode) {
                source.start(at, offset, duration);
            } else {
                source.start(at);
            }

            if (duration !== undefined) {
                // Stop slightly after the envelope bottoms out so the tail is
                // inaudible rather than truncated mid-cycle.
                source.stop(at + duration + STOP_PADDING);
            }
        } catch (err) {
            this.voices.delete(source);
            console.warn("AudioManager: failed to start voice", err);
        }
    }

    /**
     * One second of white noise, generated once and reused by every noise
     * layer — allocating a fresh buffer per explosion would be pure waste.
     */
    private ensureNoiseBuffer(context: AudioContext): AudioBuffer | null {
        if (this.noiseBuffer) return this.noiseBuffer;

        try {
            const length = Math.floor(context.sampleRate * NOISE_BUFFER_SECONDS);
            const buffer = context.createBuffer(1, length, context.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < length; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            this.noiseBuffer = buffer;
            return buffer;
        } catch (err) {
            console.warn("AudioManager: failed to build noise buffer", err);
            return null;
        }
    }
}
