// test/helpers/mock-sdk.ts
// Shared mock helpers for the Claude Agent SDK used across adapter and
// integration tests.

import { vi } from "vitest";
import type {
	Query,
	SDKMessage,
	SDKResultMessage,
} from "../../src/lib/provider/claude/types.js";
import type { EventSink, SendTurnInput } from "../../src/lib/provider/types.js";

// ─── createMockQuery ────────────────────────────────────────────────────────

/**
 * Build a mock `Query` (the async-iterable + methods object returned by the
 * SDK's `query()` function) that yields the supplied messages and then closes.
 */
export function createMockQuery(messages: SDKMessage[]): Query {
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

// ─── createMockEventSink ────────────────────────────────────────────────────

/** Create a stub EventSink whose methods are `vi.fn()` spies. */
export function createMockEventSink(): EventSink {
	return {
		push: vi.fn(async () => {}),
		requestPermission: vi.fn(async () => ({ decision: "once" as const })),
		requestQuestion: vi.fn(async () => ({})),
	};
}

// ─── SDK result factories ───────────────────────────────────────────────────

/** Create a successful SDK result message with sensible defaults. */
export function makeSuccessResult(
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

/** Create an error SDK result message with sensible defaults. */
export function makeErrorResult(
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

// ─── SendTurnInput factory ──────────────────────────────────────────────────

/** Create a base `SendTurnInput` with sensible defaults. */
export function makeBaseSendTurnInput(
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
