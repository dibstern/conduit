import { describe, it } from "@effect/vitest";
import { Effect, PubSub, Queue } from "effect";
import { expect } from "vitest";

describe("Effect PubSub replaces EventEmitter", () => {
	it.scoped("publishes to multiple subscribers", () =>
		Effect.gen(function* () {
			const pubsub = yield* PubSub.unbounded<{
				_tag: string;
				data: string;
			}>();

			const sub1 = yield* PubSub.subscribe(pubsub);
			const sub2 = yield* PubSub.subscribe(pubsub);

			yield* PubSub.publish(pubsub, {
				_tag: "Created",
				data: "session-1",
			});

			const msg1 = yield* Queue.take(sub1);
			const msg2 = yield* Queue.take(sub2);

			expect(msg1._tag).toBe("Created");
			expect(msg2._tag).toBe("Created");
			expect(msg1.data).toBe("session-1");
		}),
	);

	it.scoped("subscriber receives only messages after subscription", () =>
		Effect.gen(function* () {
			const pubsub = yield* PubSub.unbounded<string>();

			// Publish before subscribing — should NOT be received
			yield* PubSub.publish(pubsub, "before");

			const sub = yield* PubSub.subscribe(pubsub);

			// Publish after subscribing — SHOULD be received
			yield* PubSub.publish(pubsub, "after");

			const msg = yield* Queue.take(sub);
			expect(msg).toBe("after");
		}),
	);

	it.scoped("shutdown prevents further publishes", () =>
		Effect.gen(function* () {
			const pubsub = yield* PubSub.unbounded<string>();
			yield* PubSub.publish(pubsub, "hello");
			yield* PubSub.shutdown(pubsub);

			const isShutdown = yield* PubSub.isShutdown(pubsub);
			expect(isShutdown).toBe(true);
		}),
	);
});
