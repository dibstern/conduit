import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceLive } from "../../../src/lib/domain/relay/Services/agent-service.js";
import {
	LoggerTag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getAgent,
	makeOverridesStateLive,
	setAgent,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { handleGetAgents } from "../../../src/lib/handlers/agent.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";

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

function agentHandlerLayer({
	client,
	ws,
	engine,
	log = mockLogger(),
}: {
	client: OpenCodeAPI;
	ws: WebSocketHandlerShape;
	engine?: OrchestrationEngine;
	log?: Logger;
}) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	const wsLayer = Layer.succeed(WebSocketHandlerTag, ws);
	const overridesLayer = makeOverridesStateLive();
	const logLayer = Layer.succeed(LoggerTag, log);
	const deps =
		engine == null
			? Layer.mergeAll(apiLayer, wsLayer, overridesLayer, logLayer)
			: Layer.mergeAll(
					apiLayer,
					wsLayer,
					overridesLayer,
					logLayer,
					Layer.succeed(OrchestrationEngineTag, engine),
				);
	return Layer.provideMerge(AgentServiceLive, deps);
}

describe("handleGetAgents active provider", () => {
	it.effect("returns Claude agents for a Claude-bound active session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = {
			app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
		} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatchEffect: vi.fn(() =>
				Effect.succeed({
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
						{
							id: "Review",
							name: "Review",
							description: "Reviewer",
							model: "opus",
						},
					],
				}),
			),
		} as unknown as OrchestrationEngine;

		return Effect.gen(function* () {
			yield* setAgent("session-1", "Explore");
			yield* handleGetAgents("client-1", {});
			expect(client.app.agents).not.toHaveBeenCalled();
			expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
				type: "agent_list",
				agents: [
					{ id: "Explore", name: "Explore", description: "Explorer" },
					{
						id: "Review",
						name: "Review",
						description: "Reviewer",
						model: "opus",
					},
				],
				activeAgentId: "Explore",
			});
		}).pipe(Effect.provide(agentHandlerLayer({ client, ws, engine })));
	});

	it.effect(
		"returns all Claude agents regardless of active Claude model",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const client = {
				app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatchEffect: vi.fn(() =>
					Effect.succeed({
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
							{ id: "Any", name: "Any" },
							{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
							{ id: "SonnetOnly", name: "SonnetOnly", model: "sonnet" },
							{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
						],
					}),
				),
			} as unknown as OrchestrationEngine;

			return handleGetAgents("client-1", {}).pipe(
				Effect.provide(agentHandlerLayer({ client, ws, engine })),
				Effect.tap(() => {
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "agent_list",
						agents: [
							{ id: "Any", name: "Any" },
							{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
							{ id: "SonnetOnly", name: "SonnetOnly", model: "sonnet" },
							{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
						],
					});
				}),
			);
		},
	);

	it.effect(
		"returns OpenCode agents for an OpenCode-bound active session",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const rawAgents = [
				{ id: "build", name: "build", mode: "primary" as const },
				{ id: "title", name: "title", mode: "subagent" as const, hidden: true },
			];
			const client = {
				app: { agents: vi.fn(async () => rawAgents) },
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "opencode"),
				dispatchEffect: vi.fn(),
			} as unknown as OrchestrationEngine;

			return handleGetAgents("client-1", {}).pipe(
				Effect.provide(agentHandlerLayer({ client, ws, engine })),
				Effect.tap(() => {
					expect(engine.dispatchEffect).not.toHaveBeenCalled();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "agent_list",
						agents: [{ id: "build", name: "build" }],
					});
				}),
			);
		},
	);

	it.effect("preserves OpenCode behavior when no active session exists", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => undefined),
		});
		const client = {
			app: {
				agents: vi.fn(async () => [
					{ id: "build", name: "build", mode: "primary" as const },
				]),
			},
		} as unknown as OpenCodeAPI;

		return handleGetAgents("client-1", {}).pipe(
			Effect.provide(agentHandlerLayer({ client, ws })),
			Effect.tap(() => {
				expect(client.app.agents).toHaveBeenCalledOnce();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "agent_list",
					agents: [{ id: "build", name: "build" }],
				});
			}),
		);
	});

	it.effect("clears stale stored agent not present in active list", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = {
			app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
		} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatchEffect: vi.fn(() =>
				Effect.succeed({
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
				}),
			),
		} as unknown as OrchestrationEngine;

		return Effect.gen(function* () {
			yield* setAgent("session-1", "Missing");
			yield* handleGetAgents("client-1", {});
			expect(yield* getAgent("session-1")).toBeUndefined();
			expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
				type: "agent_list",
				agents: [{ id: "Explore", name: "Explore" }],
			});
		}).pipe(Effect.provide(agentHandlerLayer({ client, ws, engine })));
	});
});
