import { describe, expect, it, vi } from "vitest";
import { AsyncTracker } from "../../../src/lib/daemon/async-tracker.js";

describe("AsyncTracker", () => {
	it("track() registers and unregisters a promise", async () => {
		const tracker = new AsyncTracker();
		let resolve!: () => void;
		const p = new Promise<void>((r) => {
			resolve = r;
		});
		tracker.track(p);
		expect(tracker.pendingCount).toBe(1);
		resolve();
		await p;
		// Give microtask queue time to process .finally()
		await Promise.resolve();
		expect(tracker.pendingCount).toBe(0);
	});

	it("interval() creates a tracked interval", () => {
		const tracker = new AsyncTracker();
		const fn = vi.fn();
		tracker.interval(fn, 100);
		expect(tracker.timerCount).toBe(1);
	});

	it("timeout() creates a tracked timeout that self-removes", async () => {
		const tracker = new AsyncTracker();
		const fn = vi.fn();
		tracker.timeout(fn, 10);
		expect(tracker.timerCount).toBe(1);
		await new Promise((r) => setTimeout(r, 50));
		expect(fn).toHaveBeenCalledTimes(1);
		expect(tracker.timerCount).toBe(0);
	});

	it("drain() aborts the signal", async () => {
		const tracker = new AsyncTracker();
		expect(tracker.signal.aborted).toBe(false);
		await tracker.drain();
		expect(tracker.signal.aborted).toBe(true);
	});

	it("drain() clears all timers", async () => {
		const tracker = new AsyncTracker();
		const fn = vi.fn();
		tracker.interval(fn, 100);
		tracker.timeout(fn, 100);
		expect(tracker.timerCount).toBe(2);
		await tracker.drain();
		expect(tracker.timerCount).toBe(0);
	});

	it("drain() waits for tracked promises to settle", async () => {
		const tracker = new AsyncTracker();
		let resolved = false;
		const p = new Promise<void>((resolve) => {
			setTimeout(() => {
				resolved = true;
				resolve();
			}, 50);
		});
		tracker.track(p);
		await tracker.drain();
		expect(resolved).toBe(true);
		expect(tracker.pendingCount).toBe(0);
	});

	it("drain() handles rejected promises without throwing", async () => {
		const tracker = new AsyncTracker();
		const p = Promise.reject(new Error("boom"));
		p.catch(() => {}); // prevent unhandled rejection on original
		tracker.track(p).catch(() => {}); // prevent unhandled rejection on tracked
		await expect(tracker.drain()).resolves.toBeUndefined();
	});

	it("clearTimer() removes a specific timer", () => {
		const tracker = new AsyncTracker();
		const fn = vi.fn();
		const id = tracker.interval(fn, 100);
		expect(tracker.timerCount).toBe(1);
		tracker.clearTimer(id);
		expect(tracker.timerCount).toBe(0);
	});

	it("signal is aborted after drain", async () => {
		const tracker = new AsyncTracker();
		const signal = tracker.signal;
		await tracker.drain();
		expect(signal.aborted).toBe(true);
	});

	it("track() throws after drain()", async () => {
		const tracker = new AsyncTracker();
		await tracker.drain();
		expect(() => tracker.track(Promise.resolve())).toThrow(
			"Cannot track after drain",
		);
	});

	it("interval() throws after drain()", async () => {
		const tracker = new AsyncTracker();
		await tracker.drain();
		expect(() => tracker.interval(() => {}, 100)).toThrow(
			"Cannot track after drain",
		);
	});

	it("timeout() throws after drain()", async () => {
		const tracker = new AsyncTracker();
		await tracker.drain();
		expect(() => tracker.timeout(() => {}, 100)).toThrow(
			"Cannot track after drain",
		);
	});
});
