import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TlsCerts } from "../../../src/lib/cli/tls.js";
import {
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/effect/daemon-config-ref.js";
import type { DaemonHandle } from "../../../src/lib/effect/daemon-main.js";
import { resolveRuntimeConfigUpdateSync } from "../../../src/lib/effect/daemon-main.js";

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

const fixtureDir = join(process.cwd(), "test", "fixtures");
const testCert = readFileSync(join(fixtureDir, "test-cert.pem"));
const testKey = readFileSync(join(fixtureDir, "test-key.pem"));

const fixtureCerts: TlsCerts = {
	key: testKey,
	cert: testCert,
	caRoot: null,
	caCertPem: null,
	caCertDer: null,
};

async function sendRestartConfig(
	socketPath: string,
	config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const client = createConnection(socketPath);
		let buffer = "";

		client.on("connect", () => {
			client.write(
				`${JSON.stringify({ _tag: "RestartWithConfig", config })}\n`,
			);
		});
		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (!buffer.includes("\n")) return;
			const line = buffer.slice(0, buffer.indexOf("\n"));
			client.end();
			resolve(JSON.parse(line) as Record<string, unknown>);
		});
		client.on("error", reject);
	});
}

describe("daemon main runtime config status", () => {
	let tmpDir: string;
	let daemon: DaemonHandle | null;

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
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("reports TLS success with 0.0.0.0 host and the actual bound port", async () => {
		const { startDaemonProcess } = await import(
			"../../../src/lib/effect/daemon-main.js"
		);

		daemon = await startDaemonProcess({
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
		const { startDaemonProcess } = await import(
			"../../../src/lib/effect/daemon-main.js"
		);

		daemon = await startDaemonProcess({
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
		const { startDaemonProcess } = await import(
			"../../../src/lib/effect/daemon-main.js"
		);
		const socketPath = join(tmpDir, "relay.sock");

		daemon = await startDaemonProcess({
			configDir: tmpDir,
			socketPath,
			pidPath: join(tmpDir, "daemon.pid"),
			staticDir: tmpDir,
			port: 0,
			tlsEnabled: false,
			smartDefault: false,
		});

		const response = await sendRestartConfig(socketPath, {
			tls: true,
			keepAwake: true,
		});

		expect(response).toEqual({ ok: true });
		expect(daemon.getStatus().tlsEnabled).toBe(true);
		expect(daemon.getStatus().keepAwake).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(loadDaemonConfig(tmpDir)?.tls).toBe(true);
	});

	it("keeps keep-awake startup config in the runtime-backed ref and persisted config", async () => {
		const { startDaemonProcess } = await import(
			"../../../src/lib/effect/daemon-main.js"
		);

		daemon = await startDaemonProcess({
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

	it("keeps rehydrated dismissed paths and session counts in runtime-backed reads and persistence", async () => {
		const { startDaemonProcess } = await import(
			"../../../src/lib/effect/daemon-main.js"
		);
		const projectPath = join(tmpDir, "persisted-project");
		const dismissedPath = join(tmpDir, "dismissed-project");

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
				dismissedPaths: [dismissedPath],
			},
			tmpDir,
		);

		daemon = await startDaemonProcess({
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
		expect(persisted?.dismissedPaths).toContain(dismissedPath);
		expect(persisted?.projects).toContainEqual(
			expect.objectContaining({
				slug: "persisted-project",
				sessionCount: 7,
			}),
		);
	});

	it("does not apply a local runtime config fallback when the runtime update fails", () => {
		const initial = makeDaemonConfigFromOptions({
			port: 2633,
			host: "127.0.0.1",
			keepAwake: false,
		});

		expect(() =>
			resolveRuntimeConfigUpdateSync(
				initial,
				(config) => ({ ...config, keepAwake: true }),
				() => {
					throw new Error("ref update failed");
				},
			),
		).toThrow("ref update failed");
		expect(initial.keepAwake).toBe(false);
	});

	it("still applies local runtime config updates before the runtime exists", () => {
		const initial = makeDaemonConfigFromOptions({
			port: 2633,
			host: "127.0.0.1",
			keepAwake: false,
		});

		const updated = resolveRuntimeConfigUpdateSync(
			initial,
			(config) => ({ ...config, keepAwake: true }),
			null,
		);

		expect(updated.keepAwake).toBe(true);
	});
});
