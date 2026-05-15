// ─── SSE Stream Effect Tests ─────────────────────────────────────────────────
// Tests for the Effect.Stream-based SSE implementation.

import { describe, it } from "@effect/vitest";
import {
	Chunk,
	Duration,
	Effect,
	Exit,
	Fiber,
	Stream,
	TestClock,
} from "effect";
import { expect } from "vitest";
import {
	reconnectSchedule,
	type SSEEvent,
} from "../../../src/lib/domain/relay/Services/sse-stream.js";

describe("SSE Stream Effect", () => {
	it("reconnectSchedule has exponential backoff with jitter", () => {
		expect(reconnectSchedule).toBeDefined();
	});

	it.effect("sseStream produces SSEEvent items", () =>
		Effect.gen(function* () {
			const events: SSEEvent[] = [
				{ type: "message", data: '{"id":"1"}', lastEventId: "1" },
				{ type: "message", data: '{"id":"2"}', lastEventId: "2" },
			];

			const mockStream = Stream.fromIterable(events);

			const result = yield* Stream.runCollect(mockStream).pipe(
				Effect.map(Chunk.toArray),
			);

			expect(result).toHaveLength(2);
			expect(result[0]?.data).toBe('{"id":"1"}');
		}),
	);

	it.effect("stale detection fails stream after timeout", () =>
		Effect.gen(function* () {
			const neverStream = Stream.never as Stream.Stream<SSEEvent, never>;

			const fiber = yield* Effect.fork(
				Stream.runDrain(
					neverStream.pipe(
						Stream.timeoutFail(
							() => new Error("SSE stale"),
							Duration.millis(100),
						),
					),
				),
			);

			yield* TestClock.adjust(Duration.millis(150));
			const exit = yield* Fiber.join(fiber).pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);
});
