// test/unit/provider/claude/claude-adapter-send-turn.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";
import type {
	Query,
	SDKMessage,
	SDKResultMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type {
	EventSink,
	SendTurnInput,
} from "../../../../src/lib/provider/types.js";

// ─── Mock helpers ──────────────────────────────────────────────────────────

function createMockQuery(messages: SDKMessage[]): Query {
	const gen = (async function* () {
		for (const msg of messages) yield msg;
	})();
	return Object.assign(gen, {
		interrupt: vi.fn(async () => {}),
		close: vi.fn(),
		setModel: vi.fn(async () => {}),
		setPermissionMode: vi.fn(async () => {}),
		streamInput: vi.fn(async () => {}),
		setMaxThinkingTokens: vi.fn(async () => {}),
		applyFlagSettings: vi.fn(async () => {}),
		initializationResult: vi.fn(async () => ({})),
		supportedCommands: vi.fn(async () => []),
		supportedModels: vi.fn(async () => []),
		supportedAgents: vi.fn(async () => []),
		mcpServerStatus: vi.fn(async () => []),
		getContextUsage: vi.fn(async () => ({})),
		reloadPlugins: vi.fn(async () => ({})),
		accountInfo: vi.fn(async () => ({})),
		rewindFiles: vi.fn(async () => ({ canRewind: false })),
		seedReadState: vi.fn(async () => {}),
		reconnectMcpServer: vi.fn(async () => {}),
		toggleMcpServer: vi.fn(async () => {}),
		setMcpServers: vi.fn(async () => ({})),
		stopTask: vi.fn(async () => {}),
		next: gen.next.bind(gen),
		return: gen.return.bind(gen),
		throw: gen.throw.bind(gen),
		[Symbol.asyncIterator]: () => gen,
	}) as unknown as Query;
}

function createMockEventSink(): EventSink {
	return {
		push: vi.fn(async () => {}),
		requestPermission: vi.fn(async () => ({ decision: "once" as const })),
		requestQuestion: vi.fn(async () => ({})),
	};
}

function makeSuccessResult(
	overrides: Partial<SDKResultMessage> = {},
): SDKResultMessage {
	return {
		type: "result" as const,
		subtype: "success" as const,
		duration_ms: 1500,
		duration_api_ms: 1200,
		is_error: false,
		num_turns: 1,
		result: "Done",
		stop_reason: "end_turn",
		total_cost_usd: 0.05,
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_read_input_tokens: 10,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
		uuid: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
		session_id: "sdk-session-1",
		...overrides,
	} as unknown as SDKResultMessage;
}

function makeErrorResult(
	overrides: Partial<SDKResultMessage> = {},
): SDKResultMessage {
	return {
		type: "result" as const,
		subtype: "error_during_execution" as const,
		duration_ms: 500,
		duration_api_ms: 300,
		is_error: true,
		num_turns: 1,
		stop_reason: null,
		total_cost_usd: 0.01,
		usage: {
			input_tokens: 50,
			output_tokens: 10,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
		errors: ["Something went wrong"],
		uuid: "00000000-0000-0000-0000-000000000002" as `${string}-${string}-${string}-${string}-${string}`,
		session_id: "sdk-session-1",
		...overrides,
	} as unknown as SDKResultMessage;
}

function makeBaseSendTurnInput(
	overrides: Partial<SendTurnInput> = {},
): SendTurnInput {
	return {
		sessionId: "session-1",
		turnId: "turn-1",
		prompt: "Hello",
		history: [],
		providerState: {},
		workspaceRoot: "/tmp/ws",
		eventSink: createMockEventSink(),
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("ClaudeAdapter.sendTurn()", () => {
	let workspace: string;
	let queryFactorySpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-send-turn-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	// ── Test 1: First turn creates a new session ──────────────────────────

	it("first turn creates a new session, calls query(), and resolves with TurnResult", async () => {
		const resultMsg = makeSuccessResult();
		const mockQuery = createMockQuery([resultMsg]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const input = makeBaseSendTurnInput({ sessionId: "session-new" });
		const result = await adapter.sendTurn(input);

		// queryFactory was called exactly once
		expect(queryFactorySpy).toHaveBeenCalledTimes(1);

		// Verify the query was called with prompt (an AsyncIterable) and options
		const callArgs = queryFactorySpy.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(callArgs["prompt"]).toBeDefined();
		expect(callArgs["options"]).toBeDefined();
		expect((callArgs["options"] as Record<string, unknown>)["cwd"]).toBe(
			"/tmp/ws",
		);

		// Result should be a proper TurnResult
		expect(result.status).toBe("completed");
		expect(result.cost).toBe(0.05);
		expect(result.tokens.input).toBe(100);
		expect(result.tokens.output).toBe(50);
		expect(result.durationMs).toBe(1500);
	});

	// ── Test 2: Subsequent turn enqueues into existing session ────────────

	it("subsequent turn enqueues into existing session without creating new query()", async () => {
		// First result resolves the first turn; second result resolves the second.
		const result1 = makeSuccessResult({ session_id: "sdk-session-1" } as Record<
			string,
			unknown
		>);
		const result2 = makeSuccessResult({
			session_id: "sdk-session-1",
			total_cost_usd: 0.1,
		} as Record<string, unknown>);

		// Use a controllable query that yields both results on demand
		let resolveSecond: (() => void) | undefined;
		const secondReady = new Promise<void>((r) => {
			resolveSecond = r;
		});
		const gen = (async function* () {
			// Yield first result
			yield result1 as unknown as SDKMessage;
			// Wait until second turn is enqueued
			await secondReady;
			yield result2 as unknown as SDKMessage;
		})();

		const mockQuery = Object.assign(gen, {
			interrupt: vi.fn(async () => {}),
			close: vi.fn(),
			setModel: vi.fn(async () => {}),
			setPermissionMode: vi.fn(async () => {}),
			streamInput: vi.fn(async () => {}),
			setMaxThinkingTokens: vi.fn(async () => {}),
			applyFlagSettings: vi.fn(async () => {}),
			initializationResult: vi.fn(async () => ({})),
			supportedCommands: vi.fn(async () => []),
			supportedModels: vi.fn(async () => []),
			supportedAgents: vi.fn(async () => []),
			mcpServerStatus: vi.fn(async () => []),
			getContextUsage: vi.fn(async () => ({})),
			reloadPlugins: vi.fn(async () => ({})),
			accountInfo: vi.fn(async () => ({})),
			rewindFiles: vi.fn(async () => ({ canRewind: false })),
			seedReadState: vi.fn(async () => {}),
			reconnectMcpServer: vi.fn(async () => {}),
			toggleMcpServer: vi.fn(async () => {}),
			setMcpServers: vi.fn(async () => ({})),
			stopTask: vi.fn(async () => {}),
			next: gen.next.bind(gen),
			return: gen.return.bind(gen),
			throw: gen.throw.bind(gen),
			[Symbol.asyncIterator]: () => gen,
		}) as unknown as Query;

		queryFactorySpy = vi.fn(() => mockQuery);
		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const sink = createMockEventSink();
		const input1 = makeBaseSendTurnInput({
			sessionId: "session-multi",
			turnId: "turn-1",
			prompt: "First message",
			eventSink: sink,
		});

		// First turn
		const turn1Promise = adapter.sendTurn(input1);
		const turn1Result = await turn1Promise;

		expect(queryFactorySpy).toHaveBeenCalledTimes(1);
		expect(turn1Result.status).toBe("completed");

		// Second turn - should reuse the query
		const input2 = makeBaseSendTurnInput({
			sessionId: "session-multi",
			turnId: "turn-2",
			prompt: "Second message",
			eventSink: sink,
		});

		const turn2Promise = adapter.sendTurn(input2);
		// Unblock the second message
		resolveSecond!();
		const turn2Result = await turn2Promise;

		// query() should NOT have been called again
		expect(queryFactorySpy).toHaveBeenCalledTimes(1);
		expect(turn2Result.status).toBe("completed");
		expect(turn2Result.cost).toBe(0.1);
	});

	// ── Test 3: Resume uses SDK resume option ─────────────────────────────

	it("resume uses SDK resume option when providerState has resumeSessionId", async () => {
		const resultMsg = makeSuccessResult();
		const mockQuery = createMockQuery([resultMsg]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const input = makeBaseSendTurnInput({
			sessionId: "session-resume",
			providerState: { resumeSessionId: "prev-sdk-session-123" },
		});

		await adapter.sendTurn(input);

		const callArgs = queryFactorySpy.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect((callArgs["options"] as Record<string, unknown>)["resume"]).toBe(
			"prev-sdk-session-123",
		);
	});

	// ── Test 4: Abort signal propagates to SDK ────────────────────────────

	it("abort signal propagates to SDK options", async () => {
		const resultMsg = makeSuccessResult();
		const mockQuery = createMockQuery([resultMsg]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const abortController = new AbortController();
		const input = makeBaseSendTurnInput({
			sessionId: "session-abort",
			abortSignal: abortController.signal,
		});

		await adapter.sendTurn(input);

		const callArgs = queryFactorySpy.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(
			(callArgs["options"] as Record<string, unknown>)["abortController"],
		).toBeDefined();
		expect(
			(callArgs["options"] as Record<string, unknown>)["abortController"],
		).toBeInstanceOf(AbortController);
	});

	// ── Test 5: Stream consumer translates all messages ───────────────────

	it("stream consumer translates all messages through event sink", async () => {
		const systemMsg = {
			type: "system" as const,
			subtype: "init" as const,
			model: "claude-sonnet-4",
			session_id: "sdk-session-1",
		} as unknown as SDKMessage;

		const assistantMsg = {
			type: "assistant" as const,
			uuid: "asst-uuid-1",
			message: { role: "assistant", content: [] },
			session_id: "sdk-session-1",
		} as unknown as SDKMessage;

		const resultMsg = makeSuccessResult();

		const mockQuery = createMockQuery([systemMsg, assistantMsg, resultMsg]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const sink = createMockEventSink();
		const input = makeBaseSendTurnInput({
			sessionId: "session-translate",
			eventSink: sink,
		});

		await adapter.sendTurn(input);

		// The sink should have received events for the translated messages.
		// System init -> session.status, result -> turn.completed
		expect(sink.push).toHaveBeenCalled();
		const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
			.calls as Array<[CanonicalEvent]>;
		const eventTypes = pushCalls.map((call) => call[0].type);
		// At minimum: session.status from system/init, turn.completed from result
		expect(eventTypes).toContain("session.status");
		expect(eventTypes).toContain("turn.completed");
	});

	// ── Test 6: Stream consumer handles errors ────────────────────────────

	it("stream consumer handles errors and resolves with error status", async () => {
		// biome-ignore lint/correctness/useYield: intentionally throws before yielding
		const gen = (async function* () {
			throw new Error("SDK stream explosion");
		})();
		const mockQuery = Object.assign(gen, {
			interrupt: vi.fn(async () => {}),
			close: vi.fn(),
			setModel: vi.fn(async () => {}),
			setPermissionMode: vi.fn(async () => {}),
			streamInput: vi.fn(async () => {}),
			setMaxThinkingTokens: vi.fn(async () => {}),
			applyFlagSettings: vi.fn(async () => {}),
			initializationResult: vi.fn(async () => ({})),
			supportedCommands: vi.fn(async () => []),
			supportedModels: vi.fn(async () => []),
			supportedAgents: vi.fn(async () => []),
			mcpServerStatus: vi.fn(async () => []),
			getContextUsage: vi.fn(async () => ({})),
			reloadPlugins: vi.fn(async () => ({})),
			accountInfo: vi.fn(async () => ({})),
			rewindFiles: vi.fn(async () => ({ canRewind: false })),
			seedReadState: vi.fn(async () => {}),
			reconnectMcpServer: vi.fn(async () => {}),
			toggleMcpServer: vi.fn(async () => {}),
			setMcpServers: vi.fn(async () => ({})),
			stopTask: vi.fn(async () => {}),
			next: gen.next.bind(gen),
			return: gen.return.bind(gen),
			throw: gen.throw.bind(gen),
			[Symbol.asyncIterator]: () => gen,
		}) as unknown as Query;

		queryFactorySpy = vi.fn(() => mockQuery);
		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const sink = createMockEventSink();
		const input = makeBaseSendTurnInput({
			sessionId: "session-error",
			eventSink: sink,
		});

		const result = await adapter.sendTurn(input);

		expect(result.status).toBe("error");
		// translateError should have fired a turn.error event
		const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
			.calls as Array<[CanonicalEvent]>;
		const errorEvents = pushCalls.filter(
			(call) => call[0].type === "turn.error",
		);
		expect(errorEvents.length).toBeGreaterThanOrEqual(1);
	});

	// ── Test 6b: SDK error result yields TurnResult with error details ───────

	it("SDK error result yields TurnResult with status error and error details", async () => {
		const errorResult = makeErrorResult();
		const mockQuery = createMockQuery([errorResult]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const sink = createMockEventSink();
		const input = makeBaseSendTurnInput({
			sessionId: "session-error-result",
			eventSink: sink,
		});

		const result = await adapter.sendTurn(input);

		expect(result.status).toBe("error");
		expect(result.error).toBeDefined();
		expect(result.error!.code).toBe("error_during_execution");
		expect(result.error!.message).toBe("Something went wrong");
		expect(result.cost).toBe(0.01);
		expect(result.tokens.input).toBe(50);
		expect(result.tokens.output).toBe(10);
		expect(result.durationMs).toBe(500);
	});

	// ── Test 7: Concurrent sendTurn() for same session is serialized ──────

	it("concurrent sendTurn() for same session creates only one query()", async () => {
		// Use a delayed query so both sendTurn() calls overlap
		let resolveReady: (() => void) | undefined;
		const ready = new Promise<void>((r) => {
			resolveReady = r;
		});

		const result1 = makeSuccessResult();
		const result2 = makeSuccessResult({ total_cost_usd: 0.07 } as Record<
			string,
			unknown
		>);

		const gen = (async function* () {
			yield result1 as unknown as SDKMessage;
			await ready;
			yield result2 as unknown as SDKMessage;
		})();

		const mockQuery = Object.assign(gen, {
			interrupt: vi.fn(async () => {}),
			close: vi.fn(),
			setModel: vi.fn(async () => {}),
			setPermissionMode: vi.fn(async () => {}),
			streamInput: vi.fn(async () => {}),
			setMaxThinkingTokens: vi.fn(async () => {}),
			applyFlagSettings: vi.fn(async () => {}),
			initializationResult: vi.fn(async () => ({})),
			supportedCommands: vi.fn(async () => []),
			supportedModels: vi.fn(async () => []),
			supportedAgents: vi.fn(async () => []),
			mcpServerStatus: vi.fn(async () => []),
			getContextUsage: vi.fn(async () => ({})),
			reloadPlugins: vi.fn(async () => ({})),
			accountInfo: vi.fn(async () => ({})),
			rewindFiles: vi.fn(async () => ({ canRewind: false })),
			seedReadState: vi.fn(async () => {}),
			reconnectMcpServer: vi.fn(async () => {}),
			toggleMcpServer: vi.fn(async () => {}),
			setMcpServers: vi.fn(async () => ({})),
			stopTask: vi.fn(async () => {}),
			next: gen.next.bind(gen),
			return: gen.return.bind(gen),
			throw: gen.throw.bind(gen),
			[Symbol.asyncIterator]: () => gen,
		}) as unknown as Query;

		queryFactorySpy = vi.fn(() => mockQuery);
		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const sink = createMockEventSink();
		const input1 = makeBaseSendTurnInput({
			sessionId: "session-concurrent",
			turnId: "turn-1",
			prompt: "First",
			eventSink: sink,
		});
		const input2 = makeBaseSendTurnInput({
			sessionId: "session-concurrent",
			turnId: "turn-2",
			prompt: "Second",
			eventSink: sink,
		});

		// Fire both concurrently
		const p1 = adapter.sendTurn(input1);
		const p2 = adapter.sendTurn(input2);

		// First turn resolves immediately (result1 is yielded right away)
		const r1 = await p1;
		expect(r1.status).toBe("completed");

		// Unblock second result
		resolveReady!();
		const r2 = await p2;
		expect(r2.status).toBe("completed");

		// Only one query() should have been created
		expect(queryFactorySpy).toHaveBeenCalledTimes(1);
	});

	// ── Test 8: sendTurn() without persistence (eventSink only) ───────────

	it("sendTurn() works with eventSink as only required dep", async () => {
		const resultMsg = makeSuccessResult();
		const mockQuery = createMockQuery([resultMsg]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const sink = createMockEventSink();
		const input = makeBaseSendTurnInput({
			sessionId: "session-minimal",
			eventSink: sink,
		});

		const result = await adapter.sendTurn(input);

		expect(result.status).toBe("completed");
		expect(result.providerStateUpdates).toBeDefined();
		expect(result.providerStateUpdates.length).toBeGreaterThan(0);
	});

	// ── Test 9: Stream ends without result message ────────────────────────

	it("rejects when SDK stream ends without result message", async () => {
		// Query that yields a non-result message then closes
		const systemMsg = {
			type: "system" as const,
			subtype: "init" as const,
			model: "claude-sonnet-4",
			session_id: "sdk-session-1",
		} as unknown as SDKMessage;

		const mockQuery = createMockQuery([systemMsg]);
		queryFactorySpy = vi.fn(() => mockQuery);

		const adapter = new ClaudeAdapter({
			workspaceRoot: workspace,
			queryFactory: queryFactorySpy,
		});

		const input = makeBaseSendTurnInput({
			sessionId: "session-no-result",
		});

		await expect(adapter.sendTurn(input)).rejects.toThrow(
			"SDK stream ended without result",
		);
	});
});
