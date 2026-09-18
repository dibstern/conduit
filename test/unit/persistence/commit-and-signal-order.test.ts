import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { expect } from "vitest";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

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
