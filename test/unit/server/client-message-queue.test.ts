import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	activeClients,
	getClientSemaphore,
	getQueueDepth,
	removeClient,
} from "../../../src/lib/server/client-semaphore.js";

describe("Per-client Semaphore (replaces ClientMessageQueue)", () => {
	it("processes messages for the same client sequentially", async () => {
		const order: string[] = [];
		const sem = getClientSemaphore("cmq-c1-seq");

		const p1 = sem.withPermits(1)(
			Effect.gen(function* () {
				yield* Effect.sleep("50 millis");
				order.push("c1-first");
			}),
		);
		const p2 = sem.withPermits(1)(
			Effect.sync(() => {
				order.push("c1-second");
			}),
		);

		await Effect.runPromise(Effect.all([p1, p2], { concurrency: 2 }));
		expect(order).toEqual(["c1-first", "c1-second"]);
		removeClient("cmq-c1-seq");
	});

	it("processes messages for different clients in parallel", async () => {
		const order: string[] = [];
		const sem1 = getClientSemaphore("cmq-c1-par");
		const sem2 = getClientSemaphore("cmq-c2-par");

		const p1 = sem1.withPermits(1)(
			Effect.gen(function* () {
				yield* Effect.sleep("50 millis");
				order.push("c1");
			}),
		);
		const p2 = sem2.withPermits(1)(
			Effect.sync(() => {
				order.push("c2");
			}),
		);

		await Effect.runPromise(Effect.all([p1, p2], { concurrency: 2 }));
		// c2 should finish before c1 because they run in parallel
		expect(order).toEqual(["c2", "c1"]);
		removeClient("cmq-c1-par");
		removeClient("cmq-c2-par");
	});

	it("continues processing after handler error", async () => {
		const order: string[] = [];
		const sem = getClientSemaphore("cmq-c1-err");

		// First handler throws, but semaphore still releases after catchAll
		const h1 = sem.withPermits(1)(
			Effect.gen(function* () {
				yield* Effect.fail(new Error("boom"));
			}).pipe(Effect.catchAll(() => Effect.void)),
		);

		const h2 = sem.withPermits(1)(
			Effect.sync(() => {
				order.push("c1-after-error");
			}),
		);

		await Effect.runPromise(Effect.all([h1, h2], { concurrency: 2 }));
		expect(order).toEqual(["c1-after-error"]);
		removeClient("cmq-c1-err");
	});

	it("cleans up idle clients via removeClient", () => {
		getClientSemaphore("cmq-c1-cleanup");
		expect(activeClients()).toBeGreaterThanOrEqual(1);
		removeClient("cmq-c1-cleanup");
	});

	it("removeClient removes semaphore entry", () => {
		const before = activeClients();
		getClientSemaphore("cmq-c1-remove");
		expect(activeClients()).toBe(before + 1);
		removeClient("cmq-c1-remove");
		expect(activeClients()).toBe(before);
	});

	it("getQueueDepth returns 0 for unknown client", () => {
		expect(getQueueDepth("cmq-unknown")).toBe(0);
	});
});
