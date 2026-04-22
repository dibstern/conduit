// ─── Event Classification ───────────────────────────────────────────────────
// Shared pure functions for classifying relay event streams.
// Used by both server (session-switch) and frontend (replay).
//
// These constants and functions encode the canonical rules for LLM turn
// boundaries. When the LLM starts producing content (delta, thinking, tool use),
// a turn is "active". A turn ends when a `done` or non-retry `error` arrives.
//
// IMPORTANT: `result` is NOT a turn-ending event for LLM activity tracking.
// It carries usage/cost metadata and may appear mid-turn (between tool calls).
// Only `done` and non-retry `error` definitively end a turn.

import type { RelayMessage } from "./types.js";

/** Event types that signal the start of LLM content production. */
export const LLM_CONTENT_START_TYPES: ReadonlySet<RelayMessage["type"]> =
	new Set(["delta", "thinking_start", "tool_start"] as const);

/**
 * Walk a cached event stream and determine whether the last turn is still
 * "active" (started producing LLM content but never received a `done` or
 * non-retry `error`).
 *
 * Mirrors the `llmActive` tracking in the frontend's `replayEvents()`.
 * This is the canonical implementation — frontend and server should both
 * reference this logic.
 *
 * Pure function — no I/O, no side effects.
 */
export function isLastTurnActive(events: readonly RelayMessage[]): boolean {
	let active = false;
	for (const e of events) {
		if (LLM_CONTENT_START_TYPES.has(e.type)) {
			active = true;
		} else if (e.type === "done") {
			active = false;
		} else if (e.type === "error" && e.code !== "RETRY") {
			active = false;
		}
	}
	return active;
}
