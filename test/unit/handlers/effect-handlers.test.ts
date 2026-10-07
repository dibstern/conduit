import { SqlClient } from "@effect/sql";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	AgentServiceTag,
	filterAgents,
} from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import {
	PendingSendOwnershipLive,
	PendingSendOwnershipTag,
} from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import { ProviderTurnServiceLive } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import { SessionTitleServiceTag } from "../../../src/lib/domain/relay/Services/session-title-service.js";
// Effect Handler Tests (Batch 1)
// Verifies that the Effect handler implementations produce the expected
// observable side effects when run against a mock
// Layer. Each test provides minimal mock services via Layer.succeed, runs
// the Effect to completion, and asserts on captured calls.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, layer } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { expect, vi } from "vitest";
import { GetAgents, GetProjects } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProjectManagementServiceLive } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import { ProjectSettingsLive } from "../../../src/lib/domain/relay/Services/project-settings.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import type {
	SessionManagerShape,
	WebSocketHandlerShape,
} from "../../../src/lib/domain/relay/Services/services.js";
// Batch 2 imports
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import {
	type SessionManagerService,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	getAgent,
	getContextWindow,
	getDefaultPermissionMode,
	getModel,
	getPermissionMode,
	getVariant,
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	setAgent,
	setContextWindow,
	setModel,
	setPermissionMode,
	setVariant,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { switchContextWindowForSession } from "../../../src/lib/handlers/context-window.js";
import {
	getModelsResponse,
	switchModelForSession,
	switchVariantForSession,
} from "../../../src/lib/handlers/model.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
	setDefaultPermissionModeForRelay,
} from "../../../src/lib/handlers/permissions.js";
import {
	cancelSessionById,
	handleMessage,
	rewindSessionToMessage,
	sendMessageToSession,
} from "../../../src/lib/handlers/prompt.js";
import { reloadProviderSessionForClient } from "../../../src/lib/handlers/reload.js";
import {
	forkSessionForClient,
	handleDeleteSession,
	handleForkSession,
	handleNewSession,
	loadMoreHistoryForSession,
	markSessionSeenForClient,
	renameSessionForClient,
	viewSessionForClient,
} from "../../../src/lib/handlers/session.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectError } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { translateMessageCreated } from "../../../src/lib/relay/event-translator.js";
import { diffAndSynthesize } from "../../../src/lib/relay/message-poller.js";
import { loadRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { modelsHandlers } from "../../../src/lib/server/ws-rpc/models.js";
import { projectsHandlers } from "../../../src/lib/server/ws-rpc/projects.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import {
	makeHandlerLogger,
	makeHandlerOpenCodeAPI,
	makeSessionSettingsLayer,
} from "../../helpers/handler-fakes.js";
import {
	makeMockAgentService,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockSessionManagerShape,
	makeMockSessionTitleService,
	makeMockStatusPoller,
	makeOpenCodeInstancesStub,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { makeBaseSendTurnInput } from "../../helpers/mock-sdk.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function mockWsHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		attach: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
		...overrides,
	};
}

const flushDispatchContinuation = () =>
	Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));

function mockLogger(): Logger {
	return makeHandlerLogger();
}

type ProviderListResult = Awaited<ReturnType<OpenCodeAPI["provider"]["list"]>>;
type SessionDetail = Awaited<ReturnType<OpenCodeAPI["session"]["get"]>>;
type Message = Awaited<ReturnType<OpenCodeAPI["session"]["message"]>>;

function makeProviderListResult(
	overrides: Partial<ProviderListResult> = {},
): ProviderListResult {
	return {
		connected: [],
		defaults: {},
		providers: [],
		...overrides,
	};
}

function makeSessionDetail(
	overrides: Partial<SessionDetail> = {},
): SessionDetail {
	return {
		id: "session",
		projectID: "project",
		directory: "/tmp/project",
		title: "Session",
		version: "1.0.0",
		time: { created: 0, updated: 0 },
		...overrides,
	};
}

function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: "message",
		role: "assistant",
		sessionID: "session",
		time: { created: 0 },
		...overrides,
	};
}

function openCodeModelLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.merge(
		apiLayer,
		OpenCodeModelServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					apiLayer,
					Layer.succeed(
						OpenCodeInstancesTag,
						makeOpenCodeInstancesStub({ opencode: client }),
					),
					Layer.succeed(ConfigTag, mockConfig()),
					Layer.succeed(LoggerTag, mockLogger()),
				),
			),
		),
	);
}

function openCodeSettingsLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.merge(
		apiLayer,
		OpenCodeSettingsServiceLive.pipe(Layer.provide(apiLayer)),
	);
}

function projectManagementLayer(
	client: OpenCodeAPI,
	config: ProjectRelayConfig,
) {
	const settingsLayer = openCodeSettingsLayer(client);
	const configLayer = Layer.succeed(ConfigTag, config);
	return Layer.mergeAll(
		settingsLayer,
		configLayer,
		ProjectManagementServiceLive.pipe(
			Layer.provide(Layer.mergeAll(configLayer, settingsLayer)),
		),
	);
}

function openCodeModelAndSettingsLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.mergeAll(
		apiLayer,
		OpenCodeModelServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					apiLayer,
					Layer.succeed(
						OpenCodeInstancesTag,
						makeOpenCodeInstancesStub({ opencode: client }),
					),
					Layer.succeed(ConfigTag, mockConfig()),
					Layer.succeed(LoggerTag, mockLogger()),
				),
			),
		),
		OpenCodeSettingsServiceLive.pipe(Layer.provide(apiLayer)),
	);
}

function mockConfig(
	overrides?: Partial<ProjectRelayConfig>,
): ProjectRelayConfig {
	return makeMockConfig({
		opencodeUrl: "http://localhost:3000",
		slug: "test-project",
		projectDir: tmpdir(),
		configDir: "/tmp/test-config",
		...overrides,
	});
}

// biome-ignore format: Keep the existing test layout inside this runtime suite.
const persistentHandlerPersistence = Layer.merge(
	makePersistenceEffectLayer(":memory:"),
	Layer.succeed(ClaudeEventPersistEffectTag, {
		persistHandoffDelivered: () => Effect.void,
		persistEvent: () => Effect.void,
		persistEvents: () => Effect.void,
		persistUserMessage: () => Effect.void,
		persistClaudeSubagent: () => Effect.void,
		ensureClaudeSubagentSession: () => Effect.void,
	} satisfies ClaudeEventPersistEffect),
);
// biome-ignore format: Keep the existing test layout inside this runtime suite.
layer(Layer.mergeAll(AlertsLive, persistentHandlerPersistence, makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistentHandlerPersistence)), Layer.succeed(AgentServiceTag, makeMockAgentService()), Layer.succeed(SessionTitleServiceTag, makeMockSessionTitleService()), PendingInteractionServiceLive, PendingSendOwnershipLive, Layer.succeed(OrchestrationEngineTag, withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [], commands: [] })) })), Layer.succeed(ProviderRegistryTag, new ProviderRegistry()), Layer.succeed(ConfigTag, mockConfig()), Layer.succeed(LoggerTag, mockLogger())))("persistent handler runtime", (it) => {
describe("GetAgents", () => {
	it.effect(
		"fetches agents via OpenCodeAPI and returns the filtered list",
		() => {
			const ws = mockWsHandler();
			const mockAgents = [
				{ name: "build", id: "build", mode: "primary" as const },
				{ name: "title", id: "title", mode: "subagent" as const, hidden: true },
				{ name: "plan", id: "plan", mode: "all" as const },
			];
			const client = makeHandlerOpenCodeAPI({
				app: { agents: vi.fn(async () => mockAgents) },
			});

			return modelsHandlers
				.GetAgents(new GetAgents({ projectSlug: "test-project" }))
				.pipe(
					Effect.provide(makeTestHandlerLayer({ api: client, wsHandler: ws })),
					Effect.tap((reply) => {
						expect(client.app.agents).toHaveBeenCalledOnce();
						expect(reply).toMatchObject({
							providerScope: { id: "opencode", name: "OpenCode" },
							agents: filterAgents(mockAgents),
						});
					}),
				);
		},
	);
});

describe("GetProjects", () => {
	it.effect("uses config.getProjects when available", () => {
		const ws = mockWsHandler();
		const projects = [
			{ slug: "proj-1", title: "Project 1", folders: ["/path"] as const },
		];
		const config = mockConfig({
			getProjects: () => projects,
		});
		const client = makeHandlerOpenCodeAPI();

		const layer = Layer.mergeAll(
			projectManagementLayer(client, config),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return projectsHandlers.GetProjects(new GetProjects({ projectSlug: "test-project" })).pipe(
			Effect.provide(layer),
			Effect.tap((reply) => {
				expect(reply).toEqual({
					projectSlug: "test-project",
					projects: [{ ...projects[0], folders: ["/path"], missing: true }],
					current: "test-project",
				});
			}),
		);
	});

	it.effect(
		"returns an empty list without querying OpenCode when no registry getter is available",
		() => {
			const ws = mockWsHandler();
			const config = mockConfig();
			const client = makeHandlerOpenCodeAPI({
				app: {
					projects: vi.fn(async () => [
						{ id: "p1", name: "Proj 1", path: "/proj1" },
					]),
				},
			});

			const layer = Layer.mergeAll(
				projectManagementLayer(client, config),
				Layer.succeed(WebSocketHandlerTag, ws),
			);

			return projectsHandlers.GetProjects(new GetProjects({ projectSlug: "test-project" })).pipe(
				Effect.provide(layer),
				Effect.tap((reply) => {
					expect(client.app.projects).not.toHaveBeenCalled();
					expect(reply).toEqual({
						projectSlug: "test-project",
						projects: [],
						current: "test-project",
					});
				}),
			);
		},
	);
});

describe("reloadProviderSessionForClient", () => {
	it.effect("reloads provider session and refreshes models/commands", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const log = mockLogger();
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({ models: [] })),
			bindSession: vi.fn(),
		});
		const client = makeHandlerOpenCodeAPI({
			provider: {
				list: vi.fn(async () => makeProviderListResult({
					connected: [],
					providers: [],
				})),
			},
			app: {
				commands: vi.fn(async () => []),
			},
		});
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			openCodeModelAndSettingsLayer(client),
			Layer.succeed(ConfigTag, config),
			makeOverridesStateLive(),
		);

		return reloadProviderSessionForClient({
			clientId: "client-1",
			sessionId: "session-42",
			commandId: "cmd-reload-session",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				// Should have dispatched end_session
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "end_session",
						commandId: "cmd-reload-session",
						sessionId: "session-42",
					}),
				);

				// Should have sent provider_session_reloaded
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "provider_session_reloaded",
					sessionId: "session-42",
				});
			}),
		);
	});
});

describe("sendModelsStateToClient", () => {
	it.effect("fetches providers into the model catalog", () => {
		const ws = mockWsHandler();
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({ models: [] })),
		});
		const client = makeHandlerOpenCodeAPI({
			provider: {
				list: vi.fn(async () => makeProviderListResult({
					connected: ["openai"],
					providers: [
						{
							id: "openai",
							name: "OpenAI",
							models: [{ id: "gpt-4", name: "GPT-4" }],
						},
					],
				})),
			},
			session: { get: vi.fn() },
		});
		const log = mockLogger();

		const layer = Layer.mergeAll(
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return getModelsResponse({ clientId: "client-1" }).pipe(
			Effect.provide(layer),
			Effect.tap((response) => {
				expect(client.provider.list).toHaveBeenCalledOnce();
				expect(response.providers).toEqual(expect.arrayContaining([
							expect.objectContaining({ id: "openai" }),
						]));
			}),
		);
	});

	it.effect(
		"includes variants and contextWindowOptions in claude provider entries",
		() => {
			const ws = mockWsHandler();
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-opus-4-7",
							name: "Claude Opus 4.7",
							providerId: "claude",
							variants: { low: {}, medium: {}, high: {}, max: {} },
							contextWindowOptions: [
								{ value: "200k", label: "200K", isDefault: true },
								{ value: "1m", label: "1M (beta)" },
							],
						},
					],
				})),
			});
			const client = makeHandlerOpenCodeAPI({
				provider: {
					list: vi.fn(async () => makeProviderListResult({
						connected: [],
						providers: [],
					})),
				},
				session: { get: vi.fn() },
			});
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return getModelsResponse({ clientId: "client-1" }).pipe(
				Effect.provide(layer),
				Effect.tap((response) => {
					expect(response.providers).toEqual([
								{
									id: "claude",
									name: "Anthropic - claude",
									configured: true,
									models: [
										{
											id: "claude-opus-4-7",
											name: "Claude Opus 4.7",
											provider: "claude",
											variants: ["low", "medium", "high", "max"],
											contextWindowOptions: [
												{ value: "200k", label: "200K", isDefault: true },
												{ value: "1m", label: "1M (beta)" },
											],
										},
									],
								},
							]);
				}),
			);
		},
	);
	it.effect(
		"returns Claude models when OpenCode provider discovery fails",
		() => {
			const ws = mockWsHandler();
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
						},
					],
				})),
			});
			const client = makeHandlerOpenCodeAPI({
				provider: {
					list: vi.fn(async () => {
						throw new Error("opencode offline");
					}),
				},
				session: { get: vi.fn() },
			});
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return getModelsResponse({ clientId: "client-1" }).pipe(
				Effect.provide(layer),
				Effect.tap((response) => {
					expect(response.providers).toEqual([
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
						]);
				}),
			);
		},
	);
	it.effect(
		"keeps OpenCode discovery while skipping session lookup for a Claude-bound model refresh",
		() => {
			const ws = mockWsHandler();
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-opus-4-7",
							name: "Claude Opus 4.7",
							providerId: "claude",
						},
					],
				})),
			});
			const client = makeHandlerOpenCodeAPI({
				provider: {
					list: vi.fn(async () => makeProviderListResult({
						connected: ["openai"],
						defaults: {},
						providers: [
							{
								id: "openai",
								name: "OpenAI",
								models: [{ id: "gpt-5", name: "GPT-5" }],
							},
						],
					})),
				},
				session: {
					get: vi.fn(async () => {
						throw new Error("opencode session lookup should be skipped");
					}),
				},
			});
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "claude-opus-4-7",
				});
				const response = yield* getModelsResponse({
					clientId: "client-1",
					sessionId: "session-1",
				});

				expect(client.provider.list).toHaveBeenCalledOnce();
				expect(client.session.get).not.toHaveBeenCalled();
				expect(response.providers).toEqual([
						{
							id: "openai",
							name: "OpenAI",
							configured: true,
							models: [
								{
									id: "gpt-5",
									name: "GPT-5",
									provider: "openai",
								},
							],
						},
						{
							id: "claude",
							name: "Anthropic - claude",
							configured: true,
							models: [
								{
									id: "claude-opus-4-7",
									name: "Claude Opus 4.7",
									provider: "claude",
								},
							],
						},
					]);
				expect(response.active).toEqual({
					model: "claude-opus-4-7",
					provider: "claude",
				});
			}).pipe(Effect.provide(layer));
		},
	);
});

describe("switchModelForSession", () => {
	it.effect("sets model override when client has a session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const log = mockLogger();
		const config = mockConfig();
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({ models: [] })),
			bindSession: vi.fn(),
		});
		const client = makeHandlerOpenCodeAPI({
			provider: {
				list: vi.fn(async () => makeProviderListResult({
					providers: [],
				})),
			},
		});

		const layer = Layer.mergeAll(
			makeSessionSettingsLayer(),
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* switchModelForSession({
				clientId: "client-1",
				sessionId: "session-42",
				modelId: "gpt-4",
				providerId: "openai",
			});
			expect(yield* getModel("session-42")).toEqual({
				providerID: "openai",
				modelID: "gpt-4",
			});
			expect(log.info).toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"warms OpenCode on model switch without binding a local placeholder",
		() => {
			const ws = mockWsHandler();
			const log = mockLogger();
			const config = mockConfig();
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({ models: [] })),
				bindSession: vi.fn(),
				unbindSession: vi.fn(),
			});
			const client = makeHandlerOpenCodeAPI({
				provider: {
					list: vi.fn(async () => makeProviderListResult({
						connected: ["opencode"],
						providers: [
							{
								id: "opencode",
								name: "OpenCode",
								models: [
									{
										id: "big-pickle",
										name: "Big Pickle",
										variants: { standard: {} },
									},
								],
							},
						],
					})),
				},
				session: {
					create: vi.fn(async () => {
						throw new Error("session create should not run on model switch");
					}),
				},
			});
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("idle")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "ses-local-placeholder",
						provider: "claude",
						provider_sid: null,
						version: 0,
						title: "Untitled",
						status: "idle",
						parent_id: null,
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
					}),
				),
				getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
				getSessionsForReconciliation: () => Effect.succeed([]),
				listSessions: vi.fn(() => Effect.succeed([])),
				listSessionInfos: vi.fn(() => Effect.succeed([])),
				readSessionTranscript: vi.fn(() =>
					Effect.succeed({ messages: [], version: 0 }),
				),
				readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				readSessionTranscriptPage: vi.fn(() =>
					Effect.succeed({ messages: [], hasMore: false, version: 0 }),
				),
				readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
				countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
				readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
				getSessionHistoryMetadata: vi.fn(() => Effect.succeed({ messageCount: 0, cumulativeTokens: 0 })),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;

			const layer = Layer.mergeAll(
				makeSessionSettingsLayer(),
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				const result = yield* switchModelForSession({
					clientId: "client-1",
					sessionId: "ses-local-placeholder",
					modelId: "big-pickle",
					providerId: "opencode",
				});

				expect(client.provider.list).toHaveBeenCalledOnce();
				expect(client.session.create).not.toHaveBeenCalled();
				expect(engine.bindSession).not.toHaveBeenCalledWith(
					"ses-local-placeholder",
					"opencode",
				);
				expect(engine.unbindSession).toHaveBeenCalledWith(
					"ses-local-placeholder",
				);
				expect(yield* getModel("ses-local-placeholder")).toEqual({
					providerID: "opencode",
					modelID: "big-pickle",
				});
				expect(result).toMatchObject({
					variant: "",
					variants: ["standard"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("returns Claude variants when switching to a Claude model", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const log = mockLogger();
		const config = mockConfig({
			configDir: `/tmp/conduit-switch-model-claude-${Date.now()}`,
		});
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({
				models: [
					{
						id: "opus",
						name: "Default (recommended)",
						providerId: "claude",
						variants: { low: {}, medium: {}, high: {}, max: {} },
					},
				],
			})),
			bindSession: vi.fn(),
		});
		const client = makeHandlerOpenCodeAPI({
			provider: {
				list: vi.fn(async () => makeProviderListResult({
					connected: [],
					providers: [],
				})),
			},
		});

		const layer = Layer.mergeAll(
			makeSessionSettingsLayer(),
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			const result = yield* switchModelForSession({
				clientId: "client-1",
				sessionId: "session-42",
				modelId: "opus",
				providerId: "claude",
			});
			expect(yield* getModel("session-42")).toEqual({
				providerID: "claude",
				modelID: "opus",
			});
			expect(engine.dispatchEffect).toHaveBeenCalledWith({
				type: "discover",
				providerId: "claude",
			});
			expect(client.provider.list).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				variant: "",
				variants: ["low", "medium", "high", "max"],
			});
		}).pipe(Effect.provide(layer));
	});
});

describe("switchVariantForSession", () => {
	it.effect("returns Claude variants when active model is Claude", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({
				models: [
					{
						id: "claude-opus-4-7",
						name: "Claude Opus 4.7",
						providerId: "claude",
						variants: { low: {}, medium: {}, high: {}, max: {} },
					},
				],
			})),
		});
		const client = makeHandlerOpenCodeAPI({
			provider: {
				list: vi.fn(async () => makeProviderListResult({
					connected: [],
					providers: [],
				})),
			},
		});
		const log = mockLogger();
		const config = mockConfig({
			configDir: `/tmp/conduit-switch-variant-claude-${Date.now()}`,
		});

		const layer = Layer.mergeAll(
			makeSessionSettingsLayer(),
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
			ProjectSettingsLive,
		);

		return Effect.gen(function* () {
			yield* setModel("session-42", {
				providerID: "claude",
				modelID: "claude-opus-4-7",
			});
			const result = yield* switchVariantForSession({
				clientId: "client-1",
				sessionId: "session-42",
				variant: "high",
			});
			expect(yield* getVariant("session-42")).toBe("high");
			expect(engine.dispatchEffect).toHaveBeenCalledWith({
				type: "discover",
				providerId: "claude",
			});
			expect(client.provider.list).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				variant: "high",
				variants: ["low", "medium", "high", "max"],
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"falls back to OpenCode lookup when active model is not Claude",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-42"),
			});
			const client = makeHandlerOpenCodeAPI({
				provider: {
					list: vi.fn(async () => makeProviderListResult({
						connected: ["openai"],
						providers: [
							{
								id: "openai",
								name: "OpenAI",
							models: [
								{ id: "gpt-4", name: "GPT-4", variants: { v2: {}, v3: {} } },
							],
							},
						],
					})),
				},
			});
			const log = mockLogger();
			const config = mockConfig({
				configDir: `/tmp/conduit-switch-variant-opencode-${Date.now()}`,
			});

			const layer = Layer.mergeAll(
				makeSessionSettingsLayer(),
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				makeOverridesStateLive(),
				ProjectSettingsLive,
			);

			return Effect.gen(function* () {
				yield* setModel("session-42", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				const result = yield* switchVariantForSession({
					clientId: "client-1",
					sessionId: "session-42",
					variant: "v2",
				});
				expect(yield* getVariant("session-42")).toBe("v2");
				expect(result).toMatchObject({
					variant: "v2",
					variants: ["v2", "v3"],
				});
			}).pipe(Effect.provide(layer));
		},
	);
});

describe("switchContextWindowForSession", () => {
	it.effect(
		"persists supported Claude context window and echoes available options",
		() => {
			const contextWindowOptions = [
				{ value: "200k", label: "200k", isDefault: true },
				{ value: "1m", label: "1M" },
			];
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-42"),
			});
			const engine = withDispatchEffect({
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
			});
			const log = mockLogger();

			const layer = Layer.mergeAll(
				makeSessionSettingsLayer(),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-42", {
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});
				const result = yield* switchContextWindowForSession({
					clientId: "client-1",
					sessionId: "session-42",
					contextWindow: "1m",
				});
				expect(yield* getContextWindow("session-42")).toBe("1m");
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(result).toMatchObject({
					contextWindow: "1m",
					options: contextWindowOptions,
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"ignores unsupported context window and resends current state",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-42"),
			});
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-haiku-4-7",
							name: "Claude Haiku 4.7",
							providerId: "claude",
						},
					],
				})),
			});
			const log = mockLogger();

			const layer = Layer.mergeAll(
				makeSessionSettingsLayer(),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-42", {
					providerID: "claude",
					modelID: "claude-haiku-4-7",
				});
				yield* setContextWindow("session-42", "200k");
				const result = yield* switchContextWindowForSession({
					clientId: "client-1",
					sessionId: "session-42",
					contextWindow: "1m",
				});
				expect(yield* getContextWindow("session-42")).toBe("200k");
				expect(result).toMatchObject({
					contextWindow: "200k",
					options: [],
				});
			}).pipe(Effect.provide(layer));
		},
	);
});

// ═══════════════════════════════════════════════════════════════════════════
// Batch 2 tests — permissions, session, prompt, terminal, instance, tool-content
// ═══════════════════════════════════════════════════════════════════════════

function mockSessionManager(
	overrides?: Partial<SessionManagerShape>,
): SessionManagerShape {
	return makeMockSessionManagerShape({
		createSession: vi.fn(async () => ({
			id: "new-session-1",
			projectID: "project-1",
			directory: "/tmp/project",
			title: "",
			version: "1.0.0",
			time: { created: 0, updated: 0 },
		})),
		deleteSession: vi.fn(async () => {}),
		renameSession: vi.fn(async () => {}),
		listSessions: vi.fn(async () => []),
		searchSessions: vi.fn(async () => []),
		loadPreRenderedHistory: vi.fn(async () => ({
			messages: [],
			hasMore: false,
		})),
		sendSessionLists: vi.fn(async () => {}),
		recordMessageActivity: vi.fn(),
		...overrides,
	});
}

function makeForkSessionLayer(options?: {
	client?: OpenCodeAPI;
	ws?: WebSocketHandlerShape;
	sessionMgr?: SessionManagerShape;
	sessionManagerService?: SessionManagerService;
	log?: Logger;
}) {
	const client =
		options?.client ??
		(makeHandlerOpenCodeAPI({
			session: {
				fork: vi.fn(async () => makeSessionDetail({
					id: "ses-child",
					title: "Forked Session",
					time: { created: 200, updated: 201 },
				})),
				messages: vi.fn(async () => [
					makeMessage({ id: "msg-1", time: { created: 123 } }),
					makeMessage({ id: "msg-2" }),
				]),
				messagesPage: vi.fn(async () => [makeMessage({ id: "msg-last" })]),
				get: vi.fn(async () => makeSessionDetail()),
			},
			permission: { list: vi.fn(async () => []) },
		}));
	const ws = options?.ws ?? mockWsHandler();
	const _sessionMgr = options?.sessionMgr ?? mockSessionManager();
	const sessionManagerService =
		options?.sessionManagerService ?? makeMockSessionManagerService();
	const log = options?.log ?? mockLogger();
	const forkPersistence = Layer.effectDiscard(
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.projectEvent(
				yield* store.append(
					canonicalEvent(
						"session.created",
						"ses-parent",
						{ sessionId: "ses-parent", title: "Parent Session", provider: "opencode" },
						{ provider: "opencode", createdAt: 100 },
					),
				),
			);
		}),
	).pipe(Layer.provideMerge(makePersistenceEffectLayer(":memory:")));

	return Layer.mergeAll(
		openCodeModelLayer(client),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
		PendingSendOwnershipLive,
		Layer.succeed(LoggerTag, log),
		Layer.succeed(
			StatusPollerTag,
			makeMockStatusPoller({
				isProcessing: vi.fn(() => Effect.succeed(false)),
				clearMessageActivity: vi.fn(() => Effect.void),
			}),
		),
		Layer.succeed(PollerManagerTag, {
			on: vi.fn(),
			isPolling: vi.fn(() => true),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
			notifySSEEvent: vi.fn(),
		}),
		makeOverridesStateLive(),
		forkPersistence,
	);
}

function makeSessionLifecycleLayer(options?: {
	client?: OpenCodeAPI;
	ws?: WebSocketHandlerShape;
	sessionMgr?: SessionManagerShape;
	sessionManagerService?: SessionManagerService;
	log?: Logger;
}) {
	const ws = options?.ws ?? mockWsHandler();
	const _sessionMgr = options?.sessionMgr ?? mockSessionManager();
	const sessionManagerService =
		options?.sessionManagerService ?? makeMockSessionManagerService();
	const client =
		options?.client ??
		(makeHandlerOpenCodeAPI({
			session: {
				get: vi.fn(async () => makeSessionDetail()),
			},
			permission: { list: vi.fn(async () => []) },
			question: { list: vi.fn(async () => []) },
		}));
	const log = options?.log ?? mockLogger();

	return Layer.mergeAll(
		openCodeModelLayer(client),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
		PendingSendOwnershipLive,
		Layer.succeed(LoggerTag, log),
		Layer.succeed(
			StatusPollerTag,
			makeMockStatusPoller({
				isProcessing: vi.fn(() => Effect.succeed(false)),
				clearMessageActivity: vi.fn(() => Effect.void),
			}),
		),
		Layer.succeed(PollerManagerTag, {
			on: vi.fn(),
			isPolling: vi.fn(() => true),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
			notifySSEEvent: vi.fn(),
		}),
		makeOverridesStateLive(),
	);
}

describe("handleForkSession", () => {
	it.effect(
		"uses the canonical fork seam without duplicate establishment",
		() => {
			const establishOpenCodeSession = vi.fn(() => Effect.void);
			const setForkEntry = vi.fn(() => Effect.void);
			const ws = mockWsHandler();
			const client = makeHandlerOpenCodeAPI({
				session: {
					fork: vi.fn(async () => makeSessionDetail({
						id: "ses-child",
						title: "Forked Session",
						time: { created: 200, updated: 201 },
					})),
					messages: vi.fn(async () => [
						makeMessage({ id: "msg-1", time: { created: 123 } }),
						makeMessage({ id: "msg-2" }),
					]),
					messagesPage: vi.fn(async () => [makeMessage({ id: "msg-last" })]),
					get: vi.fn(async () => makeSessionDetail()),
				},
				permission: { list: vi.fn(async () => []) },
			});
			const layer = makeForkSessionLayer({
				client,
				ws,
				sessionManagerService: makeMockSessionManagerService({
					establishOpenCodeSession,
					setForkEntry,
				}),
			});

			return Effect.gen(function* () {
				yield* handleForkSession("client-1", {
					sessionId: "ses-parent",
					messageId: "msg-1",
				}).pipe(Effect.provide(layer));

				// OpenCode cuts before messageID, so the fork keeps msg-1.
				expect(client.session.fork).toHaveBeenCalledWith("ses-parent", {
					messageID: "msg-2",
				});
				expect(establishOpenCodeSession).not.toHaveBeenCalled();
				expect(setForkEntry).not.toHaveBeenCalled();
				expect(ws.broadcast).not.toHaveBeenCalled();
				expect(ws.setClientSession).not.toHaveBeenCalled();
			});
		},
	);

	it.effect(
		"does not expose a fork when the canonical upstream fork fails",
		() => {
			const setForkEntry = vi.fn(() => Effect.void);
			const ws = mockWsHandler();
			const client = makeHandlerOpenCodeAPI({
				session: {
					fork: vi.fn(async () => {
						throw new Error("fork unavailable");
					}),
					messages: vi.fn(async () => [
						makeMessage({ id: "msg-1", time: { created: 123 } }),
						makeMessage({ id: "msg-2" }),
					]),
					messagesPage: vi.fn(async () => []),
					get: vi.fn(async () => makeSessionDetail()),
				},
				permission: { list: vi.fn(async () => []) },
			});
			const layer = makeForkSessionLayer({
				client,
				ws,
				sessionManagerService: makeMockSessionManagerService({
					setForkEntry,
				}),
			});

			return Effect.exit(
				handleForkSession("client-1", {
					sessionId: "ses-parent",
					messageId: "msg-1",
				}).pipe(Effect.provide(layer)),
			).pipe(
				Effect.tap((exit) => {
					expect(Exit.isFailure(exit)).toBe(true);
					expect(setForkEntry).not.toHaveBeenCalled();
					expect(ws.broadcast).not.toHaveBeenCalled();
					expect(ws.sendTo).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect(
		"clears Effect override state for the forked source session",
		() => {
			const layer = makeForkSessionLayer();

			return Effect.gen(function* () {
				yield* setModel("ses-parent", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				yield* setAgent("ses-parent", "plan");
				yield* setVariant("ses-parent", "fast");
				yield* setContextWindow("ses-parent", "1m");

				yield* handleForkSession("client-1", {
					sessionId: "ses-parent",
					messageId: "msg-1",
				});

				expect(yield* getModel("ses-parent")).toBeUndefined();
				expect(yield* getAgent("ses-parent")).toBeUndefined();
				expect(yield* getVariant("ses-parent")).toBe("");
				expect(yield* getContextWindow("ses-parent")).toBe("");
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"broadcasts the persisted fork boundary instead of recomputing metadata",
		() => {
			const legacySetForkEntry = vi.fn();
			const legacySendSessionLists = vi.fn(async () => {
				throw new Error("legacy sendSessionLists should not be used");
			});
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy listSessions should not be used");
			});
			const serviceListSessions = vi.fn(() =>
				Effect.succeed([
					{
						id: "ses-parent",
						title: "Parent Session",
						status: "idle" as const,
						updatedAt: 100,
						messageCount: 1,
					},
					{
						id: "ses-child",
						title: "Forked Session",
						status: "idle" as const,
						updatedAt: 201,
						parentID: "ses-parent",
						forkMessageId: "msg-1",
						forkPointTimestamp: 456,
					},
				]),
			);
			const serviceSetForkEntry = vi.fn(() => Effect.void);
			const ws = mockWsHandler();
			const sessionMgr = mockSessionManager({
				listSessions: legacyListSessions,
				loadPreRenderedHistory: vi.fn(async () => ({
					messages: [],
					hasMore: false,
				})),
			});
			const sessionManagerService = makeMockSessionManagerService({
				listSessions: serviceListSessions,
				setForkEntry: serviceSetForkEntry,
			});
			const layer = makeForkSessionLayer({
				sessionMgr,
				sessionManagerService,
				ws,
			});

			return forkSessionForClient({
				clientId: "client-1",
				sessionId: "ses-parent",
				messageId: "msg-1",
			}).pipe(
				Effect.provide(layer),
				Effect.tap((fork) => {
					expect(serviceSetForkEntry).not.toHaveBeenCalled();
					expect(legacySetForkEntry).not.toHaveBeenCalled();
					expect(serviceListSessions).toHaveBeenCalledWith();
					expect(legacyListSessions).not.toHaveBeenCalled();
					expect(fork).toEqual({
						id: "ses-child",
						parentId: "ses-parent",
						forkMessageId: "msg-1",
						forkPointTimestamp: 456,
					});
					expect(ws.setClientSession).not.toHaveBeenCalled();
					expect(legacySendSessionLists).not.toHaveBeenCalled();
					expect(ws.broadcast).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect("uses the whole-session fork fallback message as metadata", () => {
		const legacySetForkEntry = vi.fn();
		const serviceSetForkEntry = vi.fn(() => Effect.void);
		const messagesPage = vi.fn(async () => [makeMessage({ id: "msg-last" })]);
		const client = makeHandlerOpenCodeAPI({
			session: {
				fork: vi.fn(async () => makeSessionDetail({
					id: "ses-child",
					title: "Forked Session",
					time: { created: 200, updated: 201 },
				})),
				messagesPage,
				get: vi.fn(async () => makeSessionDetail()),
			},
			permission: { list: vi.fn(async () => []) },
		});
		const sessionMgr = mockSessionManager({
			listSessions: vi.fn(async () => []),
			loadPreRenderedHistory: vi.fn(async () => ({
				messages: [],
				hasMore: false,
			})),
		});
		const sessionManagerService = makeMockSessionManagerService({
			setForkEntry: serviceSetForkEntry,
		});
		const layer = makeForkSessionLayer({
			client,
			sessionMgr,
			sessionManagerService,
		});

		return handleForkSession("client-1", {
			sessionId: "ses-parent",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(messagesPage).toHaveBeenCalledWith("ses-child", { limit: 1 });
				expect(serviceSetForkEntry).not.toHaveBeenCalled();
				expect(legacySetForkEntry).not.toHaveBeenCalled();
			}),
		);
	});

	it.effect(
		"returns without forking when no active session can be resolved",
		() => {
			const setForkEntry = vi.fn();
			const fork = vi.fn();
			const client = makeHandlerOpenCodeAPI({
				session: {
					fork,
				},
				permission: { list: vi.fn(async () => []) },
			});
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const sessionMgr = mockSessionManager();
			const layer = makeForkSessionLayer({ client, ws, sessionMgr });

			return handleForkSession("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(fork).not.toHaveBeenCalled();
					expect(setForkEntry).not.toHaveBeenCalled();
				}),
			);
		},
	);
});

describe("setDefaultPermissionModeForRelay", () => {
	it.effect(
		"persists and updates the default without changing a session",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-default-permission-mode-"),
			);
			const ws = mockWsHandler();
			const log = mockLogger();
			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, mockConfig({ configDir })),
				makeOverridesStateLive(),
				ProjectSettingsLive,
			);

			return Effect.gen(function* () {
				yield* setPermissionMode("session-1", "full");

				const mode = yield* setDefaultPermissionModeForRelay({
					clientId: "client-1",
					mode: "auto",
				});

				expect(mode).toBe("auto");
				expect(loadRelaySettings(configDir).defaultPermissionMode).toBe("auto");
				expect(yield* getDefaultPermissionMode()).toBe("auto");
				expect(yield* getPermissionMode("session-1")).toBe("full");
				// Peers hear it through SubscribeProjectSettings, not a broadcast.
				expect(ws.broadcast).not.toHaveBeenCalled();
				expect(log.info).toHaveBeenCalledWith(
					"client=client-1 Set default permission mode to: auto",
				);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() =>
						rmSync(configDir, { recursive: true, force: true }),
					),
				),
			);
		},
	);
});

describe("handlePermissionResponse", () => {
	const openCodeRegistry = () => {
		const resolvePermissionEffect = vi.fn(() => Effect.void);
		const registry = new ProviderRegistry();
		registry.registerInstance({
			providerId: "opencode",
			resolvePermissionEffect,
		} as unknown as ProviderInstance);
		return { registry, resolvePermissionEffect };
	};

	it.effect(
		"processes permission response through PendingInteractionService",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const log = mockLogger();
			const client = makeHandlerOpenCodeAPI({
				permission: { reply: vi.fn(async () => {}) },
				config: { get: vi.fn(async () => makeSessionDetail()) },
			});
			const config = mockConfig();
			const { registry, resolvePermissionEffect } = openCodeRegistry();

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(ProviderRegistryTag, registry),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
			);

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordPermissionRequest({
					requestId: "perm-1" as PermissionId,
					sessionId: "session-1",
					toolName: "Bash",
					toolInput: { patterns: [], metadata: {} },
					always: [],
				});

				yield* handlePermissionResponse("client-1", {
					requestId: "perm-1" as PermissionId,
					decision: "allow",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(resolvePermissionEffect).toHaveBeenCalledWith(
						"session-1",
						"perm-1",
						"once",
					);
				}),
			);
		},
	);

	it.effect(
		"uses the pending permission session when the responding client is viewing another session",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "visible-session"),
			});
			const log = mockLogger();
			const client = makeHandlerOpenCodeAPI({
				permission: { reply: vi.fn(async () => {}) },
				config: { get: vi.fn(async () => makeSessionDetail()) },
			});
			const config = mockConfig();
			const { registry, resolvePermissionEffect } = openCodeRegistry();

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(ProviderRegistryTag, registry),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
			);

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordPermissionRequest({
					requestId: "perm-cross-session" as PermissionId,
					sessionId: "permission-session",
					toolName: "Bash",
					toolInput: { patterns: [], metadata: {} },
					always: [],
				});

				yield* handlePermissionResponse("client-1", {
					requestId: "perm-cross-session" as PermissionId,
					decision: "allow",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(resolvePermissionEffect).toHaveBeenCalledWith(
						"permission-session",
						"perm-cross-session",
						"once",
					);
				}),
			);
		},
	);

	it.effect(
		"does not persist OpenCode permission rules for Claude sessions",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-claude"),
			});
			const log = mockLogger();
			const client = makeHandlerOpenCodeAPI({
				permission: { reply: vi.fn(async () => {}) },
				config: {
					get: vi.fn(async () => makeSessionDetail()),
					update: vi.fn(async () => {}),
				},
			});
			const config = mockConfig();
			const engine = {
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
			);

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordPermissionRequest({
					requestId: "perm-claude" as PermissionId,
					sessionId: "session-claude",
					toolName: "Bash",
					toolInput: { command: "npm test" },
					always: [],
				});

				yield* handlePermissionResponse("client-1", {
					requestId: "perm-claude" as PermissionId,
					decision: "allow_always",
					persistScope: "tool",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.permission.reply).not.toHaveBeenCalled();
					expect(client.config.get).not.toHaveBeenCalled();
					expect(client.config.update).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect(
		"does not fall back to OpenCode permission reply while the first Claude turn is still in flight",
		() =>
			Effect.gen(function* () {
				const ws = mockWsHandler({
					getClientSession: vi.fn(() => "session-claude-in-flight"),
				});
				const log = mockLogger();
				const client = makeHandlerOpenCodeAPI({
					permission: { reply: vi.fn(async () => {}) },
					config: {
						get: vi.fn(async () => makeSessionDetail()),
						update: vi.fn(async () => {}),
					},
				});
				const config = mockConfig();
				const sendStarted = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				const instance: ProviderInstance = {
					providerId: "claude",
					discoverEffect: vi.fn(() =>
						Effect.succeed({
							models: [],
							supportsTools: false,
							supportsThinking: false,
							supportsPermissions: false,
							supportsQuestions: false,
							supportsAttachments: false,
							supportsFork: false,
							supportsRevert: false,
							commands: [],
						}),
					),
					sendTurnEffect: vi.fn(() =>
						Effect.gen(function* () {
							yield* Deferred.succeed(sendStarted, undefined);
							yield* Deferred.await(releaseSend);
							return {
								status: "completed" as const,
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							};
						}),
					),
					interruptTurnEffect: vi.fn(() => Effect.void),
					resolvePermissionEffect: vi.fn(() => Effect.void),
					resolveQuestionEffect: vi.fn(() => Effect.void),
					shutdownEffect: vi.fn(() => Effect.void),
					endSessionEffect: vi.fn(() => Effect.void),
				};
				const registry = new ProviderRegistry();
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({ registry });

				const layer = Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(ConfigTag, config),
					Layer.succeed(OrchestrationEngineTag, engine),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
				);

				yield* Effect.gen(function* () {
					const fiber = yield* Effect.fork(
						engine.dispatchEffect({
							type: "send_turn",
							commandId: "cmd-claude-in-flight",
							providerId: "claude",
							input: makeBaseSendTurnInput({
								sessionId: "session-claude-in-flight",
							}),
						}),
					);
					yield* Deferred.await(sendStarted);

					const pendingInteractions = yield* PendingInteractionServiceTag;
					yield* pendingInteractions.recordPermissionRequest({
						requestId: "perm-claude-in-flight" as PermissionId,
						sessionId: "session-claude-in-flight",
						toolName: "Bash",
						toolInput: { command: "npm test" },
						always: [],
					});
					yield* handlePermissionResponse("client-1", {
						requestId: "perm-claude-in-flight" as PermissionId,
						decision: "allow_always",
						persistScope: "tool",
					});

					expect(client.permission.reply).not.toHaveBeenCalled();
					expect(client.config.get).not.toHaveBeenCalled();
					expect(client.config.update).not.toHaveBeenCalled();

					yield* Deferred.succeed(releaseSend, undefined);
					yield* Fiber.join(fiber);
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect("processes permission response", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const client = makeHandlerOpenCodeAPI({
			permission: { reply: vi.fn(async () => {}) },
			config: { get: vi.fn(async () => makeSessionDetail()) },
		});
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			PendingSendOwnershipLive,
		);

		return Effect.gen(function* () {
			const pendingInteractions = yield* PendingInteractionServiceTag;
			yield* pendingInteractions.recordPermissionRequest({
				requestId: "perm-1" as PermissionId,
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { patterns: [], metadata: {} },
				always: [],
			});
			yield* handlePermissionResponse("client-1", {
				requestId: "perm-1" as PermissionId,
				decision: "allow",
			});
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
			}),
		);
	});

	it.effect("does nothing when bridge returns null", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const client = makeHandlerOpenCodeAPI({
			permission: { reply: vi.fn(async () => {}) },
		});
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			PendingSendOwnershipLive,
		);

		return handlePermissionResponse("client-1", {
			requestId: "perm-1" as PermissionId,
			decision: "allow",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.broadcast).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleQuestionReject", () => {
	it.effect("does nothing when toolId is empty", () => {
		const ws = mockWsHandler();
		const log = mockLogger();
		const client = makeHandlerOpenCodeAPI();
		const sessionManagerService = makeMockSessionManagerService();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			makeOverridesStateLive(),
		);

		return handleQuestionReject("client-1", { toolId: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.broadcast).not.toHaveBeenCalled();
			}),
		);
	});

	it.effect("rejects question via REST API", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const sessionManagerService = makeMockSessionManagerService();
		const client = makeHandlerOpenCodeAPI({
			question: { reject: vi.fn(async () => {}) },
		});

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			makeOverridesStateLive(),
		);

		return handleQuestionReject("client-1", { toolId: "que-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.question.reject).toHaveBeenCalledWith("que-1");
			}),
		);
	});

	it.effect(
		"keeps Claude questions pending when the browser tries to skip them",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "visible-session"),
			});
			const log = mockLogger();
			const sessionManagerService = makeMockSessionManagerService();
			const client = makeHandlerOpenCodeAPI({
				question: {
					reject: vi.fn(async () => {}),
					list: vi.fn(async () => []),
				},
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn((sessionId: string) =>
					Effect.succeed(
						sessionId === "question-session" ? "claude" : "opencode",
					),
				),
			});

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordQuestionRequest({
					requestId: "que-claude",
					sessionId: "question-session",
					questions: [{ question: "Continue?" }],
				});
				const refusal = yield* Effect.flip(
					handleQuestionReject("client-1", { toolId: "que-claude" }),
				);
				const pending = yield* pendingInteractions.listPendingQuestions();
				return { refusal, pending };
			}).pipe(
				Effect.provide(layer),
				Effect.tap(({ refusal, pending }) => {
					expect(client.question.reject).not.toHaveBeenCalled();
					expect(engine.getProviderForSessionEffect).toHaveBeenCalledWith(
						"question-session",
					);
					// The refusal travels the RejectQuestion RPC's error channel.
					expect(refusal).toBeInstanceOf(WsRpcError);
					expect(refusal.message).toContain(
						"Claude questions require an answer",
					);
					expect(pending).toHaveLength(1);
					expect(pending[0]?.requestId).toBe("que-claude");
				}),
			);
		},
	);
});

describe("handleAskUserResponse", () => {
	it.effect(
		"persists and dispatches an answer to a recovered Claude question",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "question-session"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const completeRecoveredQuestion = vi.fn(() => Effect.void);
			const sendTurn = vi.fn(() => Effect.void);
			const turns: ProviderTurnService = {
				completeRecoveredQuestion,
				prepareTurnSession: ({ sessionId }) => Effect.succeed(sessionId),
				sendTurn,
				interruptTurn: () => Effect.void,
			};
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(ConfigTag, mockConfig()),
				Layer.succeed(LoggerTag, mockLogger()),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				Layer.succeed(ProviderTurnServiceTag, turns),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				makeOverridesStateLive(),
			);
			return Effect.gen(function* () {
				const pending = yield* PendingInteractionServiceTag;
				yield* pending.recoverPendingQuestions([
					{
						requestId: "toolu-1",
						sessionId: "question-session",
						toolCallId: "toolu-1",
						messageId: "message-1",
						providerId: "claude",
						questions: [{ question: "Which colour?" }],
					},
				]);
				yield* handleAskUserResponse("client-1", {
					toolId: "toolu-1",
					answers: { "0": "red" },
				});
				expect(completeRecoveredQuestion).toHaveBeenCalledWith(
					expect.objectContaining({ requestId: "toolu-1", recovered: true }),
					'Answer to your question "Which colour?": red',
					{ "0": "red" },
				);
				expect(sendTurn).toHaveBeenCalledWith(
					expect.objectContaining({
						sessionId: "question-session",
						text: 'Answer to your question "Which colour?": red',
					}),
				);
				expect(yield* pending.listPendingQuestions()).toHaveLength(0);
			}).pipe(Effect.provide(layer));
		},
	);
	it.effect("answers question via REST API", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const sessionManagerService = makeMockSessionManagerService();
		const client = makeHandlerOpenCodeAPI({
			question: { reply: vi.fn(async () => {}) },
		});

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(ConfigTag, mockConfig()),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					makeOverridesStateLive(),
				),
			);

		return handleAskUserResponse("client-1", {
			toolId: "que-1",
			answers: { "1": "Approve", "0": "Yes" },
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.question.reply).toHaveBeenCalledWith("que-1", [
					["Yes"],
					["Approve"],
				]);
			}),
		);
	});

	it.effect(
		"uses the pending question session when answering a Claude question from another visible session",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "visible-session"),
			});
			const log = mockLogger();
			const sessionManagerService = makeMockSessionManagerService();
			const client = makeHandlerOpenCodeAPI({
				question: {
					reply: vi.fn(async () => {}),
					list: vi.fn(async () => []),
				},
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn((sessionId: string) =>
					Effect.succeed(
						sessionId === "question-session" ? "claude" : "opencode",
					),
				),
			});

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(ConfigTag, mockConfig()),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordQuestionRequest({
					requestId: "que-claude",
					sessionId: "question-session",
					questions: [{ question: "Continue?" }],
				});
				yield* handleAskUserResponse("client-1", {
					toolId: "que-claude",
					answers: { "0": "Yes" },
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.question.reply).not.toHaveBeenCalled();
					expect(engine.getProviderForSessionEffect).toHaveBeenCalledWith(
						"question-session",
					);
				}),
			);
		},
	);
});

describe("handleNewSession", () => {
	it.effect(
		"creates and switches through SessionManagerService without pushing a family",
		() => {
			const ws = mockWsHandler();
			const log = mockLogger();
			const legacySendSessionLists = vi.fn(async () => {
				throw new Error("legacy sendSessionLists should not be used");
			});
			const legacyCreateSession = vi.fn(async () => {
				throw new Error("legacy createSession should not be used");
			});
			const sessionMgr = mockSessionManager({
				createSession: legacyCreateSession,
				sendSessionLists: legacySendSessionLists,
			});
			const serviceCreateSession = vi.fn(() =>
				Effect.succeed({
					id: "new-session-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "New Session",
					version: "1.0.0",
					time: { created: 100, updated: 200 },
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				createSession: serviceCreateSession,
			});
			const layer = makeSessionLifecycleLayer({
				ws,
				sessionMgr,
				sessionManagerService,
				log,
			});

			return handleNewSession("client-1", {
				title: "New Session",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(serviceCreateSession).toHaveBeenCalledWith("New Session");
					expect(legacyCreateSession).not.toHaveBeenCalled();
					expect(ws.setClientSession).toHaveBeenCalledWith(
						"client-1",
						"new-session-1",
					);
					expect(ws.sendTo).not.toHaveBeenCalledWith(
						"client-1",
						expect.objectContaining({ type: "session_family" }),
					);
					expect(legacySendSessionLists).not.toHaveBeenCalled();
					expect(ws.broadcast).not.toHaveBeenCalled();
					expect(log.info).toHaveBeenCalledWith(
						"client=client-1 Created: new-session-1",
					);
				}),
			);
		},
	);

	it.effect("passes the requested provider to SessionManagerService", () => {
		const ws = mockWsHandler();
		const log = mockLogger();
		const serviceCreateSession = vi.fn(() =>
			Effect.succeed({
				id: "opencode-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "OpenCode Session",
				version: "1.0.0",
				time: { created: 100, updated: 200 },
			}),
		);
		const sessionManagerService = makeMockSessionManagerService({
			createSession: serviceCreateSession,
		});
		const layer = makeSessionLifecycleLayer({
			ws,
			sessionManagerService,
			log,
		});

		return handleNewSession("client-1", {
			title: "OpenCode Session",
			providerId: "opencode",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(serviceCreateSession).toHaveBeenCalledWith("OpenCode Session", {
					providerId: "opencode",
				});
				expect(ws.setClientSession).toHaveBeenCalledWith(
					"client-1",
					"opencode-session",
				);
			}),
		);
	});

	it.effect(
		"does not start the OpenCode message poller for local Claude placeholders",
		() => {
			const ws = mockWsHandler();
			const log = mockLogger();
			const startPolling = vi.fn();
			const sessionManagerService = makeMockSessionManagerService();
			const client = makeHandlerOpenCodeAPI({
				session: { get: vi.fn(async () => makeSessionDetail()) },
				provider: { list: vi.fn(async () => makeProviderListResult({ providers: [] })) },
				permission: { list: vi.fn(async () => []) },
				question: { list: vi.fn(async () => []) },
			});
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("idle")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "ses-local-placeholder",
						provider: "claude",
						provider_sid: null,
						version: 0,
						title: "Untitled",
						status: "idle",
						parent_id: null,
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
					}),
				),
				getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
				getSessionsForReconciliation: () => Effect.succeed([]),
				listSessions: vi.fn(() => Effect.succeed([])),
				listSessionInfos: vi.fn(() => Effect.succeed([])),
				readSessionTranscript: vi.fn(() =>
					Effect.succeed({ messages: [], version: 0 }),
				),
				readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				readSessionTranscriptPage: vi.fn(() =>
					Effect.succeed({ messages: [], hasMore: false, version: 0 }),
				),
				readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
				countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
				readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
				getSessionHistoryMetadata: vi.fn(() => Effect.succeed({ messageCount: 0, cumulativeTokens: 0 })),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;
			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(
					StatusPollerTag,
					makeMockStatusPoller({
						isProcessing: vi.fn(() => Effect.succeed(false)),
					}),
				),
				Layer.succeed(PollerManagerTag, {
					on: vi.fn(),
					isPolling: vi.fn(() => false),
					startPolling,
					stopPolling: vi.fn(),
					notifySSEEvent: vi.fn(),
				}),
				makeOverridesStateLive(),
			);

			return viewSessionForClient({
				clientId: "client-1",
				sessionId: "ses-local-placeholder",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).not.toHaveBeenCalledWith(
						"client-1",
						expect.objectContaining({ type: "session_family" }),
					);
					expect(startPolling).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect(
		"reconnect replays durable command state without redispatching provider command",
		() => {
			const ws = mockWsHandler();
			const log = mockLogger();
			const dispatchEffect = vi.fn(() => Effect.void);
			const startPolling = vi.fn();
			const client = makeHandlerOpenCodeAPI({
				session: { get: vi.fn(async () => makeSessionDetail()) },
				provider: { list: vi.fn(async () => makeProviderListResult({ providers: [] })) },
				permission: { list: vi.fn(async () => []) },
				question: { list: vi.fn(async () => []) },
			});
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("processing")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "session-in-flight",
						provider: "opencode",
						provider_sid: null,
						version: 0,
						title: "In flight",
						status: "processing",
						parent_id: null,
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
					}),
				),
				getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
				getSessionsForReconciliation: () => Effect.succeed([]),
				listSessions: vi.fn(() => Effect.succeed([])),
				listSessionInfos: vi.fn(() => Effect.succeed([])),
				readSessionTranscript: vi.fn(() =>
					Effect.succeed({ messages: [], version: 0 }),
				),
				readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				readSessionTranscriptPage: vi.fn(() =>
					Effect.succeed({ messages: [], hasMore: false, version: 0 }),
				),
				readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
				countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
				readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
				getSessionHistoryMetadata: vi.fn(() => Effect.succeed({ messageCount: 0, cumulativeTokens: 0 })),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory: vi.fn(() =>
					Effect.succeed({
						messages: [],
						hasMore: false,
					}),
				),
			});
			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(
					OrchestrationEngineTag,
					withDispatchEffect({
						dispatch: vi.fn(async () => undefined),
						dispatchEffect,
					}),
				),
				Layer.succeed(StatusPollerTag, makeMockStatusPoller()),
				Layer.succeed(PollerManagerTag, {
					on: vi.fn(),
					isPolling: vi.fn(() => false),
					startPolling,
					stopPolling: vi.fn(),
					notifySSEEvent: vi.fn(),
				}),
				makeOverridesStateLive(),
			);

			return viewSessionForClient({
				clientId: "client-1",
				sessionId: "session-in-flight",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(dispatchEffect).not.toHaveBeenCalled();
				}),
			);
		},
	);

});

describe("handleDeleteSession", () => {
	it.effect(
		"does not repeat client-side deletion effects for a coalesced caller",
		() => {
			const ws = mockWsHandler({
				getClientsForSession: vi.fn(() => ["viewer-1"]),
			});
			const log = mockLogger();
			const deleteSession = vi.fn(() => Effect.succeed(false));
			const listSessions = vi.fn(() =>
				Effect.succeed([
					{
						id: "remaining-session",
						title: "Remaining Session",
						status: "idle" as const,
						updatedAt: 200,
						messageCount: 0,
					},
				]),
			);
			const sessionManagerService = makeMockSessionManagerService({
				deleteSession,
				listSessions,
			});
			const layer = makeSessionLifecycleLayer({
				ws,
				sessionManagerService,
				log,
			});

			return handleDeleteSession("client-1", {
				sessionId: "deleted-session",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(deleteSession).toHaveBeenCalledWith("deleted-session");
					expect(listSessions).not.toHaveBeenCalled();
					expect(ws.setClientSession).not.toHaveBeenCalled();
					expect(ws.sendTo).not.toHaveBeenCalled();
					expect(ws.broadcast).not.toHaveBeenCalled();
					expect(log.info).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect(
		"deletes through SessionManagerService and broadcasts the deletion",
		() => {
			const ws = mockWsHandler({
				getClientsForSession: vi.fn(() => []),
			});
			const log = mockLogger();
			const legacySendSessionLists = vi.fn(async () => {
				throw new Error("legacy sendSessionLists should not be used");
			});
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy listSessions should not be used");
			});
			const serviceListSessions = vi.fn(() => Effect.succeed([]));
			const legacyDeleteSession = vi.fn(async () => {
				throw new Error("legacy deleteSession should not be used");
			});
			const serviceDeleteSession = vi.fn(() => Effect.succeed(true));
			const sessionMgr = mockSessionManager({
				deleteSession: legacyDeleteSession,
				listSessions: legacyListSessions,
				sendSessionLists: legacySendSessionLists,
			});
			const sessionManagerService = makeMockSessionManagerService({
				deleteSession: serviceDeleteSession,
				listSessions: serviceListSessions,
			});
			const layer = makeSessionLifecycleLayer({
				ws,
				sessionMgr,
				sessionManagerService,
				log,
			});

			return handleDeleteSession("client-1", {
				sessionId: "deleted-session",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.getClientsForSession).not.toHaveBeenCalled();
					expect(serviceDeleteSession).toHaveBeenCalledWith("deleted-session");
					expect(legacyDeleteSession).not.toHaveBeenCalled();
					expect(serviceListSessions).not.toHaveBeenCalled();
					expect(legacyListSessions).not.toHaveBeenCalled();
					expect(ws.broadcast).not.toHaveBeenCalled();
					expect(legacySendSessionLists).not.toHaveBeenCalled();
					expect(log.info).toHaveBeenCalledWith(
						"client=client-1 Deleted: deleted-session",
					);
				}),
			);
		},
	);

	it.effect("does not move viewers after deleting their session", () => {
		const ws = mockWsHandler({
			getClientsForSession: vi.fn(() => ["client-1", "client-2"]),
		});
		const sessionManagerService = makeMockSessionManagerService({
			deleteSession: vi.fn(() => Effect.succeed(true)),
			listSessions: vi.fn(() => Effect.die("unexpected list")),
		});
		return handleDeleteSession("client-1", {
			sessionId: "deleted-session",
		}).pipe(
			Effect.provide(makeSessionLifecycleLayer({ ws, sessionManagerService })),
			Effect.tap(() => {
				expect(ws.setClientSession).not.toHaveBeenCalled();
				expect(sessionManagerService.listSessions).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("renameSessionForClient", () => {
	it.effect(
		"renames through SessionManagerService without pushing a family",
		() => {
			const log = mockLogger();
			const legacyRenameSession = vi.fn(async () => {
				throw new Error("legacy renameSession should not be used");
			});
			const _sessionMgr = mockSessionManager({
				renameSession: legacyRenameSession,
			});
			const ws = mockWsHandler();
			const calls: string[] = [];
			const renameSession = vi.fn(() =>
				Effect.sync(() => {
					calls.push("rename");
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				renameSession,
			});

			const layer = Layer.mergeAll(
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(WebSocketHandlerTag, ws),
			);

			return renameSessionForClient({
				clientId: "client-1",
				sessionId: "session-1",
				title: "New Title",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(renameSession).toHaveBeenCalledWith("session-1", "New Title");
					expect(legacyRenameSession).not.toHaveBeenCalled();
					expect(calls).toEqual(["rename"]);
					expect(ws.sendTo).not.toHaveBeenCalled();
					expect(ws.broadcast).not.toHaveBeenCalled();
					expect(log.info).toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect("does nothing when id or title is empty", () => {
		const log = mockLogger();
		const _sessionMgr = mockSessionManager();
		const ws = mockWsHandler();
		const renameSession = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			renameSession,
		});

		const layer = Layer.mergeAll(
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return renameSessionForClient({
			clientId: "client-1",
			sessionId: "",
			title: "New Title",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(renameSession).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("loadMoreHistoryForSession", () => {
	for (const provider of ["claude", "opencode"] as const) {
	it.effect(`loads ${provider} model execution from projected history`, () => {
		const loadPreRenderedHistory = vi.fn(() =>
			Effect.succeed({ messages: [], hasMore: false }),
		);
		const sessionManagerService = makeMockSessionManagerService({
			loadPreRenderedHistory,
		});
		const readQuery = {
			getToolContent: vi.fn(() => Effect.succeed(undefined)),
			getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
			getSession: vi.fn(() =>
				Effect.succeed({
					id: "session-1",
					provider,
					provider_sid: null,
					version: 0,
					title: "Claude",
					status: "idle",
					parent_id: null,
					fork_point_event: null,
					last_message_at: 1,
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
				}),
			),
			getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
			getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
			getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
			getSessionsForReconciliation: () => Effect.succeed([]),
			listSessions: vi.fn(() => Effect.succeed([])),
			listSessionInfos: vi.fn(() => Effect.succeed([])),
			readSessionTranscript: vi.fn(() =>
				Effect.succeed({ messages: [], version: 0 }),
			),
			readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
			readSessionTranscriptPage: vi.fn(() =>
				Effect.succeed({
					messages: [
						{
							id: "user-1",
							session_id: "session-1",
							turn_id: "turn-1",
							role: "user" as const,
							text: "Earlier prompt",
							cost: null,
							tokens_in: null,
							tokens_out: null,
							tokens_cache_read: null,
							tokens_cache_write: null,
							context_window: null,
							version: 0,
							is_streaming: 0,
							is_backfilled: 0,
							created_at: 1,
							updated_at: 1,
							parts: [],
							modelExecution: {
								requestedModel: "sonnet",
								expectedModel: "claude-sonnet-5",
								actualModel: "claude-fable-4-0",
							},
						},
					],
					hasMore: false,
					version: 0,
				}),
			),
			readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
			getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
			countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
			readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
			getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
			getSessionHistoryMetadata: vi.fn(() => Effect.succeed({ messageCount: 0, cumulativeTokens: 0 })),
			getSessionMessagesWithParts: vi.fn(() =>
				Effect.succeed([
					{
						id: "user-1",
						session_id: "session-1",
						turn_id: "turn-1",
						role: "user",
						text: "Earlier prompt",
						cost: null,
						tokens_in: null,
						tokens_out: null,
						tokens_cache_read: null,
						tokens_cache_write: null,
						context_window: null,
						version: 0,
						is_streaming: 0,
						is_backfilled: 0,
						created_at: 1,
						updated_at: 1,
						parts: [],
						modelExecution: {
							requestedModel: "sonnet",
							expectedModel: "claude-sonnet-5",
							actualModel: "claude-fable-4-0",
						},
					},
				]),
			),
		} satisfies ReadQueryEffect;
		const layer = Layer.merge(
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ReadQueryEffectTag, readQuery),
		);

		return loadMoreHistoryForSession({
			sessionId: "session-1",
		}).pipe(
			Effect.provide(layer),
			Effect.tap((result) => {
				expect(result.messages[0]?.modelExecution).toEqual({
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5",
					actualModel: "claude-fable-4-0",
					drifted: true,
				});
				expect(result).toMatchObject({ hasMore: false });
				expect(result).not.toHaveProperty("total");
				expect(loadPreRenderedHistory).not.toHaveBeenCalled();
			}),
		);
	});
	}
});

describe("sendMessageToSession", () => {
	for (const [settled, snoozed] of [
		[true, false],
		[false, true],
		[false, false],
	] as const) {
		it.effect(
			`message clears triage state when settled=${settled}, snoozed=${snoozed}`,
			() => {
				const dbFile = join(
					tmpdir(),
					`conduit-prompt-triage-${crypto.randomUUID()}.sqlite`,
				);
				const ws = mockWsHandler();
				const configLayer = Layer.succeed(ConfigTag, mockConfig());
				const loggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
				const openCodeApi = makeMockOpenCodeAPI();
				const serviceLayer = Layer.provideMerge(
					SessionManagerServiceLive,
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, openCodeApi),
						loggerLayer,
						configLayer,
						Layer.succeed(WebSocketHandlerTag, ws),
						Layer.succeed(BackgroundLivenessTag, () => undefined),
						RelayStatusSnapshotLive,
						makeOverridesStateLive(),
						Layer.succeed(
	OpenCodeInstancesTag,
	makeOpenCodeInstancesStub({ opencode: openCodeApi }),
),
						makeSessionManagerStateLive(),
						PendingSendOwnershipLive,
						DaemonEventBusLive,
						makePersistenceEffectLayer(dbFile),
						Layer.succeed(
							OrchestrationEngineTag,
							new OrchestrationEngine({ registry: new ProviderRegistry() }),
						),
					),
				);
				return Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					const service = yield* SessionManagerServiceTag;
					yield* runner.markRecovered();
					yield* runner.projectEvent(
						yield* store.append(
							canonicalEvent(
								"session.created",
								"s1",
								{ sessionId: "s1", title: "Triage", provider: "opencode" },
								{ provider: "opencode", createdAt: 10 },
							),
						),
					);
					if (settled)
						yield* service.setSessionSettled("s1", {
							settled: true,
							automatic: true,
						});
					if (snoozed) yield* service.snoozeSession("s1", null);
					const provider: ProviderTurnService = {
						prepareTurnSession: (input) => Effect.succeed(input.sessionId),
						sendTurn: () =>
							Effect.gen(function* () {
								expect((yield* service.listSessions())[0]).not.toHaveProperty(
									"settledAt",
								);
								expect((yield* service.listSessions())[0]).not.toHaveProperty(
									"settledAutomatically",
								);
								expect((yield* service.listSessions())[0]).not.toHaveProperty(
									"snoozedAt",
								);
								const events = yield* store.readAllBySession("s1");
								expect(
									events.filter((e) => e.type === "session.unsettled"),
								).toHaveLength(settled ? 1 : 0);
								expect(
									events.filter((e) => e.type === "session.unsnoozed"),
								).toHaveLength(snoozed ? 1 : 0);
							}).pipe(Effect.orDie),
						interruptTurn: () => Effect.void,
					};
					yield* sendMessageToSession({
						clientId: "c1",
						sessionId: "s1",
						text: "Continue",
						commandId: "cmd1",
					}).pipe(Effect.provideService(ProviderTurnServiceTag, provider));
					expect(ws.broadcast).not.toHaveBeenCalled();
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							serviceLayer,
							Layer.succeed(WebSocketHandlerTag, ws),
							Layer.succeed(ConfigTag, mockConfig()),
							PendingInteractionServiceLive,
							makeOverridesStateLive(),
						),
					),
					Effect.ensuring(Effect.sync(() => rmSync(dbFile, { force: true }))),
				);
			},
		);
	}
	function makeLayer(
		ws: WebSocketHandlerShape,
		prepareTurnSession: ProviderTurnService["prepareTurnSession"],
		sendTurn: ProviderTurnService["sendTurn"] = () => Effect.void,
	) {
		const providerTurnService: ProviderTurnService = {
			prepareTurnSession,
			sendTurn,
			interruptTurn: vi.fn(() => Effect.void),
		};
		return Layer.mergeAll(
			Layer.succeed(ProviderTurnServiceTag, providerTurnService),
			Layer.succeed(OpenCodeAPITag, {} as OpenCodeAPI),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, mockLogger()),
			Layer.succeed(ConfigTag, mockConfig()),
			Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
			PendingInteractionServiceLive,
			PendingSendOwnershipLive,
			makeOverridesStateLive(),
		);
	}

	it.effect("sends the message when unsnooze bookkeeping fails", () => {
		const sendTurn = vi.fn(() => Effect.void);
		const provider: ProviderTurnService = {
			prepareTurnSession: (input) => Effect.succeed(input.sessionId),
			sendTurn,
			interruptTurn: () => Effect.void,
		};
		const service = makeMockSessionManagerService({
			unsnoozeSession: () =>
				Effect.fail(
					new SessionManagerError({
						operation: "unsnoozeSession",
						cause: new Error("write failed"),
					}),
				),
		});
		const layer = Layer.mergeAll(
			Layer.succeed(ProviderTurnServiceTag, provider),
			Layer.succeed(OpenCodeAPITag, {} as OpenCodeAPI),
			Layer.succeed(WebSocketHandlerTag, mockWsHandler()),
			Layer.succeed(LoggerTag, mockLogger()),
			Layer.succeed(ConfigTag, mockConfig()),
			Layer.succeed(SessionManagerServiceTag, service),
			PendingInteractionServiceLive,
			PendingSendOwnershipLive,
			makeOverridesStateLive(),
		);
		return sendMessageToSession({
			clientId: "c1",
			sessionId: "s1",
			text: "Continue",
			commandId: "cmd1",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => expect(sendTurn).toHaveBeenCalledOnce()),
		);
	});

	it.effect(
		"removes only the failed command on a propagated Effect failure",
		() => {
			const layer = makeLayer(
				mockWsHandler(),
				(input) => Effect.succeed(input.sessionId),
				(input) =>
					input.commandId === "failed"
						? Effect.fail(
								new ProviderStateEffectError({
									operation: "sendTurn",
									cause: "rejected",
								}),
							)
						: Effect.void,
			);
			return Effect.gen(function* () {
				for (const commandId of ["before", "failed", "after"]) {
					const exit = yield* Effect.exit(
						sendMessageToSession({
							clientId: commandId,
							originId: commandId,
							sessionId: "effect-failed",
							commandId,
							text: "ok",
						}),
					);
					expect(Exit.isFailure(exit)).toBe(commandId === "failed");
				}
				for (const [messageId, originId] of [
					["first", "before"],
					["second", "after"],
					["tui", undefined],
				]) {
					const event = translateMessageCreated(
						{
							type: "message.created",
							properties: {
								sessionID: "effect-failed",
								messageID: messageId,
								info: { role: "user", parts: [{ type: "text", text: "ok" }] },
							},
						},
						(yield* PendingSendOwnershipTag).resolve,
					);
					if (originId) expect(event).toMatchObject({ originId });
					else expect(event).not.toHaveProperty("originId");
				}
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"correlates provider user messages by session FIFO across SSE and polling",
		() => {
			const ws = mockWsHandler();
			const layer = makeLayer(ws, (input) => Effect.succeed(input.sessionId));
			return Effect.gen(function* () {
				for (const [sessionId, originId, commandId] of [
					["fifo-a", "browser-1", "fifo-command-1"],
					["fifo-b", "browser-3", "fifo-command-3"],
					["fifo-a", "browser-2", "fifo-command-2"],
				] as const) {
					yield* sendMessageToSession({
						clientId: originId,
						sessionId,
						originId,
						commandId,
						text: "ok",
					});
				}
				const event = {
					type: "message.created",
					properties: {
						sessionID: "fifo-a",
						messageID: "msg-first",
						info: { role: "user", parts: [{ type: "text", text: "ok" }] },
					},
				};
				expect(
					translateMessageCreated(
						event,
						(yield* PendingSendOwnershipTag).resolve,
					),
				).toMatchObject({
					messageId: "msg-first",
					originId: "browser-1",
				});
				expect(
					translateMessageCreated(
						event,
						(yield* PendingSendOwnershipTag).resolve,
					),
				).toMatchObject({
					messageId: "msg-first",
					originId: "browser-1",
				});
				const { events } = diffAndSynthesize(
					new Map(),
					[
						{
							id: "msg-first",
							sessionID: "fifo-a",
							role: "user",
							parts: [{ id: "part-1", type: "text", text: "ok" }],
						},
						{
							id: "msg-second",
							sessionID: "fifo-a",
							role: "user",
							parts: [{ id: "part-2", type: "text", text: "ok" }],
						},
						{
							id: "msg-third",
							sessionID: "fifo-b",
							role: "user",
							parts: [{ id: "part-3", type: "text", text: "ok" }],
						},
					],
					(yield* PendingSendOwnershipTag).resolve,
				);
				expect(events).toEqual([
					{
						type: "user_message",
						text: "ok",
						messageId: "msg-first",
						originId: "browser-1",
					},
					{
						type: "user_message",
						text: "ok",
						messageId: "msg-second",
						originId: "browser-2",
					},
					{
						type: "user_message",
						text: "ok",
						messageId: "msg-third",
						originId: "browser-3",
					},
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"drops a stale FIFO owner on different text across SSE and polling",
		() => {
			const layer = makeLayer(mockWsHandler(), (input) =>
				Effect.succeed(input.sessionId),
			);
			return Effect.gen(function* () {
				for (const transport of ["sse", "poll"] as const) {
					const sessionId = `stale-${transport}`;
					for (const [commandId, text] of [
						["stale", "unsent"],
						["next", "TUI text"],
					] as const) {
						yield* sendMessageToSession({
							clientId: "browser",
							originId: "browser",
							sessionId,
							commandId,
							text,
						});
					}
					const providerMessage = {
						id: "foreign",
						sessionID: sessionId,
						role: "user" as const,
						parts: [{ id: "p", type: "text" as const, text: "TUI text" }],
					};
					const event = {
						type: "message.created",
						properties: {
							sessionID: sessionId,
							messageID: "foreign",
							info: providerMessage,
						},
					};
					const first =
						transport === "sse"
							? translateMessageCreated(
									event,
									(yield* PendingSendOwnershipTag).resolve,
								)
							: diffAndSynthesize(
									new Map(),
									[providerMessage],
									(yield* PendingSendOwnershipTag).resolve,
								).events[0];
					expect(first).toEqual({
						type: "user_message",
						messageId: "foreign",
						text: "TUI text",
					});
					expect(
						translateMessageCreated(
							event,
							(yield* PendingSendOwnershipTag).resolve,
						),
					).not.toHaveProperty("originId");
					expect(
						diffAndSynthesize(
							new Map(),
							[providerMessage],
							(yield* PendingSendOwnershipTag).resolve,
						).events[0],
					).not.toHaveProperty("originId");
					expect(
						translateMessageCreated(
							{
								...event,
								properties: { ...event.properties, messageID: "next" },
							},
							(yield* PendingSendOwnershipTag).resolve,
						),
					).toMatchObject({ originId: "browser", messageId: "next" });
				}
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"still attributes same-text TUI messages when an unobservable failed send left an owner",
		() => {
			const layer = makeLayer(mockWsHandler(), (input) =>
				Effect.succeed(input.sessionId),
			);
			return Effect.gen(function* () {
				yield* sendMessageToSession({
					clientId: "browser",
					originId: "browser",
					sessionId: "same-text-stale",
					commandId: "unsent",
					text: "ok",
				});
				expect(
					translateMessageCreated(
						{
							type: "message.created",
							properties: {
								sessionID: "same-text-stale",
								messageID: "tui",
								info: { role: "user", parts: [{ type: "text", text: "ok" }] },
							},
						},
						(yield* PendingSendOwnershipTag).resolve,
					),
				).toMatchObject({ originId: "browser", messageId: "tui" });
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"omits originId when preparing the turn changes the session id",
		() => {
			const ws = mockWsHandler({
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const layer = makeLayer(
				ws,
				vi.fn(() => Effect.succeed("session-new")),
			);

			return sendMessageToSession({
				clientId: "client-1",
				sessionId: "session-old",
				text: "first message",
				originId: "origin-1",
				commandId: "command-1",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "user_message",
						sessionId: "session-new",
						text: "first message",
					});
				}),
			);
		},
	);

	it.effect(
		"preserves originId when preparing the turn keeps the session id",
		() => {
			const ws = mockWsHandler({
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const layer = makeLayer(
				ws,
				vi.fn((input) => Effect.succeed(input.sessionId)),
			);

			return sendMessageToSession({
				clientId: "client-1",
				sessionId: "session-1",
				text: "next message",
				originId: "origin-1",
				commandId: "command-2",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "user_message",
						sessionId: "session-1",
						text: "next message",
						originId: "origin-1",
					});
				}),
			);
		},
	);
});

describe("cancelSessionById", () => {
	it.effect("delegates cancellation to ProviderTurnService", () => {
		const providerTurnService: ProviderTurnService = {
			prepareTurnSession: vi.fn((input) => Effect.succeed(input.sessionId)),
			sendTurn: vi.fn(() => Effect.void),
			interruptTurn: vi.fn(() => Effect.void),
		};

		const layer = Layer.mergeAll(
			Layer.succeed(ProviderTurnServiceTag, providerTurnService),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* cancelSessionById("client-1", "session-1", "cmd-cancel-test");

			expect(providerTurnService.interruptTurn).toHaveBeenCalledWith({
				clientId: "client-1",
				commandId: "cmd-cancel-test",
				sessionId: "session-1",
			});
		}).pipe(Effect.provide(layer));
	});
});

describe("rewindSessionToMessage", () => {
	it.effect("reverts to a specific message", () => {
		const log = mockLogger();
		const client = makeHandlerOpenCodeAPI({
			session: {
				messages: vi.fn(async () => [makeMessage({ id: "msg-1" })]),
				revert: vi.fn(async () => {}),
			},
		});

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(LoggerTag, log),
		);

		return rewindSessionToMessage({
			clientId: "client-1",
			sessionId: "session-1",
			messageId: "msg-1",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.session.revert).toHaveBeenCalledWith("session-1", {
					messageID: "msg-1",
				});
				expect(log.info).toHaveBeenCalled();
			}),
		);
	});
});

describe("handleMessage", () => {
	it.effect("logs, without a browser error, when no active session", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const log = mockLogger();
		const sessionManagerService = makeMockSessionManagerService();
		const config = mockConfig();
		const client = makeHandlerOpenCodeAPI();

		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				makeOverridesStateLive(),
			),
		);

		return handleMessage("client-1", {
			text: "hello",
			commandId: "cmd-no-session",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("no active session"),
				);
				expect(ws.sendTo).not.toHaveBeenCalled();
			}),
		);
	});

	it.effect("does nothing when text is empty", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const sessionManagerService = makeMockSessionManagerService();
		const config = mockConfig();
		const client = makeHandlerOpenCodeAPI();

		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				makeOverridesStateLive(),
			),
		);

		return handleMessage("client-1", { text: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).not.toHaveBeenCalled();
				expect(ws.sendToSession).not.toHaveBeenCalled();
			}),
		);
	});

	it.effect("passes contextWindow override into engine send_turn input", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1"]),
		});
		const log = mockLogger();
		const sessionManagerService = makeMockSessionManagerService();
		const config = mockConfig();
		const client = makeHandlerOpenCodeAPI();
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch: vi.fn(async () => ({
				status: "completed",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			})),
		});

		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			),
		);

		return Effect.gen(function* () {
			yield* setModel("session-1", {
				providerID: "claude",
				modelID: "sonnet",
			});
			yield* setContextWindow("session-1", "1m");
			yield* handleMessage("client-1", {
				text: "hello world",
				commandId: "cmd-context-window",
			});
			yield* flushDispatchContinuation();
			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					providerId: "claude",
					input: expect.objectContaining({
						contextWindow: "1m",
					}),
				}),
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"builds Claude event sinks from PendingInteractionService without bridge tags",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const sessionManagerService = makeMockSessionManagerService();
			const config = mockConfig();
			const client = makeHandlerOpenCodeAPI();
			let questionPromise: Promise<Record<string, unknown>> | undefined;
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async (command) => {
					if (
						typeof command === "object" &&
						command !== null &&
						"type" in command &&
						command.type === "send_turn"
					) {
						questionPromise = Effect.runPromise(
							command.input.eventSink.requestQuestion({
								requestId: "que-service-1",
								questions: [
									{
										question: "Continue?",
										header: "Confirm",
										options: [{ label: "Yes", description: "Continue" }],
										multiSelect: false,
										custom: true,
									},
								],
							}),
						);
					}
					return {
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					};
				}),
			});

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					Layer.succeed(ConfigTag, config),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					// Production always supplies ProviderRuntimeIngestion for Claude output
					// (relay-stack builds it from the daemon's always-present persistence
					// DB). cev.3 makes the seam mandatory, so the Claude event sink needs
					// it present to avoid the failing guard sink.
					Layer.succeed(ProviderRuntimeIngestionTag, {
						ingest: () => Effect.succeed(0),
						ingestBatch: () => Effect.succeed(0),
						drain: () => Effect.void,
					}),
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "sonnet",
				});
				yield* handleMessage("client-1", {
					text: "hello world",
					commandId: "cmd-pending-question",
				});
				yield* flushDispatchContinuation();
				const pendingInteractions = yield* PendingInteractionServiceTag;
				const pendingQuestions =
					yield* pendingInteractions.listPendingQuestions("session-1");
				expect(pendingQuestions).toEqual([
					expect.objectContaining({
						requestId: "que-service-1",
						sessionId: "session-1",
					}),
				]);
				yield* pendingInteractions.resolveQuestionRequest("que-service-1", {
					"0": "Yes",
				});
				yield* Effect.tryPromise(() => questionPromise ?? Promise.resolve({}));
			}).pipe(Effect.provide(layer));
		},
	);

		it.effect(
			"passes Claude history metadata without a transcript into send_turn input",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const sessionManagerService = makeMockSessionManagerService();
			const config = mockConfig();
			const client = makeHandlerOpenCodeAPI();
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			});
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getSession: vi.fn(() => Effect.succeed(undefined)),
				getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
				getSessionsForReconciliation: () => Effect.succeed([]),
				listSessions: vi.fn(() => Effect.succeed([])),
				listSessionInfos: vi.fn(() => Effect.succeed([])),
				readSessionTranscript: vi.fn(() =>
					Effect.succeed({ messages: [], version: 0 }),
				),
				readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				readSessionTranscriptPage: vi.fn(() =>
					Effect.succeed({ messages: [], hasMore: false, version: 0 }),
				),
				readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
				countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
				readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
					getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
					getSessionHistoryMetadata: vi.fn(() =>
						Effect.succeed({ messageCount: 1, cumulativeTokens: 42 }),
					),
			} satisfies ReadQueryEffect;

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					Layer.succeed(ConfigTag, config),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
					Layer.succeed(ReadQueryEffectTag, readQuery),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "sonnet",
				});
				yield* handleMessage("client-1", {
					text: "new prompt",
					commandId: "cmd-sqlite-history",
				});
				expect(readQuery.getSessionHistoryMetadata).toHaveBeenCalledWith(
					"session-1",
				);
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							history: [],
							cumulativeTokens: 42,
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"does not run legacy session-manager auto-rename after first Claude turn",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy auto-rename listSessions should not be used");
			});
			const legacyRenameSession = vi.fn(async () => {
				throw new Error("legacy auto-rename renameSession should not be used");
			});
			const _sessionMgr = mockSessionManager({
				listSessions: legacyListSessions,
				renameSession: legacyRenameSession,
			});
			const listSessions = vi.fn(() =>
				Effect.succeed([
					{
						id: "session-1",
						title: "Untitled",
						status: "idle" as const,
						updatedAt: 100,
						messageCount: 0,
					},
				]),
			);
			const renameSession = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				listSessions,
				renameSession,
			});
			const config = mockConfig();
			const client = makeHandlerOpenCodeAPI();
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [{ key: "turnCount", value: 1 }],
				})),
			});

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					Layer.succeed(ConfigTag, config),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", {
					text: "First prompt",
					commandId: "cmd-first-prompt",
				});
				yield* flushDispatchContinuation();

				expect(listSessions).not.toHaveBeenCalled();
				expect(renameSession).not.toHaveBeenCalled();
				expect(ws.broadcast).not.toHaveBeenCalled();
				expect(legacyListSessions).not.toHaveBeenCalled();
				expect(legacyRenameSession).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("does not inspect custom titles during prompt dispatch", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1"]),
		});
		const log = mockLogger();
		const _sessionMgr = mockSessionManager();
		const listSessions = vi.fn(() =>
			Effect.succeed([
				{
					id: "session-1",
					title: "User named this",
					status: "idle" as const,
					updatedAt: 100,
					messageCount: 0,
				},
			]),
		);
		const renameSession = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			listSessions,
			renameSession,
		});
		const config = mockConfig();
			const client = makeHandlerOpenCodeAPI();
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch: vi.fn(async () => ({
				status: "completed",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [{ key: "turnCount", value: 1 }],
			})),
		});

		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			),
		);

		return Effect.gen(function* () {
			yield* handleMessage("client-1", {
				text: "First prompt",
				commandId: "cmd-first-prompt-title",
			});
			yield* flushDispatchContinuation();

			expect(listSessions).not.toHaveBeenCalled();
			expect(renameSession).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"materializes an empty local session before sending an OpenCode-selected first prompt",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "ses-local-placeholder"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const serviceCreateSession = vi.fn(() =>
				Effect.succeed({
					id: "ses-opencode-created",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Untitled",
					version: "1.0.0",
					time: { created: 100, updated: 100 },
					providerID: "opencode",
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				createSession: serviceCreateSession,
			});
			const config = mockConfig();
			const client = makeHandlerOpenCodeAPI();
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("idle")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "ses-local-placeholder",
						provider: "claude",
						provider_sid: null,
						version: 0,
						title: "Untitled",
						status: "idle",
						parent_id: null,
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
					}),
				),
				getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
				getSessionsForReconciliation: () => Effect.succeed([]),
				listSessions: vi.fn(() => Effect.succeed([])),
				listSessionInfos: vi.fn(() => Effect.succeed([])),
				readSessionTranscript: vi.fn(() =>
					Effect.succeed({ messages: [], version: 0 }),
				),
				readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				readSessionTranscriptPage: vi.fn(() =>
					Effect.succeed({ messages: [], hasMore: false, version: 0 }),
				),
				readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
				countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
				readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
				getSessionHistoryMetadata: vi.fn(() => Effect.succeed({ messageCount: 0, cumulativeTokens: 0 })),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed(undefined)),
				bindSession: vi.fn(),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			});

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					Layer.succeed(ConfigTag, config),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
					Layer.succeed(ReadQueryEffectTag, readQuery),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* setModel("ses-local-placeholder", {
					providerID: "opencode",
					modelID: "big-pickle",
				});

				const dispatchedSessionId = yield* sendMessageToSession({
					clientId: "client-1",
					sessionId: "ses-local-placeholder",
					text: "Test query",
					commandId: "cmd-materialize-opencode",
				});
				yield* flushDispatchContinuation();
				expect(dispatchedSessionId).toBe("ses-opencode-created");

				expect(serviceCreateSession).toHaveBeenCalledWith("Untitled", {
					providerId: "opencode",
				});
				expect(engine.bindSession).toHaveBeenCalledWith(
					"ses-opencode-created",
					"opencode",
				);
				expect(ws.setClientSession).toHaveBeenCalledWith(
					"client-1",
					"ses-opencode-created",
				);
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "opencode",
						input: expect.objectContaining({
							sessionId: "ses-opencode-created",
							prompt: "Test query",
							model: {
								providerId: "opencode",
								modelId: "big-pickle",
							},
						}),
					}),
				);
				expect(engine.dispatchEffect).not.toHaveBeenCalledWith(
					expect.objectContaining({
						input: expect.objectContaining({
							sessionId: "ses-local-placeholder",
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"keeps dispatch rejection recovery after launching continuation",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const _sessionMgr = mockSessionManager();
			const sessionManagerService = makeMockSessionManagerService();
			const config = mockConfig();
			const client = makeHandlerOpenCodeAPI();
			const dispatchError = new Error("dispatch failed");
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async (command: { readonly type: string }) => {
					if (command.type === "discover") {
						return {
							models: [{ id: "opus", name: "Opus", providerId: "claude" }],
						};
					}
					throw dispatchError;
				}),
			});

			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					Layer.succeed(ConfigTag, config),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* sendMessageToSession({
					clientId: "client-1",
					originId: "browser-rejected",
					sessionId: "session-rejected",
					text: "First prompt",
					commandId: "cmd-dispatch-rejection",
				});
				yield* flushDispatchContinuation();
				expect(
					translateMessageCreated(
						{
							type: "message.created",
							properties: {
								sessionID: "session-rejected",
								messageID: "tui-after-rejection",
								info: {
									role: "user",
									parts: [{ type: "text", text: "First prompt" }],
								},
							},
						},
						(yield* PendingSendOwnershipTag).resolve,
					),
				).not.toHaveProperty("originId");

				expect(yield* hasActiveProcessingTimeout("session-rejected")).toBe(
					false,
				);
				// The failure is recorded as the turn's error; the relay's failed
				// `done` idles the composer from there.
				const sql = yield* SqlClient.SqlClient;
				const failures = yield* sql<{ code: string; error: string }>`
					SELECT json_extract(data, '$.code') AS code,
						json_extract(data, '$.error') AS error
					FROM events
					WHERE session_id = 'session-rejected' AND type = 'turn.error'`;
				expect(failures).toEqual([
					{ code: "SEND_FAILED", error: expect.any(String) },
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("clears ownership when model discovery prevents dispatch", () => {
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch: vi.fn(async () => ({ models: [] })),
		});
		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, {} as OpenCodeAPI),
			Layer.succeed(WebSocketHandlerTag, mockWsHandler()),
			Layer.succeed(LoggerTag, mockLogger()),
			Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
			Layer.succeed(ConfigTag, mockConfig()),
			Layer.succeed(OrchestrationEngineTag, engine),
			PendingInteractionServiceLive,
			PendingSendOwnershipLive,
			makeOverridesStateLive(),
			),
		);
		return Effect.gen(function* () {
			yield* sendMessageToSession({
				clientId: "browser",
				originId: "browser",
				sessionId: "no-model",
				commandId: "no-model-command",
				text: "ok",
			});
			expect(
				translateMessageCreated(
					{
						type: "message.created",
						properties: {
							sessionID: "no-model",
							messageID: "tui",
							info: { role: "user", parts: [{ type: "text", text: "ok" }] },
						},
					},
					(yield* PendingSendOwnershipTag).resolve,
				),
			).not.toHaveProperty("originId");
		}).pipe(Effect.provide(layer));
	});


});

});

// A failed save fails toward unread: the caller gets the typed error, the
// failure is logged, and nothing retries it (conduit-test-hk9m.6).
describe("markSessionSeenForClient", () => {
	it.effect(
		"returns a failed save as a typed error, logged once, not retried",
		() => {
			const ws = mockWsHandler();
			const log = mockLogger();
			const failure = new SessionManagerError({
				operation: "markSessionSeen",
				cause: new Error("SQLITE_BUSY"),
			});
			const sessionManagerService = makeMockSessionManagerService({
				markSessionSeen: vi.fn(() => Effect.fail(failure)),
			});

			return markSessionSeenForClient({
				clientId: "client-1",
				sessionId: "session-1",
				upTo: 4,
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(WebSocketHandlerTag, ws),
						Layer.succeed(LoggerTag, log),
						Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					),
				),
				Effect.flip,
				Effect.tap((error) => {
					expect(error).toBe(failure);
					expect(sessionManagerService.markSessionSeen).toHaveBeenCalledOnce();
					expect(log.warn).toHaveBeenCalledOnce();
					expect(log.warn).toHaveBeenCalledWith(
						expect.stringContaining("session-1"),
						failure,
					);
					expect(ws.broadcast).not.toHaveBeenCalled();
				}),
			);
		},
	);
});
