import { describe, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";
import { expect } from "vitest";
import {
	makeSessionEventBusLive,
	SESSION_EVENT_BUS_CAPACITY,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";

function stored(sessionId: string, sequence: number): StoredEvent {
	return {
		...canonicalEvent("message.created", sessionId, {
			messageId: `m-${sequence}`,
			role: "assistant",
			sessionId,
		}),
		sequence,
		streamVersion: sequence - 1,
	};
}

describe("SessionEventBus", () => {
	it.scoped(
		"streams only the filtered session's committed events, in order",
		() =>
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				// Subscribe before publishing so events buffer into the subscription.
				const stream = yield* bus.subscribe({ sessionId: "session-a" });
				yield* bus.publish([
					stored("session-a", 1),
					stored("session-b", 2),
					stored("session-a", 3),
				]);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				const got = Chunk.toReadonlyArray(events);

				expect(got.map((e) => e.sequence)).toEqual([1, 3]);
				expect(got.every((e) => e.sessionId === "session-a")).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(makeSessionEventBusLive()))),
	);

	it.scoped("delivers every session when no filter is given", () =>
		Effect.gen(function* () {
			const bus = yield* SessionEventBusTag;
			const stream = yield* bus.subscribe();
			yield* bus.publish([stored("s1", 1), stored("s2", 2)]);

			const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);

			expect(Chunk.toReadonlyArray(events).map((e) => e.sessionId)).toEqual([
				"s1",
				"s2",
			]);
		}).pipe(Effect.provide(Layer.fresh(makeSessionEventBusLive()))),
	);

	it.scoped("fans out committed events to every subscriber", () =>
		Effect.gen(function* () {
			const bus = yield* SessionEventBusTag;
			const first = yield* bus.subscribe();
			const second = yield* bus.subscribe();
			yield* bus.publish([stored("s1", 1)]);

			const a = yield* first.pipe(Stream.take(1), Stream.runCollect);
			const b = yield* second.pipe(Stream.take(1), Stream.runCollect);

			expect(Chunk.toReadonlyArray(a)[0]?.sequence).toBe(1);
			expect(Chunk.toReadonlyArray(b)[0]?.sequence).toBe(1);
		}).pipe(Effect.provide(Layer.fresh(makeSessionEventBusLive()))),
	);

	it("documents the production sliding-buffer capacity", () => {
		expect(SESSION_EVENT_BUS_CAPACITY).toBe(256);
	});
});
