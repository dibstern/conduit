import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { saveGlobalSettings } from "../../../src/lib/daemon/global-settings.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/project-services/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/project-services/Services/session-manager-service.js";
import {
	getModel,
	getVariant,
	makeOverridesStateLive,
} from "../../../src/lib/domain/project-services/Services/session-overrides-state.js";
import { switchModelForSession } from "../../../src/lib/handlers/model.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type { Logger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeTestHandlerLayer,
	makeTestSessionActivityLayer,
	mockSessionManagers,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

function mockLogger(): Logger {
	return makeMockLogger() as Logger;
}

const flushDispatchContinuation = () =>
	Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));

// biome-ignore format: Keep the existing test layout inside this runtime suite.
layer(Layer.mergeAll(Layer.succeed(AccountDirectory)(makeMockAccountDirectory()), makePersistenceEffectLayer(":memory:", "test-project"), Layer.succeed(SessionManagerServiceTag)(mockSessionManagers(makeMockSessionManagerService())), Layer.succeed(OrchestrationEngineTag)(withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [], commands: [] })) })), Layer.succeed(ProviderRegistryTag)(new ProviderRegistry())))("persistent handler runtime", (it) => {
describe("model handlers with Effect override state", () => {
	it.effect(
		"stores selected session model and restored variant without legacy SessionOverrides",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-state-"));
			saveGlobalSettings(
				{ defaultVariants: { "openai/gpt-4": "fast" } },
				configDir,
			);
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
						connected: ["openai"],
						defaults: {},
						providers: [
							{
								id: "openai",
								name: "OpenAI",
								models: [
									{
										id: "gpt-4",
										name: "GPT-4",
										variants: { standard: {}, fast: {} },
									},
								],
							},
						],
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag)(modelService),
				makeTestSessionActivityLayer("session-1"),
				Layer.succeed(LoggerTag)(mockLogger()),
				Layer.succeed(ConfigTag)(makeMockConfig({ configDir })),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				const result = yield* switchModelForSession({
					clientId: "client-1",
					sessionId: "session-1",
					modelId: "gpt-4",
					providerId: "openai",
				});

				expect(yield* getModel("session-1")).toEqual({
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(result).toEqual({
					model: "gpt-4",
					provider: "openai",
					variant: "fast",
					variants: ["standard", "fast"],
					contextWindow: { contextWindow: "", options: [] },
				});
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);

	it.effect(
		"uses the selected model and variant when sending the next turn",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-prompt-"));
			saveGlobalSettings(
				{ defaultVariants: { "openai/gpt-4": "fast" } },
				configDir,
			);
			const api = makeMockOpenCodeAPI();
			vi.mocked(api.provider.list).mockResolvedValue({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{
								id: "gpt-4",
								name: "GPT-4",
								variants: { standard: {}, fast: {} },
							},
						],
					},
				],
			});
			const sessionManagerService = makeMockSessionManagerService({
				recordMessageActivity: vi.fn(() => Effect.void),
			});
			const engine = withDispatchEffect({
				bindSession: vi.fn(),
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("opencode")),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			});

			return Effect.gen(function* () {
				yield* switchModelForSession({
					clientId: "client-1",
					sessionId: "session-1",
					providerId: "openai",
					modelId: "gpt-4",
				});
				yield* handleMessage("client-1", {
					text: "ship it",
					commandId: "cmd-model-overrides",
				});
				yield* flushDispatchContinuation();

				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						input: expect.objectContaining({
							model: { providerId: "openai", modelId: "gpt-4" },
							variant: "fast",
						}),
					}),
				);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						makeTestHandlerLayer({
							api,
							selectedSession: "session-1",
							sessionManagerService,
							orchestrationEngine: withDispatchEffect(engine),
							config: makeMockConfig({ configDir }),
							seedEvents: [makeSessionCreatedEvent("session-1")],
						}),
					),
				),
			);
		},
	);
});
});
