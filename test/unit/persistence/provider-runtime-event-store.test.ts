import { describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createAllProjectors,
	ProjectionRunner,
} from "../../../src/lib/persistence/projection-runner.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import { ProviderRuntimeEventStore } from "../../../src/lib/persistence/provider-runtime-event-store.js";
import {
	createTestHarness,
	FIXED_TEST_TIMESTAMP,
} from "../../helpers/persistence-factories.js";

const SESSION_ID = "ses-runtime-store";

function runtimeEvent(
	overrides: Partial<ProviderRuntimeEvent> & Pick<ProviderRuntimeEvent, "type">,
): ProviderRuntimeEvent {
	const { type, ...rest } = overrides;
	return {
		eventId: `evt_${type.replaceAll(".", "_")}`,
		type,
		providerId: "claude",
		sessionId: SESSION_ID,
		turnId: "turn-1",
		providerRefs: {
			providerSessionId: "claude-session-1",
			providerMessageId: "msg-1",
		},
		rawSource: { kind: "claude-sdk", sourceSchema: "ClaudeSDKMessageSchema" },
		createdAt: FIXED_TEST_TIMESTAMP,
		data: {},
		...rest,
	};
}

function eventCount(harness: ReturnType<typeof createTestHarness>): number {
	return (
		harness.db.queryOne<{ count: number }>(
			"SELECT COUNT(*) AS count FROM events",
		)?.count ?? 0
	);
}

describe("ProviderRuntimeEventStore", () => {
	it("rejects unknown event envelopes before appending to SQLite", () => {
		const harness = createTestHarness();
		try {
			harness.seedSession(SESSION_ID, { provider: "claude" });
			const store = new ProviderRuntimeEventStore(harness.eventStore);

			expect(() =>
				store.appendUnknown({
					...runtimeEvent({ type: "text.delta" }),
					type: "made.up",
				}),
			).toThrow();
			expect(eventCount(harness)).toBe(0);
		} finally {
			harness.close();
		}
	});

	it("rejects malformed typed runtime events before appending to SQLite", () => {
		const harness = createTestHarness();
		try {
			harness.seedSession(SESSION_ID, { provider: "claude" });
			const store = new ProviderRuntimeEventStore(harness.eventStore);

			expect(() =>
				store.append({
					...runtimeEvent({ type: "text.delta" }),
					rawSource: { kind: "" },
				} as ProviderRuntimeEvent),
			).toThrow(/invalid providerruntimeevent envelope/i);
			expect(eventCount(harness)).toBe(0);
		} finally {
			harness.close();
		}
	});

	it("rejects oversized raw provider metadata before appending to SQLite", () => {
		const harness = createTestHarness();
		try {
			harness.seedSession(SESSION_ID, { provider: "claude" });
			const store = new ProviderRuntimeEventStore(harness.eventStore);

			expect(() =>
				store.append(
					runtimeEvent({
						type: "text.delta",
						metadata: { rawPayload: "x".repeat(20_000) },
						data: { messageId: "msg-1", partId: "part-1", text: "hello" },
					}),
				),
			).toThrow(/raw provider payload/i);
			expect(eventCount(harness)).toBe(0);
		} finally {
			harness.close();
		}
	});

	it("stores provider refs and raw source metadata for decoded runtime events", () => {
		const harness = createTestHarness();
		try {
			harness.seedSession(SESSION_ID, { provider: "claude" });
			const store = new ProviderRuntimeEventStore(harness.eventStore);
			const event = runtimeEvent({
				type: "text.delta",
				providerRefs: {
					providerSessionId: "claude-session-1",
					providerMessageId: "msg-1",
					providerToolUseId: "toolu-1",
				},
				data: { messageId: "msg-1", partId: "part-1", text: "hello" },
			});

			const stored = store.append(event);
			const row = harness.db.queryOne<{ metadata: string }>(
				"SELECT metadata FROM events WHERE sequence = ?",
				[stored.sequence],
			);

			expect(row).toBeDefined();
			expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
				providerRuntimeSource: "provider-runtime",
				providerRefs: event.providerRefs,
				rawSource: event.rawSource,
			});
		} finally {
			harness.close();
		}
	});

	it("replays mixed legacy canonical rows and new runtime rows exactly once", () => {
		const harness = createTestHarness();
		try {
			harness.seedSession(SESSION_ID, { provider: "claude" });
			const runtimeStore = new ProviderRuntimeEventStore(harness.eventStore);

			harness.eventStore.append(
				canonicalEvent(
					"message.created",
					SESSION_ID,
					{ messageId: "msg-1", role: "assistant", sessionId: SESSION_ID },
					{ provider: "claude", createdAt: FIXED_TEST_TIMESTAMP },
				),
			);
			runtimeStore.append(
				runtimeEvent({
					type: "text.delta",
					data: { messageId: "msg-1", partId: "part-1", text: "hello" },
				}),
			);

			const runner = new ProjectionRunner({
				db: harness.db,
				eventStore: harness.eventStore,
				cursorRepo: new ProjectorCursorRepository(harness.db),
				projectors: createAllProjectors(),
			});
			runner.recover();
			runner.recover();

			const message = harness.db.queryOne<{ text: string }>(
				"SELECT text FROM messages WHERE id = ?",
				["msg-1"],
			);
			const part = harness.db.queryOne<{ text: string }>(
				"SELECT text FROM message_parts WHERE id = ?",
				["part-1"],
			);

			expect(message?.text).toBe("hello");
			expect(part?.text).toBe("hello");
		} finally {
			harness.close();
		}
	});
});
