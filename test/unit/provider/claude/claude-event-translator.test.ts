// test/unit/provider/claude/claude-event-translator.test.ts

import { Effect, Schema, TestClock, TestContext } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ProviderRuntimeEvent,
	ProviderRuntimeEventSchema,
} from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { historyToChatMessages } from "../../../../src/lib/frontend/utils/history-logic.js";
import { createToolMessage } from "../../../../src/lib/frontend/utils/tool-message-factory.js";
import { launchRow } from "../../../../src/lib/frontend/utils/turns.js";
import { createTestLogger } from "../../../../src/lib/logger.js";
import { messageRowsToHistory } from "../../../../src/lib/persistence/session-history-adapter.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import { createClaudeMessageOwnership } from "../../../../src/lib/provider/claude/claude-message-ownership.js";
import {
	applyClaudeOwnershipDecisionEffect,
	decideClaudeMessageOwnershipEffect,
} from "../../../../src/lib/provider/claude/claude-message-ownership-runtime.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import { createRelayEventSink } from "../../../../src/lib/provider/relay-event-sink.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { makeSessionBackgroundLiveness } from "../../../../src/lib/session/background-liveness.js";
import { makeEffectProjectionHarness } from "../../../helpers/effect-projection-harness.js";
import { partialFake } from "../../../helpers/partial-fake.js";
import { providerRuntimeEventFromCanonical } from "../../../helpers/provider-runtime-event.js";
import { assertProviderRuntimeStreamInvariants } from "../../../helpers/provider-runtime-stream-invariants.js";

/** Extract event data as a plain object for assertion access. */
function dataOf(
	event: ProviderRuntimeEvent | undefined,
): Record<string, unknown> {
	return event?.data as unknown as Record<string, unknown>;
}

function makeStubSink(): EventSink & { events: ProviderRuntimeEvent[] } {
	const events: ProviderRuntimeEvent[] = [];
	return {
		events,
		push: vi.fn((event: ProviderRuntimeEvent) =>
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
		promptQueue: partialFake<ClaudeSessionContext["promptQueue"]>({
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		}),
		query: partialFake<ClaudeSessionContext["query"]>({
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		}),
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

function makeInitMessage(model: string): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		apiKeySource: "api_key",
		claude_code_version: "1.0.0",
		cwd: "/tmp/ws",
		tools: ["Bash", "Read", "Write"],
		mcp_servers: [],
		model,
		permissionMode: "default",
		slash_commands: [],
		output_style: "text",
		skills: [],
		plugins: [],
		uuid: "00000000-0000-0000-0000-000000000001",
		session_id: "sdk-sess-new",
	} as unknown as SDKMessage;
}

function makeAssistantMessage(model: string): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: "msg-served-by",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			model,
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		parent_tool_use_id: null,
		uuid: "00000000-0000-0000-0000-000000000002",
		session_id: "sdk-sess-new",
	} as unknown as SDKMessage;
}

// Tools seeded into ctx.inFlightTools before the first translate call opened
// mid-turn — their tool.started happened "before the test window". Snapshot
// them so the afterEach invariant check doesn't flag their running/completed
// events as orphans. Captured on the FIRST call only: tools the translator
// itself registers mid-stream must still earn a real tool.started.
let seededToolPartIds: Set<string> | null = null;

function runTranslate(
	translator: ClaudeEventTranslator,
	...args: Parameters<ClaudeEventTranslator["translate"]>
): Promise<void> {
	const [ctx] = args;
	seededToolPartIds ??= new Set(
		[...ctx.inFlightTools.values()].map((tool) => tool.itemId),
	);
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
				providerCostTotalUsd: message.total_cost_usd,
				providerSessionId: message.session_id,
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

describe("ClaudeEventTranslator", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;
	let logger: ReturnType<typeof createTestLogger>;

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		seededToolPartIds = null;
		logger = createTestLogger();
		logger.warn = vi.fn();
		translator = new ClaudeEventTranslator({
			getSink: () => sink,
			logger,
		});
	});

	// Scenario assertions above say what should happen; this says what must
	// never happen (phantom tools, self-minted messageIds, malformed
	// envelopes) — across every scenario in this file.
	afterEach(() => {
		assertProviderRuntimeStreamInvariants(sink.events, {
			preStartedToolPartIds: seededToolPartIds ?? [],
		});
	});

	// 1. system (subtype init)

	it("emits matching model evidence before idle without changing the requested model", async () => {
		ctx.currentModel = "sonnet";
		ctx.expectedApiModelId = "claude-sonnet-5";
		await runTranslate(translator, ctx, makeInitMessage("claude-sonnet-5"));

		// init also carries the permission mode the SDK is actually running in,
		// and this is the session's first, so it reports alongside the model.
		expect(sink.events.map((event) => event.type)).toEqual([
			"turn.model_resolved",
			"session.permission_mode_changed",
			"workspace.changed",
			"session.status",
		]);
		expect(dataOf(sink.events[0])).toEqual({
			requestedModel: "sonnet",
			expectedModel: "claude-sonnet-5",
			actualModel: "claude-sonnet-5",
		});

		const statusEvent = sink.events.find((e) => e.type === "session.status");
		expect(statusEvent).toBeDefined();
		const data = dataOf(statusEvent);
		expect(data["sessionId"]).toBe("sess-1");
		expect(data["status"]).toBe("idle");

		expect(ctx.currentModel).toBe("sonnet");
		expect(logger.warn).not.toHaveBeenCalled();

		// SDK session_id captured for resume
		expect(ctx.resumeSessionId).toBe("sdk-sess-new");
	});

	it("emits unequal evidence and logs one model-drift warning", async () => {
		ctx.currentModel = "sonnet";
		ctx.expectedApiModelId = "claude-sonnet-5";

		await runTranslate(translator, ctx, makeInitMessage("claude-opus-5[1m]"));

		expect(dataOf(sink.events[0])).toEqual({
			requestedModel: "sonnet",
			expectedModel: "claude-sonnet-5",
			actualModel: "claude-opus-5[1m]",
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain("sess-1");
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain("sonnet");
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain(
			"claude-sonnet-5",
		);
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain(
			"claude-opus-5[1m]",
		);
	});

	it("treats a context-window suffix as the same model across both reports", async () => {
		// The two channels disagree about `[1m]`: `init` echoes conduit's
		// outbound id, the assistant message reports the bare API id. Same
		// model, so the turn resolves once and nothing warns.
		ctx.currentModel = "opus[1m]";
		ctx.expectedApiModelId = "claude-opus-5[1m]";

		await runTranslate(translator, ctx, makeInitMessage("claude-opus-5[1m]"));
		await runTranslate(translator, ctx, makeAssistantMessage("claude-opus-5"));

		expect(
			sink.events.filter((event) => event.type === "turn.model_resolved"),
		).toHaveLength(1);
		expect(dataOf(sink.events[0])).toEqual({
			requestedModel: "opus[1m]",
			expectedModel: "claude-opus-5[1m]",
			actualModel: "claude-opus-5[1m]",
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("still resolves again when the served model genuinely changes", async () => {
		ctx.currentModel = "opus[1m]";
		ctx.expectedApiModelId = "claude-opus-5[1m]";

		await runTranslate(translator, ctx, makeInitMessage("claude-opus-5[1m]"));
		await runTranslate(
			translator,
			ctx,
			makeAssistantMessage("claude-sonnet-5"),
		);

		const resolved = sink.events.filter(
			(event) => event.type === "turn.model_resolved",
		);
		expect(resolved).toHaveLength(2);
		expect(dataOf(resolved[1])).toEqual({
			requestedModel: "opus[1m]",
			expectedModel: "claude-opus-5[1m]",
			actualModel: "claude-sonnet-5",
		});
	});

	it("does not treat a locally generated reply as the serving model", async () => {
		// Claude Code answers quota exhaustion and unsupported slash commands
		// itself, labelling the message `<synthetic>`. No model served it.
		ctx.currentModel = "opus";
		ctx.expectedApiModelId = "claude-opus-5-5";

		await runTranslate(translator, ctx, makeInitMessage("claude-opus-5-5"));
		await runTranslate(translator, ctx, makeAssistantMessage("<synthetic>"));

		expect(
			sink.events
				.filter((event) => event.type === "turn.model_resolved")
				.map((event) => dataOf(event)["actualModel"]),
		).toEqual(["claude-opus-5-5"]);
	});

	it("warns when init reports a different model than expected", async () => {
		ctx.currentModel = "opus[1m]";
		ctx.expectedApiModelId = "claude-opus-5[1m]";

		await runTranslate(translator, ctx, makeInitMessage("claude-sonnet-5"));

		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"requested without expected",
			{ currentModel: "sonnet" },
			{
				requestedModel: "sonnet",
				actualModel: "claude-sonnet-5",
			},
		],
		[
			"actual only",
			{ currentModel: undefined },
			{ actualModel: "claude-sonnet-5" },
		],
	] as const)("emits %s evidence without warning", async (_name, overrides, data) => {
		Object.assign(ctx, overrides);

		await runTranslate(translator, ctx, makeInitMessage("claude-sonnet-5"));

		expect(dataOf(sink.events[0])).toEqual(data);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	// 2. system (subtype status)

	it("translates system/status to session.status", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "status",
			status: "requesting",
			uuid: "00000000-0000-0000-0000-000000000002",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const statusEvent = sink.events.find((e) => e.type === "session.status");
		expect(statusEvent).toBeDefined();
		// "requesting" means the SDK is issuing an API call — busy, not idle.
		// (Compaction statuses are handled separately as session.compaction —
		// see the compaction tests below.)
		const data = dataOf(statusEvent);
		expect(data["sessionId"]).toBe("sess-1");
		expect(data["status"]).toBe("busy");
	});

	it("translates a null system/status to idle", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "status",
			status: null,
			uuid: "00000000-0000-0000-0000-000000000003",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const statusEvent = sink.events.find((e) => e.type === "session.status");
		expect(dataOf(statusEvent)["status"]).toBe("idle");
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

	it("starts a real Bash tool for a backgrounded shell reported as a task", async () => {
		// Claude reports `run_in_background` Bash shells through the same
		// task_started/task_notification channel as subagents, with
		// subagent_type "local_bash" and a tool_use_id conduit never saw as a
		// streamed tool_use block. Emitting tool.completed for it leaves an
		// orphan the ingress mapper renders as a phantom "Unknown {}" card.
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_started",
			task_id: "batefivs0",
			tool_use_id: "toolu-local-bash",
			description: "codex exec --color never review",
			task_type: "local_bash",
			uuid: "00000000-0000-0000-0000-000000000301",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "task_notification",
			task_id: "batefivs0",
			tool_use_id: "toolu-local-bash",
			status: "completed",
			summary: "codex exec --color never review",
			uuid: "00000000-0000-0000-0000-000000000302",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const started = sink.events.filter((e) => e.type === "tool.started");
		const completed = sink.events.filter((e) => e.type === "tool.completed");
		expect(started).toHaveLength(1);
		expect(dataOf(started[0])).toMatchObject({
			partId: "toolu-local-bash",
			toolName: "Bash",
			input: { tool: "Bash", command: "codex exec --color never review" },
		});
		expect(completed).toHaveLength(1);
		expect(dataOf(completed[0])["partId"]).toBe("toolu-local-bash");
	});

	it("maps assistant snapshot thinking blocks through relay, history, and frontend messages", async () => {
		const harness = makeEffectProjectionHarness();
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"sess-thinking-snapshot",
					"claude",
					"Test",
					"idle",
					Date.now(),
					Date.now(),
				],
			);
			const relaySink = createRelayEventSink({
				sessionId: "sess-thinking-snapshot",
				persist: {
					persistEvent: (event) =>
						Effect.promise(() =>
							harness
								.ingest(providerRuntimeEventFromCanonical(event))
								.then(() => undefined),
						),
				},
			});
			const relayTranslator = new ClaudeEventTranslator({
				getSink: () => relaySink,
			});
			const relayCtx = makeCtx({
				sessionId: "sess-thinking-snapshot",
				eventSink: relaySink,
			});

			await runTranslate(relayTranslator, relayCtx, {
				type: "assistant",
				message: {
					id: "msg-thinking-snapshot",
					type: "message",
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "visible Claude thought" },
						{ type: "text", text: "final answer" },
					],
					model: "claude-sonnet-4-5",
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
					},
				},
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000206",
				session_id: "sdk-sess-thinking-snapshot",
			} as unknown as SDKMessage);

			const rows = await harness.sessionMessagesWithParts(
				"sess-thinking-snapshot",
			);
			const history = messageRowsToHistory(rows, { pageSize: 50 });
			const messages = historyToChatMessages(history.messages);

			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "thinking",
						text: "visible Claude thought",
						done: true,
					}),
					expect.objectContaining({
						type: "assistant",
						rawText: "final answer",
					}),
				]),
			);
		} finally {
			await harness.dispose();
		}
	});

	it("persists the result context window through history hydration", async () => {
		const harness = makeEffectProjectionHarness();
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"sess-context-window",
					"claude",
					"Test",
					"idle",
					Date.now(),
					Date.now(),
				],
			);
			const relaySink = createRelayEventSink({
				sessionId: "sess-context-window",
				persist: {
					persistEvent: (event) =>
						Effect.promise(() =>
							harness
								.ingest(providerRuntimeEventFromCanonical(event))
								.then(() => undefined),
						),
				},
			});
			const relayTranslator = new ClaudeEventTranslator({
				getSink: () => relaySink,
			});
			const relayCtx = makeCtx({
				sessionId: "sess-context-window",
				eventSink: relaySink,
				currentApiModelId: "claude-sonnet-4[1m]",
			});

			await runTranslate(relayTranslator, relayCtx, {
				type: "assistant",
				message: {
					id: "msg-context-window",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "within the million-token window" }],
					model: "claude-sonnet-4",
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: {
						input_tokens: 10_000,
						output_tokens: 100,
						cache_read_input_tokens: 320_000,
						cache_creation_input_tokens: 0,
					},
				},
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000207",
				session_id: "sdk-sess-context-window",
			} as unknown as SDKMessage);
			await runTranslate(relayTranslator, relayCtx, {
				type: "result",
				subtype: "success",
				duration_ms: 1200,
				duration_api_ms: 900,
				is_error: false,
				num_turns: 1,
				result: "done",
				stop_reason: "end_turn",
				total_cost_usd: 0.12,
				usage: {
					input_tokens: 10_000,
					output_tokens: 100,
					cache_read_input_tokens: 320_000,
					cache_creation_input_tokens: 0,
				},
				modelUsage: {
					"claude-sonnet-4[1m]": { contextWindow: 1_000_000 },
				},
				permission_denials: [],
				uuid: "00000000-0000-0000-0000-000000000208",
				session_id: "sdk-sess-context-window",
			} as unknown as SDKMessage);

			const rows = await harness.sessionMessagesWithParts(
				"sess-context-window",
			);
			const assistantRow = rows.find((row) => row.role === "assistant") as
				| ((typeof rows)[number] & { context_window?: number })
				| undefined;
			expect(assistantRow?.context_window).toBe(1_000_000);

			const history = messageRowsToHistory(rows, { pageSize: 50 });
			const assistantHistory = history.messages.find(
				(message) => message.role === "assistant",
			);
			expect(
				(assistantHistory?.tokens as { context_window?: number } | undefined)
					?.context_window,
			).toBe(1_000_000);

			const messages = historyToChatMessages(history.messages);
			const result = messages.find((message) => message.type === "result");
			expect(
				result?.type === "result" ? result.context_window : undefined,
			).toBe(1_000_000);
		} finally {
			await harness.dispose();
		}
	});

	// 3b. system (subtype api_retry)

	it("translates system/api_retry to session.status:retry with its reason", async () => {
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
		// The reason (attempt, error, delay) rides the payload for the shell row.
		const message = statusEvent ? dataOf(statusEvent)["message"] : undefined;
		expect(message).toMatch(/attempt 3\/10/);
		expect(message).toMatch(/HTTP 502/);
		expect(message).toMatch(/next in 2\.2s/);
	});

	// 3b-compaction. system (compact_boundary / status compaction)

	it("translates system/compact_boundary to session.compaction:completed with token deltas", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "compact_boundary",
			compact_metadata: {
				trigger: "manual",
				pre_tokens: 194925,
				post_tokens: 95521,
			},
			session_id: "sdk-sess",
			uuid: "00000000-0000-0000-0000-0000000000c1",
		} as unknown as SDKMessage);

		const event = sink.events.find((e) => e.type === "session.compaction");
		expect(event).toBeDefined();
		const data = dataOf(event);
		expect(data["state"]).toBe("completed");
		expect(data["preTokens"]).toBe(194925);
		expect(data["postTokens"]).toBe(95521);
		expect(data["detail"]).toMatch(/Context compacted/);
		expect(data["detail"]).toMatch(/195k → 96k/);
	});

	it("translates system/status compact_result:failed to session.compaction:failed with error", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "status",
			status: null,
			compact_result: "failed",
			compact_error: "context too small to compact",
			session_id: "sdk-sess",
			uuid: "00000000-0000-0000-0000-0000000000c2",
		} as unknown as SDKMessage);

		const event = sink.events.find((e) => e.type === "session.compaction");
		expect(event).toBeDefined();
		expect(dataOf(event)["state"]).toBe("failed");
		expect(dataOf(event)["detail"]).toMatch(/context too small to compact/);
		// A failed compaction must not masquerade as an idle session.status.
		expect(sink.events.some((e) => e.type === "session.status")).toBe(false);
	});

	it("translates system/status:compacting to session.compaction:started (not idle)", async () => {
		await runTranslate(translator, ctx, {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "sdk-sess",
			uuid: "00000000-0000-0000-0000-0000000000c3",
		} as unknown as SDKMessage);

		const event = sink.events.find((e) => e.type === "session.compaction");
		expect(event).toBeDefined();
		expect(dataOf(event)["state"]).toBe("started");
		// "compacting" means busy — it must not emit session.status idle.
		expect(sink.events.some((e) => e.type === "session.status")).toBe(false);
	});

	// 3c. stream_event (message_start) emits session.status: busy

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

	// 4. stream_event (content_block_start: text)

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

	// 5. stream_event (content_block_start: thinking)

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

	// 6. stream_event (content_block_start: tool_use)

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
				providerCostTotalUsd: 0.12,
				providerSessionId: "sdk-session-1",
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

	// 7. stream_event (content_block_delta: text_delta)

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

	// 8. stream_event (content_block_delta: thinking_delta)

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

	// 9. stream_event (content_block_delta: input_json_delta)

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

	// 10. stream_event (content_block_stop)

	it("clears text blocks on content_block_stop without emitting tool events", async () => {
		// The tool.completed this used to emit carried the text part's own
		// uuid as messageId, which the ingress pipeline expanded into a
		// phantom "Unknown" tool plus an empty assistant message row.
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

		const toolEvents = sink.events.filter(
			(e) => e.type === "tool.completed" || e.type === "tool.started",
		);
		expect(toolEvents).toHaveLength(0);
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
		const textDelta = sink.events.find((e) => e.type === "text.delta");
		expect(textDelta).toBeDefined();
		expect(dataOf(textDelta)["messageId"]).toBe("msg-1");
		expect(dataOf(textDelta)["text"]).toBe("Hello");
	});

	// 12. user (tool_result)

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

	// 13. result (success)

	it("keeps the Claude session total and identity for durable cost conversion", async () => {
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
		expect(data["providerCostTotalUsd"]).toBe(0.0123);
		expect(data["providerSessionId"]).toBe("sdk-sess");
		expect(data["cost"]).toBeUndefined();
		expect(data["duration"]).toBe(1200);
	});

	it("uses the largest finite positive context window from result model usage", async () => {
		ctx.lastAssistantUuid = "assist-uuid-context-window";

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
				cache_read_input_tokens: 320_000,
				cache_creation_input_tokens: 5,
			},
			modelUsage: {
				"claude-sonnet-4": { contextWindow: 200_000 },
				"claude-sonnet-4[1m]": { contextWindow: 1_000_000 },
				ignored: { contextWindow: Number.POSITIVE_INFINITY },
			},
			permission_denials: [],
			uuid: "00000000-0000-0000-0000-000000000011",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		const tokens = dataOf(turnCompleted)["tokens"] as Record<string, unknown>;
		expect(tokens["contextWindow"]).toBe(1_000_000);
	});

	it("falls back to the effective 1m API model suffix when model usage has no window", async () => {
		ctx.lastAssistantUuid = "assist-uuid-context-window-fallback";
		ctx.currentApiModelId = "claude-sonnet-4[1m]";

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
				cache_read_input_tokens: 320_000,
				cache_creation_input_tokens: 5,
			},
			modelUsage: {
				ignored: { contextWindow: 0 },
			},
			permission_denials: [],
			uuid: "00000000-0000-0000-0000-000000000012",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		const tokens = dataOf(turnCompleted)["tokens"] as Record<string, unknown>;
		expect(tokens["contextWindow"]).toBe(1_000_000);
	});

	it("reports result usage separately from the last main request's context, ignoring subagent chatter", async () => {
		const assistantMsg = (
			uuid: string,
			usage: Record<string, number>,
			parentToolUseId: string | null = null,
		): SDKMessage =>
			({
				type: "assistant",
				message: {
					id: `msg-${uuid}`,
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: `text-${uuid}` }],
					model: "claude-fable-5",
					stop_reason: "end_turn",
					stop_sequence: null,
					usage,
				},
				parent_tool_use_id: parentToolUseId,
				uuid,
				session_id: "sdk-sess",
			}) as unknown as SDKMessage;

		// First API round
		await runTranslate(
			translator,
			ctx,
			assistantMsg("00000000-0000-0000-0000-000000000301", {
				input_tokens: 20,
				output_tokens: 300,
				cache_read_input_tokens: 100_000,
				cache_creation_input_tokens: 2_000,
			}),
		);
		// Last main-chain API round — this is the current context occupancy
		await runTranslate(
			translator,
			ctx,
			assistantMsg("00000000-0000-0000-0000-000000000302", {
				input_tokens: 30,
				output_tokens: 800,
				cache_read_input_tokens: 110_000,
				cache_creation_input_tokens: 1_500,
			}),
		);
		// Subagent chatter after it must NOT overwrite the main-chain usage
		await runTranslate(
			translator,
			ctx,
			assistantMsg(
				"00000000-0000-0000-0000-000000000303",
				{
					input_tokens: 5,
					output_tokens: 50,
					cache_read_input_tokens: 9_000,
					cache_creation_input_tokens: 100,
				},
				"tool-subagent-1",
			),
		);

		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			duration_ms: 5000,
			duration_api_ms: 4000,
			is_error: false,
			num_turns: 1,
			result: "done",
			stop_reason: "end_turn",
			total_cost_usd: 1.5,
			usage: {
				input_tokens: 500,
				output_tokens: 20_000,
				cache_read_input_tokens: 3_300_000,
				cache_creation_input_tokens: 80_000,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "00000000-0000-0000-0000-000000000310",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();
		const tokens = dataOf(turnCompleted)["tokens"] as Record<string, unknown>;
		expect(tokens).toEqual({
			input: 500,
			output: 20_000,
			cacheRead: 3_300_000,
			cacheWrite: 80_000,
		});
		expect(dataOf(turnCompleted)["contextTokens"]).toBe(111_530);
		// The raw session total is converted only when the result is persisted.
		expect(dataOf(turnCompleted)["providerCostTotalUsd"]).toBe(1.5);
		expect(dataOf(turnCompleted)["cost"]).toBeUndefined();
	});

	it.each([
		undefined,
		{},
	])("keeps missing result usage unknown while retaining context: %j", async (usage) => {
		await runTranslate(translator, ctx, makeAssistantMessage("claude-fable-5"));
		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			duration_ms: 100,
			total_cost_usd: 0,
			...(usage === undefined ? {} : { usage }),
			modelUsage: {},
			uuid: "00000000-0000-0000-0000-000000000311",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);
		const completed = sink.events.find(
			(event) => event.type === "turn.completed",
		);
		expect(dataOf(completed)["tokens"]).toEqual({});
		expect(dataOf(completed)["contextTokens"]).toBe(10);

		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "next",
			duration_ms: 100,
			total_cost_usd: 0,
			usage: {
				input_tokens: 100,
				output_tokens: 300,
				cache_read_input_tokens: 1_000,
				cache_creation_input_tokens: 200,
			},
			modelUsage: {},
			uuid: "00000000-0000-0000-0000-000000000312",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);
		const next = sink.events
			.filter((event) => event.type === "turn.completed")
			.at(-1);
		expect(dataOf(next)["tokens"]).toEqual({
			input: 100,
			output: 300,
			cacheRead: 1_000,
			cacheWrite: 200,
		});
		expect(dataOf(next)).not.toHaveProperty("contextTokens");
	});

	it("preserves a reported zero context independently of result usage", async () => {
		const assistant = makeAssistantMessage("claude-fable-5");
		if (assistant.type !== "assistant") throw new Error("expected assistant");
		await runTranslate(translator, ctx, {
			...assistant,
			message: {
				...assistant.message,
				usage: { input_tokens: 0, output_tokens: 50 },
			},
		} as unknown as SDKMessage);
		await runTranslate(translator, ctx, {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			duration_ms: 100,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 500,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			modelUsage: {},
			uuid: "00000000-0000-0000-0000-000000000313",
			session_id: "sdk-sess",
		} as unknown as SDKMessage);
		const completed = sink.events.find(
			(event) => event.type === "turn.completed",
		);
		expect(dataOf(completed)["tokens"]).toEqual({ input: 0, output: 500 });
		expect(dataOf(completed)["contextTokens"]).toBe(0);
	});

	// 13b. result (success, no streaming, text in result field)
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

	// 14. result (error)

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
		// The SDK uuid names no turn, so it must not stand in for the reply id.
		expect(data["messageId"]).toBe("");
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

	// 15. result (interrupted)

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
		// An SDK uuid names no turn row; empty tells the projector "the running turn".
		expect(data["messageId"]).toBe("");
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

	it("ignores system/task_notification messages without a tool_use_id", async () => {
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

	it.each([
		"local_bash",
		"local_agent",
	])("keeps the first SDK receipt time when a nested %s start is held and duplicated", async (taskType) => {
		const ownership = createClaudeMessageOwnership({
			childSessionIdFor: (taskId) => `claude-subagent-${taskId}`,
		});
		const runtimeCtx = makeCtx({
			messageOwnership: ownership,
			subagentTasks: new Map(),
			eventSink: sink,
		});
		ownership.decide({
			kind: "sdk",
			message: {
				type: "assistant",
				uuid: "parent-message",
				parent_tool_use_id: null,
				message: {
					content: [
						{ type: "tool_use", id: "agent-tool", name: "Agent", input: {} },
					],
				},
			} as unknown as SDKMessage,
		});
		ownership.decide({
			kind: "sdk",
			message: {
				type: "system",
				subtype: "task_started",
				task_id: "agent-task",
				tool_use_id: "agent-tool",
				task_type: "local_agent",
				description: "Parent agent",
			} as unknown as SDKMessage,
		});
		const start = {
			type: "system",
			subtype: "task_started",
			task_id: "nested-task",
			tool_use_id: "nested-tool",
			task_type: taskType,
			description: "Nested work",
			is_backgrounded: true,
		} as unknown as SDKMessage;
		const apply: Parameters<typeof decideClaudeMessageOwnershipEffect>[2] = (
			decisions,
		) =>
			Effect.forEach(
				decisions,
				(decision) =>
					applyClaudeOwnershipDecisionEffect(undefined, runtimeCtx, decision),
				{ discard: true },
			);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(1000);
				yield* decideClaudeMessageOwnershipEffect(
					runtimeCtx,
					{ kind: "sdk", message: start },
					apply,
				);
				yield* TestClock.setTime(1200);
				yield* decideClaudeMessageOwnershipEffect(
					runtimeCtx,
					{ kind: "sdk", message: start },
					apply,
				);
				yield* decideClaudeMessageOwnershipEffect(
					runtimeCtx,
					{
						kind: "sdk",
						message: {
							type: "system",
							subtype: "task_updated",
							task_id: "nested-task",
							patch: { status: "completed", end_time: 1500 },
						} as unknown as SDKMessage,
					},
					apply,
				);
				yield* TestClock.setTime(2500);
				yield* decideClaudeMessageOwnershipEffect(
					runtimeCtx,
					{
						kind: "transcript",
						taskId: "agent-task",
						messages: [
							{
								type: "assistant",
								uuid: "agent-message",
								session_id: "sdk-sess",
								parent_tool_use_id: null,
								parent_agent_id: null,
								message: {
									content: [
										{
											type: "tool_use",
											id: "nested-tool",
											name: "Bash",
											input: {},
										},
									],
								},
							},
						],
					},
					apply,
				);
				yield* TestClock.setTime(3000);
				yield* decideClaudeMessageOwnershipEffect(
					runtimeCtx,
					{ kind: "sdk", message: start },
					apply,
				);
			}).pipe(Effect.provide(TestContext.TestContext)),
		);

		const metadata: Record<string, unknown> = {};
		const starts: unknown[] = [];
		for (const event of sink.events) {
			if (
				event.type !== "tool.running" ||
				dataOf(event)["partId"] !== "nested-tool"
			)
				continue;
			const patch = dataOf(event)["metadata"] as Record<string, unknown>;
			if (patch["taskStartedAt"] !== undefined)
				starts.push(patch["taskStartedAt"]);
			Object.assign(metadata, patch);
		}
		expect(starts).toEqual([1000, 1000, 1000]);
		expect(
			launchRow(
				createToolMessage({
					uuid: "nested-tool",
					id: "nested-tool",
					name: "Bash",
					status: "completed",
					metadata,
				}),
				[],
				3000,
			),
		).toMatchObject({ state: { kind: "finished" }, time: 500 });
	});

	it.each([
		false,
		true,
	])("uses ingress time for a held nested pause (resumed while held=%s)", async (resumedWhileHeld) => {
		const ownership = createClaudeMessageOwnership({
			childSessionIdFor: (taskId) => `claude-subagent-${taskId}`,
		});
		const runtimeCtx = makeCtx({
			messageOwnership: ownership,
			subagentTasks: new Map(),
			eventSink: sink,
		});
		ownership.decide({
			kind: "sdk",
			message: {
				type: "assistant",
				uuid: "parent-message",
				parent_tool_use_id: null,
				message: {
					content: [
						{ type: "tool_use", id: "agent-tool", name: "Agent", input: {} },
					],
				},
			} as unknown as SDKMessage,
		});
		ownership.decide({
			kind: "sdk",
			message: {
				type: "system",
				subtype: "task_started",
				task_id: "agent-task",
				tool_use_id: "agent-tool",
				task_type: "local_agent",
				description: "Parent agent",
			} as unknown as SDKMessage,
		});
		const apply: Parameters<typeof decideClaudeMessageOwnershipEffect>[2] = (
			decisions,
		) =>
			Effect.forEach(
				decisions,
				(decision) =>
					applyClaudeOwnershipDecisionEffect(undefined, runtimeCtx, decision),
				{ discard: true },
			);
		const metadata: Record<string, unknown> = {};
		let seen = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const messages: readonly (readonly [number, SDKMessage])[] = [
					[
						1000,
						{
							type: "system",
							subtype: "task_started",
							task_id: "nested-task",
							tool_use_id: "nested-tool",
							task_type: "local_bash",
							description: "Nested work",
							is_backgrounded: true,
						} as unknown as SDKMessage,
					],
					[
						1500,
						{
							type: "system",
							subtype: "task_updated",
							task_id: "nested-task",
							patch: { status: "paused" },
						} as unknown as SDKMessage,
					],
					...(resumedWhileHeld
						? [
								[
									2000,
									{
										type: "system",
										subtype: "task_updated",
										task_id: "nested-task",
										patch: { status: "running" },
									} as unknown as SDKMessage,
								] as const,
								[
									2200,
									{
										type: "system",
										subtype: "task_updated",
										task_id: "nested-task",
										patch: { status: "paused" },
									} as unknown as SDKMessage,
								] as const,
							]
						: []),
				];
				for (const [at, message] of messages) {
					yield* TestClock.setTime(at);
					yield* decideClaudeMessageOwnershipEffect(
						runtimeCtx,
						{ kind: "sdk", message },
						apply,
					);
				}
				yield* TestClock.setTime(2500);
				yield* decideClaudeMessageOwnershipEffect(
					runtimeCtx,
					{
						kind: "transcript",
						taskId: "agent-task",
						messages: [
							{
								type: "assistant",
								uuid: "agent-message",
								session_id: "sdk-sess",
								parent_tool_use_id: null,
								parent_agent_id: null,
								message: {
									content: [
										{
											type: "tool_use",
											id: "nested-tool",
											name: "Bash",
											input: {},
										},
									],
								},
							},
						],
					},
					apply,
				);
				for (const [at, status, now, time, pausedAt] of [
					[
						2500,
						undefined,
						3000,
						resumedWhileHeld ? 700 : 500,
						resumedWhileHeld ? 2200 : 1500,
					],
					[
						3500,
						"paused",
						4000,
						resumedWhileHeld ? 700 : 500,
						resumedWhileHeld ? 2200 : 1500,
					],
					[4500, "running", 5000, resumedWhileHeld ? 1200 : 1000, null],
					[5500, "paused", 6000, resumedWhileHeld ? 1700 : 1500, 5500],
					[6500, "running", 7000, resumedWhileHeld ? 2200 : 2000, null],
				] as const) {
					yield* TestClock.setTime(at);
					if (status)
						yield* decideClaudeMessageOwnershipEffect(
							runtimeCtx,
							{
								kind: "sdk",
								message: {
									type: "system",
									subtype: "task_updated",
									task_id: "nested-task",
									patch: { status },
								} as unknown as SDKMessage,
							},
							apply,
						);
					for (const event of sink.events.slice(seen)) {
						if (
							event.type === "tool.running" &&
							dataOf(event)["partId"] === "nested-tool"
						)
							Object.assign(metadata, dataOf(event)["metadata"]);
					}
					seen = sink.events.length;
					expect(
						launchRow(
							createToolMessage({
								uuid: "nested-tool",
								id: "nested-tool",
								name: "Bash",
								status: "running",
								metadata,
							}),
							[{ id: "nested-task" }],
							now,
						)?.time,
					).toBe(time);
					expect(metadata["pausedAt"]).toBe(pausedAt);
				}
			}).pipe(Effect.provide(TestContext.TestContext)),
		);
	});

	it("shows the latest step from either task progress or tool progress", async () => {
		seededToolPartIds = new Set(["progress-tool"]);
		ctx = makeCtx({ lastAssistantUuid: "assistant" });
		const metadata: Record<string, unknown> = {
			providerTaskId: "progress-task",
			backgrounded: true,
			taskStartedAt: 0,
		};
		const toolProgress = (toolName: string): SDKMessage =>
			({
				type: "tool_progress",
				tool_use_id: `active-${toolName}`,
				parent_tool_use_id: "progress-tool",
				task_id: "progress-task",
				tool_name: toolName,
				elapsed_time_seconds: 1,
				uuid: `progress-${toolName}`,
				session_id: "sdk-session",
			}) as unknown as SDKMessage;
		const taskProgress = (description: string): SDKMessage =>
			({
				type: "system",
				subtype: "task_progress",
				task_id: "progress-task",
				tool_use_id: "progress-tool",
				description,
				usage: { total_tokens: 100, tool_uses: 1, duration_ms: 1000 },
				uuid: `progress-${description}`,
				session_id: "sdk-session",
			}) as unknown as SDKMessage;
		let seen = 0;
		for (const [message, step] of [
			[toolProgress("Bash"), "Bash"],
			[taskProgress("Running pnpm test"), "Running pnpm test"],
			[toolProgress("Read"), "Read"],
			[taskProgress("Writing docs"), "Writing docs"],
		] as const) {
			await runTranslate(translator, ctx, message);
			for (const event of sink.events.slice(seen)) {
				if (event.type === "tool.running")
					Object.assign(metadata, dataOf(event)["metadata"]);
			}
			seen = sink.events.length;
			expect(
				launchRow(
					createToolMessage({
						uuid: "progress-tool",
						id: "progress-tool",
						name: "Task",
						status: "running",
						input: { tool: "Task", description: "Audit", prompt: "Go" },
						metadata,
					}),
					[{ id: "progress-task" }],
					1000,
				)?.step,
			).toBe(step);
		}
	});

	it("persists the active pause start and clears it on resume", async () => {
		seededToolPartIds = new Set(["paused-tool"]);
		ctx = makeCtx({
			lastAssistantUuid: "assistant",
			subagentTasks: new Map([["paused-task", { toolUseId: "paused-tool" }]]),
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(10_000);
				yield* translator.translate(ctx, {
					type: "system",
					subtype: "task_updated",
					task_id: "paused-task",
					patch: { status: "paused", total_paused_ms: 2_000 },
				} as unknown as SDKMessage);
				yield* TestClock.setTime(70_000);
				yield* translator.translate(ctx, {
					type: "system",
					subtype: "task_updated",
					task_id: "paused-task",
					patch: { status: "running", total_paused_ms: 62_000 },
				} as unknown as SDKMessage);
			}).pipe(Effect.provide(TestContext.TestContext)),
		);
		const updates = sink.events.filter(
			(event) => event.type === "tool.running",
		);
		expect(dataOf(updates[0])["metadata"]).toMatchObject({
			pausedAt: 10_000,
			pausedMs: 2_000,
		});
		expect(dataOf(updates[1])["metadata"]).toMatchObject({
			pausedAt: null,
			pausedMs: 62_000,
		});
	});

	it("accounts for status-only resumes, authoritative totals, and later pauses", async () => {
		seededToolPartIds = new Set(["paused-tool"]);
		ctx = makeCtx({
			lastAssistantUuid: "assistant",
			subagentTasks: new Map([["paused-task", { toolUseId: "paused-tool" }]]),
		});
		const metadata: Record<string, unknown> = {
			providerTaskId: "paused-task",
			backgrounded: true,
			taskStartedAt: 0,
		};
		let seen = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				for (const [at, patch, now, time, pausedAt] of [
					[
						10_000,
						{ status: "paused", total_paused_ms: 2_000 },
						20_000,
						8_000,
						10_000,
					],
					[70_000, { status: "running" }, 72_000, 10_000, null],
					[71_000, { total_paused_ms: 60_000 }, 72_000, 12_000, null],
					[73_000, { status: "paused" }, 78_000, 13_000, 73_000],
					[80_000, { status: "running" }, 83_000, 16_000, null],
					[81_000, { status: "running" }, 83_000, 16_000, null],
				] as const) {
					yield* TestClock.setTime(at);
					yield* translator.translate(ctx, {
						type: "system",
						subtype: "task_updated",
						task_id: "paused-task",
						patch,
					} as unknown as SDKMessage);
					for (const event of sink.events.slice(seen)) {
						if (event.type === "tool.running")
							Object.assign(metadata, dataOf(event)["metadata"]);
					}
					seen = sink.events.length;
					expect(
						launchRow(
							createToolMessage({
								uuid: "paused-tool",
								id: "paused-tool",
								name: "Task",
								status: "running",
								metadata,
							}),
							[{ id: "paused-task" }],
							now,
						)?.time,
					).toBe(time);
					expect(metadata["pausedAt"]).toBe(pausedAt);
				}
			}).pipe(Effect.provide(TestContext.TestContext)),
		);
	});

	it("keeps the current pause start across repeated paused patches", async () => {
		seededToolPartIds = new Set(["paused-tool"]);
		ctx = makeCtx({
			lastAssistantUuid: "assistant",
			subagentTasks: new Map([["paused-task", { toolUseId: "paused-tool" }]]),
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				for (const at of [10_000, 40_000]) {
					yield* TestClock.setTime(at);
					yield* translator.translate(ctx, {
						type: "system",
						subtype: "task_updated",
						task_id: "paused-task",
						patch: { status: "paused", total_paused_ms: 2_000 },
					} as unknown as SDKMessage);
				}
			}).pipe(Effect.provide(TestContext.TestContext)),
		);
		const metadata: Record<string, unknown> = {
			providerTaskId: "paused-task",
			backgrounded: true,
			taskStartedAt: 0,
		};
		for (const event of sink.events) {
			if (event.type === "tool.running")
				Object.assign(metadata, dataOf(event)["metadata"]);
		}
		expect(
			launchRow(
				createToolMessage({
					uuid: "paused-tool",
					id: "paused-tool",
					name: "Task",
					status: "running",
					metadata,
				}),
				[{ id: "paused-task" }],
				50_000,
			)?.time,
		).toBe(8_000);
		expect(metadata["pausedAt"]).toBe(10_000);
	});

	it.each([
		"completed",
		"failed",
		"killed",
	] as const)("ends an active pause at the SDK end time when %s arrives late", async (status) => {
		seededToolPartIds = new Set(["paused-tool"]);
		ctx = makeCtx({
			lastAssistantUuid: "assistant",
			subagentTasks: new Map([["paused-task", { toolUseId: "paused-tool" }]]),
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(10_000);
				yield* translator.translate(ctx, {
					type: "system",
					subtype: "task_updated",
					task_id: "paused-task",
					patch: { status: "paused", total_paused_ms: 2_000 },
				} as unknown as SDKMessage);
				yield* TestClock.setTime(25_000);
				yield* translator.translate(ctx, {
					type: "system",
					subtype: "task_updated",
					task_id: "paused-task",
					patch: { status, end_time: 20_000 },
				} as unknown as SDKMessage);
			}).pipe(Effect.provide(TestContext.TestContext)),
		);
		const metadata: Record<string, unknown> = {
			providerTaskId: "paused-task",
			backgrounded: true,
			taskStartedAt: 0,
		};
		for (const event of sink.events) {
			if (event.type === "tool.running")
				Object.assign(metadata, dataOf(event)["metadata"]);
		}
		expect(
			launchRow(
				createToolMessage({
					uuid: "paused-tool",
					id: "paused-tool",
					name: "Task",
					status: "running",
					metadata,
				}),
				[{ id: "paused-task" }],
				30_000,
			),
		).toMatchObject({
			state: {
				kind: "finished",
				outcome: status === "killed" ? "stopped" : status,
			},
			time: 8_000,
		});
		expect(metadata["pausedAt"]).toBeNull();
	});

	it("tracks live work from background_tasks_changed, ignoring ambient tasks", async () => {
		const liveness = makeSessionBackgroundLiveness(undefined, () => 200);
		const trackingTranslator = new ClaudeEventTranslator({
			getSink: () => sink,
			onBackgroundTask: liveness.record,
		});
		const snapshot = (
			tasks: ReadonlyArray<Record<string, unknown>>,
			n: number,
		) =>
			Effect.runPromise(
				Effect.gen(function* () {
					yield* TestClock.setTime(100);
					yield* trackingTranslator.translate(ctx, {
						type: "system",
						subtype: "background_tasks_changed",
						tasks,
						uuid: `00000000-0000-0000-0000-00000000040${n}`,
						session_id: "sdk-sess",
					} as unknown as SDKMessage);
				}).pipe(Effect.provide(TestContext.TestContext)),
			);
		const bash = {
			task_id: "bash",
			task_type: "local_bash",
			description: "codex exec",
		};
		const watcher = {
			task_id: "watch",
			task_type: "local_bash",
			description: "watch",
			ambient: true,
		};

		const plan = { task_id: "plan", task_type: "plan", description: "Plan" };
		const planMode = {
			task_id: "plan-mode",
			task_type: "plan_mode",
			description: "Plan mode",
		};
		await snapshot([bash, watcher, plan, planMode], 1);
		expect(liveness.hasLiveWork(ctx.sessionId)).toBe(true);
		expect(liveness.backgroundOf(ctx.sessionId)).toEqual({
			work: "monitoring",
			tasks: [
				{
					id: "bash",
					type: "local_bash",
					description: "codex exec",
					firstSeenAt: 100,
				},
			],
		});
		await snapshot([watcher, plan, planMode], 2);
		expect(liveness.hasLiveWork(ctx.sessionId)).toBe(false);
		expect(liveness.backgroundOf(ctx.sessionId)).toBeUndefined();
		await snapshot([bash], 3);
		await snapshot([], 4);
		expect(liveness.hasLiveWork(ctx.sessionId)).toBe(false);
		expect(sink.events).toHaveLength(0);
	});

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
		// turn.error is terminal, so it also releases the busy lease.
		expect(sink.events.map((event) => event.type)).toEqual([
			"turn.error",
			"session.status",
		]);
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

	it("all emitted events have providerId set to 'claude'", async () => {
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
			expect(event.providerId).toBe("claude");
		}
	});

	// A single agentic turn spans multiple SDK assistant messages (one per
	// tool round). Each round's stream restarts content_block index at 0, but
	// the translator pins currentAssistantMessageId to the first round's id.
	// If the content-block key (messageId:index:type) ignores the round, every
	// text segment collides on `msg:0:text` and merges into ONE part — created
	// before any tool — so all narration renders clumped ahead of every tool
	// call (both live and on reload). Post-tool text MUST get a distinct partId.
	it("assigns distinct partIds to text before and after a tool across SDK message rounds", async () => {
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "assistant-round-1" },
			}),
		);
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
				delta: { type: "text_delta", text: "Before the tool." },
			}),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 0 }),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "toolu_round1",
					name: "Bash",
					input: { command: "ls" },
				},
			}),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 1 }),
		);

		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({
				type: "message_start",
				message: { id: "assistant-round-2" },
			}),
		);
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
				delta: { type: "text_delta", text: "After the tool." },
			}),
		);
		await runTranslate(
			translator,
			ctx,
			makeStreamEvent({ type: "content_block_stop", index: 0 }),
		);

		const textDeltas = sink.events.filter((e) => e.type === "text.delta");
		const before = textDeltas.find(
			(e) => dataOf(e)["text"] === "Before the tool.",
		);
		const after = textDeltas.find(
			(e) => dataOf(e)["text"] === "After the tool.",
		);
		expect(before, "pre-tool text delta emitted").toBeDefined();
		expect(after, "post-tool text delta emitted").toBeDefined();

		// The two text segments are logically separate parts (a tool call runs
		// between them). They MUST have distinct partIds so the projector orders
		// them as text → tool → text, not [merged text] → tool.
		expect(dataOf(after)["partId"]).not.toBe(dataOf(before)["partId"]);

		// And all text stays under one cohesive assistant message.
		expect(dataOf(before)["messageId"]).toBe("assistant-round-1");
		expect(dataOf(after)["messageId"]).toBe("assistant-round-1");

		// Sanity: the post-tool text is emitted AFTER the tool.started, so the
		// chronological interleave is preserved in emission order too.
		const startedIdx = sink.events.findIndex((e) => e.type === "tool.started");
		const afterIdx = sink.events.findIndex(
			(e) => e.type === "text.delta" && dataOf(e)["text"] === "After the tool.",
		);
		expect(startedIdx).toBeGreaterThanOrEqual(0);
		expect(afterIdx).toBeGreaterThan(startedIdx);
	});
});
