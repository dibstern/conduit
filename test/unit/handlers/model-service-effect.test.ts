import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { ProjectSettingsLive } from "../../../src/lib/domain/relay/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceLive,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	getDefaultModel,
	getDefaultVariant,
	getVariant,
	makeOverridesStateLive,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	getModelsResponse,
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../../../src/lib/handlers/model.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

// biome-ignore format: Keep the existing test layout inside this runtime suite.
layer(Layer.mergeAll(makePersistenceEffectLayer(":memory:"), Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()), Layer.succeed(OrchestrationEngineTag, withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [], commands: [] })) })), Layer.succeed(ProviderRegistryTag, new ProviderRegistry()), Layer.succeed(ConfigTag, makeMockConfig())))("persistent handler runtime", (it) => {
describe("model handlers with Effect-native model service", () => {
	it.effect(
		"loads providers and relay-owned active-session model info without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const logger = makeMockLogger();
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
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					OrchestrationEngineTag,
					withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [] })) }),
				),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				return yield* getModelsResponse({
					clientId: "client-1",
					sessionId: "session-1",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap((response) => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(response.active).toEqual({
						model: "gpt-4",
						provider: "openai",
					});
					expect(response.variant).toEqual({
						variant: "",
						variants: ["standard", "fast"],
					});
				}),
			);
		},
	);

	it.effect(
		"keeps configured OpenCode providers in model refreshes for Claude-bound sessions",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const logger = makeMockLogger();
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
						connected: ["openai"],
						defaults: {},
						providers: [
							{
								id: "openai",
								name: "OpenAI",
								models: [{ id: "gpt-5", name: "GPT-5" }],
							},
						],
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async () => ({
					models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
					supportsTools: true,
					supportsThinking: true,
					supportsPermissions: true,
					supportsQuestions: true,
					supportsAttachments: true,
					supportsFork: true,
					supportsRevert: true,
					commands: [],
				})),
			});

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(OrchestrationEngineTag, engine),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "sonnet",
				});
				const response = yield* getModelsResponse({
					clientId: "client-1",
					sessionId: "session-1",
				});

				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(response.providers).toEqual([
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
									id: "sonnet",
									name: "Sonnet",
									provider: "claude",
								},
							],
						},
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"switches OpenCode variants using the model service without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const logger = makeMockLogger();
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
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-switch-variant-")),
					}),
				),
				makeOverridesStateLive(),
				ProjectSettingsLive,
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				const result = yield* switchVariantForSession({
					clientId: "client-1",
					sessionId: "session-1",
					variant: "fast",
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(result).toEqual({
					variant: "fast",
					variants: ["standard", "fast"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"switches OpenCode models using the model service for restored variants without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const logger = makeMockLogger();
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
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-switch-model-")),
					}),
				),
				makeOverridesStateLive(),
			);

			return switchModelForSession({
				clientId: "client-1",
				modelId: "gpt-4",
				providerId: "openai",
			}).pipe(
				Effect.provide(layer),
				Effect.tap((result) => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(result).toEqual({
						model: "gpt-4",
						provider: "openai",
						variant: "",
						variants: ["standard", "fast"],
					});
				}),
			);
		},
	);

	it.effect(
		"sets the OpenCode default model using the model service without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const logger = makeMockLogger();
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
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-default-model-")),
						projectDir: mkdtempSync(join(tmpdir(), "conduit-project-")),
					}),
				),
				makeOverridesStateLive(),
				ProjectSettingsLive,
			);

			return Effect.gen(function* () {
				const result = yield* setDefaultModelForRelay({
					clientId: "client-1",
					model: "gpt-4",
					provider: "openai",
				});
				expect(yield* getDefaultModel()).toEqual({
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(yield* getDefaultVariant()).toBe("");
				expect(modelService.persistDefaultModel).toHaveBeenCalledWith(
					"openai",
					"gpt-4",
				);
				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(result).toMatchObject({
					variant: "",
					variants: ["standard", "fast"],
				});
				expect(wsHandler.broadcast).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"persists OpenCode default model and relocates the config write in the live model service",
		() => {
			const projectDir = mkdtempSync(join(tmpdir(), "conduit-model-live-"));
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-live-cfg-"));
			const logger = makeMockLogger();
			const api = makeHandlerOpenCodeAPI({
				config: {
					update: vi.fn(async (patch: Record<string, unknown>) => {
						await writeFile(
							join(projectDir, "config.json"),
							`${JSON.stringify(patch)}\n`,
						);
					}),
				},
				provider: {
					list: vi.fn(async () => ({
						connected: [],
						defaults: {},
						providers: [],
					})),
				},
				session: {
					get: vi.fn(async () => ({
						id: "session",
						projectID: "project",
						directory: projectDir,
						title: "Session",
						version: "1.0.0",
						time: { created: 0, updated: 0 },
					})),
				},
			});

			const layer = OpenCodeModelServiceLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(
							OpenCodeInstancesTag,
							makeOpenCodeInstancesStub({ opencode: api }),
						),
						Layer.succeed(ConfigTag, makeMockConfig({ configDir, projectDir })),
						Layer.succeed(LoggerTag, logger),
					),
				),
			);

			return Effect.gen(function* () {
				const modelService = yield* OpenCodeModelServiceTag;
				yield* modelService.persistDefaultModel("openai", "gpt-4");
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(api.config.update).toHaveBeenCalledWith({
						model: "openai/gpt-4",
					});
					expect(existsSync(join(projectDir, "config.json"))).toBe(false);
					expect(
						JSON.parse(
							readFileSync(join(projectDir, "opencode.json"), "utf-8"),
						),
					).toEqual({
						model: "openai/gpt-4",
					});
					expect(logger.info).toHaveBeenCalledWith(
						expect.stringContaining("Merged config.json"),
					);
				}),
			);
		},
	);
});
});
