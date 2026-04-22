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

function makeTranslator() {
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
	return { translator, events };
}

describe("ClaudeEventTranslator — tool_use buffering", () => {
	it("emits exactly one tool.started per tool_use block, at content_block_stop", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// content_block_start (tool_use) — should NOT emit tool.started yet
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_1",
					name: "Read",
					input: {},
				},
			},
		} as never);

		const afterStart = events.filter((e) => e.type === "tool.started");
		expect(afterStart).toHaveLength(0);

		// input_json_delta chunks
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"file_path":"/src/main.ts"}',
				},
			},
		} as never);

		// Still no tool.started
		expect(events.filter((e) => e.type === "tool.started")).toHaveLength(0);

		// content_block_stop — NOW tool.started should emit with complete input
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]?.data.input).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
		});

		// No tool.input_updated events should have been emitted
		const inputUpdated = events.filter((e) => e.type === "tool.input_updated");
		expect(inputUpdated).toHaveLength(0);

		// tool.running must come AFTER tool.started
		const toolRunning = events.filter((e) => e.type === "tool.running");
		expect(toolRunning).toHaveLength(1);
		const startIdx = events.findIndex((e) => e.type === "tool.started");
		const runIdx = events.findIndex((e) => e.type === "tool.running");
		expect(runIdx).toBeGreaterThan(startIdx);
	});

	it("emits tool.started with initial input if no deltas arrive", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_2",
					name: "Bash",
					input: { command: "echo hi" },
				},
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]?.data.input).toEqual({
			tool: "Bash",
			command: "echo hi",
		});
	});

	it("emits tool.started before cleanup when stream is interrupted mid-buffering", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// content_block_start but NO content_block_stop (simulates interruption)
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_3",
					name: "Read",
					input: {},
				},
			},
		} as never);

		// Verify tool is in pendingStart state
		expect(ctx.inFlightTools.size).toBe(1);
		const tool = ctx.inFlightTools.get(0);
		expect(tool?.pendingStart).toBe(true);

		// Simulate adapter cleanup: flush pendingStart tools
		await translator.flushPendingTools(ctx);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]?.data.toolName).toBe("Read");

		// tool.completed should also be emitted for the interrupted tool
		const toolCompleted = events.filter((e) => e.type === "tool.completed");
		expect(toolCompleted).toHaveLength(1);
	});

	it("bufferedInput overrides non-empty initial block.input", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_4",
					name: "Bash",
					input: { command: "partial" },
				},
			},
		} as never);

		// Delta overrides with complete input
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"command":"ls -la","description":"list"}',
				},
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]?.data.input).toEqual({
			tool: "Bash",
			command: "ls -la",
			description: "list",
		});
	});

	it("handles multiple concurrent tool_use blocks at different indices", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// Two tool_use blocks started at different indices
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_a",
					name: "Read",
					input: {},
				},
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "toolu_b",
					name: "Bash",
					input: {},
				},
			},
		} as never);

		// Deltas for each
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"file_path":"/a.ts"}',
				},
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 1,
				delta: {
					type: "input_json_delta",
					partial_json: '{"command":"echo hi"}',
				},
			},
		} as never);

		// Stop both
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 1 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(2);
		expect(toolStarted[0]?.data.toolName).toBe("Read");
		expect(toolStarted[1]?.data.toolName).toBe("Bash");
	});

	it("handles partial JSON that fails to parse mid-stream", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_5",
					name: "Grep",
					input: {},
				},
			},
		} as never);

		// Chunk 1: incomplete JSON — should not crash
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"pattern":"TO' },
			},
		} as never);

		// Chunk 2: completes the JSON
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: 'DO"}' },
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]?.data.input).toEqual({
			tool: "Grep",
			pattern: "TODO",
		});
	});
});
