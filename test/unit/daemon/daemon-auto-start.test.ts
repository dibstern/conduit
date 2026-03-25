// ─── Tests: Daemon Auto-Start (probe-and-convert) ───────────────────────────
// Tests the behavior where the daemon probes an unmanaged "default" instance
// and converts it to managed when OpenCode is not reachable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock daemon-utils before importing Daemon
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

import { Daemon } from "../../../src/lib/daemon/daemon.js";
import {
	isOpencodeInstalled,
	probeOpenCode,
} from "../../../src/lib/daemon/daemon-utils.js";

const mockProbe = vi.mocked(probeOpenCode);
const mockInstalled = vi.mocked(isOpencodeInstalled);

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
	let daemon: Daemon;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		vi.clearAllMocks();
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

		daemon = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		await daemon.start();

		const instances = daemon.getInstances();
		const inst = instances.find((i) => i.id === "default");
		expect(inst).toBeDefined();
		expect(inst?.managed).toBe(false);
		expect(mockInstalled).not.toHaveBeenCalled();
	});

	it("converts to managed when OpenCode is unreachable and binary exists", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		await daemon.start();

		const instances = daemon.getInstances();
		const inst = instances.find((i) => i.id === "default");
		expect(inst).toBeDefined();
		expect(inst?.managed).toBe(true);
	});

	it("throws when OpenCode is unreachable and binary is not installed", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(false);

		daemon = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		await expect(daemon.start()).rejects.toThrow(/opencode.*not found/i);
	});

	it("skips probe-and-convert when smartDefault is false", async () => {
		mockProbe.mockResolvedValue(false);

		daemon = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: false,
		});

		await daemon.start();

		// Should NOT have probed since smartDefault is off
		expect(mockProbe).not.toHaveBeenCalled();

		const instances = daemon.getInstances();
		const inst = instances.find((i) => i.id === "default");
		// Stays unmanaged because smart default is disabled
		expect(inst?.managed).toBe(false);
	});

	it("smart default (no opencodeUrl) also checks binary before spawning", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(false);

		daemon = new Daemon({
			...daemonOpts(tmpDir),
			// No opencodeUrl — triggers the smart default path
			smartDefault: true,
		});

		await expect(daemon.start()).rejects.toThrow(/opencode.*not found/i);
	});

	it("preserves instance name during conversion", async () => {
		mockProbe.mockResolvedValue(false);
		mockInstalled.mockResolvedValue(true);

		daemon = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
			smartDefault: true,
		});

		await daemon.start();

		const instances = daemon.getInstances();
		const inst = instances.find((i) => i.id === "default");
		expect(inst?.name).toBe("Default");
	});
});
