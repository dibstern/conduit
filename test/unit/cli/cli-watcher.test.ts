// ─── Daemon Health Watcher — Unit Tests (Ticket 8.13) ────────────────────────
// Tests for DaemonWatcher: polling, crash detection, restart logic, backoff.
// Uses vi.useFakeTimers() to control intervals and injectable mock connect/readCrashInfo.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DaemonWatcher,
	type WatcherCallbacks,
	type WatcherOptions,
} from "../../../src/lib/cli/cli-watcher.js";
import type { CrashInfo } from "../../../src/lib/daemon/config-persistence.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock socket that emits connect on next tick. */
function createSuccessSocket() {
	const emitter = new EventEmitter();
	const socket = {
		on: (event: string, cb: (...args: unknown[]) => void) => {
			emitter.on(event, cb);
		},
		destroy: vi.fn(),
		emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
	};
	// Schedule connect event
	setTimeout(() => socket.emit("connect"), 0);
	return socket;
}

/** Create a mock socket that emits error on next tick. */
function createErrorSocket() {
	const emitter = new EventEmitter();
	const socket = {
		on: (event: string, cb: (...args: unknown[]) => void) => {
			emitter.on(event, cb);
		},
		destroy: vi.fn(),
		emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
	};
	// Schedule error event
	setTimeout(() => socket.emit("error", new Error("ECONNREFUSED")), 0);
	return socket;
}

/** Create a mock socket that never connects (simulates timeout). */
function createHangingSocket() {
	const emitter = new EventEmitter();
	return {
		on: (event: string, cb: (...args: unknown[]) => void) => {
			emitter.on(event, cb);
		},
		destroy: vi.fn(),
		emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
	};
}

/** Default crash info for tests. */
function defaultCrashInfo(overrides?: Partial<CrashInfo>): CrashInfo {
	return {
		reason: "Segmentation fault",
		timestamp: Date.now(),
		...overrides,
	};
}

/** Create default mock callbacks. */
function createMockCallbacks(): WatcherCallbacks {
	return {
		onDied: vi.fn(),
		onRestart: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		onGiveUp: vi.fn(),
		onShutdown: vi.fn(),
	};
}

/** Create a watcher with mock defaults. */
function createWatcher(overrides?: {
	callbacks?: Partial<WatcherCallbacks>;
	options?: Partial<WatcherOptions>;
}) {
	const callbacks = {
		...createMockCallbacks(),
		...overrides?.callbacks,
	};
	const options: WatcherOptions = {
		socketPath: "/tmp/test-relay.sock",
		pollInterval: 3000,
		connectTimeout: 1500,
		maxAttempts: 5,
		backoffWindow: 60000,
		readCrashInfo: () => null,
		connect: () => createSuccessSocket(),
		...overrides?.options,
	};
	return { watcher: new DaemonWatcher(callbacks, options), callbacks, options };
}

/**
 * Trigger one poll cycle and let async handlers settle.
 * Advances past the poll interval, then the setTimeout(0) for the socket event,
 * then flushes microtasks (Promises).
 */
async function triggerErrorPoll(pollInterval = 3000): Promise<void> {
	// Advance past poll interval to trigger poll()
	vi.advanceTimersByTime(pollInterval);
	// Advance past setTimeout(0) that fires the socket error event
	vi.advanceTimersByTime(1);
	// Flush microtasks (Promise resolution from async onDaemonDied)
	await flushMicrotasks();
}

/**
 * Trigger one poll cycle for a hanging socket (timeout-based).
 */
async function triggerTimeoutPoll(
	pollInterval = 3000,
	connectTimeout = 1500,
): Promise<void> {
	vi.advanceTimersByTime(pollInterval);
	vi.advanceTimersByTime(connectTimeout);
	await flushMicrotasks();
}

/** Flush pending microtasks (Promises) without advancing timers further. */
async function flushMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => {
		queueMicrotask(resolve);
	});
	// Double-flush to ensure chained promises resolve
	await new Promise<void>((resolve) => {
		queueMicrotask(resolve);
	});
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("DaemonWatcher.start()", () => {
	it("begins polling", () => {
		const { watcher } = createWatcher();
		expect(watcher.isRunning()).toBe(false);
		watcher.start();
		expect(watcher.isRunning()).toBe(true);
		watcher.stop();
	});
});

describe("DaemonWatcher.stop()", () => {
	it("stops polling", () => {
		const { watcher } = createWatcher();
		watcher.start();
		expect(watcher.isRunning()).toBe(true);
		watcher.stop();
		expect(watcher.isRunning()).toBe(false);
	});
});

describe("DaemonWatcher.isRunning()", () => {
	it("returns correct state after start and stop", () => {
		const { watcher } = createWatcher();
		expect(watcher.isRunning()).toBe(false);
		watcher.start();
		expect(watcher.isRunning()).toBe(true);
		watcher.stop();
		expect(watcher.isRunning()).toBe(false);
	});
});

describe("successful connect", () => {
	it("does not fire any callbacks on successful connect", async () => {
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createSuccessSocket(),
			},
		});

		watcher.start();

		// Advance past poll interval
		vi.advanceTimersByTime(3000);
		// Advance past the setTimeout(0) for connect event
		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(callbacks.onDied).not.toHaveBeenCalled();
		expect(callbacks.onShutdown).not.toHaveBeenCalled();
		expect(callbacks.onGiveUp).not.toHaveBeenCalled();
		expect(callbacks.onRestart).not.toHaveBeenCalled();

		watcher.stop();
	});
});

describe("connection error", () => {
	it("triggers onDied when socket emits error and crash info exists", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
			},
		});

		watcher.start();
		await triggerErrorPoll();

		expect(callbacks.onDied).toHaveBeenCalledWith({
			isCrash: true,
			crashInfo,
			attempt: 1,
			maxAttempts: 5,
		});

		watcher.stop();
	});
});

describe("connection timeout", () => {
	it("triggers onDied when socket times out and crash info exists", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createHangingSocket(),
				readCrashInfo: () => crashInfo,
				connectTimeout: 1500,
			},
		});

		watcher.start();
		await triggerTimeoutPoll(3000, 1500);

		expect(callbacks.onDied).toHaveBeenCalledWith({
			isCrash: true,
			crashInfo,
			attempt: 1,
			maxAttempts: 5,
		});

		watcher.stop();
	});
});

describe("no crash info", () => {
	it("calls onShutdown when readCrashInfo returns null (intentional shutdown)", async () => {
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => null,
			},
		});

		watcher.start();
		await triggerErrorPoll();

		expect(callbacks.onShutdown).toHaveBeenCalled();
		expect(callbacks.onDied).not.toHaveBeenCalled();
		expect(callbacks.onRestart).not.toHaveBeenCalled();

		watcher.stop();
	});
});

describe("crash info present", () => {
	it("calls onDied with isCrash: true when crash info exists", async () => {
		const crashInfo = defaultCrashInfo({ reason: "Out of memory" });
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
			},
		});

		watcher.start();
		await triggerErrorPoll();

		expect(callbacks.onDied).toHaveBeenCalledWith(
			expect.objectContaining({ isCrash: true, crashInfo }),
		);

		watcher.stop();
	});

	it("calls onRestart after onDied", async () => {
		const crashInfo = defaultCrashInfo();
		const callOrder: string[] = [];
		const { watcher } = createWatcher({
			callbacks: {
				onDied: vi.fn(() => callOrder.push("onDied")),
				onRestart: vi.fn(async () => {
					callOrder.push("onRestart");
				}),
			},
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
			},
		});

		watcher.start();
		await triggerErrorPoll();

		expect(callOrder).toEqual(["onDied", "onRestart"]);

		watcher.stop();
	});
});

describe("watcher re-starts after restart", () => {
	it("re-starts polling after successful restart", async () => {
		const crashInfo = defaultCrashInfo();
		let connectCount = 0;
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => {
					connectCount++;
					// First poll fails, subsequent succeed
					if (connectCount === 1) return createErrorSocket();
					return createSuccessSocket();
				},
				readCrashInfo: () => crashInfo,
			},
		});

		watcher.start();
		expect(watcher.isRunning()).toBe(true);

		// First poll — error, triggers crash handling + restart
		await triggerErrorPoll();

		// After restart, watcher should be running again
		expect(watcher.isRunning()).toBe(true);
		expect(callbacks.onRestart).toHaveBeenCalledOnce();

		watcher.stop();
	});
});

describe("attempt counter", () => {
	it("increments on each crash", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
				maxAttempts: 10,
			},
		});

		watcher.start();

		// First crash
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(1);

		// Second crash (watcher re-started after first restart)
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(2);

		watcher.stop();
	});
});

describe("max attempts", () => {
	it("calls onGiveUp when max attempts exceeded", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
				maxAttempts: 2,
			},
		});

		watcher.start();

		// Crash 1
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(1);

		// Crash 2
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(2);

		// Crash 3 — exceeds max
		await triggerErrorPoll();

		expect(callbacks.onGiveUp).toHaveBeenCalledWith(crashInfo);
		expect(watcher.getAttemptCount()).toBe(3);

		watcher.stop();
	});
});

describe("backoff window", () => {
	it("resets counter after backoff window elapses", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
				maxAttempts: 5,
				backoffWindow: 10000,
			},
		});

		watcher.start();

		// Crash 1
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(1);

		// Crash 2
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(2);

		// Advance time beyond backoff window (10s) without triggering a poll
		// (watcher has re-started with 3s interval, so we need to be careful)
		// After crash 2, watcher re-starts. We advance past the backoff window.
		vi.advanceTimersByTime(11000);
		// The above also triggers polls at 3s, 6s, 9s — which all fire errors.
		// But the setTimeout(0) events haven't fired yet. Let them fire:
		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		// The counter should have been reset then incremented for the new crash
		// The 3s poll at 3s triggers error -> crash 3. But backoffStart was set
		// at crash 1. 3s after crash 2 = 6s total. 6s < 10s backoff window.
		// So it won't reset at crash 3.
		// Actually, let's simplify this test. After crash 2, watcher restarts.
		// The next poll is 3s later. Let's just check the state.

		// Due to the complexity of time advancement, let's just verify the
		// backoff mechanism works conceptually:
		watcher.stop();

		// Reset and test cleanly: create fresh watcher, manually set backoff start
		const { watcher: w2, callbacks: cb2 } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
				maxAttempts: 3,
				backoffWindow: 5000,
			},
		});

		w2.start();

		// Crash 1 at t=3001
		await triggerErrorPoll();
		expect(w2.getAttemptCount()).toBe(1);

		// Crash 2 at t=6002
		await triggerErrorPoll();
		expect(w2.getAttemptCount()).toBe(2);

		// Now advance past the backoff window (5s from crash 1)
		// Need to advance enough that Date.now() - backoffStart > 5000
		// Crash 1 was at ~3001ms, current time is ~6003ms, so we need
		// backoffStart + 5000 = ~8001ms. Advance to ~9000ms.
		vi.advanceTimersByTime(3000); // triggers poll
		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		// Attempt count should have been reset to 0 then incremented to 1
		expect(w2.getAttemptCount()).toBe(1);
		expect(cb2.onGiveUp).not.toHaveBeenCalled();

		w2.stop();
	});
});

describe("resetAttempts()", () => {
	it("clears the attempt counter", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
			},
		});

		watcher.start();

		// Crash 1
		await triggerErrorPoll();
		expect(watcher.getAttemptCount()).toBe(1);

		watcher.resetAttempts();
		expect(watcher.getAttemptCount()).toBe(0);

		watcher.stop();
	});
});

describe("getAttemptCount()", () => {
	it("returns current attempt count", () => {
		const { watcher } = createWatcher();
		expect(watcher.getAttemptCount()).toBe(0);
		watcher.stop();
	});
});

describe("multiple consecutive crashes", () => {
	it("tracks all crashes correctly with attempt numbers", async () => {
		const crashInfo = defaultCrashInfo();
		const diedCalls: Array<{ attempt: number; maxAttempts: number }> = [];
		const { watcher, callbacks } = createWatcher({
			callbacks: {
				onDied: vi.fn((info) => diedCalls.push(info)),
				onRestart: vi.fn(async () => {}),
			},
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => crashInfo,
				maxAttempts: 4,
			},
		});

		watcher.start();

		// 4 crashes (within maxAttempts)
		for (let i = 1; i <= 4; i++) {
			await triggerErrorPoll();
		}

		expect(diedCalls).toHaveLength(4);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(diedCalls[0]!.attempt).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(diedCalls[1]!.attempt).toBe(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(diedCalls[2]!.attempt).toBe(3);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(diedCalls[3]!.attempt).toBe(4);

		// 5th crash exceeds max → onGiveUp
		await triggerErrorPoll();

		expect(callbacks.onGiveUp).toHaveBeenCalledWith(crashInfo);

		watcher.stop();
	});
});

describe("stop during crash handling", () => {
	it("does not call callbacks if stopped before poll fires", async () => {
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createErrorSocket(),
				readCrashInfo: () => defaultCrashInfo(),
			},
		});

		watcher.start();

		// Stop before the first poll fires
		watcher.stop();

		// Advance past what would have been the first poll
		vi.advanceTimersByTime(5000);
		await flushMicrotasks();

		expect(callbacks.onDied).not.toHaveBeenCalled();
		expect(callbacks.onShutdown).not.toHaveBeenCalled();
		expect(callbacks.onGiveUp).not.toHaveBeenCalled();
		expect(callbacks.onRestart).not.toHaveBeenCalled();
	});
});

describe("connect timeout configurable", () => {
	it("uses custom connect timeout", async () => {
		const crashInfo = defaultCrashInfo();
		const { watcher, callbacks } = createWatcher({
			options: {
				connect: () => createHangingSocket(),
				readCrashInfo: () => crashInfo,
				connectTimeout: 500,
			},
		});

		watcher.start();

		// Advance past poll interval
		vi.advanceTimersByTime(3000);

		// Should not have fired yet (only 400ms of timeout)
		vi.advanceTimersByTime(400);
		await flushMicrotasks();
		expect(callbacks.onDied).not.toHaveBeenCalled();

		// Advance past the 500ms custom timeout
		vi.advanceTimersByTime(100);
		await flushMicrotasks();

		expect(callbacks.onDied).toHaveBeenCalledWith(
			expect.objectContaining({ isCrash: true }),
		);

		watcher.stop();
	});
});
