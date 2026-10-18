import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { getVariant } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
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
				yield* (yield* ProjectionRunnerEffectTag).recover();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions
					(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
					VALUES ('session-1', 'opencode', 'Stored session', 'openai', 'gpt-4', 'standard', '', 1, 1)`;
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.SwitchVariant({
					sessionId: "session-1",
					variant: "fast",
					originId: "browser-1",
				});

				expect(result).toEqual({
					projectSlug: "test-project",
					variant: "fast",
					variants: ["standard", "fast"],
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(
					yield* (yield* ReadQueryEffectTag).getSession("session-1"),
				).toMatchObject({
					model_provider: "openai",
					model_id: "gpt-4",
					variant: "fast",
					context_window: "",
				});
				const committed = yield* (yield* EventStoreEffectTag).readAllBySession(
					"session-1",
				);
				expect(committed.map((event) => event.type)).toEqual([
					"session.variant_changed",
				]);
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
