import { Cause, Effect, Layer } from "effect";
import { assert, describe, expect, it, vi } from "vitest";
import { handleClientConnectedEffect } from "../../../src/lib/bridges/client-init.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import type { AgentService } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import type {
	PendingInteractionService,
	PendingQuestion,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import type {
	OpenCodeModelService,
	OpenCodeSessionDetail,
} from "../../../src/lib/domain/relay/Services/services.js";
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
	setDefaultPermissionMode,
	setDefaultVariant,
	setModel,
	setPermissionMode,
	setVariant,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { OpenCodeTerminalService } from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { OpenCodeTerminalServiceTag } from "../../../src/lib/domain/relay/Services/terminal-service.js";
import type { Logger } from "../../../src/lib/logger.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { ProviderCapabilities } from "../../../src/lib/provider/types.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockStatusPoller,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { partialFake } from "../../helpers/partial-fake.js";

/** Cast a plain string to PermissionId for test data. */
const pid = (s: string) => s as PermissionId;

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
		getSessionsForReconciliation: () => Effect.succeed([]),
		listSessions: vi.fn(() => Effect.succeed([])),
		listSessionInfos: () => Effect.succeed([]),
		readSessionTranscript: () => Effect.succeed({ messages: [], version: 0 }),
		readSessionList: () => Effect.succeed({ rows: [], version: 0 }),
		getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
		getSessionFamily: () => Effect.succeed([]),
		countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
		getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
		getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
		readPendingInputs: () => Effect.succeed({ rows: [], removed: [] }),
		readInboxState: () => Effect.succeed(undefined),
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
	const modelService: OpenCodeModelService = {
		getSession: vi.fn(() =>
			Effect.succeed({
				id: "session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 1",
				version: "1.0.0",
				time: { created: 0, updated: 0 },
				modelID: "gpt-4",
				providerID: "openai",
			}),
		),
		listProviders: vi.fn(() =>
			Effect.succeed({ providers: [], defaults: {}, connected: [] }),
		),
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
	const pendingQuestions: PendingQuestion[] = [];
	const pendingInteractions = partialFake<PendingInteractionService>({
		listPendingPermissions: vi.fn<
			PendingInteractionService["listPendingPermissions"]
		>(() => Effect.succeed([])),
		recoverPendingPermissions: vi.fn<
			PendingInteractionService["recoverPendingPermissions"]
		>(() => Effect.succeed([])),
		listPendingQuestions: vi.fn<
			PendingInteractionService["listPendingQuestions"]
		>(() => Effect.succeed(pendingQuestions)),
		recordQuestionRequest: vi.fn<
			PendingInteractionService["recordQuestionRequest"]
		>((input) =>
			Effect.sync(() => {
				const question = { ...input, timestamp: Date.now() };
				pendingQuestions.push(question);
				return question;
			}),
		),
	});
	const terminal = partialFake<OpenCodeTerminalService>({
		replay: vi.fn(() => Effect.void),
	});
	const discoverClaudeCapabilities = vi.fn(() =>
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
		pendingInteractions,
		terminal,
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
				Layer.succeed(PendingInteractionServiceTag, pendingInteractions),
				Layer.succeed(OpenCodeTerminalServiceTag, terminal),
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

	it("a sessionless daemon attach sends lists without selecting or creating a session", async () => {
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
		for (const type of ["agent_list", "model_list"]) {
			expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
				"client-1",
				expect.objectContaining({ type }),
			);
		}
	});

	it("keeps session and default permission modes distinct on connect", async () => {
		const deps = makeClientInitEffectLayer();
		await runClientInit(
			deps,
			"client-1",
			"requested-session",
			undefined,
			Effect.gen(function* () {
				yield* setDefaultPermissionMode("auto");
				yield* setPermissionMode("requested-session", "full");
			}),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_mode_info",
			mode: "full",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "default_permission_mode_info",
			mode: "auto",
		});
	});

	it("reports the configured default when no session is bound", async () => {
		const deps = makeClientInitEffectLayer(makeReadQuery("claude-sdk"), {
			getDefaultSessionId: vi.fn(() =>
				Effect.fail(
					new SessionManagerError({
						operation: "getDefaultSessionId",
						cause: "no sessions",
					}),
				),
			),
		});
		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});
				yield* setDefaultVariant("high");
				yield* setDefaultPermissionMode("full");
			}),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_mode_info",
			mode: "full",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "default_model_info",
			model: "claude-sonnet-4-7",
			provider: "claude",
			variant: "high",
		});
	});
});

describe("handleClientConnectedEffect — model info", () => {
	it("loads session and provider models through the Effect model service", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		vi.mocked(deps.client.session.get).mockRejectedValue(
			new Error("legacy session.get should not be used"),
		);
		vi.mocked(deps.client.provider.list).mockRejectedValue(
			new Error("legacy provider.list should not be used"),
		);
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.succeed({
				id: "session-1",
				modelID: "gpt-4",
				providerID: "openai",
			} as OpenCodeSessionDetail),
		);
		vi.mocked(deps.modelService.listProviders).mockReturnValue(
			Effect.succeed(TEST_PROVIDERS),
		);

		await runClientInit(deps, "client-1");

		expect(deps.modelService.getSession).toHaveBeenCalledWith("session-1");
		expect(deps.modelService.listProviders).toHaveBeenCalledOnce();
		expect(deps.client.session.get).not.toHaveBeenCalled();
		expect(deps.client.provider.list).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "gpt-4",
			provider: "openai",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_list",
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [
						{
							id: "gpt-4",
							name: "GPT-4",
							provider: "openai",
						},
					],
				},
			],
		});
	});

	it("sends model_info when session has modelID", async () => {
		const deps = makeClientInitEffectLayer();

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("sends model_info from Effect override state when session has no model", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.succeed({
				id: "s1",
				modelID: "",
			} as OpenCodeSessionDetail),
		);
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

	it("sends Effect override model_info as fallback when getSession fails", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("session fail"))),
		);
		await runClientInit(
			deps,
			"client-1",
			undefined,
			undefined,
			setModel("session-1", { providerID: "anthropic", modelID: "claude-3" }),
		);

		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "system_error",
				code: "INIT_FAILED",
				message: expect.stringContaining("Failed to load session info"),
			}),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			sessionId: "session-1",
			model: "claude-3",
			provider: "anthropic",
		});
	});

	it("does not send model_info when neither session nor override state have model", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.succeed({
				id: "s1",
				modelID: "",
			} as OpenCodeSessionDetail),
		);
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

	it("sends INIT_FAILED when pushViewerFamilies throws", async () => {
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
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
		);
		const errorOrder = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.invocationCallOrder.find(
				(_, index) =>
					vi.mocked(deps.wsHandler.sendTo).mock.calls[index]?.[1].type ===
					"system_error",
			);
		const bootstrapOrder = vi.mocked(deps.wsHandler.markClientBootstrapped).mock
			.invocationCallOrder[0];
		expect(errorOrder).toBeDefined();
		expect(bootstrapOrder).toBeDefined();
		if (errorOrder === undefined || bootstrapOrder === undefined) {
			throw new Error(
				"INIT_FAILED and bootstrap calls should both be recorded",
			);
		}
		expect(errorOrder).toBeLessThan(bootstrapOrder);
	});
});

describe("handleClientConnectedEffect — agent list", () => {
	it("sends agent_list filtering internal agents", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [{ id: "coder", name: "coder", description: "Main agent" }],
		});
	});

	it("sends Claude agents for a Claude-bound active session", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		vi.mocked(deps.agentService.listAgents).mockReturnValue(
			Effect.succeed({
				providerScope: { id: "claude", name: "Claude" },
				agents: [
					{ id: "Explore", name: "Explore", description: "Explorer" },
					{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
					{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
				],
				activeAgentId: "Explore",
			}),
		);

		await runClientInit(deps, "client-1");

		expect(deps.client.app.agents).not.toHaveBeenCalled();
		expect(deps.agentService.listAgents).toHaveBeenCalledWith("session-1");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			providerScope: { id: "claude", name: "Claude" },
			agents: [
				{ id: "Explore", name: "Explore", description: "Explorer" },
				{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
				{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
			],
			activeAgentId: "Explore",
		});
	});

	it("clears stale agent during Claude-bound client init", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		vi.mocked(deps.agentService.listAgents).mockReturnValue(
			Effect.succeed({
				providerScope: { id: "claude", name: "Claude" },
				agents: [{ id: "Explore", name: "Explore" }],
			}),
		);

		await runClientInit(deps, "client-1");

		expect(deps.agentService.listAgents).toHaveBeenCalledWith("session-1");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			providerScope: { id: "claude", name: "Claude" },
			agents: [{ id: "Explore", name: "Explore" }],
		});
	});

	it("sends INIT_FAILED when listAgents throws", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.agentService.listAgents).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("agents fail"))),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
		);
	});
});

// Model list (providers)

describe("handleClientConnectedEffect — model list", () => {
	it("sends model_list with only configured providers", async () => {
		const deps = applyTestDefaults(makeClientInitEffectLayer());

		await runClientInit(deps, "client-1");

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
		let resolveDiscovery: (value: ProviderCapabilities) => void = () => {};
		const deps = applyTestDefaults(makeClientInitEffectLayer());
		deps.discoverClaudeCapabilities.mockImplementation(() =>
			Effect.promise(
				() =>
					new Promise((resolve) => {
						resolveDiscovery = resolve;
					}),
			),
		);

		const initPromise = runClientInit(deps, "client-1");
		await vi.waitFor(() =>
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
			}),
		);

		resolveDiscovery(makeClaudeCapabilities());
		await initPromise;
	});

	it("includes contextWindowOptions on Claude entries in model_list", async () => {
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

		await runClientInit(deps, "client-1");

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

	it("sends Claude model_list when OpenCode provider discovery fails", async () => {
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

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_list",
			providers: [
				{
					id: "claude",
					name: "Anthropic - claude",
					configured: true,
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							provider: "claude",
						},
					],
				},
			],
		});
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "system_error",
				code: "INIT_FAILED",
				message: expect.stringContaining("Failed to list providers"),
			}),
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
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.succeed({
				id: "session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 1",
				version: "1.0.0",
				time: { created: 0, updated: 0 },
			}),
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

	it("sends INIT_FAILED when listProviders throws", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.listProviders).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("providers fail"))),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "system_error", code: "INIT_FAILED" }),
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
		// Should send model_info to the client (not broadcast)
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "default_model_info",
			model: "gpt-4-turbo",
			provider: "openai",
			variant: "high",
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

describe("handleClientConnectedEffect — PTY replay", () => {
	it("replays terminal state through the terminal replay port", async () => {
		const deps = makeClientInitEffectLayer();

		await runClientInit(deps, "client-1");

		expect(deps.terminal.replay).toHaveBeenCalledWith("client-1");
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
			expect.objectContaining({ type: "agent_list" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "model_list" }),
		);
	});
});

describe("handleClientConnectedEffect — pending permissions", () => {
	it("sends pending permission requests to reconnecting client", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
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
			]),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("perm-1"),
			toolName: "file_write",
			toolInput: { patterns: ["/tmp/*"], metadata: {} },
			always: [],
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("perm-2"),
			toolName: "shell_exec",
			toolInput: { patterns: [], metadata: { command: "rm -rf" } },
			always: ["shell_exec"],
		});
	});

	it("does not send permission_request when no pending permissions", async () => {
		const deps = makeClientInitEffectLayer();
		// listPendingPermissions returns [] by default

		await runClientInit(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		expect(permCalls).toHaveLength(0);
	});

	it("replayed permissions include sessionId", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("perm-1"),
					sessionId: "ses-xyz",
					toolName: "Bash",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 1000,
				},
			]),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-xyz",
			requestId: pid("perm-1"),
			toolName: "Bash",
			toolInput: { patterns: [], metadata: {} },
			always: [],
		});
	});
});

describe("handleClientConnectedEffect — pending questions", () => {
	it("replays grandchild questions after publishing the reconnect family", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.sessionService.getSessionFamily).mockReturnValue(
			Effect.succeed({
				type: "session_family",
				rootId: "session-1",
				sessions: [
					{
						id: "session-1",
						title: "Root",
						status: "idle",
						updatedAt: 0,
						messageCount: 0,
					},
					{
						id: "child",
						parentID: "session-1",
						title: "Child",
						status: "idle",
						updatedAt: 0,
						messageCount: 0,
					},
					{
						id: "grandchild",
						parentID: "child",
						title: "Grandchild",
						status: "idle",
						updatedAt: 0,
						messageCount: 0,
					},
				],
			}),
		);
		vi.mocked(deps.pendingInteractions.listPendingQuestions).mockReturnValue(
			Effect.succeed([
				{
					requestId: "service-question",
					timestamp: 0,
					sessionId: "grandchild",
					questions: [
						{
							question: "Continue?",
							header: "Confirm",
							options: [],
							multiSelect: false,
						},
					],
				},
			]),
		);
		vi.mocked(deps.client.question.list).mockResolvedValue([
			{
				id: "api-question",
				sessionID: "grandchild",
				questions: [{ question: "Proceed?", header: "Confirm", options: [] }],
			},
			{
				id: "unrelated-question",
				sessionID: "unrelated",
				questions: [{ question: "Proceed?", header: "Confirm", options: [] }],
			},
		]);
		await runClientInit(deps, "client-1");
		expect(
			deps.pendingInteractions.listPendingQuestions,
		).toHaveBeenCalledWith();
		for (const toolId of ["service-question", "api-question"]) {
			expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
				"client-1",
				expect.objectContaining({
					type: "ask_user",
					sessionId: "grandchild",
					toolId,
				}),
			);
		}
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ toolId: "unrelated-question" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_family" }),
		);
		const sentTypes = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.calls.map(([, message]) => message.type);
		expect(sentTypes.indexOf("session_family")).toBeLessThan(
			sentTypes.indexOf("ask_user"),
		);
	});

	it("sends pending questions to reconnecting client", async () => {
		const deps = makeClientInitEffectLayer();
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

		await runClientInit(deps, "client-1");

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
			providerId: "opencode",
			toolUseId: "toolu_abc123",
		});
	});

	it("does not send ask_user when no pending questions", async () => {
		const deps = makeClientInitEffectLayer();
		// listPendingQuestions returns [] by default

		await runClientInit(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);
		expect(askCalls).toHaveLength(0);
	});

	it("sends both pending permissions and questions together", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("perm-1"),
					sessionId: "ses-1",
					toolName: "file_write",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 1000,
				},
			]),
		);
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

		await runClientInit(deps, "client-1");

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
		const deps = makeClientInitEffectLayer();
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

		await runClientInit(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);
		// Only the question matching the active session should be sent
		expect(askCalls).toHaveLength(1);
		const askCall = askCalls[0];
		assert.exists(askCall, "expected ask call");
		expect((askCall[1] as { toolId: string }).toolId).toBe("que_this");
	});
});

describe("handleClientConnectedEffect — error resilience", () => {
	it("continues sending remaining data when getSession fails", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("session fail"))),
		);

		await runClientInit(deps, "client-1");

		expect(deps.sessionService.pushViewerFamilies).toHaveBeenCalledOnce();
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
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.modelService.getSession).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("fail"))),
		);
		vi.mocked(deps.sessionService.pushViewerFamilies).mockReturnValue(
			Effect.fail(
				new SessionManagerError({
					operation: "pushViewerFamilies",
					cause: new Error("fail"),
				}),
			),
		);
		vi.mocked(deps.agentService.listAgents).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("fail"))),
		);
		vi.mocked(deps.modelService.listProviders).mockReturnValue(
			Effect.fail(new Cause.UnknownException(new Error("fail"))),
		);

		// Should NOT throw
		await expect(runClientInit(deps, "client-1")).resolves.toBeUndefined();

		// Should have sent INIT_FAILED errors for genuinely unavailable init data.
		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const errorCalls = sendToCalls.filter(
			(c) =>
				(c[1] as { type: string }).type === "system_error" &&
				(c[1] as { code: string }).code === "INIT_FAILED",
		);
		expect(errorCalls.length).toBeGreaterThanOrEqual(2);
	});
});

// Permissions are replayed from the Effect-owned pending interaction port.
// Questions are replayed first from the same port, then from the OpenCode REST
// API with field mapping (`multiple` → `multiSelect`).

describe("handleClientConnectedEffect — pending interaction integration", () => {
	it("replays permission from the pending interaction port", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("perm-real-1"),
					sessionId: "",
					toolName: "file_write",
					toolInput: { patterns: ["/tmp/test.txt"], metadata: { foo: "bar" } },
					always: ["shell_exec"],
					timestamp: 1000,
				},
			]),
		);

		await runClientInit(deps, "client-1");

		// Verify the exact message shape sent to the client
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "",
			requestId: pid("perm-real-1"),
			toolName: "file_write",
			toolInput: { patterns: ["/tmp/test.txt"], metadata: { foo: "bar" } },
			always: ["shell_exec"],
		});
	});

	it("replays question from API with field mapping (multiple → multiSelect)", async () => {
		const deps = makeClientInitEffectLayer();

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

		await runClientInit(deps, "client-1");

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
			providerId: "opencode",
			toolUseId: "toolu_xyz",
		});
	});

	it("replays multiple pending permissions and API questions simultaneously", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
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
			]),
		);

		// Mock the REST API to return 1 pending question
		vi.mocked(deps.client.question.list).mockResolvedValue([
			{
				id: "q-r1",
				questions: [{ question: "Continue?", header: "Confirm" }],
			},
		]);

		await runClientInit(deps, "client-1");

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
		assert.exists(perm1Msg, "expected permission message");
		expect((perm1Msg[1] as { toolName: string }).toolName).toBe("shell_exec");
	});
});

describe("handleClientConnectedEffect — API permission rehydration", () => {
	it("fetches permissions from API and sends them to connecting client", async () => {
		const deps = makeClientInitEffectLayer();
		// Pending interaction service has nothing — simulates relay restart where service state is lost
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([]),
		);
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
		).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("per_api1"),
					sessionId: "ses-abc",
					toolName: "file_write",
					toolInput: {
						patterns: ["/src/*"],
						metadata: { path: "/src/foo.ts" },
					},
					always: [],
					timestamp: 1000,
				},
			]),
		);

		await runClientInit(deps, "client-1");

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
		const deps = makeClientInitEffectLayer();
		// Pending interaction service already has one permission
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("per_service1"),
					sessionId: "ses-1",
					toolName: "shell_exec",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 1000,
				},
			]),
		);
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
		).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("per_api2"),
					sessionId: "ses-2",
					toolName: "file_write",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 2000,
				},
			]),
		);

		await runClientInit(deps, "client-1");

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
		const deps = makeClientInitEffectLayer();
		// Pending interaction service has permission per_dup
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("per_dup"),
					sessionId: "ses-1",
					toolName: "shell_exec",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 1000,
				},
			]),
		);
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
		).mockReturnValue(Effect.succeed([]));

		await runClientInit(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const permCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "permission_request",
		);
		// Should only send once (from service replay), not duplicated from API
		expect(permCalls).toHaveLength(1);
		const permissionCall = permCalls[0];
		assert.exists(permissionCall, "expected permission call");
		expect((permissionCall[1] as { requestId: string }).requestId).toBe(
			"per_dup",
		);
	});

	it("gracefully handles API failure for permissions", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.client.permission.list).mockRejectedValue(
			new Error("API down"),
		);
		// Pending interaction service still has a permission
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("per_service"),
					sessionId: "ses-1",
					toolName: "Bash",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 1000,
				},
			]),
		);

		// Should NOT throw
		await expect(runClientInit(deps, "client-1")).resolves.toBeUndefined();

		// Pending interaction service permission should still be sent
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("per_service"),
			toolName: "Bash",
			toolInput: { patterns: [], metadata: {} },
			always: [],
		});
	});

	it("maps API sessionID field to sessionId in recovered permissions", async () => {
		const deps = makeClientInitEffectLayer();
		vi.mocked(deps.pendingInteractions.listPendingPermissions).mockReturnValue(
			Effect.succeed([]),
		);
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
		).mockReturnValue(
			Effect.succeed([
				{
					requestId: pid("per_sess"),
					sessionId: "ses_325b9c3caffeFlhLvFRycK1ruF",
					toolName: "file_write",
					toolInput: { patterns: [], metadata: {} },
					always: [],
					timestamp: 1000,
				},
			]),
		);

		await runClientInit(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "permission_request",
			sessionId: "ses_325b9c3caffeFlhLvFRycK1ruF",
			requestId: pid("per_sess"),
			toolName: "file_write",
			toolInput: { patterns: [], metadata: {} },
		});
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

describe("handleClientConnectedEffect — instance list", () => {
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
		const deps = makeClientInitEffectLayer();

		await runClientInit(deps, "client-1", undefined, {
			getInstances: vi.fn().mockReturnValue(instances),
		});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "instance_list",
			instances,
		});
	});

	it("does NOT send instance_list when getInstances is omitted", async () => {
		const deps = makeClientInitEffectLayer();
		// getInstances is not set

		await runClientInit(deps, "client-1");

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
		const deps = makeClientInitEffectLayer();

		await runClientInit(deps, "client-1", undefined, {
			getInstances: vi.fn().mockReturnValue(instances),
		});

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const instanceListCall = sendToCalls.find(
			(c) => (c[1] as { type: string }).type === "instance_list",
		);
		expect(instanceListCall).toBeDefined();
		assert.exists(instanceListCall, "expected instance-list call");
		expect(
			(instanceListCall[1] as { type: string; instances: unknown[] }).instances,
		).toHaveLength(2);
		expect(instanceListCall[1]).toEqual({ type: "instance_list", instances });
	});

	it("sends instance_list via sendTo (not broadcast) to the specific client", async () => {
		const deps = makeClientInitEffectLayer();

		await runClientInit(deps, "client-xyz", undefined, {
			getInstances: vi.fn().mockReturnValue([]),
		});

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
