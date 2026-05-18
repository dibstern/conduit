import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	AgentServiceLive,
	AgentServiceTag,
} from "../../../src/lib/domain/relay/Services/agent-service.js";
import {
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getAgent,
	makeOverridesStateLive,
	setAgent,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

function makeDiscoverCapabilities(
	agents: Array<{
		id: string;
		name: string;
		description?: string;
		model?: string;
	}>,
) {
	return {
		models: [],
		supportsTools: true,
		supportsThinking: true,
		supportsPermissions: true,
		supportsQuestions: true,
		supportsAttachments: true,
		supportsFork: false,
		supportsRevert: false,
		commands: [],
		agents,
	};
}

function makeEngine(overrides?: Record<string, unknown>): OrchestrationEngine {
	return {
		getProviderForSession: vi.fn(() => undefined),
		dispatchEffect: vi.fn(() => Effect.succeed(makeDiscoverCapabilities([]))),
		...overrides,
	} as unknown as OrchestrationEngine;
}

function makeLayer({
	api = makeMockOpenCodeAPI(),
	log = makeMockLogger(),
	engine = makeEngine(),
}: {
	api?: OpenCodeAPI;
	log?: Logger;
	engine?: OrchestrationEngine;
} = {}) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, api);
	const overridesLayer = makeOverridesStateLive();
	const loggerLayer = Layer.succeed(LoggerTag, log);
	const engineLayer = Layer.succeed(OrchestrationEngineTag, engine);
	const deps = Layer.mergeAll(
		apiLayer,
		overridesLayer,
		loggerLayer,
		engineLayer,
	);
	return Layer.provideMerge(AgentServiceLive, deps);
}

describe("AgentService", () => {
	it.effect(
		"lists filtered OpenCode agents and preserves active override",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.mocked(api.app.agents).mockResolvedValue([
				{ id: "build", name: "build", mode: "primary" },
				{ id: "title", name: "title", mode: "subagent", hidden: true },
				{ id: "plan", name: "plan", mode: "all" },
			]);
			const engine = makeEngine({
				getProviderForSession: vi.fn(() => "opencode"),
			});

			return Effect.gen(function* () {
				yield* setAgent("session-1", "plan");
				const service = yield* AgentServiceTag;
				const result = yield* service.listAgents("session-1");
				expect(result).toEqual({
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: [
						{ id: "build", name: "build" },
						{ id: "plan", name: "plan" },
					],
					activeAgentId: "plan",
				});
				expect(api.app.agents).toHaveBeenCalledOnce();
				expect(engine.dispatchEffect).not.toHaveBeenCalled();
				expect(yield* getAgent("session-1")).toBe("plan");
			}).pipe(Effect.provide(makeLayer({ api, engine })));
		},
	);

	it.effect(
		"discovers Claude agents through the Effect orchestration API",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.mocked(api.app.agents).mockResolvedValue([
				{ id: "build", name: "build" },
			]);
			const engine = makeEngine({
				getProviderForSession: vi.fn(() => "claude"),
				dispatchEffect: vi.fn(() =>
					Effect.succeed(
						makeDiscoverCapabilities([
							{ id: "Explore", name: "Explore", description: "Explorer" },
							{ id: "Review", name: "Review", model: "opus" },
						]),
					),
				),
			});
			return Effect.gen(function* () {
				yield* setAgent("session-1", "Explore");
				const service = yield* AgentServiceTag;
				const result = yield* service.listAgents("session-1");
				expect(result).toEqual({
					providerScope: { id: "claude", name: "Claude" },
					agents: [
						{ id: "Explore", name: "Explore", description: "Explorer" },
						{ id: "Review", name: "Review", model: "opus" },
					],
					activeAgentId: "Explore",
				});
				expect(api.app.agents).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
			}).pipe(Effect.provide(makeLayer({ api, engine })));
		},
	);

	it.effect(
		"logs Claude discovery failures and clears stale active agent",
		() => {
			const engine = makeEngine({
				getProviderForSession: vi.fn(() => "claude"),
				dispatchEffect: vi.fn(() => Effect.fail(new Error("claude offline"))),
			});
			const log = makeMockLogger();

			return Effect.gen(function* () {
				yield* setAgent("session-1", "Explore");
				const service = yield* AgentServiceTag;
				const result = yield* service.listAgents("session-1");
				expect(result).toEqual({
					providerScope: { id: "claude", name: "Claude" },
					agents: [],
				});
				expect(log.warn).toHaveBeenCalledWith(
					"Failed to discover Claude agents: claude offline",
				);
				expect(yield* getAgent("session-1")).toBeUndefined();
			}).pipe(Effect.provide(makeLayer({ log, engine })));
		},
	);

	it.effect("sets an agent override only when a session is active", () => {
		const log = makeMockLogger();

		return Effect.gen(function* () {
			const service = yield* AgentServiceTag;
			yield* service.switchAgent({
				clientId: "client-1",
				sessionId: "session-1",
				agentId: "plan",
			});
			yield* service.switchAgent({
				clientId: "client-2",
				sessionId: undefined,
				agentId: "build",
			});
			yield* service.switchAgent({
				clientId: "client-3",
				sessionId: "session-3",
				agentId: "",
			});

			expect(yield* getAgent("session-1")).toBe("plan");
			expect(yield* getAgent("session-3")).toBeUndefined();
			expect(log.warn).toHaveBeenCalledWith(
				"client=client-2 agent switch with no session - ignoring",
			);
			expect(log.info).toHaveBeenCalledTimes(2);
		}).pipe(Effect.provide(makeLayer({ log })));
	});
});
