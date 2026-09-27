import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, TestClock } from "effect";
import { expect, vi } from "vitest";
import {
	makeSessionStateProjectionNotifierLive,
	SessionStateProjectionNotifierLive,
} from "../../../src/lib/domain/relay/Layers/session-state-projection-notifier-layer.js";
import { WebSocketHandlerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import {
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

describe("SessionStateProjectionNotifier", () => {
	it.effect("returns while git refresh is still running", () =>
		Effect.gen(function* () {
			let releaseRefresh: (() => void) | undefined;
			const refreshStarted = yield* Deferred.make<void>();
			const wsHandler = makeMockWebSocketHandler();
			const sessionManagerService = makeMockSessionManagerService();
			const layer = makeSessionStateProjectionNotifierLive(() => {
				Effect.runSync(Deferred.succeed(refreshStarted, undefined));
				return new Promise<void>((resolve) => {
					releaseRefresh = resolve;
				});
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
				const call = yield* notifier
					.sessionStateProjected("session-1", "turn.completed")
					.pipe(Effect.fork);
				yield* Deferred.await(refreshStarted);
				expect((yield* Fiber.poll(call))._tag).toBe("Some");
				releaseRefresh?.();
				yield* Fiber.join(call);
			}).pipe(Effect.provide(layer));
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
				yield* Effect.yieldNow();
				expect(order).toEqual(["refresh"]);
				yield* TestClock.adjust("150 millis");
				expect(order).toEqual(["refresh", "broadcast"]);
			}).pipe(Effect.provide(layer));
		}),
	);
	it.effect(
		"delivers refreshed git context to the list after a turn ends",
		() =>
			Effect.gen(function* () {
				let branch = "before";
				const wsHandler = makeMockWebSocketHandler();
				const sessionManagerService = makeMockSessionManagerService({
					sendSessionLists: (send) =>
						Effect.sync(() =>
							send({
								type: "session_list",
								roots: true,
								sessions: [
									{
										id: "session-1",
										title: "Session",
										status: "idle",
										git: { branch },
									},
								],
							}),
						),
				});
				const layer = makeSessionStateProjectionNotifierLive(async () => {
					branch = "after";
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
					yield* TestClock.adjust("150 millis");
					expect(wsHandler.broadcast).toHaveBeenCalledWith({
						type: "session_list",
						roots: true,
						sessions: [
							{
								id: "session-1",
								title: "Session",
								status: "idle",
								git: { branch: "after" },
							},
						],
					});
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
						Layer.succeed(WebSocketHandlerTag, wsHandler),
						Layer.succeed(SessionManagerServiceTag, sessionManagerService),
					),
				),
			);

			yield* Effect.gen(function* () {
				const notifier = yield* SessionStateProjectionNotifierTag;
				yield* notifier.sessionStateProjected("session-1", "turn.completed");
				yield* notifier.sessionStateProjected("session-1", "turn.error");

				yield* TestClock.adjust("150 millis");
				expect(markSessionRead).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		}),
	);
});
