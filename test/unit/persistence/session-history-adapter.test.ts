// test/unit/persistence/session-history-adapter.test.ts
import { describe, expect, it } from "vitest";
import type {
	MessagePartRow,
	MessageWithParts,
} from "../../../src/lib/persistence/read-query-service.js";
import {
	type HistoryResult,
	messageRowsToHistory,
} from "../../../src/lib/persistence/session-history-adapter.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePartRow(
	id: string,
	messageId: string,
	overrides?: Partial<MessagePartRow>,
): MessagePartRow {
	return {
		id,
		message_id: messageId,
		type: "text",
		text: "",
		tool_name: null,
		call_id: null,
		input: null,
		result: null,
		duration: null,
		status: null,
		sort_order: 0,
		created_at: 1_000_000_000_000,
		updated_at: 1_000_000_000_000,
		...overrides,
	};
}

function makeMessageWithParts(
	id: string,
	overrides?: Partial<MessageWithParts>,
): MessageWithParts {
	return {
		id,
		session_id: "s1",
		turn_id: null,
		role: "user",
		text: "",
		cost: null,
		tokens_in: null,
		tokens_out: null,
		tokens_cache_read: null,
		tokens_cache_write: null,
		is_streaming: 0,
		created_at: 1_000_000_000_000,
		updated_at: 1_000_000_000_000,
		parts: [],
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("messageRowsToHistory", () => {
	it("converts message rows to HistoryMessage format", () => {
		const rows: MessageWithParts[] = [
			makeMessageWithParts("m1", {
				role: "user",
				text: "Hello",
				parts: [makePartRow("p1", "m1", { text: "Hello", created_at: 1000 })],
				created_at: 1000,
			}),
			makeMessageWithParts("m2", {
				role: "assistant",
				text: "Hi there",
				parts: [
					makePartRow("p2", "m2", { text: "Hi there", created_at: 2000 }),
				],
				created_at: 2000,
				cost: 0.01,
				tokens_in: 10,
				tokens_out: 20,
			}),
		];

		const result: HistoryResult = messageRowsToHistory(rows, { pageSize: 50 });
		expect(result.messages).toHaveLength(2);

		const [first, second] = result.messages;
		expect(first?.id).toBe("m1");
		expect(first?.role).toBe("user");
		expect(second?.id).toBe("m2");
		expect(second?.role).toBe("assistant");
		expect(result.hasMore).toBe(false);
	});

	it("sets hasMore=true when rows exceed pageSize", () => {
		const rows = [
			makeMessageWithParts("m1"),
			makeMessageWithParts("m2"),
			makeMessageWithParts("m3"),
		];

		const result = messageRowsToHistory(rows, { pageSize: 2 });
		expect(result.hasMore).toBe(true);
		expect(result.messages).toHaveLength(2);
	});

	it("handles empty result", () => {
		const result = messageRowsToHistory([], { pageSize: 50 });
		expect(result.messages).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it("maps parts from MessagePartRow to HistoryMessagePart", () => {
		const rows: MessageWithParts[] = [
			makeMessageWithParts("m1", {
				parts: [
					makePartRow("p1", "m1", { type: "text", text: "Hello" }),
					makePartRow("p2", "m1", {
						type: "tool",
						text: "",
						tool_name: "bash",
						call_id: "c1",
						input: JSON.stringify({ command: "ls" }),
						status: "completed",
						sort_order: 1,
					}),
				],
			}),
		];

		const result = messageRowsToHistory(rows, { pageSize: 50 });
		const [msg] = result.messages;
		const parts = msg?.parts ?? [];
		expect(parts).toHaveLength(2);

		const [textPart, toolPart] = parts;
		expect(textPart).toMatchObject({ id: "p1", type: "text", text: "Hello" });
		expect(toolPart).toMatchObject({
			id: "p2",
			type: "tool",
			tool: "bash",
			callID: "c1",
		});
		expect(toolPart?.state?.status).toBe("completed");
		expect(toolPart?.state?.input).toEqual({ command: "ls" });
	});

	it("handles invalid JSON in tool input gracefully", () => {
		const rows: MessageWithParts[] = [
			makeMessageWithParts("m1", {
				parts: [
					makePartRow("p1", "m1", {
						type: "tool",
						input: "not-json",
						status: "running",
					}),
				],
			}),
		];

		const result = messageRowsToHistory(rows, { pageSize: 50 });
		const [msg] = result.messages;
		const [part] = msg?.parts ?? [];
		// Invalid JSON falls back to the raw string
		expect(part?.state?.input).toBe("not-json");
	});

	it("includes cost and token fields on assistant messages", () => {
		const rows: MessageWithParts[] = [
			makeMessageWithParts("m1", {
				role: "assistant",
				cost: 0.05,
				tokens_in: 100,
				tokens_out: 200,
				tokens_cache_read: 50,
				tokens_cache_write: 10,
			}),
		];

		const result = messageRowsToHistory(rows, { pageSize: 50 });
		const [msg] = result.messages;
		expect(msg?.cost).toBe(0.05);
		expect(msg?.tokens?.input).toBe(100);
		expect(msg?.tokens?.output).toBe(200);
		expect(msg?.tokens?.cache?.read).toBe(50);
		expect(msg?.tokens?.cache?.write).toBe(10);
	});

	it("omits cost and tokens fields when null", () => {
		const rows = [makeMessageWithParts("m1", { cost: null, tokens_in: null })];
		const result = messageRowsToHistory(rows, { pageSize: 50 });
		const [msg] = result.messages;
		expect(msg?.cost).toBeUndefined();
		expect(msg?.tokens).toBeUndefined();
	});

	it("includes time fields from created_at and updated_at", () => {
		const rows = [
			makeMessageWithParts("m1", { created_at: 1000, updated_at: 2000 }),
		];
		const result = messageRowsToHistory(rows, { pageSize: 50 });
		const [msg] = result.messages;
		expect(msg?.time).toEqual({ created: 1000, completed: 2000 });
	});

	it("does not set state on text parts with no status/input/result", () => {
		const rows: MessageWithParts[] = [
			makeMessageWithParts("m1", {
				parts: [
					makePartRow("p1", "m1", {
						type: "text",
						text: "hello",
						status: null,
						input: null,
						result: null,
					}),
				],
			}),
		];
		const result = messageRowsToHistory(rows, { pageSize: 50 });
		const [msg] = result.messages;
		const [part] = msg?.parts ?? [];
		expect(part?.state).toBeUndefined();
	});
});
