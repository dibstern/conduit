// ─── Effect Handler Tests (Batch 1) ─────────────────────────────────────────
// Verifies that the Effect handler implementations produce the expected
// observable side effects when run against a mock
// Layer. Each test provides minimal mock services via Layer.succeed, runs
// the Effect to completion, and asserts on captured calls.

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/effect/pending-interaction-service.js";
import type {
	SessionManagerShape,
	WebSocketHandlerShape,
} from "../../../src/lib/effect/services.js";
// Batch 2 imports
import {
	ConfigTag,
	InstanceMgmtTag,
	LoggerTag,
	OpenCodeAPITag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	PollerManagerTag,
	ReadQueryTag,
	ScanDepsTag,
	SessionManagerTag,
	SessionOverridesTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	SessionManagerError,
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/effect/session-manager-service.js";
import {
	type OpenCodeTerminalService,
	OpenCodeTerminalServiceTag,
} from "../../../src/lib/effect/terminal-service.js";
import {
	filterAgents,
	handleGetAgents,
	handleSwitchAgent,
} from "../../../src/lib/handlers/agent.js";
import { handleSwitchContextWindow } from "../../../src/lib/handlers/context-window.js";
import {
	handleGetFileContent,
	handleGetFileList,
} from "../../../src/lib/handlers/files.js";
import {
	handleInstanceAdd,
	handleInstanceRemove,
	handleInstanceStart,
	handleInstanceStop,
	handleScanNow,
} from "../../../src/lib/handlers/instance.js";
import {
	handleGetModels,
	handleSwitchModel,
	handleSwitchVariant,
} from "../../../src/lib/handlers/model.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import {
	handleCancel,
	handleInputSync,
	handleMessage,
	handleRewind,
} from "../../../src/lib/handlers/prompt.js";
import { handleReloadProviderSession } from "../../../src/lib/handlers/reload.js";
import {
	handleDeleteSession,
	handleForkSession,
	handleListSessions,
	handleLoadMoreHistory,
	handleNewSession,
	handleRenameSession,
	handleSearchSessions,
} from "../../../src/lib/handlers/session.js";
import {
	handleGetCommands,
	handleGetProjects,
	handleGetTodo,
} from "../../../src/lib/handlers/settings.js";
import {
	handlePtyClose,
	handlePtyInput,
	handlePtyResize,
} from "../../../src/lib/handlers/terminal.js";
import { handleGetToolContent } from "../../../src/lib/handlers/tool-content.js";
import type {
	InstanceManagementDeps,
	ScanDeps,
} from "../../../src/lib/handlers/types.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { SessionOverrides } from "../../../src/lib/session/session-overrides.js";
import type { PermissionId, RequestId } from "../../../src/lib/shared-types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";

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

function mockOverrides(
	overrides?: Partial<SessionOverrides>,
): SessionOverrides {
	return {
		setAgent: vi.fn(),
		setModel: vi.fn(),
		setVariant: vi.fn(),
		setContextWindow: vi.fn(),
		getModel: vi.fn(),
		getVariant: vi.fn(),
		getContextWindow: vi.fn(),
		setDefaultModel: vi.fn(),
		defaultModel: undefined,
		defaultVariant: "",
		defaultContextWindow: "",
		...overrides,
	} as unknown as SessionOverrides;
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

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
			);

			return handleGetAgents("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.app.agents).toHaveBeenCalledOnce();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "agent_list",
						agents: filterAgents(mockAgents),
					});
				}),
			);
		},
	);
});

describe("handleSwitchAgent", () => {
	it.effect("sets agent override when client has a session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		return handleSwitchAgent("client-1", { agentId: "plan" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.setAgent).toHaveBeenCalledWith("session-42", "plan");
				expect(log.info).toHaveBeenCalledOnce();
			}),
		);
	});

	it.effect("warns when no session is assigned", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		return handleSwitchAgent("client-1", { agentId: "build" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.setAgent).not.toHaveBeenCalled();
				expect(log.warn).toHaveBeenCalledOnce();
			}),
		);
	});

	it.effect("does nothing when agentId is empty", () => {
		const ws = mockWsHandler();
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		return handleSwitchAgent("client-1", { agentId: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.setAgent).not.toHaveBeenCalled();
				expect(log.info).not.toHaveBeenCalled();
			}),
		);
	});
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

describe("handleGetTodo", () => {
	it.effect("sends empty todo list", () => {
		const ws = mockWsHandler();

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleGetTodo("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "todo_state",
					items: [],
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
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(ConfigTag, config),
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
				openCodeSettingsLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(ConfigTag, config),
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

describe("handleReloadProviderSession", () => {
	it.effect("sends error when no active session", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const log = mockLogger();
		const engine = {
			dispatch: vi.fn(async () => ({ models: [] })),
		} as unknown as OrchestrationEngine;
		const client = {
			provider: { list: vi.fn(async () => ({ connected: [], providers: [] })) },
			app: { commands: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI;
		const overrides = mockOverrides();
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, engine),
			openCodeModelAndSettingsLayer(client),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(ConfigTag, config),
		);

		return handleReloadProviderSession("client-1", {}).pipe(
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
		const overrides = mockOverrides();
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, engine),
			openCodeModelAndSettingsLayer(client),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(ConfigTag, config),
		);

		return handleReloadProviderSession("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				// Should have dispatched end_session
				expect(engine.dispatch).toHaveBeenCalledWith(
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

describe("handleGetModels", () => {
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
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleGetModels("client-1", {}).pipe(
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

	it("sends OpenCode model_list before slow Claude discovery finishes", async () => {
		const ws = mockWsHandler();
		let resolveDiscovery: (value: { models: [] }) => void = () => {};
		const engine = {
			dispatch: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveDiscovery = resolve as (value: { models: [] }) => void;
					}),
			),
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
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			openCodeModelLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		const runPromise = Effect.runPromise(
			handleGetModels("client-1", {}).pipe(Effect.provide(layer)),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(ws.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
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

		resolveDiscovery({ models: [] });
		await runPromise;
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
			const overrides = mockOverrides();
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return handleGetModels("client-1", {}).pipe(
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
		"sends context_window_info for active Claude model after get_models",
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
			const overrides = mockOverrides({
				defaultModel: {
					providerID: "claude",
					modelID: "claude-opus-4-7",
				},
				defaultContextWindow: "1m",
			});
			const log = mockLogger();

			const layer = Layer.mergeAll(
				openCodeModelLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return handleGetModels("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "context_window_info",
						contextWindow: "1m",
						options: contextWindowOptions,
					});
				}),
			);
		},
	);
});

describe("handleSwitchModel", () => {
	it.effect("sets model override when client has a session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const overrides = mockOverrides();
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleSwitchModel("client-1", {
			modelId: "gpt-4",
			providerId: "openai",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.setModel).toHaveBeenCalledWith("session-42", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(log.info).toHaveBeenCalled();
			}),
		);
	});

	it.effect("returns Claude variants when switching to a Claude model", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const overrides = mockOverrides();
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleSwitchModel("client-1", {
			modelId: "opus",
			providerId: "claude",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(engine.dispatch).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(client.provider.list).not.toHaveBeenCalled();
				expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
					type: "variant_info",
					variant: "",
					variants: ["low", "medium", "high", "max"],
				});
			}),
		);
	});
});

describe("handleSwitchVariant", () => {
	it.effect("returns Claude variants when active model is Claude", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-42"),
		});
		const overrides = mockOverrides({
			getModel: vi.fn(() => ({
				providerID: "claude",
				modelID: "claude-opus-4-7",
			})),
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleSwitchVariant("client-1", { variant: "high" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(engine.dispatch).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(client.provider.list).not.toHaveBeenCalled();
				expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
					type: "variant_info",
					variant: "high",
					variants: ["low", "medium", "high", "max"],
				});
			}),
		);
	});

	it.effect(
		"falls back to OpenCode lookup when active model is not Claude",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-42"),
			});
			const overrides = mockOverrides({
				getModel: vi.fn(() => ({
					providerID: "openai",
					modelID: "gpt-4",
				})),
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(ConfigTag, config),
			);

			return handleSwitchVariant("client-1", { variant: "v2" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
						type: "variant_info",
						variant: "v2",
						variants: ["v2", "v3"],
					});
				}),
			);
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
			const overrides = mockOverrides({
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				})),
				getContextWindow: vi.fn(() => ""),
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
			const client = { provider: { list: vi.fn() } } as unknown as OpenCodeAPI;
			const log = mockLogger();

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return handleSwitchContextWindow("client-1", {
				contextWindow: "1m",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(overrides.setContextWindow).toHaveBeenCalledWith(
						"session-42",
						"1m",
					);
					expect(engine.dispatch).toHaveBeenCalledWith({
						type: "discover",
						providerId: "claude",
					});
					expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
						type: "context_window_info",
						contextWindow: "1m",
						options: contextWindowOptions,
					});
				}),
			);
		},
	);

	it.effect(
		"ignores unsupported context window and resends current state",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-42"),
			});
			const overrides = mockOverrides({
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-haiku-4-7",
				})),
				getContextWindow: vi.fn(() => ""),
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
			const client = { provider: { list: vi.fn() } } as unknown as OpenCodeAPI;
			const log = mockLogger();

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return handleSwitchContextWindow("client-1", {
				contextWindow: "1m",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(overrides.setContextWindow).not.toHaveBeenCalled();
					expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
						type: "context_window_info",
						contextWindow: "",
						options: [],
					});
				}),
			);
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
		list: vi.fn(() => Effect.void),
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
	overrides?: SessionOverrides;
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
	const sessionMgr = options?.sessionMgr ?? mockSessionManager();
	const sessionManagerService =
		options?.sessionManagerService ?? makeMockSessionManagerService();
	const overrides =
		options?.overrides ??
		mockOverrides({
			clearSession: vi.fn(),
			hasActiveProcessingTimeout: vi.fn(() => false),
		});
	const log = options?.log ?? mockLogger();

	return Layer.mergeAll(
		openCodeModelLayer(client),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(SessionManagerTag, sessionMgr),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
		Layer.succeed(SessionOverridesTag, overrides),
		Layer.succeed(LoggerTag, log),
		Layer.succeed(StatusPollerTag, {
			isProcessing: vi.fn(() => false),
			clearMessageActivity: vi.fn(),
		}),
		Layer.succeed(PollerManagerTag, {
			isPolling: vi.fn(() => true),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
		}),
	);
}

function makeSessionLifecycleLayer(options?: {
	client?: OpenCodeAPI;
	ws?: WebSocketHandlerShape;
	sessionMgr?: SessionManagerShape;
	sessionManagerService?: SessionManagerService;
	overrides?: SessionOverrides;
	log?: Logger;
}) {
	const ws = options?.ws ?? mockWsHandler();
	const sessionMgr = options?.sessionMgr ?? mockSessionManager();
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
	const overrides =
		options?.overrides ??
		mockOverrides({
			hasActiveProcessingTimeout: vi.fn(() => false),
		});
	const log = options?.log ?? mockLogger();

	return Layer.mergeAll(
		openCodeModelLayer(client),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(SessionManagerTag, sessionMgr),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
		Layer.succeed(SessionOverridesTag, overrides),
		Layer.succeed(LoggerTag, log),
		Layer.succeed(StatusPollerTag, {
			isProcessing: vi.fn(() => false),
			clearMessageActivity: vi.fn(),
		}),
		Layer.succeed(PollerManagerTag, {
			isPolling: vi.fn(() => true),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
		}),
	);
}

// ─── Tool Content handler tests ───────────────────────────────────────────

describe("handleGetToolContent", () => {
	it.effect(
		"returns tool content when readQuery is available and content exists",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const readQuery = {
				getToolContent: vi.fn(() => "full tool output text"),
			} as unknown as import("../../../src/lib/persistence/read-query-service.js").ReadQueryService;

			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(ReadQueryTag, readQuery),
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

		// No ReadQueryTag provided — serviceOption returns None
		const layer = Layer.succeed(WebSocketHandlerTag, ws);

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

describe("handlePtyClose", () => {
	it.effect("closes PTY through terminal service", () => {
		const terminal = mockTerminalService();

		const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

		return handlePtyClose("client-1", { ptyId: "pty-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(terminal.close).toHaveBeenCalledWith("pty-1");
			}),
		);
	});
});

describe("handlePtyResize", () => {
	it.effect("resizes PTY through terminal service", () => {
		const terminal = mockTerminalService();

		const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

		return handlePtyResize("client-1", {
			ptyId: "pty-1",
			cols: 120,
			rows: 40,
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(terminal.resize).toHaveBeenCalledWith(
					"client-1",
					"pty-1",
					40,
					120,
				);
			}),
		);
	});

	it.effect(
		"defaults resize dimensions before calling terminal service",
		() => {
			const terminal = mockTerminalService();

			const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

			return handlePtyResize("client-1", {
				ptyId: "pty-1",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(terminal.resize).toHaveBeenCalledWith(
						"client-1",
						"pty-1",
						24,
						80,
					);
				}),
			);
		},
	);
});

// ─── Instance handler tests ───────────────────────────────────────────────

function mockInstanceMgmt(): InstanceManagementDeps {
	const mockInstance = {
		id: "test-instance",
		name: "Test Instance",
		port: 3000,
		status: "stopped" as const,
		managed: true,
		restartCount: 0,
		createdAt: Date.now(),
	};
	return {
		getInstances: vi.fn(() => []),
		addInstance: vi.fn(() => mockInstance),
		removeInstance: vi.fn(),
		startInstance: vi.fn(async () => {}),
		stopInstance: vi.fn(),
		updateInstance: vi.fn(() => mockInstance),
		persistConfig: vi.fn(),
	};
}

describe("handleInstanceAdd", () => {
	it.effect("adds instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceAdd("client-1", { name: "Test Instance" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(instanceMgmt.addInstance).toHaveBeenCalled();
				expect(ws.broadcast).toHaveBeenCalledWith(
					expect.objectContaining({ type: "instance_list" }),
				);
				expect(instanceMgmt.persistConfig).toHaveBeenCalled();
			}),
		);
	});

	it.effect("sends error when instanceMgmt is not available", () => {
		const ws = mockWsHandler();

		// No InstanceMgmtTag provided — serviceOption returns None
		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleInstanceAdd("client-1", { name: "Test" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "Instance management not available",
				});
			}),
		);
	});
});

describe("handleInstanceRemove", () => {
	it.effect("removes instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceRemove("client-1", {
			instanceId: "test-instance",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(instanceMgmt.removeInstance).toHaveBeenCalledWith(
					"test-instance",
				);
				expect(instanceMgmt.persistConfig).toHaveBeenCalled();
			}),
		);
	});
});

describe("handleInstanceStart", () => {
	it.effect("starts instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceStart("client-1", {
			instanceId: "test-instance",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(instanceMgmt.startInstance).toHaveBeenCalledWith(
					"test-instance",
				);
				expect(ws.broadcast).toHaveBeenCalledWith(
					expect.objectContaining({ type: "instance_list" }),
				);
			}),
		);
	});
});

describe("handleInstanceStop", () => {
	it.effect("stops instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceStop("client-1", {
			instanceId: "test-instance",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(instanceMgmt.stopInstance).toHaveBeenCalledWith("test-instance");
			}),
		);
	});
});

describe("handleScanNow", () => {
	it.effect("sends error when scan deps not available", () => {
		const ws = mockWsHandler();

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleScanNow("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "Port scanning not available",
				});
			}),
		);
	});

	it.effect("sends scan result when available", () => {
		const ws = mockWsHandler();
		const scanDeps: ScanDeps = {
			triggerScan: vi.fn(async () => ({
				discovered: [8080],
				lost: [],
				active: [3000, 8080],
			})),
		};

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(ScanDepsTag, scanDeps),
		);

		return handleScanNow("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "scan_result",
					discovered: [8080],
					lost: [],
					active: [3000, 8080],
				});
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
		const overrides = mockOverrides({
			startProcessingTimeout: vi.fn(),
		});

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(SessionOverridesTag, overrides),
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
		const overrides = mockOverrides({
			startProcessingTimeout: vi.fn(),
		});
		const client = {
			question: { reject: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(SessionOverridesTag, overrides),
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
		"uses the pending question session when rejecting a Claude question from another visible session",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "visible-session"),
			});
			const log = mockLogger();
			const decrementPendingQuestionCount = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				decrementPendingQuestionCount,
			});
			const overrides = mockOverrides({
				startProcessingTimeout: vi.fn(),
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
				Layer.succeed(SessionOverridesTag, overrides),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordQuestionRequest({
					requestId: "que-claude",
					sessionId: "question-session",
					questions: [{ question: "Continue?" }],
				});
				yield* handleQuestionReject("client-1", { toolId: "que-claude" });
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.question.reject).not.toHaveBeenCalled();
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
			const overrides = mockOverrides({
				startProcessingTimeout: vi.fn(),
			});
			const client = {
				question: { reply: vi.fn(async () => {}) },
			} as unknown as OpenCodeAPI;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(SessionOverridesTag, overrides),
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
			const overrides = mockOverrides({
				startProcessingTimeout: vi.fn(),
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
				Layer.succeed(SessionOverridesTag, overrides),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
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

// ─── Session handler tests ───────────────────────────────────────────────

describe("handleListSessions", () => {
	it.effect("sends session list to client", () => {
		const ws = mockWsHandler();
		const sendDualSessionLists = vi.fn((send) =>
			Effect.sync(() => {
				send({
					type: "session_list",
					sessions: [
						{
							id: "session-1",
							title: "Session 1",
							updatedAt: 100,
							messageCount: 0,
						},
					],
					roots: true,
				});
			}),
		);

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(
				SessionManagerServiceTag,
				makeMockSessionManagerService({
					listSessions: vi.fn(() => Effect.succeed([])),
					createSession: vi.fn(() =>
						Effect.succeed({
							id: "session-new",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Session New",
							version: "1.0.0",
							time: { created: 0, updated: 0 },
						}),
					),
					sendDualSessionLists,
				}),
			),
		);

		return handleListSessions("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(sendDualSessionLists).toHaveBeenCalled();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_list",
					sessions: [
						{
							id: "session-1",
							title: "Session 1",
							updatedAt: 100,
							messageCount: 0,
						},
					],
					roots: true,
				});
			}),
		);
	});
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
						"Failed to broadcast session list after new_session",
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

describe("handleRenameSession", () => {
	it.effect(
		"renames through SessionManagerService and broadcasts lists",
		() => {
			const log = mockLogger();
			const legacyRenameSession = vi.fn(async () => {
				throw new Error("legacy renameSession should not be used");
			});
			const sessionMgr = mockSessionManager({
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
				Layer.succeed(SessionManagerTag, sessionMgr),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(WebSocketHandlerTag, ws),
			);

			return handleRenameSession("client-1", {
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
		const sessionMgr = mockSessionManager();
		const ws = mockWsHandler();
		const renameSession = vi.fn(() => Effect.void);
		const sendDualSessionLists = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			renameSession,
			sendDualSessionLists,
		});

		const layer = Layer.mergeAll(
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleRenameSession("client-1", {
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

describe("handleSearchSessions", () => {
	it.effect("searches service sessions and sends results", () => {
		const ws = mockWsHandler();
		const legacySearchSessions = vi.fn(async () => {
			throw new Error("legacy searchSessions should not be used");
		});
		const sessionMgr = mockSessionManager({
			searchSessions: legacySearchSessions,
		});
		const listSessions = vi.fn(() =>
			Effect.succeed([
				{
					id: "s1",
					title: "Match",
					updatedAt: 0,
					messageCount: 0,
				},
				{
					id: "s2",
					title: "Other",
					updatedAt: 0,
					messageCount: 0,
				},
			]),
		);
		const sessionManagerService = makeMockSessionManagerService({
			listSessions,
		});

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		);

		return handleSearchSessions("client-1", { query: "mat" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(listSessions).toHaveBeenCalledWith(undefined);
				expect(legacySearchSessions).not.toHaveBeenCalled();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_list",
					sessions: [
						{
							id: "s1",
							title: "Match",
							updatedAt: 0,
							messageCount: 0,
						},
					],
					roots: false,
					search: true,
				});
			}),
		);
	});

	it.effect("passes roots filtering to the service before searching", () => {
		const ws = mockWsHandler();
		const legacySearchSessions = vi.fn(async () => {
			throw new Error("legacy searchSessions should not be used");
		});
		const sessionMgr = mockSessionManager({
			searchSessions: legacySearchSessions,
		});
		const listSessions = vi.fn(() =>
			Effect.succeed([
				{
					id: "root-1",
					title: "Root Match",
					updatedAt: 0,
					messageCount: 0,
				},
			]),
		);
		const sessionManagerService = makeMockSessionManagerService({
			listSessions,
		});

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		);

		return handleSearchSessions("client-1", {
			query: "root",
			roots: true,
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(listSessions).toHaveBeenCalledWith({ roots: true });
				expect(legacySearchSessions).not.toHaveBeenCalled();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_list",
					sessions: [
						{
							id: "root-1",
							title: "Root Match",
							updatedAt: 0,
							messageCount: 0,
						},
					],
					roots: true,
					search: true,
				});
			}),
		);
	});
});

describe("handleLoadMoreHistory", () => {
	it.effect(
		"loads history page through SessionManagerService and sends to client",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
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
			const legacyLoadPreRenderedHistory = vi.fn(async () => {
				throw new Error("legacy loadPreRenderedHistory should not be used");
			});
			const sessionMgr = mockSessionManager({
				loadPreRenderedHistory: legacyLoadPreRenderedHistory,
			});
			const loadPreRenderedHistory = vi.fn(() => Effect.succeed(page));
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});

			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionManagerTag, sessionMgr),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			);

			return handleLoadMoreHistory("client-1", { offset: 50 }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1", 50);
					expect(legacyLoadPreRenderedHistory).not.toHaveBeenCalled();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "history_page",
						sessionId: "session-1",
						messages: page.messages,
						hasMore: true,
						total: 10,
					});
				}),
			);
		},
	);

	it.effect(
		"does nothing when no session id is available for load more",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const loadPreRenderedHistory = vi.fn(() =>
				Effect.succeed({ messages: [], hasMore: false }),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});

			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionManagerTag, mockSessionManager()),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			);

			return handleLoadMoreHistory("client-1", { offset: 50 }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(loadPreRenderedHistory).not.toHaveBeenCalled();
					expect(ws.sendTo).not.toHaveBeenCalledWith(
						"client-1",
						expect.objectContaining({ type: "history_page" }),
					);
				}),
			);
		},
	);
});

// ─── Prompt handler tests ─────────────────────────────────────────────────

describe("handleCancel", () => {
	it.effect("clears processing timeout and sends done when no engine", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const overrides = mockOverrides({
			clearProcessingTimeout: vi.fn(),
		});
		const client = {
			session: { abort: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		return handleCancel("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.clearProcessingTimeout).toHaveBeenCalledWith(
					"session-1",
				);
				expect(client.session.abort).toHaveBeenCalledWith("session-1");
				expect(ws.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "done",
					sessionId: "session-1",
					code: 1,
				});
			}),
		);
	});

	it.effect("does nothing when no active session", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const log = mockLogger();
		const overrides = mockOverrides();
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		return handleCancel("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendToSession).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleInputSync", () => {
	it.effect("forwards input to other clients in same session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1", "client-2"]),
		});

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleInputSync("client-1", { text: "hello" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				// Should send to client-2 but NOT client-1 (the sender)
				expect(ws.sendTo).toHaveBeenCalledWith("client-2", {
					type: "input_sync",
					text: "hello",
					from: "client-1",
				});
				expect(ws.sendTo).toHaveBeenCalledTimes(1);
			}),
		);
	});

	it.effect("does nothing when no session", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleInputSync("client-1", { text: "hello" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleRewind", () => {
	it.effect("reverts to a specific message and clears cursor", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const legacyClearPaginationCursor = vi.fn(() => {
			throw new Error("legacy clearPaginationCursor should not be used");
		});
		const sessionMgr = mockSessionManager({
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
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(LoggerTag, log),
		);

		return handleRewind("client-1", { messageId: "msg-1" }).pipe(
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
		const overrides = mockOverrides();
		const sessionManagerService = makeMockSessionManagerService();
		const config = mockConfig();
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
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
		const overrides = mockOverrides();
		const sessionManagerService = makeMockSessionManagerService();
		const config = mockConfig();
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
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
		const overrides = mockOverrides({
			getAgent: vi.fn(() => undefined),
			getModel: vi.fn(() => ({
				providerID: "claude",
				modelID: "claude-sonnet-4-5",
			})),
			getVariant: vi.fn(() => ""),
			getContextWindow: vi.fn(() => "1m"),
			isModelUserSelected: vi.fn(() => true),
			startProcessingTimeout: vi.fn(),
		});
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleMessage("client-1", { text: "hello world" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(engine.dispatch).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							contextWindow: "1m",
						}),
					}),
				);
			}),
		);
	});

	it.effect(
		"builds Claude event sinks from PendingInteractionService without bridge tags",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const overrides = mockOverrides({
				getAgent: vi.fn(() => undefined),
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				})),
				getVariant: vi.fn(() => ""),
				getContextWindow: vi.fn(() => ""),
				isModelUserSelected: vi.fn(() => true),
				startProcessingTimeout: vi.fn(),
				resetProcessingTimeout: vi.fn(),
			});
			const sessionManagerService = makeMockSessionManagerService();
			const config = mockConfig();
			const client = {} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async (command) => {
					if (
						typeof command === "object" &&
						command !== null &&
						"type" in command &&
						command.type === "send_turn"
					) {
						void command.input.eventSink.requestQuestion({
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
						});
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "hello world" });
				const pendingInteractions = yield* PendingInteractionServiceTag;
				const pendingQuestions =
					yield* pendingInteractions.listPendingQuestions("session-1");
				expect(pendingQuestions).toEqual([
					expect.objectContaining({
						requestId: "que-service-1",
						sessionId: "session-1",
					}),
				]);
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
			const overrides = mockOverrides({
				getAgent: vi.fn(() => "Plan"),
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				})),
				getVariant: vi.fn(() => ""),
				getContextWindow: vi.fn(() => ""),
				isModelUserSelected: vi.fn(() => true),
				startProcessingTimeout: vi.fn(),
			});
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
				getSessionMessagesWithParts: vi.fn(() => [
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
								duration: null,
								status: null,
								sort_order: 0,
								created_at: 1,
								updated_at: 1,
							},
						],
					},
				]),
			} as unknown as ReadQueryService;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(ReadQueryTag, readQuery),
			);

			return handleMessage("client-1", { text: "new prompt" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(readQuery.getSessionMessagesWithParts).toHaveBeenCalledWith(
						"session-1",
					);
					expect(engine.dispatch).toHaveBeenCalledWith(
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
		"loads prior Claude history through SessionManagerService when SQLite is unavailable",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const overrides = mockOverrides({
				getAgent: vi.fn(() => undefined),
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				})),
				getVariant: vi.fn(() => ""),
				getContextWindow: vi.fn(() => ""),
				isModelUserSelected: vi.fn(() => true),
				startProcessingTimeout: vi.fn(),
			});
			const legacyLoadPreRenderedHistory = vi.fn(async () => {
				throw new Error("legacy prompt history load should not be used");
			});
			const sessionMgr = mockSessionManager({
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerTag, sessionMgr),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return handleMessage("client-1", { text: "new prompt" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1");
					expect(legacyLoadPreRenderedHistory).not.toHaveBeenCalled();
					expect(engine.dispatch).toHaveBeenCalledWith(
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
		"auto-renames first Claude turn through SessionManagerService",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const overrides = mockOverrides({
				getAgent: vi.fn(() => undefined),
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				})),
				getVariant: vi.fn(() => ""),
				getContextWindow: vi.fn(() => ""),
				isModelUserSelected: vi.fn(() => true),
				startProcessingTimeout: vi.fn(),
			});
			const legacyListSessions = vi.fn(async () => {
				throw new Error("legacy auto-rename listSessions should not be used");
			});
			const legacyRenameSession = vi.fn(async () => {
				throw new Error("legacy auto-rename renameSession should not be used");
			});
			const sessionMgr = mockSessionManager({
				listSessions: legacyListSessions,
				renameSession: legacyRenameSession,
			});
			const listSessions = vi.fn(() =>
				Effect.succeed([
					{
						id: "session-1",
						title: "Claude Session",
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerTag, sessionMgr),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "First prompt" });
				yield* flushDispatchContinuation();

				expect(listSessions).toHaveBeenCalledWith();
				expect(renameSession).toHaveBeenCalledWith("session-1", "First prompt");
				expect(sendDualSessionLists).toHaveBeenCalled();
				expect(ws.broadcast).toHaveBeenCalledWith({
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
				expect(legacyListSessions).not.toHaveBeenCalled();
				expect(legacyRenameSession).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("does not auto-rename Claude sessions with custom titles", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1"]),
		});
		const log = mockLogger();
		const overrides = mockOverrides({
			getAgent: vi.fn(() => undefined),
			getModel: vi.fn(() => ({
				providerID: "claude",
				modelID: "claude-sonnet-4-5",
			})),
			getVariant: vi.fn(() => ""),
			getContextWindow: vi.fn(() => ""),
			isModelUserSelected: vi.fn(() => true),
			startProcessingTimeout: vi.fn(),
		});
		const sessionMgr = mockSessionManager();
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return Effect.gen(function* () {
			yield* handleMessage("client-1", { text: "First prompt" });
			yield* flushDispatchContinuation();

			expect(listSessions).toHaveBeenCalledWith();
			expect(renameSession).not.toHaveBeenCalled();
			expect(sendDualSessionLists).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"keeps dispatch rejection recovery after launching continuation",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const log = mockLogger();
			const overrides = mockOverrides({
				getAgent: vi.fn(() => undefined),
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				})),
				getVariant: vi.fn(() => ""),
				getContextWindow: vi.fn(() => ""),
				isModelUserSelected: vi.fn(() => true),
				startProcessingTimeout: vi.fn(),
				clearProcessingTimeout: vi.fn(),
			});
			const sessionMgr = mockSessionManager();
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerTag, sessionMgr),
				Layer.succeed(SessionManagerServiceTag, sessionManagerService),
				Layer.succeed(ConfigTag, config),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "First prompt" });
				yield* flushDispatchContinuation();

				expect(overrides.clearProcessingTimeout).toHaveBeenCalledWith(
					"session-1",
				);
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
		const overrides = mockOverrides({
			getAgent: vi.fn(() => undefined),
			getModel: vi.fn(() => undefined),
			getVariant: vi.fn(() => ""),
			isModelUserSelected: vi.fn(() => false),
			startProcessingTimeout: vi.fn(),
		});
		const legacyRecordMessageActivity = vi.fn(() => {
			throw new Error("legacy recordMessageActivity should not be used");
		});
		const sessionMgr = mockSessionManager({
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionManagerServiceTag, sessionManagerService),
			Layer.succeed(ConfigTag, config),
			PendingInteractionServiceLive,
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
