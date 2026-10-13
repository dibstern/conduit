import { RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { getContextWindow } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("WsRpcServerLayer SwitchContextWindow", () => {
	it.effect("sets the context window and returns the resulting options", () => {
		const contextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		const wsHandler = makeMockWebSocketHandler();
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({
				models: [
					{
						id: "claude-sonnet-4-7",
						name: "Claude Sonnet 4.7",
						providerId: "claude",
						contextWindowOptions,
					},
				],
			})),
		});

		return Effect.gen(function* () {
			yield* (yield* ProjectionRunnerEffectTag).recover();
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions
				(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
				VALUES ('session-1', 'claude', 'Stored session', 'claude', 'claude-sonnet-4-7', '', '200k', 1, 1)`;

			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.SwitchContextWindow({
				projectSlug: "project-a",
				sessionId: "session-1",
				contextWindow: "1m",
				originId: "browser-1",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				contextWindow: "1m",
				options: contextWindowOptions,
			});
			expect(yield* getContextWindow("session-1")).toBe("1m");
			expect(
				yield* (yield* ReadQueryEffectTag).getSession("session-1"),
			).toMatchObject({
				model_provider: "claude",
				model_id: "claude-sonnet-4-7",
				variant: "",
				context_window: "1m",
			});
			const committed = yield* (yield* EventStoreEffectTag).readAllBySession(
				"session-1",
			);
			expect(committed.map((event) => event.type)).toEqual([
				"session.context_window_changed",
			]);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							wsHandler,
							log: makeMockLogger(),
							orchestrationEngine: engine,
						}),
					),
					Layer.provideMerge(Layer.succeed(LoggerTag, makeMockLogger())),
				),
			),
		);
	});
});
