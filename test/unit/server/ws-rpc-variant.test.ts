import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	getVariant,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer SwitchVariant", () => {
	it.effect(
		"sets the variant for the requested session and returns pushed state",
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

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.SwitchVariant({
					projectSlug: "project-a",
					sessionId: "session-1",
					variant: "fast",
					originId: "browser-1",
				});

				expect(result).toEqual({
					projectSlug: "project-a",
					variant: "fast",
					variants: ["standard", "fast"],
				});
				expect(yield* getVariant("session-1")).toBe("fast");
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
								config: makeMockConfig({
									configDir: mkdtempSync(
										join(tmpdir(), "conduit-rpc-variant-"),
									),
								}),
							}),
						),
					),
				),
			);
		},
	);
});
