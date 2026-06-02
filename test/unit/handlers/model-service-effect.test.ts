import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceLive,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getDefaultModel,
	getDefaultVariant,
	getVariant,
	makeOverridesStateLive,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	sendModelsStateToClient,
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../../../src/lib/handlers/model.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("model handlers with Effect-native model service", () => {
	it.effect(
		"loads providers and active-session model info without requiring the Promise OpenCode API tag",
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
				getSession: vi.fn((sessionId: string) =>
					Effect.succeed({
						id: sessionId,
						projectID: "project-1",
						directory: "/tmp/project",
						title: "Session 1",
						version: "1.0.0",
						time: { created: 0, updated: 0 },
						modelID: "gpt-4",
						providerID: "openai",
					}),
				),
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

			return sendModelsStateToClient("client-1").pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(modelService.getSession).toHaveBeenCalledWith("session-1");
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "model_info",
						model: "gpt-4",
						provider: "openai",
					});
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "variant_info",
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
				getSession: vi.fn(),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};
			const engine = withDispatchEffect({
				getProviderForSession: vi.fn(() => "claude"),
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
				yield* sendModelsStateToClient("client-1");

				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(modelService.getSession).not.toHaveBeenCalled();
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "model_list",
					providers: [
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
					],
				});
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
				getSession: vi.fn(),
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
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				yield* switchVariantForSession({
					clientId: "client-1",
					sessionId: "session-1",
					variant: "fast",
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "variant_info",
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
				getSession: vi.fn(),
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
				Effect.tap(() => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "model_info",
						model: "gpt-4",
						provider: "openai",
					});
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "variant_info",
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
				getSession: vi.fn(),
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
			);

			return Effect.gen(function* () {
				yield* setDefaultModelForRelay({
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
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
					type: "variant_info",
					variant: "",
					variants: ["standard", "fast"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"persists OpenCode default model and relocates the config write in the live model service",
		() => {
			const projectDir = mkdtempSync(join(tmpdir(), "conduit-model-live-"));
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-live-cfg-"));
			const logger = makeMockLogger();
			const api = {
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
					get: vi.fn(async () => ({})),
				},
			} as unknown as OpenCodeAPI;

			const layer = OpenCodeModelServiceLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, api),
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
