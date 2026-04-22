import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";

// We need to test translateCanonicalEvent directly. It's currently a
// module-private function. We'll export it in step 3 and import here.
// For now, test through the public createRelayEventSink.push() surface.

function makeEvent<T extends CanonicalEvent["type"]>(
	type: T,
	data: Extract<CanonicalEvent, { type: T }>["data"],
	metadata: Record<string, unknown> = {},
): CanonicalEvent {
	return {
		eventId: `evt_test`,
		sessionId: "ses-1",
		type,
		data,
		metadata,
		provider: "claude",
		createdAt: Date.now(),
	} as CanonicalEvent;
}

describe("translateCanonicalEvent — TranslationResult shape", () => {
	// Payload-carrying events MUST produce { kind: "emit", messages: [...] }
	// with at least one message.
	const EMIT_CASES: Array<{
		type: CanonicalEvent["type"];
		data: Record<string, unknown>;
		meta?: Record<string, unknown>;
		expectedTypes: string[];
	}> = [
		{
			type: "text.delta",
			data: { messageId: "m", partId: "p", text: "x" },
			expectedTypes: ["delta"],
		},
		{
			type: "thinking.start",
			data: { messageId: "m", partId: "p" },
			expectedTypes: ["thinking_start"],
		},
		{
			type: "thinking.delta",
			data: { messageId: "m", partId: "p", text: "x" },
			expectedTypes: ["thinking_delta"],
		},
		{
			type: "thinking.end",
			data: { messageId: "m", partId: "p" },
			expectedTypes: ["thinking_stop"],
		},
		{
			type: "tool.started",
			data: {
				messageId: "m",
				partId: "p",
				toolName: "Bash",
				callId: "c",
				input: {},
			},
			expectedTypes: ["tool_start", "tool_executing"],
		},
		{
			type: "tool.completed",
			data: { messageId: "m", partId: "p", result: "ok", duration: 0 },
			expectedTypes: ["tool_result"],
		},
		{
			type: "turn.completed",
			data: {
				messageId: "m",
				tokens: { input: 1, output: 1 },
				cost: 0,
				duration: 0,
			},
			expectedTypes: ["result", "done"],
		},
		{
			type: "turn.error",
			data: { messageId: "m", error: "boom", code: "err" },
			expectedTypes: ["error", "done"],
		},
		{
			type: "turn.interrupted",
			data: { messageId: "m" },
			expectedTypes: ["done"],
		},
		{
			type: "session.status",
			data: { sessionId: "s", status: "retry" },
			meta: { correlationId: "Retrying" },
			expectedTypes: ["error"],
		},
	];

	for (const { type, data, meta, expectedTypes } of EMIT_CASES) {
		it(`${type} returns kind=emit with correct message types`, async () => {
			const sent: Array<{ type: string }> = [];
			const { createRelayEventSink } = await import(
				"../../../src/lib/provider/relay-event-sink.js"
			);
			const sink = createRelayEventSink({
				sessionId: "ses-1",
				send: (msg: unknown) => sent.push(msg as { type: string }),
			});
			await sink.push(makeEvent(type, data as never, meta));
			expect(sent.map((m) => m.type)).toEqual(expectedTypes);
		});
	}

	// Intentionally-silent events MUST NOT produce relay messages.
	const SILENT_CASES: Array<{
		type: CanonicalEvent["type"];
		data: Record<string, unknown>;
	}> = [
		{ type: "tool.running", data: { messageId: "m", partId: "p" } },
		{
			type: "tool.input_updated",
			data: { messageId: "m", partId: "c" },
		},
		{ type: "session.status", data: { sessionId: "s", status: "idle" } },
		{ type: "session.status", data: { sessionId: "s", status: "busy" } },
		{ type: "session.status", data: { sessionId: "s", status: "error" } },
		{
			type: "message.created",
			data: { messageId: "m", role: "assistant", sessionId: "s" },
		},
		{
			type: "session.created",
			data: { sessionId: "s", title: "t", provider: "p" },
		},
		{ type: "session.renamed", data: { sessionId: "s", title: "t" } },
		{
			type: "session.provider_changed",
			data: { sessionId: "s", oldProvider: "a", newProvider: "b" },
		},
		{
			type: "permission.asked",
			data: { id: "p", sessionId: "s", toolName: "Bash", input: {} },
		},
		{ type: "permission.resolved", data: { id: "p", decision: "once" } },
		{
			type: "question.asked",
			data: { id: "q", sessionId: "s", questions: [] },
		},
		{ type: "question.resolved", data: { id: "q", answers: {} } },
	];

	for (const { type, data } of SILENT_CASES) {
		it(`${type} produces zero relay messages (silent)`, async () => {
			const sent: unknown[] = [];
			const { createRelayEventSink } = await import(
				"../../../src/lib/provider/relay-event-sink.js"
			);
			const sink = createRelayEventSink({
				sessionId: "ses-1",
				send: (msg: unknown) => sent.push(msg),
			});
			await sink.push(makeEvent(type, data as never));
			expect(sent).toHaveLength(0);
		});
	}
});
