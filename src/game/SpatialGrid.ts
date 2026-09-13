import type { Collidable } from "./types";

/* ------------------------------------------------------------------ *
 * Spatial grid — collision broad-phase.
 *
 * Divides the play area into uniform cells. Each entity is inserted into
 * every cell it overlaps; a query returns only the entities sharing a cell
 * with the probe, cutting the pair count from O(n*m) to roughly O(n + k)
 * where k is the candidates near the probe.
 *
 * Two things the previous (unused) implementation got wrong and this one
 * handles:
 *
 *   1. An entity wider than one cell is inserted into several cells, so a
 *      naive query returns it multiple times. Left unguarded that means one
 *      bullet dealing two or three hits to the same enemy. Queries here
 *      de-duplicate through a reused Set.
 *   2. The grid was sized once from the constructor and never resized, so
 *      after a window resize every entity in the new area hashed outside the
 *      bounds check and silently stopped colliding. resize() fixes that.
 * ------------------------------------------------------------------ */

export class SpatialGrid<T extends Collidable> {
    private cellSize: number;
    private cols = 0;
    private rows = 0;

    /** Flat cols*rows array of buckets; index = col * rows + row. */
    private cells: T[][] = [];

    /**
     * Buckets are emptied lazily. clear() only bumps `generation`; a bucket is
     * truncated the first time it is touched in the new generation. Clearing
     * thousands of arrays outright every frame costs more than the lookups.
     */
    private cellGeneration: Int32Array = new Int32Array(0);
    private generation = 1;

    /** Reused across queries so a de-duplicated query allocates nothing. */
    private seen: Set<T> = new Set();

    constructor(width: number, height: number, cellSize: number) {
        this.cellSize = Math.max(1, cellSize);
        this.resize(width, height);
    }

    /** Rebuilds the bucket table for a new viewport. Safe to call every frame. */
    resize(width: number, height: number): void {
        const cols = Math.max(1, Math.ceil(width / this.cellSize) + 1);
        const rows = Math.max(1, Math.ceil(height / this.cellSize) + 1);
        if (cols === this.cols && rows === this.rows) return;

        this.cols = cols;
        this.rows = rows;

        const count = cols * rows;
        this.cells = new Array(count);
        for (let i = 0; i < count; i++) this.cells[i] = [];
        this.cellGeneration = new Int32Array(count);
        this.generation = 1;
    }

    clear(): void {
        this.generation++;
    }

    /** Returns the bucket at `index`, emptied first if it is stale. */
    private bucket(index: number): T[] {
        const cell = this.cells[index];
        if (this.cellGeneration[index] !== this.generation) {
            this.cellGeneration[index] = this.generation;
            cell.length = 0;
        }
        return cell;
    }

    insert(entity: T): void {
        const size = this.cellSize;
        const startCol = Math.max(0, Math.floor(entity.x / size));
        const startRow = Math.max(0, Math.floor(entity.y / size));
        const endCol = Math.min(this.cols - 1, Math.floor((entity.x + entity.width) / size));
        const endRow = Math.min(this.rows - 1, Math.floor((entity.y + entity.height) / size));

        for (let c = startCol; c <= endCol; c++) {
            const base = c * this.rows;
            for (let r = startRow; r <= endRow; r++) {
                this.bucket(base + r).push(entity);
            }
        }
    }

    insertAll(entities: T[], accept?: (entity: T) => boolean): void {
        for (let i = 0; i < entities.length; i++) {
            const entity = entities[i];
            if (accept && !accept(entity)) continue;
            this.insert(entity);
        }
    }

    /**
     * Appends every distinct entity overlapping `probe`'s cells into `out`.
     * The caller owns `out` and is expected to reuse it, so a full collision
     * pass allocates nothing.
     */
    queryInto(probe: Collidable, out: T[]): T[] {
        out.length = 0;

        const size = this.cellSize;
        const startCol = Math.max(0, Math.floor(probe.x / size));
        const startRow = Math.max(0, Math.floor(probe.y / size));
        const endCol = Math.min(this.cols - 1, Math.floor((probe.x + probe.width) / size));
        const endRow = Math.min(this.rows - 1, Math.floor((probe.y + probe.height) / size));
        if (endCol < startCol || endRow < startRow) return out;

        const seen = this.seen;
        seen.clear();

        for (let c = startCol; c <= endCol; c++) {
            const base = c * this.rows;
            for (let r = startRow; r <= endRow; r++) {
                const index = base + r;
                // A stale bucket belongs to a previous frame: treat it as empty
                // rather than resurrecting last frame's entities.
                if (this.cellGeneration[index] !== this.generation) continue;

                const cell = this.cells[index];
                for (let i = 0; i < cell.length; i++) {
                    const entity = cell[i];
                    if (seen.has(entity)) continue;
                    seen.add(entity);
                    out.push(entity);
                }
            }
        }

        return out;
    }
}
