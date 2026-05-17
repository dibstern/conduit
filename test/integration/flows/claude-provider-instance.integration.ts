// ─── Integration: Claude Provider Instance Full Lifecycle ──────────────────────────────
// End-to-end lifecycle tests that exercise the full ClaudeProviderInstance flow with a
// mock SDK query factory. These verify that the provider instance, event translator,
// and permission bridge work together correctly.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { ClaudeProviderInstance } from "../../../src/lib/provider/claude/claude-provider-instance.js";
import type {
	Query,
	SDKMessage,
} from "../../../src/lib/provider/claude/types.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../helpers/mock-sdk.js";

function systemInitMessage(sessionId: string, workspace: string): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		uuid: `${sessionId}-init`,
		session_id: sessionId,
		apiKeySource: "none",
		claude_code_version: "test",
		cwd: workspace,
		tools: [],
		mcp_servers: [],
		model: "claude-sonnet-4",
		permissionMode: "default",
		slash_commands: [],
		output_style: "default",
		skills: [],
		plugins: [],
	} as unknown as SDKMessage;
}

function assistantMessage(sessionId: string, uuid: string): SDKMessage {
	return {
		type: "assistant",
		uuid,
		session_id: sessionId,
		parent_tool_use_id: null,
		message: { role: "assistant", content: [] },
	} as unknown as SDKMessage;
}

function streamEventMessage(
	sessionId: string,
	uuid: string,
	event: Record<string, unknown>,
): SDKMessage {
	return {
		type: "stream_event",
		uuid,
		session_id: sessionId,
		parent_tool_use_id: null,
		event,
	} as unknown as SDKMessage;
}

function userToolResultMessage(
	sessionId: string,
	toolUseId: string,
	content: string,
): SDKMessage {
	return {
		type: "user",
		uuid: `${sessionId}-tool-result-${toolUseId}`,
		session_id: sessionId,
		parent_tool_use_id: null,
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content,
				},
			],
		},
	} as unknown as SDKMessage;
}

describe("Integration: ClaudeProviderInstance full lifecycle", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-integ-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	// ── Test 1: Full turn lifecycle ─────────────────────────────────────────

	it("full turn: system init → assistant → text deltas → tool_use → tool_result → result", async () => {
		// Build a realistic SDK message sequence that exercises the full
		// translator pipeline: system/init, assistant snapshot, stream events
		// for content blocks (text + tool_use), user tool_result, and result.

		const toolUseId = "toolu_01ABC123";

		const messages: SDKMessage[] = [
			// 1. System init
			systemInitMessage("sdk-sess-integ-1", workspace),

			// 2. Assistant snapshot (sets the current message UUID)
			assistantMessage("sdk-sess-integ-1", "asst-uuid-integ-1"),

			// 3. Content block start: text
			streamEventMessage("sdk-sess-integ-1", "stream-integ-1", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),

			// 4. Text deltas
			streamEventMessage("sdk-sess-integ-1", "stream-integ-2", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Let me " },
			}),
			streamEventMessage("sdk-sess-integ-1", "stream-integ-3", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "help you." },
			}),

			// 5. Content block stop: text
			streamEventMessage("sdk-sess-integ-1", "stream-integ-4", {
				type: "content_block_stop",
				index: 0,
			}),

			// 6. Content block start: tool_use
			streamEventMessage("sdk-sess-integ-1", "stream-integ-5", {
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: toolUseId,
					name: "Read",
					input: {},
				},
			}),

			// 7. Input JSON delta for tool_use
			streamEventMessage("sdk-sess-integ-1", "stream-integ-6", {
				type: "content_block_delta",
				index: 1,
				delta: {
					type: "input_json_delta",
					partial_json: '{"file_path":"/tmp/test.ts"}',
				},
			}),

			// 8. Content block stop: tool_use
			streamEventMessage("sdk-sess-integ-1", "stream-integ-7", {
				type: "content_block_stop",
				index: 1,
			}),

			// 9. User message with tool_result
			userToolResultMessage(
				"sdk-sess-integ-1",
				toolUseId,
				"file contents here",
			),

			// 10. Result
			makeSuccessResult({
				session_id: "sdk-sess-integ-1",
				total_cost_usd: 0.03,
				duration_ms: 2000,
				usage: {
					input_tokens: 200,
					output_tokens: 100,
					cache_read_input_tokens: 20,
					cache_creation_input_tokens: 0,
				},
			} as Record<string, unknown>),
		];

		const mockQuery = createMockQuery(messages);
		const queryFactory = vi.fn(() => mockQuery);

		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory,
		});

		const sink = createMockEventSink();
		const input = makeBaseSendTurnInput({
			sessionId: "session-integ-full",
			turnId: "turn-integ-1",
			prompt: "Read the file",
			eventSink: sink,
			workspaceRoot: workspace,
		});

		const result = await Effect.runPromise(instance.sendTurnEffect(input));

		// ── Verify TurnResult ──────────────────────────────────────────
		expect(result.status).toBe("completed");
		expect(result.cost).toBe(0.03);
		expect(result.tokens.input).toBe(200);
		expect(result.tokens.output).toBe(100);
		expect(result.durationMs).toBe(2000);

		// ── Verify event sequence ──────────────────────────────────────
		const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
			.calls as Array<[CanonicalEvent]>;
		const eventTypes = pushCalls.map((call) => call[0].type);

		// Must contain session.status from system/init
		expect(eventTypes).toContain("session.status");

		// Must contain text.delta events from the text content block
		const textDeltas = pushCalls.filter((c) => c[0].type === "text.delta");
		expect(textDeltas.length).toBe(2);
		// Verify the text content
		const textPayloads = textDeltas.map(
			(c) => (c[0].data as { text: string }).text,
		);
		expect(textPayloads).toContain("Let me ");
		expect(textPayloads).toContain("help you.");

		// Must contain tool.started for the text block and the tool_use block
		const toolStarted = pushCalls.filter((c) => c[0].type === "tool.started");
		expect(toolStarted.length).toBeGreaterThanOrEqual(1); // tool_use block (text block may not emit tool.started)

		// Verify the tool_use started event has the correct tool name
		const readToolStarted = toolStarted.find(
			(c) => (c[0].data as { toolName: string }).toolName === "Read",
		);
		expect(readToolStarted).toBeDefined();

		// Must contain tool.running from input_json_delta
		const toolRunning = pushCalls.filter((c) => c[0].type === "tool.running");
		expect(toolRunning.length).toBeGreaterThanOrEqual(1);

		// Must contain tool.completed for the tool_result
		const toolCompleted = pushCalls.filter(
			(c) => c[0].type === "tool.completed",
		);
		expect(toolCompleted.length).toBeGreaterThanOrEqual(1);
		// One of the tool.completed events should have the tool result content
		const toolResultEvent = toolCompleted.find(
			(c) => (c[0].data as { result: unknown }).result === "file contents here",
		);
		expect(toolResultEvent).toBeDefined();

		// Must end with turn.completed
		const turnCompleted = pushCalls.filter(
			(c) => c[0].type === "turn.completed",
		);
		expect(turnCompleted.length).toBe(1);

		// ── Verify ordering: session.status before text.delta before tool ──
		const statusIdx = eventTypes.indexOf("session.status");
		const firstTextDeltaIdx = eventTypes.indexOf("text.delta");
		const firstToolStartIdx = eventTypes.findIndex(
			(t, i) =>
				t === "tool.started" &&
				(pushCalls[i]?.[0].data as { toolName: string }).toolName === "Read",
		);
		const turnCompletedIdx = eventTypes.lastIndexOf("turn.completed");

		expect(statusIdx).toBeLessThan(firstTextDeltaIdx);
		expect(firstTextDeltaIdx).toBeLessThan(firstToolStartIdx);
		expect(firstToolStartIdx).toBeLessThan(turnCompletedIdx);
	});

	// ── Test 2: Permission flow round-trip ──────────────────────────────────

	it("permission flow: tool_use → canUseTool → requestPermission → allow → tool_result → result", async () => {
		// This test exercises the permission bridge integration. The provider instance's
		// canUseTool callback is invoked by the SDK when a tool needs approval.
		// We simulate this by having the queryFactory capture the canUseTool
		// callback from options, then invoking it manually during the query
		// iteration to simulate the SDK's permission check.

		const toolUseId = "toolu_perm_01";

		// We need a controllable query that:
		// 1. Yields initial messages
		// 2. Pauses while canUseTool is called (simulating SDK behavior)
		// 3. Yields tool_result and result after permission is granted

		let capturedCanUseTool:
			| ((
					toolName: string,
					input: Record<string, unknown>,
					opts: { signal: AbortSignal; toolUseID: string },
			  ) => Promise<{
					behavior: string;
					updatedInput?: Record<string, unknown>;
					message?: string;
			  }>)
			| undefined;

		let resolvePermissionPhase: (() => void) | undefined;
		const permissionPhaseReady = new Promise<void>((r) => {
			resolvePermissionPhase = r;
		});

		let resolvePostPermission: (() => void) | undefined;
		const postPermissionReady = new Promise<void>((r) => {
			resolvePostPermission = r;
		});

		const gen = (async function* () {
			// System init
			yield systemInitMessage("sdk-sess-perm-1", workspace);

			// Assistant snapshot
			yield assistantMessage("sdk-sess-perm-1", "asst-uuid-perm-1");

			// Tool_use content block start
			yield streamEventMessage("sdk-sess-perm-1", "stream-perm-1", {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: toolUseId,
					name: "Bash",
					input: {},
				},
			});

			// Tool input
			yield streamEventMessage("sdk-sess-perm-1", "stream-perm-2", {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"command":"rm -rf /"}',
				},
			});

			// Content block stop
			yield streamEventMessage("sdk-sess-perm-1", "stream-perm-3", {
				type: "content_block_stop",
				index: 0,
			});

			// Signal that the permission phase is ready for canUseTool invocation
			resolvePermissionPhase?.();

			// Wait for permission to be resolved before continuing
			await postPermissionReady;

			// Tool result (after permission was granted)
			yield userToolResultMessage(
				"sdk-sess-perm-1",
				toolUseId,
				"command output",
			);

			// Result
			yield makeSuccessResult({
				session_id: "sdk-sess-perm-1",
			} as Record<string, unknown>) as unknown as SDKMessage;
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

		// Capture canUseTool from options when queryFactory is called
		const queryFactory = vi.fn(
			(params: {
				prompt: AsyncIterable<unknown>;
				options?: Record<string, unknown>;
			}) => {
				capturedCanUseTool = params.options?.[
					"canUseTool"
				] as typeof capturedCanUseTool;
				return mockQuery;
			},
		);

		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory: queryFactory as unknown as NonNullable<
				ConstructorParameters<typeof ClaudeProviderInstance>[0]["queryFactory"]
			>,
		});

		// Set up the event sink with a requestPermission that resolves with "once"
		// after a short delay (simulating user interaction).
		const sink = createMockEventSink();
		// Override requestPermission to resolve asynchronously
		(sink.requestPermission as ReturnType<typeof vi.fn>).mockImplementation(
			() => Effect.succeed({ decision: "once" as const }),
		);

		const input = makeBaseSendTurnInput({
			sessionId: "session-integ-perm",
			turnId: "turn-perm-1",
			prompt: "Run the command",
			eventSink: sink,
			workspaceRoot: workspace,
		});

		// Start the turn (non-blocking; the query will pause at permission phase)
		const turnPromise = Effect.runPromise(instance.sendTurnEffect(input));

		// Wait for the permission phase to be ready
		await permissionPhaseReady;

		// Now invoke canUseTool as the SDK would, simulating the permission check.
		// The provider instance should have wired canUseTool through the permission bridge.
		expect(capturedCanUseTool).toBeDefined();
		if (!capturedCanUseTool) throw new Error("canUseTool not captured");

		const abortController = new AbortController();
		const permissionResult = await capturedCanUseTool(
			"Bash",
			{ command: "rm -rf /" },
			{ signal: abortController.signal, toolUseID: toolUseId },
		);

		// The permission bridge calls eventSink.requestPermission, which we
		// mocked to return { decision: "once" }. So permissionResult should
		// resolve with { behavior: "allow" }.
		expect(permissionResult.behavior).toBe("allow");

		// Now unblock the post-permission messages
		resolvePostPermission?.();

		// Wait for the turn to complete
		const result = await turnPromise;

		// ── Verify turn completed successfully ─────────────────────────
		expect(result.status).toBe("completed");

		// ── Verify requestPermission was called ────────────────────────
		expect(sink.requestPermission).toHaveBeenCalledTimes(1);
		const permCall = (sink.requestPermission as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(permCall["toolName"]).toBe("Bash");
		expect(permCall["sessionId"]).toBe("session-integ-perm");

		// ── Verify event sequence includes tool events ─────────────────
		const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
			.calls as Array<[CanonicalEvent]>;
		const eventTypes = pushCalls.map((c) => c[0].type);

		// Should have session.status, tool.started, tool.running,
		// tool.completed, and turn.completed
		expect(eventTypes).toContain("session.status");
		expect(eventTypes).toContain("tool.started");
		expect(eventTypes).toContain("tool.running");
		expect(eventTypes).toContain("tool.completed");
		expect(eventTypes).toContain("turn.completed");

		// Tool started should reference "Bash"
		const bashStarted = pushCalls.find(
			(c) =>
				c[0].type === "tool.started" &&
				(c[0].data as { toolName: string }).toolName === "Bash",
		);
		expect(bashStarted).toBeDefined();

		// Tool completed should have the result
		const bashCompleted = pushCalls.find(
			(c) =>
				c[0].type === "tool.completed" &&
				(c[0].data as { result: unknown }).result === "command output",
		);
		expect(bashCompleted).toBeDefined();
	});
});
