import type { Collidable, ImageSource } from "./types";

/* ------------------------------------------------------------------ *
 * Image cache
 * ------------------------------------------------------------------ */

const imageCache: Map<string, HTMLImageElement> = new Map();

export function loadImage(src: ImageSource): HTMLImageElement {
    const srcString = typeof src === "string" ? src : src.src;

    const cached = imageCache.get(srcString);
    if (cached) return cached;

    const img = new Image();
    img.src = srcString;
    imageCache.set(srcString, img);
    return img;
}

export function isDrawable(image: HTMLImageElement): boolean {
    return image.complete && image.naturalWidth > 0;
}

/* ------------------------------------------------------------------ *
 * Array + collision helpers
 * ------------------------------------------------------------------ */

/**
 * Drops dead entries in place, preserving order. The original code rebuilt
 * these arrays with .filter() every frame, allocating garbage for each of the
 * six entity lists on every one of 60 frames per second.
 */
export function compact<T>(list: T[], isDead: (entry: T) => boolean): void {
    let write = 0;
    for (let read = 0; read < list.length; read++) {
        const entry = list[read];
        if (!isDead(entry)) {
            if (write !== read) list[write] = entry;
            write++;
        }
    }
    list.length = write;
}

export function intersects(a: Collidable, b: Collidable): boolean {
    return (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
    );
}

export function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}
