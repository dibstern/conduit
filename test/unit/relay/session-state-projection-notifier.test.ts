import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Exit,
	Layer,
	Logger,
	Scope,
	TestClock,
} from "effect";
import { expect, vi } from "vitest";
import {
	makeSessionStateProjectionNotifierLive,
	SessionStateProjectionNotifierLive,
} from "../../../src/lib/domain/relay/Layers/session-state-projection-notifier-layer.js";
import { WebSocketHandlerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import {
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

describe("SessionStateProjectionNotifier", () => {
	it.effect(
		"interrupts an in-flight broadcast when its relay scope closes",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const finished = yield* Deferred.make<void>();
				const errors: string[] = [];
				const logger = Logger.make<unknown, void>((entry) => {
					if (entry.logLevel._tag === "Error")
						errors.push(String(entry.message));
				});
				const sessionManagerService = makeMockSessionManagerService({
					sendSessionLists: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(release);
							return yield* Effect.fail(
								new SessionManagerError({
									operation: "listSessions",
									cause: new Error("The database connection is not open"),
								}),
							);
						}).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
				});
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
							Layer.succeed(SessionManagerServiceTag, sessionManagerService),
						),
					),
				);

				yield* Effect.gen(function* () {
					const scope = yield* Scope.make();
					const context = yield* Layer.buildWithScope(layer, scope);
					const notifier = yield* Effect.provide(
						SessionStateProjectionNotifierTag,
						context,
					);
					yield* Effect.provide(
						notifier.sessionStateProjected("session-1", "text.delta"),
						context,
					);
					yield* TestClock.adjust("150 millis");
					yield* Deferred.await(started);
					yield* Scope.close(scope, Exit.void);
					yield* Deferred.succeed(release, undefined);
					yield* Deferred.await(finished);
					expect(errors).toEqual([]);
				}).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)));
			}),
	);

	it.effect("logs the underlying cause of a real broadcast failure", () =>
		Effect.gen(function* () {
			const errors: string[] = [];
			const logger = Logger.make<unknown, void>((entry) => {
				if (entry.logLevel._tag === "Error") errors.push(String(entry.message));
			});
			const sessionManagerService = makeMockSessionManagerService({
				sendSessionLists: () =>
					Effect.fail(
						new SessionManagerError({
							operation: "listSessions",
							cause: new Error("SQLite query failed"),
						}),
					),
			});
			const layer = SessionStateProjectionNotifierLive.pipe(
				Layer.provide(
					Layer.merge(
						Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
						Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					),
				),
			);

			yield* Effect.gen(function* () {
				const notifier = yield* SessionStateProjectionNotifierTag;
				yield* notifier.sessionStateProjected("session-1", "text.delta");
				yield* TestClock.adjust("150 millis");
				expect(errors.join("\n")).toContain("SQLite query failed");
			}).pipe(
				Effect.provide(layer),
				Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
			);
		}),
	);

	it.effect("refreshes git before broadcasting a completed turn", () =>
		Effect.gen(function* () {
			const order: string[] = [];
			const wsHandler = makeMockWebSocketHandler();
			const sessionManagerService = makeMockSessionManagerService({
				sendSessionLists: () =>
					Effect.sync(() => {
						order.push("broadcast");
					}),
			});
			const layer = makeSessionStateProjectionNotifierLive(async () => {
				order.push("refresh");
			}).pipe(
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
				expect(order).toEqual(["refresh"]);
				yield* TestClock.adjust("150 millis");
				expect(order).toEqual(["refresh", "broadcast"]);
			}).pipe(Effect.provide(layer));
		}),
	);
	it.effect("broadcasts after a git refresh failure", () =>
		Effect.gen(function* () {
			const wsHandler = makeMockWebSocketHandler();
			const sendSessionLists = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				sendSessionLists,
			});
			const layer = makeSessionStateProjectionNotifierLive(async () => {
				throw new Error("git unavailable");
			}).pipe(
				Layer.provide(
					Layer.merge(
						Layer.succeed(WebSocketHandlerTag, wsHandler),
						Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					),
				),
			);
			yield* Effect.gen(function* () {
				const notifier = yield* SessionStateProjectionNotifierTag;
				yield* notifier.sessionStateProjected("session-1", "turn.error");
				yield* TestClock.adjust("150 millis");
				expect(sendSessionLists).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(layer));
		}),
	);
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
