// Entry point for `node --test --import ./src/test-support/loader.mjs`.
// Registers the resolve/load hooks below for the test process and every
// `node --test` child process it spawns.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
