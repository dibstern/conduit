import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, TestClock } from "effect";
import { expect, vi } from "vitest";
import { SessionStateProjectionNotifierLive } from "../../../src/lib/domain/relay/Layers/session-state-projection-notifier-layer.js";
import { WebSocketHandlerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import {
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

describe("SessionStateProjectionNotifier", () => {
	it.effect("coalesces a burst of projected events into one broadcast", () =>
		Effect.gen(function* () {
			const wsHandler = makeMockWebSocketHandler();
			const sendSessionLists = vi.fn((send) =>
				Effect.sync(() =>
					send({ type: "session_list", sessions: [], roots: true }),
				),
			);
			const sessionManagerService = makeMockSessionManagerService({
				sendSessionLists,
			});
			const layer = SessionStateProjectionNotifierLive.pipe(
				Layer.provide(
					Layer.merge(
						Layer.succeed(WebSocketHandlerTag, wsHandler),
						Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					),
				),
			);

			yield* Effect.gen(function* () {
				const notifier = yield* SessionStateProjectionNotifierTag;
				for (let index = 0; index < 100; index++) {
					yield* notifier.sessionStateProjected("session-1", "text.delta");
				}
				yield* TestClock.adjust("150 millis");

				expect(sendSessionLists).toHaveBeenCalledTimes(1);
				expect(wsHandler.broadcast).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(layer));
		}),
	);

	// A state change that lands while a broadcast is in flight is the whole
	// reason this service exists: if the coalescing slot stayed taken until the
	// fan-out finished, that change would be silently dropped with nothing left
	// to ever publish it.
	it.effect(
		"arms a fresh broadcast for a change that lands mid-broadcast",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const wsHandler = makeMockWebSocketHandler();
				const sendSessionLists = vi.fn(() =>
					Deferred.succeed(started, undefined).pipe(
						Effect.zipRight(Deferred.await(release)),
					),
				);
				const sessionManagerService = makeMockSessionManagerService({
					sendSessionLists,
				});
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag, wsHandler),
							Layer.succeed(SessionManagerServiceTag, sessionManagerService),
						),
					),
				);

				yield* Effect.gen(function* () {
					const notifier = yield* SessionStateProjectionNotifierTag;
					yield* notifier.sessionStateProjected("session-1", "text.delta");
					yield* TestClock.adjust("150 millis");
					// The first fan-out has begun and is parked, holding no slot.
					yield* Deferred.await(started);

					yield* notifier.sessionStateProjected("session-1", "text.delta");
					// The newly forked fiber needs one scheduling turn to reach its sleep;
					// TestClock only fires sleeps already registered when it advances.
					// Under a real clock that gap is microseconds against 150ms.
					yield* Effect.yieldNow();
					yield* TestClock.adjust("150 millis");
					expect(sendSessionLists).toHaveBeenCalledTimes(2);

					yield* Deferred.succeed(release, undefined);
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect(
		"marks completed and errored turns read when the session has viewers",
		() =>
			Effect.gen(function* () {
				const wsHandler = makeMockWebSocketHandler({
					getClientsForSession: vi.fn(() => ["client-1"]),
				});
				const markSessionRead = vi.fn(() => Effect.void);
				const sessionManagerService = makeMockSessionManagerService({
					markSessionRead,
				});
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag, wsHandler),
							Layer.succeed(SessionManagerServiceTag, sessionManagerService),
						),
					),
				);

				yield* Effect.gen(function* () {
					const notifier = yield* SessionStateProjectionNotifierTag;
					yield* notifier.sessionStateProjected("session-1", "turn.completed");
					yield* notifier.sessionStateProjected("session-1", "turn.error");

					expect(markSessionRead).toHaveBeenCalledTimes(2);
					expect(markSessionRead).toHaveBeenNthCalledWith(1, "session-1");
					expect(markSessionRead).toHaveBeenNthCalledWith(2, "session-1");
					yield* TestClock.adjust("150 millis");
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect(
		"does not mark a completed turn read when the session has no viewers",
		() =>
			Effect.gen(function* () {
				const wsHandler = makeMockWebSocketHandler();
				const markSessionRead = vi.fn(() => Effect.void);
				const sessionManagerService = makeMockSessionManagerService({
					markSessionRead,
				});
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag, wsHandler),
							Layer.succeed(SessionManagerServiceTag, sessionManagerService),
						),
					),
				);

				yield* Effect.gen(function* () {
					const notifier = yield* SessionStateProjectionNotifierTag;
					yield* notifier.sessionStateProjected("session-1", "turn.completed");

					expect(markSessionRead).not.toHaveBeenCalled();
					yield* TestClock.adjust("150 millis");
				}).pipe(Effect.provide(layer));
			}),
	);
});
