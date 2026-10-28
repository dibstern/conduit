import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Logger, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { SessionGit } from "../../../src/lib/domain/daemon/Services/session-git.js";
import { SessionStateProjectionNotifierLive } from "../../../src/lib/domain/relay/Layers/session-state-projection-notifier-layer.js";
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
		"interrupts an in-flight lineage refresh when its relay scope closes",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const finished = yield* Deferred.make<void>();
				const errors: string[] = [];
				const logger = Logger.make<unknown, void>((entry) => {
					if (entry.logLevel === "Error") errors.push(String(entry.message));
				});
				const sessionManagerService = makeMockSessionManagerService({
					refreshSessionLineage: () =>
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
							Layer.succeed(WebSocketHandlerTag)(makeMockWebSocketHandler()),
							Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
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
				}).pipe(Effect.provide(Logger.layer([logger, Logger.tracerLogger])));
			}),
	);
	it.effect(
		"requests git refreshes for tool results without refreshing lineage",
		() =>
			Effect.gen(function* () {
				const invalidate = vi.fn(() => Effect.void);
				const refreshSessionLineage = vi.fn(() => Effect.void);
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.succeed(SessionGit, {
							read: () => Effect.succeed(undefined),
							changes: Stream.empty,
							invalidate,
						}),
					),
					Layer.provide(
						Layer.succeed(
							SessionManagerServiceTag,
							makeMockSessionManagerService({ refreshSessionLineage }),
						),
					),
				);
				yield* Effect.gen(function* () {
					const notifier = yield* SessionStateProjectionNotifierTag;
					for (let index = 0; index < 30; index++)
						yield* notifier.sessionStateProjected(
							"session-1",
							"tool.completed",
						);
					yield* TestClock.adjust(200);
					expect(invalidate).toHaveBeenCalledTimes(30);
					expect(invalidate).toHaveBeenCalledWith({ sessionId: "session-1" });
					expect(refreshSessionLineage).not.toHaveBeenCalled();
				}).pipe(Effect.provide(layer, { local: true }));
			}),
	);

	it.effect("logs the underlying cause of a real lineage refresh failure", () =>
		Effect.gen(function* () {
			const errors: string[] = [];
			const logger = Logger.make<unknown, void>((entry) => {
				if (entry.logLevel === "Error") errors.push(String(entry.message));
			});
			const sessionManagerService = makeMockSessionManagerService({
				refreshSessionLineage: () =>
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
						Layer.succeed(WebSocketHandlerTag)(makeMockWebSocketHandler()),
						Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
					),
				),
			);

			yield* Effect.gen(function* () {
				const notifier = yield* SessionStateProjectionNotifierTag;
				yield* notifier.sessionStateProjected("session-1", "text.delta");
				yield* TestClock.adjust("150 millis");
				expect(errors.join("\n")).toContain("SQLite query failed");
			}).pipe(
				Effect.provide(layer, { local: true }),
				Effect.provide(Logger.layer([logger, Logger.tracerLogger])),
			);
		}),
	);

	it.effect(
		"invalidates git before refreshing lineage after a completed turn",
		() =>
			Effect.gen(function* () {
				const order: string[] = [];
				const wsHandler = makeMockWebSocketHandler();
				const sessionManagerService = makeMockSessionManagerService({
					refreshSessionLineage: () =>
						Effect.sync(() => {
							order.push("lineage");
						}),
				});
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.succeed(SessionGit, {
							read: () => Effect.succeed(undefined),
							changes: Stream.empty,
							invalidate: () =>
								Effect.sync(() => {
									order.push("invalidate");
								}),
						}),
					),
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag)(wsHandler),
							Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
						),
					),
				);
				yield* Effect.gen(function* () {
					const notifier = yield* SessionStateProjectionNotifierTag;
					yield* notifier.sessionStateProjected("session-1", "turn.completed");
					yield* Effect.yieldNow;
					expect(order).toEqual(["invalidate"]);
					yield* TestClock.adjust("150 millis");
					expect(order).toEqual(["invalidate", "lineage"]);
				}).pipe(Effect.provide(layer, { local: true }));
			}),
	);
	it.effect(
		"coalesces a burst of projected events into one lineage refresh",
		() =>
			Effect.gen(function* () {
				const wsHandler = makeMockWebSocketHandler();
				const refreshSessionLineage = vi.fn(() => Effect.void);
				const sessionManagerService = makeMockSessionManagerService({
					refreshSessionLineage,
				});
				const layer = SessionStateProjectionNotifierLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag)(wsHandler),
							Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
						),
					),
				);

				yield* Effect.gen(function* () {
					const notifier = yield* SessionStateProjectionNotifierTag;
					for (let index = 0; index < 100; index++) {
						yield* notifier.sessionStateProjected("session-1", "text.delta");
					}
					yield* TestClock.adjust("150 millis");

					expect(refreshSessionLineage).toHaveBeenCalledTimes(1);
				}).pipe(Effect.provide(layer, { local: true }));
			}),
	);

	// A state change that lands while a refresh is in flight is the whole
	// reason this service exists: if the coalescing slot stayed taken until the
	// fan-out finished, that change would be silently dropped with nothing left
	// to ever publish it.
	it.effect("arms a fresh refresh for a change that lands mid-refresh", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const wsHandler = makeMockWebSocketHandler();
			const refreshSessionLineage = vi.fn(() =>
				Deferred.succeed(started, undefined).pipe(
					Effect.andThen(Deferred.await(release)),
				),
			);
			const sessionManagerService = makeMockSessionManagerService({
				refreshSessionLineage,
			});
			const layer = SessionStateProjectionNotifierLive.pipe(
				Layer.provide(
					Layer.merge(
						Layer.succeed(WebSocketHandlerTag)(wsHandler),
						Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
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
				yield* Effect.yieldNow;
				yield* TestClock.adjust("150 millis");
				expect(refreshSessionLineage).toHaveBeenCalledTimes(2);

				yield* Deferred.succeed(release, undefined);
			}).pipe(Effect.provide(layer, { local: true }));
		}),
	);

	// A turn end is what makes a session unread; only a user's pick clears it
	// (ADR-0004, Scope; conduit-test-hk9m.3). Main used to mark it read here
	// whenever any window was viewing the session.
	it.effect("never marks a turn read, even when the session has viewers", () =>
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
						Layer.succeed(WebSocketHandlerTag)(wsHandler),
						Layer.succeed(SessionManagerServiceTag)(sessionManagerService),
					),
				),
			);

			yield* Effect.gen(function* () {
				const notifier = yield* SessionStateProjectionNotifierTag;
				yield* notifier.sessionStateProjected("session-1", "turn.completed");
				yield* notifier.sessionStateProjected("session-1", "turn.error");

				yield* TestClock.adjust("150 millis");
				expect(markSessionRead).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer, { local: true }));
		}),
	);
});
