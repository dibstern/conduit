import { describe, expect, it } from "vitest";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import { copyForkHistory } from "../../../src/lib/persistence/fork-history.js";

const history = [
	canonicalEvent(
		"session.created",
		"parent",
		{ sessionId: "parent", title: "Parent", provider: "claude" },
		{ createdAt: 100 },
	),
	canonicalEvent(
		"permission.asked",
		"parent",
		{ id: "permission", sessionId: "parent", toolName: "Read", input: {} },
		{ createdAt: 101 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{
			sessionId: "parent",
			messageId: "msg_user_1",
			role: "user",
			turnId: "turn_1",
		},
		{ createdAt: 102 },
	),
	canonicalEvent(
		"text.delta",
		"parent",
		{ messageId: "msg_user_1", partId: "prt_user_1", text: "Question" },
		{ createdAt: 103 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: "msg_assistant_1", role: "assistant" },
		{ createdAt: 104 },
	),
	canonicalEvent(
		"thinking.start",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_thinking" },
		{ createdAt: 105 },
	),
	canonicalEvent(
		"thinking.delta",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_thinking", text: "Think" },
		{ createdAt: 106 },
	),
	canonicalEvent(
		"thinking.end",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_thinking" },
		{ createdAt: 107 },
	),
	canonicalEvent(
		"tool.started",
		"parent",
		{
			messageId: "msg_assistant_1",
			partId: "prt_tool",
			callId: "call_1",
			toolName: "Read",
			input: { tool: "Read", filePath: "/file" },
		},
		{ createdAt: 108 },
	),
	canonicalEvent(
		"tool.running",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_tool", callId: "call_1" },
		{ createdAt: 109 },
	),
	canonicalEvent(
		"tool.input_updated",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_tool", input: "updated" },
		{ createdAt: 109.5 },
	),
	canonicalEvent(
		"tool.completed",
		"parent",
		{
			messageId: "msg_assistant_1",
			partId: "prt_tool",
			result: "done",
			duration: 5,
		},
		{ createdAt: 110 },
	),
	canonicalEvent(
		"text.delta",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_answer", text: "Answer" },
		{ createdAt: 111 },
	),
	canonicalEvent(
		"turn.completed",
		"parent",
		{ messageId: "msg_assistant_1" },
		{ createdAt: 112 },
	),
	canonicalEvent(
		"turn.model_resolved",
		"parent",
		{ actualModel: "claude-sonnet" },
		{ createdAt: 113 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: "msg_user_2", role: "user" },
		{ createdAt: 114 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: "msg_assistant_2", role: "assistant" },
		{ createdAt: 115 },
	),
	canonicalEvent(
		"text.delta",
		"parent",
		{ messageId: "msg_assistant_2", partId: "prt_answer_2", text: "Later" },
		{ createdAt: 116 },
	),
	canonicalEvent(
		"turn.completed",
		"parent",
		{ messageId: "msg_assistant_2" },
		{ createdAt: 117 },
	),
] satisfies CanonicalEvent[];

const stored = history.map((event, index) => ({
	...event,
	sequence: index + 1,
	streamVersion: index,
})) satisfies StoredEvent[];

describe("copyForkHistory", () => {
	it("copies a whole turn through tool work and trailing turn events", () => {
		const result = copyForkHistory(stored, {
			newSessionId: "ses_fork_a",
			upToMessageId: "msg_assistant_1",
		});
		expect(result).toBeDefined();
		expect(result?.forkMessageId).toBe("msg_assistant_1_ses_fork_a");
		expect(result?.events.map((event) => event.type)).toEqual([
			"message.created",
			"text.delta",
			"message.created",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
			"tool.started",
			"tool.running",
			"tool.input_updated",
			"tool.completed",
			"text.delta",
			"turn.completed",
			"turn.model_resolved",
		]);
		expect(result?.events.every((event) => event.createdAt < 114)).toBe(true);
		expect(
			result?.events.every((event) => event.sessionId === "ses_fork_a"),
		).toBe(true);
		const tool = result?.events.find((event) => event.type === "tool.started");
		expect(tool?.data).toMatchObject({
			messageId: "msg_assistant_1_ses_fork_a",
			partId: "prt_tool_ses_fork_a",
			callId: "call_1_ses_fork_a",
			toolName: "Read",
		});
		expect(
			result?.events.find((event) => event.type === "tool.running")?.data,
		).toMatchObject({ callId: "call_1_ses_fork_a" });
		expect(result?.events[0]?.data).toMatchObject({ sessionId: "ses_fork_a" });
		expect(result?.events[0]?.data).toMatchObject({
			turnId: "turn_1_ses_fork_a",
		});
		expect(result?.events[0]?.createdAt).toBe(102);
		expect(result?.events[0]?.eventId).toBe(
			`${history[2]?.eventId}_ses_fork_a`,
		);
		expect(result?.events[0]).not.toHaveProperty("sequence");
		expect(result?.events[0]).not.toHaveProperty("streamVersion");
	});

	it("returns undefined for an unknown fork point", () => {
		expect(
			copyForkHistory(stored, {
				newSessionId: "ses_fork",
				upToMessageId: "missing",
			}),
		).toBeUndefined();
	});

	it("copies all message history without a cut and keeps fork ids disjoint", () => {
		const first = copyForkHistory(stored, { newSessionId: "ses_fork_a" });
		const second = copyForkHistory(stored, { newSessionId: "ses_fork_b" });
		expect(first?.forkMessageId).toBe("msg_assistant_2_ses_fork_a");
		expect(first?.events).toHaveLength(stored.length - 2);
		expect(first?.events.map((event) => event.type)).not.toContain(
			"session.created",
		);
		expect(first?.events.map((event) => event.type)).not.toContain(
			"permission.asked",
		);
		expect(new Set(first?.events.map((event) => event.eventId)).size).toBe(
			first?.events.length,
		);
		expect(
			first?.events
				.map((event) => event.eventId)
				.some((id) => second?.events.some((event) => event.eventId === id)),
		).toBe(false);
		const copiedIds = (events: readonly CanonicalEvent[]) =>
			events.flatMap((event) => {
				const data = event.data;
				return [
					"messageId" in data ? data.messageId : undefined,
					"partId" in data ? data.partId : undefined,
					"callId" in data ? data.callId : undefined,
				].filter((id): id is string => typeof id === "string");
			});
		const secondIds = new Set(copiedIds(second?.events ?? []));
		expect(copiedIds(first?.events ?? []).some((id) => secondIds.has(id))).toBe(
			false,
		);
		const originalOrder = ["msg_user_1", "msg_assistant_1", "msg_user_2"];
		expect(originalOrder.map((id) => `${id}_ses_fork_a`).sort()).toEqual(
			[...originalOrder].sort().map((id) => `${id}_ses_fork_a`),
		);
		expect(first?.events.map((event) => event.createdAt)).toEqual(
			history.slice(2).map((event) => event.createdAt),
		);
	});
	it("excludes a prompt queued before the target turn finished", () => {
		const events = [
			canonicalEvent(
				"message.created",
				"parent",
				{ sessionId: "parent", messageId: "msg_a", role: "assistant" },
				{ createdAt: 1 },
			),
			canonicalEvent(
				"message.created",
				"parent",
				{ sessionId: "parent", messageId: "msg_queued", role: "user" },
				{ createdAt: 2 },
			),
			canonicalEvent(
				"text.delta",
				"parent",
				{ messageId: "msg_queued", partId: "prt_q", text: "Next" },
				{ createdAt: 3 },
			),
			canonicalEvent(
				"text.delta",
				"parent",
				{ messageId: "msg_a", partId: "prt_a", text: "Done" },
				{ createdAt: 4 },
			),
			canonicalEvent(
				"turn.completed",
				"parent",
				{ messageId: "msg_a" },
				{ createdAt: 5 },
			),
		] satisfies CanonicalEvent[];
		const result = copyForkHistory(events, {
			newSessionId: "ses_fork",
			upToMessageId: "msg_a",
		});
		expect(
			result?.events.map((event) =>
				"messageId" in event.data ? event.data.messageId : undefined,
			),
		).toEqual(["msg_a_ses_fork", "msg_a_ses_fork", "msg_a_ses_fork"]);
	});

	it("keeps completed compactions before the cut", () => {
		const events = [
			canonicalEvent(
				"session.compaction",
				"parent",
				{
					sessionId: "parent",
					state: "completed",
					detail: "auto",
					preTokens: 900,
					postTokens: 100,
				},
				{ createdAt: 1 },
			),
			canonicalEvent(
				"message.created",
				"parent",
				{ sessionId: "parent", messageId: "msg_a", role: "assistant" },
				{ createdAt: 2 },
			),
		] satisfies CanonicalEvent[];
		const result = copyForkHistory(events, {
			newSessionId: "ses_fork",
			upToMessageId: "msg_a",
		});
		expect(result?.events[0]).toMatchObject({
			type: "session.compaction",
			sessionId: "ses_fork",
			data: { sessionId: "ses_fork", preTokens: 900, postTokens: 100 },
		});
	});
});
