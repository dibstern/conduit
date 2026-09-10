import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	defaultInstanceIdForDriver,
	ProviderInstanceIdSchema,
} from "../../../src/lib/contracts/provider-instance.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	AgentServiceLive,
	AgentServiceTag,
} from "../../../src/lib/domain/relay/Services/agent-service.js";
import {
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const makeDiscoverCapabilities = (
	agents: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly description?: string;
	}>,
) => ({
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
});

const makeEngine = (
	overrides: Record<string, unknown> = {},
): OrchestrationEngine =>
	({
		getProviderForSession: vi.fn(() => undefined),
		dispatchEffect: vi.fn(() => Effect.succeed(makeDiscoverCapabilities([]))),
		...overrides,
	}) as unknown as OrchestrationEngine;

const makeLayer = ({
	api = makeMockOpenCodeAPI(),
	log = makeMockLogger(),
	engine = makeEngine(),
}: {
	readonly api?: OpenCodeAPI;
	readonly log?: Logger;
	readonly engine?: OrchestrationEngine | null;
} = {}) => {
	const baseDependencies = Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag, api),
		makeOverridesStateLive(),
		Layer.succeed(LoggerTag, log),
	);
	const dependencies =
		engine === null
			? baseDependencies
			: Layer.merge(
					baseDependencies,
					Layer.succeed(OrchestrationEngineTag, engine),
				);
	return Layer.provideMerge(AgentServiceLive, dependencies);
};

describe("AgentService instance scoping", () => {
	it.effect(
		"uses the requested built-in instance instead of the session provider",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.mocked(api.app.agents).mockResolvedValue([
				{ id: "build", name: "build", mode: "primary" },
				{ id: "internal", name: "internal", mode: "subagent" },
			]);
			const engine = makeEngine({
				getProviderForSession: vi.fn(() => "claude"),
				dispatchEffect: vi.fn(() =>
					Effect.succeed(
						makeDiscoverCapabilities([
							{ id: "Explore", name: "Explore", description: "Claude only" },
						]),
					),
				),
			});

			return Effect.gen(function* () {
				const service = yield* AgentServiceTag;
				const result = yield* service.listAgents(
					"session-1",
					defaultInstanceIdForDriver("opencode"),
				);

				expect(result).toEqual({
					instanceId: "opencode",
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: [{ id: "build", name: "build" }],
				});
				expect(api.app.agents).toHaveBeenCalledOnce();
				expect(engine.dispatchEffect).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeLayer({ api, engine })));
		},
	);

	it.effect(
		"discovers only Claude agents for a requested Claude instance",
		() => {
			const api = makeMockOpenCodeAPI();
			const engine = makeEngine({
				getProviderForSession: vi.fn(() => "opencode"),
				dispatchEffect: vi.fn(() =>
					Effect.succeed(
						makeDiscoverCapabilities([
							{ id: "Explore", name: "Explore", description: "Claude only" },
						]),
					),
				),
			});

			return Effect.gen(function* () {
				const service = yield* AgentServiceTag;
				const result = yield* service.listAgents(
					"session-1",
					defaultInstanceIdForDriver("claude"),
				);

				expect(result).toEqual({
					instanceId: "claude",
					providerScope: { id: "claude", name: "Claude" },
					agents: [
						{ id: "Explore", name: "Explore", description: "Claude only" },
					],
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
		"returns an empty Claude snapshot when its driver is unavailable",
		() =>
			Effect.gen(function* () {
				const service = yield* AgentServiceTag;
				const instanceId = ProviderInstanceIdSchema.make("claude-work");
				const result = yield* service.listAgents(
					"session-1",
					instanceId,
					"claude",
				);

				expect(result).toEqual({
					instanceId: "claude-work",
					providerScope: { id: "claude", name: "Claude" },
					agents: [],
				});
			}).pipe(Effect.provide(makeLayer({ engine: null }))),
	),
		it.effect("does not clear a session agent during scoped discovery", () =>
			Effect.gen(function* () {
				const service = yield* AgentServiceTag;
				yield* service.switchAgent({
					clientId: "client-1",
					sessionId: "session-1",
					agentId: "build",
				});

				yield* service.listAgents(
					"session-1",
					defaultInstanceIdForDriver("claude"),
				);

				expect(yield* service.getActiveAgent("session-1")).toBe("build");
			}).pipe(Effect.provide(makeLayer({ engine: null }))),
		);

	it.effect("returns an empty OpenCode snapshot when discovery fails", () => {
		const api = makeMockOpenCodeAPI();
		vi.mocked(api.app.agents).mockRejectedValue(new Error("opencode offline"));

		return Effect.gen(function* () {
			const service = yield* AgentServiceTag;
			const result = yield* service.listAgents(
				"session-1",
				defaultInstanceIdForDriver("opencode"),
			);

			expect(result).toEqual({
				instanceId: "opencode",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [],
			});
		}).pipe(Effect.provide(makeLayer({ api })));
	});

	it.effect("fails closed for a configured unknown driver", () => {
		const api = makeMockOpenCodeAPI();
		const engine = makeEngine();

		return Effect.gen(function* () {
			const service = yield* AgentServiceTag;
			const result = yield* service.listAgents(
				undefined,
				ProviderInstanceIdSchema.make("future-instance"),
				"future-driver",
			);

			expect(result).toEqual({
				instanceId: "future-instance",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [],
			});
			expect(api.app.agents).not.toHaveBeenCalled();
			expect(engine.dispatchEffect).not.toHaveBeenCalled();
		}).pipe(Effect.provide(makeLayer({ api, engine })));
	});

	it.effect("treats an unknown unconfigured instance as OpenCode", () => {
		const api = makeMockOpenCodeAPI();
		vi.mocked(api.app.agents).mockResolvedValue([
			{ id: "build", name: "build", mode: "primary" },
		]);

		return Effect.gen(function* () {
			const service = yield* AgentServiceTag;
			const result = yield* service.listAgents(
				undefined,
				ProviderInstanceIdSchema.make("unknown-instance"),
			);

			expect(result).toEqual({
				instanceId: "unknown-instance",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [{ id: "build", name: "build" }],
			});
		}).pipe(Effect.provide(makeLayer({ api })));
	});
});
