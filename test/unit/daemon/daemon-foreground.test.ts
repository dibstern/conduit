import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sendIPCCommand } from "../../../src/bin/cli-utils.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import type { OpenCodeInstance } from "../../../src/lib/types.js";

async function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address == null) {
				throw new Error("Expected TCP server address");
			}
			resolve(address.port);
		});
	});
}

async function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

const expectedBasicAuth = (username: string, password: string) =>
	`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("startForegroundDaemon", () => {
	it("starts an Effect-backed foreground handle with isolated config", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-foreground-"));
		const configDir = join(root, "config");
		const staticDir = join(root, "static");
		const projectDir = join(root, "project");
		mkdirSync(staticDir);
		mkdirSync(projectDir);
		writeFileSync(join(staticDir, "index.html"), "<html>ok</html>", {
			flag: "w",
		});

		const daemon = await startForegroundDaemon({
			port: 0,
			configDir,
			socketPath: join(root, "relay.sock"),
			pidPath: join(root, "daemon.pid"),
			staticDir,
			tlsEnabled: false,
			smartDefault: false,
			logLevel: "error",
			logFormat: "json",
		});

		try {
			expect(daemon.port).toBeGreaterThan(0);
			expect(daemon.onboardingPort).toBeNull();

			const project = await daemon.addProject(projectDir, "foreground-project");
			expect(project.slug).toBe("foreground-project");

			const status = daemon.getStatus();
			expect(status.projectCount).toBe(1);
			expect(status.projects.map((p) => p.slug)).toEqual([
				"foreground-project",
			]);
			expect(daemon.getProjects().map((p) => p.slug)).toEqual([
				"foreground-project",
			]);
		} finally {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts health polling for an opencodeUrl default instance", async () => {
		const healthServer = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		const opencodePort = await listen(healthServer);
		const root = mkdtempSync(join(tmpdir(), "conduit-foreground-health-"));
		const configDir = join(root, "config");
		const staticDir = join(root, "static");
		mkdirSync(staticDir);
		writeFileSync(join(staticDir, "index.html"), "<html>ok</html>", {
			flag: "w",
		});

		const daemon = await startForegroundDaemon({
			port: 0,
			configDir,
			socketPath: join(root, "relay.sock"),
			pidPath: join(root, "daemon.pid"),
			staticDir,
			opencodeUrl: `http://127.0.0.1:${opencodePort}`,
			tlsEnabled: false,
			smartDefault: false,
			logLevel: "error",
			logFormat: "json",
		});

		try {
			await vi.waitFor(() => {
				expect(daemon.getInstances()).toEqual([
					expect.objectContaining({
						id: "default",
						managed: false,
						port: opencodePort,
						status: "healthy",
					}),
				]);
			});
		} finally {
			await daemon.stop();
			await closeServer(healthServer);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("authenticates default instance health checks with OpenCode credentials", async () => {
		const previousPassword = process.env["OPENCODE_SERVER_PASSWORD"];
		const previousUsername = process.env["OPENCODE_SERVER_USERNAME"];
		process.env["OPENCODE_SERVER_PASSWORD"] = "health-secret";
		process.env["OPENCODE_SERVER_USERNAME"] = "opencode";

		const healthServer = createServer((req, res) => {
			if (
				req.headers.authorization !==
				expectedBasicAuth("opencode", "health-secret")
			) {
				res.writeHead(401);
				res.end("unauthorized");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		const opencodePort = await listen(healthServer);
		const root = mkdtempSync(join(tmpdir(), "conduit-foreground-auth-health-"));
		const configDir = join(root, "config");
		const staticDir = join(root, "static");
		mkdirSync(staticDir);
		writeFileSync(join(staticDir, "index.html"), "<html>ok</html>", {
			flag: "w",
		});

		const daemon = await startForegroundDaemon({
			port: 0,
			configDir,
			socketPath: join(root, "relay.sock"),
			pidPath: join(root, "daemon.pid"),
			staticDir,
			opencodeUrl: `http://127.0.0.1:${opencodePort}`,
			tlsEnabled: false,
			smartDefault: false,
			logLevel: "error",
			logFormat: "json",
		});

		try {
			await vi.waitFor(() => {
				expect(daemon.getInstances()).toEqual([
					expect.objectContaining({
						id: "default",
						managed: false,
						port: opencodePort,
						status: "healthy",
					}),
				]);
			});
		} finally {
			await daemon.stop();
			await closeServer(healthServer);
			if (previousPassword === undefined) {
				delete process.env["OPENCODE_SERVER_PASSWORD"];
			} else {
				process.env["OPENCODE_SERVER_PASSWORD"] = previousPassword;
			}
			if (previousUsername === undefined) {
				delete process.env["OPENCODE_SERVER_USERNAME"];
			} else {
				process.env["OPENCODE_SERVER_USERNAME"] = previousUsername;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serves instance lifecycle commands through the foreground IPC socket", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-foreground-ipc-"));
		const configDir = join(root, "config");
		const staticDir = join(root, "static");
		const socketPath = join(root, "relay.sock");
		mkdirSync(staticDir);
		writeFileSync(join(staticDir, "index.html"), "<html>ok</html>", {
			flag: "w",
		});

		const daemon = await startForegroundDaemon({
			port: 0,
			configDir,
			socketPath,
			pidPath: join(root, "daemon.pid"),
			staticDir,
			tlsEnabled: false,
			smartDefault: false,
			logLevel: "error",
			logFormat: "json",
		});

		try {
			const addResult = await sendIPCCommand(socketPath, {
				cmd: "instance_add",
				name: "Alt Provider",
				port: 4555,
				managed: false,
				url: "http://127.0.0.1:4555",
			});
			expect(addResult.ok).toBe(true);
			const added = (addResult as { instance: OpenCodeInstance }).instance;
			expect(added).toMatchObject({
				id: "alt-provider",
				name: "Alt Provider",
				port: 4555,
				managed: false,
				status: "starting",
			});

			const updateResult = await sendIPCCommand(socketPath, {
				cmd: "instance_update",
				id: added.id,
				name: "Renamed Provider",
				port: 4556,
			});
			expect(updateResult.ok).toBe(true);
			expect(
				(updateResult as { instance: OpenCodeInstance }).instance,
			).toMatchObject({
				id: added.id,
				name: "Renamed Provider",
				port: 4556,
			});

			const stopResult = await sendIPCCommand(socketPath, {
				cmd: "instance_stop",
				id: added.id,
			});
			expect(stopResult.ok).toBe(true);

			const statusResult = await sendIPCCommand(socketPath, {
				cmd: "instance_status",
				id: added.id,
			});
			expect(statusResult.ok).toBe(true);
			expect(
				(statusResult as { instance: OpenCodeInstance }).instance,
			).toMatchObject({
				id: added.id,
				status: "stopped",
			});

			const listResult = await sendIPCCommand(socketPath, {
				cmd: "instance_list",
			});
			expect(listResult.ok).toBe(true);
			expect(
				(listResult as { instances: ReadonlyArray<OpenCodeInstance> })
					.instances,
			).toEqual([
				expect.objectContaining({
					id: added.id,
					name: "Renamed Provider",
					status: "stopped",
				}),
			]);

			const removeResult = await sendIPCCommand(socketPath, {
				cmd: "instance_remove",
				id: added.id,
			});
			expect(removeResult.ok).toBe(true);
			expect(daemon.getInstances()).toEqual([]);
		} finally {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
