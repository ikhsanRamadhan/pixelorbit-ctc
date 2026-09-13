import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pointerRole } from "../pointer-role.ts";

describe("pointerRole (GameEngine two-finger laser)", () => {
  test("first finger down → steer", () => {
    assert.equal(pointerRole(false), "steer");
  });

  test("second finger down while steering → laser", () => {
    assert.equal(pointerRole(true), "laser");
  });

  test("third finger down while already steering + lasing → laser", () => {
    // isPointerDown reflects "at least one steer finger is down"; any extra
    // pointer arriving in that state joins as another laser finger.
    assert.equal(pointerRole(true), "laser");
  });

  test("after releasing the steer finger, a new finger steers again", () => {
    // Once isPointerDown returns to false, the next pointer becomes the new
    // steer finger — the role resets with the flag.
    assert.equal(pointerRole(false), "steer");
  });
});
