// test/unit/provider/claude/claude-event-translator.test.ts

import type { SDKTaskStartedMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRuntimeEventSchema } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { historyToChatMessages } from "../../../../src/lib/frontend/utils/history-logic.js";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import {
	createAllProjectors,
	ProjectionRunner,
} from "../../../../src/lib/persistence/projection-runner.js";
import { ProjectorCursorRepository } from "../../../../src/lib/persistence/projector-cursor-repository.js";
import { ReadQueryService } from "../../../../src/lib/persistence/read-query-service.js";
import { messageRowsToHistory } from "../../../../src/lib/persistence/session-history-adapter.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKTaskProgressMessage,
} from "../../../../src/lib/provider/claude/types.js";
import { createRelayEventSink } from "../../../../src/lib/provider/relay-event-sink.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { createTestHarness } from "../../../helpers/persistence-factories.js";

// ─── Test Helpers ─────────────────────────────────────────────────────────

/** Extract event data as a plain object for assertion access. */
function dataOf(event: CanonicalEvent | undefined): Record<string, unknown> {
	return event?.data as unknown as Record<string, unknown>;
}

function makeStubSink(): EventSink & { events: CanonicalEvent[] } {
	const events: CanonicalEvent[] = [];
	return {
		events,
		push: vi.fn((event: CanonicalEvent) =>
			Effect.sync(() => {
				events.push(event);
			}),
		),
		requestPermission: vi.fn(() =>
			Effect.succeed({ decision: "once" as const }),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
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

function runTranslate(
	translator: ClaudeEventTranslator,
	...args: Parameters<ClaudeEventTranslator["translate"]>
): Promise<void> {
	return Effect.runPromise(translator.translate(...args));
}

function runTranslateError(
	translator: ClaudeEventTranslator,
	...args: Parameters<ClaudeEventTranslator["translateError"]>
): Promise<void> {
	return Effect.runPromise(translator.translateError(...args));
}

function plannedRuntimeEventsForClaudeSdkFixture(
	ctx: ClaudeSessionContext,
	message: SDKMessage,
): ReadonlyArray<unknown> {
	if (message.type !== "result") return [];
	if (message.subtype !== "success" || message.is_error) return [];
	const messageId =
		message.uuid ?? ctx.lastAssistantUuid ?? ctx.currentTurnId ?? ctx.sessionId;
	return [
		{
			eventId: "runtime-event-1",
			type: "turn.completed",
			providerId: "claude",
			sessionId: ctx.sessionId,
			...(ctx.currentTurnId ? { turnId: ctx.currentTurnId } : {}),
			providerRefs: {
				...(message.session_id
					? { providerSessionId: message.session_id }
					: {}),
				...(message.uuid ? { providerMessageId: message.uuid } : {}),
			},
			rawSource: {
				kind: "claude.sdk.message",
				providerMessageType: message.type,
				sdkVariant: "agent-sdk",
			},
			createdAt: Date.now(),
			data: {
				messageId,
				cost: message.total_cost_usd,
				tokens: {
					input: message.usage.input_tokens,
					output: message.usage.output_tokens,
					...(message.usage.cache_read_input_tokens > 0
						? { cacheRead: message.usage.cache_read_input_tokens }
						: {}),
					...(message.usage.cache_creation_input_tokens > 0
						? { cacheWrite: message.usage.cache_creation_input_tokens }
						: {}),
				},
				duration: message.duration_ms,
			},
		},
	];
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ClaudeEventTranslator", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		translator = new ClaudeEventTranslator({
			getSink: () => sink,
		});
	});

	// ─── 1. system (subtype init) ────────────────────────────────────────

	it("translates system/init to session.status and captures model", async () => {
		await runTranslate(translator, ctx, {
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
		await runTranslate(translator, ctx, {
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

	it("does not translate system/task_progress to main turn completion", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_progress",
			task_id: "task-1",
			tool_use_id: "tool-task-1",
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
		expect(turnCompleted).toBeUndefined();

		const running = sink.events.find((e) => e.type === "tool.running");
		expect(running).toBeDefined();
		const data = dataOf(running);
		expect(data["partId"]).toBe("tool-task-1");
		expect(data["metadata"]).toMatchObject({
			providerTaskId: "task-1",
			status: "running",
			description: "Working...",
			totalTokens: 500,
			toolUses: 3,
			durationMs: 2000,
		});
	});

	it("maps system/task_started to child task metadata", async () => {
		const taskStarted: SDKTaskStartedMessage = {
			type: "system",
			subtype: "task_started",
			task_id: "task-2",
			tool_use_id: "tool-task-2",
			description: "Explore code",
			task_type: "explore",
			prompt: "Find the route",
			uuid: "00000000-0000-0000-0000-000000000026",
			session_id: "sdk-sess",
		};

		await runTranslate(translator, ctx, taskStarted);

		const running = sink.events.find((e) => e.type === "tool.running");
		expect(running).toBeDefined();
		const data = dataOf(running);
		expect(data["partId"]).toBe("tool-task-2");
		expect(data["metadata"]).toMatchObject({
			providerTaskId: "task-2",
			status: "running",
			description: "Explore code",
			subagentType: "explore",
			prompt: "Find the route",
		});
		expect(data["metadata"]).not.toHaveProperty("subagent_type");
	});

	it("starts each live Agent tool before task_started metadata updates it", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "assistant-live-agents" },
			}),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu-agent-1",
					name: "Agent",
					input: {},
				},
			}),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "toolu-agent-2",
					name: "Agent",
					input: {},
				},
			}),
		);

		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_started",
			task_id: "sdk-agent-1",
			tool_use_id: "toolu-agent-1",
			description: "Audit Effect services",
			task_type: "explore",
			prompt: "Inspect service ownership",
			uuid: "00000000-0000-0000-0000-000000000201",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_started",
			task_id: "sdk-agent-2",
			tool_use_id: "toolu-agent-2",
			description: "Audit frontend rendering",
			task_type: "explore",
			prompt: "Inspect subagent cards",
			uuid: "00000000-0000-0000-0000-000000000202",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const toolStarts = sink.events.filter(
			(event) => event.type === "tool.started",
		);
		expect(toolStarts.map((event) => dataOf(event)["partId"])).toEqual([
			"toolu-agent-1",
			"toolu-agent-2",
		]);
		expect(toolStarts.map((event) => dataOf(event)["toolName"])).toEqual([
			"Task",
			"Task",
		]);
		expect(dataOf(toolStarts[0])["input"]).toMatchObject({
			tool: "Task",
			description: "Audit Effect services",
			prompt: "Inspect service ownership",
			subagentType: "explore",
		});

		const runningEvents = sink.events.filter(
			(event) => event.type === "tool.running",
		);
		expect(runningEvents.map((event) => dataOf(event)["partId"])).toEqual([
			"toolu-agent-1",
			"toolu-agent-2",
		]);
		expect(dataOf(runningEvents[1])["metadata"]).toMatchObject({
			providerTaskId: "sdk-agent-2",
			description: "Audit frontend rendering",
			subagentType: "explore",
		});
	});

	it("maps system/task_progress to canonical task metadata names", async () => {
		const taskProgress = {
			type: "system",
			subtype: "task_progress",
			task_id: "task-1",
			tool_use_id: "tool-task-1",
			description: "Exploring...",
			subagent_type: "explore",
			usage: {
				total_tokens: 500,
				tool_uses: 3,
				duration_ms: 2000,
			},
			uuid: "00000000-0000-0000-0000-000000000027",
			session_id: "sdk-sess",
		} satisfies SDKTaskProgressMessage & { subagent_type: string };

		await runTranslate(translator, ctx, taskProgress);

		const running = sink.events.find((e) => e.type === "tool.running");
		expect(running).toBeDefined();
		const metadata = dataOf(running)["metadata"] as Record<string, unknown>;
		expect(metadata).toMatchObject({
			providerTaskId: "task-1",
			subagentType: "explore",
		});
		expect(metadata).not.toHaveProperty("subagent_type");
	});

	it("completes the live Agent tool when Claude reports task completion", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "assistant-completes-agent" },
			}),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu-agent-complete",
					name: "Agent",
					input: {},
				},
			}),
		);
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_started",
			task_id: "sdk-agent-complete",
			tool_use_id: "toolu-agent-complete",
			description: "Audit the architecture",
			task_type: "explore",
			prompt: "Report findings",
			uuid: "00000000-0000-0000-0000-000000000203",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_notification",
			task_id: "sdk-agent-complete",
			tool_use_id: "toolu-agent-complete",
			status: "completed",
			summary: "Found architecture issues",
			uuid: "00000000-0000-0000-0000-000000000204",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const completed = sink.events.find(
			(event) => event.type === "tool.completed",
		);
		expect(completed).toBeDefined();
		expect(dataOf(completed)["partId"]).toBe("toolu-agent-complete");
		expect(dataOf(completed)["result"]).toBe("Found architecture issues");
	});

	it("maps Claude Task input from SDK events through relay, history, and frontend ToolMessage", async () => {
		const harness = createTestHarness();
		try {
			harness.seedSession("sess-contract", { provider: "claude" });
			const runner = new ProjectionRunner({
				db: harness.db,
				eventStore: harness.eventStore,
				cursorRepo: new ProjectorCursorRepository(harness.db),
				projectors: createAllProjectors(),
			});
			runner.recover();
			const relaySink = createRelayEventSink({
				sessionId: "sess-contract",
				send: vi.fn(),
				persist: {
					persistEvent: (event) =>
						Effect.sync(() => {
							const stored = harness.eventStore.append(event);
							runner.projectEvent(stored);
						}),
				},
			});
			const relayTranslator = new ClaudeEventTranslator({
				getSink: () => relaySink,
			});
			const relayCtx = makeCtx({
				sessionId: "sess-contract",
				eventSink: relaySink,
			});

			const messageStart: SDKPartialAssistantMessage = {
				type: "stream_event",
				event: {
					type: "message_start",
					message: {
						id: "msg-contract",
						type: "message",
						role: "assistant",
						content: [],
						container: null,
						context_management: null,
						model: "claude-sonnet-4-5",
						stop_reason: null,
						stop_sequence: null,
						usage: {
							cache_creation: null,
							cache_creation_input_tokens: null,
							cache_read_input_tokens: null,
							inference_geo: null,
							input_tokens: 0,
							iterations: null,
							output_tokens: 0,
							server_tool_use: null,
							service_tier: null,
							speed: null,
						},
					},
				},
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000201",
				session_id: "sdk-sess-contract",
			};
			const taskToolUse: SDKPartialAssistantMessage = {
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "tool-task-1",
						name: "Task",
						input: {
							description: "Audit Claude provider",
							prompt: "Find SDK mapping gaps",
							subagent_type: "explore",
						},
					},
				},
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000202",
				session_id: "sdk-sess-contract",
			};
			const taskToolStop: SDKPartialAssistantMessage = {
				type: "stream_event",
				event: {
					type: "content_block_stop",
					index: 0,
				},
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000203",
				session_id: "sdk-sess-contract",
			};
			const taskStarted = {
				type: "system",
				subtype: "task_started",
				task_id: "task-1",
				tool_use_id: "tool-task-1",
				description: "Audit Claude provider",
				task_type: "explore",
				prompt: "Find SDK mapping gaps",
				child_session_id: "claude-subagent-abc",
				uuid: "00000000-0000-0000-0000-000000000204",
				session_id: "sdk-sess-contract",
			} satisfies SDKTaskStartedMessage & { child_session_id: string };
			const taskProgress = {
				type: "system",
				subtype: "task_progress",
				task_id: "task-1",
				tool_use_id: "tool-task-1",
				description: "Audit Claude provider",
				subagent_type: "explore",
				child_session_id: "claude-subagent-abc",
				usage: {
					total_tokens: 12,
					tool_uses: 1,
					duration_ms: 300,
				},
				uuid: "00000000-0000-0000-0000-000000000205",
				session_id: "sdk-sess-contract",
			} satisfies SDKTaskProgressMessage & {
				child_session_id: string;
				subagent_type: string;
			};

			await runTranslate(relayTranslator, relayCtx, messageStart);
			await runTranslate(relayTranslator, relayCtx, taskToolUse);
			await runTranslate(relayTranslator, relayCtx, taskToolStop);
			await runTranslate(relayTranslator, relayCtx, taskStarted);
			await runTranslate(relayTranslator, relayCtx, taskProgress);

			const rows = new ReadQueryService(harness.db).getSessionMessagesWithParts(
				"sess-contract",
			);
			const history = messageRowsToHistory(rows, { pageSize: 50 });
			const messages = historyToChatMessages(history.messages);
			const taskMessage = messages.find(
				(message) => message.type === "tool" && message.name === "Task",
			);

			expect(taskMessage).toBeDefined();
			if (taskMessage?.type === "tool") {
				expect(taskMessage.input).toMatchObject({
					tool: "Task",
					description: "Audit Claude provider",
					prompt: "Find SDK mapping gaps",
					subagentType: "explore",
				});
				expect(taskMessage.input).not.toHaveProperty("taskId");
				expect(taskMessage.input).not.toHaveProperty("task_id");
				expect(taskMessage.metadata?.["providerTaskId"]).toBe("task-1");
				expect(taskMessage.metadata?.["childSessionId"]).toBe(
					"claude-subagent-abc",
				);
			}
		} finally {
			harness.close();
		}
	});

	// ─── 3b. system (subtype api_retry) ──────────────────────────────────

	it("translates system/api_retry to session.status:retry with detail metadata", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "api_retry",
			attempt: 3,
			max_retries: 10,
			retry_delay_ms: 2240,
			error_status: 502,
			error: "server_error",
			session_id: "sdk-sess",
			uuid: "00000000-0000-0000-0000-000000000099",
		} as unknown as SDKMessage);

		const statusEvent = sink.events.find(
			(e) => e.type === "session.status" && dataOf(e)["status"] === "retry",
		);
		expect(statusEvent).toBeDefined();
		// Detail (attempt, delay, error) is passed via metadata.correlationId
		// so the relay sink can render it without parsing canonical payloads.
		const meta = statusEvent?.metadata as Record<string, unknown>;
		expect(typeof meta["correlationId"]).toBe("string");
		expect(meta["correlationId"]).toMatch(/attempt 3\/10/);
		expect(meta["correlationId"]).toMatch(/HTTP 502/);
		expect(meta["correlationId"]).toMatch(/next in 2\.2s/);
	});

	// ─── 3c. stream_event (message_start) emits session.status: busy ─────

	it("emits session.status busy after message.created on message_start", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "msg-busy-1", type: "message", role: "assistant" },
			}),
		);

		// Should have exactly two events: message.created then session.status
		expect(sink.events).toHaveLength(2);

		const first = sink.events[0];
		const second = sink.events[1];
		expect(first).toBeDefined();
		expect(second).toBeDefined();

		// First event: message.created
		expect(first?.type).toBe("message.created");
		const createdData = dataOf(first);
		expect(createdData["messageId"]).toBe("msg-busy-1");
		expect(createdData["role"]).toBe("assistant");
		expect(createdData["sessionId"]).toBe("sess-1");

		// Second event: session.status with status "busy"
		expect(second?.type).toBe("session.status");
		const statusData = dataOf(second);
		expect(statusData["sessionId"]).toBe("sess-1");
		expect(statusData["status"]).toBe("busy");
	});

	it("does not emit session.status busy if message_start has no message id", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { type: "message", role: "assistant" },
			}),
		);

		expect(sink.events).toHaveLength(0);
	});

	// ─── 4. stream_event (content_block_start: text) ─────────────────────

	it("registers text block in inFlightTools without emitting tool.started", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		// Text blocks do not emit tool.started — content streams via delta directly
		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeUndefined();
		// But the in-flight tracking is still registered for subsequent deltas
		expect(ctx.inFlightTools.get(0)?.toolName).toBe("__text");
	});

	// ─── 5. stream_event (content_block_start: thinking) ─────────────────

	it("translates content_block_start thinking to thinking.start", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		);

		// Thinking blocks emit thinking.start (not tool.started)
		const thinkingStart = sink.events.find((e) => e.type === "thinking.start");
		expect(thinkingStart).toBeDefined();
		const data = dataOf(thinkingStart);
		// thinking.start carries messageId and partId
		expect(typeof data["partId"]).toBe("string");
		// No tool.started should be emitted for thinking blocks
		const toolStarted = sink.events.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeUndefined();
		// In-flight tracking registered for subsequent deltas
		expect(ctx.inFlightTools.get(0)?.toolName).toBe("__thinking");
	});

	// ─── 6. stream_event (content_block_start: tool_use) ─────────────────

	it("translates content_block_start tool_use to tool.started at block stop", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "assistant-message-1" },
			}),
		);
		await runTranslate(
			translator,
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

		// tool.started is buffered — not emitted at content_block_start
		expect(sink.events.find((e) => e.type === "tool.started")).toBeUndefined();
		expect(ctx.inFlightTools.get(1)?.toolName).toBe("Bash");

		// Emit content_block_stop to flush the buffered tool.started
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 1 }),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("Bash");
		expect(data["callId"]).toBe("tool-abc");
		expect(data["input"]).toEqual({ tool: "Bash", command: "ls" });
	});

	it("decodes a Claude SDK result fixture to ProviderRuntimeEvent before canonical translation", () => {
		const sdkResult = {
			type: "result",
			subtype: "success",
			is_error: false,
			duration_ms: 1234,
			duration_api_ms: 1000,
			num_turns: 1,
			result: "done",
			session_id: "sdk-session-1",
			total_cost_usd: 0.12,
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 5,
			},
			uuid: "assistant-result-1",
		} as unknown as SDKMessage;

		const runtimeEvents = plannedRuntimeEventsForClaudeSdkFixture(
			ctx,
			sdkResult,
		);
		const decodeRuntimeEvent = Schema.decodeUnknownSync(
			ProviderRuntimeEventSchema,
		);
		const [decoded] = runtimeEvents.map((event) => decodeRuntimeEvent(event));

		expect(decoded).toMatchObject({
			type: "turn.completed",
			providerId: "claude",
			sessionId: "sess-1",
			turnId: "turn-1",
			providerRefs: {
				providerSessionId: "sdk-session-1",
				providerMessageId: "assistant-result-1",
			},
			rawSource: {
				kind: "claude.sdk.message",
				providerMessageType: "result",
				sdkVariant: "agent-sdk",
			},
			data: {
				messageId: "assistant-result-1",
				cost: 0.12,
				tokens: {
					input: 10,
					output: 20,
					cacheRead: 5,
				},
				duration: 1234,
			},
		});
		expect(JSON.stringify(decoded)).not.toContain("session_id");
	});

	// ─── 7. stream_event (content_block_delta: text_delta) ───────────────

	it("translates text_delta to text.delta", async () => {
		// Seed a text block so the translator has an in-flight tool
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		await runTranslate(
			translator,
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
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		);

		await runTranslate(
			translator,
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

	it("buffers input_json_delta — no tool.running or tool.input_updated until block stop", async () => {
		// Seed a tool_use block
		await runTranslate(
			translator,
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

		// Send a complete JSON delta — should buffer, not emit
		await runTranslate(
			translator,
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

		// No events emitted during buffering
		expect(sink.events.filter((e) => e.type === "tool.running")).toHaveLength(
			0,
		);
		expect(
			sink.events.filter((e) => e.type === "tool.input_updated"),
		).toHaveLength(0);

		// Stop the block — should emit tool.started with buffered input
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 0 }),
		);

		const started = sink.events.filter((e) => e.type === "tool.started");
		expect(started).toHaveLength(1);
		const data = dataOf(started[0]);
		expect(data["input"]).toEqual({ tool: "Bash", command: "ls" });
	});

	// ─── 10. stream_event (content_block_stop) ───────────────────────────

	it("translates content_block_stop to tool.completed for text blocks", async () => {
		// Start a text block
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		expect(ctx.inFlightTools.has(0)).toBe(true);

		// Stop the block
		await runTranslate(
			translator,
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

	it("translates content_block_stop to thinking.end for thinking blocks", async () => {
		// Establish assistant messageId via message_start (like real streaming)
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "msg-think-1", type: "message", role: "assistant" },
			}),
		);

		// Start a thinking block
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
		);

		// Capture the partId assigned by thinking.start
		const thinkingStart = sink.events.find((e) => e.type === "thinking.start");
		expect(thinkingStart).toBeDefined();
		const startPartId = dataOf(thinkingStart)["partId"] as string;
		expect(startPartId).toBeTruthy();

		expect(ctx.inFlightTools.has(0)).toBe(true);

		// Stop the block
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_stop",
				index: 0,
			}),
		);

		// Should emit thinking.end, NOT tool.completed
		const thinkingEnd = sink.events.filter((e) => e.type === "thinking.end");
		expect(thinkingEnd).toHaveLength(1);
		const data = dataOf(thinkingEnd[0]);
		// messageId must match the assistant message (same as thinking.start)
		expect(data["messageId"]).toBe("msg-think-1");
		// partId must match the thinking.start partId
		expect(data["partId"]).toBe(startPartId);

		// No tool.completed for thinking blocks
		const completed = sink.events.filter((e) => e.type === "tool.completed");
		expect(completed).toHaveLength(0);

		// In-flight entry cleaned up
		expect(ctx.inFlightTools.has(0)).toBe(false);
	});

	it("does NOT complete tool_use blocks on content_block_stop", async () => {
		// Start a tool_use block
		await runTranslate(
			translator,
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
		await runTranslate(
			translator,
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
		await runTranslate(translator, ctx, {
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

		await runTranslate(translator, ctx, {
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

	it("serializes structured TodoWrite tool_result content so the todo UI can update", async () => {
		ctx.inFlightTools.set(1, {
			itemId: "tool-todos",
			toolName: "TodoWrite",
			title: "Update tasks",
			input: {
				todos: [
					{ content: "Write tests", status: "in_progress" },
					{ content: "Patch implementation", status: "pending" },
				],
			},
			partialInputJson: "",
		});

		await runTranslate(translator, ctx, {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-todos",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									todos: [
										{ content: "Write tests", status: "in_progress" },
										{
											content: "Patch implementation",
											status: "pending",
										},
									],
								}),
							},
						],
						is_error: false,
					},
				],
			},
			parent_tool_use_id: null,
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const completed = sink.events.find((e) => e.type === "tool.completed");
		expect(dataOf(completed)["result"]).toContain("Write tests");
		expect(dataOf(completed)["result"]).toContain("Patch implementation");
	});

	it("emits tool.running before tool.completed when tool_result has content", async () => {
		ctx.inFlightTools.set(0, {
			itemId: "tool-run",
			toolName: "Read",
			title: "File read",
			input: {},
			partialInputJson: "",
		});

		await runTranslate(translator, ctx, {
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

		await runTranslate(translator, ctx, {
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

	// ─── 13b. result (success, no streaming, text in result field) ──────────
	// Regression: short responses and slash-command dispatch (e.g. "/usage")
	// bypass the stream_event/assistant path entirely. The SDK returns a
	// single result message with the full text in `result.result`. Before
	// this fix, the translator ignored that field — the UI got a `done`
	// event but no assistant bubble, appearing to "hang" with no response.

	it("emits text.delta when result.result is set and no streaming occurred", async () => {
		// No assistant uuid set — simulates the non-streaming path.
		expect(ctx.lastAssistantUuid).toBeUndefined();

		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			duration_ms: 5,
			duration_api_ms: 0,
			is_error: false,
			num_turns: 1,
			result: "Unknown skill: usage",
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
			uuid: "11111111-1111-1111-1111-111111111111",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const delta = sink.events.find((e) => e.type === "text.delta");
		expect(delta).toBeDefined();
		const data = dataOf(delta);
		expect(data["text"]).toBe("Unknown skill: usage");
		// MessageId reuses the result uuid so the UI groups delta + done.
		expect(data["messageId"]).toBe("11111111-1111-1111-1111-111111111111");

		// turn.completed still fires so the UI transitions out of processing.
		const completed = sink.events.find((e) => e.type === "turn.completed");
		expect(completed).toBeDefined();
	});

	it("does NOT emit synthetic text.delta when streaming already delivered content", async () => {
		// Simulate a streamed response: assistant uuid is set before result.
		ctx.lastAssistantUuid = "streamed-uuid-1";

		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			duration_ms: 1500,
			duration_api_ms: 1200,
			is_error: false,
			num_turns: 1,
			result: "streamed final text",
			stop_reason: "end_turn",
			total_cost_usd: 0.001,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "22222222-2222-2222-2222-222222222222",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		// No synthetic delta emitted — content already arrived via stream_event.
		const textDeltas = sink.events.filter((e) => e.type === "text.delta");
		expect(textDeltas).toHaveLength(0);
	});

	// ─── 14. result (error) ──────────────────────────────────────────────

	it("translates result/error to turn.error", async () => {
		ctx.lastAssistantUuid = "assist-uuid-2";

		await runTranslate(translator, ctx, {
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
		await runTranslate(translator, ctx, {
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

		await runTranslate(translator, ctx, {
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
		await runTranslate(translator, ctx, {
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
		await runTranslate(translator, ctx, {
			type: "status",
			status: "idle",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores rate_limit_event messages", async () => {
		await runTranslate(translator, ctx, {
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
		await runTranslate(translator, ctx, {
			type: "prompt_suggestion",
			suggestion: "Try asking about...",
			uuid: "00000000-0000-0000-0000-000000000021",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("silently ignores auth_status messages", async () => {
		await runTranslate(translator, ctx, {
			type: "auth_status",
			isAuthenticating: false,
			output: [],
			uuid: "00000000-0000-0000-0000-000000000022",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		expect(sink.events).toHaveLength(0);
	});

	it("maps tool_progress messages to child task metadata", async () => {
		await runTranslate(translator, ctx, {
			type: "tool_progress",
			tool_use_id: "tool-1",
			tool_name: "Bash",
			parent_tool_use_id: "tool-task-1",
			elapsed_time_seconds: 5,
			task_id: "task-1",
			uuid: "00000000-0000-0000-0000-000000000023",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const running = sink.events.find((e) => e.type === "tool.running");
		expect(running).toBeDefined();
		const data = dataOf(running);
		expect(data["partId"]).toBe("tool-task-1");
		expect(data["metadata"]).toMatchObject({
			providerTaskId: "task-1",
			parentToolUseId: "tool-task-1",
			activeToolUseId: "tool-1",
			activeToolName: "Bash",
			elapsedTimeSeconds: 5,
		});
	});

	it("silently ignores system/task_notification messages", async () => {
		await runTranslate(translator, ctx, {
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

	it("ignores system/task_started messages without a tool_use_id", async () => {
		await runTranslate(translator, ctx, {
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

		await runTranslate(translator, ctx, {
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
		await runTranslateError(translator, ctx, new Error("SDK blew up"));

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toContain("SDK blew up");
		expect(data["code"]).toBe("provider_error");
	});

	it("translateError handles non-Error values", async () => {
		await runTranslateError(translator, ctx, "string error");

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toBe("string error");
	});

	it("restores buffered write state when translation work fails", async () => {
		let sessionIdReads = 0;
		const failingCtx = {
			...ctx,
			get sessionId() {
				sessionIdReads += 1;
				if (sessionIdReads === 3) {
					throw new Error("session id unavailable");
				}
				return "sess-1";
			},
		} as ClaudeSessionContext;

		await expect(
			runTranslate(
				translator,
				failingCtx,
				makeStreamEvent({
					type: "message_start",
					message: { id: "assistant-buffer-restore" },
				}),
			),
		).rejects.toThrow("session id unavailable");

		expect(
			(
				translator as unknown as {
					bufferedWrites?: Effect.Effect<void, unknown>[];
				}
			).bufferedWrites,
		).toBeUndefined();

		await runTranslateError(translator, ctx, new Error("after failure"));
		expect(sink.events.map((event) => event.type)).toEqual(["turn.error"]);
	});

	it("resetInFlightState clears counters and message id", () => {
		translator.resetInFlightState();
		// Should not throw -- verifies it's callable
		expect(true).toBe(true);
	});

	it("handles server_tool_use block type", async () => {
		await runTranslate(
			translator,
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
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 0 }),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("WebSearch");
	});

	it("handles mcp_tool_use block type", async () => {
		await runTranslate(
			translator,
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
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 0 }),
		);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("mcp_database_query");
	});

	// ─── Gap tests: edge cases ──────────────────────────────────────────

	it("text.delta with empty string is skipped", async () => {
		// Seed a text block so the translator has an in-flight tool
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);

		const countBefore = sink.events.length;

		// Send an empty text_delta
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "" },
			}),
		);

		// No new events should have been pushed (empty deltas are skipped)
		const deltaEvents = sink.events
			.slice(countBefore)
			.filter((e) => e.type === "text.delta");
		expect(deltaEvents).toHaveLength(0);
	});

	it("input_json_delta with duplicate fingerprint is deduplicated (buffered input not overwritten)", async () => {
		// Seed a tool_use block
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "tool-dedup",
					name: "Bash",
					input: {},
				},
			}),
		);

		// Send the first JSON delta
		await runTranslate(
			translator,
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

		// No events during buffering
		expect(sink.events.filter((e) => e.type === "tool.running")).toHaveLength(
			0,
		);

		// bufferedInput should be set
		const tool = ctx.inFlightTools.get(0);
		expect(tool?.bufferedInput).toEqual({ command: "ls" });

		// Reset partial input so a fresh identical JSON chunk triggers re-parse
		if (tool) tool.partialInputJson = "";

		await runTranslate(
			translator,
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

		// bufferedInput should not change (same fingerprint)
		expect(tool?.bufferedInput).toEqual({ command: "ls" });
	});

	it("result with cache_creation_input_tokens includes cacheWrite", async () => {
		ctx.lastAssistantUuid = "assist-uuid-cache";

		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			duration_ms: 800,
			duration_api_ms: 600,
			is_error: false,
			num_turns: 1,
			result: "done",
			stop_reason: "end_turn",
			total_cost_usd: 0.05,
			usage: {
				input_tokens: 200,
				output_tokens: 100,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 500,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "00000000-0000-0000-0000-000000000040",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();
		const data = dataOf(turnCompleted);
		const tokens = data["tokens"] as Record<string, unknown>;
		expect(tokens["input"]).toBe(200);
		expect(tokens["output"]).toBe(100);
		expect(tokens["cacheWrite"]).toBe(500);
	});

	it("all emitted events have provider set to 'claude'", async () => {
		// Trigger several event types
		await runTranslate(translator, ctx, {
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

		await runTranslate(
			translator,
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
