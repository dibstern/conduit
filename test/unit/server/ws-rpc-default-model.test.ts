import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	getDefaultModel,
	getDefaultVariant,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer SetDefaultModel", () => {
	it.effect(
		"sets the relay default model and returns restored variant state",
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
			api.config.update = vi.fn(
				async () => undefined,
			) as typeof api.config.update;
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-default-model-"),
			);
			saveRelaySettings(
				{ defaultVariants: { "openai/gpt-4": "fast" } },
				configDir,
			);

			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.SetDefaultModel({
					projectSlug: "project-a",
					model: "gpt-4",
					provider: "openai",
					originId: "browser-1",
				});

				expect(result).toEqual({
					projectSlug: "project-a",
					model: "gpt-4",
					provider: "openai",
					variant: "fast",
					variants: ["standard", "fast"],
				});
				expect(yield* getDefaultModel()).toEqual({
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(yield* getDefaultVariant()).toBe("fast");
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
					type: "model_info",
					model: "gpt-4",
					provider: "openai",
				});
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
					type: "default_model_info",
					model: "gpt-4",
					provider: "openai",
				});
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
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
								config: makeMockConfig({ configDir }),
							}),
						),
					),
				),
			);
		},
	);
});
