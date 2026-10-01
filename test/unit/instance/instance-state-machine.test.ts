// Comprehensive coverage of every InstanceStatus transition, focusing on
// transitions not already covered by instance-manager.test.ts.
//
// State diagram:
//   addInstance ──► stopped ──► starting ──► healthy ──► unhealthy
//                                 │             │            │
//                              (all ← stopInstance → stopped)

import type { ChildProcess } from "node:child_process";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";
import type { InstanceConfig } from "../../../src/lib/types.js";
import { partialFake } from "../../helpers/partial-fake.js";

function managedConfig(
	overrides: Partial<InstanceConfig> = {},
): InstanceConfig {
	return { name: "SM", port: 15000, managed: true, ...overrides };
}

function createMockProcess(pid = 99999): ChildProcess {
	return partialFake<ChildProcess>({
		kill: vi.fn(),
		pid,
		on: vi.fn(),
		removeAllListeners: vi.fn(),
	});
}

/** Create a mock spawner that also captures the exit callback. */
function createExitCapturingSpawner(pid = 99999) {
	let exitCb: ((code: number | null, signal: string | null) => void) | null =
		null;
	const proc = partialFake<ChildProcess>({
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
	});

	const spawner = vi.fn().mockResolvedValue({ pid: proc.pid, process: proc });

	return { spawner, proc, getExitCb: () => exitCb };
}

describe("Instance state machine transitions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("starting → initial health check fails → stays 'starting', poll begins", async () => {
		const mgr = new InstanceManager({
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
		const t4 = mgr.getInstance("t4");
		assert.exists(t4, "expected the t4 instance");
		expect(t4.status).toBe("starting");
	});

	// #6: starting → process exits (code=0) → stopped

	it("starting → process exits code=0 → stopped", async () => {
		vi.useFakeTimers();
		const { spawner, getExitCb } = createExitCapturingSpawner(10001);
		const mgr = new InstanceManager({
			healthPollIntervalMs: 999_999,
		});
		mgr.setSpawner(spawner);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t6", managedConfig());
		await mgr.startInstance("t6");
		const t6 = mgr.getInstance("t6");
		assert.exists(t6, "expected the t6 instance");
		expect(t6.status).toBe("healthy");

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		// Process exits cleanly after becoming healthy
		const exitCb = getExitCb();
		expect(exitCb).not.toBeNull();
		assert.exists(exitCb, "expected the process exit callback");
		exitCb(0, null);

		const stoppedT6 = mgr.getInstance("t6");
		assert.exists(stoppedT6, "expected the t6 instance");
		expect(stoppedT6.status).toBe("stopped");
		expect(stoppedT6.exitCode).toBe(0);
		expect(events).toEqual(["stopped"]);

		// Advance timers — no restart
		await vi.advanceTimersByTimeAsync(10_000);
		const timedOutT6 = mgr.getInstance("t6");
		assert.exists(timedOutT6, "expected the t6 instance");
		expect(timedOutT6.status).toBe("stopped");

		mgr.stopAll();
	});

	it("starting → stopInstance → stopped", async () => {
		const mgr = new InstanceManager({
			healthPollIntervalMs: 999_999,
		});
		const proc = createMockProcess(10002);
		mgr.setSpawner(vi.fn().mockResolvedValue({ pid: 10002, process: proc }));
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t7", managedConfig());
		await mgr.startInstance("t7");
		const t7 = mgr.getInstance("t7");
		assert.exists(t7, "expected the t7 instance");
		expect(t7.status).toBe("healthy");

		// Manually set to starting to test this specific transition
		const inst = mgr.getInstance("t7");
		assert.exists(inst, "expected the t7 instance");
		(inst as { status: string }).status = "starting";

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		mgr.stopInstance("t7");

		const stoppedT7 = mgr.getInstance("t7");
		assert.exists(stoppedT7, "expected the t7 instance");
		expect(stoppedT7.status).toBe("stopped");
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(events).toContain("stopped");
	});

	it("healthy → health poll fails → unhealthy", async () => {
		vi.useFakeTimers();
		const mgr = new InstanceManager({
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
		const t9 = mgr.getInstance("t9");
		assert.exists(t9, "expected the t9 instance");
		expect(t9.status).toBe("healthy");

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		// Advance timer to trigger poll
		await vi.advanceTimersByTimeAsync(150);

		expect(events).toContain("unhealthy");

		mgr.stopAll();
	});

	// #11: healthy → process exits (code=0) → stopped

	it("healthy → process exits code=0 → stopped", async () => {
		vi.useFakeTimers();
		const { spawner, getExitCb } = createExitCapturingSpawner(10003);
		const mgr = new InstanceManager({
			healthPollIntervalMs: 999_999,
		});
		mgr.setSpawner(spawner);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t11", managedConfig());
		await mgr.startInstance("t11");
		const t11 = mgr.getInstance("t11");
		assert.exists(t11, "expected the t11 instance");
		expect(t11.status).toBe("healthy");

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		// Clean exit
		const exitCallback = getExitCb();
		assert.exists(exitCallback, "expected the process exit callback");
		exitCallback(0, null);

		const stoppedT11 = mgr.getInstance("t11");
		assert.exists(stoppedT11, "expected the t11 instance");
		expect(stoppedT11.status).toBe("stopped");
		expect(stoppedT11.exitCode).toBe(0);
		expect(events).toEqual(["stopped"]);

		// Advance timers — no restart should happen
		await vi.advanceTimersByTimeAsync(10_000);
		const timedOutT11 = mgr.getInstance("t11");
		assert.exists(timedOutT11, "expected the t11 instance");
		expect(timedOutT11.status).toBe("stopped");

		mgr.stopAll();
	});

	it("unhealthy → stopInstance → stopped", async () => {
		const mgr = new InstanceManager({
			healthPollIntervalMs: 999_999,
		});
		const proc = createMockProcess(10004);
		mgr.setSpawner(vi.fn().mockResolvedValue({ pid: 10004, process: proc }));
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		mgr.addInstance("t14", managedConfig());
		await mgr.startInstance("t14");

		// Manually set to unhealthy
		const inst = mgr.getInstance("t14");
		assert.exists(inst, "expected the t14 instance");
		(inst as { status: string }).status = "unhealthy";

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		mgr.stopInstance("t14");

		const stoppedT14 = mgr.getInstance("t14");
		assert.exists(stoppedT14, "expected the t14 instance");
		expect(stoppedT14.status).toBe("stopped");
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(events).toContain("stopped");
	});

	it("unhealthy → startInstance → kills old process, transitions to starting then healthy", async () => {
		const mgr = new InstanceManager({
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
		const inst = mgr.getInstance("t16");
		assert.exists(inst, "expected the t16 instance");
		(inst as { status: string }).status = "unhealthy";

		const events: string[] = [];
		mgr.on("status_changed", (i) => events.push(i.status));

		await mgr.startInstance("t16");

		expect(oldProc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(spawnCount).toBe(2);
		const restartedT16 = mgr.getInstance("t16");
		assert.exists(restartedT16, "expected the t16 instance");
		expect(restartedT16.status).toBe("healthy");
		expect(restartedT16.pid).toBe(10006);
		expect(events).toContain("starting");
		expect(events).toContain("healthy");
	});

	// #17: stopped → startInstance (second time) → starting

	it("stopped → startInstance (second time after stop) → starting → healthy", async () => {
		const mgr = new InstanceManager({
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
		const t17 = mgr.getInstance("t17");
		assert.exists(t17, "expected the t17 instance");
		expect(t17.status).toBe("healthy");

		// Stop
		mgr.stopInstance("t17");
		const stoppedT17 = mgr.getInstance("t17");
		assert.exists(stoppedT17, "expected the t17 instance");
		expect(stoppedT17.status).toBe("stopped");

		// Second start
		await mgr.startInstance("t17");
		const restartedT17 = mgr.getInstance("t17");
		assert.exists(restartedT17, "expected the t17 instance");
		expect(restartedT17.status).toBe("healthy");
		expect(spawnCount).toBe(2);

		mgr.stopAll();
	});

	// #19: starting → startInstance again → returns early (no double spawn)

	it("starting → startInstance again → returns early", async () => {
		const mgr = new InstanceManager({
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

	it("healthy → startInstance again → returns early (no re-spawn)", async () => {
		const mgr = new InstanceManager({
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
		const t20 = mgr.getInstance("t20");
		assert.exists(t20, "expected the t20 instance");
		expect(t20.status).toBe("healthy");
		expect(spawnCount).toBe(1);

		// Start again — should be a no-op
		await mgr.startInstance("t20");
		expect(spawnCount).toBe(1); // no additional spawn

		mgr.stopAll();
	});
});
