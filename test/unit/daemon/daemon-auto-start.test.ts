// ─── Tests: Daemon Auto-Start (probe-and-convert) ───────────────────────────
// Tests the behavior where the daemon probes an unmanaged "default" instance
// and converts it to managed when OpenCode is not reachable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeServer } from "@opencode-ai/sdk/server";
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

vi.mock("@opencode-ai/sdk/server", () => ({
	createOpencodeServer: vi.fn().mockResolvedValue({
		url: "http://127.0.0.1:4096",
		close: vi.fn(),
	}),
}));

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

const mockProbe = vi.mocked(probeOpenCode);
const mockInstalled = vi.mocked(isOpencodeInstalled);
const mockCreateOpencodeServer = vi.mocked(createOpencodeServer);

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "daemon-auto-start-"));
}

function daemonOpts(tmpDir: string) {
	return {
		configDir: tmpDir,
		socketPath: join(tmpDir, "relay.sock"),
		pidPath: join(tmpDir, "daemon.pid"),
		logPath: join(tmpDir, "daemon.log"),
		port: 0,
	};
}

describe("daemon auto-start (probe-and-convert)", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		vi.clearAllMocks();
		mockCreateOpencodeServer.mockResolvedValue({
			url: "http://127.0.0.1:4096",
			close: vi.fn(),
		});
	});

	afterEach(async () => {
		try {
			await daemon?.stop();
		} catch {
			// ignore — may not have started
		}
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
		const inst = instances.find((i: { id: string }) => i.id === "default");
		expect(inst).toBeDefined();
		expect(inst?.managed).toBe(false);
		expect(mockInstalled).not.toHaveBeenCalled();
	});

	it("prefers a healthy localhost:4096 OpenCode over a persisted managed default", async () => {
		mockProbe.mockResolvedValue(true);

		const instances = await Effect.runPromise(
			resolveSmartDefaultInstances(
				[{ id: "default", name: "opencode", port: 4096, managed: true }],
				{ smartDefault: true },
			),
		);

		expect(instances).toEqual([
			{
				id: "default",
				name: "opencode",
				port: 4096,
				managed: false,
				url: "http://localhost:4096",
			},
		]);
		expect(mockInstalled).not.toHaveBeenCalled();
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
		const inst = instances.find((i: { id: string }) => i.id === "default");
		expect(inst).toBeDefined();
		expect(inst?.managed).toBe(true);
	});

	it("starts the managed default through the OpenCode SDK server helper", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		expect(mockCreateOpencodeServer).toHaveBeenCalledWith(
			expect.objectContaining({
				hostname: "127.0.0.1",
				port: 4096,
			}),
		);
		const instances = daemon.getInstances();
		const inst = instances.find((i: { id: string }) => i.id === "default");
		expect(inst?.status).toBe("healthy");
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
		const inst = instances.find((i: { id: string }) => i.id === "default");
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
		const inst = instances.find((i: { id: string }) => i.id === "default");
		expect(inst?.name).toBe("Default");
	});
});
