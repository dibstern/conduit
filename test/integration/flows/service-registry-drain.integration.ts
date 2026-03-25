/**
 * Integration test: ServiceRegistry drains real services with real timers.
 *
 * No fake timers, no mocks — exercises the actual AsyncTracker / TrackedService
 * / ServiceRegistry stack with real setInterval, setTimeout, and promises.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { TrackedService } from "../../../src/lib/daemon/tracked-service.js";

// ── Concrete services for testing ──────────────────────────────────────────

class TickingService extends TrackedService {
	ticks = 0;
	start(ms: number): void {
		this.repeating(() => {
			this.ticks++;
		}, ms);
	}
}

class DelayedWorkService extends TrackedService {
	completed = false;
	startWork(ms: number): void {
		this.delayed(() => {
			this.completed = true;
		}, ms);
	}
}

class InFlightPromiseService extends TrackedService {
	settled = false;
	startWork(ms: number): Promise<string> {
		return this.tracked(
			new Promise<string>((resolve) => {
				setTimeout(() => {
					this.settled = true;
					resolve("done");
				}, ms);
			}),
		);
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ServiceRegistry drain (real timers)", () => {
	let registry: ServiceRegistry;

	afterEach(async () => {
		// Safety net — drain anything left over from a failing test
		await registry?.drainAll();
	});

	it("drainAll stops real setInterval timers from firing", async () => {
		registry = new ServiceRegistry();
		const svc = new TickingService(registry);
		svc.start(20); // tick every 20ms

		// Let it tick a few times
		await new Promise((r) => setTimeout(r, 70));
		expect(svc.ticks).toBeGreaterThanOrEqual(2);

		// Drain
		await registry.drainAll();
		const ticksAtDrain = svc.ticks;

		// Wait — no more ticks should fire
		await new Promise((r) => setTimeout(r, 60));
		expect(svc.ticks).toBe(ticksAtDrain);
	});

	it("drainAll clears real setTimeout timers before they fire", async () => {
		registry = new ServiceRegistry();
		const svc = new DelayedWorkService(registry);
		svc.startWork(200); // fire after 200ms

		// Drain immediately — before the timeout fires
		await registry.drainAll();
		expect(svc.completed).toBe(false);

		// Wait past the original timeout — should never fire
		await new Promise((r) => setTimeout(r, 300));
		expect(svc.completed).toBe(false);
	});

	it("drainAll waits for in-flight promises to settle", async () => {
		registry = new ServiceRegistry();
		const svc = new InFlightPromiseService(registry);
		const resultPromise = svc.startWork(50); // settles after 50ms

		// Drain — should wait for the tracked promise
		await registry.drainAll();
		expect(svc.settled).toBe(true);
		await expect(resultPromise).resolves.toBe("done");
	});

	it("drainAll handles multiple services of different types", async () => {
		registry = new ServiceRegistry();

		const ticker = new TickingService(registry);
		ticker.start(20);

		const delayer = new DelayedWorkService(registry);
		delayer.startWork(500); // should be cancelled

		const inflight = new InFlightPromiseService(registry);
		inflight.startWork(30); // should be awaited

		// Let services run briefly
		await new Promise((r) => setTimeout(r, 50));
		expect(ticker.ticks).toBeGreaterThanOrEqual(1);

		// Drain everything
		await registry.drainAll();

		// Ticker stopped
		const ticksAtDrain = ticker.ticks;
		await new Promise((r) => setTimeout(r, 60));
		expect(ticker.ticks).toBe(ticksAtDrain);

		// Delayed work was cancelled
		expect(delayer.completed).toBe(false);

		// In-flight work completed
		expect(inflight.settled).toBe(true);

		// Registry is empty
		expect(registry.size).toBe(0);
	});

	it("drain aborts the AbortSignal for fetch-like operations", async () => {
		registry = new ServiceRegistry();

		class FetchService extends TrackedService {
			aborted = false;
			startListening(): void {
				// Simulate a long-running operation that checks the signal
				this.tracked(
					new Promise<void>((resolve) => {
						const check = setInterval(() => {
							if (this.abortSignal.aborted) {
								this.aborted = true;
								clearInterval(check);
								resolve();
							}
						}, 10);
					}),
				);
			}
		}

		const svc = new FetchService(registry);
		svc.startListening();

		await registry.drainAll();
		expect(svc.aborted).toBe(true);
	});
});
