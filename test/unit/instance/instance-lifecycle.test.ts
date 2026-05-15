import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";

describe("instance lifecycle integration", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle | null = null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "instance-lifecycle-"));
	});

	afterEach(async () => {
		try {
			await daemon?.stop();
		} catch {
			// ignore
		}
		daemon = null;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("daemon with opencodeUrl creates default instance", async () => {
		daemon = await startForegroundDaemon({
			port: 0,
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			opencodeUrl: "http://localhost:4096",
			smartDefault: false,
		});
		expect(daemon.getInstances()).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(daemon.getInstances()[0]!.id).toBe("default");
	});

	it("daemon without opencodeUrl has no instances (smartDefault=false)", async () => {
		daemon = await startForegroundDaemon({
			port: 0,
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			smartDefault: false,
		});
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
		daemon = await startForegroundDaemon({
			port: 0,
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			opencodeUrl: "http://localhost:4096",
			smartDefault: false,
		});
		const project = await daemon.addProject("/tmp/lifecycle-test");
		expect(project.instanceId).toBe("default");
	});
});
