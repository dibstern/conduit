import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { expect, vi } from "vitest";
import { makeSessionStateProjectionNotifierLive } from "../../../src/lib/domain/relay/Layers/session-state-projection-notifier-layer.js";
import { WebSocketHandlerTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

const testLayer = Layer.merge(
	makePersistenceEffectLayer(":memory:", undefined, SessionEventBusLive),
	SessionEventBusLive,
);

const created = (sessionId: string) =>
	canonicalEvent("session.created", sessionId, {
		sessionId,
		title: sessionId,
		provider: "claude",
	});

describe("commit advance ordering", () => {
	it.effect(
		"returns after publishing a turn while git refresh remains pending",
		() =>
			Effect.gen(function* () {
				let releaseRefresh: (() => void) | undefined;
				const refreshStarted = yield* Deferred.make<void>();
				const notifier = makeSessionStateProjectionNotifierLive(() => {
					Effect.runSync(Deferred.succeed(refreshStarted, undefined));
					return new Promise<void>((resolve) => {
						releaseRefresh = resolve;
					});
				}).pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
							Layer.succeed(
								SessionManagerServiceTag,
								makeMockSessionManagerService(),
							),
						),
					),
				);
				yield* Effect.gen(function* () {
					const writer = yield* makeCommitAndSignal;
					const call = yield* writer([
						created("git-session"),
						canonicalEvent("turn.completed", "git-session", {
							messageId: "assistant-1",
						}),
					]).pipe(Effect.fork);
					yield* Deferred.await(refreshStarted);
					expect((yield* Fiber.poll(call))._tag).toBe("Some");
					releaseRefresh?.();
					yield* Fiber.join(call);
				}).pipe(Effect.provide(Layer.merge(testLayer, notifier)));
			}),
	);
	it.effect("publishes committed events before invoking the notifier", () =>
		Effect.gen(function* () {
			const order: string[] = [];
			const bus = yield* SessionEventBusTag;
			const recordingBus: SessionEventBus = {
				...bus,
				publish: (events) =>
					Effect.sync(() => {
						order.push("publish");
					}).pipe(Effect.zipRight(bus.publish(events))),
			};
			const writer = yield* makeCommitAndSignal.pipe(
				Effect.provideService(SessionEventBusTag, recordingBus),
			);
			yield* writer([created("ordered")]).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected: () => Effect.sync(() => order.push("notify")),
				}),
			);
			expect(order).toEqual(["publish", "notify"]);
		}).pipe(Effect.provide(testLayer)),
	);
	it.effect("does not notify while recover replays the event log", () => {
		const sessionStateProjected = vi.fn(() => Effect.void);
		return Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* store.append(created("replayed"));
			yield* runner.recover();
			expect(sessionStateProjected).not.toHaveBeenCalled();
		}).pipe(
			Effect.provideService(SessionStateProjectionNotifierTag, {
				sessionStateProjected,
			}),
			Effect.provide(testLayer),
		);
	});

	it.effect(
		"notifies after the event and its projection have committed",
		() => {
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sessionStateProjected = vi.fn((sessionId: string) =>
					sql<{
						title: string;
					}>`SELECT title FROM sessions WHERE id = ${sessionId}`.pipe(
						Effect.tap((rows) =>
							Effect.sync(() => expect(rows).toEqual([{ title: sessionId }])),
						),
						Effect.orDie,
						Effect.asVoid,
					),
				);
				const writer = yield* makeCommitAndSignal;
				yield* writer([created("committed")]).pipe(
					Effect.provideService(SessionStateProjectionNotifierTag, {
						sessionStateProjected,
					}),
				);
				expect(sessionStateProjected).toHaveBeenCalledOnce();
				expect(sessionStateProjected).toHaveBeenCalledWith(
					"committed",
					"session.created",
				);
			}).pipe(Effect.provide(testLayer));
		},
	);

	it.effect(
		"notifies once for every successfully projected batch event",
		() => {
			const sessionStateProjected = vi.fn(() => Effect.void);
			return Effect.gen(function* () {
				const writer = yield* makeCommitAndSignal;
				yield* writer([created("first"), created("second")]);
				expect(sessionStateProjected.mock.calls).toEqual([
					["first", "session.created"],
					["second", "session.created"],
				]);
			}).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected,
				}),
				Effect.provide(testLayer),
			);
		},
	);

	it.effect("projects successfully when the notifier service is absent", () =>
		Effect.gen(function* () {
			const writer = yield* makeCommitAndSignal;
			yield* writer([created("without-notifier")]);
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ title: string }>`
				SELECT title FROM sessions WHERE id = 'without-notifier'`;
			expect(rows).toEqual([{ title: "without-notifier" }]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.scoped(
		"allows afterCommit to commit again after publishing its own advance",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const bus = yield* SessionEventBusTag;
				const advances = yield* bus.subscribeAdvances();
				const writer = yield* makeCommitAndSignal;
				yield* writer([created("a")], {
					afterCommit: writer([created("b")]).pipe(Effect.orDie),
				});
				const received = yield* Stream.runCollect(Stream.take(advances, 2));
				expect(Array.from(received, (advance) => advance.version)).toEqual([
					1, 2,
				]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.scoped(
		"publishes in commit order across writers while afterCommit is stalled",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const bus = yield* SessionEventBusTag;
				const advances = yield* bus.subscribeAdvances();
				const firstWriter = yield* makeCommitAndSignal;
				const secondWriter = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const first = yield* firstWriter([created("a")], {
					afterCommit: Effect.zipRight(
						Deferred.succeed(entered, undefined),
						Deferred.await(release),
					),
				}).pipe(Effect.fork);
				yield* Deferred.await(entered);
				yield* secondWriter([created("b")]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				const received = yield* Stream.runCollect(Stream.take(advances, 2));
				expect(Array.from(received, (advance) => advance.version)).toEqual([
					1, 2,
				]);
			}).pipe(Effect.provide(testLayer)),
	);
});
