import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	getModel,
	getVariant,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("WsRpcServerLayer SwitchModel", () => {
	it.effect(
		"sets the model for the requested session and returns restored variant state",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const api = makeMockOpenCodeAPI();
			api.provider.list = vi.fn(async () => ({
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
			})) as typeof api.provider.list;
			const orchestrationEngine = withDispatchEffect({
				bindSession: vi.fn(),
				dispatch: vi.fn(async () => ({ models: [] })),
			});
			const configDir = mkdtempSync(join(tmpdir(), "conduit-rpc-model-"));
			saveRelaySettings(
				{ defaultVariants: { "openai/gpt-4": "fast" } },
				configDir,
			);

			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.SwitchModel({
					projectSlug: "project-a",
					sessionId: "session-1",
					modelId: "gpt-4",
					providerId: "openai",
					originId: "browser-1",
				});

				expect(result).toEqual({
					projectSlug: "project-a",
					model: "gpt-4",
					provider: "openai",
					variant: "fast",
					variants: ["standard", "fast"],
				});
				expect(yield* getModel("session-1")).toEqual({
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(orchestrationEngine.bindSession).toHaveBeenCalledWith(
					"session-1",
					"opencode",
				);
				expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "model_info",
					model: "gpt-4",
					provider: "openai",
				});
				expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "variant_info",
					variant: "fast",
					variants: ["standard", "fast"],
				});
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								wsHandler,
								orchestrationEngine,
								config: makeMockConfig({ configDir }),
							}),
						),
					),
				),
			);
		},
	);
});
