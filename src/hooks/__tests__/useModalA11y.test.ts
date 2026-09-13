import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modalHeaderRow } from "../../lib/ui-tokens.ts";
import { setupModalA11y } from "../useModalA11y.ts";
import {
    __resetBodyScrollLockForTests,
    lockBodyScroll,
    unlockBodyScroll,
} from "../useModalA11y.ts";

// The repo has no DOM test environment (no jsdom/happy-dom; suites run via
// `node --test`), so the hook's React shell is left to typecheck + manual
// verification while its focus-once core (`setupModalA11y`) is driven here
// through minimal hand-rolled fakes.

type KeydownListener = (event: KeyboardEvent) => void;

/** Minimal stand-in for the document surface setupModalA11y touches. */
class FakeDocument {
    activeElement: HTMLElement | null = null;
    private listeners = new Map<string, Set<KeydownListener>>();

    addEventListener(type: string, listener: KeydownListener): void {
        const set = this.listeners.get(type) ?? new Set<KeydownListener>();
        set.add(listener);
        this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: KeydownListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    emit(event: KeyboardEvent): void {
        for (const listener of this.listeners.get("keydown") ?? []) listener(event);
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
}

/** Minimal focusable element: records focus() calls and their options. */
class FakeElement {
    readonly focusCalls: Array<FocusOptions | undefined> = [];
    readonly seenSelectors: string[] = [];
    isConnected = true;
    children: FakeElement[] = [];
    private readonly doc: FakeDocument;

    constructor(doc: FakeDocument) {
        this.doc = doc;
    }

    focus(options?: FocusOptions): void {
        this.focusCalls.push(options);
        this.doc.activeElement = this as unknown as HTMLElement;
    }

    querySelectorAll<T extends HTMLElement>(selector: string): NodeListOf<T> {
        this.seenSelectors.push(selector);
        return this.children as unknown as NodeListOf<T>;
    }

    get focusCount(): number {
        return this.focusCalls.length;
    }
}

const globalScope = globalThis as unknown as { document?: FakeDocument };
let originalDocument: FakeDocument | undefined;
let doc: FakeDocument;

beforeEach(() => {
    originalDocument = globalScope.document;
    doc = new FakeDocument();
    globalScope.document = doc;
});

afterEach(() => {
    if (originalDocument === undefined) delete globalScope.document;
    else globalScope.document = originalDocument;
});

function makePanel(childCount: number): { panel: FakeElement; children: FakeElement[] } {
    const panel = new FakeElement(doc);
    panel.children = Array.from({ length: childCount }, () => new FakeElement(doc));
    return { panel, children: panel.children };
}

function totalFocusCalls(panel: FakeElement): number {
    return panel.focusCount + panel.children.reduce((sum, child) => sum + child.focusCount, 0);
}

function fakeKey(key: string, shiftKey = false): { event: KeyboardEvent; prevented: () => boolean } {
    let defaultPrevented = false;
    const event = {
        key,
        shiftKey,
        preventDefault: () => {
            defaultPrevented = true;
        },
    } as unknown as KeyboardEvent;
    return { event, prevented: () => defaultPrevented };
}

function asElement(fake: FakeElement): HTMLElement {
    return fake as unknown as HTMLElement;
}

describe("modalHeaderRow nowrap option", () => {
    test("default keeps the exact legacy classes (byte-identical)", () => {
        assert.equal(
            modalHeaderRow("cyan"),
            "flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-6 border-b border-cyan-950 pb-3 sm:pb-4 shrink-0",
        );
    });

    test("explicit nowrap:false matches the default", () => {
        assert.equal(modalHeaderRow("cyan", { nowrap: false }), modalHeaderRow("cyan"));
    });

    test("nowrap:true swaps only the wrap class", () => {
        const wrapped = modalHeaderRow("cyan");
        const nowrap = modalHeaderRow("cyan", { nowrap: true });
        assert.equal(nowrap, wrapped.replace("flex-wrap", "flex-nowrap"));
        assert.ok(!nowrap.includes("flex-wrap"));
    });

    test("nowrap works for every accent", () => {
        assert.ok(modalHeaderRow("amber", { nowrap: true }).includes("flex-nowrap"));
        assert.ok(modalHeaderRow("amber", { nowrap: true }).includes("border-amber-950"));
        assert.ok(modalHeaderRow("red", { nowrap: true }).includes("border-red-950"));
        assert.ok(modalHeaderRow("amber").includes("flex-wrap"));
    });
});

describe("setupModalA11y focus-once contract", () => {
    test("re-render with a fresh onClose moves no focus; Escape reaches the latest handler", () => {
        const opener = new FakeElement(doc);
        doc.activeElement = asElement(opener);
        const { panel, children } = makePanel(2);
        const first = children[0];

        let staleCalls = 0;
        let latestCalls = 0;
        let current = (): void => {
            staleCalls += 1;
        };
        const cleanup = setupModalA11y(asElement(panel), () => current);

        // Initial focus lands on the first control, exactly once, without scrolling.
        assert.equal(first.focusCount, 1);
        assert.deepEqual(first.focusCalls[0], { preventScroll: true });
        assert.equal(totalFocusCalls(panel), 1);

        // A store-driven re-render swaps the closure; nothing refocuses.
        current = (): void => {
            latestCalls += 1;
        };
        assert.equal(totalFocusCalls(panel), 1);

        const escape = fakeKey("Escape");
        doc.emit(escape.event);
        assert.equal(escape.prevented(), true);
        assert.equal(staleCalls, 0);
        assert.equal(latestCalls, 1);
        assert.equal(doc.listenerCount("keydown"), 1);
        cleanup();
    });

    test("Tab cycles within the panel and re-queries the list per Tab", () => {
        const opener = new FakeElement(doc);
        doc.activeElement = asElement(opener);
        const { panel, children } = makePanel(3);
        const first = children[0];
        const middle = children[1];
        const last = children[2];
        let closed = 0;
        const cleanup = setupModalA11y(asElement(panel), () => () => {
            closed += 1;
        });

        // Tab on the last control wraps to the first without scrolling.
        doc.activeElement = asElement(last);
        const wrap = fakeKey("Tab");
        doc.emit(wrap.event);
        assert.equal(wrap.prevented(), true);
        assert.equal(first.focusCount, 2);
        assert.deepEqual(first.focusCalls[1], { preventScroll: true });

        // Shift+Tab on the first control wraps to the last.
        doc.activeElement = asElement(first);
        const wrapBack = fakeKey("Tab", true);
        doc.emit(wrapBack.event);
        assert.equal(wrapBack.prevented(), true);
        assert.equal(last.focusCount, 1);

        // A mid-list Tab is left to the browser: no interception, no focus move.
        const before = totalFocusCalls(panel);
        doc.activeElement = asElement(middle);
        const mid = fakeKey("Tab");
        doc.emit(mid.event);
        assert.equal(mid.prevented(), false);
        assert.equal(totalFocusCalls(panel), before);

        // The list is re-queried on mount + every Tab, so swapped stage
        // content is picked up instead of a stale snapshot.
        assert.ok(panel.seenSelectors.length >= 4);

        // Non-Escape/Tab keys are ignored entirely.
        const other = fakeKey("a");
        doc.emit(other.event);
        assert.equal(other.prevented(), false);
        assert.equal(closed, 0);
        cleanup();
    });

    test("empty panel falls back to the panel and traps Tab", () => {
        const opener = new FakeElement(doc);
        doc.activeElement = asElement(opener);
        const { panel } = makePanel(0);
        const cleanup = setupModalA11y(asElement(panel), () => () => {});
        assert.equal(panel.focusCount, 1);
        assert.deepEqual(panel.focusCalls[0], { preventScroll: true });

        const tab = fakeKey("Tab");
        doc.emit(tab.event);
        assert.equal(tab.prevented(), true);
        assert.equal(totalFocusCalls(panel), 1);
        cleanup();
    });

    test("cleanup removes the listener and returns focus to a connected opener", () => {
        const opener = new FakeElement(doc);
        doc.activeElement = asElement(opener);
        const { panel } = makePanel(1);
        let closed = 0;
        const cleanup = setupModalA11y(asElement(panel), () => () => {
            closed += 1;
        });

        cleanup();
        assert.equal(doc.listenerCount("keydown"), 0);
        assert.equal(opener.focusCount, 1);
        assert.deepEqual(opener.focusCalls[0], { preventScroll: true });

        // After unmount, keys no longer reach the handler.
        doc.emit(fakeKey("Escape").event);
        assert.equal(closed, 0);
    });

    test("cleanup skips focus-return when the opener is gone", () => {
        const opener = new FakeElement(doc);
        opener.isConnected = false;
        doc.activeElement = asElement(opener);
        const { panel } = makePanel(1);
        const cleanup = setupModalA11y(asElement(panel), () => () => {});
        cleanup();
        assert.equal(opener.focusCount, 0);
    });
});

describe("useModalA11y source guards", () => {
    const source = readFileSync(new URL("../useModalA11y.ts", import.meta.url), "utf8");

    test("every .focus() call opts out of scrolling", () => {
        const code = source
            .split("\n")
            .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
            .join("\n");
        const all = code.match(/\.focus\(/g) ?? [];
        const guarded = code.match(/\.focus\(\{ preventScroll: true \}\)/g) ?? [];
        assert.ok(all.length > 0);
        assert.equal(guarded.length, all.length);
    });

    test("keydown subscription is mount-only and reads onClose through a ref", () => {
        assert.ok(!source.includes("[onClose]"));
        assert.ok(source.includes("onCloseRef"));
        assert.ok(source.includes("}, [])"));
    });
});

describe("lockBodyScroll ref-counted body lock", () => {
    function fakeBody(initialOverflow = ""): { style: { overflow: string } } {
        const body = { style: { overflow: initialOverflow } };
        (doc as unknown as { body: unknown }).body = body;
        return body;
    }

    test("lock hides body overflow, unlock restores the previous value", () => {
        __resetBodyScrollLockForTests();
        const body = fakeBody();
        lockBodyScroll();
        assert.equal(body.style.overflow, "hidden");
        unlockBodyScroll();
        assert.equal(body.style.overflow, "");
    });

    test("nested modals keep the lock until the last one releases", () => {
        __resetBodyScrollLockForTests();
        const body = fakeBody();
        lockBodyScroll();
        lockBodyScroll();
        unlockBodyScroll();
        assert.equal(body.style.overflow, "hidden");
        unlockBodyScroll();
        assert.equal(body.style.overflow, "");
    });

    test("a pre-existing inline overflow is restored verbatim, not blanked", () => {
        __resetBodyScrollLockForTests();
        const body = fakeBody("auto");
        lockBodyScroll();
        assert.equal(body.style.overflow, "hidden");
        unlockBodyScroll();
        assert.equal(body.style.overflow, "auto");
    });

    test("unbalanced unlock without a lock is a safe no-op", () => {
        __resetBodyScrollLockForTests();
        const body = fakeBody("scroll");
        unlockBodyScroll();
        assert.equal(body.style.overflow, "scroll");
    });
});
