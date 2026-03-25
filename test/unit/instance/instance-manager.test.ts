// ─── Tests: InstanceManager ──────────────────────────────────────────────────
//
// Tests cover:
// T1: addInstance — creates instance, rejects duplicates, rejects max exceeded
// T2: getInstances / getInstance — returns all, returns by ID, returns undefined
// T3: removeInstance — removes existing, throws for unknown
// T4: getInstanceUrl — managed URL, external URL, throws for unknown
// T5: events — instance_added, instance_removed, status_changed
// T6: stopInstance — sets status to stopped, emits status_changed
// T7: stopAll — stops all running/healthy instances
// T8: startInstance — process spawning, status transitions, health checks
// T9: constructor — default and custom maxInstances
// T10: crash recovery — auto-restart, backoff, max restarts, exit codes

import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";
import type {
	InstanceConfig,
	OpenCodeInstance,
} from "../../../src/lib/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function managedConfig(
	overrides: Partial<InstanceConfig> = {},
): InstanceConfig {
	return {
		name: "Test Instance",
		port: 4096,
		managed: true,
		...overrides,
	};
}

function externalConfig(
	overrides: Partial<InstanceConfig> = {},
): InstanceConfig {
	const { url, env, ...rest } = overrides;
	return {
		name: "External Instance",
		port: 8080,
		managed: false,
		url: "https://opencode.example.com",
		...(url != null && { url }),
		...(env != null && { env }),
		...rest,
	};
}

function createMockProcess(pid = 99999): ChildProcess {
	return {
		kill: vi.fn(),
		pid,
		on: vi.fn(),
		removeAllListeners: vi.fn(),
	} as unknown as ChildProcess;
}

function createMockSpawner(mockProcess?: ChildProcess) {
	const proc = mockProcess ?? createMockProcess();
	return vi.fn().mockResolvedValue({ pid: proc.pid, process: proc });
}

function createMockHealthChecker(healthy = true) {
	return vi.fn().mockResolvedValue(healthy);
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe("InstanceManager", () => {
	describe("constructor", () => {
		it("uses default maxInstances of 5", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			// Add 5 instances — should work
			for (let i = 0; i < 5; i++) {
				mgr.addInstance(`inst-${i}`, managedConfig({ port: 4096 + i }));
			}
			// 6th should throw
			expect(() =>
				mgr.addInstance("inst-5", managedConfig({ port: 5000 })),
			).toThrow(/max/i);
		});

		it("accepts custom maxInstances", () => {
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxInstances: 2,
			});
			mgr.addInstance("a", managedConfig({ port: 4096 }));
			mgr.addInstance("b", managedConfig({ port: 4097 }));
			expect(() => mgr.addInstance("c", managedConfig({ port: 4098 }))).toThrow(
				/max/i,
			);
		});
	});

	// ─── addInstance ────────────────────────────────────────────────────────

	describe("addInstance", () => {
		it("creates an instance with status 'stopped'", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			const inst = mgr.getInstance("dev");
			expect(inst).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.id).toBe("dev");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.name).toBe("Test Instance");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.port).toBe(4096);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.managed).toBe(true);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.restartCount).toBe(0);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.createdAt).toBeGreaterThan(0);
		});

		it("rejects duplicate IDs", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			expect(() => mgr.addInstance("dev", managedConfig())).toThrow(
				/already exists/i,
			);
		});

		it("rejects when max instances reached", () => {
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxInstances: 1,
			});
			mgr.addInstance("a", managedConfig());
			expect(() => mgr.addInstance("b", managedConfig({ port: 4097 }))).toThrow(
				/max/i,
			);
		});

		it("throws for invalid url", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(() =>
				mgr.addInstance("bad-url", externalConfig({ url: "not-a-valid-url" })),
			).toThrow(/invalid url/i);
		});

		it("stores env from config", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig({ env: { API_KEY: "sk-test" } }));
			const inst = mgr.getInstance("dev");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.env).toEqual({ API_KEY: "sk-test" });
		});

		it("returns the created instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const inst = mgr.addInstance("dev", managedConfig());
			expect(inst.id).toBe("dev");
			expect(inst.status).toBe("stopped");
		});
	});

	// ─── getInstances / getInstance ─────────────────────────────────────────

	describe("getInstances", () => {
		it("returns empty array when no instances", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(mgr.getInstances()).toEqual([]);
		});

		it("returns all instances", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("a", managedConfig({ port: 4096 }));
			mgr.addInstance("b", managedConfig({ port: 4097 }));
			const all = mgr.getInstances();
			expect(all).toHaveLength(2);
			expect(all.map((i) => i.id).sort()).toEqual(["a", "b"]);
		});
	});

	describe("getInstance", () => {
		it("returns instance by ID", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			const inst = mgr.getInstance("dev");
			expect(inst).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst!.id).toBe("dev");
		});

		it("returns undefined for unknown ID", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(mgr.getInstance("nope")).toBeUndefined();
		});
	});

	// ─── removeInstance ─────────────────────────────────────────────────────

	describe("removeInstance", () => {
		it("removes an existing instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			mgr.removeInstance("dev");
			expect(mgr.getInstance("dev")).toBeUndefined();
			expect(mgr.getInstances()).toHaveLength(0);
		});

		it("throws for unknown ID", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(() => mgr.removeInstance("nope")).toThrow(/not found/i);
		});

		it("allows re-adding after removal", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			mgr.removeInstance("dev");
			mgr.addInstance("dev", managedConfig());
			expect(mgr.getInstance("dev")).toBeDefined();
		});
	});

	// ─── updateInstance ─────────────────────────────────────────────────────

	describe("updateInstance", () => {
		it("updates instance name", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			mgr.updateInstance("test-1", { name: "Renamed" });
			expect(mgr.getInstance("test-1")?.name).toBe("Renamed");
		});

		it("updates instance env", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			mgr.updateInstance("test-1", { env: { XDG_DATA_HOME: "/custom/path" } });
			expect(mgr.getInstance("test-1")?.env).toEqual({
				XDG_DATA_HOME: "/custom/path",
			});
		});

		it("updates instance port", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			mgr.updateInstance("test-1", { port: 6000 });
			expect(mgr.getInstance("test-1")?.port).toBe(6000);
		});

		it("throws for unknown instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(() => mgr.updateInstance("nope", { name: "X" })).toThrow(
				/not found/i,
			);
		});

		it("sets needsRestart when env changes on running instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			// Simulate running state
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("test-1")!;
			(inst as { status: string }).status = "healthy";
			mgr.updateInstance("test-1", { env: { FOO: "bar" } });
			expect(mgr.getInstance("test-1")?.needsRestart).toBe(true);
		});

		it("sets needsRestart when port changes on running instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test", port: 5000 }));
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("test-1")!;
			(inst as { status: string }).status = "healthy";
			mgr.updateInstance("test-1", { port: 6000 });
			expect(mgr.getInstance("test-1")?.needsRestart).toBe(true);
		});

		it("does not set needsRestart when instance is stopped", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			mgr.updateInstance("test-1", { env: { FOO: "bar" } });
			expect(mgr.getInstance("test-1")?.needsRestart).toBeFalsy();
		});

		it("does not set needsRestart for name-only change on running instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("test-1")!;
			(inst as { status: string }).status = "healthy";
			mgr.updateInstance("test-1", { name: "Renamed" });
			expect(mgr.getInstance("test-1")?.needsRestart).toBeFalsy();
		});

		it("clears needsRestart on stopInstance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("test-1")!;
			(inst as { status: string }).status = "healthy";
			(inst as { needsRestart: boolean }).needsRestart = true;
			mgr.stopInstance("test-1");
			expect(mgr.getInstance("test-1")?.needsRestart).toBeFalsy();
		});

		it("emits status_changed when needsRestart set", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("test-1")!;
			(inst as { status: string }).status = "healthy";
			const events: OpenCodeInstance[] = [];
			mgr.on("status_changed", (i) => events.push(i));
			mgr.updateInstance("test-1", { env: { FOO: "bar" } });
			expect(events).toHaveLength(1);
			expect(events[0]?.needsRestart).toBe(true);
		});

		it("does not emit status_changed when nothing changes", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("test-1", managedConfig({ name: "Test" }));
			const events: OpenCodeInstance[] = [];
			mgr.on("status_changed", (i) => events.push(i));
			mgr.updateInstance("test-1", { name: "Test" }); // same name
			expect(events).toHaveLength(0);
		});
	});

	// ─── getInstanceUrl ─────────────────────────────────────────────────────

	describe("getInstanceUrl", () => {
		it("returns http://localhost:{port} for managed instances", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig({ port: 4096 }));
			expect(mgr.getInstanceUrl("dev")).toBe("http://localhost:4096");
		});

		it("returns custom URL for external instances", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance(
				"ext",
				externalConfig({ url: "https://opencode.example.com" }),
			);
			expect(mgr.getInstanceUrl("ext")).toBe("https://opencode.example.com");
		});

		it("falls back to localhost URL for external without custom URL", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("ext", {
				name: "External Instance",
				port: 9090,
				managed: false,
			});
			expect(mgr.getInstanceUrl("ext")).toBe("http://localhost:9090");
		});

		it("throws for unknown ID", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(() => mgr.getInstanceUrl("nope")).toThrow(/not found/i);
		});
	});

	// ─── stopInstance ───────────────────────────────────────────────────────

	describe("stopInstance", () => {
		it("sets status to 'stopped'", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			// Manually set to healthy to test stop
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("dev")!;
			// Instance starts as stopped, so simulate it being healthy
			(inst as { status: string }).status = "healthy";
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.status).toBe("healthy");

			mgr.stopInstance("dev");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.status).toBe("stopped");
		});

		it("throws for unknown ID", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(() => mgr.stopInstance("nope")).toThrow(/not found/i);
		});

		it("is idempotent for already-stopped instances", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			// Already stopped by default
			mgr.stopInstance("dev");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.status).toBe("stopped");
		});
	});

	// ─── stopAll ────────────────────────────────────────────────────────────

	describe("stopAll", () => {
		it("stops all non-stopped instances", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("a", managedConfig({ port: 4096 }));
			mgr.addInstance("b", managedConfig({ port: 4097 }));
			mgr.addInstance("c", managedConfig({ port: 4098 }));

			// Simulate some as running
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const a = mgr.getInstance("a")!;
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const b = mgr.getInstance("b")!;
			(a as { status: string }).status = "healthy";
			(b as { status: string }).status = "starting";
			// c stays stopped

			mgr.stopAll();

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("a")!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("b")!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("c")!.status).toBe("stopped");
		});

		it("does nothing when no instances exist", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			expect(() => mgr.stopAll()).not.toThrow();
		});

		it("clears health polling for instances with status 'stopped' (A2 fix)", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const healthChecker = createMockHealthChecker(true);
			mgr.setHealthChecker(healthChecker);

			// Add an unmanaged instance — addInstance starts health polling immediately,
			// and the instance status remains "stopped" (unmanaged instances have no
			// process lifecycle, but they DO get health-polled).
			mgr.addInstance("ext", {
				name: "External",
				port: 8080,
				managed: false,
				url: "https://opencode.example.com",
			});
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("ext")!.status).toBe("stopped");

			// Verify health polling is active by advancing time
			await vi.advanceTimersByTimeAsync(1100);
			const callsBeforeStop = healthChecker.mock.calls.length;
			expect(callsBeforeStop).toBeGreaterThan(0);

			// stopAll should clear health polling even though status is "stopped"
			mgr.stopAll();

			// Advance past several polling intervals — no additional health checks
			await vi.advanceTimersByTimeAsync(5000);
			expect(healthChecker.mock.calls.length).toBe(callsBeforeStop);

			vi.useRealTimers();
		});

		it("drain() calls stopAll and clears tracked timers", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const healthChecker = createMockHealthChecker(true);
			mgr.setHealthChecker(healthChecker);

			// Add an unmanaged instance with active health polling
			mgr.addInstance("ext", {
				name: "External",
				port: 8080,
				managed: false,
				url: "https://opencode.example.com",
			});

			// Advance to ensure polling is active
			await vi.advanceTimersByTimeAsync(1100);
			const callsBefore = healthChecker.mock.calls.length;

			// drain() should stop everything
			await mgr.drain();

			// Advance — no more health checks
			await vi.advanceTimersByTimeAsync(5000);
			expect(healthChecker.mock.calls.length).toBe(callsBefore);

			vi.useRealTimers();
		});
	});

	// ─── startInstance ──────────────────────────────────────────────────────

	describe("startInstance", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("transitions managed instance to starting then healthy", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const mockProc = createMockProcess(12345);
			mgr.setSpawner(createMockSpawner(mockProc));
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("dev", managedConfig({ port: 14096 }));

			const statusChanges: string[] = [];
			mgr.on("status_changed", (inst) => statusChanges.push(inst.status));

			await mgr.startInstance("dev");

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("dev")!;
			expect(inst.status).toBe("healthy");
			expect(inst.pid).toBe(12345);
			expect(statusChanges).toEqual(["starting", "healthy"]);
		});

		it("throws for external instance", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("ext", externalConfig());

			await expect(mgr.startInstance("ext")).rejects.toThrow(
				/cannot start external instance/i,
			);
		});

		it("throws for unknown instance", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());

			await expect(mgr.startInstance("nope")).rejects.toThrow(/not found/i);
		});

		it("is idempotent for healthy instance", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const spawner = createMockSpawner();
			mgr.setSpawner(spawner);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("dev", managedConfig({ port: 14097 }));

			await mgr.startInstance("dev");
			expect(spawner).toHaveBeenCalledTimes(1);

			// Start again — should be a no-op
			await mgr.startInstance("dev");
			expect(spawner).toHaveBeenCalledTimes(1);
		});

		it("is idempotent for starting instance", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			// Spawner that never resolves (simulates long start)
			let resolveSpawner!: (val: {
				pid: number;
				process: ChildProcess;
			}) => void;
			const spawner = vi.fn().mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveSpawner = resolve;
					}),
			);
			mgr.setSpawner(spawner);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("dev", managedConfig({ port: 14098 }));

			// Start — sets status to "starting" then waits on spawner
			const p1 = mgr.startInstance("dev");

			// Second start while first is in progress — returns early
			const p2 = mgr.startInstance("dev");
			await p2; // should resolve immediately since status is "starting"

			expect(spawner).toHaveBeenCalledTimes(1);

			// Now resolve the spawner so p1 finishes cleanly
			resolveSpawner({ pid: 99999, process: createMockProcess() });
			await p1;
		});

		it("sets lastHealthCheck when initial check succeeds", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.setSpawner(createMockSpawner());
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("dev", managedConfig({ port: 14099 }));

			const before = Date.now();
			await mgr.startInstance("dev");

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("dev")!;
			expect(inst.lastHealthCheck).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(inst.lastHealthCheck!).toBeGreaterThanOrEqual(before);
		});
	});

	// ─── stopInstance with process ──────────────────────────────────────────

	describe("stopInstance with process", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("kills the spawned process and transitions to stopped", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const mockProc = createMockProcess(55555);
			mgr.setSpawner(createMockSpawner(mockProc));
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("dev", managedConfig({ port: 14100 }));
			await mgr.startInstance("dev");

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.status).toBe("healthy");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.pid).toBe(55555);

			mgr.stopInstance("dev");

			expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("dev")!.pid).toBeUndefined();
		});

		it("clears health polling on stop", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry());
			const healthChecker = createMockHealthChecker(true);
			mgr.setSpawner(createMockSpawner());
			mgr.setHealthChecker(healthChecker);

			mgr.addInstance("dev", managedConfig({ port: 14101 }));
			await mgr.startInstance("dev");

			// Reset call count after initial health check
			const callsAfterStart = healthChecker.mock.calls.length;

			mgr.stopInstance("dev");

			// Advance past several polling intervals
			await vi.advanceTimersByTimeAsync(15_000);

			// No additional health checks should have been called
			expect(healthChecker.mock.calls.length).toBe(callsAfterStart);

			vi.useRealTimers();
		});
	});

	// ─── stopAll with processes ────────────────────────────────────────────

	describe("stopAll with processes", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("kills all spawned processes and stops health polling", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const procA = createMockProcess(11111);
			const procB = createMockProcess(22222);
			let callCount = 0;
			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					callCount++;
					const proc = callCount === 1 ? procA : procB;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("a", managedConfig({ port: 14102 }));
			mgr.addInstance("b", managedConfig({ port: 14103 }));

			await mgr.startInstance("a");
			await mgr.startInstance("b");

			mgr.stopAll();

			expect(procA.kill).toHaveBeenCalledWith("SIGTERM");
			expect(procB.kill).toHaveBeenCalledWith("SIGTERM");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("a")!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("b")!.status).toBe("stopped");
		});
	});

	// ─── Events ─────────────────────────────────────────────────────────────

	describe("events", () => {
		it("emits 'instance_added' on addInstance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const handler = vi.fn();
			mgr.on("instance_added", handler);

			mgr.addInstance("dev", managedConfig());

			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({ id: "dev", status: "stopped" }),
			);
		});

		it("emits 'instance_removed' on removeInstance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());

			const handler = vi.fn();
			mgr.on("instance_removed", handler);

			mgr.removeInstance("dev");

			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith("dev");
		});

		it("emits 'status_changed' on stopInstance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			// Set to healthy first
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			(mgr.getInstance("dev")! as { status: string }).status = "healthy";

			const handler = vi.fn();
			mgr.on("status_changed", handler);

			mgr.stopInstance("dev");

			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "dev",
					status: "stopped",
				}),
			);
		});

		it("emits 'status_changed' for each instance in stopAll", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("a", managedConfig({ port: 4096 }));
			mgr.addInstance("b", managedConfig({ port: 4097 }));
			// Set both to healthy
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			(mgr.getInstance("a")! as { status: string }).status = "healthy";
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			(mgr.getInstance("b")! as { status: string }).status = "healthy";

			const handler = vi.fn();
			mgr.on("status_changed", handler);

			mgr.stopAll();

			expect(handler).toHaveBeenCalledTimes(2);
		});

		it("does not emit 'status_changed' for already-stopped instances in stopAll", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("a", managedConfig({ port: 4096 }));
			// a is already stopped by default

			const handler = vi.fn();
			mgr.on("status_changed", handler);

			mgr.stopAll();

			expect(handler).not.toHaveBeenCalled();
		});
	});

	// ─── Crash Recovery ────────────────────────────────────────────────────

	describe("crash recovery", () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it("restarts instance when process exits with non-zero code", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			const exitCallbacks: Array<(code: number | null) => void> = [];

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallbacks.push(cb as (code: number | null) => void);
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("crashy", managedConfig({ port: 14200 }));
			await mgr.startInstance("crashy");

			expect(spawnCount).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("crashy")!.status).toBe("healthy");

			// Simulate crash (non-zero exit)
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[0]!(1);

			// Advance past backoff delay (first restart: 1000ms base)
			await vi.advanceTimersByTimeAsync(2000);

			expect(spawnCount).toBe(2);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("crashy")!.restartCount).toBe(1);

			mgr.stopAll();
		});

		it("does not restart on clean exit (code 0)", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("clean", managedConfig({ port: 14201 }));
			await mgr.startInstance("clean");

			expect(spawnCount).toBe(1);

			// Simulate clean exit
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallback!(0);

			// Advance past any potential backoff
			await vi.advanceTimersByTimeAsync(5000);

			// Should NOT have respawned
			expect(spawnCount).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("clean")!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("clean")!.exitCode).toBe(0);

			mgr.stopAll();
		});

		it("does not restart when instance was stopped intentionally", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("manual", managedConfig({ port: 14202 }));
			await mgr.startInstance("manual");

			expect(spawnCount).toBe(1);

			// Intentionally stop the instance
			mgr.stopInstance("manual");

			// If the process fires exit after being killed, it shouldn't restart
			if (exitCallback) {
				(exitCallback as (code: number | null) => void)(1);
			}

			await vi.advanceTimersByTimeAsync(5000);

			// Should NOT have respawned
			expect(spawnCount).toBe(1);

			mgr.stopAll();
		});

		it("gives up after max restarts in window and emits instance_error", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 2,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			const exitCallbacks: Array<(code: number | null) => void> = [];

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallbacks.push(cb as (code: number | null) => void);
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			const errorHandler = vi.fn();
			mgr.on("instance_error", errorHandler);

			mgr.addInstance("fragile", managedConfig({ port: 14203 }));
			await mgr.startInstance("fragile");

			// First crash → restart #1
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[0]!(1);
			await vi.advanceTimersByTimeAsync(2000);
			expect(spawnCount).toBe(2);

			// Second crash → should give up (maxRestartsPerWindow = 2, recent.length >= 2)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallbacks[1]!(1);
			await vi.advanceTimersByTimeAsync(5000);

			// Should NOT have spawned a 3rd time
			expect(spawnCount).toBe(2);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("fragile")!.status).toBe("stopped");
			expect(errorHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "fragile",
					error: expect.stringContaining("giving up"),
				}),
			);

			mgr.stopAll();
		});

		it("uses exponential backoff between restarts", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 10,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			const exitCallbacks: Array<(code: number | null) => void> = [];

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallbacks.push(cb as (code: number | null) => void);
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("backoff", managedConfig({ port: 14204 }));
			await mgr.startInstance("backoff");

			// First crash → backoff should be ~1000ms
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[0]!(1);

			// After 500ms, should NOT have restarted yet
			await vi.advanceTimersByTimeAsync(500);
			expect(spawnCount).toBe(1);

			// After another 600ms (total 1100ms), should have restarted
			await vi.advanceTimersByTimeAsync(600);
			expect(spawnCount).toBe(2);

			// Second crash → backoff should be ~2000ms
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[1]!(1);

			// After 1500ms, should NOT have restarted yet
			await vi.advanceTimersByTimeAsync(1500);
			expect(spawnCount).toBe(2);

			// After another 600ms (total 2100ms), should have restarted
			await vi.advanceTimersByTimeAsync(600);
			expect(spawnCount).toBe(3);

			mgr.stopAll();
		});

		it("increments restartCount on each crash", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			const exitCallbacks: Array<(code: number | null) => void> = [];

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallbacks.push(cb as (code: number | null) => void);
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("counting", managedConfig({ port: 14205 }));
			await mgr.startInstance("counting");

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("counting")!.restartCount).toBe(0);

			// First crash
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[0]!(1);
			await vi.advanceTimersByTimeAsync(2000);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("counting")!.restartCount).toBe(1);

			// Second crash
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[1]!(1);
			await vi.advanceTimersByTimeAsync(3000);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("counting")!.restartCount).toBe(2);

			mgr.stopAll();
		});

		it("records exitCode on crash", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					const proc = {
						kill: vi.fn(),
						pid: 55555,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("exit-code", managedConfig({ port: 14206 }));
			await mgr.startInstance("exit-code");

			// Crash with exit code 137 (OOM kill)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallback!(137);

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("exit-code")!;
			expect(inst.exitCode).toBe(137);

			mgr.stopAll();
		});

		it("sets status to unhealthy immediately on crash", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					const proc = {
						kill: vi.fn(),
						pid: 55555,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("crash-status", managedConfig({ port: 14207 }));
			await mgr.startInstance("crash-status");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("crash-status")!.status).toBe("healthy");

			// Crash — status should be unhealthy IMMEDIATELY, before backoff fires
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallback!(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("crash-status")!.status).toBe("unhealthy");

			mgr.stopAll();
		});

		it("cancels pending restart when stopInstance is called during backoff", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("cancel-restart", managedConfig({ port: 14208 }));
			await mgr.startInstance("cancel-restart");
			expect(spawnCount).toBe(1);

			// Crash — starts backoff timer
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallback!(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("cancel-restart")!.status).toBe("unhealthy");

			// Stop during backoff — should cancel the pending restart
			mgr.stopInstance("cancel-restart");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("cancel-restart")!.status).toBe("stopped");

			// Advance past backoff — should NOT have respawned
			await vi.advanceTimersByTimeAsync(5000);
			expect(spawnCount).toBe(1);
		});
	});

	// ─── removeInstance with running process ─────────────────────────────

	describe("removeInstance with running process", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("stops process before removing instance", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const mockProc = createMockProcess(77777);
			mgr.setSpawner(createMockSpawner(mockProc));
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("running", managedConfig({ port: 14209 }));
			await mgr.startInstance("running");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("running")!.status).toBe("healthy");

			mgr.removeInstance("running");

			expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(mgr.getInstance("running")).toBeUndefined();
		});

		it("cancels pending restart timers on remove", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 5,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("remove-backoff", managedConfig({ port: 14210 }));
			await mgr.startInstance("remove-backoff");

			// Crash — starts backoff timer
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallback!(1);

			// Remove during backoff
			mgr.removeInstance("remove-backoff");
			expect(mgr.getInstance("remove-backoff")).toBeUndefined();

			// Advance past backoff — should NOT crash or respawn
			await vi.advanceTimersByTimeAsync(5000);
			expect(spawnCount).toBe(1);

			vi.useRealTimers();
		});
	});

	// ─── startInstance edge cases ─────────────────────────────────────────

	describe("startInstance edge cases", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("kills old process when starting unhealthy instance", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const oldProc = createMockProcess(11111);
			const newProc = createMockProcess(22222);
			let callCount = 0;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					callCount++;
					const proc = callCount === 1 ? oldProc : newProc;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("unhealthy-start", managedConfig({ port: 14211 }));
			await mgr.startInstance("unhealthy-start");
			expect(callCount).toBe(1);

			// Simulate unhealthy status
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("unhealthy-start")!;
			(inst as { status: string }).status = "unhealthy";

			// Start again — should kill old process and spawn new
			await mgr.startInstance("unhealthy-start");
			expect(oldProc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(callCount).toBe(2);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("unhealthy-start")!.pid).toBe(22222);
		});

		it("resets to stopped if spawner rejects", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.setSpawner(vi.fn().mockRejectedValue(new Error("spawn failed")));
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("spawn-fail", managedConfig({ port: 14212 }));

			const statusChanges: string[] = [];
			mgr.on("status_changed", (inst) => statusChanges.push(inst.status));

			await expect(mgr.startInstance("spawn-fail")).rejects.toThrow(
				"spawn failed",
			);

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("spawn-fail")!.status).toBe("stopped");
			expect(statusChanges).toContain("starting");
			expect(statusChanges).toContain("stopped");
		});

		it("cleans up process if health check throws after spawn", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const mockProc = createMockProcess(33333);
			mgr.setSpawner(
				vi.fn().mockResolvedValue({ pid: 33333, process: mockProc }),
			);
			mgr.setHealthChecker(
				vi.fn().mockRejectedValue(new Error("check failed")),
			);

			mgr.addInstance("leak-test", managedConfig({ port: 14213 }));

			await expect(mgr.startInstance("leak-test")).rejects.toThrow(
				"check failed",
			);

			// Process should have been killed and cleaned up
			expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(mockProc.removeAllListeners).toHaveBeenCalledWith("exit");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("leak-test")!.status).toBe("stopped");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("leak-test")!.pid).toBeUndefined();
		});
	});

	// ─── getExternalUrl ──────────────────────────────────────────────────

	describe("getExternalUrl", () => {
		it("returns URL for external instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("ext", externalConfig({ url: "https://example.com" }));
			expect(mgr.getExternalUrl("ext")).toBe("https://example.com");
		});

		it("returns undefined for managed instance", () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			mgr.addInstance("dev", managedConfig());
			expect(mgr.getExternalUrl("dev")).toBeUndefined();
		});
	});

	// ─── Fix #4: Race — process exits during startInstance's async continuation ─

	describe("fix #4: race guard after health check", () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it("does not start health polling if process exited (unhealthy) before health check completes", async () => {
			vi.useFakeTimers();
			// maxRestartsPerWindow: 0 ensures crash gives up immediately (no backoff restart)
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
				maxRestartsPerWindow: 0,
			});

			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					const proc = {
						kill: vi.fn(),
						pid: 55555,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);

			// Health checker fires the exit callback BEFORE returning false
			// (simulating process death during health check await)
			const healthCheckerFn = vi.fn().mockImplementation(async () => {
				// Simulate crash during health check
				if (exitCallback) {
					exitCallback(1);
				}
				return false;
			});
			mgr.setHealthChecker(healthCheckerFn);

			mgr.addInstance("race", managedConfig({ port: 14300 }));
			await mgr.startInstance("race");

			// After startInstance, instance should be stopped (max restarts exceeded, gave up)
			// The exit fired during health check: handleProcessExit → unhealthy → then stopped
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const status = mgr.getInstance("race")!.status;
			expect(status === "unhealthy" || status === "stopped").toBe(true);

			// Advance past several polling intervals — health polling should NOT run
			const callsAfterStart = healthCheckerFn.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(healthCheckerFn.mock.calls.length).toBe(callsAfterStart);

			mgr.stopAll();
		});

		it("does not overwrite 'unhealthy' status when healthy=true and process died during health check", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
				maxRestartsPerWindow: 0,
			});

			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					const proc = {
						kill: vi.fn(),
						pid: 55557,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);

			// Health checker returns TRUE, but process crashes during the await
			// (the guard must prevent the healthy=true write from overwriting "unhealthy")
			const healthCheckerFn = vi.fn().mockImplementation(async () => {
				if (exitCallback) {
					exitCallback(1); // crash fires BEFORE health check resolves
				}
				return true; // reports healthy even though it just died
			});
			mgr.setHealthChecker(healthCheckerFn);

			const statusChanges: string[] = [];
			mgr.on("status_changed", (inst) => statusChanges.push(inst.status));

			mgr.addInstance("race-healthy-crash", managedConfig({ port: 14303 }));
			await mgr.startInstance("race-healthy-crash");

			// Status must NOT be "healthy" — the guard should have prevented that write
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const finalStatus = mgr.getInstance("race-healthy-crash")!.status;
			expect(finalStatus === "unhealthy" || finalStatus === "stopped").toBe(
				true,
			);
			expect(finalStatus).not.toBe("healthy");

			// Health polling must NOT have started — advancing time should not call health checker again
			const callsAfterStart = healthCheckerFn.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(healthCheckerFn.mock.calls.length).toBe(callsAfterStart);

			mgr.stopAll();
		});

		it("does not start health polling if process exited (stopped) before health check completes", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});

			let exitCallback: ((code: number | null) => void) | null = null;

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					const proc = {
						kill: vi.fn(),
						pid: 55556,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallback = cb as (code: number | null) => void;
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);

			// Health checker fires clean exit BEFORE returning
			const healthCheckerFn2 = vi.fn().mockImplementation(async () => {
				// Simulate clean exit during health check
				if (exitCallback) {
					exitCallback(0);
				}
				return false;
			});
			mgr.setHealthChecker(healthCheckerFn2);

			mgr.addInstance("race-stop", managedConfig({ port: 14301 }));
			await mgr.startInstance("race-stop");

			// After startInstance, status should be stopped (clean exit)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("race-stop")!.status).toBe("stopped");

			// No health polling should fire
			const callsAfterStart = healthCheckerFn2.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(healthCheckerFn2.mock.calls.length).toBe(callsAfterStart);

			mgr.stopAll();
		});
	});

	// ─── Fix #5: Off-by-one in restart rate-limiting ─────────────────────────

	describe("fix #5: >= maxRestartsPerWindow rate limit", () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it("gives up exactly at maxRestartsPerWindow crashes (not one beyond)", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				maxRestartsPerWindow: 3,
				restartWindowMs: 60_000,
			});

			let spawnCount = 0;
			const exitCallbacks: Array<(code: number | null) => void> = [];

			mgr.setSpawner(
				vi.fn().mockImplementation(() => {
					spawnCount++;
					const proc = {
						kill: vi.fn(),
						pid: 10000 + spawnCount,
						on: vi.fn().mockImplementation(
							(
								event: string, // biome-ignore lint/complexity/noBannedTypes: test mock
								cb: Function,
							) => {
								if (event === "exit")
									exitCallbacks.push(cb as (code: number | null) => void);
							},
						),
						removeAllListeners: vi.fn(),
					} as unknown as ChildProcess;
					return Promise.resolve({ pid: proc.pid, process: proc });
				}),
			);
			mgr.setHealthChecker(createMockHealthChecker(true));

			const errorHandler = vi.fn();
			mgr.on("instance_error", errorHandler);

			mgr.addInstance("exact-limit", managedConfig({ port: 14302 }));
			await mgr.startInstance("exact-limit");

			// Crash 1 → restart
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[0]!(1);
			await vi.advanceTimersByTimeAsync(2000);
			expect(spawnCount).toBe(2);
			expect(errorHandler).not.toHaveBeenCalled();

			// Crash 2 → restart
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			exitCallbacks[1]!(1);
			await vi.advanceTimersByTimeAsync(3000);
			expect(spawnCount).toBe(3);
			expect(errorHandler).not.toHaveBeenCalled();

			// Crash 3 → should give up (recent.length = 3, 3 >= maxRestartsPerWindow = 3)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			exitCallbacks[2]!(1);
			await vi.advanceTimersByTimeAsync(5000);

			expect(spawnCount).toBe(3); // No 4th spawn
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("exact-limit")!.status).toBe("stopped");
			expect(errorHandler).toHaveBeenCalledWith(
				expect.objectContaining({ id: "exact-limit" }),
			);

			mgr.stopAll();
		});
	});

	// ─── Fix #7: defaultSpawner wraps in Promise for 'spawn'/'error' events ──

	describe("fix #7: defaultSpawner error handling", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("spawner rejects reset instance to stopped status", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			// Simulate what the fixed defaultSpawner does: reject on error
			mgr.setSpawner(vi.fn().mockRejectedValue(new Error("spawn ENOENT")));
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("spawn-err", managedConfig({ port: 14310 }));

			await expect(mgr.startInstance("spawn-err")).rejects.toThrow(
				"spawn ENOENT",
			);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("spawn-err")!.status).toBe("stopped");
		});

		it("spawner resolves with pid on successful spawn", async () => {
			const mgr = new InstanceManager(new ServiceRegistry());
			const mockProc = createMockProcess(42000);
			mgr.setSpawner(createMockSpawner(mockProc));
			mgr.setHealthChecker(createMockHealthChecker(true));

			mgr.addInstance("spawn-ok", managedConfig({ port: 14311 }));
			await mgr.startInstance("spawn-ok");

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("spawn-ok")!.status).toBe("healthy");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("spawn-ok")!.pid).toBe(42000);
		});
	});

	// ─── Fix #8: Health polling stops when status becomes "unhealthy" ─────────

	describe("fix #8: health polling stops on unhealthy status", () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it("stops health polling interval when poll detects unhealthy status set externally", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const mockProc = createMockProcess(99998);
			mgr.setSpawner(createMockSpawner(mockProc));
			const healthChecker = createMockHealthChecker(true);
			mgr.setHealthChecker(healthChecker);

			mgr.addInstance("poll-stop", managedConfig({ port: 14320 }));
			await mgr.startInstance("poll-stop");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("poll-stop")!.status).toBe("healthy");

			// Simulate external process death: mark unhealthy (as handleProcessExit does)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("poll-stop")!;
			(inst as { status: string }).status = "unhealthy";

			// Track health checker calls after we mark unhealthy
			// The poll interval should fire once, detect unhealthy, then stop
			const callsBefore = healthChecker.mock.calls.length;

			// Advance one poll interval — the callback should run and then stop itself
			await vi.advanceTimersByTimeAsync(1000);
			const callsAfterOne = healthChecker.mock.calls.length;

			// Advance several more intervals — no more calls should happen
			await vi.advanceTimersByTimeAsync(5000);
			expect(healthChecker.mock.calls.length).toBe(callsAfterOne);

			// The interval fired at most once after being marked unhealthy
			expect(callsAfterOne - callsBefore).toBeLessThanOrEqual(1);

			mgr.stopAll();
		});

		it("does not update status when already unhealthy (guard returns early)", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const mockProc = createMockProcess(99997);
			mgr.setSpawner(createMockSpawner(mockProc));

			let callCount = 0;
			mgr.setHealthChecker(
				vi.fn().mockImplementation(async () => {
					callCount++;
					return false;
				}),
			);

			mgr.addInstance("poll-unhealthy", managedConfig({ port: 14321 }));
			await mgr.startInstance("poll-unhealthy");

			// Manually set to unhealthy
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("poll-unhealthy")!;
			(inst as { status: string }).status = "unhealthy";

			const callsBefore = callCount;

			// Advance one tick — the interval fires, detects unhealthy, stops
			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(5000);

			// Should have stopped after at most one extra call
			expect(callCount - callsBefore).toBeLessThanOrEqual(1);

			mgr.stopAll();
		});

		it("poll continues and transitions to unhealthy when health check fails during 'starting' status", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const mockProc = createMockProcess(99996);
			mgr.setSpawner(createMockSpawner(mockProc));

			// Health checker that initially returns healthy, then unhealthy on the next call
			let pollCallCount = 0;
			const healthChecker = vi.fn().mockImplementation(async () => {
				pollCallCount++;
				return pollCallCount === 1; // first call (initial) = healthy; subsequent = unhealthy
			});
			mgr.setHealthChecker(healthChecker);

			mgr.addInstance("stale-poll", managedConfig({ port: 14322 }));
			await mgr.startInstance("stale-poll");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("stale-poll")!.status).toBe("healthy");

			// Simulate restart cycle: status is set to "starting" (as handleProcessExit's
			// restart timer would do before calling startInstance again).
			// NOTE: In production, startInstance() calls startHealthPolling() which
			// clears the old interval first. This test verifies that if the status is
			// "starting" and the poll fires, it correctly transitions the status
			// rather than silently self-terminating.
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const inst = mgr.getInstance("stale-poll")!;
			(inst as { status: string }).status = "starting";

			const statusChanges: string[] = [];
			mgr.on("status_changed", (i) => statusChanges.push(i.status));

			// Advance one poll interval — poll fires, health check fails → unhealthy
			await vi.advanceTimersByTimeAsync(1000);

			// The poll should have transitioned the instance to "unhealthy"
			expect(statusChanges).toContain("unhealthy");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("stale-poll")!.status).toBe("unhealthy");

			mgr.stopAll();
		});
	});

	// ─── Bug C-1: Health poll self-terminates when status is "starting" ──────

	describe("Bug C-1: managed instance transitions from starting to healthy via polling", () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it("health poll eventually transitions 'starting' to 'healthy' when initial check fails", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const mockProc = createMockProcess(44444);
			mgr.setSpawner(createMockSpawner(mockProc));

			// Initial health check fails (process not ready), then subsequent polls succeed
			let checkCount = 0;
			mgr.setHealthChecker(
				vi.fn().mockImplementation(async () => {
					checkCount++;
					return checkCount > 1; // first check = false, rest = true
				}),
			);

			mgr.addInstance("slow-start", managedConfig({ port: 14400 }));

			const statusChanges: string[] = [];
			mgr.on("status_changed", (inst) => statusChanges.push(inst.status));

			await mgr.startInstance("slow-start");

			// After startInstance, status should still be "starting" (initial check failed)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("slow-start")!.status).toBe("starting");

			// Advance past one polling interval — the poll should transition to "healthy"
			await vi.advanceTimersByTimeAsync(1100);

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("slow-start")!.status).toBe("healthy");
			expect(statusChanges).toContain("healthy");

			mgr.stopAll();
		});

		it("poll transitions 'starting' to 'unhealthy' then stops when health checks keep failing", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});
			const mockProc = createMockProcess(44445);
			mgr.setSpawner(createMockSpawner(mockProc));

			// Health check always fails
			const healthChecker = vi.fn().mockResolvedValue(false);
			mgr.setHealthChecker(healthChecker);

			mgr.addInstance("always-failing", managedConfig({ port: 14401 }));
			await mgr.startInstance("always-failing");

			// After startInstance: status = "starting" (initial check failed)
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("always-failing")!.status).toBe("starting");

			// Advance 1s — first poll tick: starting → unhealthy
			await vi.advanceTimersByTimeAsync(1100);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("always-failing")!.status).toBe("unhealthy");

			// Advance several more intervals — polling should stop after seeing "unhealthy"
			// (the guard catches it on the next tick after the transition)
			const callsBeforeWait = healthChecker.mock.calls.length;
			await vi.advanceTimersByTimeAsync(10_000);
			// At most one more poll fires before the guard stops the interval
			expect(
				healthChecker.mock.calls.length - callsBeforeWait,
			).toBeLessThanOrEqual(1);

			mgr.stopAll();
		});
	});

	// ─── Health checker with auth against real OpenCode ──────────────────────

	describe("health checker with real OpenCode server", () => {
		it("default health checker fails when OpenCode requires auth", async () => {
			// Skip if no real OpenCode server running
			const password = process.env["OPENCODE_SERVER_PASSWORD"];
			if (!password) return;

			const noAuthRes = await fetch("http://localhost:4096/health");
			if (noAuthRes.ok) return; // server doesn't require auth
			expect(noAuthRes.status).toBe(401);

			// Use real defaultHealthChecker (no injection) — should get 401 → unhealthy
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});

			mgr.addInstance("no-auth", {
				name: "No Auth",
				port: 4096,
				managed: false,
				url: "http://localhost:4096",
			});

			// Wait for a health poll cycle
			await vi.waitFor(
				() => {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior addInstance
					expect(mgr.getInstance("no-auth")!.status).toBe("unhealthy");
				},
				{ timeout: 5000 },
			);

			mgr.stopAll();
		}, 10_000);

		it("injected auth health checker succeeds against real OpenCode", async () => {
			// Skip if no real OpenCode server running
			const password = process.env["OPENCODE_SERVER_PASSWORD"];
			if (!password) return;

			const noAuthRes = await fetch("http://localhost:4096/health");
			if (noAuthRes.ok) return; // server doesn't require auth
			expect(noAuthRes.status).toBe(401);

			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});

			// Inject health checker with real credentials (same as daemon would)
			const username = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";
			const encoded = Buffer.from(`${username}:${password}`).toString("base64");
			const authHeader = `Basic ${encoded}`;
			mgr.setHealthChecker(async (port: number) => {
				try {
					const res = await fetch(`http://localhost:${port}/health`, {
						headers: { Authorization: authHeader },
					});
					return res.ok;
				} catch {
					return false;
				}
			});

			const statusChanges: string[] = [];
			mgr.on("status_changed", (inst) => statusChanges.push(inst.status));

			mgr.addInstance("with-auth", {
				name: "With Auth",
				port: 4096,
				managed: false,
				url: "http://localhost:4096",
			});

			// Wait for a health poll cycle
			await vi.waitFor(
				() => {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior addInstance
					expect(mgr.getInstance("with-auth")!.status).toBe("healthy");
				},
				{ timeout: 5000 },
			);

			expect(statusChanges).toContain("healthy");

			mgr.stopAll();
		}, 10_000);
	});

	// ─── Bug C-2: Unmanaged instance never gets health-polled ────────────────

	describe("Bug C-2: unmanaged instance health polling", () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it("unmanaged instance transitions to healthy when health check passes", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});

			const healthChecker = createMockHealthChecker(true);
			mgr.setHealthChecker(healthChecker);

			const statusChanges: string[] = [];
			mgr.on("status_changed", (inst) => statusChanges.push(inst.status));

			mgr.addInstance(
				"default",
				externalConfig({ url: "http://localhost:4096" }),
			);

			// The instance should eventually be polled and transition to "healthy"
			await vi.advanceTimersByTimeAsync(6000);

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("default")!.status).toBe("healthy");
			expect(statusChanges).toContain("healthy");

			mgr.stopAll();
		});

		it("unmanaged instance transitions to unhealthy when health check fails", async () => {
			vi.useFakeTimers();
			const mgr = new InstanceManager(new ServiceRegistry(), {
				healthPollIntervalMs: 1000,
			});

			// First check succeeds, second fails
			let callCount = 0;
			mgr.setHealthChecker(
				vi.fn().mockImplementation(async () => {
					callCount++;
					return callCount <= 1;
				}),
			);

			mgr.addInstance(
				"ext-down",
				externalConfig({ url: "http://localhost:8080" }),
			);

			// First poll — should become healthy
			await vi.advanceTimersByTimeAsync(1100);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("ext-down")!.status).toBe("healthy");

			// Second poll — should become unhealthy
			await vi.advanceTimersByTimeAsync(1000);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("ext-down")!.status).toBe("unhealthy");

			mgr.stopAll();
		});
	});
});
