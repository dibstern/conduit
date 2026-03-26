// ─── Cold Cache Repair ───────────────────────────────────────────────────────
// Repairs session event caches loaded from disk after a process restart.
// Removes streaming events from incomplete assistant turns while preserving
// all complete turns and user messages.
//
// Pure function — no I/O, no side effects. Deterministic.

import type { RelayMessage } from "../types.js";

/** Event types that mark a completed assistant turn. */
const TERMINAL_TYPES: ReadonlySet<RelayMessage["type"]> = new Set([
	"done",
	"result",
	"error",
]);

/**
 * Repair a cold session's cached events by removing incomplete assistant turns.
 *
 * Walks the events to find the last terminal event (done/result/error).
 * Keeps everything up to and including that terminal, plus any user_message
 * events after it. Discards streaming events (delta, tool_*, thinking_*)
 * that follow the terminal — these are from an interrupted assistant turn.
 *
 * If no terminal events exist, keeps only user_message events.
 *
 * @returns The repaired events and whether any change was made.
 */
export function repairColdSession(events: readonly RelayMessage[]): {
	repaired: RelayMessage[];
	changed: boolean;
} {
	if (events.length === 0) {
		return { repaired: [], changed: false };
	}

	// Find last terminal event
	let lastTerminalIdx = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		const evt = events[i];
		if (evt && TERMINAL_TYPES.has(evt.type)) {
			lastTerminalIdx = i;
			break;
		}
	}

	// If last event is already terminal, cache is complete
	if (lastTerminalIdx === events.length - 1) {
		return { repaired: events as RelayMessage[], changed: false };
	}

	// Build repaired array: everything up to terminal + user_messages after
	const repaired: RelayMessage[] =
		lastTerminalIdx >= 0 ? events.slice(0, lastTerminalIdx + 1) : [];

	// Scan events after the terminal (or from start if no terminal)
	const scanStart = lastTerminalIdx + 1;
	for (let i = scanStart; i < events.length; i++) {
		const evt = events[i];
		if (evt && evt.type === "user_message") {
			repaired.push(evt);
		}
	}

	// Determine if anything changed
	const changed = repaired.length !== events.length;

	return { repaired, changed };
}
