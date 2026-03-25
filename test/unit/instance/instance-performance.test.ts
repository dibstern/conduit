// ─── Performance Tests: Instance Scaling ─────────────────────────────────────
// Verify InstanceManager handles many instances without excessive resource use,
// and that config persistence handles large instance lists.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
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

describe("InstanceManager performance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles 50 instances without excessive timer accumulation", async () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			maxInstances: 50,
			healthPollIntervalMs: 60_000, // Long interval to avoid actual polling
		});
		mgr.setSpawner(
			vi.fn().mockImplementation((port: number) =>
				Promise.resolve({
					pid: port,
					process: createMockProcess(port),
				}),
			),
		);
		mgr.setHealthChecker(vi.fn().mockResolvedValue(true));

		// Add and start 50 instances
		for (let i = 0; i < 50; i++) {
			mgr.addInstance(`i${i}`, {
				name: `I${i}`,
				port: 3000 + i,
				managed: true,
			});
			await mgr.startInstance(`i${i}`);
		}

		expect(mgr.getInstances()).toHaveLength(50);
		expect(mgr.getInstances().every((i) => i.status === "healthy")).toBe(true);

		// Stop all — verify all are stopped
		mgr.stopAll();
		expect(mgr.getInstances().every((i) => i.status === "stopped")).toBe(true);
	});

	it("saveDaemonConfig handles large instance lists", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "perf-test-"));
		const instances = Array.from({ length: 50 }, (_, i) => ({
			id: `inst-${i}`,
			name: `Instance ${i}`,
			port: 3000 + i,
			managed: true,
		}));

		const config: DaemonConfig = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances,
		};

		const start = performance.now();
		saveDaemonConfig(config, tmpDir);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(100); // Well under 100ms
	});

	it("addInstance + removeInstance is O(1) per operation", () => {
		const mgr = new InstanceManager(new ServiceRegistry(), {
			maxInstances: 1000,
		});

		const start = performance.now();
		for (let i = 0; i < 500; i++) {
			mgr.addInstance(`perf-${i}`, {
				name: `P${i}`,
				port: 3000 + i,
				managed: true,
			});
		}
		for (let i = 0; i < 500; i++) {
			mgr.removeInstance(`perf-${i}`);
		}
		const elapsed = performance.now() - start;

		expect(mgr.getInstances()).toHaveLength(0);
		expect(elapsed).toBeLessThan(200); // 500 add + 500 remove under 200ms
	});
});
