// test/unit/effect/prompt-queue.test.ts

import { describe, it } from "@effect/vitest";
import { Effect, Exit, Queue } from "effect";
import { expect } from "vitest";

describe("Effect Queue replaces PromptQueue", () => {
	it.effect("enqueue and dequeue in order", () =>
		Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Queue.offer(queue, "first");
			yield* Queue.offer(queue, "second");
			const a = yield* Queue.take(queue);
			const b = yield* Queue.take(queue);
			expect([a, b]).toEqual(["first", "second"]);
		}),
	);

	it.live("take blocks until item available", () =>
		Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Effect.fork(
				Effect.flatMap(Effect.sleep("50 millis"), () =>
					Queue.offer(queue, "delayed"),
				),
			);
			const val = yield* Queue.take(queue);
			expect(val).toBe("delayed");
		}),
	);

	it.effect("shutdown signals end to consumers", () =>
		Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Queue.offer(queue, "item");
			yield* Queue.shutdown(queue);
			const result = yield* Queue.isShutdown(queue);
			expect(result).toBe(true);
		}),
	);

	it.effect("take on shutdown queue returns failure", () =>
		Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Queue.shutdown(queue);
			const exit = yield* Effect.exit(Queue.take(queue));
			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);
});
