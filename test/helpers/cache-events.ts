/**
 * Test helper: validate that event arrays only contain cacheable event types.
 *
 * The message cache (event-pipeline.ts CACHEABLE_EVENT_TYPES) only stores
 * certain event types. Tests that call replayEvents() with hand-crafted
 * event arrays should use this helper to ensure they aren't fabricating
 * events that would never exist in the real cache (e.g., "status" events).
 *
 * Usage:
 *   const events = [{ type: "user_message", text: "hi" }, ...];
 *   assertCacheRealisticEvents(events); // throws if any type is non-cacheable
 *   replayEvents(events);
 */

import {
	CACHEABLE_EVENT_TYPES,
	type CacheableEventType,
} from "../../src/lib/relay/event-pipeline.js";
import type { RelayMessage } from "../../src/lib/shared-types.js";

const cacheableSet: ReadonlySet<string> = new Set(CACHEABLE_EVENT_TYPES);

/**
 * Assert that every event in the array has a type that would actually be
 * stored in the message cache. Throws with a clear message identifying
 * the offending event type and index.
 */
export function assertCacheRealisticEvents(events: RelayMessage[]): void {
	for (let i = 0; i < events.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const event = events[i]!;
		if (!cacheableSet.has(event.type)) {
			throw new Error(
				`Event at index ${i} has type "${event.type}" which is NOT in ` +
					`CACHEABLE_EVENT_TYPES. This event would never appear in the ` +
					`message cache. Cacheable types: ${CACHEABLE_EVENT_TYPES.join(", ")}`,
			);
		}
	}
}

/** Type-narrowed version: returns events typed as having cacheable types. */
export function asCacheEvents(
	events: RelayMessage[],
): Array<RelayMessage & { type: CacheableEventType }> {
	assertCacheRealisticEvents(events);
	return events as Array<RelayMessage & { type: CacheableEventType }>;
}
