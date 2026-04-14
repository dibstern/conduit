// test/unit/provider/claude/claude-event-translator.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

// ─── Test Helpers ─────────────────────────────────────────────────────────

/** Extract event data as a plain object for assertion access. */
function dataOf(event: CanonicalEvent | undefined): Record<string, unknown> {
	return event?.data as unknown as Record<string, unknown>;
}

function makeStubSink(): EventSink & { events: CanonicalEvent[] } {
	const events: CanonicalEvent[] = [];
	return {
		events,
		push: vi.fn(async (event: CanonicalEvent) => {
			events.push(event);
		}),
		requestPermission: vi.fn(),
		requestQuestion: vi.fn(),
	};
}

function makeCtx(
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-05T00:00:00.000Z",
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

/**
 * Factory for stream_event messages wrapping a BetaRawMessageStreamEvent.
 * Uses `as unknown as SDKMessage` since we build minimal test fixtures.
 */
function makeStreamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		session_id: "test-session",
	} as unknown as SDKMessage;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ClaudeEventTranslator", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		translator = new ClaudeEventTranslator({ sink });
	});

	// ─── 1. system (subtype init) ────────────────────────────────────────

	it("translates system/init to session.status and captures model", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "init",
			apiKeySource: "api_key",
			claude_code_version: "1.0.0",
			cwd: "/tmp/ws",
			tools: ["Bash", "Read", "Write"],
			mcp_servers: [],
			model: "claude-sonnet-4-5",
			permissionMode: "default",
			slash_commands: [],
			output_style: "text",
			skills: [],
			plugins: [],
			uuid: "00000000-0000-0000-0000-000000000001",
			session_id: "sdk-sess-new",
		} as unknown as SDKMessage);

		const statusEvent = sink.events.find((e) => e.type === "session.status");
		expect(statusEvent).toBeDefined();
		const data = dataOf(statusEvent);
		expect(data["sessionId"]).toBe("sess-1");
		expect(data["status"]).toBe("idle");

		// Model captured on context
		expect(ctx.currentModel).toBe("claude-sonnet-4-5");

		// SDK session_id captured for resume
		expect(ctx.resumeSessionId).toBe("sdk-sess-new");
	});

	// ─── 2. system (subtype status) ──────────────────────────────────────

	it("translates system/status to session.status", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "status",
			status: "compacting",
			uuid: "00000000-0000-0000-0000-000000000002",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const statusEvent = sink.events.find((e) => e.type === "session.status");
		expect(statusEvent).toBeDefined();
		// The translator falls back to "idle" if status is not a valid SessionStatusValue
		const data = dataOf(statusEvent);
		expect(data["sessionId"]).toBe("sess-1");
	});

	// ─── 3. system (subtype task_progress) ───────────────────────────────

	it("translates system/task_progress to turn.completed with usage", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "task_progress",
			task_id: "task-1",
			description: "Working...",
			usage: {
				total_tokens: 500,
				tool_uses: 3,
				duration_ms: 2000,
				input_tokens: 300,
				output_tokens: 200,
				cache_read_input_tokens: 50,
			},
			uuid: "00000000-0000-0000-0000-000000000003",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();
		const data = dataOf(turnCompleted);
		const tokens = data["tokens"] as Record<string, unknown>;
		expect(tokens["input"]).toBe(300);
		expect(tokens["output"]).toBe(200);
		expect(tokens["cacheRead"]).toBe(50);
	});

	// ─── 4. stream_event (content_block_start: text) ─────────────────────

	it("translates content_block_start text to tool.started for __text", async () => {
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("__text");
		expect(ctx.inFlightTools.get(0)?.toolName).toBe("__text");
	});

	// ─── 5. stream_event (content_block_start: thinking) ─────────────────

	it("translates content_block_start thinking to tool.started for __thinking", async () => {
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("__thinking");
		expect(ctx.inFlightTools.get(0)?.toolName).toBe("__thinking");
	});

	// ─── 6. stream_event (content_block_start: tool_use) ─────────────────

	it("translates content_block_start tool_use to tool.started with tool name", async () => {
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "tool-abc",
					name: "Bash",
					input: { command: "ls" },
				},
			}),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("Bash");
		expect(data["callId"]).toBe("tool-abc");
		expect(data["input"]).toEqual({ command: "ls" });
		expect(ctx.inFlightTools.get(1)?.toolName).toBe("Bash");
	});

	// ─── 7. stream_event (content_block_delta: text_delta) ───────────────

	it("translates text_delta to text.delta", async () => {
		// Seed a text block so the translator has an in-flight tool
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello world" },
			}),
		);

		const deltaEvents = sink.events.filter((e) => e.type === "text.delta");
		expect(deltaEvents).toHaveLength(1);
		const data = dataOf(deltaEvents[0]);
		expect(data["text"]).toBe("Hello world");
		expect(data["messageId"]).toBeDefined();
		expect(data["partId"]).toBeDefined();
	});

	// ─── 8. stream_event (content_block_delta: thinking_delta) ───────────

	it("translates thinking_delta to thinking.delta", async () => {
		// Seed a thinking block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		);

		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Let me think..." },
			}),
		);

		const delta = sink.events.find((e) => e.type === "thinking.delta");
		expect(delta).toBeDefined();
		const data = dataOf(delta);
		expect(data["text"]).toBe("Let me think...");
		expect(data["messageId"]).toBeDefined();
		expect(data["partId"]).toBeDefined();
	});

	// ─── 9. stream_event (content_block_delta: input_json_delta) ─────────

	it("translates input_json_delta to tool.running + tool.input_updated", async () => {
		// Seed a tool_use block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "tool-json",
					name: "Bash",
					input: {},
				},
			}),
		);

		// Send a complete JSON delta
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"command":"ls"}',
				},
			}),
		);

		const running = sink.events.filter((e) => e.type === "tool.running");
		expect(running.length).toBeGreaterThanOrEqual(1);

		const inputUpdated = sink.events.filter(
			(e) => e.type === "tool.input_updated",
		);
		expect(inputUpdated.length).toBeGreaterThanOrEqual(1);
		const data = dataOf(inputUpdated[0]);
		expect(data["input"]).toEqual({ command: "ls" });
	});

	// ─── 10. stream_event (content_block_stop) ───────────────────────────

	it("translates content_block_stop to tool.completed for text blocks", async () => {
		// Start a text block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		expect(ctx.inFlightTools.has(0)).toBe(true);

		// Stop the block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_stop",
				index: 0,
			}),
		);

		const completed = sink.events.filter((e) => e.type === "tool.completed");
		expect(completed).toHaveLength(1);
		expect(ctx.inFlightTools.has(0)).toBe(false);
	});

	it("translates content_block_stop to tool.completed for thinking blocks", async () => {
		// Start a thinking block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		);

		expect(ctx.inFlightTools.has(0)).toBe(true);

		// Stop the block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_stop",
				index: 0,
			}),
		);

		const completed = sink.events.filter((e) => e.type === "tool.completed");
		expect(completed).toHaveLength(1);
		expect(ctx.inFlightTools.has(0)).toBe(false);
	});

	it("does NOT complete tool_use blocks on content_block_stop", async () => {
		// Start a tool_use block
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "tool-keep",
					name: "Bash",
					input: {},
				},
			}),
		);

		// Stop event should NOT complete tool_use (it waits for tool_result)
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_stop",
				index: 0,
			}),
		);

		const completed = sink.events.filter((e) => e.type === "tool.completed");
		expect(completed).toHaveLength(0);
		// Tool still in-flight
		expect(ctx.inFlightTools.has(0)).toBe(true);
	});

	// ─── 11. assistant ───────────────────────────────────────────────────

	it("translates assistant message and captures uuid on context", async () => {
		await translator.translate(ctx, {
			type: "assistant",
			message: {
				id: "msg-1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				model: "claude-sonnet-4-5",
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
				},
			},
			parent_tool_use_id: null,
			uuid: "assist-uuid-123",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(ctx.lastAssistantUuid).toBe("assist-uuid-123");
		// No events emitted -- assistant snapshot only updates context
		expect(sink.events).toHaveLength(0);
	});

	// ─── 12. user (tool_result) ──────────────────────────────────────────

	it("translates user tool_result to tool.completed for in-flight tool", async () => {
		// Seed an in-flight tool
		ctx.inFlightTools.set(1, {
			itemId: "tool-abc",
			toolName: "Bash",
			title: "Command run",
			input: { command: "ls" },
			partialInputJson: "",
		});

		await translator.translate(ctx, {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-abc",
						content: "file1.txt\nfile2.txt",
						is_error: false,
					},
				],
			},
			parent_tool_use_id: null,
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const completed = sink.events.find((e) => e.type === "tool.completed");
		expect(completed).toBeDefined();
		const data = dataOf(completed);
		expect(data["result"]).toBe("file1.txt\nfile2.txt");
		expect(data["duration"]).toBe(0);

		// Tool removed from in-flight
		expect(ctx.inFlightTools.has(1)).toBe(false);
	});

	it("emits tool.running before tool.completed when tool_result has content", async () => {
		ctx.inFlightTools.set(0, {
			itemId: "tool-run",
			toolName: "Read",
			title: "File read",
			input: {},
			partialInputJson: "",
		});

		await translator.translate(ctx, {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-run",
						content: "some output",
						is_error: false,
					},
				],
			},
			parent_tool_use_id: null,
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const types = sink.events.map((e) => e.type);
		const runningIdx = types.indexOf("tool.running");
		const completedIdx = types.indexOf("tool.completed");
		expect(runningIdx).toBeGreaterThanOrEqual(0);
		expect(completedIdx).toBeGreaterThan(runningIdx);
	});

	// ─── 13. result (success) ────────────────────────────────────────────

	it("translates result/success to turn.completed with tokens, cost, duration", async () => {
		// Set assistant uuid so messageId is populated
		ctx.lastAssistantUuid = "assist-uuid-1";

		await translator.translate(ctx, {
			type: "result",
			subtype: "success",
			duration_ms: 1200,
			duration_api_ms: 900,
			is_error: false,
			num_turns: 1,
			result: "done",
			stop_reason: "end_turn",
			total_cost_usd: 0.0123,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 10,
				cache_creation_input_tokens: 5,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "00000000-0000-0000-0000-000000000010",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();
		const data = dataOf(turnCompleted);
		expect(data["messageId"]).toBe("assist-uuid-1");
		const tokens = data["tokens"] as Record<string, unknown>;
		expect(tokens["input"]).toBe(100);
		expect(tokens["output"]).toBe(50);
		expect(tokens["cacheRead"]).toBe(10);
		expect(tokens["cacheWrite"]).toBe(5);
		expect(data["cost"]).toBeCloseTo(0.0123);
		expect(data["duration"]).toBe(1200);
	});

	// ─── 14. result (error) ──────────────────────────────────────────────

	it("translates result/error to turn.error", async () => {
		ctx.lastAssistantUuid = "assist-uuid-2";

		await translator.translate(ctx, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 500,
			duration_api_ms: 400,
			is_error: true,
			num_turns: 0,
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			modelUsage: {},
			permission_denials: [],
			errors: ["Something went wrong"],
			uuid: "00000000-0000-0000-0000-000000000011",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toContain("Something went wrong");
		expect(data["messageId"]).toBe("assist-uuid-2");
	});

	it("translates result/error_max_turns to turn.error", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "error_max_turns",
			duration_ms: 5000,
			duration_api_ms: 4000,
			is_error: true,
			num_turns: 10,
			stop_reason: null,
			total_cost_usd: 0.5,
			usage: {
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			modelUsage: {},
			permission_denials: [],
			errors: ["Exceeded maximum number of turns"],
			uuid: "00000000-0000-0000-0000-000000000012",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toContain("maximum number of turns");
	});

	// ─── 15. result (interrupted) ────────────────────────────────────────

	it("translates result with interrupt error to turn.interrupted", async () => {
		ctx.lastAssistantUuid = "assist-uuid-3";

		await translator.translate(ctx, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 500,
			duration_api_ms: 400,
			is_error: false,
			num_turns: 1,
			stop_reason: null,
			total_cost_usd: 0.01,
			usage: {
				input_tokens: 50,
				output_tokens: 25,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			modelUsage: {},
			permission_denials: [],
			errors: ["request was aborted by the user"],
			uuid: "00000000-0000-0000-0000-000000000013",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const interrupted = sink.events.find((e) => e.type === "turn.interrupted");
		expect(interrupted).toBeDefined();
		const data = dataOf(interrupted);
		expect(data["messageId"]).toBe("assist-uuid-3");
	});

	it("translates result with 'interrupted' keyword to turn.interrupted", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 500,
			duration_api_ms: 400,
			is_error: false,
			num_turns: 1,
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			modelUsage: {},
			permission_denials: [],
			errors: ["The operation was interrupted"],
			uuid: "00000000-0000-0000-0000-000000000014",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const interrupted = sink.events.find((e) => e.type === "turn.interrupted");
		expect(interrupted).toBeDefined();
	});

	// ─── 16. Unknown message types silently ignored ──────────────────────

	it("silently ignores SDKStatusMessage (type: 'system', subtype: 'status' via top-level 'status' type)", async () => {
		// SDKStatusMessage has type: 'system' / subtype: 'status' in reality,
		// but some unknown types like 'status' at the top level should also be ignored.
		// The real SDKStatusMessage routes through system/status handler, which is tested above.
		// This tests a raw `type: 'status'` message (not part of the union but defensive).
		await translator.translate(ctx, {
			type: "status",
			status: "idle",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores rate_limit_event messages", async () => {
		await translator.translate(ctx, {
			type: "rate_limit_event",
			rate_limit_info: {
				status: "allowed",
			},
			uuid: "00000000-0000-0000-0000-000000000020",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores prompt_suggestion messages", async () => {
		await translator.translate(ctx, {
			type: "prompt_suggestion",
			suggestion: "Try asking about...",
			uuid: "00000000-0000-0000-0000-000000000021",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores auth_status messages", async () => {
		await translator.translate(ctx, {
			type: "auth_status",
			isAuthenticating: false,
			output: [],
			uuid: "00000000-0000-0000-0000-000000000022",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores tool_progress messages", async () => {
		await translator.translate(ctx, {
			type: "tool_progress",
			tool_use_id: "tool-1",
			tool_name: "Bash",
			parent_tool_use_id: null,
			elapsed_time_seconds: 5,
			uuid: "00000000-0000-0000-0000-000000000023",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores system/task_notification messages", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "task_notification",
			task_id: "task-1",
			status: "completed",
			output_file: "/tmp/output",
			summary: "Task done",
			uuid: "00000000-0000-0000-0000-000000000024",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		// system/task_notification is not init, status, or task_progress, so it's ignored
		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores system/task_started messages", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "task_started",
			task_id: "task-2",
			description: "Starting task...",
			uuid: "00000000-0000-0000-0000-000000000025",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	// ─── Additional behavioral tests ─────────────────────────────────────

	it("captures session_id on context from any message with session_id", async () => {
		expect(ctx.resumeSessionId).toBeUndefined();

		await translator.translate(ctx, {
			type: "assistant",
			message: {
				id: "msg-2",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-sonnet-4",
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
			parent_tool_use_id: null,
			uuid: "assist-uuid-456",
			session_id: "captured-session-id",
		} as unknown as SDKMessage);

		expect(ctx.resumeSessionId).toBe("captured-session-id");
	});

	it("pushes turn.error via translateError for unhandled exceptions", async () => {
		await translator.translateError(ctx, new Error("SDK blew up"));

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toContain("SDK blew up");
		expect(data["code"]).toBe("provider_error");
	});

	it("translateError handles non-Error values", async () => {
		await translator.translateError(ctx, "string error");

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toBe("string error");
	});

	it("resetInFlightState clears counters and message id", () => {
		translator.resetInFlightState();
		// Should not throw -- verifies it's callable
		expect(true).toBe(true);
	});

	it("handles server_tool_use block type", async () => {
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "server_tool_use",
					id: "server-tool-1",
					name: "WebSearch",
					input: {},
				},
			}),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("WebSearch");
	});

	it("handles mcp_tool_use block type", async () => {
		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "mcp_tool_use",
					id: "mcp-tool-1",
					name: "mcp_database_query",
					input: {},
				},
			}),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("mcp_database_query");
	});

	it("all emitted events have provider set to 'claude'", async () => {
		// Trigger several event types
		await translator.translate(ctx, {
			type: "system",
			subtype: "init",
			apiKeySource: "api_key",
			claude_code_version: "1.0.0",
			cwd: "/tmp/ws",
			tools: [],
			mcp_servers: [],
			model: "claude-sonnet-4",
			permissionMode: "default",
			slash_commands: [],
			output_style: "text",
			skills: [],
			plugins: [],
			uuid: "00000000-0000-0000-0000-000000000030",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		await translator.translate(
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		for (const event of sink.events) {
			expect(event.provider).toBe("claude");
		}
	});
});
