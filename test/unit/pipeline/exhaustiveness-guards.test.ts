import { describe, expect, it } from "vitest";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("Exhaustiveness guards", () => {
	// ─── DB constraint guard ─────────────────────────────────────────────

	describe("DB schema CHECK constraint — message_parts.type", () => {
		let harness: TestHarness;

		it("rejects invalid part type 'reasoning' — CHECK constraint violation", async () => {
			harness = createTestHarness();
			try {
				await harness.seedSession("ses-check");
				// Direct SQL insert bypassing projector
				await harness.execute(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
					["msg-check", "ses-check", "assistant", 1000, 1000],
				);

				// Attempt to insert type='reasoning' — schema CHECK rejects it
				await expect(
					harness.execute(
						"INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						["part-bad", "msg-check", "reasoning", "test", 0, 1000, 1000],
					),
				).rejects.toThrow(); // CHECK(type IN ('text', 'thinking', 'tool'))
			} finally {
				await harness?.close();
			}
		});

		it("rejects unknown part type 'unknown' — CHECK constraint violation", async () => {
			harness = createTestHarness();
			try {
				await harness.seedSession("ses-check-2");
				await harness.execute(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
					["msg-check-2", "ses-check-2", "assistant", 1000, 1000],
				);

				await expect(
					harness.execute(
						"INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						["part-bad-2", "msg-check-2", "unknown", "test", 0, 1000, 1000],
					),
				).rejects.toThrow();
			} finally {
				await harness?.close();
			}
		});

		it("accepts valid part types: text, thinking, tool, file", async () => {
			harness = createTestHarness();
			try {
				await harness.seedSession("ses-check-ok");
				await harness.execute(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
					["msg-check-ok", "ses-check-ok", "assistant", 1000, 1000],
				);

				for (const [idx, type] of [
					"text",
					"thinking",
					"tool",
					"file",
				].entries()) {
					await expect(
						harness.execute(
							"INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
							[`part-ok-${idx}`, "msg-check-ok", type, "test", idx, 1000, 1000],
						),
					).resolves.toBeUndefined();
				}
			} finally {
				await harness?.close();
			}
		});
	});

	// ─── EventPayloadMap key snapshot ────────────────────────────────────

	describe("EventPayloadMap key snapshot", () => {
		it("snapshot of all canonical event types — breaks when new types added", async () => {
			// Dynamic import to get the actual type keys at runtime
			const eventsModule = await import(
				"../../../src/lib/persistence/events.js"
			);

			// Derive known types from the CANONICAL_EVENT_TYPES runtime array —
			// this stays in sync with the EventPayloadMap interface (any drift
			// between them is caught by TypeScript in canonicalEvent/validate).
			const knownTypes = [...eventsModule.CANONICAL_EVENT_TYPES].sort();

			// This list should be updated when new event types are added.
			// If you're adding a new event type, add it here AND add test
			// coverage in the relevant pipeline test file.
			expect(knownTypes).toMatchSnapshot();
		});
	});
});
