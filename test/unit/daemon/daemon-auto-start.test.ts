// Tests: smart default (probe-and-convert) on first start.
// Startup seeds the default instance without probing. Its first start probes
// the default URL, reuses a reachable OpenCode, and only otherwise converts to
// a managed instance and spawns it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
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
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	type ForegroundDaemonHandle,
	OpenCodeUnavailableError,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import type { DaemonInstanceConfig } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { InstanceHealthCheckTag } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import {
	getInstance,
	type InstanceManagerStateOptions,
	ManagedOpenCodeLifecycleLive,
	makeInstanceManagerStateLive,
	startInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { resolveSmartDefaultInstance } from "../../../src/lib/domain/daemon/Services/opencode-smart-default.js";
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

describe("smart default", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-auto-start-"));
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

	/** Runs the default instance's first start. */
	const startDefault = (
		options: InstanceManagerStateOptions,
		initialInstances: DaemonInstanceConfig[] = [],
	) =>
		Effect.gen(function* () {
			const first = yield* Effect.exit(startInstance("opencode"));
			const instance = yield* getInstance("opencode");
			return { first, instance };
		}).pipe(
			Effect.provide(
				ManagedOpenCodeLifecycleLive(tmpDir).pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							makeInstanceManagerStateLive(
								undefined,
								initialInstances,
								options,
							),
							DaemonEventBusLive,
							ConfigPersistenceNoopLive,
							Layer.succeed(InstanceHealthCheckTag, {
								check: () => Effect.succeed(true),
							}),
						),
					),
				),
			),
			Effect.scoped,
			Effect.runPromise,
		);

	it("neither probes nor spawns at startup", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			port: 0,
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		expect(mockProbe).not.toHaveBeenCalled();
		expect(mockInstalled).not.toHaveBeenCalled();
		expect(mockSpawnManagedOpenCode).not.toHaveBeenCalled();
		expect(daemon.getInstances()).toEqual([
			expect.objectContaining({
				id: "opencode",
				name: "Default",
				managed: false,
				status: "stopped",
			}),
		]);
	});

	it("keeps unmanaged when OpenCode is reachable on first start", async () => {
		mockProbe.mockResolvedValue(true);

		const { first, instance } = await startDefault({
			defaultOpencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		expect(Exit.isSuccess(first)).toBe(true);
		expect(mockProbe.mock.calls).toEqual([
			["http://localhost:4096", undefined],
		]);
		expect(instance.managed).toBe(false);
		expect(mockInstalled).not.toHaveBeenCalled();
		expect(mockSpawnManagedOpenCode).not.toHaveBeenCalled();
	});

	it("looks for OpenCode at smartDefaultUrl when no default is configured", async () => {
		mockProbe.mockResolvedValue(true);

		const { instance } = await startDefault({
			smartDefault: true,
			smartDefaultUrl: "http://localhost:4297",
		});

		expect(mockProbe.mock.calls).toEqual([
			["http://localhost:4297", undefined],
		]);
		expect(instance).toMatchObject({
			id: "opencode",
			name: "Default",
			port: 4297,
			managed: false,
		});
	});

	it("converts to managed and spawns once when nothing answers on first start", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		const { first, instance } = await startDefault({
			defaultOpencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		expect(Exit.isSuccess(first)).toBe(true);
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
		expect(instance).toMatchObject({
			name: "Default",
			managed: true,
			port: 4096,
			status: "healthy",
		});
	});

	it("fails the first start when nothing answers and the binary is missing", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(false);

		const { first, instance } = await startDefault({ smartDefault: true });

		if (Exit.isSuccess(first)) throw new Error("Expected the start to fail");
		const error = Cause.squash(first.cause);
		expect(error).toBeInstanceOf(OpenCodeUnavailableError);
		expect(error).toMatchObject({ url: "http://localhost:4096", port: 4096 });
		expect(instance.managed).toBe(false);
		expect(mockSpawnManagedOpenCode).not.toHaveBeenCalled();
	});

	it("skips probe-and-convert when smartDefault is false", async () => {
		mockProbe.mockResolvedValue(false);

		const { instance } = await startDefault({
			defaultOpencodeUrl: "http://localhost:4096",
			smartDefault: false,
		});

		expect(mockProbe).not.toHaveBeenCalled();
		expect(instance.managed).toBe(false);
	});

	it("prefers a healthy smartDefaultUrl OpenCode over a persisted managed default", async () => {
		mockProbe.mockResolvedValue(true);

		const instance = await Effect.runPromise(
			resolveSmartDefaultInstance(
				{ id: "opencode", name: "opencode", port: 4096, managed: true },
				"http://localhost:4096",
			),
		);

		expect(instance).toEqual({
			id: "opencode",
			name: "opencode",
			port: 4096,
			managed: false,
			url: "http://localhost:4096",
		});
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

		const instance = await Effect.runPromise(
			resolveSmartDefaultInstance(survivor, "http://localhost:4096"),
		);

		expect(instance).toEqual(survivor);
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

		const instance = await Effect.runPromise(
			resolveSmartDefaultInstance(external, "http://localhost:4096"),
		);

		expect(mockProbe.mock.calls).toEqual([[external.url, external.env]]);
		expect(instance).toEqual(external);
	});
});
