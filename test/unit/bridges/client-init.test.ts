import { Cause, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { handleClientConnectedEffect } from "../../../src/lib/bridges/client-init.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import type { AgentService } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import type { OpenCodeModelService } from "../../../src/lib/domain/relay/Services/services.js";
import {
	OpenCodeModelServiceTag,
	StatusPollerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import type { SessionManagerService } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	getDefaultModel,
	type ModelOverride,
	type OverridesStateTag,
	setContextWindow,
	setDefaultModel,
	setDefaultVariant,
	setModel,
	setVariant,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { Logger } from "../../../src/lib/logger.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { ProviderCapabilities } from "../../../src/lib/provider/types.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockStatusPoller,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

// The shared factory provides minimal defaults. These helpers set the richer
// mock return values that this test file's assertions depend on.

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

const makeClaudeCapabilities = (
	overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities => ({
	models: [],
	supportsTools: true,
	supportsThinking: true,
	supportsPermissions: true,
	supportsQuestions: true,
	supportsAttachments: true,
	supportsFork: false,
	supportsRevert: false,
	commands: [],
	...overrides,
});

/** Apply test-specific mock return values on top of shared factory defaults. */
function applyTestDefaults(deps: ReturnType<typeof makeClientInitEffectLayer>) {
	vi.mocked(deps.agentService.listAgents).mockReturnValue(
		Effect.succeed({
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [{ id: "coder", name: "coder", description: "Main agent" }],
		}),
	);
	vi.mocked(deps.modelService.listProviders).mockReturnValue(
		Effect.succeed(TEST_PROVIDERS),
	);
	return deps;
}

function makeReadQuery(
	provider: string,
	parentId: string | null = null,
): ReadQueryEffect {
	return {
		getToolContent: vi.fn(() => Effect.succeed(undefined)),
		getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
		getSession: vi.fn(() =>
			Effect.succeed({
				id: "requested-session",
				provider,
				provider_sid: null,
				title: "Requested session",
				status: "idle",
				parent_id: parentId,
				forked_from: null,
				fork_point_event: null,
				last_message_at: null,
				last_turn_error_at: null,
				permission_mode: null,
				read_at: null,
				settled_at: null,
				pinned_at: null,
				snoozed_at: null,
				snoozed_until: null,
				woken_at: null,
				woken_reason: null,
				created_at: 1,
				updated_at: 1,
				version: 0,
			}),
		),
		getGoalDetails: () =>
			Effect.succeed({ checks: [], tokensSinceStart: null }),
		getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
		getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
		getSessionsForReconciliation: () => Effect.succeed([]),
		listSessions: vi.fn(() => Effect.succeed([])),
		listSessionInfos: () => Effect.succeed([]),
		readSessionTranscript: () => Effect.succeed({ messages: [], version: 0 }),
		readSessionTodos: () => Effect.succeed({ rows: [], version: 0 }),
		readSessionList: () => Effect.succeed({ rows: [], version: 0 }),
		getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
		getSessionFamily: () => Effect.succeed([]),
		countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
		readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
		getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
		getSessionHistoryMetadata: vi.fn(() =>
			Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
		),
		getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
		readSessionTranscriptPage: () =>
			Effect.succeed({ messages: [], hasMore: false, version: 0 }),
	};
}

function makeClientInitEffectLayer(
	readQuery: ReadQueryEffect = makeReadQuery("opencode"),
	sessionManagerOverrides: Partial<SessionManagerService> = {},
	log: Logger = makeMockLogger(),
) {
	const wsHandler = makeMockWebSocketHandler();
	const state: { defaultModel: ModelOverride | undefined } = {
		defaultModel: undefined,
	};
	const client = makeMockOpenCodeAPI();
	const statusPoller = makeMockStatusPoller();
	const sessionManagerService = makeMockSessionManagerService({
		getDefaultSessionId: vi.fn(() => Effect.succeed("session-1")),
		sessionExists: vi.fn(() => Effect.succeed(true)),
		...sessionManagerOverrides,
	});
	const listProviders = vi.fn<OpenCodeModelService["listProviders"]>(() =>
		Effect.succeed({ providers: [], defaults: {}, connected: [] }),
	);
	const modelService: OpenCodeModelService = {
		listProviders,
		// The cached catalog is whatever the last listProviders returned.
		cachedProviders: vi.fn(() => Effect.option(listProviders())),
		persistDefaultModel: vi.fn(() => Effect.void),
	};
	const agentService: AgentService = {
		listAgents: vi.fn(() =>
			Effect.succeed({
				providerScope: { id: "opencode" as const, name: "OpenCode" as const },
				agents: [],
			}),
		),
		getActiveAgent: vi.fn(() => Effect.succeed(undefined)),
		switchAgent: vi.fn(() => Effect.void),
	};
	const discoverClaudeCapabilities = vi.fn(
		(): Effect.Effect<ProviderCapabilities, unknown> =>
			Effect.succeed(makeClaudeCapabilities()),
	);
	const orchestrationEngine = withDispatchEffect({
		getProviderForSessionEffect: vi.fn(() => Effect.succeed(undefined)),
		dispatchEffect: vi.fn(() => discoverClaudeCapabilities()),
	});

	return {
		state,
		wsHandler,
		client,
		statusPoller,
		modelService,
		agentService,
		discoverClaudeCapabilities,
		orchestrationEngine,
		log,
		sessionService: sessionManagerService,
		sessionManagerService,
		layer: Layer.merge(
			makeTestHandlerLayer({
				api: client,
				wsHandler,
				sessionManagerService,
				statusPoller,
				orchestrationEngine,
				log,
			}),
			Layer.mergeAll(
				Layer.succeed(ReadQueryEffectTag, readQuery),
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(AgentServiceTag, agentService),
				Layer.succeed(StatusPollerTag, statusPoller),
			),
		),
	};
}

function runClientInit(
	deps: ReturnType<typeof makeClientInitEffectLayer>,
	clientId: string,
	requestedSessionId?: string,
	options?: Parameters<typeof handleClientConnectedEffect>[2],
	setup: Effect.Effect<void, never, OverridesStateTag> = Effect.void,
) {
	return Effect.runPromise(
		Effect.gen(function* () {
			yield* setup;
			yield* handleClientConnectedEffect(clientId, requestedSessionId, options);
			deps.state.defaultModel = yield* getDefaultModel();
		}).pipe(Effect.provide(deps.layer)),
	);
}

describe("handleClientConnectedEffect — session selection", () => {
	it("sends family and status without a server-selected session frame", async () => {
		const deps = makeClientInitEffectLayer();
		await runClientInit(deps, "client-1", "requested-session");
		expect(deps.sessionService.sessionExists).toHaveBeenCalledWith(
			"requested-session",
		);
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"requested-session",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "session_family",
				rootId: "requested-session",
			}),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			sessionId: "requested-session",
			status: "idle",
		});
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_switched" }),
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notification_event",
				eventType: "session_viewed",
			}),
		);
	});

	it("selects no session when the requested session does not exist", async () => {
		const log = makeMockLogger();
		const deps = makeClientInitEffectLayer(
			makeReadQuery("opencode"),
			{ sessionExists: vi.fn(() => Effect.succeed(false)) },
			log,
		);
		await runClientInit(deps, "client-1", "unknown-session");
		expect(deps.sessionService.sessionExists).toHaveBeenCalledWith(
			"unknown-session",
		);
		expect(deps.sessionService.getDefaultSessionId).not.toHaveBeenCalled();
		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_family" }),
		);
		expect(log.info).toHaveBeenCalledWith(
			"Requested session unknown-session not found; no session selected",
		);
	});

	it("selects no session for an unknown id when the default is skipped", async () => {
		const deps = makeClientInitEffectLayer(makeReadQuery("opencode"), {
			sessionExists: vi.fn(() => Effect.succeed(false)),
		});
		await runClientInit(deps, "client-1", "unknown-session", {
			skipDefaultSession: true,
		});
		expect(deps.sessionService.getDefaultSessionId).not.toHaveBeenCalled();
		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_family" }),
		);
	});

	it("trusts the requested session when its existence check fails", async () => {
		const log = makeMockLogger();
		const deps = makeClientInitEffectLayer(
			makeReadQuery("opencode"),
			{
				sessionExists: vi.fn(() =>
					Effect.fail(
						new SessionManagerError({
							operation: "sessionExists",
							cause: "provider unavailable",
						}),
					),
				),
			},
			log,
		);
		await runClientInit(deps, "client-1", "requested-session");
		expect(deps.sessionService.getDefaultSessionId).not.toHaveBeenCalled();
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"requested-session",
		);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("provider unavailable"),
		);
	});

	it("a sessionless daemon attach sends settings without selecting or creating a session", async () => {
		const getDefaultSessionId = vi.fn(() =>
			Effect.succeed("unrequested-session"),
		);
		const createSession = vi.fn<SessionManagerService["createSession"]>(() =>
			Effect.fail(
				new SessionManagerError({
					operation: "createSession",
					cause: "unexpected creation",
				}),
			),
		);
		const deps = makeClientInitEffectLayer(makeReadQuery("opencode"), {
			getDefaultSessionId,
			createSession,
		});
		await runClientInit(deps, "client-1", undefined, {
			skipDefaultSession: true,
		});
		expect(getDefaultSessionId).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(deps.sessionService.pushViewerFamilies).toHaveBeenCalledOnce();
		expect(deps.wsHandler.markClientBootstrapped).toHaveBeenCalledWith(
			"client-1",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "variant_info" }),
		);
	});
});

describe("handleClientConnectedEffect — model info", () => {
	it("loads relay model state and providers without an OpenCode session lookup", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		vi.mocked(deps.client.session.get).mockRejectedValue(
			new Error("legacy session.get should not be used"),
		);
		vi.mocked(deps.client.provider.list).mockRejectedValue(
			new Error("legacy provider.list should not be used"),
		);
		vi.mocked(deps.modelService.listProviders).mockReturnValue(
			Effect.succeed(TEST_PROVIDERS),
		);

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setModel("session-1", { providerID: "openai", modelID: "gpt-4" }),
		);

		expect(deps.modelService.listProviders).toHaveBeenCalledOnce();
		expect(deps.client.session.get).not.toHaveBeenCalled();
		expect(deps.client.provider.list).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("sends model_info from the relay default model", async () => {
		const deps = makeClientInitEffectLayer();

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setDefaultModel({ providerID: "openai", modelID: "gpt-4" }),
		);

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("sends model_info from Effect override state", async () => {
		const deps = makeClientInitEffectLayer();
		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setModel("session-1", { providerID: "anthropic", modelID: "claude-3" }),
		);

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "claude-3",
			provider: "anthropic",
		});
	});

	it("sends Effect override model_info when OpenCode session reads are unavailable", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.client.session.get).mockRejectedValue(
			new Error("OpenCode session reads are unavailable"),
		);
		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setModel("session-1", { providerID: "anthropic", modelID: "claude-3" }),
		);

		expect(deps.client.session.get).not.toHaveBeenCalled();
		expect(deps.log.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("Failed to load session info"),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "claude-3",
			provider: "anthropic",
		});
	});

	it("does not send model_info when relay model state is unset", async () => {
		const deps = makeClientInitEffectLayer();
		// overrides.model is already undefined by default

		await runClientInit(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const modelInfoCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "model_info",
		);
		expect(modelInfoCalls).toHaveLength(0);
	});
});

describe("handleClientConnectedEffect — viewed families", () => {
	it("pushes viewed families before marking the client bootstrapped", async () => {
		const deps = makeClientInitEffectLayer();
		await runClientInit(deps, "client-1");
		const pushOrder = vi.mocked(deps.sessionService.pushViewerFamilies).mock
			.invocationCallOrder[0];
		const bootstrapOrder = vi.mocked(deps.wsHandler.markClientBootstrapped).mock
			.invocationCallOrder[0];
		expect(pushOrder).toBeDefined();
		expect(bootstrapOrder).toBeDefined();
		if (pushOrder === undefined || bootstrapOrder === undefined) {
			throw new Error(
				"family push and bootstrap calls should both be recorded",
			);
		}
		expect(pushOrder).toBeLessThan(bootstrapOrder);
	});

	it("logs, without a browser error, when pushViewerFamilies throws", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.sessionService.pushViewerFamilies).mockReturnValue(
			Effect.fail(
				new SessionManagerError({
					operation: "pushViewerFamilies",
					cause: new Error("family fail"),
				}),
			),
		);
		await runClientInit(deps, "client-1");
		// Init failures are background-task errors (fork 3.2): log only.
		expect(deps.log.warn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to push viewed families"),
		);
		const errorOrder = vi.mocked(deps.log.warn).mock.invocationCallOrder[0];
		const bootstrapOrder = vi.mocked(deps.wsHandler.markClientBootstrapped).mock
			.invocationCallOrder[0];
		expect(errorOrder).toBeDefined();
		expect(bootstrapOrder).toBeDefined();
		if (errorOrder === undefined || bootstrapOrder === undefined) {
			throw new Error(
				"init-failure log and bootstrap calls should both be recorded",
			);
		}
		expect(errorOrder).toBeLessThan(bootstrapOrder);
	});
});

describe("handleClientConnectedEffect — model list", () => {
	it("does not report INIT_FAILED when only OpenCode provider discovery fails", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		deps.discoverClaudeCapabilities.mockReturnValue(
			Effect.succeed(
				makeClaudeCapabilities({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
						},
					],
				}),
			),
		);
		vi.mocked(deps.modelService.listProviders).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("opencode offline"))),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "model_info",
			model: "claude-sonnet-4-7",
			provider: "claude",
		});
		expect(deps.log.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("Failed to list providers"),
		);
	});

	it("sends context_window_info for active Claude model on connect", async () => {
		const contextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		deps.discoverClaudeCapabilities.mockReturnValue(
			Effect.succeed(
				makeClaudeCapabilities({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							contextWindowOptions,
						},
					],
				}),
			),
		);

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			Effect.all([
				setModel("session-1", {
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				}),
				setContextWindow("session-1", "1m"),
			]).pipe(Effect.asVoid),
		);

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
		const deps = makeClientInitEffectLayer();
		deps.discoverClaudeCapabilities.mockReturnValue(
			Effect.succeed(
				makeClaudeCapabilities({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							variants: { standard: {}, thinking: {} },
							contextWindowOptions,
						},
					],
				}),
			),
		);
		vi.mocked(deps.modelService.listProviders).mockReturnValue(
			Effect.succeed({
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
			}),
		);

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			Effect.all([
				setModel("session-1", {
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				}),
				setVariant("session-1", "thinking"),
				setContextWindow("session-1", "1m"),
			]).pipe(Effect.asVoid),
		);

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
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
		const deps = applyTestDefaults(makeClientInitEffectLayer());

		await runClientInit(deps, "client-1");

		expect(deps.state.defaultModel).toEqual({
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
		const deps = makeClientInitEffectLayer();
		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setDefaultModel({ providerID: "anthropic", modelID: "claude-3" }),
		);

		expect(deps.state.defaultModel).toEqual({
			providerID: "anthropic",
			modelID: "claude-3",
		});
	});

	it("logs, without a browser error, when no catalog is cached and Claude discovery fails", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.cachedProviders).mockReturnValue(
			Effect.succeedNone,
		);
		deps.discoverClaudeCapabilities.mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("claude fail"))),
		);

		await runClientInit(deps, "client-1");

		expect(deps.log.warn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to list providers"),
		);
	});
});

describe("handleClientConnectedEffect — defaultModel priority", () => {
	it("prefers defaultModel over provider-level default", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			Effect.all([
				setDefaultModel({ providerID: "openai", modelID: "gpt-4-turbo" }),
				setDefaultVariant("high"),
			]).pipe(Effect.asVoid),
		);

		expect(deps.state.defaultModel).toEqual({
			providerID: "openai",
			modelID: "gpt-4-turbo",
		});
	});

	it("falls back to provider default when defaultModel provider is not connected", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setDefaultModel({ providerID: "google", modelID: "gemini-pro" }),
		);

		// google is not connected — defaultModel exists but its provider isn't available.
		// The relay should NOT override the user's persisted default just because the
		// provider is temporarily offline. No auto-select should happen.
		expect(deps.state.defaultModel).toEqual({
			providerID: "google",
			modelID: "gemini-pro",
		});
	});

	it("falls back to provider default when defaultModel is undefined", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer()); // no defaultModel set

		await runClientInit(deps, "client-1");

		// Should use provider default since no defaultModel
		expect(deps.state.defaultModel).toEqual({
			providerID: "openai",
			modelID: "gpt-4",
		});
	});
});

describe("handleClientConnectedEffect — no active session", () => {
	it("skips session info and model info when no active session", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.sessionService.getDefaultSessionId).mockReturnValue(
			Effect.succeed(undefined as unknown as string),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();

		expect(deps.sessionService.pushViewerFamilies).toHaveBeenCalledOnce();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "variant_info" }),
		);
	});
});

describe("handleClientConnectedEffect — error resilience", () => {
	it("continues sending remaining data when OpenCode session reads are unavailable", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.client.session.get).mockRejectedValue(
			new Error("OpenCode session reads are unavailable"),
		);

		await runClientInit(deps, "client-1");

		expect(deps.client.session.get).not.toHaveBeenCalled();
		expect(deps.sessionService.pushViewerFamilies).toHaveBeenCalledOnce();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "variant_info" }),
		);
	});

	it("does not crash when all API calls fail", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.sessionService.pushViewerFamilies).mockReturnValue(
			Effect.fail(
				new SessionManagerError({
					operation: "pushViewerFamilies",
					cause: new Error("fail"),
				}),
			),
		);
		// No cached OpenCode catalog and no Claude models: no providers at all.
		deps.discoverClaudeCapabilities.mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("fail"))),
		);

		// Should NOT throw
		await expect(runClientInit(deps, "client-1")).resolves.toBeUndefined();

		// Genuinely unavailable init data is logged, never sent to the browser.
		expect(vi.mocked(deps.log.warn).mock.calls.length).toBeGreaterThanOrEqual(
			2,
		);
	});
});

describe("handleClientConnectedEffect — no OpenCode requests", () => {
	it("does not ask OpenCode for pending permissions or questions", async () => {
		const deps = makeClientInitEffectLayer();

		await runClientInit(deps, "client-1");

		expect(deps.client.permission.list).not.toHaveBeenCalled();
		expect(deps.client.question.list).not.toHaveBeenCalled();
	});
});

describe("handleClientConnectedEffect — processing status on connect", () => {
	it("sends status 'processing' from a busy family with a cold poller", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.sessionService.getSessionFamily).mockReturnValue(
			Effect.succeed({
				type: "session_family",
				rootId: "session-1",
				sessions: [
					{
						id: "session-1",
						title: "Session 1",
						status: "busy",
						updatedAt: 0,
						messageCount: 0,
					},
				],
			}),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			sessionId: expect.any(String),
			status: "processing",
		});
	});

	it("sends status 'idle' when active session is not busy", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.statusPoller.isProcessing).mockReturnValue(
			Effect.succeed(false),
		);
		vi.mocked(deps.statusPoller.getCurrentStatuses).mockReturnValue(
			Effect.succeed({}),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			sessionId: expect.any(String),
			status: "idle",
		});
	});

	it("sends status 'processing' when Effect timeout state is active", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.statusPoller.isProcessing).mockReturnValue(
			Effect.succeed(false),
		);
		vi.mocked(deps.statusPoller.getCurrentStatuses).mockReturnValue(
			Effect.succeed({}),
		);

		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			startProcessingTimeout("session-1", "2 minutes", () => Effect.void),
		);

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			sessionId: expect.any(String),
			status: "processing",
		});
	});
});
