// Tests: Daemon Auto-Start (probe-and-convert)
// Tests the behavior where the daemon probes an unmanaged "opencode" instance
// and converts it to managed when OpenCode is not reachable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock daemon-utils before importing startForegroundDaemon
vi.mock("../../../src/lib/daemon/daemon-utils.js", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("../../../src/lib/daemon/daemon-utils.js")
		>();
	return {
		...original,
		probeOpenCode: vi.fn(),
		isOpencodeInstalled: vi.fn(),
		findFreePort: vi.fn().mockResolvedValue(4096),
	};
});

vi.mock(
	"../../../src/lib/instance/managed-opencode-process.js",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof import("../../../src/lib/instance/managed-opencode-process.js")
			>();
		const { ChildProcess } = await import("node:child_process");
		const probeHealth = vi.fn(original.probeOpenCodeHealth);
		return {
			...original,
			availableOpenCodePort: vi.fn().mockResolvedValue(4096),
			canReuseManagedOpenCode: vi.fn().mockResolvedValue(false),
			inspectManagedOpenCodeProcess: vi.fn().mockResolvedValue(undefined),
			isProcessAlive: vi.fn().mockReturnValue(false),
			spawnManagedOpenCode: vi.fn().mockResolvedValue({
				pid: 10001,
				process: new ChildProcess(),
				processIdentity: {
					supervisorPid: 10002,
					controlPort: 4097,
					token: "a".repeat(64),
				},
			}),
			commitManagedOpenCodeSpawn: vi.fn().mockResolvedValue(undefined),
			probeOpenCodeHealth: probeHealth,
			waitForOpenCodeHealth: vi.fn(
				async (
					record: Parameters<typeof original.waitForOpenCodeHealth>[0],
				) => {
					const health = await probeHealth(record.port, record.env);
					if (!health) throw new Error("Mock OpenCode health unavailable");
					return { pid: 10001, ...health };
				},
			),
			stopManagedOpenCode: vi.fn().mockResolvedValue(true),
		};
	},
);

import {
	isOpencodeInstalled,
	probeOpenCode,
} from "../../../src/lib/daemon/daemon-utils.js";
import {
	type ForegroundDaemonHandle,
	OpenCodeUnavailableError,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { resolveSmartDefaultInstances } from "../../../src/lib/domain/daemon/Services/opencode-smart-default.js";
import {
	canReuseManagedOpenCode,
	spawnManagedOpenCode,
} from "../../../src/lib/instance/managed-opencode-process.js";

const mockProbe = vi.mocked(probeOpenCode);
const mockInstalled = vi.mocked(isOpencodeInstalled);
const mockSpawnManagedOpenCode = vi.mocked(spawnManagedOpenCode);
const mockCanReuse = vi.mocked(canReuseManagedOpenCode);
const mockFetch = vi.fn<typeof fetch>(async () =>
	Response.json({ healthy: true, version: "mock-opencode" }),
);

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-auto-start-"));
}

function daemonOpts(tmpDir: string) {
	return {
		configDir: tmpDir,
		socketPath: join(tmpDir, "relay.sock"),
		port: 0,
	};
}

describe("daemon auto-start (probe-and-convert)", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle | undefined;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		daemon = undefined;
		vi.clearAllMocks();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(async () => {
		try {
			await daemon?.stop();
		} catch {
			// ignore — may not have started
		}
		vi.unstubAllGlobals();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("keeps unmanaged when OpenCode is reachable", async () => {
		mockProbe.mockResolvedValue(true);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		const instances = daemon.getInstances();
		const inst = instances.find((i: { id: string }) => i.id === "opencode");
		expect(inst).toBeDefined();
		expect(inst?.managed).toBe(false);
		expect(mockInstalled).not.toHaveBeenCalled();
	});

	it("prefers a healthy localhost:4096 OpenCode over a persisted managed default", async () => {
		mockProbe.mockResolvedValue(true);

		const instances = await Effect.runPromise(
			resolveSmartDefaultInstances(
				[{ id: "opencode", name: "opencode", port: 4096, managed: true }],
				{ smartDefault: true },
			),
		);

		expect(instances).toEqual([
			{
				id: "opencode",
				name: "opencode",
				port: 4096,
				managed: false,
				url: "http://localhost:4096",
			},
		]);
		expect(mockInstalled).not.toHaveBeenCalled();
	});

	// The supervisor outlives a restart on purpose. Treating its listener as a
	// stranger's server drops the credentials the relay needs to call it.
	it("keeps a persisted managed default whose own OpenCode survived the restart", async () => {
		mockProbe.mockResolvedValue(true);
		mockCanReuse.mockResolvedValueOnce(true);
		const survivor = {
			id: "opencode",
			name: "opencode",
			port: 4096,
			managed: true,
			pid: 74201,
			env: { OPENCODE_SERVER_PASSWORD: "managed-secret" },
		};

		const instances = await Effect.runPromise(
			resolveSmartDefaultInstances([survivor], { smartDefault: true }),
		);

		expect(instances).toEqual([survivor]);
	});

	it("probes an unmanaged default with its own credentials", async () => {
		mockProbe.mockResolvedValue(true);
		const external = {
			id: "opencode",
			name: "opencode",
			port: 4096,
			managed: false,
			url: "http://localhost:4096",
			env: { OPENCODE_SERVER_PASSWORD: "external-secret" },
		};

		const instances = await Effect.runPromise(
			resolveSmartDefaultInstances([external], { smartDefault: true }),
		);

		expect(mockProbe.mock.calls).toEqual([[external.url, external.env]]);
		expect(instances).toEqual([external]);
	});

	it("probes smartDefaultUrl instead of localhost:4096 when given", async () => {
		mockProbe.mockResolvedValue(true);

		const instances = await Effect.runPromise(
			resolveSmartDefaultInstances([], {
				smartDefault: true,
				smartDefaultUrl: "http://localhost:4297",
			}),
		);

		expect(mockProbe.mock.calls).toEqual([
			["http://localhost:4297", undefined],
		]);
		expect(instances).toEqual([
			{
				id: "opencode",
				name: "Default",
				port: 4297,
				managed: false,
				url: "http://localhost:4297",
			},
		]);
	});

	it("converts to managed when OpenCode is unreachable and binary exists", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		const instances = daemon.getInstances();
		const inst = instances.find((i: { id: string }) => i.id === "opencode");
		expect(inst).toBeDefined();
		expect(inst?.managed).toBe(true);
		expect(mockSpawnManagedOpenCode).toHaveBeenCalledOnce();
	});

	it("spawns a healthy managed default on 127.0.0.1:4096 through the managed process helper", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		expect(mockSpawnManagedOpenCode).toHaveBeenCalledExactlyOnceWith(
			"opencode",
			4096,
			expect.objectContaining({
				OPENCODE_SERVER_PASSWORD: expect.any(String),
			}),
			tmpDir,
		);
		expect(mockFetch).toHaveBeenCalledWith(
			"http://127.0.0.1:4096/global/health",
			expect.any(Object),
		);
		const instances = daemon.getInstances();
		const inst = instances.find((i: { id: string }) => i.id === "opencode");
		expect(inst).toMatchObject({
			managed: true,
			port: 4096,
			status: "healthy",
		});
	});

	it("throws when OpenCode is unreachable and binary is not installed", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(false);

		const rejected = startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		await expect(rejected).rejects.toBeInstanceOf(OpenCodeUnavailableError);
		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeUnavailableError",
			url: "http://localhost:4096",
			port: 4096,
		});
		await expect(rejected).rejects.toThrow(/opencode.*not found/i);
	});

	it("skips probe-and-convert when smartDefault is false", async () => {
		mockProbe.mockResolvedValue(false);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: false,
		});

		// Should NOT have probed since smartDefault is off
		expect(mockProbe).not.toHaveBeenCalled();

		const instances = daemon.getInstances();
		const inst = instances.find((i: { id: string }) => i.id === "opencode");
		// Stays unmanaged because smart default is disabled
		expect(inst?.managed).toBe(false);
	});

	it("smart default (no opencodeUrl) also checks binary before spawning", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(false);

		const rejected = startForegroundDaemon({
			...daemonOpts(tmpDir),
			// No opencodeUrl — triggers the smart default path
			smartDefault: true,
		});

		await expect(rejected).rejects.toBeInstanceOf(OpenCodeUnavailableError);
		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeUnavailableError",
			url: "http://localhost:4096",
			port: 4096,
		});
		await expect(rejected).rejects.toThrow(/opencode.*not found/i);
	});

	it("preserves instance name during conversion", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		const instances = daemon.getInstances();
		const inst = instances.find((i: { id: string }) => i.id === "opencode");
		expect(inst?.name).toBe("Default");
	});
});
