import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";
import {
	ClientMessageSerializationLive,
	ClientMessageSerializationTag,
} from "../../../src/lib/effect/client-message-serialization.js";

const provideFreshSerialization = <A, E>(
	effect: Effect.Effect<A, E, ClientMessageSerializationTag>,
) => effect.pipe(Effect.provide(Layer.fresh(ClientMessageSerializationLive)));

describe("ClientMessageSerialization", () => {
	it.effect("serializes concurrent effects for the same client", () =>
		provideFreshSerialization(
			Effect.gen(function* () {
				const serialization = yield* ClientMessageSerializationTag;
				const order: string[] = [];
				const firstStarted = yield* Deferred.make<void>();
				const releaseFirst = yield* Deferred.make<void>();

				const firstFiber = yield* serialization
					.withClient(
						"client-1",
						Effect.gen(function* () {
							order.push("first-start");
							yield* Deferred.succeed(firstStarted, undefined);
							yield* Deferred.await(releaseFirst);
							order.push("first-end");
						}),
					)
					.pipe(Effect.fork);

				yield* Deferred.await(firstStarted);

				const secondFiber = yield* serialization
					.withClient(
						"client-1",
						Effect.sync(() => {
							order.push("second");
						}),
					)
					.pipe(Effect.fork);

				yield* Effect.yieldNow();
				expect(order).toEqual(["first-start"]);

				yield* Deferred.succeed(releaseFirst, undefined);
				yield* Fiber.join(firstFiber);
				yield* Fiber.join(secondFiber);

				expect(order).toEqual(["first-start", "first-end", "second"]);
			}),
		),
	);

	it.effect("allows different clients to run concurrently", () =>
		provideFreshSerialization(
			Effect.gen(function* () {
				const serialization = yield* ClientMessageSerializationTag;
				const order: string[] = [];
				const firstStarted = yield* Deferred.make<void>();
				const releaseFirst = yield* Deferred.make<void>();

				const firstFiber = yield* serialization
					.withClient(
						"client-1",
						Effect.gen(function* () {
							order.push("client-1-start");
							yield* Deferred.succeed(firstStarted, undefined);
							yield* Deferred.await(releaseFirst);
							order.push("client-1-end");
						}),
					)
					.pipe(Effect.fork);

				yield* Deferred.await(firstStarted);

				const secondFiber = yield* serialization
					.withClient(
						"client-2",
						Effect.sync(() => {
							order.push("client-2");
						}),
					)
					.pipe(Effect.fork);

				yield* Fiber.join(secondFiber);
				expect(order).toEqual(["client-1-start", "client-2"]);

				yield* Deferred.succeed(releaseFirst, undefined);
				yield* Fiber.join(firstFiber);
				expect(order).toEqual(["client-1-start", "client-2", "client-1-end"]);
			}),
		),
	);

	it.effect("releases the client permit when an effect fails", () =>
		provideFreshSerialization(
			Effect.gen(function* () {
				const serialization = yield* ClientMessageSerializationTag;
				const order: string[] = [];

				yield* serialization
					.withClient(
						"client-1",
						Effect.gen(function* () {
							order.push("first");
							return yield* Effect.fail(new Error("boom"));
						}),
					)
					.pipe(Effect.either);

				yield* serialization.withClient(
					"client-1",
					Effect.sync(() => {
						order.push("second");
					}),
				);

				expect(order).toEqual(["first", "second"]);
			}),
		),
	);

	it.effect(
		"tracks and removes per-client state inside the provided layer",
		() =>
			provideFreshSerialization(
				Effect.gen(function* () {
					const serialization = yield* ClientMessageSerializationTag;

					expect(yield* serialization.activeClients).toBe(0);
					yield* serialization.withClient("client-1", Effect.void);
					yield* serialization.withClient("client-2", Effect.void);
					expect(yield* serialization.activeClients).toBe(2);

					yield* serialization.removeClient("client-1");
					expect(yield* serialization.activeClients).toBe(1);
				}),
			),
	);
});
