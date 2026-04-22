import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import {
	canonicalEvent,
	createEventId,
} from "../../../src/lib/persistence/events.js";
import {
	createTestHarness,
	FIXED_TEST_TIMESTAMP,
	makeSessionCreatedEvent,
	makeTextDelta,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("EventStore", () => {
	let harness: TestHarness;
	let store: EventStore;

	beforeEach(() => {
		harness = createTestHarness();
		store = harness.eventStore;
	});

	afterEach(() => {
		harness.close();
	});

	describe("append", () => {
		it("appends an event and returns it with sequence and streamVersion", () => {
			harness.seedSession("s1");
			const event = makeSessionCreatedEvent("s1");
			const stored = store.append(event);
			expect(stored.sequence).toBe(1);
			expect(stored.streamVersion).toBe(0);
			expect(stored.eventId).toBe(event.eventId);
			expect(stored.type).toBe("session.created");
			expect(stored.sessionId).toBe("s1");
		});

		it("assigns incrementing stream versions per session", () => {
			harness.seedSession("s1");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			const e2 = store.append(makeTextDelta("s1", "m1", "hello"));
			const e3 = store.append(makeTextDelta("s1", "m1", " world"));
			expect(e1.streamVersion).toBe(0);
			expect(e2.streamVersion).toBe(1);
			expect(e3.streamVersion).toBe(2);
		});

		it("assigns independent stream versions per session", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			const e2 = store.append(makeSessionCreatedEvent("s2"));
			expect(e1.streamVersion).toBe(0);
			expect(e2.streamVersion).toBe(0);
			expect(e1.sequence).toBe(1);
			expect(e2.sequence).toBe(2);
		});

		it("rejects duplicate event IDs", () => {
			harness.seedSession("s1");
			const eventId = createEventId();
			store.append(makeSessionCreatedEvent("s1", { eventId }));
			expect(() =>
				store.append(makeTextDelta("s1", "m1", "x", { eventId })),
			).toThrow();
		});

		it("stores data as JSON", () => {
			harness.seedSession("s1");
			const stored = store.append(makeSessionCreatedEvent("s1"));
			const row = harness.db.queryOne<{ data: string }>(
				"SELECT data FROM events WHERE sequence = ?",
				[stored.sequence],
			);
			expect(row).toBeDefined();
			const parsed = JSON.parse(row?.data ?? "");
			expect(parsed.sessionId).toBe("s1");
			expect(parsed.title).toBe("Test Session");
		});

		it("stores metadata as JSON", () => {
			harness.seedSession("s1");
			const stored = store.append(
				makeSessionCreatedEvent("s1", {
					metadata: { commandId: "cmd_123", adapterKey: "oc" },
				}),
			);
			const row = harness.db.queryOne<{ metadata: string }>(
				"SELECT metadata FROM events WHERE sequence = ?",
				[stored.sequence],
			);
			expect(row).toBeDefined();
			const parsed = JSON.parse(row?.metadata ?? "");
			expect(parsed.commandId).toBe("cmd_123");
			expect(parsed.adapterKey).toBe("oc");
		});
	});

	describe("appendBatch", () => {
		it("appends multiple events atomically", () => {
			harness.seedSession("s1");
			const events = [
				makeSessionCreatedEvent("s1"),
				makeTextDelta("s1", "m1", "hello"),
				makeTextDelta("s1", "m1", " world"),
			];
			const stored = store.appendBatch(events);
			expect(stored).toHaveLength(3);
			expect(stored[0]?.streamVersion).toBe(0);
			expect(stored[1]?.streamVersion).toBe(1);
			expect(stored[2]?.streamVersion).toBe(2);
		});

		it("rolls back all events on failure", () => {
			harness.seedSession("s1");
			const sharedId = createEventId();
			const events = [
				makeSessionCreatedEvent("s1"),
				makeTextDelta("s1", "m1", "hello", { eventId: sharedId }),
				makeTextDelta("s1", "m1", "world", { eventId: sharedId }),
			];
			expect(() => store.appendBatch(events)).toThrow();
			const rows = harness.db.query("SELECT * FROM events");
			expect(rows).toEqual([]);
		});

		it("returns empty array for empty input", () => {
			const stored = store.appendBatch([]);
			expect(stored).toEqual([]);
		});
	});

	describe("readFromSequence", () => {
		it("reads events after a given sequence", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s1", "m1", "b"));
			const events = store.readFromSequence(1, 10);
			expect(events).toHaveLength(2);
			expect(events[0]?.sequence).toBe(2);
		});

		it("reads from the beginning with cursor 0", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			const events = store.readFromSequence(0, 100);
			expect(events).toHaveLength(2);
		});

		it("respects the limit parameter", () => {
			harness.seedSession("s1");
			for (let i = 0; i < 5; i++) {
				store.append(makeTextDelta("s1", "m1", `chunk-${i}`));
			}
			const events = store.readFromSequence(0, 3);
			expect(events).toHaveLength(3);
		});

		it("returns empty array when no events after cursor", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const events = store.readFromSequence(1, 10);
			expect(events).toEqual([]);
		});
	});

	describe("readBySession", () => {
		it("returns only events for the given session", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeSessionCreatedEvent("s2"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s2", "m2", "b"));
			const s1Events = store.readBySession("s1");
			expect(s1Events).toHaveLength(2);
			expect(s1Events.every((e) => e.sessionId === "s1")).toBe(true);
		});

		it("supports fromSequence filter", () => {
			harness.seedSession("s1");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s1", "m1", "b"));
			const events = store.readBySession("s1", e1.sequence);
			expect(events).toHaveLength(2);
		});

		it("returns empty array for unknown session", () => {
			const events = store.readBySession("nonexistent");
			expect(events).toEqual([]);
		});

		it("respects the limit parameter", () => {
			harness.seedSession("s1");
			for (let i = 0; i < 5; i++) {
				store.append(makeTextDelta("s1", "m1", `chunk-${i}`));
			}
			const events = store.readBySession("s1", 0, 3);
			expect(events).toHaveLength(3);
		});
	});

	describe("getNextStreamVersion", () => {
		it("returns 0 for a session with no events", () => {
			harness.seedSession("s1");
			expect(store.getNextStreamVersion("s1")).toBe(0);
		});

		it("returns the next version after existing events", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			expect(store.getNextStreamVersion("s1")).toBe(2);
		});
	});

	describe("deserialization", () => {
		it("round-trips event data through JSON serialization", () => {
			harness.seedSession("s1");
			const input = canonicalEvent(
				"tool.started",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					toolName: "bash",
					callId: "call-1",
					input: { command: "ls -la", nested: { deep: true } },
				},
				{
					metadata: { commandId: "cmd_abc", adapterKey: "oc-main" },
					createdAt: FIXED_TEST_TIMESTAMP,
				},
			);
			store.append(input);
			const [read] = store.readFromSequence(0, 1);
			expect(read).toBeDefined();
			expect(read?.data).toEqual(input.data);
			expect(read?.metadata).toEqual(input.metadata);
		});
	});

	describe("boundary conditions", () => {
		it("accepts createdAt = 0 (epoch zero)", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1", { createdAt: 0 }));
			const read = store.readFromSequence(0);
			expect(read[0]?.createdAt).toBe(0);
		});

		it("handles large data payloads without truncation", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const largeText = "x".repeat(10_000);
			store.append(makeTextDelta("s1", "m1", largeText));
			const read = store.readFromSequence(1);
			expect((read[0]?.data as { text: string }).text).toBe(largeText);
		});

		it("readFromSequence with afterSequence = -1 behaves as 0", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const read = store.readFromSequence(-1);
			expect(read.length).toBe(1);
		});

		it("readBySession with limit = 0 returns empty array", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const read = store.readBySession("s1", 0, 0);
			expect(read).toEqual([]);
		});

		it("concurrent version conflict via two EventStore instances", () => {
			harness.seedSession("s1");
			const store2 = new EventStore(harness.db);
			store.append(makeSessionCreatedEvent("s1"));
			const e2 = store2.append(makeTextDelta("s1", "m1", "hello"));
			expect(e2.streamVersion).toBe(1);
		});
	});

	describe("resetVersionCache", () => {
		it("clears cached versions and falls back to DB query", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s1", "m1", "b"));
			store.resetVersionCache();
			const e4 = store.append(makeTextDelta("s1", "m1", "c"));
			expect(e4.streamVersion).toBe(3);
		});

		it("handles reset with empty store", () => {
			store.resetVersionCache();
			harness.seedSession("s1");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			expect(e1.streamVersion).toBe(0);
		});

		it("handles reset after events from multiple sessions", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeSessionCreatedEvent("s2"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.resetVersionCache();
			const e4 = store.append(makeTextDelta("s1", "m1", "b"));
			const e5 = store.append(makeTextDelta("s2", "m2", "c"));
			expect(e4.streamVersion).toBe(2);
			expect(e5.streamVersion).toBe(1);
		});
	});
});
