// Module customization for `node --test`.
//
// Production modules under test (`src/services/wallet.ts`,
// `src/stores/wallet-store.tsx`) import the `@/` alias, `.tsx` sources, and
// ABI JSON — none of which plain Node resolves. This hook maps `@/` to
// `src/`, serves `.tsx` (JSX-free) as TypeScript and `.json` as JSON, and
// redirects a handful of wallet-only dependencies (wallet connectors,
// toasts, server actions, wagmi hooks) to narrow test doubles under
// `./stubs/`. Everything else (viem, zustand, react) loads for real, and
// specifiers from the existing suites pass straight through.
import { readFile, stat } from "node:fs/promises";

const STUBS = {
    "@/services/bridge": "./stubs/bridge.ts",
    "@/lib/wagmi": "./stubs/wagmi-config.ts",
    "@/app/actions": "./stubs/actions.ts",
    sonner: "./stubs/sonner.ts",
    wagmi: "./stubs/wagmi.ts",
    "wagmi/actions": "./stubs/wagmi-actions.ts",
};

export async function resolve(specifier, context, next) {
    if (Object.hasOwn(STUBS, specifier)) {
        return {
            url: new URL(STUBS[specifier], import.meta.url).href,
            shortCircuit: true,
        };
    }
    if (specifier.startsWith("@/")) {
        // `@/` specifiers are extensionless; probe for the real file the
        // way the bundler would.
        const base = new URL(`../${specifier.slice(2)}`, import.meta.url).href;
        return { url: await withExtension(base), shortCircuit: true };
    }
    if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        context.parentURL?.startsWith("file:")
    ) {
        // Relative sources in `src/` omit extensions (`./bridge-logic`
        // beside the test convention of explicit `.ts`); probe likewise.
        const base = new URL(specifier, context.parentURL).href;
        const probed = await withExtension(base);
        if (probed !== base) return { url: probed, shortCircuit: true };
    }
    return next(specifier, context);
}

/** First existing candidate wins: exact, .ts, .tsx, index files, .json. */
async function withExtension(base) {
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}.json`];
    for (const candidate of candidates) {
        try {
            if ((await stat(new URL(candidate))).isFile()) return candidate;
        } catch {
            // Probe the next candidate.
        }
    }
    return base;
}

export async function load(url, context, next) {
    if (url.endsWith(".tsx")) {
        // The store modules contain no JSX syntax, so Node's type
        // stripping parses them as TypeScript.
        const source = await readFile(new URL(url), "utf8");
        return { format: "module-typescript", source, shortCircuit: true };
    }
    if (url.endsWith(".json")) {
        const source = await readFile(new URL(url), "utf8");
        return { format: "json", source, shortCircuit: true };
    }
    return next(url, context);
}
