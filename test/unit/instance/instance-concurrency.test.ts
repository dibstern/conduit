// ─── Concurrency Stress Tests ────────────────────────────────────────────────
// Rapid parallel operations to surface race conditions in InstanceManager.

import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockProcess(pid = 99999): ChildProcess {
	return {
		kill: vi.fn(),
		pid,
		on: vi.fn(),
		removeAllListeners: vi.fn(),
	} as unknown as ChildProcess;
}

describe("InstanceManager concurrency", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("survives rapid add/remove cycles without orphaned state", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			maxInstances: 100,
		});
		const ops: Promise<void>[] = [];

		for (let i = 0; i < 50; i++) {
			ops.push(
				(async () => {
					const id = `inst-${i}`;
					mgr.addInstance(id, {
						name: `I${i}`,
						port: 3000 + i,
						managed: true,
					});
					mgr.removeInstance(id);
				})(),
			);
		}

		await Promise.all(ops);
		expect(mgr.getInstances()).toHaveLength(0);
	});

	it("survives rapid start/stop cycles on the same instance", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		mgr.setSpawner(
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve({ pid: 1, process: createMockProcess() }),
				),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));
		mgr.addInstance("rapid", {
			name: "Rapid",
			port: 3000,
			managed: true,
		});

		for (let i = 0; i < 10; i++) {
			await mgr.startInstance("rapid");
			mgr.stopInstance("rapid");
		}

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(mgr.getInstance("rapid")!.status).toBe("stopped");
	});

	it("concurrent startInstance calls don't double-spawn", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			healthPollIntervalMs: 999_999,
		});
		let spawnCount = 0;
		mgr.setSpawner(
			vi.fn().mockImplementation(async () => {
				spawnCount++;
				await new Promise((r) => setTimeout(r, 10));
				return {
					pid: spawnCount,
					process: createMockProcess(spawnCount),
				};
			}),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));
		mgr.addInstance("dup", { name: "Dup", port: 3000, managed: true });

		// Two concurrent starts — second should return early (status is "starting")
		await Promise.all([mgr.startInstance("dup"), mgr.startInstance("dup")]);

		expect(spawnCount).toBe(1);

		mgr.stopAll();
	});

	it("adding instances up to maxInstances works, one more throws", () => {
		const mgr = new InstanceManager(new ServiceRegistry(), { maxInstances: 3 });
		mgr.addInstance("a", { name: "A", port: 3001, managed: true });
		mgr.addInstance("b", { name: "B", port: 3002, managed: true });
		mgr.addInstance("c", { name: "C", port: 3003, managed: true });
		expect(() =>
			mgr.addInstance("d", { name: "D", port: 3004, managed: true }),
		).toThrow(/max/i);
	});

	it("removing and re-adding the same ID rapidly works cleanly", () => {
		const mgr = new InstanceManager(new ServiceRegistry());

		for (let i = 0; i < 20; i++) {
			mgr.addInstance("cycle", {
				name: `Cycle-${i}`,
				port: 3000 + i,
				managed: true,
			});
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(mgr.getInstance("cycle")!.name).toBe(`Cycle-${i}`);
			mgr.removeInstance("cycle");
			expect(mgr.getInstance("cycle")).toBeUndefined();
		}

		expect(mgr.getInstances()).toHaveLength(0);
	});

	it("events fire in correct order during rapid operations", () => {
		const mgr = new InstanceManager(new ServiceRegistry());
		const events: string[] = [];

		mgr.on("instance_added", (inst) => events.push(`added:${inst.id}`));
		mgr.on("instance_removed", (id) => events.push(`removed:${id}`));
		mgr.on("status_changed", (inst) =>
			events.push(`status:${inst.id}:${inst.status}`),
		);

		mgr.addInstance("x", { name: "X", port: 3000, managed: true });
		mgr.removeInstance("x");

		expect(events).toEqual(["added:x", "removed:x"]);
	});
});
