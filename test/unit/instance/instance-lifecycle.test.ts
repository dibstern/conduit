import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type DaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { Daemon } from "../../../src/lib/daemon/daemon.js";
import { buildIPCHandlers } from "../../../src/lib/daemon/daemon-ipc.js";
import { createCommandRouter } from "../../../src/lib/daemon/ipc-protocol.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";
import type { InstanceConfig, StoredProject } from "../../../src/lib/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal DaemonIPCContext backed by an InstanceManager for IPC tests. */
function makeIPCContext(manager: InstanceManager, _configDir: string) {
	return {
		getInstances: () => manager.getInstances(),
		getInstance: (id: string) => manager.getInstance(id),
		addInstance: (id: string, config: InstanceConfig) =>
			manager.addInstance(id, config),
		removeInstance: (id: string) => manager.removeInstance(id),
		startInstance: (id: string) => manager.startInstance(id),
		stopInstance: (id: string) => manager.stopInstance(id),
		updateInstance: (
			id: string,
			updates: {
				name?: string;
				env?: Record<string, string>;
				port?: number;
			},
		) => manager.updateInstance(id, updates),
		addProject: async (): Promise<StoredProject> => ({
			slug: "x",
			directory: "/x",
			title: "x",
		}),
		removeProject: async () => {},
		getProjects: () => [],
		setProjectTitle: () => {},
		getPinHash: () => null,
		setPinHash: () => {},
		getKeepAwake: () => false,
		setKeepAwake: () => ({ supported: false, active: false }),
		setKeepAwakeCommand: () => {},
		persistConfig: () => {},
		scheduleShutdown: () => {},
	};
}

describe("instance lifecycle integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "instance-lifecycle-"));
	});

	it("daemon with opencodeUrl creates default instance", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		expect(daemon.getInstances()).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(daemon.getInstances()[0]!.id).toBe("default");
	});

	it("daemon without opencodeUrl has no instances", () => {
		const daemon = new Daemon({ port: 0, configDir: tmpDir });
		expect(daemon.getInstances()).toHaveLength(0);
	});

	it("persists instances in config via saveDaemonConfig", async () => {
		const config: DaemonConfig = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [
				{
					path: "/src/app",
					slug: "app",
					addedAt: Date.now(),
					instanceId: "personal",
				},
			],
			instances: [
				{ id: "personal", name: "Personal", port: 4096, managed: true },
				{ id: "work", name: "Work", port: 4097, managed: true },
			],
		};
		await saveDaemonConfig(config, tmpDir);

		const loaded = loadDaemonConfig(tmpDir);
		expect(loaded).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(loaded!.instances).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(loaded!.projects[0]!.instanceId).toBe("personal");
	});

	it("addProject assigns instanceId from available instances", async () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		const project = await daemon.addProject("/tmp/lifecycle-test");
		expect(project.instanceId).toBe("default");
	});

	// ─── IPC round-trip tests ─────────────────────────────────────────────────

	it("instance_add IPC command returns ok:true with instance data", async () => {
		const manager = new InstanceManager(new ServiceRegistry());
		const ctx = makeIPCContext(manager, tmpDir);
		const handlers = buildIPCHandlers(ctx, () => ({
			ok: true,
			uptime: 0,
			port: 3000,
			host: "127.0.0.1",
			projectCount: 0, sessionCount: 0,
			clientCount: 0,
			pinEnabled: false,
			tlsEnabled: false,
			keepAwake: false,
			projects: [],
		}));
		const router = createCommandRouter(handlers);

		// Send instance_add command
		const addResult = await router({
			cmd: "instance_add",
			name: "Personal",
			port: 4096,
			managed: true,
		});

		expect(addResult.ok).toBe(true);
		const result = addResult as {
			instance?: { id: string; name: string };
		};
		expect(result.instance).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.instance!.name).toBe("Personal");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.instance!.id).toBe("personal");

		// Verify the instance is registered in the manager
		expect(manager.getInstances()).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(manager.getInstance("personal")!.port).toBe(4096);
	});

	it("instance_remove IPC command after adding returns ok:true", async () => {
		const manager = new InstanceManager(new ServiceRegistry());
		const ctx = makeIPCContext(manager, tmpDir);
		const handlers = buildIPCHandlers(ctx, () => ({
			ok: true,
			uptime: 0,
			port: 3000,
			host: "127.0.0.1",
			projectCount: 0, sessionCount: 0,
			clientCount: 0,
			pinEnabled: false,
			tlsEnabled: false,
			keepAwake: false,
			projects: [],
		}));
		const router = createCommandRouter(handlers);

		// Add first
		await router({
			cmd: "instance_add",
			name: "Work",
			port: 4097,
			managed: true,
		});
		expect(manager.getInstances()).toHaveLength(1);

		// Now remove
		const removeResult = await router({
			cmd: "instance_remove",
			id: "work",
		});
		expect(removeResult.ok).toBe(true);
		expect(manager.getInstances()).toHaveLength(0);
	});
});
