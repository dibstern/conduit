import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
// ─── Effect Handler Tests (Batch 1) ─────────────────────────────────────────
// Verifies that the Effect handler implementations produce the expected
// observable side effects when run against a mock
// Layer. Each test provides minimal mock services via Layer.succeed, runs
// the Effect to completion, and asserts on captured calls.

import { describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProjectManagementServiceLive } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import type {
	SessionManagerShape,
	WebSocketHandlerShape,
} from "../../../src/lib/domain/relay/Services/services.js";
// Batch 2 imports
import {
	ConfigTag,
	LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionManagerError,
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	getAgent,
	getContextWindow,
	getModel,
	getVariant,
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	setAgent,
	setContextWindow,
	setDefaultContextWindow,
	setDefaultModel,
	setModel,
	setVariant,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	type OpenCodeTerminalService,
	OpenCodeTerminalServiceTag,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import {
	ToolContentServiceLive,
	ToolContentServiceNoop,
} from "../../../src/lib/domain/relay/Services/tool-content-service.js";
import {
	filterAgents,
	handleGetAgents,
} from "../../../src/lib/handlers/agent.js";
import { handleSwitchContextWindow } from "../../../src/lib/handlers/context-window.js";
import {
	handleGetFileContent,
	handleGetFileList,
} from "../../../src/lib/handlers/files.js";
import {
	sendModelsStateToClient,
	switchModelForSession,
	switchVariantForSession,
} from "../../../src/lib/handlers/model.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import {
	cancelSessionById,
	handleMessage,
	rewindSessionToMessage,
	syncInputDraftForSession,
} from "../../../src/lib/handlers/prompt.js";
import { reloadProviderSessionForClient } from "../../../src/lib/handlers/reload.js";
import {
	handleDeleteSession,
	handleForkSession,
	handleNewSession,
	loadMoreHistoryForSession,
	renameSessionForClient,
	viewSessionForClient,
} from "../../../src/lib/handlers/session.js";
import {
	handleGetCommands,
	handleGetProjects,
} from "../../../src/lib/handlers/settings.js";
import { handlePtyInput } from "../../../src/lib/handlers/terminal.js";
import { handleGetToolContent } from "../../../src/lib/handlers/tool-content.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { PermissionId, RequestId } from "../../../src/lib/shared-types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import {
	makeMockSessionManagerService,
	makeMockStatusPoller,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

// ─── Mock factories ────────────────────────────────────────────────────────

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
		handleUpgrade: vi.fn(),
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
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

function openCodeFileLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.merge(
		apiLayer,
		OpenCodeFileServiceLive.pipe(Layer.provide(apiLayer)),
	);
}

function openCodeModelLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.merge(
		apiLayer,
		OpenCodeModelServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					apiLayer,
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
	return {
		opencodeUrl: "http://localhost:3000",
		slug: "test-project",
		projectDir: "/tmp/test",
		configDir: "/tmp/test-config",
		...overrides,
	} as unknown as ProjectRelayConfig;
}

// ─── Agent handler tests ───────────────────────────────────────────────────

describe("handleGetAgents", () => {
	it.effect(
		"fetches agents via OpenCodeAPI and sends filtered list to client",
		() => {
			const ws = mockWsHandler();
			const mockAgents = [
				{ name: "build", id: "build", mode: "primary" as const },
				{ name: "title", id: "title", mode: "subagent" as const, hidden: true },
				{ name: "plan", id: "plan", mode: "all" as const },
			];
			const client = {
				app: { agents: vi.fn(async () => mockAgents) },
			} as unknown as OpenCodeAPI;

			return handleGetAgents("client-1", {}).pipe(
				Effect.provide(makeTestHandlerLayer({ api: client, wsHandler: ws })),
				Effect.tap(() => {
					expect(client.app.agents).toHaveBeenCalledOnce();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "agent_list",
						providerScope: { id: "opencode", name: "OpenCode" },
						agents: filterAgents(mockAgents),
					});
				}),
			);
		},
	);
});

// ─── Settings handler tests ────────────────────────────────────────────────

describe("handleGetCommands", () => {
	it.effect("fetches commands and sends to client", () => {
		const ws = mockWsHandler();
		const mockCommands = [{ name: "test" }];
		const client = {
			app: { commands: vi.fn(async () => mockCommands) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetCommands("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.app.commands).toHaveBeenCalledOnce();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "command_list",
					commands: mockCommands,
				});
			}),
		);
	});
});

describe("handleGetProjects", () => {
	it.effect("uses config.getProjects when available", () => {
		const ws = mockWsHandler();
		const projects = [
			{ slug: "proj-1", title: "Project 1", directory: "/path" },
		];
		const config = mockConfig({
			getProjects: () => projects,
		});
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			projectManagementLayer(client, config),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetProjects("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "project_list",
					projects,
					current: "test-project",
				});
			}),
		);
	});

	it.effect(
		"falls back to client.app.projects when getProjects is not available",
		() => {
			const ws = mockWsHandler();
			const config = mockConfig();
			const client = {
				app: {
					projects: vi.fn(async () => [
						{ id: "p1", name: "Proj 1", path: "/proj1" },
					]),
				},
			} as unknown as OpenCodeAPI;

			const layer = Layer.mergeAll(
				projectManagementLayer(client, config),
				Layer.succeed(WebSocketHandlerTag, ws),
			);

			return handleGetProjects("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.app.projects).toHaveBeenCalledOnce();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "project_list",
						projects: [{ slug: "p1", title: "Proj 1", directory: "/proj1" }],
						current: "test-project",
					});
				}),
			);
		},
	);
});

// ─── File handler tests ────────────────────────────────────────────────────

describe("handleGetFileContent", () => {
	it.effect("reads file content and sends to client", () => {
		const ws = mockWsHandler();
		const client = {
			file: {
				read: vi.fn(async () => ({ content: "hello world" })),
			},
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			openCodeFileLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetFileContent("client-1", { path: "README.md" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.file.read).toHaveBeenCalledWith("README.md");
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "file_content",
					path: "README.md",
					content: "hello world",
				});
			}),
		);
	});

	it.effect("does nothing when path is empty", () => {
		const ws = mockWsHandler();
		const client = {
			file: { read: vi.fn() },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			openCodeFileLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetFileContent("client-1", { path: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.file.read).not.toHaveBeenCalled();
				expect(ws.sendTo).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleGetFileList", () => {
	it.effect("lists files and filters with gitignore rules", () => {
		const ws = mockWsHandler();
		const client = {
			file: {
				list: vi.fn(async () => [
					{ name: "src", type: "directory" },
					{ name: ".git", type: "directory" },
					{ name: "README.md", type: "file" },
				]),
				read: vi.fn(async () => ({ content: "" })),
			},
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			openCodeFileLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetFileList("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "file_list",
					path: ".",
					entries: [
						{ name: "src", type: "directory" },
						{ name: "README.md", type: "file" },
					],
				});
			}),
		);
	});
});

// ─── Reload handler tests ──────────────────────────────────────────────────

describe("reloadProviderSessionForClient", () => {
	it.effect("reloads provider session and refreshes models/commands", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const log = mockLogger();
		const engine = {
			dispatch: vi.fn(async () => ({ models: [] })),
			bindSession: vi.fn(),
		} as unknown as OrchestrationEngine;
		const client = {
			provider: {
				list: vi.fn(async () => ({
					connected: [],
					providers: [],
				})),
			},
			app: {
				commands: vi.fn(async () => []),
			},
		} as unknown as OpenCodeAPI;
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
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				// Should have dispatched end_session
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "end_session",
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

// ─── Model handler tests ──────────────────────────────────────────────────

describe("sendModelsStateToClient", () => {
	it.effect("fetches providers and sends model_list to client", () => {
		const ws = mockWsHandler();
		const engine = {
			dispatch: vi.fn(async () => ({ models: [] })),
		} as unknown as OrchestrationEngine;
		const client = {
			provider: {
				list: vi.fn(async () => ({
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
		} as unknown as OpenCodeAPI;
		const log = mockLogger();

		const layer = Layer.mergeAll(
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return sendModelsStateToClient("client-1").pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.provider.list).toHaveBeenCalledOnce();
				// Verify model_list was sent with correct providers
				expect(ws.sendTo).toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({
						type: "model_list",
						providers: expect.arrayContaining([
							expect.objectContaining({ id: "openai" }),
						]),
					}),
				);
			}),
		);
	});

	it.effect(
		"includes variants and contextWindowOptions in claude provider entries in model_list",
		() => {
			const ws = mockWsHandler();
			const engine = {
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
			} as unknown as OrchestrationEngine;
			const client = {
				provider: {
					list: vi.fn(async () => ({
						connected: [],
						providers: [],
					})),
				},
				session: { get: vi.fn() },
			} as unknown as OpenCodeAPI;
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return sendModelsStateToClient("client-1").pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith(
						"client-1",
						expect.objectContaining({
							type: "model_list",
							providers: [
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
							],
						}),
					);
				}),
			);
		},
	);
	it.effect(
		"sends Claude models when OpenCode provider discovery fails",
		() => {
			const ws = mockWsHandler();
			const engine = {
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
						},
					],
				})),
			} as unknown as OrchestrationEngine;
			const client = {
				provider: {
					list: vi.fn(async () => {
						throw new Error("opencode offline");
					}),
				},
				session: { get: vi.fn() },
			} as unknown as OpenCodeAPI;
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return sendModelsStateToClient("client-1").pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
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
				}),
			);
		},
	);
	it.effect(
		"sends context_window_info for active Claude model during model refresh",
		() => {
			const contextWindowOptions = [
				{ value: "200k", label: "200K", isDefault: true },
				{ value: "1m", label: "1M (beta)" },
			];
			const ws = mockWsHandler();
			const engine = {
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-opus-4-7",
							name: "Claude Opus 4.7",
							providerId: "claude",
							contextWindowOptions,
						},
					],
				})),
			} as unknown as OrchestrationEngine;
			const client = {
				provider: {
					list: vi.fn(async () => ({
						connected: [],
						providers: [],
					})),
				},
				session: { get: vi.fn() },
			} as unknown as OpenCodeAPI;
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "claude",
					modelID: "claude-opus-4-7",
				});
				yield* setDefaultContextWindow("1m");
				yield* sendModelsStateToClient("client-1");
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "context_window_info",
					contextWindow: "1m",
					options: contextWindowOptions,
				});
			}).pipe(Effect.provide(layer));
		},
	);
	it.effect(
		"keeps OpenCode discovery while skipping session lookup for a Claude-bound model refresh",
		() => {
			const ws = mockWsHandler();
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-opus-4-7",
							name: "Claude Opus 4.7",
							providerId: "claude",
						},
					],
				})),
			} as unknown as OrchestrationEngine;
			const client = {
				provider: {
					list: vi.fn(async () => ({
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
			} as unknown as OpenCodeAPI;
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
				yield* sendModelsStateToClient("client-1", "session-1");

				expect(client.provider.list).toHaveBeenCalledOnce();
				expect(client.session.get).not.toHaveBeenCalled();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "model_list",
					providers: [
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
					],
				});
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "model_info",
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
		const engine = {
			dispatch: vi.fn(async () => ({ models: [] })),
			bindSession: vi.fn(),
		} as unknown as OrchestrationEngine;
		const client = {
			provider: {
				list: vi.fn(async () => ({
					providers: [],
				})),
			},
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
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
			const engine = {
				dispatch: vi.fn(async () => ({ models: [] })),
				bindSession: vi.fn(),
				unbindSession: vi.fn(),
			} as unknown as OrchestrationEngine;
			const client = {
				provider: {
					list: vi.fn(async () => ({
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
			} as unknown as OpenCodeAPI;
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("idle")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "ses-local-placeholder",
						provider: "claude",
						provider_sid: null,
						title: "Untitled",
						status: "idle",
						parent_id: null,
						fork_point_event: null,
						last_message_at: null,
						created_at: 1,
						updated_at: 1,
					}),
				),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* switchModelForSession({
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
				expect(ws.sendToSession).toHaveBeenCalledWith("ses-local-placeholder", {
					type: "variant_info",
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
		const engine = {
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
		} as unknown as OrchestrationEngine;
		const client = {
			provider: {
				list: vi.fn(async () => ({
					connected: [],
					providers: [],
				})),
			},
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
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
			expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
				type: "variant_info",
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
		const engine = {
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
		} as unknown as OrchestrationEngine;
		const client = {
			provider: {
				list: vi.fn(async () => ({
					connected: [],
					providers: [],
				})),
			},
		} as unknown as OpenCodeAPI;
		const log = mockLogger();
		const config = mockConfig({
			configDir: `/tmp/conduit-switch-variant-claude-${Date.now()}`,
		});

		const layer = Layer.mergeAll(
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* setModel("session-42", {
				providerID: "claude",
				modelID: "claude-opus-4-7",
			});
			yield* switchVariantForSession({
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
			expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
				type: "variant_info",
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
			const client = {
				provider: {
					list: vi.fn(async () => ({
						connected: ["openai"],
						providers: [
							{
								id: "openai",
								name: "OpenAI",
								models: [{ id: "gpt-4", variants: { v2: {}, v3: {} } }],
							},
						],
					})),
				},
			} as unknown as OpenCodeAPI;
			const log = mockLogger();
			const config = mockConfig({
				configDir: `/tmp/conduit-switch-variant-opencode-${Date.now()}`,
			});

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-42", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				yield* switchVariantForSession({
					clientId: "client-1",
					sessionId: "session-42",
					variant: "v2",
				});
				expect(yield* getVariant("session-42")).toBe("v2");
				expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
					type: "variant_info",
					variant: "v2",
					variants: ["v2", "v3"],
				});
			}).pipe(Effect.provide(layer));
		},
	);
});

describe("handleSwitchContextWindow", () => {
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
			const engine = {
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
			} as unknown as OrchestrationEngine;
			const log = mockLogger();

			const layer = Layer.mergeAll(
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
				yield* handleSwitchContextWindow("client-1", {
					contextWindow: "1m",
				});
				expect(yield* getContextWindow("session-42")).toBe("1m");
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
					type: "context_window_info",
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
			const engine = {
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-haiku-4-7",
							name: "Claude Haiku 4.7",
							providerId: "claude",
						},
					],
				})),
			} as unknown as OrchestrationEngine;
			const log = mockLogger();

			const layer = Layer.mergeAll(
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
				yield* handleSwitchContextWindow("client-1", {
					contextWindow: "1m",
				});
				expect(yield* getContextWindow("session-42")).toBe("200k");
				expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
					type: "context_window_info",
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

// ─── Additional mock factories for batch 2 ────────────────────────────────

function mockSessionManager(
	overrides?: Partial<SessionManagerShape>,
): SessionManagerShape {
	return {
		createSession: vi.fn(async () => ({ id: "new-session-1", title: "" })),
		deleteSession: vi.fn(async () => {}),
		renameSession: vi.fn(async () => {}),
		listSessions: vi.fn(async () => []),
		searchSessions: vi.fn(async () => []),
		loadPreRenderedHistory: vi.fn(async () => ({
			messages: [],
			hasMore: false,
		})),
		sendDualSessionLists: vi.fn(async () => {}),
		recordMessageActivity: vi.fn(),
		clearPaginationCursor: vi.fn(),
		decrementPendingQuestionCount: vi.fn(),
		...overrides,
	} as unknown as SessionManagerShape;
}

function mockTerminalService(
	overrides?: Partial<OpenCodeTerminalService>,
): OpenCodeTerminalService {
	return {
		create: vi.fn(() => Effect.void),
		list: vi.fn(() => Effect.succeed([])),
		replay: vi.fn(() => Effect.void),
		sendInput: vi.fn(() => Effect.void),
		close: vi.fn(() => Effect.void),
		resize: vi.fn(() => Effect.void),
		...overrides,
	};
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
		({
			session: {
				fork: vi.fn(async () => ({
					id: "ses-child",
					title: "Forked Session",
					time: { created: 200, updated: 201 },
				})),
				message: vi.fn(async () => ({ time: { created: 123 } })),
				messagesPage: vi.fn(async () => [{ id: "msg-last" }]),
				get: vi.fn(async () => ({})),
			},
			permission: { list: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI);
	const ws = options?.ws ?? mockWsHandler();
	const _sessionMgr = options?.sessionMgr ?? mockSessionManager();
	const sessionManagerService =
		options?.sessionManagerService ?? makeMockSessionManagerService();
	const log = options?.log ?? mockLogger();

	return Layer.mergeAll(
		openCodeModelLayer(client),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
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
		({
			session: {
				get: vi.fn(async () => ({})),
			},
			permission: { list: vi.fn(async () => []) },
			question: { list: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI);
	const log = options?.log ?? mockLogger();

	return Layer.mergeAll(
		openCodeModelLayer(client),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
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

// ─── Tool Content handler tests ───────────────────────────────────────────

describe("handleGetToolContent", () => {
	it.effect(
		"returns tool content when Effect read query is available and content exists",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed("full tool output text")),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getSession: vi.fn(() => Effect.succeed(undefined)),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;

			const layer = Layer.provideMerge(
				ToolContentServiceLive,
				Layer.mergeAll(
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(ReadQueryEffectTag, readQuery),
				),
			);

			return handleGetToolContent("client-1", { toolId: "tool-42" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(readQuery.getToolContent).toHaveBeenCalledWith("tool-42");
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "tool_content",
						sessionId: "session-1",
						toolId: "tool-42",
						content: "full tool output text",
					});
				}),
			);
		},
	);

	it.effect("returns NOT_FOUND when readQuery is absent", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});

		// No persistence-backed tool content service provided.
		const layer = Layer.merge(
			Layer.succeed(WebSocketHandlerTag, ws),
			ToolContentServiceNoop,
		);

		return handleGetToolContent("client-1", { toolId: "tool-42" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "error",
					sessionId: "session-1",
					code: "NOT_FOUND",
					message: "Full tool content not available",
				});
			}),
		);
	});
});

describe("handleForkSession", () => {
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
		"stores explicit fork metadata through SessionManagerService",
		() => {
			const legacySetForkEntry = vi.fn();
			const legacySendDualSessionLists = vi.fn(async () => {
				throw new Error("legacy sendDualSessionLists should not be used");
			});
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy listSessions should not be used");
			});
			const serviceListSessions = vi.fn(() =>
				Effect.succeed([
					{
						id: "ses-parent",
						title: "Parent Session",
						updatedAt: 100,
						messageCount: 1,
					},
				]),
			);
			const serviceSetForkEntry = vi.fn(() => Effect.void);
			const serviceSendDualSessionLists = vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "ses-child",
								title: "Forked Session",
								updatedAt: 201,
								messageCount: 0,
								parentID: "ses-parent",
								forkMessageId: "msg-1",
								forkPointTimestamp: 123,
							},
						],
						roots: false,
					});
				}),
			);
			const ws = mockWsHandler();
			const sessionMgr = mockSessionManager({
				setForkEntry: legacySetForkEntry,
				sendDualSessionLists: legacySendDualSessionLists,
				listSessions: legacyListSessions,
				loadPreRenderedHistory: vi.fn(async () => ({
					messages: [],
					hasMore: false,
				})),
			});
			const sessionManagerService = makeMockSessionManagerService({
				listSessions: serviceListSessions,
				setForkEntry: serviceSetForkEntry,
				sendDualSessionLists: serviceSendDualSessionLists,
			});
			const layer = makeForkSessionLayer({
				sessionMgr,
				sessionManagerService,
				ws,
			});

			return handleForkSession("client-1", {
				sessionId: "ses-parent",
				messageId: "msg-1",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(serviceSetForkEntry).toHaveBeenCalledWith("ses-child", {
						forkMessageId: "msg-1",
						parentID: "ses-parent",
						forkPointTimestamp: 123,
					});
					expect(legacySetForkEntry).not.toHaveBeenCalled();
					expect(serviceListSessions).toHaveBeenCalledWith();
					expect(legacyListSessions).not.toHaveBeenCalled();
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_forked",
						sessionId: "ses-child",
						session: {
							id: "ses-child",
							title: "Forked Session",
							updatedAt: 201,
							parentID: "ses-parent",
							forkMessageId: "msg-1",
							forkPointTimestamp: 123,
						},
						parentId: "ses-parent",
						parentTitle: "Parent Session",
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "ses-child",
						sessionId: "ses-child",
						history: {
							messages: [],
							hasMore: false,
						},
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "status",
						sessionId: "ses-child",
						status: "idle",
					});
					expect(serviceSendDualSessionLists).toHaveBeenCalled();
					expect(legacySendDualSessionLists).not.toHaveBeenCalled();
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_list",
						sessions: [
							{
								id: "ses-child",
								title: "Forked Session",
								updatedAt: 201,
								messageCount: 0,
								parentID: "ses-parent",
								forkMessageId: "msg-1",
								forkPointTimestamp: 123,
							},
						],
						roots: false,
					});
				}),
			);
		},
	);

	it.effect("uses the whole-session fork fallback message as metadata", () => {
		const legacySetForkEntry = vi.fn();
		const serviceSetForkEntry = vi.fn(() => Effect.void);
		const messagesPage = vi.fn(async () => [{ id: "msg-last" }]);
		const client = {
			session: {
				fork: vi.fn(async () => ({
					id: "ses-child",
					title: "Forked Session",
					time: { created: 200, updated: 201 },
				})),
				messagesPage,
				get: vi.fn(async () => ({})),
			},
			permission: { list: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI;
		const sessionMgr = mockSessionManager({
			setForkEntry: legacySetForkEntry,
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
				expect(serviceSetForkEntry).toHaveBeenCalledWith("ses-child", {
					forkMessageId: "msg-last",
					parentID: "ses-parent",
					forkPointTimestamp: 200,
				});
				expect(legacySetForkEntry).not.toHaveBeenCalled();
			}),
		);
	});

	it.effect(
		"returns without forking when no active session can be resolved",
		() => {
			const setForkEntry = vi.fn();
			const fork = vi.fn();
			const client = {
				session: {
					fork,
				},
				permission: { list: vi.fn(async () => []) },
			} as unknown as OpenCodeAPI;
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const sessionMgr = mockSessionManager({ setForkEntry });
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

// ─── Terminal handler tests ───────────────────────────────────────────────

describe("handlePtyInput", () => {
	it.effect("sends input through terminal service", () => {
		const terminal = mockTerminalService();

		const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

		return handlePtyInput("client-1", {
			ptyId: "pty-1",
			data: "ls\n",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(terminal.sendInput).toHaveBeenCalledWith("pty-1", "ls\n");
			}),
		);
	});

	it.effect("does nothing when ptyId is empty", () => {
		const terminal = mockTerminalService();

		const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

		return handlePtyInput("client-1", { ptyId: "", data: "ls\n" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(terminal.sendInput).not.toHaveBeenCalled();
			}),
		);
	});
});

// ─── Permissions handler tests ────────────────────────────────────────────

describe("handlePermissionResponse", () => {
	it.effect(
		"processes permission response through PendingInteractionService",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const log = mockLogger();
			const client = {
				permission: { reply: vi.fn(async () => {}) },
				config: { get: vi.fn(async () => ({})) },
			} as unknown as OpenCodeAPI;
			const config = mockConfig();

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
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
					expect(client.permission.reply).toHaveBeenCalledWith(
						"session-1",
						"perm-1",
						"once",
					);
					expect(ws.broadcast).toHaveBeenCalledWith(
						expect.objectContaining({
							type: "permission_resolved",
							requestId: "perm-1",
							decision: "once",
						}),
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
			const client = {
				permission: { reply: vi.fn(async () => {}) },
				config: { get: vi.fn(async () => ({})) },
			} as unknown as OpenCodeAPI;
			const config = mockConfig();

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
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
					expect(client.permission.reply).toHaveBeenCalledWith(
						"permission-session",
						"perm-cross-session",
						"once",
					);
					expect(ws.broadcast).toHaveBeenCalledWith(
						expect.objectContaining({
							type: "permission_resolved",
							sessionId: "permission-session",
							requestId: "perm-cross-session",
							decision: "once",
						}),
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
			const client = {
				permission: { reply: vi.fn(async () => {}) },
				config: {
					get: vi.fn(async () => ({})),
					update: vi.fn(async () => {}),
				},
			} as unknown as OpenCodeAPI;
			const config = mockConfig();
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				PendingInteractionServiceLive,
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

	it.effect("processes permission response and broadcasts resolution", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const client = {
			permission: { reply: vi.fn(async () => {}) },
			config: { get: vi.fn(async () => ({})) },
		} as unknown as OpenCodeAPI;
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
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
				expect(ws.broadcast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "permission_resolved",
						requestId: "perm-1",
					}),
				);
			}),
		);
	});

	it.effect("does nothing when bridge returns null", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const client = {
			permission: { reply: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
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
		const client = {} as unknown as OpenCodeAPI;
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

	it.effect("rejects question via REST API and broadcasts resolution", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const decrementPendingQuestionCount = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			decrementPendingQuestionCount,
		});
		const client = {
			question: { reject: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

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
				expect(ws.broadcast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "ask_user_resolved",
						toolId: "que-1",
					}),
				);
				expect(decrementPendingQuestionCount).toHaveBeenCalledWith("session-1");
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
			const decrementPendingQuestionCount = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				decrementPendingQuestionCount,
			});
			const client = {
				question: {
					reject: vi.fn(async () => {}),
					list: vi.fn(async () => []),
				},
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn((sessionId: string) =>
					sessionId === "question-session" ? "claude" : "opencode",
				),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				PendingInteractionServiceLive,
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
				yield* handleQuestionReject("client-1", { toolId: "que-claude" });
				const pending = yield* pendingInteractions.listPendingQuestions();
				return pending;
			}).pipe(
				Effect.provide(layer),
				Effect.tap((pending) => {
					expect(client.question.reject).not.toHaveBeenCalled();
					expect(engine.getProviderForSession).toHaveBeenCalledWith(
						"question-session",
					);
					expect(ws.sendTo).toHaveBeenCalledWith(
						"client-1",
						expect.objectContaining({
							type: "ask_user_error",
							toolId: "que-claude",
							sessionId: "question-session",
						}),
					);
					expect(ws.broadcast).not.toHaveBeenCalledWith(
						expect.objectContaining({
							type: "ask_user_resolved",
							toolId: "que-claude",
						}),
					);
					expect(decrementPendingQuestionCount).not.toHaveBeenCalled();
					expect(pending).toHaveLength(1);
					expect(pending[0]?.requestId).toBe("que-claude");
				}),
			);
		},
	);
});

describe("handleAskUserResponse", () => {
	it.effect(
		"answers question via REST API and decrements through service",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const log = mockLogger();
			const decrementPendingQuestionCount = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				decrementPendingQuestionCount,
			});
			const client = {
				question: { reply: vi.fn(async () => {}) },
			} as unknown as OpenCodeAPI;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				makeOverridesStateLive(),
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
					expect(ws.broadcast).toHaveBeenCalledWith(
						expect.objectContaining({
							type: "ask_user_resolved",
							toolId: "que-1",
						}),
					);
					expect(decrementPendingQuestionCount).toHaveBeenCalledWith(
						"session-1",
					);
				}),
			);
		},
	);

	it.effect(
		"uses the pending question session when answering a Claude question from another visible session",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "visible-session"),
			});
			const log = mockLogger();
			const decrementPendingQuestionCount = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				decrementPendingQuestionCount,
			});
			const client = {
				question: {
					reply: vi.fn(async () => {}),
					list: vi.fn(async () => []),
				},
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn((sessionId: string) =>
					sessionId === "question-session" ? "claude" : "opencode",
				),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				PendingInteractionServiceLive,
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
				yield* handleAskUserResponse("client-1", {
					toolId: "que-claude",
					answers: { "0": "Yes" },
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.question.reply).not.toHaveBeenCalled();
					expect(engine.getProviderForSession).toHaveBeenCalledWith(
						"question-session",
					);
					expect(ws.broadcast).toHaveBeenCalledWith(
						expect.objectContaining({
							type: "ask_user_resolved",
							toolId: "que-claude",
							sessionId: "question-session",
						}),
					);
					expect(decrementPendingQuestionCount).toHaveBeenCalledWith(
						"question-session",
					);
				}),
			);
		},
	);
});

describe("handleNewSession", () => {
	it.effect(
		"creates and switches before broadcasting lists through SessionManagerService",
		() => {
			const ws = mockWsHandler();
			const log = mockLogger();
			const legacySendDualSessionLists = vi.fn(async () => {
				throw new Error("legacy sendDualSessionLists should not be used");
			});
			const legacyCreateSession = vi.fn(async () => {
				throw new Error("legacy createSession should not be used");
			});
			const sessionMgr = mockSessionManager({
				createSession: legacyCreateSession,
				sendDualSessionLists: legacySendDualSessionLists,
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
			const sendDualSessionLists = vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "new-session-1",
								title: "New Session",
								updatedAt: 200,
								messageCount: 0,
							},
						],
						roots: true,
					});
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				createSession: serviceCreateSession,
				sendDualSessionLists,
			});
			const layer = makeSessionLifecycleLayer({
				ws,
				sessionMgr,
				sessionManagerService,
				log,
			});

			return handleNewSession("client-1", {
				title: "New Session",
				requestId: "request-1" as RequestId,
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(serviceCreateSession).toHaveBeenCalledWith("New Session");
					expect(legacyCreateSession).not.toHaveBeenCalled();
					expect(ws.setClientSession).toHaveBeenCalledWith(
						"client-1",
						"new-session-1",
					);
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "new-session-1",
						sessionId: "new-session-1",
						requestId: "request-1",
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "status",
						sessionId: "new-session-1",
						status: "idle",
					});
					expect(sendDualSessionLists).toHaveBeenCalled();
					expect(legacySendDualSessionLists).not.toHaveBeenCalled();
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_list",
						sessions: [
							{
								id: "new-session-1",
								title: "New Session",
								updatedAt: 200,
								messageCount: 0,
							},
						],
						roots: true,
					});
					expect(log.info).toHaveBeenCalledWith(
						"client=client-1 Created: new-session-1",
					);
				}),
			);
		},
	);

	it.effect("does not wait for session list refresh before completing", () => {
		const ws = mockWsHandler();
		const log = mockLogger();
		const serviceCreateSession = vi.fn(() =>
			Effect.succeed({
				id: "new-session-fast",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "New Session",
				version: "1.0.0",
				time: { created: 100, updated: 200 },
			}),
		);
		const sendDualSessionLists = vi.fn(() => Effect.never);
		const sessionManagerService = makeMockSessionManagerService({
			createSession: serviceCreateSession,
			sendDualSessionLists,
		});
		const layer = makeSessionLifecycleLayer({
			ws,
			sessionManagerService,
			log,
		});

		return Effect.gen(function* () {
			const result = yield* Effect.either(
				handleNewSession("client-1", {
					title: "New Session",
					requestId: "request-fast" as RequestId,
				}).pipe(Effect.timeout(Duration.millis(50)), Effect.provide(layer)),
			);

			expect(result._tag).toBe("Right");
			expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
				type: "session_switched",
				id: "new-session-fast",
				sessionId: "new-session-fast",
				requestId: "request-fast",
			});
			expect(sendDualSessionLists).toHaveBeenCalled();
		});
	});

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
		const sendDualSessionLists = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			createSession: serviceCreateSession,
			sendDualSessionLists,
		});
		const layer = makeSessionLifecycleLayer({
			ws,
			sessionManagerService,
			log,
		});

		return handleNewSession("client-1", {
			title: "OpenCode Session",
			requestId: "request-opencode" as RequestId,
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
			const client = {
				session: { get: vi.fn(async () => ({})) },
				provider: { list: vi.fn(async () => ({ providers: [] })) },
				permission: { list: vi.fn(async () => []) },
				question: { list: vi.fn(async () => []) },
			} as unknown as OpenCodeAPI;
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("idle")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "ses-local-placeholder",
						provider: "claude",
						provider_sid: null,
						title: "Untitled",
						status: "idle",
						parent_id: null,
						fork_point_event: null,
						last_message_at: null,
						created_at: 1,
						updated_at: 1,
					}),
				),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;
			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				PendingInteractionServiceLive,
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
				skipMetadata: true,
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "ses-local-placeholder",
						sessionId: "ses-local-placeholder",
					});
					expect(startPolling).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect("logs and completes when the service list broadcast fails", () => {
		const ws = mockWsHandler();
		const log = mockLogger();
		const legacySendDualSessionLists = vi.fn(async () => {
			throw new Error("legacy sendDualSessionLists should not be used");
		});
		const legacyCreateSession = vi.fn(async () => {
			throw new Error("legacy createSession should not be used");
		});
		const sessionMgr = mockSessionManager({
			createSession: legacyCreateSession,
			sendDualSessionLists: legacySendDualSessionLists,
		});
		const serviceCreateSession = vi.fn(() =>
			Effect.succeed({
				id: "new-session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "",
				version: "1.0.0",
				time: { created: 100, updated: 200 },
			}),
		);
		const sendDualSessionLists = vi.fn(() =>
			Effect.fail(
				new SessionManagerError({
					operation: "sendDualSessionLists",
					cause: new Error("service unavailable"),
				}),
			),
		);
		const sessionManagerService = makeMockSessionManagerService({
			createSession: serviceCreateSession,
			sendDualSessionLists,
		});
		const layer = makeSessionLifecycleLayer({
			ws,
			sessionMgr,
			sessionManagerService,
			log,
		});

		return handleNewSession("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.setClientSession).toHaveBeenCalledWith(
					"client-1",
					"new-session-1",
				);
				expect(serviceCreateSession).toHaveBeenCalledWith(undefined);
				expect(legacyCreateSession).not.toHaveBeenCalled();
				expect(sendDualSessionLists).toHaveBeenCalled();
				expect(legacySendDualSessionLists).not.toHaveBeenCalled();
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining(
						"Failed to broadcast session list after CreateSession",
					),
				);
				expect(log.info).toHaveBeenCalledWith(
					"client=client-1 Created: new-session-1",
				);
			}),
		);
	});
});

describe("handleDeleteSession", () => {
	it.effect(
		"deletes and broadcasts lists through SessionManagerService",
		() => {
			const ws = mockWsHandler({
				getClientsForSession: vi.fn(() => []),
			});
			const log = mockLogger();
			const legacySendDualSessionLists = vi.fn(async () => {
				throw new Error("legacy sendDualSessionLists should not be used");
			});
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy listSessions should not be used");
			});
			const serviceListSessions = vi.fn(() => Effect.succeed([]));
			const legacyDeleteSession = vi.fn(async () => {
				throw new Error("legacy deleteSession should not be used");
			});
			const serviceDeleteSession = vi.fn(() => Effect.void);
			const sessionMgr = mockSessionManager({
				deleteSession: legacyDeleteSession,
				listSessions: legacyListSessions,
				sendDualSessionLists: legacySendDualSessionLists,
			});
			const sendDualSessionLists = vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [],
						roots: true,
					});
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				deleteSession: serviceDeleteSession,
				listSessions: serviceListSessions,
				sendDualSessionLists,
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
					expect(ws.getClientsForSession).toHaveBeenCalledWith(
						"deleted-session",
					);
					expect(serviceDeleteSession).toHaveBeenCalledWith("deleted-session");
					expect(legacyDeleteSession).not.toHaveBeenCalled();
					expect(serviceListSessions).not.toHaveBeenCalled();
					expect(legacyListSessions).not.toHaveBeenCalled();
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_deleted",
						sessionId: "deleted-session",
					});
					expect(sendDualSessionLists).toHaveBeenCalled();
					expect(legacySendDualSessionLists).not.toHaveBeenCalled();
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_list",
						sessions: [],
						roots: true,
					});
					expect(log.info).toHaveBeenCalledWith(
						"client=client-1 Deleted: deleted-session",
					);
				}),
			);
		},
	);

	it.effect(
		"switches every viewer and replays metadata before the service list broadcast",
		() => {
			const ws = mockWsHandler({
				getClientsForSession: vi.fn(() => ["client-1", "client-2"]),
			});
			const log = mockLogger();
			const legacySendDualSessionLists = vi.fn(async () => {
				throw new Error("legacy sendDualSessionLists should not be used");
			});
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy listSessions should not be used");
			});
			const serviceListSessions = vi.fn(() =>
				Effect.succeed([
					{
						id: "remaining-session",
						title: "Remaining Session",
						updatedAt: 200,
						messageCount: 0,
					},
				]),
			);
			const legacyDeleteSession = vi.fn(async () => {
				throw new Error("legacy deleteSession should not be used");
			});
			const serviceDeleteSession = vi.fn(() => Effect.void);
			const sessionMgr = mockSessionManager({
				deleteSession: legacyDeleteSession,
				listSessions: legacyListSessions,
				loadPreRenderedHistory: vi.fn(async () => ({
					messages: [],
					hasMore: false,
				})),
				sendDualSessionLists: legacySendDualSessionLists,
			});
			const sendDualSessionLists = vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "remaining-session",
								title: "Remaining Session",
								updatedAt: 200,
								messageCount: 0,
							},
						],
						roots: true,
					});
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				deleteSession: serviceDeleteSession,
				listSessions: serviceListSessions,
				sendDualSessionLists,
			});
			const client = {
				session: {
					get: vi.fn(async () => ({
						id: "remaining-session",
						modelID: "claude-sonnet-4-5",
						providerID: "anthropic",
					})),
				},
				permission: { list: vi.fn(async () => []) },
				question: { list: vi.fn(async () => []) },
			} as unknown as OpenCodeAPI;
			const layer = makeSessionLifecycleLayer({
				client,
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
					expect(ws.getClientsForSession).toHaveBeenCalledWith(
						"deleted-session",
					);
					expect(serviceDeleteSession).toHaveBeenCalledWith("deleted-session");
					expect(legacyDeleteSession).not.toHaveBeenCalled();
					expect(serviceListSessions).toHaveBeenCalledWith();
					expect(legacyListSessions).not.toHaveBeenCalled();
					expect(ws.setClientSession).toHaveBeenCalledWith(
						"client-1",
						"remaining-session",
					);
					expect(ws.setClientSession).toHaveBeenCalledWith(
						"client-2",
						"remaining-session",
					);
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "remaining-session",
						sessionId: "remaining-session",
						history: {
							messages: [],
							hasMore: false,
						},
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-2", {
						type: "session_switched",
						id: "remaining-session",
						sessionId: "remaining-session",
						history: {
							messages: [],
							hasMore: false,
						},
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "model_info",
						model: "claude-sonnet-4-5",
						provider: "anthropic",
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-2", {
						type: "model_info",
						model: "claude-sonnet-4-5",
						provider: "anthropic",
					});
					expect(sendDualSessionLists).toHaveBeenCalledTimes(3);
					expect(legacySendDualSessionLists).not.toHaveBeenCalled();
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_deleted",
						sessionId: "deleted-session",
					});
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_list",
						sessions: [
							{
								id: "remaining-session",
								title: "Remaining Session",
								updatedAt: 200,
								messageCount: 0,
							},
						],
						roots: true,
					});
				}),
			);
		},
	);
});

describe("renameSessionForClient", () => {
	it.effect(
		"renames through SessionManagerService and broadcasts lists",
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
			const sendDualSessionLists = vi.fn((send) =>
				Effect.sync(() => {
					calls.push("broadcast");
					send({
						type: "session_list",
						sessions: [
							{
								id: "session-1",
								title: "New Title",
								updatedAt: 100,
								messageCount: 0,
							},
						],
						roots: true,
					});
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				renameSession,
				sendDualSessionLists,
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
					expect(sendDualSessionLists).toHaveBeenCalled();
					expect(calls).toEqual(["rename", "broadcast"]);
					expect(ws.broadcast).toHaveBeenCalledWith({
						type: "session_list",
						sessions: [
							{
								id: "session-1",
								title: "New Title",
								updatedAt: 100,
								messageCount: 0,
							},
						],
						roots: true,
					});
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
		const sendDualSessionLists = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			renameSession,
			sendDualSessionLists,
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
				expect(sendDualSessionLists).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("loadMoreHistoryForSession", () => {
	it.effect("loads history page through SessionManagerService", () => {
		const page = {
			messages: [
				{
					id: "msg-1",
					role: "assistant" as const,
					parts: [{ id: "part-1", type: "text" as const, text: "hello" }],
				},
			],
			hasMore: true,
			total: 10,
		};
		const loadPreRenderedHistory = vi.fn(() => Effect.succeed(page));
		const sessionManagerService = makeMockSessionManagerService({
			loadPreRenderedHistory,
		});

		const layer = Layer.succeed(
			SessionManagerServiceTag,
			sessionManagerService,
		);

		return loadMoreHistoryForSession({
			sessionId: "session-1",
			offset: 50,
		}).pipe(
			Effect.provide(layer),
			Effect.tap((result) => {
				expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1", 50);
				expect(result).toEqual({
					sessionId: "session-1",
					messages: page.messages,
					hasMore: true,
					total: 10,
				});
			}),
		);
	});
});

// ─── Prompt handler tests ─────────────────────────────────────────────────

describe("cancelSessionById", () => {
	it.effect("clears processing timeout and sends done when no engine", () => {
		const ws = mockWsHandler();
		const log = mockLogger();
		const client = {
			session: { abort: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* startProcessingTimeout(
				"session-1",
				"2 minutes",
				() => Effect.void,
			);
			yield* cancelSessionById("client-1", "session-1");

			expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
			expect(client.session.abort).toHaveBeenCalledWith("session-1");
			expect(ws.sendToSession).toHaveBeenCalledWith("session-1", {
				type: "done",
				sessionId: "session-1",
				code: 1,
			});
		}).pipe(Effect.provide(layer));
	});
});

describe("syncInputDraftForSession", () => {
	it.effect("forwards input to clients in the target session", () => {
		const ws = mockWsHandler({
			getClientsForSession: vi.fn(() => ["client-1", "client-2"]),
		});

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return syncInputDraftForSession({
			sessionId: "session-1",
			text: "hello",
			from: "browser-tab-a",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.getClientsForSession).toHaveBeenCalledWith("session-1");
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "input_sync",
					text: "hello",
					from: "browser-tab-a",
				});
				expect(ws.sendTo).toHaveBeenCalledWith("client-2", {
					type: "input_sync",
					text: "hello",
					from: "browser-tab-a",
				});
				expect(ws.sendTo).toHaveBeenCalledTimes(2);
			}),
		);
	});

	it.effect("clears the draft by forwarding an empty sync", () => {
		const ws = mockWsHandler({
			getClientsForSession: vi.fn(() => ["client-1"]),
		});

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return syncInputDraftForSession({
			sessionId: "session-1",
			text: "",
			from: "browser-tab-a",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "input_sync",
					text: "",
					from: "browser-tab-a",
				});
			}),
		);
	});
});

describe("rewindSessionToMessage", () => {
	it.effect("reverts to a specific message and clears cursor", () => {
		const log = mockLogger();
		const legacyClearPaginationCursor = vi.fn(() => {
			throw new Error("legacy clearPaginationCursor should not be used");
		});
		const _sessionMgr = mockSessionManager({
			clearPaginationCursor: legacyClearPaginationCursor,
		});
		const clearPaginationCursor = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			clearPaginationCursor,
		});
		const client = {
			session: { revert: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
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
				expect(clearPaginationCursor).toHaveBeenCalledWith("session-1");
				expect(legacyClearPaginationCursor).not.toHaveBeenCalled();
				expect(log.info).toHaveBeenCalled();
			}),
		);
	});
});

describe("handleMessage", () => {
	it.effect("sends error when no active session", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const log = mockLogger();
		const sessionManagerService = makeMockSessionManagerService();
		const config = mockConfig();
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			makeOverridesStateLive(),
		);

		return handleMessage("client-1", { text: "hello" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({
						type: "system_error",
						code: "NO_SESSION",
					}),
				);
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
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			makeOverridesStateLive(),
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
		const client = {} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => ({
				status: "completed",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			})),
		} as unknown as OrchestrationEngine;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* setContextWindow("session-1", "1m");
			yield* handleMessage("client-1", { text: "hello world" });
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
			const client = {} as unknown as OpenCodeAPI;
			let questionPromise: Promise<Record<string, unknown>> | undefined;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
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
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "hello world" });
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
		"passes prior SQLite history into Claude engine send_turn input",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const sessionManagerService = makeMockSessionManagerService();
			const config = mockConfig();
			const client = {} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			} as unknown as OrchestrationEngine;
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getSession: vi.fn(() => Effect.succeed(undefined)),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() =>
					Effect.succeed([
						{
							id: "msg-user-1",
							session_id: "session-1",
							turn_id: "turn-1",
							role: "user",
							text: "Earlier question",
							cost: null,
							tokens_in: null,
							tokens_out: null,
							tokens_cache_read: null,
							tokens_cache_write: null,
							is_streaming: 0,
							created_at: 1,
							updated_at: 1,
							parts: [
								{
									id: "part-user-1",
									message_id: "msg-user-1",
									type: "text",
									text: "Earlier question",
									tool_name: null,
									call_id: null,
									input: null,
									result: null,
									metadata: null,
									duration: null,
									status: null,
									sort_order: 0,
									created_at: 1,
									updated_at: 1,
								},
							],
						},
					]),
				),
			} satisfies ReadQueryEffect;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				makeOverridesStateLive(),
			);

			return handleMessage("client-1", { text: "new prompt" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(readQuery.getSessionMessagesWithParts).toHaveBeenCalledWith(
						"session-1",
					);
					expect(engine.dispatchEffect).toHaveBeenCalledWith(
						expect.objectContaining({
							type: "send_turn",
							providerId: "claude",
							input: expect.objectContaining({
								history: [
									expect.objectContaining({
										role: "user",
										parts: [
											expect.objectContaining({
												type: "text",
												text: "Earlier question",
											}),
										],
									}),
								],
							}),
						}),
					);
				}),
			);
		},
	);

	it.effect(
		"loads prior Claude history through SessionManagerService when Effect SQLite is unavailable",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const legacyLoadPreRenderedHistory = vi.fn(async () => {
				throw new Error("legacy prompt history load should not be used");
			});
			const _sessionMgr = mockSessionManager({
				loadPreRenderedHistory: legacyLoadPreRenderedHistory,
			});
			const loadPreRenderedHistory = vi.fn(() =>
				Effect.succeed({
					messages: [
						{
							id: "history-msg-1",
							role: "user" as const,
							parts: [
								{
									id: "history-part-1",
									type: "text" as const,
									text: "Earlier fallback question",
								},
							],
						},
					],
					hasMore: false,
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});
			const config = mockConfig();
			const client = {} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			} as unknown as OrchestrationEngine;
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return handleMessage("client-1", { text: "new prompt" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1");
					expect(legacyLoadPreRenderedHistory).not.toHaveBeenCalled();
					expect(engine.dispatchEffect).toHaveBeenCalledWith(
						expect.objectContaining({
							type: "send_turn",
							providerId: "claude",
							input: expect.objectContaining({
								history: [
									expect.objectContaining({
										role: "user",
										parts: [
											expect.objectContaining({
												type: "text",
												text: "Earlier fallback question",
											}),
										],
									}),
								],
							}),
						}),
					);
				}),
			);
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
						updatedAt: 100,
						messageCount: 0,
					},
				]),
			);
			const renameSession = vi.fn(() => Effect.void);
			const sendDualSessionLists = vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "session-1",
								title: "First prompt",
								updatedAt: 200,
								messageCount: 1,
							},
						],
						roots: true,
					});
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				listSessions,
				renameSession,
				sendDualSessionLists,
			});
			const config = mockConfig();
			const client = {} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [{ key: "turnCount", value: 1 }],
				})),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "First prompt" });
				yield* flushDispatchContinuation();

				expect(listSessions).not.toHaveBeenCalled();
				expect(renameSession).not.toHaveBeenCalled();
				expect(sendDualSessionLists).not.toHaveBeenCalled();
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
					updatedAt: 100,
					messageCount: 0,
				},
			]),
		);
		const renameSession = vi.fn(() => Effect.void);
		const sendDualSessionLists = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			listSessions,
			renameSession,
			sendDualSessionLists,
		});
		const config = mockConfig();
		const client = {} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => ({
				status: "completed",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [{ key: "turnCount", value: 1 }],
			})),
		} as unknown as OrchestrationEngine;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* handleMessage("client-1", { text: "First prompt" });
			yield* flushDispatchContinuation();

			expect(listSessions).not.toHaveBeenCalled();
			expect(renameSession).not.toHaveBeenCalled();
			expect(sendDualSessionLists).not.toHaveBeenCalled();
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
				sendDualSessionLists: vi.fn(() => Effect.void),
			});
			const config = mockConfig();
			const client = {} as unknown as OpenCodeAPI;
			const readQuery = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed("idle")),
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "ses-local-placeholder",
						provider: "claude",
						provider_sid: null,
						title: "Untitled",
						status: "idle",
						parent_id: null,
						fork_point_event: null,
						last_message_at: null,
						created_at: 1,
						updated_at: 1,
					}),
				),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			} satisfies ReadQueryEffect;
			const engine = {
				getProviderForSession: vi.fn(() => undefined),
				bindSession: vi.fn(),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				Layer.succeed(ReadQueryEffectTag, readQuery),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("ses-local-placeholder", {
					providerID: "opencode",
					modelID: "big-pickle",
				});

				yield* handleMessage("client-1", { text: "Test query" });
				yield* flushDispatchContinuation();

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
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_switched",
					id: "ses-opencode-created",
					sessionId: "ses-opencode-created",
				});
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
			const client = {} as unknown as OpenCodeAPI;
			const dispatchError = new Error("dispatch failed");
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async () => {
					throw dispatchError;
				}),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "First prompt" });
				yield* flushDispatchContinuation();

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
				expect(ws.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "done",
					sessionId: "session-1",
					code: 1,
				});
				expect(ws.sendTo).toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({
						type: "error",
						sessionId: "session-1",
						code: "SEND_FAILED",
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("sends message via legacy path when no engine", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1"]),
		});
		const log = mockLogger();
		const legacyRecordMessageActivity = vi.fn(() => {
			throw new Error("legacy recordMessageActivity should not be used");
		});
		const _sessionMgr = mockSessionManager({
			recordMessageActivity: legacyRecordMessageActivity,
		});
		const recordMessageActivity = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			recordMessageActivity,
		});
		const config = mockConfig();
		const client = {
			session: { prompt: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			makeOverridesStateLive(),
		);

		return handleMessage("client-1", { text: "hello world" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.session.prompt).toHaveBeenCalledWith("session-1", {
					text: "hello world",
				});
				expect(recordMessageActivity).toHaveBeenCalledWith("session-1");
				expect(legacyRecordMessageActivity).not.toHaveBeenCalled();
			}),
		);
	});
});
