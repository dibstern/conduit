import { describe, expect, it, vi } from "vitest";
import {
	type ClientInitDeps,
	handleClientConnected,
} from "../../../src/lib/bridges/client-init.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
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
	vi.mocked(deps.client.app.agents).mockResolvedValue(TEST_AGENTS);
	vi.mocked(deps.agentService.listAgents).mockResolvedValue({
		agents: [{ id: "coder", name: "coder", description: "Main agent" }],
	});
	vi.mocked(deps.client.provider.list).mockResolvedValue(TEST_PROVIDERS);
	vi.mocked(deps.sessionMgr.loadPreRenderedHistory).mockResolvedValue(
		TEST_HISTORY,
	);
	return deps;
}

// ─── Session with REST history ───────────────────────────────────────────────
// MessageCache has been removed (Task 50.5). resolveSessionHistory now always
// uses the REST path (sessionMgr.loadPreRenderedHistory) or SQLite.

describe("handleClientConnected — session with REST history", () => {
	it("sends session_switched with REST history on connect", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-1",
			sessionId: "session-1",
			history: {
				messages: [{ role: "user", content: "hi" }],
				hasMore: false,
				total: 1,
			},
		});
	});

	it("sends status idle after session_switched", async () => {
		const deps = createMockClientInitDeps();

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

// ─── Session history — REST fallback and error handling ──────────────────────

describe("handleClientConnected — REST API history", () => {
	it("sends session_switched with REST API history", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-1",
			sessionId: "session-1",
			history: {
				messages: [{ role: "user", content: "hi" }],
				hasMore: false,
				total: 1,
			},
		});
	});

	it("sends session_switched without data when REST API fails", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.sessionMgr.loadPreRenderedHistory).mockRejectedValue(
			new Error("REST fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-1",
			sessionId: "session-1",
		});
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

	it("sends model_info from Effect override state when session has no model", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.session.get).mockResolvedValue({
			id: "s1",
			modelID: "",
		} as Awaited<ReturnType<typeof deps.client.session.get>>);
		vi.mocked(deps.overrideState.getModel).mockResolvedValue({
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

	it("sends Effect override model_info as fallback when getSession fails", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.session.get).mockRejectedValue(
			new Error("session fail"),
		);
		vi.mocked(deps.overrideState.getModel).mockResolvedValue({
			providerID: "anthropic",
			modelID: "claude-3",
		});

		await handleClientConnected(deps, "client-1");

		// Should send INIT_FAILED error
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
		);
		// And still send model_info from Effect override state
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			model: "claude-3",
			provider: "anthropic",
		});
	});

	it("does not send model_info when neither session nor override state have model", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.session.get).mockResolvedValue({
			id: "s1",
			modelID: "",
		} as Awaited<ReturnType<typeof deps.client.session.get>>);
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
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
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

	it("sends Claude agents for a Claude-bound active session", async () => {
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				orchestrationEngine: {
					getProviderForSession: vi.fn(() => "claude"),
					dispatch: vi.fn(async () => ({
						models: [],
						supportsTools: true,
						supportsThinking: true,
						supportsPermissions: true,
						supportsQuestions: true,
						supportsAttachments: true,
						supportsFork: false,
						supportsRevert: false,
						commands: [],
						agents: [
							{ id: "Explore", name: "Explore", description: "Explorer" },
							{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
							{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
						],
					})),
				} as unknown as NonNullable<ClientInitDeps["orchestrationEngine"]>,
			}),
		);
		vi.mocked(deps.agentService.listAgents).mockResolvedValue({
			agents: [
				{ id: "Explore", name: "Explore", description: "Explorer" },
				{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
				{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
			],
			activeAgentId: "Explore",
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.client.app.agents).not.toHaveBeenCalled();
		expect(deps.agentService.listAgents).toHaveBeenCalledWith("session-1");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			agents: [
				{ id: "Explore", name: "Explore", description: "Explorer" },
				{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
				{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
			],
			activeAgentId: "Explore",
		});
	});

	it("clears stale agent during Claude-bound client init", async () => {
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				orchestrationEngine: {
					getProviderForSession: vi.fn(() => "claude"),
					dispatch: vi.fn(async () => ({
						models: [],
						supportsTools: true,
						supportsThinking: true,
						supportsPermissions: true,
						supportsQuestions: true,
						supportsAttachments: true,
						supportsFork: false,
						supportsRevert: false,
						commands: [],
						agents: [{ id: "Explore", name: "Explore" }],
					})),
				} as unknown as NonNullable<ClientInitDeps["orchestrationEngine"]>,
			}),
		);
		vi.mocked(deps.agentService.listAgents).mockResolvedValue({
			agents: [{ id: "Explore", name: "Explore" }],
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.agentService.listAgents).toHaveBeenCalledWith("session-1");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			agents: [{ id: "Explore", name: "Explore" }],
		});
	});

	it("sends INIT_FAILED when listAgents throws", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.agentService.listAgents).mockRejectedValue(
			new Error("agents fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
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

	it("sends OpenCode model_list before slow Claude discovery finishes", async () => {
		let resolveDiscovery: (value: { models: [] }) => void = () => {};
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				orchestrationEngine: {
					dispatch: vi.fn(
						() =>
							new Promise((resolve) => {
								resolveDiscovery = resolve as (value: { models: [] }) => void;
							}),
					),
				} as unknown as NonNullable<ClientInitDeps["orchestrationEngine"]>,
			}),
		);

		const initPromise = handleClientConnected(deps, "client-1");
		await new Promise((resolve) => setTimeout(resolve, 0));

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

		resolveDiscovery({ models: [] });
		await initPromise;
	});

	it("includes contextWindowOptions on Claude entries in model_list", async () => {
		const contextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				orchestrationEngine: {
					dispatch: vi.fn(async () => ({
						models: [
							{
								id: "claude-sonnet-4-7",
								name: "Claude Sonnet 4.7",
								providerId: "claude",
								contextWindowOptions,
							},
						],
					})),
				} as unknown as NonNullable<ClientInitDeps["orchestrationEngine"]>,
			}),
		);

		await handleClientConnected(deps, "client-1");

		const modelLists = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.calls.map((call) => call[1])
			.filter((msg) => (msg as { type?: string }).type === "model_list");
		expect(modelLists).toContainEqual(
			expect.objectContaining({
				type: "model_list",
				providers: expect.arrayContaining([
					expect.objectContaining({
						id: "claude",
						models: [
							expect.objectContaining({
								id: "claude-sonnet-4-7",
								contextWindowOptions,
							}),
						],
					}),
				]),
			}),
		);
	});

	it("sends context_window_info for active Claude model on connect", async () => {
		const contextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				orchestrationEngine: {
					dispatch: vi.fn(async () => ({
						models: [
							{
								id: "claude-sonnet-4-7",
								name: "Claude Sonnet 4.7",
								providerId: "claude",
								contextWindowOptions,
							},
						],
					})),
				} as unknown as NonNullable<ClientInitDeps["orchestrationEngine"]>,
			}),
		);
		vi.mocked(deps.overrideState.getModel).mockResolvedValue({
			providerID: "claude",
			modelID: "claude-sonnet-4-7",
		});
		vi.mocked(deps.overrideState.getContextWindow).mockResolvedValue("1m");

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "context_window_info",
			contextWindow: "1m",
			options: contextWindowOptions,
		});
	});

	it("bootstraps model, variant, and context window from Effect override state", async () => {
		const contextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		const overrideState = {
			getModel: vi.fn(async () => ({
				providerID: "claude",
				modelID: "claude-sonnet-4-7",
			})),
			getDefaultModel: vi.fn(async () => undefined),
			getVariant: vi.fn(async () => "thinking"),
			getDefaultVariant: vi.fn(async () => ""),
			getContextWindow: vi.fn(async () => "1m"),
			getDefaultContextWindow: vi.fn(async () => ""),
			setDefaultModel: vi.fn(async () => undefined),
		};
		const deps = createMockClientInitDeps({
			orchestrationEngine: {
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							variants: { standard: {}, thinking: {} },
							contextWindowOptions,
						},
					],
				})),
			} as unknown as NonNullable<ClientInitDeps["orchestrationEngine"]>,
			overrideState,
		} as unknown as Partial<ClientInitDeps>);
		vi.mocked(deps.client.session.get).mockResolvedValue({
			id: "session-1",
			projectID: "project-1",
			directory: "/tmp/project",
			title: "Session 1",
			version: "1.0.0",
			time: { created: 0, updated: 0 },
		});
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			connected: ["openai"],
			defaults: {},
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [
						{
							id: "gpt-4",
							name: "GPT-4",
							variants: { standard: {}, fast: {} },
						},
					],
				},
			],
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			model: "claude-sonnet-4-7",
			provider: "claude",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "variant_info",
			variant: "thinking",
			variants: ["standard", "thinking"],
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "context_window_info",
			contextWindow: "1m",
			options: contextWindowOptions,
		});
	});

	it("auto-selects default model when defaultModel is not set", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps());

		await handleClientConnected(deps, "client-1");

		expect(deps.overrideState.setDefaultModel).toHaveBeenCalledWith({
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
		vi.mocked(deps.overrideState.getDefaultModel).mockResolvedValue({
			providerID: "anthropic",
			modelID: "claude-3",
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.overrideState.setDefaultModel).not.toHaveBeenCalled();
	});

	it("sends INIT_FAILED when listProviders throws", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.provider.list).mockRejectedValue(
			new Error("providers fail"),
		);

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
		);
	});
});

// ─── Config-seeded defaultModel priority ────────────────────────────────────

describe("handleClientConnected — defaultModel priority", () => {
	it("prefers defaultModel over provider-level default", async () => {
		const deps = applyTestDefaults(
			createMockClientInitDeps({
				overrideState: {
					...createMockClientInitDeps().overrideState,
					getDefaultModel: vi.fn().mockResolvedValue({
						providerID: "openai",
						modelID: "gpt-4-turbo",
					}),
					setDefaultModel: vi.fn().mockResolvedValue(undefined),
				},
			}),
		);

		await handleClientConnected(deps, "client-1");

		// Should NOT call setDefaultModel since defaultModel is already set
		expect(deps.overrideState.setDefaultModel).not.toHaveBeenCalled();
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
				overrideState: {
					...createMockClientInitDeps().overrideState,
					getDefaultModel: vi.fn().mockResolvedValue({
						providerID: "google",
						modelID: "gemini-pro",
					}),
					setDefaultModel: vi.fn().mockResolvedValue(undefined),
				},
			}),
		);

		await handleClientConnected(deps, "client-1");

		// google is not connected — defaultModel exists but its provider isn't available.
		// The relay should NOT override the user's persisted default just because the
		// provider is temporarily offline. No auto-select should happen.
		expect(deps.overrideState.setDefaultModel).not.toHaveBeenCalled();
	});

	it("falls back to provider default when defaultModel is undefined", async () => {
		const deps = applyTestDefaults(createMockClientInitDeps()); // no defaultModel set

		await handleClientConnected(deps, "client-1");

		// Should use provider default since no defaultModel
		expect(deps.overrideState.setDefaultModel).toHaveBeenCalledWith({
			providerID: "openai",
			modelID: "gpt-4",
		});
	});
});

// ─── PTY replay ──────────────────────────────────────────────────────────────

describe("handleClientConnected — PTY replay", () => {
	it("replays terminal state through the terminal replay port", async () => {
		const deps = createMockClientInitDeps();

		await handleClientConnected(deps, "client-1");

		expect(deps.terminal.replay).toHaveBeenCalledWith("client-1");
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
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
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
		// listPendingPermissions returns [] by default

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		expect(permCalls).toHaveLength(0);
	});

	it("replayed permissions include sessionId", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
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
		vi.mocked(deps.client.question.list).mockResolvedValue([
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
			sessionId: "session-1",
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
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
			{
				requestId: pid("perm-1"),
				sessionId: "ses-1",
				toolName: "file_write",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);
		vi.mocked(deps.client.question.list).mockResolvedValue([
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
		vi.mocked(deps.client.question.list).mockResolvedValue([
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
		vi.mocked(deps.client.session.get).mockRejectedValue(
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
		vi.mocked(deps.client.session.get).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.sessionMgr.sendDualSessionLists).mockRejectedValue(
			new Error("fail"),
		);
		vi.mocked(deps.client.app.agents).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.client.provider.list).mockRejectedValue(new Error("fail"));
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
				(c[1] as { type: string }).type === "system_error" &&
				(c[1] as { code: string }).code === "INIT_FAILED",
		);
		expect(errorCalls.length).toBeGreaterThanOrEqual(3);
	});
});

// ─── Pending interaction integration ─────────────────────────────────────────
// Permissions are replayed from the Effect-owned pending interaction port.
// Questions are replayed first from the same port, then from the OpenCode REST
// API with field mapping (`multiple` → `multiSelect`).

describe("handleClientConnected — pending interaction integration", () => {
	it("replays permission from the pending interaction port", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
			{
				requestId: pid("perm-real-1"),
				sessionId: "",
				toolName: "file_write",
				toolInput: { patterns: ["/tmp/test.txt"], metadata: { foo: "bar" } },
				always: ["shell_exec"],
				timestamp: 1000,
			},
		]);

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
		vi.mocked(deps.client.question.list).mockResolvedValue([
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
			sessionId: "session-1",
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

	it("replays multiple pending permissions and API questions simultaneously", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
			{
				requestId: pid("perm-r1"),
				sessionId: "",
				toolName: "shell_exec",
				toolInput: { patterns: [], metadata: { cmd: "npm install" } },
				always: [],
				timestamp: 1000,
			},
			{
				requestId: pid("perm-r2"),
				sessionId: "",
				toolName: "file_write",
				toolInput: { patterns: ["/src/**"], metadata: {} },
				always: [],
				timestamp: 1001,
			},
		]);

		// Mock the REST API to return 1 pending question
		vi.mocked(deps.client.question.list).mockResolvedValue([
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
		// Pending interaction service has nothing — simulates relay restart where service state is lost
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([]);
		// But API has a pending permission
		vi.mocked(deps.client.permission.list).mockResolvedValue([
			{
				id: "per_api1",
				sessionID: "ses-abc",
				permission: "file_write",
				patterns: ["/src/*"],
				metadata: { path: "/src/foo.ts" },
				always: [],
			},
		]);
		// recoverPendingPermissions returns the recovered entries
		vi.mocked(
			deps.pendingInteractions.recoverPendingPermissions,
		).mockResolvedValue([
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
		expect(deps.client.permission.list).toHaveBeenCalled();
		// Should recover into pending interaction service (sessionID mapped to sessionId)
		expect(
			deps.pendingInteractions.recoverPendingPermissions,
		).toHaveBeenCalledWith([
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

	it("sends both service-cached and API-fetched permissions without duplicates", async () => {
		const deps = createMockClientInitDeps();
		// Pending interaction service already has one permission
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
			{
				requestId: pid("per_service1"),
				sessionId: "ses-1",
				toolName: "shell_exec",
				toolInput: { patterns: [], metadata: {} },
				always: [],
				timestamp: 1000,
			},
		]);
		// API returns a different permission (not in service)
		vi.mocked(deps.client.permission.list).mockResolvedValue([
			{
				id: "per_api2",
				sessionID: "ses-2",
				permission: "file_write",
				patterns: [],
				metadata: {},
				always: [],
			},
		]);
		vi.mocked(
			deps.pendingInteractions.recoverPendingPermissions,
		).mockResolvedValue([
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
		// Should have both: one from service, one from API
		expect(permCalls).toHaveLength(2);
		const requestIds = permCalls.map(
			(c) => (c[1] as { requestId: string }).requestId,
		);
		expect(requestIds).toContain("per_service1");
		expect(requestIds).toContain("per_api2");
	});

	it("deduplicates permissions that exist in both service and API", async () => {
		const deps = createMockClientInitDeps();
		// Pending interaction service has permission per_dup
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
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
		vi.mocked(deps.client.permission.list).mockResolvedValue([
			{
				id: "per_dup",
				sessionID: "ses-1",
				permission: "shell_exec",
				patterns: [],
				metadata: {},
				always: [],
			},
		]);
		// recoverPendingPermissions won't return anything new since service already has it
		vi.mocked(
			deps.pendingInteractions.recoverPendingPermissions,
		).mockResolvedValue([]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		// Should only send once (from service replay), not duplicated from API
		expect(permCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((permCalls[0]![1] as { requestId: string }).requestId).toBe(
			"per_dup",
		);
	});

	it("gracefully handles API failure for permissions", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.permission.list).mockRejectedValue(
			new Error("API down"),
		);
		// Pending interaction service still has a permission
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([
			{
				requestId: pid("per_service"),
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

		// Pending interaction service permission should still be sent
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("per_service"),
			toolName: "Bash",
			toolInput: { patterns: [], metadata: {} },
		});
	});

	it("maps API sessionID field to sessionId in recovered permissions", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(
			deps.pendingInteractions.listPendingPermissions,
		).mockResolvedValue([]);
		vi.mocked(deps.client.permission.list).mockResolvedValue([
			{
				id: "per_sess",
				sessionID: "ses_325b9c3caffeFlhLvFRycK1ruF",
				permission: "file_write",
				patterns: [],
				metadata: {},
			},
		]);
		vi.mocked(
			deps.pendingInteractions.recoverPendingPermissions,
		).mockResolvedValue([
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
			sessionId: expect.any(String),
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
			sessionId: expect.any(String),
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
			sessionId: expect.any(String),
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
