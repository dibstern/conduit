import { describe, expect, it, vi } from "vitest";
import {
	type ClientInitDeps,
	handleClientConnected,
} from "../../../src/lib/bridges/client-init.js";
import { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { createMockClientInitDeps } from "../../helpers/mock-factories.js";

/** Cast a plain string to PermissionId for test data. */
const pid = (s: string) => s as PermissionId;

// ─── Test-specific defaults ─────────────────────────────────────────────────
// The shared factory provides minimal defaults. These helpers set the richer
// mock return values that this test file's assertions depend on.

const TEST_AGENTS = [
	{ id: "1", name: "coder", description: "Main agent" },
	{ id: "2", name: "title", description: "Title generator" },
];

const TEST_PROVIDERS = {
	providers: [
		{
			id: "openai",
			name: "OpenAI",
			models: [{ id: "gpt-4", name: "GPT-4" }],
		},
		{
			id: "anthropic",
			name: "Anthropic",
			models: [{ id: "claude-3", name: "Claude 3" }],
		},
	],
	defaults: { openai: "gpt-4" },
	connected: ["openai"],
};

const TEST_HISTORY = {
	messages: [{ role: "user", content: "hi" }] as unknown[],
	hasMore: false,
	total: 1,
} as Awaited<
	ReturnType<ClientInitDeps["sessionMgr"]["loadPreRenderedHistory"]>
>;

/** Apply test-specific mock return values on top of shared factory defaults. */
function applyTestDefaults(deps: ClientInitDeps): ClientInitDeps {
	vi.mocked(deps.client.listAgents).mockResolvedValue(TEST_AGENTS);
	vi.mocked(deps.client.listProviders).mockResolvedValue(TEST_PROVIDERS);
	vi.mocked(deps.sessionMgr.loadPreRenderedHistory).mockResolvedValue(
		TEST_HISTORY,
	);
	return deps;
}

// ─── Session with cached events ──────────────────────────────────────────────

describe("handleClientConnected — session with cached events", () => {
	it("sends session_switched with cached events when cache has chat content", async () => {
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hi" },
			{ type: "delta", text: "hello" },
		];
		const deps = createMockClientInitDeps();
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(cachedEvents);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-1",
			// Session is idle and cache has no done — synthetic done is appended
			events: [...cachedEvents, { type: "done", code: 0 }],
		});
	});

	it("sends status idle after session_switched", async () => {
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hi" },
			{ type: "delta", text: "hello" },
		];
		const deps = createMockClientInitDeps();
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(cachedEvents);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchIdx = sendToCalls.findIndex(
			(c) => (c[1] as { type: string }).type === "session_switched",
		);
		const statusIdx = sendToCalls.findIndex(
			(c) =>
				(c[1] as { type: string }).type === "status" &&
				(c[1] as { status: string }).status === "idle",
		);
		expect(switchIdx).toBeLessThan(statusIdx);
	});
});

// ─── Session with REST API fallback ──────────────────────────────────────────

describe("handleClientConnected — REST API history fallback", () => {
	it("sends session_switched with REST API history when cache misses", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());
		// Cache returns null — no events
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(null);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-1",
			history: {
				messages: [{ role: "user", content: "hi" }],
				hasMore: false,
				total: 1,
			},
		});
	});

	it("sends session_switched without data when REST API also fails", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(null);
		vi.mocked(deps.sessionMgr.loadPreRenderedHistory).mockRejectedValue(
			new Error("REST fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-1",
		});
	});

	it("uses REST fallback when cache has events but no chat content", async () => {
		const deps = createMockClientInitDeps();
		// Events exist but only non-chat types (e.g., status, done)
		const nonChatEvents: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(nonChatEvents);

		await handleClientConnected(deps, "client-1");

		// Should NOT include events (no chat content), should use REST fallback
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"session-1",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "session_switched",
				id: "session-1",
				history: expect.any(Object),
			}),
		);
	});
});

// ─── Model info ──────────────────────────────────────────────────────────────

describe("handleClientConnected — model info", () => {
	it("sends model_info when session has modelID", async () => {
		const deps = createMockClientInitDeps();

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("sends model_info from overrides when session has no model", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.getSession).mockResolvedValue({
			id: "s1",
			modelID: "",
		} as Awaited<ReturnType<typeof deps.client.getSession>>);
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-3",
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			model: "claude-3",
			provider: "anthropic",
		});
	});

	it("sends overrides model_info as fallback when getSession fails", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.getSession).mockRejectedValue(
			new Error("session fail"),
		);
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-3",
		});

		await handleClientConnected(deps, "client-1");

		// Should send INIT_FAILED error
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INIT_FAILED" }),
		);
		// And still send model_info from overrides
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			model: "claude-3",
			provider: "anthropic",
		});
	});

	it("does not send model_info when neither session nor overrides have model", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.getSession).mockResolvedValue({
			id: "s1",
			modelID: "",
		} as Awaited<ReturnType<typeof deps.client.getSession>>);
		// overrides.model is already undefined by default

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const modelInfoCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "model_info",
		);
		expect(modelInfoCalls).toHaveLength(0);
	});
});

// ─── Session list ────────────────────────────────────────────────────────────

describe("handleClientConnected — session list", () => {
	it("sends session_list to connecting client", async () => {
		const deps = createMockClientInitDeps();

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_list",
			sessions: [
				{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
			],
			roots: true,
		});
	});

	it("sends INIT_FAILED when sendDualSessionLists throws", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.sessionMgr.sendDualSessionLists).mockRejectedValue(
			new Error("list fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INIT_FAILED" }),
		);
	});
});

// ─── Agent list ──────────────────────────────────────────────────────────────

describe("handleClientConnected — agent list", () => {
	it("sends agent_list filtering internal agents", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			agents: [{ id: "coder", name: "coder", description: "Main agent" }],
		});
	});

	it("sends INIT_FAILED when listAgents throws", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.listAgents).mockRejectedValue(
			new Error("agents fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INIT_FAILED" }),
		);
	});
});

// ─── Model list (providers) ──────────────────────────────────────────────────

describe("handleClientConnected — model list", () => {
	it("sends model_list with only configured providers", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_list",
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [{ id: "gpt-4", name: "GPT-4", provider: "openai" }],
				},
			],
		});
	});

	it("auto-selects default model when defaultModel is not set", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());

		await handleClientConnected(deps, "client-1");

		expect(deps.overrides.setDefaultModel).toHaveBeenCalledWith({
			providerID: "openai",
			modelID: "gpt-4",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "model_info",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("does not auto-select when defaultModel is already set", async () => {
		const deps = createMockClientInitDeps();
		(
			deps.overrides as {
				defaultModel: { providerID: string; modelID: string } | undefined;
			}
		).defaultModel = {
			providerID: "anthropic",
			modelID: "claude-3",
		};

		await handleClientConnected(deps, "client-1");

		expect(deps.overrides.setDefaultModel).not.toHaveBeenCalled();
	});

	it("sends INIT_FAILED when listProviders throws", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.listProviders).mockRejectedValue(
			new Error("providers fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INIT_FAILED" }),
		);
	});
});

// ─── Config-seeded defaultModel priority ────────────────────────────────────

describe("handleClientConnected — defaultModel priority", () => {
	it("prefers defaultModel over provider-level default", async () => {
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				overrides: {
					defaultModel: {
						providerID: "openai",
						modelID: "gpt-4-turbo",
					},
					setDefaultModel: vi.fn(),
					setModelDefault: vi.fn(),
					getVariant: vi.fn().mockReturnValue(""),
					getModel: vi.fn().mockReturnValue(undefined),
					defaultVariant: "",
				} as unknown as ClientInitDeps["overrides"],
			}),
		);

		await handleClientConnected(deps, "client-1");

		// Should NOT call setDefaultModel since defaultModel is already set
		expect(deps.overrides.setDefaultModel).not.toHaveBeenCalled();
		// Should send model_info to the client (not broadcast)
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "default_model_info",
			model: "gpt-4-turbo",
			provider: "openai",
		});
	});

	it("falls back to provider default when defaultModel provider is not connected", async () => {
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				overrides: {
					defaultModel: {
						providerID: "google",
						modelID: "gemini-pro",
					},
					setDefaultModel: vi.fn(),
					setModelDefault: vi.fn(),
					getVariant: vi.fn().mockReturnValue(""),
					getModel: vi.fn().mockReturnValue(undefined),
					defaultVariant: "",
				} as unknown as ClientInitDeps["overrides"],
			}),
		);

		await handleClientConnected(deps, "client-1");

		// google is not connected — defaultModel exists but its provider isn't available.
		// The relay should NOT override the user's persisted default just because the
		// provider is temporarily offline. No auto-select should happen.
		expect(deps.overrides.setDefaultModel).not.toHaveBeenCalled();
	});

	it("falls back to provider default when defaultModel is undefined", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps()); // no defaultModel set

		await handleClientConnected(deps, "client-1");

		// Should use provider default since no defaultModel
		expect(deps.overrides.setDefaultModel).toHaveBeenCalledWith({
			providerID: "openai",
			modelID: "gpt-4",
		});
	});
});

// ─── PTY replay ──────────────────────────────────────────────────────────────

describe("handleClientConnected — PTY replay", () => {
	it("sends pty_list and replays scrollback for each session", async () => {
		const deps = createMockClientInitDeps();
		(deps.ptyManager as { sessionCount: number }).sessionCount = 2;
		vi.mocked(deps.ptyManager.listSessions).mockReturnValue([
			{ id: "pty-1", status: "running" },
			{ id: "pty-2", status: "running" },
		]);
		vi.mocked(deps.ptyManager.getScrollback).mockImplementation((id) => {
			if (id === "pty-1") return "$ ls\nfoo.ts\n";
			return "";
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "pty_list",
			ptys: [
				{ id: "pty-1", status: "running" },
				{ id: "pty-2", status: "running" },
			],
		});
		// Scrollback replayed for pty-1 (has content)
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "pty_output",
			ptyId: "pty-1",
			data: "$ ls\nfoo.ts\n",
		});
	});

	it("sends pty_exited for exited PTY sessions", async () => {
		const deps = createMockClientInitDeps();
		(deps.ptyManager as { sessionCount: number }).sessionCount = 1;
		vi.mocked(deps.ptyManager.listSessions).mockReturnValue([
			{ id: "pty-1", status: "exited" },
		]);
		vi.mocked(deps.ptyManager.getScrollback).mockReturnValue("done\n");
		vi.mocked(deps.ptyManager.getSession).mockReturnValue({
			exited: true,
			exitCode: 1,
			upstream: {} as unknown,
			scrollback: [],
			scrollbackSize: 0,
		} as ReturnType<typeof deps.ptyManager.getSession>);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "pty_exited",
			ptyId: "pty-1",
			exitCode: 1,
		});
	});

	it("does not send pty_list when no PTY sessions exist", async () => {
		const deps = createMockClientInitDeps();
		// sessionCount is 0 by default

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const ptyListCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "pty_list",
		);
		expect(ptyListCalls).toHaveLength(0);
	});
});

// ─── No active session ───────────────────────────────────────────────────────

describe("handleClientConnected — no active session", () => {
	it("skips session info and model info when no active session", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.sessionMgr.getDefaultSessionId).mockResolvedValue(
			undefined as unknown as string,
		);

		await handleClientConnected(deps, "client-1");

		// Should NOT send session_switched or model_info via sendTo
		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "session_switched",
		);
		expect(switchCalls).toHaveLength(0);

		// Should still send session_list, agent_list, model_list
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_list" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "agent_list" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "model_list" }),
		);
	});
});

// ─── Pending permissions replay ──────────────────────────────────────────────

describe("handleClientConnected — pending permissions", () => {
	it("sends pending permission requests to reconnecting client", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId: pid("perm-1"),
				sessionId: "ses-1",
				toolName: "file_write",
				toolInput: { patterns: ["/tmp/*"], metadata: {} },
				always: [],
				timestamp: 1000,
			},
			{
				requestId: pid("perm-2"),
				sessionId: "ses-1",
				toolName: "shell_exec",
				toolInput: { patterns: [], metadata: { command: "rm -rf" } },
				always: ["shell_exec"],
				timestamp: 2000,
			},
		]);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("perm-1"),
			toolName: "file_write",
			toolInput: { patterns: ["/tmp/*"], metadata: {} },
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("perm-2"),
			toolName: "shell_exec",
			toolInput: { patterns: [], metadata: { command: "rm -rf" } },
		});
	});

	it("does not send permission_request when no pending permissions", async () => {
		const deps = createMockClientInitDeps();
		// getPending returns [] by default

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		expect(permCalls).toHaveLength(0);
	});

	it("replayed permissions include sessionId", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId: pid("perm-1"),
				sessionId: "ses-xyz",
				toolName: "Bash",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-xyz",
			requestId: pid("perm-1"),
			toolName: "Bash",
			toolInput: { patterns: [], metadata: {} },
		});
	});
});

// ─── Pending questions replay ────────────────────────────────────────────────

describe("handleClientConnected — pending questions", () => {
	it("sends pending questions to reconnecting client", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{
				id: "que_tool1",
				questions: [
					{
						question: "Which option?",
						header: "Select",
						options: [
							{ label: "A", description: "Option A" },
							{ label: "B", description: "Option B" },
						],
						multiple: false,
						custom: true,
					},
				],
				tool: { callID: "toolu_abc123" },
			},
		]);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "ask_user",
			toolId: "que_tool1",
			questions: [
				{
					question: "Which option?",
					header: "Select",
					options: [
						{ label: "A", description: "Option A" },
						{ label: "B", description: "Option B" },
					],
					multiSelect: false,
					custom: true,
				},
			],
			toolUseId: "toolu_abc123",
		});
	});

	it("does not send ask_user when no pending questions", async () => {
		const deps = createMockClientInitDeps();
		// listPendingQuestions returns [] by default

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);
		expect(askCalls).toHaveLength(0);
	});

	it("sends both pending permissions and questions together", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId: pid("perm-1"),
				sessionId: "ses-1",
				toolName: "file_write",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{
				id: "que_tool1",
				questions: [
					{
						question: "Continue?",
						header: "",
						options: [],
						multiple: false,
						custom: true,
					},
				],
			},
		]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);
		expect(permCalls).toHaveLength(1);
		expect(askCalls).toHaveLength(1);
	});

	it("filters out questions from other sessions", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{
				id: "que_this",
				questions: [
					{
						question: "Q1?",
						header: "H",
						options: [],
						multiple: false,
						custom: true,
					},
				],
				sessionID: "session-1", // matches default activeId
			},
			{
				id: "que_other",
				questions: [
					{
						question: "Q2?",
						header: "H",
						options: [],
						multiple: false,
						custom: true,
					},
				],
				sessionID: "session-OTHER",
			},
		]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);
		// Only the question matching the active session should be sent
		expect(askCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((askCalls[0]![1] as { toolId: string }).toolId).toBe("que_this");
	});
});

// ─── Error resilience ────────────────────────────────────────────────────────

describe("handleClientConnected — error resilience", () => {
	it("continues sending remaining data when getSession fails", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.getSession).mockRejectedValue(
			new Error("session fail"),
		);

		await handleClientConnected(deps, "client-1");

		// Should still send session_list, agent_list, model_list
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_list" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "agent_list" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "model_list" }),
		);
	});

	it("does not crash when all API calls fail", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.getSession).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.sessionMgr.sendDualSessionLists).mockRejectedValue(
			new Error("fail"),
		);
		vi.mocked(deps.client.listAgents).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.client.listProviders).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.sessionMgr.loadPreRenderedHistory).mockRejectedValue(
			new Error("fail"),
		);

		// Should NOT throw
		await expect(
			handleClientConnected(deps, "client-1"),
		).resolves.toBeUndefined();

		// Should have sent multiple INIT_FAILED errors
		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const errorCalls = sendToCalls.filter(
			(c) =>
				(c[1] as { type: string }).type === "error" &&
				(c[1] as { code: string }).code === "INIT_FAILED",
		);
		expect(errorCalls.length).toBeGreaterThanOrEqual(3);
	});
});

// ─── Gap 3: Real bridges integration ─────────────────────────────────────────
// Previous tests use vi.fn() mocks for bridges. These tests use real
// PermissionBridge instances to verify the actual data shape from getPending()
// matches what handleClientConnected sends. Questions are now fetched via the
// REST API (client.listPendingQuestions), so those tests use mock return values
// in the API format (with `multiple` instead of `multiSelect`).

describe("handleClientConnected — real bridges integration (Gap 3)", () => {
	it("replays permission from real PermissionBridge populated via onPermissionRequest", async () => {
		const bridge = new PermissionBridge();

		// Feed a real SSE event through the bridge
		const sseEvent: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-real-1",
				permission: "file_write",
				patterns: ["/tmp/test.txt"],
				metadata: { foo: "bar" },
				always: ["shell_exec"],
			},
		};
		bridge.onPermissionRequest(sseEvent);
		expect(bridge.size).toBe(1);

		const deps = createMockClientInitDeps({
			permissionBridge: bridge,
		});

		await handleClientConnected(deps, "client-1");

		// Verify the exact message shape sent to the client
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "",
			requestId: pid("perm-real-1"),
			toolName: "file_write",
			toolInput: { patterns: ["/tmp/test.txt"], metadata: { foo: "bar" } },
		});
	});

	it("replays question from API with field mapping (multiple → multiSelect)", async () => {
		const deps = createMockClientInitDeps();

		// Mock the REST API to return a pending question in OpenCode's format
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{
				id: "q-real-1",
				questions: [
					{
						question: "Which option?",
						header: "Choose",
						options: [
							{ label: "A", description: "opt A" },
							{ label: "B", description: "opt B" },
						],
						multiple: false,
						custom: true,
					},
				],
				tool: { callID: "toolu_xyz" },
			},
		]);

		await handleClientConnected(deps, "client-1");

		// Verify the question was mapped correctly (multiple → multiSelect)
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "ask_user",
			toolId: "q-real-1",
			questions: [
				{
					question: "Which option?",
					header: "Choose",
					options: [
						{ label: "A", description: "opt A" },
						{ label: "B", description: "opt B" },
					],
					multiSelect: false,
					custom: true,
				},
			],
			toolUseId: "toolu_xyz",
		});
	});

	it("replays multiple pending items from real PermissionBridge and API questions simultaneously", async () => {
		// Populate real PermissionBridge with 2 permissions
		const pBridge = new PermissionBridge();
		pBridge.onPermissionRequest({
			type: "permission.asked",
			properties: {
				id: "perm-r1",
				permission: "shell_exec",
				patterns: [],
				metadata: { cmd: "npm install" },
			},
		});
		pBridge.onPermissionRequest({
			type: "permission.asked",
			properties: {
				id: "perm-r2",
				permission: "file_write",
				patterns: ["/src/**"],
				metadata: {},
			},
		});
		expect(pBridge.size).toBe(2);

		const deps = createMockClientInitDeps({
			permissionBridge: pBridge,
		});

		// Mock the REST API to return 1 pending question
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{
				id: "q-r1",
				questions: [{ question: "Continue?", header: "Confirm" }],
			},
		]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);

		expect(permCalls).toHaveLength(2);
		expect(askCalls).toHaveLength(1);

		// Verify specific fields from real bridge data shapes
		const perm1Msg = permCalls.find(
			(c) => (c[1] as { requestId: string }).requestId === "perm-r1",
		);
		expect(perm1Msg).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((perm1Msg![1] as { toolName: string }).toolName).toBe("shell_exec");
	});
});

// ─── API-based permission fetch on connect ───────────────────────────────────

describe("handleClientConnected — API permission rehydration", () => {
	it("fetches permissions from API and sends them to connecting client", async () => {
		const deps = createMockClientInitDeps();
		// Bridge has nothing — simulates relay restart where bridge state is lost
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([]);
		// But API has a pending permission
		vi.mocked(deps.client.listPendingPermissions).mockResolvedValue([
			{
				id: "per_api1",
				sessionID: "ses-abc",
				permission: "file_write",
				patterns: ["/src/*"],
				metadata: { path: "/src/foo.ts" },
				always: [],
			},
		]);
		// recoverPending returns the recovered entries
		vi.mocked(deps.permissionBridge.recoverPending).mockReturnValue([
			{
				requestId: pid("per_api1"),
				sessionId: "ses-abc",
				toolName: "file_write",
				toolInput: { patterns: ["/src/*"], metadata: { path: "/src/foo.ts" } },
				always: [],
				timestamp: 1000,
			},
		]);

		await handleClientConnected(deps, "client-1");

		// Should call the API
		expect(deps.client.listPendingPermissions).toHaveBeenCalled();
		// Should recover into bridge (sessionID mapped to sessionId for bridge)
		expect(deps.permissionBridge.recoverPending).toHaveBeenCalledWith([
			{
				id: "per_api1",
				sessionId: "ses-abc",
				permission: "file_write",
				patterns: ["/src/*"],
				metadata: { path: "/src/foo.ts" },
				always: [],
			},
		]);
		// Should send permission_request to client
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-abc",
			requestId: pid("per_api1"),
			toolName: "file_write",
			toolInput: { patterns: ["/src/*"], metadata: { path: "/src/foo.ts" } },
		});
	});

	it("sends both bridge-cached and API-fetched permissions without duplicates", async () => {
		const deps = createMockClientInitDeps();
		// Bridge already has one permission
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId: pid("per_bridge1"),
				sessionId: "ses-1",
				toolName: "shell_exec",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);
		// API returns a different permission (not in bridge)
		vi.mocked(deps.client.listPendingPermissions).mockResolvedValue([
			{
				id: "per_api2",
				sessionID: "ses-2",
				permission: "file_write",
				patterns: [],
				metadata: {},
				always: [],
			},
		]);
		vi.mocked(deps.permissionBridge.recoverPending).mockReturnValue([
			{
				requestId: pid("per_api2"),
				sessionId: "ses-2",
				toolName: "file_write",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 2000,
			},
		]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		// Should have both: one from bridge, one from API
		expect(permCalls).toHaveLength(2);
		const requestIds = permCalls.map(
			(c) => (c[1] as { requestId: string }).requestId,
		);
		expect(requestIds).toContain("per_bridge1");
		expect(requestIds).toContain("per_api2");
	});

	it("deduplicates permissions that exist in both bridge and API", async () => {
		const deps = createMockClientInitDeps();
		// Bridge has permission per_dup
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId: pid("per_dup"),
				sessionId: "ses-1",
				toolName: "shell_exec",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);
		// API also returns per_dup (same permission)
		vi.mocked(deps.client.listPendingPermissions).mockResolvedValue([
			{
				id: "per_dup",
				sessionID: "ses-1",
				permission: "shell_exec",
				patterns: [],
				metadata: {},
				always: [],
			},
		]);
		// recoverPending won't return anything new since bridge already has it
		vi.mocked(deps.permissionBridge.recoverPending).mockReturnValue([]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		// Should only send once (from bridge replay), not duplicated from API
		expect(permCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((permCalls[0]![1] as { requestId: string }).requestId).toBe(
			"per_dup",
		);
	});

	it("gracefully handles API failure for permissions", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.listPendingPermissions).mockRejectedValue(
			new Error("API down"),
		);
		// Bridge still has a permission
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId: pid("per_bridge"),
				sessionId: "ses-1",
				toolName: "Bash",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);

		// Should NOT throw
		await expect(
			handleClientConnected(deps, "client-1"),
		).resolves.toBeUndefined();

		// Bridge permission should still be sent
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("per_bridge"),
			toolName: "Bash",
			toolInput: { patterns: [], metadata: {} },
		});
	});

	it("maps API sessionID field to sessionId in recovered permissions", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([]);
		vi.mocked(deps.client.listPendingPermissions).mockResolvedValue([
			{
				id: "per_sess",
				sessionID: "ses_325b9c3caffeFlhLvFRycK1ruF",
				permission: "file_write",
				patterns: [],
				metadata: {},
			},
		]);
		vi.mocked(deps.permissionBridge.recoverPending).mockReturnValue([
			{
				requestId: pid("per_sess"),
				sessionId: "ses_325b9c3caffeFlhLvFRycK1ruF",
				toolName: "file_write",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses_325b9c3caffeFlhLvFRycK1ruF",
			requestId: pid("per_sess"),
			toolName: "file_write",
			toolInput: { patterns: [], metadata: {} },
		});
	});
});

// ─── Processing status on connect ────────────────────────────────────────────

describe("handleClientConnected — processing status on connect", () => {
	it("sends status 'processing' when active session is busy", async () => {
		const deps = createMockClientInitDeps({
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(true),
				getCurrentStatuses: vi
					.fn()
					.mockReturnValue({ "session-1": { type: "busy" } }),
			} as unknown as NonNullable<ClientInitDeps["statusPoller"]>,
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			status: "processing",
		});
	});

	it("sends status 'idle' when active session is not busy", async () => {
		const deps = createMockClientInitDeps({
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
				getCurrentStatuses: vi.fn().mockReturnValue({}),
			} as unknown as NonNullable<ClientInitDeps["statusPoller"]>,
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			status: "idle",
		});
	});

	it("includes processing flags in initial session_list", async () => {
		const deps = createMockClientInitDeps({
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
				getCurrentStatuses: vi.fn().mockReturnValue({ s1: { type: "busy" } }),
			} as unknown as NonNullable<ClientInitDeps["statusPoller"]>,
		});

		await handleClientConnected(deps, "client-1");

		// sessionMgr.sendDualSessionLists should have been called with statuses
		expect(deps.sessionMgr.sendDualSessionLists).toHaveBeenCalledWith(
			expect.any(Function),
			{ statuses: { s1: { type: "busy" } } },
		);
	});

	it("falls back to idle when statusPoller is not provided", async () => {
		const deps = createMockClientInitDeps();
		// statusPoller is undefined by default in createMockClientInitDeps

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			status: "idle",
		});
	});
});

// ─── Instance list on connect ─────────────────────────────────────────────────

describe("handleClientConnected — instance list", () => {
	it("sends instance_list when getInstances is provided", async () => {
		const instances = [
			{
				id: "inst-1",
				name: "default",
				port: 4096,
				managed: true,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: 1000,
			},
		];
		const deps = createMockClientInitDeps({
			getInstances: vi.fn().mockReturnValue(instances),
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "instance_list",
			instances,
		});
	});

	it("does NOT send instance_list when getInstances is omitted", async () => {
		const deps = createMockClientInitDeps();
		// getInstances is not set

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const instanceListCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "instance_list",
		);
		expect(instanceListCalls).toHaveLength(0);
	});

	it("sends correct instances array from getInstances", async () => {
		const instances = [
			{
				id: "inst-a",
				name: "alpha",
				port: 4096,
				managed: true,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: 1000,
			},
			{
				id: "inst-b",
				name: "beta",
				port: 4097,
				managed: false,
				status: "stopped" as const,
				restartCount: 2,
				createdAt: 2000,
			},
		];
		const deps = createMockClientInitDeps({
			getInstances: vi.fn().mockReturnValue(instances),
		});

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const instanceListCall = sendToCalls.find(
			(c) => (c[1] as { type: string }).type === "instance_list",
		);
		expect(instanceListCall).toBeDefined();
		expect(
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			(instanceListCall![1] as { type: string; instances: unknown[] })
				.instances,
		).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instanceListCall![1]).toEqual({ type: "instance_list", instances });
	});

	it("sends instance_list via sendTo (not broadcast) to the specific client", async () => {
		const deps = createMockClientInitDeps({
			getInstances: vi.fn().mockReturnValue([]),
		});

		await handleClientConnected(deps, "client-xyz");

		// sendTo called with the correct clientId
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-xyz",
			expect.objectContaining({ type: "instance_list" }),
		);
		// broadcast NOT called with instance_list
		const broadcastCalls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
		const broadcastInstanceListCalls = broadcastCalls.filter(
			(c) => (c[0] as { type: string }).type === "instance_list",
		);
		expect(broadcastInstanceListCalls).toHaveLength(0);
	});
});
