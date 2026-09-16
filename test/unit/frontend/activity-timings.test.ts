// Regression: activity timings collapsed to 0s because per-part timestamps
// were dropped on the way from SQLite to the transcript.
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../../../src/lib/frontend/stores/tool-registry.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	segmentTurns,
	stepDurations,
} from "../../../src/lib/frontend/utils/turns.js";
import type {
	MessagePartRow,
	MessageWithParts,
} from "../../../src/lib/persistence/read-model-types.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";

const T0 = 1_789_475_347_363;

function part(
	o: Partial<MessagePartRow> & { id: string; created_at: number },
): MessagePartRow {
	return {
		message_id: "m1",
		type: "tool",
		text: "",
		tool_name: "Bash",
		call_id: o.id,
		input: null,
		result: "ok",
		metadata: null,
		duration: null,
		status: "completed",
		sort_order: 0,
		updated_at: o.created_at,
		...o,
	} as MessagePartRow;
}

describe("activity timings", () => {
	it("keeps per-step wall-clock for a finished turn", () => {
		const rows: MessageWithParts[] = [
			{
				id: "u1",
				session_id: "s1",
				role: "user",
				text: "go",
				created_at: T0,
				updated_at: T0,
				parts: [
					part({
						id: "up",
						message_id: "u1",
						type: "text",
						text: "go",
						tool_name: null,
						call_id: null,
						status: null,
						result: null,
						created_at: T0,
					}),
				],
			} as unknown as MessageWithParts,
			{
				id: "m1",
				session_id: "s1",
				role: "assistant",
				text: "",
				created_at: T0 + 1_000,
				updated_at: T0 + 61_000,
				parts: [
					part({ id: "p1", created_at: T0 + 1_000, sort_order: 0 }),
					part({ id: "p2", created_at: T0 + 21_000, sort_order: 1 }),
					part({
						id: "p3",
						created_at: T0 + 41_000,
						updated_at: T0 + 61_000,
						sort_order: 2,
					}),
				],
			} as unknown as MessageWithParts,
		];

		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		const chat = historyToChatMessages(messages);
		const turn = segmentTurns(chat, false)[0];
		if (!turn?.segments[0]) throw new Error("expected one segmented turn");
		const steps = stepDurations(turn.segments[0], turn, true, T0 + 61_000);

		expect(steps).toEqual([20_000, 20_000, 20_000]);
	});

	it("stamps live tool steps so an in-flight turn has a clock", () => {
		const registry = createToolRegistry();
		const started = registry.start("call-1", "Bash");
		expect(started.action).toBe("create");
		expect(
			started.action === "create" ? started.tool.createdAt : undefined,
		).toBeTypeOf("number");
	});
});
