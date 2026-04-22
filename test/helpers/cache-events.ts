/**
 * Test helper: validate that event arrays only contain persisted event types.
 *
 * The SQLite event store (event-pipeline.ts PERSISTED_EVENT_TYPES) only stores
 * certain event types. Tests that call replayEvents() with hand-crafted
 * event arrays should use this helper to ensure they aren't fabricating
 * events that would never exist in the real store (e.g., "status" events).
 *
 * Usage:
 *   const events = [{ type: "user_message", text: "hi" }, ...];
 *   assertCacheRealisticEvents(events); // throws if any type is non-persisted
 *   replayEvents(events);
 */

import {
	PERSISTED_EVENT_TYPES,
	type PersistedEventType,
} from "../../src/lib/relay/event-pipeline.js";
import type { RelayMessage } from "../../src/lib/shared-types.js";

const persistedSet: ReadonlySet<string> = new Set(PERSISTED_EVENT_TYPES);

/**
 * Assert that every event in the array has a type that would actually be
 * stored in the SQLite event store. Throws with a clear message identifying
 * the offending event type and index.
 */
export function assertCacheRealisticEvents(events: RelayMessage[]): void {
	for (let i = 0; i < events.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const event = events[i]!;
		if (!persistedSet.has(event.type)) {
			throw new Error(
				`Event at index ${i} has type "${event.type}" which is NOT in ` +
					`PERSISTED_EVENT_TYPES. This event would never appear in the ` +
					`event store. Persisted types: ${PERSISTED_EVENT_TYPES.join(", ")}`,
			);
		}
	}
}

/** Type-narrowed version: returns events typed as having persisted types. */
export function asCacheEvents(
	events: RelayMessage[],
): Array<RelayMessage & { type: PersistedEventType }> {
	assertCacheRealisticEvents(events);
	return events as Array<RelayMessage & { type: PersistedEventType }>;
}
