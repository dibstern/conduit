import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	getModel,
	getVariant,
	makeOverridesStateLive,
} from "../../../src/lib/effect/session-overrides-state.js";
import { handleSwitchModel } from "../../../src/lib/handlers/model.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function mockWsHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => "session-1"),
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
	return makeMockLogger() as Logger;
}

const flushDispatchContinuation = () =>
	Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));

describe("model handlers with Effect override state", () => {
	it.effect(
		"stores selected session model and restored variant without legacy SessionOverrides",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-state-"));
			saveRelaySettings(
				{ defaultVariants: { "openai/gpt-4": "fast" } },
				configDir,
			);
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
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
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, mockLogger()),
				Layer.succeed(ConfigTag, makeMockConfig({ configDir })),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* handleSwitchModel("client-1", {
					modelId: "gpt-4",
					providerId: "openai",
				});

				expect(yield* getModel("session-1")).toEqual({
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(ws.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "model_info",
					model: "gpt-4",
					provider: "openai",
				});
				expect(ws.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "variant_info",
					variant: "fast",
					variants: ["standard", "fast"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"uses the selected model and variant when sending the next turn",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-prompt-"));
			saveRelaySettings(
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
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => ["client-1"]),
			});
			const sessionManagerService = makeMockSessionManagerService({
				recordMessageActivity: vi.fn(() => Effect.void),
			});
			const engine = {
				bindSession: vi.fn(),
				getProviderForSession: vi.fn(() => "opencode"),
				dispatch: vi.fn(async () => ({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				})),
			} as unknown as OrchestrationEngine;

			return Effect.gen(function* () {
				yield* handleSwitchModel("client-1", {
					providerId: "openai",
					modelId: "gpt-4",
				});
				yield* handleMessage("client-1", { text: "ship it" });
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
							wsHandler: ws,
							sessionManagerService,
							orchestrationEngine: withDispatchEffect(engine),
							config: makeMockConfig({ configDir }),
						}),
					),
				),
			);
		},
	);
});
