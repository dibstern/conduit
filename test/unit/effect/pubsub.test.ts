import { Effect, PubSub, Queue } from "effect";
import { describe, expect, it } from "vitest";

describe("Effect PubSub replaces EventEmitter", () => {
	it("publishes to multiple subscribers", async () => {
		const program = Effect.scoped(
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

				return { msg1, msg2 };
			}),
		);

		const { msg1, msg2 } = await Effect.runPromise(program);
		expect(msg1._tag).toBe("Created");
		expect(msg2._tag).toBe("Created");
		expect(msg1.data).toBe("session-1");
	});

	it("subscriber receives only messages after subscription", async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				const pubsub = yield* PubSub.unbounded<string>();

				// Publish before subscribing — should NOT be received
				yield* PubSub.publish(pubsub, "before");

				const sub = yield* PubSub.subscribe(pubsub);

				// Publish after subscribing — SHOULD be received
				yield* PubSub.publish(pubsub, "after");

				const msg = yield* Queue.take(sub);
				return msg;
			}),
		);

		const result = await Effect.runPromise(program);
		expect(result).toBe("after");
	});

	it("shutdown prevents further publishes", async () => {
		const program = Effect.scoped(
			Effect.gen(function* () {
				const pubsub = yield* PubSub.unbounded<string>();
				yield* PubSub.publish(pubsub, "hello");
				yield* PubSub.shutdown(pubsub);

				const isShutdown = yield* PubSub.isShutdown(pubsub);
				return isShutdown;
			}),
		);

		const result = await Effect.runPromise(program);
		expect(result).toBe(true);
	});
});
