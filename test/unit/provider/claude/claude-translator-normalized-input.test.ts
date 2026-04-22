import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";

function makeCtx(
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "ses-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-22T00:00:00.000Z",
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

describe("ClaudeEventTranslator — normalized tool input", () => {
	it("tool.started event carries CanonicalToolInput with camelCase fields", async () => {
		const events: CanonicalEvent[] = [];
		const translator = new ClaudeEventTranslator({
			sink: {
				push: async (e: CanonicalEvent) => {
					events.push(e);
				},
				requestPermission: vi.fn(),
				requestQuestion: vi.fn(),
			},
		});

		const ctx = makeCtx();

		// Simulate content_block_start with a Read tool_use block
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_123",
					name: "Read",
					input: { file_path: "/src/main.ts", offset: 10 },
				},
			},
		} as never);

		// Flush buffered tool.started via content_block_stop
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.data.input).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
		});
	});
});
