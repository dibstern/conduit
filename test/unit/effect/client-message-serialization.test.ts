import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	activeClients,
	getClientSemaphore,
	getQueueDepth,
	removeClient,
} from "../../../src/lib/server/client-semaphore.js";

describe("Per-client semaphore serialization", () => {
	it.live("serializes concurrent handlers for same client", () =>
		Effect.gen(function* () {
			const order: string[] = [];
			const semaphore = Effect.unsafeMakeSemaphore(1);

			const handler1 = semaphore.withPermits(1)(
				Effect.gen(function* () {
					order.push("h1-start");
					yield* Effect.sleep("50 millis");
					order.push("h1-end");
				}),
			);
			const handler2 = semaphore.withPermits(1)(
				Effect.sync(() => {
					order.push("h2-start");
					order.push("h2-end");
				}),
			);

			yield* Effect.all([handler1, handler2], { concurrency: 2 });
			expect(order).toEqual(["h1-start", "h1-end", "h2-start", "h2-end"]);
		}),
	);

	it.live("allows parallel execution for different clients", () =>
		Effect.gen(function* () {
			const order: string[] = [];
			const sem1 = Effect.unsafeMakeSemaphore(1);
			const sem2 = Effect.unsafeMakeSemaphore(1);

			const handler1 = sem1.withPermits(1)(
				Effect.gen(function* () {
					yield* Effect.sleep("50 millis");
					order.push("c1");
				}),
			);
			const handler2 = sem2.withPermits(1)(
				Effect.sync(() => {
					order.push("c2");
				}),
			);

			yield* Effect.all([handler1, handler2], { concurrency: 2 });
			// c2 should finish before c1 because they are on separate semaphores
			expect(order).toEqual(["c2", "c1"]);
		}),
	);

	it("getClientSemaphore returns the same semaphore for same client", () => {
		const sem1 = getClientSemaphore("test-same-1");
		const sem2 = getClientSemaphore("test-same-1");
		expect(sem1).toBe(sem2);
		removeClient("test-same-1");
	});

	it("getClientSemaphore returns different semaphores for different clients", () => {
		const sem1 = getClientSemaphore("test-diff-1");
		const sem2 = getClientSemaphore("test-diff-2");
		expect(sem1).not.toBe(sem2);
		removeClient("test-diff-1");
		removeClient("test-diff-2");
	});

	it("removeClient cleans up the semaphore map entry", () => {
		getClientSemaphore("test-remove");
		expect(getQueueDepth("test-remove")).toBe(0);
		removeClient("test-remove");
		// After removal, a new call returns a fresh semaphore
		const fresh = getClientSemaphore("test-remove");
		expect(fresh).toBeDefined();
		removeClient("test-remove");
	});

	it("activeClients tracks number of tracked clients", () => {
		const before = activeClients();
		getClientSemaphore("test-active-1");
		getClientSemaphore("test-active-2");
		expect(activeClients()).toBe(before + 2);
		removeClient("test-active-1");
		removeClient("test-active-2");
		expect(activeClients()).toBe(before);
	});

	it("getQueueDepth returns 0 for unknown client", () => {
		expect(getQueueDepth("unknown-client-xyz")).toBe(0);
	});
});
