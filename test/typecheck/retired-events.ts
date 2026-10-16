import type { EventStoreEffect } from "../../src/lib/persistence/effect/event-store-effect.js";
import {
	canonicalEvent,
	type StoredEvent,
} from "../../src/lib/persistence/events.js";

// Compiled by pnpm check, never executed. Each retired type must fail at both
// write boundaries, while the full canonical union remains available to reads.
export function retiredEventsAreReadOnly(
	store: EventStoreEffect,
	tool: Extract<StoredEvent, { type: "tool.input_updated" }>,
	read: Extract<StoredEvent, { type: "session.read" }>,
	unread: Extract<StoredEvent, { type: "session.unread" }>,
) {
	// @ts-expect-error Retired events cannot be constructed.
	canonicalEvent("tool.input_updated", tool.sessionId, tool.data);
	// @ts-expect-error Retired events cannot be constructed.
	canonicalEvent("session.read", read.sessionId, read.data);
	// @ts-expect-error Retired events cannot be constructed.
	canonicalEvent("session.unread", unread.sessionId, unread.data);
	// @ts-expect-error Retired events cannot be appended.
	store.append(tool);
	// @ts-expect-error Retired events cannot be appended.
	store.append(read);
	// @ts-expect-error Retired events cannot be appended.
	store.append(unread);
	// @ts-expect-error Batches cannot append retired events either.
	store.appendBatch([tool]);
	// @ts-expect-error Batches cannot append retired events either.
	store.appendBatch([read]);
	// @ts-expect-error Batches cannot append retired events either.
	store.appendBatch([unread]);
}
