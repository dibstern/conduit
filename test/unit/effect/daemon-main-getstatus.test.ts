import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TlsCerts } from "../../../src/lib/cli/tls.js";
import { RestartWithConfig } from "../../../src/lib/contracts/ws-rpc.js";
import {
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { ForegroundDaemonHandle } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { makeTestTlsCerts } from "../../helpers/tls-cert-fixture.js";

const ensureCertsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/cli/tls.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/lib/cli/tls.js")>();
	return {
		...actual,
		ensureCerts: ensureCertsMock,
		getTailscaleIP: vi.fn(() => null),
		getAllIPs: vi.fn(() => []),
	};
});

const fixtureCerts: TlsCerts = makeTestTlsCerts();

async function waitForPersistedConfig(
	configDir: string,
	predicate: (
		config: NonNullable<ReturnType<typeof loadDaemonConfig>>,
	) => boolean,
): Promise<NonNullable<ReturnType<typeof loadDaemonConfig>>> {
	return vi.waitFor(
		() => {
			const config = loadDaemonConfig(configDir);
			if (config && predicate(config)) return config;
			throw new Error(
				`Timed out waiting for persisted config: ${JSON.stringify(config)}`,
			);
		},
		{ timeout: 1_000 },
	);
}

describe("daemon main runtime config status", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle | null;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "conduit-daemon-main-status-"));
		daemon = null;
		vi.clearAllMocks();
		ensureCertsMock.mockResolvedValue(fixtureCerts);
	});

	afterEach(async () => {
		try {
			await daemon?.stop();
		} catch {
			// ignore failed startup or restart shutdown races
		}
		await rm(tmpDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 20,
		});
	});

	it("reports TLS success with 0.0.0.0 host and the actual bound port", async () => {
		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			tlsEnabled: true,
			smartDefault: false,
		});

		const status = daemon.getStatus();
		expect(status.tlsEnabled).toBe(true);
		expect(status.host).toBe("0.0.0.0");
		expect(status.port).toBeGreaterThan(0);
		expect(daemon.port).toBe(status.port);
	});

	it("reports TLS disabled with the explicit loopback host", async () => {
		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			host: "127.0.0.1",
			tlsEnabled: false,
			smartDefault: false,
		});

		const status = daemon.getStatus();
		expect(status.tlsEnabled).toBe(false);
		expect(status.host).toBe("127.0.0.1");
		expect(status.port).toBeGreaterThan(0);
		expect(daemon.port).toBe(status.port);
		expect(ensureCertsMock).not.toHaveBeenCalled();
	});

	it("applies restart TLS config before persistence and shutdown", async () => {
		const socketPath = join(tmpDir, "relay.sock");

		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath,
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			tlsEnabled: false,
			smartDefault: false,
		});

		const response = await sendRpcRequest(
			socketPath,
			new RestartWithConfig({ config: { tls: true, keepAwake: true } }),
		);

		expect(response).toEqual({ ok: true });
		expect(daemon.getStatus().tlsEnabled).toBe(true);
		expect(daemon.getStatus().keepAwake).toBe(true);
		const persisted = await waitForPersistedConfig(
			tmpDir,
			(config) => config.tls === true,
		);
		expect(persisted.tls).toBe(true);
	});

	it("keeps keep-awake startup config in the runtime-backed ref and persisted config", async () => {
		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			tlsEnabled: false,
			smartDefault: false,
			keepAwake: true,
			keepAwakeCommand: "printf",
			keepAwakeArgs: ["awake"],
		});

		const status = daemon.getStatus();
		expect(status.keepAwake).toBe(true);

		await daemon.stop();
		daemon = null;

		const persisted = loadDaemonConfig(tmpDir);
		expect(persisted?.keepAwake).toBe(true);
		expect(persisted?.keepAwakeCommand).toBe("printf");
		expect(persisted?.keepAwakeArgs).toEqual(["awake"]);
	});

	it("keeps rehydrated session counts in runtime-backed reads and persistence", async () => {
		const projectPath = join(tmpDir, "persisted-project");

		await saveDaemonConfig(
			{
				pid: 123,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [
					{
						path: projectPath,
						slug: "persisted-project",
						title: "Persisted Project",
						addedAt: 456,
						sessionCount: 7,
					},
				],
				instances: [],
			},
			tmpDir,
		);

		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			tlsEnabled: false,
			smartDefault: false,
		});

		const status = daemon.getStatus();
		expect(status.sessionCount).toBe(7);

		await daemon.stop();
		daemon = null;

		const persisted = loadDaemonConfig(tmpDir);
		expect(persisted).not.toHaveProperty("dismissedPaths");
		expect(persisted?.projects).toContainEqual(
			expect.objectContaining({
				slug: "persisted-project",
				sessionCount: 7,
			}),
		);
	});

	it("keeps a removed project removed across restart and accepts an explicit re-add", async () => {
		const projectPath = join(tmpDir, "project");
		await mkdir(projectPath);
		const options = {
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			tlsEnabled: false,
			smartDefault: false,
		};
		daemon = await startForegroundDaemon(options);
		const project = await daemon.addProject(projectPath);
		expect(daemon.getProjects().map((entry) => entry.directory)).toEqual([
			projectPath,
		]);
		await daemon.removeProject(project.slug);
		await daemon.stop();
		expect(loadDaemonConfig(tmpDir)?.projects).toEqual([]);
		daemon = await startForegroundDaemon(options);
		expect(daemon.getProjects()).toEqual([]);
		const added = await daemon.addProject(projectPath);
		expect(added.directory).toBe(projectPath);
		expect(daemon.getProjects()).toEqual([added]);
		await daemon.stop();
		daemon = null;
		expect(loadDaemonConfig(tmpDir)?.projects).toEqual([
			expect.objectContaining({ path: projectPath, slug: added.slug }),
		]);
	});
});
