import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OpenCodeModelServiceLive,
	OpenCodeModelServiceTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	handleGetModels,
	handleSetDefaultModel,
	handleSwitchModel,
	handleSwitchVariant,
} from "../../../src/lib/handlers/model.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockSessionOverrides,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

describe("model handlers with Effect-native model service", () => {
	it.effect(
		"loads providers and active-session model info without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const overrides = makeMockSessionOverrides();
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, logger),
			);

			return handleGetModels("client-1", {}).pipe(
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
		"switches OpenCode variants using the model service without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const overrides = makeMockSessionOverrides({
				getModel: vi.fn(() => ({
					providerID: "openai",
					modelID: "gpt-4",
				})),
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-switch-variant-")),
					}),
				),
			);

			return handleSwitchVariant("client-1", { variant: "fast" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
						type: "variant_info",
						variant: "fast",
						variants: ["standard", "fast"],
					});
				}),
			);
		},
	);

	it.effect(
		"switches OpenCode models using the model service for restored variants without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const overrides = makeMockSessionOverrides();
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-switch-model-")),
					}),
				),
			);

			return handleSwitchModel("client-1", {
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
			const overrides = makeMockSessionOverrides();
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-default-model-")),
						projectDir: mkdtempSync(join(tmpdir(), "conduit-project-")),
					}),
				),
			);

			return handleSetDefaultModel("client-1", {
				model: "gpt-4",
				provider: "openai",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
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
				}),
			);
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
