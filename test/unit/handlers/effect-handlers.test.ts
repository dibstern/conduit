// ─── Effect Handler Tests (Batch 1) ─────────────────────────────────────────
// Verifies that the new *Effect handler implementations produce the same
// observable side effects as the original handlers when run against a mock
// Layer. Each test provides minimal mock services via Layer.succeed, runs
// the Effect to completion, and asserts on captured calls.

import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketHandlerShape } from "../../../src/lib/effect/services.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
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
	handleGetModelsEffect,
	handleSwitchModelEffect,
} from "../../../src/lib/handlers/model.js";

import { handleReloadProviderSessionEffect } from "../../../src/lib/handlers/reload.js";
import {
	handleGetCommandsEffect,
	handleGetProjectsEffect,
	handleGetTodoEffect,
} from "../../../src/lib/handlers/settings.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { SessionOverrides } from "../../../src/lib/session/session-overrides.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

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
	it("fetches agents via OpenCodeAPI and sends filtered list to client", async () => {
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

		await Effect.runPromise(
			handleGetAgentsEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

		expect(client.app.agents).toHaveBeenCalledOnce();
		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			agents: filterAgents(mockAgents),
		});
	});
});

describe("handleSwitchAgentEffect", () => {
	it("sets agent override when client has a session", async () => {
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

		await Effect.runPromise(
			handleSwitchAgentEffect("client-1", { agentId: "plan" }).pipe(
				Effect.provide(layer),
			),
		);

		expect(overrides.setAgent).toHaveBeenCalledWith("session-42", "plan");
		expect(log.info).toHaveBeenCalledOnce();
	});

	it("warns when no session is assigned", async () => {
		const ws = mockWsHandler({ getClientSession: vi.fn(() => undefined) });
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		await Effect.runPromise(
			handleSwitchAgentEffect("client-1", { agentId: "build" }).pipe(
				Effect.provide(layer),
			),
		);

		expect(overrides.setAgent).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledOnce();
	});

	it("does nothing when agentId is empty", async () => {
		const ws = mockWsHandler();
		const overrides = mockOverrides();
		const log = mockLogger();

		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
		);

		await Effect.runPromise(
			handleSwitchAgentEffect("client-1", { agentId: "" }).pipe(
				Effect.provide(layer),
			),
		);

		expect(overrides.setAgent).not.toHaveBeenCalled();
		expect(log.info).not.toHaveBeenCalled();
	});
});

// ─── Settings handler tests ────────────────────────────────────────────────

describe("handleGetCommandsEffect", () => {
	it("fetches commands and sends to client", async () => {
		const ws = mockWsHandler();
		const mockCommands = [{ name: "test" }];
		const client = {
			app: { commands: vi.fn(async () => mockCommands) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		await Effect.runPromise(
			handleGetCommandsEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

		expect(client.app.commands).toHaveBeenCalledOnce();
		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "command_list",
			commands: mockCommands,
		});
	});
});

describe("handleGetTodoEffect", () => {
	it("sends empty todo list", async () => {
		const ws = mockWsHandler();

		const layer = Layer.succeed(WebSocketHandlerTag, ws);

		await Effect.runPromise(
			handleGetTodoEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "todo_state",
			items: [],
		});
	});
});

describe("handleGetProjectsEffect", () => {
	it("uses config.getProjects when available", async () => {
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

		await Effect.runPromise(
			handleGetProjectsEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "project_list",
			projects,
			current: "test-project",
		});
	});

	it("falls back to client.app.projects when getProjects is not available", async () => {
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

		await Effect.runPromise(
			handleGetProjectsEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

		expect(client.app.projects).toHaveBeenCalledOnce();
		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "project_list",
			projects: [{ slug: "p1", title: "Proj 1", directory: "/proj1" }],
			current: "test-project",
		});
	});
});

// ─── File handler tests ────────────────────────────────────────────────────

describe("handleGetFileContentEffect", () => {
	it("reads file content and sends to client", async () => {
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

		await Effect.runPromise(
			handleGetFileContentEffect("client-1", { path: "README.md" }).pipe(
				Effect.provide(layer),
			),
		);

		expect(client.file.read).toHaveBeenCalledWith("README.md");
		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "file_content",
			path: "README.md",
			content: "hello world",
		});
	});

	it("does nothing when path is empty", async () => {
		const ws = mockWsHandler();
		const client = {
			file: { read: vi.fn() },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		await Effect.runPromise(
			handleGetFileContentEffect("client-1", { path: "" }).pipe(
				Effect.provide(layer),
			),
		);

		expect(client.file.read).not.toHaveBeenCalled();
		expect(ws.sendTo).not.toHaveBeenCalled();
	});
});

describe("handleGetFileListEffect", () => {
	it("lists files and filters with gitignore rules", async () => {
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

		await Effect.runPromise(
			handleGetFileListEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "file_list",
			path: ".",
			entries: [
				{ name: "src", type: "directory" },
				{ name: "README.md", type: "file" },
			],
		});
	});
});

// ─── Reload handler tests ──────────────────────────────────────────────────

describe("handleReloadProviderSessionEffect", () => {
	it("sends error when no active session", async () => {
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

		await Effect.runPromise(
			handleReloadProviderSessionEffect("client-1", {}).pipe(
				Effect.provide(layer),
			),
		);

		expect(ws.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "system_error",
				code: "NO_SESSION",
			}),
		);
	});

	it("reloads provider session and refreshes models/commands", async () => {
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

		await Effect.runPromise(
			handleReloadProviderSessionEffect("client-1", {}).pipe(
				Effect.provide(layer),
			),
		);

		// Should have dispatched end_session
		expect(engine.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "end_session", sessionId: "session-42" }),
		);

		// Should have sent provider_session_reloaded
		expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
			type: "provider_session_reloaded",
			sessionId: "session-42",
		});
	});
});

// ─── Model handler tests ──────────────────────────────────────────────────

describe("handleGetModelsEffect", () => {
	it("fetches providers and sends model_list to client", async () => {
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

		await Effect.runPromise(
			handleGetModelsEffect("client-1", {}).pipe(Effect.provide(layer)),
		);

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
	});
});

describe("handleSwitchModelEffect", () => {
	it("sets model override when client has a session", async () => {
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

		await Effect.runPromise(
			handleSwitchModelEffect("client-1", {
				modelId: "gpt-4",
				providerId: "openai",
			}).pipe(Effect.provide(layer)),
		);

		expect(overrides.setModel).toHaveBeenCalledWith("session-42", {
			providerID: "openai",
			modelID: "gpt-4",
		});
		expect(log.info).toHaveBeenCalled();
	});
});
