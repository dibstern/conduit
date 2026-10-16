import { describe, expect, it } from "vitest";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("Exhaustiveness guards", () => {
	describe("DB schema accepts provider message part types", () => {
		let harness: TestHarness;

		it("accepts REST reasoning parts", async () => {
			harness = createTestHarness();
			try {
				await harness.seedSession("ses-check");
				// Direct SQL insert bypassing projector
				await harness.execute(
					"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
					["msg-check", "ses-check", "assistant", 1000, 1000],
				);

				// REST reasoning is a distinct part type from Claude's thinking.
				await expect(
					harness.execute(
						"INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						["part-bad", "msg-check", "reasoning", "test", 0, 1000, 1000],
					),
				).resolves.toBeUndefined();
			} finally {
				await harness?.close();
			}
		});

		it("retains future provider part types without a schema change", async () => {
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
				).resolves.toBeUndefined();
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
});
