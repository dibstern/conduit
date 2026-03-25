// ─── Unit Tests: StorageMonitor (Ticket 6.2 AC8) ────────────────────────────
//
// Tests:
// T1:  Emits `low_disk_space` when available space drops below threshold
// T2:  Does NOT emit when space is above threshold
// T3:  Emits `disk_space_ok` when space recovers
// T4:  Does NOT emit `disk_space_ok` on first check if space is above threshold
// T5:  Does NOT re-emit `low_disk_space` on consecutive low checks (transition only)
// T6:  `stop()` is idempotent (calling stop twice doesn't throw)
// T7:  Custom threshold works

import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import type {
	DiskSpaceOkEvent,
	LowDiskSpaceEvent,
} from "../../../src/lib/daemon/storage-monitor.js";
import { StorageMonitor } from "../../../src/lib/daemon/storage-monitor.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create an injectable _statfs that returns the given available bytes */
function mockStatfs(availableBytes: number) {
	return vi.fn(async (_path: string) => ({ available: availableBytes }));
}

/** Create a _statfs that resolves on demand via returned triggers */
function mockStatfsControlled(sequence: number[]) {
	let callIndex = 0;
	const calls: Array<(v: { available: number }) => void> = [];
	const fn = vi.fn(
		(_path: string) =>
			new Promise<{ available: number }>((resolve) => {
				calls.push(resolve);
			}),
	);

	/** Resolve the next pending call with the next value in the sequence */
	function next() {
		const resolve = calls.shift();
		if (!resolve) throw new Error("No pending statfs call to resolve");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const available = sequence[callIndex] ?? sequence[sequence.length - 1]!;
		callIndex++;
		resolve({ available });
	}

	return { fn, next };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ticket 6.2 AC8 — StorageMonitor", () => {
	// ─── T1: Emits low_disk_space when below threshold ──────────────────

	describe("T1: Emits low_disk_space when available space drops below threshold", () => {
		it("emits low_disk_space on first check when below threshold", async () => {
			const threshold = 100 * 1024 * 1024; // 100MB
			const belowThreshold = threshold - 1;
			const statfs = mockStatfs(belowThreshold);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const events: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				events.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			await vi.waitFor(() => expect(events).toHaveLength(1));
			monitor.stop();

			expect(events[0]).toEqual({
				availableBytes: belowThreshold,
				thresholdBytes: threshold,
			});
		});

		it("emits low_disk_space when space is exactly 0", async () => {
			const statfs = mockStatfs(0);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				_statfs: statfs,
			});

			const events: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				events.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			await vi.waitFor(() => expect(events).toHaveLength(1));
			monitor.stop();

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(events[0]!.availableBytes).toBe(0);
		});
	});

	// ─── T2: Does NOT emit when space is above threshold ────────────────

	describe("T2: Does NOT emit when space is above threshold", () => {
		it("no events emitted when space is plentiful", async () => {
			const threshold = 100 * 1024 * 1024;
			const aboveThreshold = threshold + 1;
			const statfs = mockStatfs(aboveThreshold);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			const okEvents: DiskSpaceOkEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);
			monitor.on("disk_space_ok", (data: DiskSpaceOkEvent) =>
				okEvents.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			monitor.stop();

			expect(lowEvents).toHaveLength(0);
			expect(okEvents).toHaveLength(0);
		});

		it("no events when exactly at threshold", async () => {
			const threshold = 100 * 1024 * 1024;
			const statfs = mockStatfs(threshold);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			monitor.stop();

			// At threshold exactly means NOT below — should not emit
			expect(lowEvents).toHaveLength(0);
		});
	});

	// ─── T3: Emits disk_space_ok when space recovers ────────────────────

	describe("T3: Emits disk_space_ok when space recovers", () => {
		it("emits disk_space_ok after low_disk_space then recovery", async () => {
			const threshold = 100 * 1024 * 1024;
			const low = threshold - 1;
			const high = threshold + 1_000_000;
			const { fn: statfs, next } = mockStatfsControlled([low, high]);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 10,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			const okEvents: DiskSpaceOkEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);
			monitor.on("disk_space_ok", (data: DiskSpaceOkEvent) =>
				okEvents.push(data),
			);

			monitor.start();

			// First check: low
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(1));
			next();
			await vi.waitFor(() => expect(lowEvents).toHaveLength(1));

			// Second check: high (recovery)
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(2));
			next();
			await vi.waitFor(() => expect(okEvents).toHaveLength(1));

			monitor.stop();

			expect(lowEvents).toHaveLength(1);
			expect(okEvents).toHaveLength(1);
			expect(okEvents[0]).toEqual({ availableBytes: high });
		});
	});

	// ─── T4: Does NOT emit disk_space_ok on first check if above threshold ─

	describe("T4: Does NOT emit disk_space_ok on first check if space is above threshold", () => {
		it("no disk_space_ok when first check is above threshold", async () => {
			const threshold = 100 * 1024 * 1024;
			const statfs = mockStatfs(threshold + 1_000_000);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const okEvents: DiskSpaceOkEvent[] = [];
			monitor.on("disk_space_ok", (data: DiskSpaceOkEvent) =>
				okEvents.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			monitor.stop();

			expect(okEvents).toHaveLength(0);
		});
	});

	// ─── T5: Does NOT re-emit low_disk_space on consecutive low checks ──

	describe("T5: Does NOT re-emit low_disk_space on consecutive low checks (transition only)", () => {
		it("emits low_disk_space only once across multiple consecutive low checks", async () => {
			const threshold = 100 * 1024 * 1024;
			const low1 = threshold - 1;
			const low2 = threshold - 2;
			const low3 = threshold - 3;
			const { fn: statfs, next } = mockStatfsControlled([low1, low2, low3]);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 10,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);

			monitor.start();

			// Resolve three consecutive low checks
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(1));
			next();
			await vi.waitFor(() => expect(lowEvents).toHaveLength(1));

			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(2));
			next();

			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(3));
			next();

			monitor.stop();

			// Should only emit once on the first transition to low
			expect(lowEvents).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(lowEvents[0]!.availableBytes).toBe(low1);
		});

		it("emits low_disk_space again after recovery and re-drop", async () => {
			const threshold = 100 * 1024 * 1024;
			const low = threshold - 1;
			const high = threshold + 1_000_000;
			// low -> high (recovery) -> low (re-drop)
			const { fn: statfs, next } = mockStatfsControlled([low, high, low]);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 10,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			const okEvents: DiskSpaceOkEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);
			monitor.on("disk_space_ok", (data: DiskSpaceOkEvent) =>
				okEvents.push(data),
			);

			monitor.start();

			// Check 1: low
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(1));
			next();
			await vi.waitFor(() => expect(lowEvents).toHaveLength(1));

			// Check 2: high (recovery)
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(2));
			next();
			await vi.waitFor(() => expect(okEvents).toHaveLength(1));

			// Check 3: low (re-drop)
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(3));
			next();
			await vi.waitFor(() => expect(lowEvents).toHaveLength(2));

			monitor.stop();

			// Two transitions to low, one recovery
			expect(lowEvents).toHaveLength(2);
			expect(okEvents).toHaveLength(1);
		});
	});

	// ─── T6: stop() is idempotent ───────────────────────────────────────

	describe("T6: stop() is idempotent (calling stop twice doesn't throw)", () => {
		it("does not throw on double stop", () => {
			const statfs = mockStatfs(1_000_000_000);
			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				_statfs: statfs,
			});

			monitor.start();
			monitor.stop();
			expect(() => monitor.stop()).not.toThrow();
		});

		it("does not throw when stop called before start", () => {
			const statfs = mockStatfs(1_000_000_000);
			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				_statfs: statfs,
			});

			expect(() => monitor.stop()).not.toThrow();
		});
	});

	// ─── T7: Custom threshold works ─────────────────────────────────────

	describe("T7: Custom threshold works", () => {
		it("uses custom threshold for low_disk_space detection", async () => {
			const customThreshold = 500 * 1024 * 1024; // 500MB
			const belowCustom = customThreshold - 1;
			const statfs = mockStatfs(belowCustom);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: customThreshold,
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			await vi.waitFor(() => expect(lowEvents).toHaveLength(1));
			monitor.stop();

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(lowEvents[0]!.thresholdBytes).toBe(customThreshold);
		});

		it("emits low_disk_space when below custom threshold", async () => {
			const customThreshold = 500 * 1024 * 1024; // 500MB
			// 200MB — below 500MB custom threshold
			const available = 200 * 1024 * 1024;
			const statfs = mockStatfs(available);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				thresholdBytes: customThreshold,
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			await vi.waitFor(() => expect(lowEvents).toHaveLength(1));
			monitor.stop();
		});

		it("default threshold is 100MB", async () => {
			const justBelow100mb = 100 * 1024 * 1024 - 1;
			const statfs = mockStatfs(justBelow100mb);

			const monitor = new StorageMonitor(new ServiceRegistry(), {
				path: "/tmp",
				intervalMs: 60_000,
				_statfs: statfs,
			});

			const lowEvents: LowDiskSpaceEvent[] = [];
			monitor.on("low_disk_space", (data: LowDiskSpaceEvent) =>
				lowEvents.push(data),
			);

			monitor.start();
			await vi.waitFor(() => expect(statfs).toHaveBeenCalled());
			await vi.waitFor(() => expect(lowEvents).toHaveLength(1));
			monitor.stop();

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(lowEvents[0]!.thresholdBytes).toBe(100 * 1024 * 1024);
		});
	});

	// ─── T8: After drain(), interval no longer fires ────────────────────

	describe("T8: After drain(), interval no longer fires", () => {
		it("does not call check after drain()", async () => {
			const threshold = 100 * 1024 * 1024;
			const registry = new ServiceRegistry();
			const statfs = vi.fn(async (_path: string) => ({
				available: threshold + 1_000_000,
			}));

			const monitor = new StorageMonitor(registry, {
				path: "/tmp",
				thresholdBytes: threshold,
				intervalMs: 10, // Short interval so it would fire quickly
				_statfs: statfs,
			});

			monitor.start();
			// Wait for the initial check to complete
			await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(1));

			// Drain the registry — should cancel the interval
			await registry.drainAll();

			// Record call count after drain
			const callsAfterDrain = statfs.mock.calls.length;

			// Wait enough time for at least one more interval tick
			await new Promise((resolve) => setTimeout(resolve, 50));

			// No new calls should have been made after drain
			expect(statfs.mock.calls.length).toBe(callsAfterDrain);
		});
	});
});
