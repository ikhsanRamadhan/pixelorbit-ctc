/**
 * Multi-touch role resolution.
 *
 * Pure function so the role logic is unit-testable without instantiating
 * Game (which needs canvas, audio, images). The engine stores the resulting
 * pointer ids; this module decides which role a fresh pointer gets.
 */
export type PointerRole = "laser" | "steer";

/**
 * Classifies an incoming pointer: if a finger is already steering, the new
 * pointer is the laser (second finger). Otherwise it steers the ship.
 */
export function pointerRole(isPointerDown: boolean): PointerRole {
  return isPointerDown ? "laser" : "steer";
}
