// test/unit/effect/prompt-queue.test.ts

import { Effect, Exit, Queue } from "effect";
import { describe, expect, it } from "vitest";

describe("Effect Queue replaces PromptQueue", () => {
	it("enqueue and dequeue in order", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Queue.offer(queue, "first");
			yield* Queue.offer(queue, "second");
			const a = yield* Queue.take(queue);
			const b = yield* Queue.take(queue);
			return [a, b];
		});
		const result = await Effect.runPromise(program);
		expect(result).toEqual(["first", "second"]);
	});

	it("take blocks until item available", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Effect.fork(
				Effect.flatMap(Effect.sleep("50 millis"), () =>
					Queue.offer(queue, "delayed"),
				),
			);
			const val = yield* Queue.take(queue);
			return val;
		});
		const result = await Effect.runPromise(program);
		expect(result).toBe("delayed");
	});

	it("shutdown signals end to consumers", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Queue.offer(queue, "item");
			yield* Queue.shutdown(queue);
			return yield* Queue.isShutdown(queue);
		});
		const result = await Effect.runPromise(program);
		expect(result).toBe(true);
	});

	it("take on shutdown queue returns failure", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* Queue.unbounded<string>();
			yield* Queue.shutdown(queue);
			const exit = yield* Effect.exit(Queue.take(queue));
			return Exit.isFailure(exit);
		});
		const result = await Effect.runPromise(program);
		expect(result).toBe(true);
	});
});
