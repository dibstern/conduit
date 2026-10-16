import { RpcTest } from "@effect/rpc";
import { it } from "@effect/vitest";
import { type Context, Effect, Layer, Stream } from "effect";
import { expect, vi } from "vitest";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	makeSessionDirectoryLive,
	SessionDirectory,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeSessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeRoutedWsRpcServerLayer,
	RpcSubscriptionScopeLive,
} from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockSessionManagerService,
} from "../../helpers/mock-factories.js";

// Failure modes: payload/default project overrides ownership; missing ids touch
// a relay; subscriptions route differently from unary session operations.
it.scoped(
	"unary and streaming session RPCs route by the directory and unknown ids fail before relay startup",
	() =>
		Effect.gen(function* () {
			const directory = yield* SessionDirectory.pipe(
				Effect.provide(makeSessionDirectoryLive("/unused", [])),
			);
			const bus = makeSessionEventBusLive();
			const context = yield* Layer.build(
				Layer.mergeAll(
					RpcSubscriptionScopeLive,
					bus,
					makePersistenceEffectLayer(":memory:", "b", undefined, bus),
					Layer.succeed(ConfigTag, makeMockConfig({ slug: "b" })),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService({
							sessionExists: () => Effect.succeed(true),
						}),
					),
				),
			);
			yield* Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"session.created",
						"owned",
						{ sessionId: "owned", title: "Owned", provider: "claude" },
						{ provider: "claude" },
					),
				]);
			}).pipe(
				Effect.provide(context),
				Effect.provideService(SessionDirectory, directory),
			);
			const resolve = vi.fn((slug: string) =>
				slug === "b"
					? Effect.succeed(context as Context.Context<unknown>)
					: Effect.fail(new WsRpcError({ message: `Wrong project ${slug}` })),
			);
			const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
				Effect.provide(
					makeRoutedWsRpcServerLayer(resolve, undefined, "a").pipe(
						Layer.provide(Layer.succeed(SessionDirectory, directory)),
					),
				),
			);
			expect(yield* client.ResolveSession({ sessionId: "owned" })).toEqual({
				projectSlug: "b",
			});
			const envelopes = yield* client
				.SubscribeSessionTodos({ sessionId: "owned" })
				.pipe(Stream.take(2), Stream.runCollect);
			expect(Array.from(envelopes)).toMatchObject([
				{ _tag: "snapshot" },
				{ _tag: "synchronized" },
			]);
			expect(resolve.mock.calls.every(([slug]) => slug === "b")).toBe(true);
			resolve.mockClear();
			expect(
				yield* Effect.either(client.MarkSessionRead({ sessionId: "missing" })),
			).toMatchObject({
				_tag: "Left",
				left: {
					_tag: "WsRpcError",
					message: expect.stringContaining("missing"),
				},
			});
			expect(
				yield* Effect.either(
					client
						.SubscribeSessionTodos({ sessionId: "missing" })
						.pipe(Stream.runDrain),
				),
			).toMatchObject({ _tag: "Left", left: { _tag: "WsRpcError" } });
			expect(resolve).not.toHaveBeenCalled();
		}),
);
