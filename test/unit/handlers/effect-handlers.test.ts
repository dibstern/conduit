// ─── Effect Handler Tests (Batch 1) ─────────────────────────────────────────
// Verifies that the new *Effect handler implementations produce the same
// observable side effects as the original handlers when run against a mock
// Layer. Each test provides minimal mock services via Layer.succeed, runs
// the Effect to completion, and asserts on captured calls.

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import type { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import type { QuestionBridge } from "../../../src/lib/bridges/question-bridge.js";
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
	OrchestrationEngineTag,
	PermissionBridgeTag,
	PtyManagerTag,
	QuestionBridgeTag,
	ReadQueryTag,
	ScanDepsTag,
	SessionManagerTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	filterAgents,
	handleGetAgentsEffect,
	handleSwitchAgentEffect,
} from "../../../src/lib/handlers/agent.js";
import {
	handleGetFileContentEffect,
	handleGetFileListEffect,
} from "../../../src/lib/handlers/files.js";
import {
	handleInstanceAddEffect,
	handleInstanceRemoveEffect,
	handleInstanceStartEffect,
	handleInstanceStopEffect,
	handleScanNowEffect,
} from "../../../src/lib/handlers/instance.js";
import {
	handleGetModelsEffect,
	handleSwitchModelEffect,
} from "../../../src/lib/handlers/model.js";
import {
	handlePermissionResponseEffect,
	handleQuestionRejectEffect,
} from "../../../src/lib/handlers/permissions.js";
import {
	handleCancelEffect,
	handleInputSyncEffect,
	handleMessageEffect,
	handleRewindEffect,
} from "../../../src/lib/handlers/prompt.js";
import { handleReloadProviderSessionEffect } from "../../../src/lib/handlers/reload.js";
import {
	handleListSessionsEffect,
	handleLoadMoreHistoryEffect,
	handleRenameSessionEffect,
	handleSearchSessionsEffect,
} from "../../../src/lib/handlers/session.js";
import {
	handleGetCommandsEffect,
	handleGetProjectsEffect,
	handleGetTodoEffect,
} from "../../../src/lib/handlers/settings.js";
import {
	handlePtyCloseEffect,
	handlePtyInputEffect,
	handlePtyResizeEffect,
} from "../../../src/lib/handlers/terminal.js";
import { handleGetToolContentEffect } from "../../../src/lib/handlers/tool-content.js";
import type {
	InstanceManagementDeps,
	ScanDeps,
} from "../../../src/lib/handlers/types.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { PtyManager } from "../../../src/lib/relay/pty-manager.js";
import type { SessionOverrides } from "../../../src/lib/session/session-overrides.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import type {
	OpenCodeDecision,
	ProjectRelayConfig,
} from "../../../src/lib/types.js";

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

function mockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
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
		getModel: vi.fn(),
		getVariant: vi.fn(),
		setDefaultModel: vi.fn(),
		defaultModel: undefined,
		defaultVariant: "",
		...overrides,
	} as unknown as SessionOverrides;
}

// ─── Agent handler tests ───────────────────────────────────────────────────

describe("handleGetAgentsEffect", () => {
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

			return handleGetAgentsEffect("client-1", {}).pipe(
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

describe("handleSwitchAgentEffect", () => {
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

		return handleSwitchAgentEffect("client-1", { agentId: "plan" }).pipe(
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

		return handleSwitchAgentEffect("client-1", { agentId: "build" }).pipe(
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

		return handleSwitchAgentEffect("client-1", { agentId: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.setAgent).not.toHaveBeenCalled();
				expect(log.info).not.toHaveBeenCalled();
			}),
		);
	});
});

// ─── Settings handler tests ────────────────────────────────────────────────

describe("handleGetCommandsEffect", () => {
	it.effect("fetches commands and sends to client", () => {
		const ws = mockWsHandler();
		const mockCommands = [{ name: "test" }];
		const client = {
			app: { commands: vi.fn(async () => mockCommands) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetCommandsEffect("client-1", {}).pipe(
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

describe("handleGetTodoEffect", () => {
	it.effect("sends empty todo list", () => {
		const ws = mockWsHandler();

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleGetTodoEffect("client-1", {}).pipe(
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

describe("handleGetProjectsEffect", () => {
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(ConfigTag, config),
		);

		return handleGetProjectsEffect("client-1", {}).pipe(
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
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(ConfigTag, config),
			);

			return handleGetProjectsEffect("client-1", {}).pipe(
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

describe("handleGetFileContentEffect", () => {
	it.effect("reads file content and sends to client", () => {
		const ws = mockWsHandler();
		const client = {
			file: {
				read: vi.fn(async () => ({ content: "hello world" })),
			},
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetFileContentEffect("client-1", { path: "README.md" }).pipe(
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetFileContentEffect("client-1", { path: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.file.read).not.toHaveBeenCalled();
				expect(ws.sendTo).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleGetFileListEffect", () => {
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetFileListEffect("client-1", {}).pipe(
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

describe("handleReloadProviderSessionEffect", () => {
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(ConfigTag, config),
		);

		return handleReloadProviderSessionEffect("client-1", {}).pipe(
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(ConfigTag, config),
		);

		return handleReloadProviderSessionEffect("client-1", {}).pipe(
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

describe("handleGetModelsEffect", () => {
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleGetModelsEffect("client-1", {}).pipe(
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
});

describe("handleSwitchModelEffect", () => {
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
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(OrchestrationEngineTag, engine),
		);

		return handleSwitchModelEffect("client-1", {
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

function mockPermissionBridge(
	overrides?: Partial<PermissionBridge>,
): PermissionBridge {
	return {
		onPermissionResponse: vi.fn(() => null),
		getPending: vi.fn(() => []),
		...overrides,
	} as unknown as PermissionBridge;
}

function mockQuestionBridge(
	overrides?: Partial<QuestionBridge>,
): QuestionBridge {
	return {
		getPending: vi.fn(() => []),
		...overrides,
	} as unknown as QuestionBridge;
}

function mockPtyManager(overrides?: Partial<PtyManager>): PtyManager {
	return {
		closeSession: vi.fn(),
		sendInput: vi.fn(),
		hasSession: vi.fn(() => false),
		...overrides,
	} as unknown as PtyManager;
}

// ─── Tool Content handler tests ───────────────────────────────────────────

describe("handleGetToolContentEffect", () => {
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

			return handleGetToolContentEffect("client-1", { toolId: "tool-42" }).pipe(
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

		return handleGetToolContentEffect("client-1", { toolId: "tool-42" }).pipe(
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

// ─── Terminal handler tests ───────────────────────────────────────────────

describe("handlePtyInputEffect", () => {
	it.effect("sends input to pty manager", () => {
		const ptyManager = mockPtyManager();

		const layer = Layer.succeed(PtyManagerTag, ptyManager);

		return handlePtyInputEffect("client-1", {
			ptyId: "pty-1",
			data: "ls\n",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ptyManager.sendInput).toHaveBeenCalledWith("pty-1", "ls\n");
			}),
		);
	});

	it.effect("does nothing when ptyId is empty", () => {
		const ptyManager = mockPtyManager();

		const layer = Layer.succeed(PtyManagerTag, ptyManager);

		return handlePtyInputEffect("client-1", { ptyId: "", data: "ls\n" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ptyManager.sendInput).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handlePtyCloseEffect", () => {
	it.effect("closes PTY session and broadcasts deletion", () => {
		const ws = mockWsHandler();
		const ptyManager = mockPtyManager();
		const client = {
			pty: { delete: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(PtyManagerTag, ptyManager),
		);

		return handlePtyCloseEffect("client-1", { ptyId: "pty-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ptyManager.closeSession).toHaveBeenCalledWith("pty-1");
				expect(client.pty.delete).toHaveBeenCalledWith("pty-1");
				expect(ws.broadcast).toHaveBeenCalledWith({
					type: "pty_deleted",
					ptyId: "pty-1",
				});
			}),
		);
	});
});

describe("handlePtyResizeEffect", () => {
	it.effect("resizes PTY without errors", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const client = {
			pty: { resize: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
		);

		return handlePtyResizeEffect("client-1", {
			ptyId: "pty-1",
			cols: 120,
			rows: 40,
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.pty.resize).toHaveBeenCalledWith("pty-1", 40, 120);
			}),
		);
	});

	it.effect("logs warning on resize failure (non-fatal)", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const client = {
			pty: {
				resize: vi.fn(async () => {
					throw new Error("resize failed");
				}),
			},
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
		);

		return handlePtyResizeEffect("client-1", {
			ptyId: "pty-1",
			cols: 120,
			rows: 40,
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(log.warn).toHaveBeenCalled();
			}),
		);
	});
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

describe("handleInstanceAddEffect", () => {
	it.effect("adds instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceAddEffect("client-1", { name: "Test Instance" }).pipe(
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

		return handleInstanceAddEffect("client-1", { name: "Test" }).pipe(
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

describe("handleInstanceRemoveEffect", () => {
	it.effect("removes instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceRemoveEffect("client-1", {
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

describe("handleInstanceStartEffect", () => {
	it.effect("starts instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceStartEffect("client-1", {
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

describe("handleInstanceStopEffect", () => {
	it.effect("stops instance and broadcasts list", () => {
		const ws = mockWsHandler();
		const instanceMgmt = mockInstanceMgmt();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);

		return handleInstanceStopEffect("client-1", {
			instanceId: "test-instance",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(instanceMgmt.stopInstance).toHaveBeenCalledWith("test-instance");
			}),
		);
	});
});

describe("handleScanNowEffect", () => {
	it.effect("sends error when scan deps not available", () => {
		const ws = mockWsHandler();

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleScanNowEffect("client-1", {}).pipe(
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

		return handleScanNowEffect("client-1", {}).pipe(
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

describe("handlePermissionResponseEffect", () => {
	it.effect("processes permission response and broadcasts resolution", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const permissionBridge = mockPermissionBridge({
			onPermissionResponse: vi.fn(() => ({
				toolName: "Bash",
				mapped: "once" as OpenCodeDecision,
			})),
		});
		const client = {
			permission: { reply: vi.fn(async () => {}) },
			config: { get: vi.fn(async () => ({})) },
		} as unknown as OpenCodeAPI;
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(PermissionBridgeTag, permissionBridge),
			Layer.succeed(ConfigTag, config),
		);

		return handlePermissionResponseEffect("client-1", {
			requestId: "perm-1" as PermissionId,
			decision: "allow",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(permissionBridge.onPermissionResponse).toHaveBeenCalledWith(
					"perm-1",
					"allow",
				);
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
		const permissionBridge = mockPermissionBridge({
			onPermissionResponse: vi.fn(() => null),
		});
		const client = {
			permission: { reply: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;
		const config = mockConfig();

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(PermissionBridgeTag, permissionBridge),
			Layer.succeed(ConfigTag, config),
		);

		return handlePermissionResponseEffect("client-1", {
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

describe("handleQuestionRejectEffect", () => {
	it.effect("does nothing when toolId is empty", () => {
		const ws = mockWsHandler();
		const log = mockLogger();
		const client = {} as unknown as OpenCodeAPI;
		const sessionMgr = mockSessionManager();
		const overrides = mockOverrides({
			startProcessingTimeout: vi.fn(),
		});

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionOverridesTag, overrides),
		);

		return handleQuestionRejectEffect("client-1", { toolId: "" }).pipe(
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
		const sessionMgr = mockSessionManager();
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
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionOverridesTag, overrides),
		);

		return handleQuestionRejectEffect("client-1", { toolId: "que-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.question.reject).toHaveBeenCalledWith("que-1");
				expect(ws.broadcast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "ask_user_resolved",
						toolId: "que-1",
					}),
				);
				expect(sessionMgr.decrementPendingQuestionCount).toHaveBeenCalledWith(
					"session-1",
				);
			}),
		);
	});
});

// ─── Session handler tests ───────────────────────────────────────────────

describe("handleListSessionsEffect", () => {
	it.effect("sends session list to client", () => {
		const ws = mockWsHandler();
		const sessionMgr = mockSessionManager();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
		);

		return handleListSessionsEffect("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(sessionMgr.sendDualSessionLists).toHaveBeenCalled();
			}),
		);
	});
});

describe("handleRenameSessionEffect", () => {
	it.effect("renames session and logs", () => {
		const log = mockLogger();
		const sessionMgr = mockSessionManager();

		const layer = Layer.mergeAll(
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
		);

		return handleRenameSessionEffect("client-1", {
			sessionId: "session-1",
			title: "New Title",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(sessionMgr.renameSession).toHaveBeenCalledWith(
					"session-1",
					"New Title",
				);
				expect(log.info).toHaveBeenCalled();
			}),
		);
	});

	it.effect("does nothing when id or title is empty", () => {
		const log = mockLogger();
		const sessionMgr = mockSessionManager();

		const layer = Layer.mergeAll(
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
		);

		return handleRenameSessionEffect("client-1", {
			sessionId: "",
			title: "New Title",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(sessionMgr.renameSession).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleSearchSessionsEffect", () => {
	it.effect("searches sessions and sends results", () => {
		const ws = mockWsHandler();
		const results = [{ id: "s1", title: "Match", updatedAt: 0 }];
		const sessionMgr = mockSessionManager({
			searchSessions: vi.fn(async () => results),
		});

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
		);

		return handleSearchSessionsEffect("client-1", { query: "test" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(sessionMgr.searchSessions).toHaveBeenCalledWith(
					"test",
					undefined,
				);
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_list",
					sessions: results,
					roots: false,
					search: true,
				});
			}),
		);
	});
});

describe("handleLoadMoreHistoryEffect", () => {
	it.effect("loads history page and sends to client", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const page = { messages: [], hasMore: false };
		const sessionMgr = mockSessionManager({
			loadPreRenderedHistory: vi.fn(async () => page),
		});

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
		);

		return handleLoadMoreHistoryEffect("client-1", { offset: 50 }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
					"session-1",
					50,
				);
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "history_page",
					sessionId: "session-1",
					messages: [],
					hasMore: false,
				});
			}),
		);
	});
});

// ─── Prompt handler tests ─────────────────────────────────────────────────

describe("handleCancelEffect", () => {
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

		return handleCancelEffect("client-1", {}).pipe(
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

		return handleCancelEffect("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendToSession).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleInputSyncEffect", () => {
	it.effect("forwards input to other clients in same session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => ["client-1", "client-2"]),
		});

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		return handleInputSyncEffect("client-1", { text: "hello" }).pipe(
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

		return handleInputSyncEffect("client-1", { text: "hello" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).not.toHaveBeenCalled();
			}),
		);
	});
});

describe("handleRewindEffect", () => {
	it.effect("reverts to a specific message and clears cursor", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const log = mockLogger();
		const sessionMgr = mockSessionManager();
		const client = {
			session: { revert: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(LoggerTag, log),
		);

		return handleRewindEffect("client-1", { messageId: "msg-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.session.revert).toHaveBeenCalledWith("session-1", {
					messageID: "msg-1",
				});
				expect(sessionMgr.clearPaginationCursor).toHaveBeenCalledWith(
					"session-1",
				);
				expect(log.info).toHaveBeenCalled();
			}),
		);
	});
});

describe("handleMessageEffect", () => {
	it.effect("sends error when no active session", () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const log = mockLogger();
		const overrides = mockOverrides();
		const sessionMgr = mockSessionManager();
		const config = mockConfig();
		const permissionBridge = mockPermissionBridge();
		const questionBridge = mockQuestionBridge();
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(PermissionBridgeTag, permissionBridge),
			Layer.succeed(QuestionBridgeTag, questionBridge),
		);

		return handleMessageEffect("client-1", { text: "hello" }).pipe(
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
		const sessionMgr = mockSessionManager();
		const config = mockConfig();
		const permissionBridge = mockPermissionBridge();
		const questionBridge = mockQuestionBridge();
		const client = {} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(PermissionBridgeTag, permissionBridge),
			Layer.succeed(QuestionBridgeTag, questionBridge),
		);

		return handleMessageEffect("client-1", { text: "" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ws.sendTo).not.toHaveBeenCalled();
				expect(ws.sendToSession).not.toHaveBeenCalled();
			}),
		);
	});

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
		const sessionMgr = mockSessionManager();
		const config = mockConfig();
		const permissionBridge = mockPermissionBridge();
		const questionBridge = mockQuestionBridge();
		const client = {
			session: { prompt: vi.fn(async () => {}) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(PermissionBridgeTag, permissionBridge),
			Layer.succeed(QuestionBridgeTag, questionBridge),
		);

		return handleMessageEffect("client-1", { text: "hello world" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.session.prompt).toHaveBeenCalledWith("session-1", {
					text: "hello world",
				});
				expect(sessionMgr.recordMessageActivity).toHaveBeenCalledWith(
					"session-1",
				);
			}),
		);
	});
});
