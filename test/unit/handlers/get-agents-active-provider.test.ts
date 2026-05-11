import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	OpenCodeAPITag,
	OrchestrationEngineTag,
	SessionOverridesTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { handleGetAgents } from "../../../src/lib/handlers/agent.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { SessionOverrides } from "../../../src/lib/session/session-overrides.js";

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

function mockOverrides(
	overrides?: Partial<SessionOverrides>,
): SessionOverrides {
	return {
		getModel: vi.fn(() => undefined),
		getAgent: vi.fn(() => undefined),
		clearAgent: vi.fn(),
		...overrides,
	} as unknown as SessionOverrides;
}

describe("handleGetAgents active provider", () => {
	it.effect("returns Claude agents for a Claude-bound active session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = {
			app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
		} as unknown as OpenCodeAPI;
		const overrides = mockOverrides({
			getAgent: vi.fn(() => "Explore"),
			getModel: vi.fn(() => ({
				providerID: "claude",
				modelID: "claude-sonnet-4-7",
			})),
		});
		const engine = {
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
					{
						id: "Review",
						name: "Review",
						description: "Reviewer",
						model: "opus",
					},
				],
			})),
		} as unknown as OrchestrationEngine;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, engine),
			Layer.succeed(SessionOverridesTag, overrides),
		);

		return handleGetAgents("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
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
			}),
		);
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
			const overrides = mockOverrides({
				getModel: vi.fn(() => ({
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				})),
			});
			const engine = {
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
						{ id: "Any", name: "Any" },
						{ id: "OpusOnly", name: "OpusOnly", model: "opus" },
						{ id: "SonnetOnly", name: "SonnetOnly", model: "sonnet" },
						{ id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
					],
				})),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(SessionOverridesTag, overrides),
			);

			return handleGetAgents("client-1", {}).pipe(
				Effect.provide(layer),
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
				dispatch: vi.fn(),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(SessionOverridesTag, mockOverrides()),
			);

			return handleGetAgents("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(engine.dispatch).not.toHaveBeenCalled();
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
		const overrides = mockOverrides({
			getAgent: vi.fn(() => "Missing"),
			getModel: vi.fn(() => ({
				providerID: "claude",
				modelID: "claude-opus-4-7",
			})),
		});
		const engine = {
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
		} as unknown as OrchestrationEngine;

		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, engine),
			Layer.succeed(SessionOverridesTag, overrides),
		);

		return handleGetAgents("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(overrides.clearAgent).toHaveBeenCalledWith("session-1");
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "agent_list",
					agents: [{ id: "Explore", name: "Explore" }],
				});
			}),
		);
	});
});
