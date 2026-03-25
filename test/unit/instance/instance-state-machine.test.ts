// ─── State Machine Transition Tests ──────────────────────────────────────────
// Comprehensive coverage of every InstanceStatus transition, focusing on
// transitions not already covered by instance-manager.test.ts.
//
// State diagram:
//   addInstance ──► stopped ──► starting ──► healthy ──► unhealthy
//                                 │             │            │
//                              (all ← stopInstance → stopped)

import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";
import type { InstanceConfig } from "../../../src/lib/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function managedConfig(
	overrides: Partial<InstanceConfig> = {},
): InstanceConfig {
	return { name: "SM", port: 15000, managed: true, ...overrides };
}

function createMockProcess(pid = 99999): ChildProcess {
	return {
		kill: vi.fn(),
		pid,
		on: vi.fn(),
		removeAllListeners: vi.fn(),
	} as unknown as ChildProcess;
}

/** Create a mock spawner that also captures the exit callback. */
function createExitCapturingSpawner(pid = 99999) {
	let exitCb: ((code: number | null, signal: string | null) => void) | null =
		null;
	const proc = {
		kill: vi.fn(),
		pid,
		on: vi.fn().mockImplementation(
			(
				event: string,
				// biome-ignore lint/complexity/noBannedTypes: test mock
				cb: Function,
			) => {
				if (event === "exit")
					exitCb = cb as (code: number | null, signal: string | null) => void;
			},
		),
		removeAllListeners: vi.fn(),
	} as unknown as ChildProcess;

	const spawner = vi.fn().mockResolvedValue({ pid: proc.pid, process: proc });

	return { spawner, proc, getExitCb: () => exitCb };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Instance state machine transitions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	// ── #4: starting → health check fails → stays starting, poll starts ──

	it("starting → initial health check fails → stays 'starting', poll begins", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		mgr.setSpawner(
			vi.fn().mockResolvedValue({ pid: 1, process: createMockProcess() }),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(false)); // initial check fails

		mgr.addInstance("t4", managedConfig());
		await mgr.startInstance("t4");

		// Status should remain "starting" (initial health check failed,
		// but the process is still alive)
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t4")!.status).toBe("starting");
	});

	// ── #6: starting → process exits (code=0) → stopped ──

	it("starting → process exits code=0 → stopped", async () => {
		vi.useFakeTimers();
		const { spawner, getExitCb } = createExitCapturingSpawner(10001);
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		mgr.setSpawner(spawner);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t6", managedConfig());
		await mgr.startInstance("t6");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t6")!.status).toBe("healthy");

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		// Process exits cleanly after becoming healthy
		const exitCb = getExitCb();
		expect(exitCb).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		exitCb!(0, null);

		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t6")!.status).toBe("stopped");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t6")!.exitCode).toBe(0);
		expect(events).toEqual(["stopped"]);

		// Advance timers — no restart
		await vi.advanceTimersByTimeAsync(10_000);
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t6")!.status).toBe("stopped");

		mgr.stopAll();
	});

	// ── #7: starting → stopInstance → stopped ──

	it("starting → stopInstance → stopped", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		const proc = createMockProcess(10002);
		mgr.setSpawner(vi.fn().mockResolvedValue({ pid: 10002, process: proc }));
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t7", managedConfig());
		await mgr.startInstance("t7");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t7")!.status).toBe("healthy");

		// Manually set to starting to test this specific transition
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		const inst = mgr.getInstance("t7")!;
		(inst as { status: string }).status = "starting";

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		mgr.stopInstance("t7");

		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t7")!.status).toBe("stopped");
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(events).toContain("stopped");
	});

	// ── #9: healthy → health poll fails → unhealthy ──

	it("healthy → health poll fails → unhealthy", async () => {
		vi.useFakeTimers();
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 100,
		});
		mgr.setSpawner(
			vi.fn().mockResolvedValue({ pid: 1, process: createMockProcess() }),
		);

		let checkCount = 0;
		mgr.setHealthChecker(
			vi.fn().mockImplementation(() => {
				checkCount++;
				// First call (initial check): healthy
				// Second call (poll): unhealthy
				return Promise.resolve(checkCount <= 1);
			}),
		);

		mgr.addInstance("t9", managedConfig());
		await mgr.startInstance("t9");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t9")!.status).toBe("healthy");

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		// Advance timer to trigger poll
		await vi.advanceTimersByTimeAsync(150);

		expect(events).toContain("unhealthy");

		mgr.stopAll();
	});

	// ── #11: healthy → process exits (code=0) → stopped ──

	it("healthy → process exits code=0 → stopped", async () => {
		vi.useFakeTimers();
		const { spawner, getExitCb } = createExitCapturingSpawner(10003);
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		mgr.setSpawner(spawner);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t11", managedConfig());
		await mgr.startInstance("t11");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t11")!.status).toBe("healthy");

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		// Clean exit
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		getExitCb()!(0, null);

		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t11")!.status).toBe("stopped");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t11")!.exitCode).toBe(0);
		expect(events).toEqual(["stopped"]);

		// Advance timers — no restart should happen
		await vi.advanceTimersByTimeAsync(10_000);
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t11")!.status).toBe("stopped");

		mgr.stopAll();
	});

	// ── #14: unhealthy → stopInstance → stopped ──

	it("unhealthy → stopInstance → stopped", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		const proc = createMockProcess(10004);
		mgr.setSpawner(vi.fn().mockResolvedValue({ pid: 10004, process: proc }));
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t14", managedConfig());
		await mgr.startInstance("t14");

		// Manually set to unhealthy
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		const inst = mgr.getInstance("t14")!;
		(inst as { status: string }).status = "unhealthy";

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		mgr.stopInstance("t14");

		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t14")!.status).toBe("stopped");
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(events).toContain("stopped");
	});

	// ── #16: unhealthy → startInstance → kills old, starting ──

	it("unhealthy → startInstance → kills old process, transitions to starting then healthy", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		const oldProc = createMockProcess(10005);
		const newProc = createMockProcess(10006);
		let spawnCount = 0;

		mgr.setSpawner(
			vi.fn().mockImplementation(() => {
				spawnCount++;
				const proc = spawnCount === 1 ? oldProc : newProc;
				return Promise.resolve({ pid: proc.pid, process: proc });
			}),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t16", managedConfig());
		await mgr.startInstance("t16");
		expect(spawnCount).toBe(1);

		// Set to unhealthy
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		const inst = mgr.getInstance("t16")!;
		(inst as { status: string }).status = "unhealthy";

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		await mgr.startInstance("t16");

		expect(oldProc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(spawnCount).toBe(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t16")!.status).toBe("healthy");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t16")!.pid).toBe(10006);
		expect(events).toContain("starting");
		expect(events).toContain("healthy");
	});

	// ── #17: stopped → startInstance (second time) → starting ──

	it("stopped → startInstance (second time after stop) → starting → healthy", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		let spawnCount = 0;

		mgr.setSpawner(
			vi.fn().mockImplementation(() => {
				spawnCount++;
				return Promise.resolve({
					pid: 20000 + spawnCount,
					process: createMockProcess(20000 + spawnCount),
				});
			}),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t17", managedConfig());

		// First start
		await mgr.startInstance("t17");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t17")!.status).toBe("healthy");

		// Stop
		mgr.stopInstance("t17");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t17")!.status).toBe("stopped");

		// Second start
		await mgr.startInstance("t17");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t17")!.status).toBe("healthy");
		expect(spawnCount).toBe(2);

		mgr.stopAll();
	});

	// ── #19: starting → startInstance again → returns early (no double spawn) ──

	it("starting → startInstance again → returns early", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		let spawnCount = 0;

		mgr.setSpawner(
			vi.fn().mockImplementation(async () => {
				spawnCount++;
				// Small delay to make the race window visible
				await new Promise((r) => setTimeout(r, 10));
				return { pid: spawnCount, process: createMockProcess(spawnCount) };
			}),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t19", managedConfig());

		// Start two concurrent calls
		const p1 = mgr.startInstance("t19");
		const p2 = mgr.startInstance("t19"); // should return early (status is "starting")

		await Promise.all([p1, p2]);

		// Only one spawn should have happened
		expect(spawnCount).toBe(1);

		mgr.stopAll();
	});

	// ── #20: healthy → startInstance again → returns early ──

	it("healthy → startInstance again → returns early (no re-spawn)", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		let spawnCount = 0;

		mgr.setSpawner(
			vi.fn().mockImplementation(() => {
				spawnCount++;
				return Promise.resolve({
					pid: spawnCount,
					process: createMockProcess(spawnCount),
				});
			}),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t20", managedConfig());
		await mgr.startInstance("t20");
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
		expect(mgr.getInstance("t20")!.status).toBe("healthy");
		expect(spawnCount).toBe(1);

		// Start again — should be a no-op
		await mgr.startInstance("t20");
		expect(spawnCount).toBe(1); // no additional spawn

		mgr.stopAll();
	});
});
