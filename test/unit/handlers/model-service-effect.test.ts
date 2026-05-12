import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { handleGetModels } from "../../../src/lib/handlers/model.js";
import {
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
});
