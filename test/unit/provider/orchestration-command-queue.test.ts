import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { DurableCommandQueue } from "../../../src/lib/provider/orchestration-command-queue.js";

describe("DurableCommandQueue", () => {
	it("serializes command work and shares same-command waiters", async () => {
		const queue = new DurableCommandQueue();
		const order: string[] = [];
		const firstGate = await Effect.runPromise(Deferred.make<void>());

		const first = Effect.runPromise(
			queue.run(
				"cmd-1",
				Effect.gen(function* () {
					order.push("first:start");
					yield* Deferred.await(firstGate);
					order.push("first:end");
					return "one";
				}),
			),
		);
		const duplicate = Effect.runPromise(
			queue.run(
				"cmd-1",
				Effect.sync(() => {
					order.push("duplicate");
					return "duplicate";
				}),
			),
		);
		const second = Effect.runPromise(
			queue.run(
				"cmd-2",
				Effect.sync(() => {
					order.push("second");
					return "two";
				}),
			),
		);

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);

		await Effect.runPromise(Deferred.succeed(firstGate, undefined));

		await expect(first).resolves.toBe("one");
		await expect(duplicate).resolves.toBe("one");
		await expect(second).resolves.toBe("two");
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("returns an Effect program instead of starting Promise work eagerly", async () => {
		const queue = new DurableCommandQueue();
		const order: string[] = [];

		const program = queue.run(
			"cmd-1",
			Effect.sync(() => {
				order.push("ran");
				return "ok";
			}),
		);

		expect(Effect.isEffect(program)).toBe(true);
		expect(order).toEqual([]);
		await expect(Effect.runPromise(program)).resolves.toBe("ok");
		expect(order).toEqual(["ran"]);
	});

	it("shares same-command waiters across concurrent Effect fibers", async () => {
		const queue = new DurableCommandQueue<string>();
		let runs = 0;
		const firstGate = await Effect.runPromise(Deferred.make<void>());
		const firstStarted = await Effect.runPromise(Deferred.make<void>());

		const resultPromise = Effect.runPromise(
			Effect.all(
				[
					queue.run(
						"cmd-1",
						Effect.gen(function* () {
							runs += 1;
							yield* Deferred.succeed(firstStarted, undefined);
							yield* Deferred.await(firstGate);
							return "first";
						}),
					),
					queue.run(
						"cmd-1",
						Effect.sync(() => {
							runs += 1;
							return "second";
						}),
					),
				],
				{ concurrency: "unbounded" },
			),
		);

		await Effect.runPromise(Deferred.await(firstStarted));
		expect(runs).toBe(1);
		await Effect.runPromise(Deferred.succeed(firstGate, undefined));

		const result = await resultPromise;
		expect(result).toEqual(["first", "first"]);
		expect(runs).toBe(1);
	});
});
