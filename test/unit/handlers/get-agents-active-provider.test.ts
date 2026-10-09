import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { GetAgents } from "../../../src/lib/contracts/ws-rpc.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceLive } from "../../../src/lib/domain/relay/Services/agent-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getAgent,
	makeOverridesStateLive,
	setAgent,
	setDefaultModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { OrchestrationEngine as OrchestrationEngineLive } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { modelsHandlers } from "../../../src/lib/server/ws-rpc/models.js";
import {
	makeHandlerLogger,
	makeHandlerOpenCodeAPI,
} from "../../helpers/handler-fakes.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function mockWsHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): WebSocketHandlerShape {
	return {
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		registerSessionViewer: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		...overrides,
	};
}

function agentHandlerLayer({
	client,
	ws,
	engine,
	log = makeHandlerLogger(),
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
	const deps = Layer.mergeAll(
		apiLayer,
		wsLayer,
		overridesLayer,
		logLayer,
		Layer.succeed(ConfigTag, makeMockConfig()),
		Layer.succeed(
			OrchestrationEngineTag,
			engine ??
				new OrchestrationEngineLive({ registry: new ProviderRegistry() }),
		),
	);
	return Layer.provideMerge(AgentServiceLive, deps);
}

/** The GetAgents RPC reply, minus the fields this suite does not cover. */
const listAgents = (sessionId: string | undefined, instanceId?: string) =>
	modelsHandlers
		.GetAgents(
			new GetAgents({
				projectSlug: "demo",
				...(sessionId === undefined ? {} : { sessionId }),
				...(instanceId === undefined ? {} : { instanceId }),
			}),
		)
		.pipe(
			Effect.map(
				({ projectSlug: _slug, hiddenAgents: _hidden, ...reply }) => reply,
			),
		);

describe("GetAgents active provider", () => {
	it.effect("returns Claude agents for a Claude-bound active session", () => {
		const ws = mockWsHandler();
		const client = makeHandlerOpenCodeAPI({
			app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
		});
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
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
		});

		return Effect.gen(function* () {
			yield* setAgent("session-1", "Explore");
			const reply = yield* listAgents("session-1");
			expect(client.app.agents).not.toHaveBeenCalled();
			expect(reply).toEqual({
				instanceId: "claude",
				providerScope: { id: "claude", name: "Claude" },
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
			const ws = mockWsHandler();
			const client = makeHandlerOpenCodeAPI({
				app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
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
			});

			return listAgents("session-1").pipe(
				Effect.provide(agentHandlerLayer({ client, ws, engine })),
				Effect.tap((reply) => {
					expect(reply).toEqual({
						instanceId: "claude",
						providerScope: { id: "claude", name: "Claude" },
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
			const ws = mockWsHandler();
			const rawAgents = [
				{ id: "build", name: "build", mode: "primary" as const },
				{ id: "title", name: "title", mode: "subagent" as const, hidden: true },
			];
			const client = makeHandlerOpenCodeAPI({
				app: { agents: vi.fn(async () => rawAgents) },
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("opencode")),
				dispatchEffect: vi.fn(),
			});

			return listAgents("session-1").pipe(
				Effect.provide(agentHandlerLayer({ client, ws, engine })),
				Effect.tap((reply) => {
					expect(engine.dispatchEffect).not.toHaveBeenCalled();
					expect(reply).toEqual({
						instanceId: "opencode",
						providerScope: { id: "opencode", name: "OpenCode" },
						agents: [{ id: "build", name: "build" }],
					});
				}),
			);
		},
	);

	it.effect(
		"uses the requested instance instead of the active session provider",
		() => {
			const ws = mockWsHandler();
			const client = makeHandlerOpenCodeAPI({
				app: {
					agents: vi.fn(async () => [
						{ id: "build", name: "build", mode: "primary" as const },
					]),
				},
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatchEffect: vi.fn(),
			});

			return listAgents("session-1", "opencode").pipe(
				Effect.provide(agentHandlerLayer({ client, ws, engine })),
				Effect.tap((reply) => {
					expect(engine.dispatchEffect).not.toHaveBeenCalled();
					expect(reply).toEqual({
						instanceId: "opencode",
						providerScope: { id: "opencode", name: "OpenCode" },
						agents: [{ id: "build", name: "build" }],
					});
				}),
			);
		},
	);

	it.effect("preserves OpenCode behavior when no active session exists", () => {
		const ws = mockWsHandler();
		const client = makeHandlerOpenCodeAPI({
			app: {
				agents: vi.fn(async () => [
					{ id: "build", name: "build", mode: "primary" as const },
				]),
			},
		});

		return listAgents(undefined).pipe(
			Effect.provide(agentHandlerLayer({ client, ws })),
			Effect.tap((reply) => {
				expect(client.app.agents).toHaveBeenCalledOnce();
				expect(reply).toEqual({
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: [{ id: "build", name: "build" }],
				});
			}),
		);
	});

	it.effect(
		"falls back to Claude agents when startup has no active session and OpenCode is unavailable",
		() => {
			const ws = mockWsHandler();
			const client = makeHandlerOpenCodeAPI({
				app: {
					agents: vi.fn(async () => {
						throw new Error("opencode offline");
					}),
				},
			});
			const engine = withDispatchEffect({
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
						agents: [{ id: "Explore", name: "Explore", model: "haiku" }],
					}),
				),
			});

			return listAgents(undefined).pipe(
				Effect.provide(agentHandlerLayer({ client, ws, engine })),
				Effect.tap((reply) => {
					expect(client.app.agents).toHaveBeenCalledOnce();
					expect(engine.dispatchEffect).toHaveBeenCalledWith({
						type: "discover",
						providerId: "claude",
					});
					expect(reply).toEqual({
						providerScope: { id: "claude", name: "Claude" },
						agents: [{ id: "Explore", name: "Explore", model: "haiku" }],
					});
				}),
			);
		},
	);

	it.effect(
		"uses Claude agents immediately when the default provider is Claude",
		() => {
			const ws = mockWsHandler();
			const client = makeHandlerOpenCodeAPI({
				app: {
					agents: vi.fn(async () => {
						throw new Error("opencode should not be queried");
					}),
				},
			});
			const engine = withDispatchEffect({
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
						agents: [{ id: "Explore", name: "Explore", model: "haiku" }],
					}),
				),
			});

			return Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "claude",
					modelID: "default",
				});
				const reply = yield* listAgents(undefined);
				expect(client.app.agents).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(reply).toEqual({
					providerScope: { id: "claude", name: "Claude" },
					agents: [{ id: "Explore", name: "Explore", model: "haiku" }],
				});
			}).pipe(Effect.provide(agentHandlerLayer({ client, ws, engine })));
		},
	);

	it.effect("clears stale stored agent not present in active list", () => {
		const ws = mockWsHandler();
		const client = makeHandlerOpenCodeAPI({
			app: { agents: vi.fn(async () => [{ id: "build", name: "build" }]) },
		});
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
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
		});

		return Effect.gen(function* () {
			yield* setAgent("session-1", "Missing");
			const reply = yield* listAgents("session-1");
			expect(yield* getAgent("session-1")).toBeUndefined();
			expect(reply).toEqual({
				instanceId: "claude",
				providerScope: { id: "claude", name: "Claude" },
				agents: [{ id: "Explore", name: "Explore" }],
			});
		}).pipe(Effect.provide(agentHandlerLayer({ client, ws, engine })));
	});
});
