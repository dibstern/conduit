import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/lib/logger.js")>();
	return {
		...actual,
		createLogger: () => ({
			debug: debugSpy,
			verbose: vi.fn(),
			info: vi.fn(),
			warn: warnSpy,
			error: vi.fn(),
			child: () => ({
				debug: debugSpy,
				verbose: vi.fn(),
				info: vi.fn(),
				warn: warnSpy,
				error: vi.fn(),
				child: vi.fn(),
			}),
		}),
	};
});

import type { DaemonIPCContext } from "../../../src/lib/daemon/daemon-ipc.js";
import {
	closeIPCServer,
	type DaemonLifecycleContext,
	startIPCServer,
} from "../../../src/lib/daemon/daemon-lifecycle.js";
import type { DaemonStatus } from "../../../src/lib/daemon/daemon-types.js";
import { parseCommand } from "../../../src/lib/daemon/ipc-protocol.js";
import type {
	InstanceConfig,
	OpenCodeInstance,
	StoredProject,
} from "../../../src/lib/types.js";

const makeContext = (socketPath: string): DaemonLifecycleContext => ({
	port: 0,
	host: "127.0.0.1",
	httpServer: null,
	onboardingServer: null,
	upgradeServer: null,
	ipcServer: null,
	ipcClients: new Set(),
	clientCount: 0,
	socketPath,
	router: null,
});

const makeStatus = (overrides: Partial<DaemonStatus> = {}): DaemonStatus => ({
	ok: true,
	uptime: 1,
	port: 2633,
	host: "127.0.0.1",
	projectCount: 0,
	sessionCount: 0,
	clientCount: 0,
	pinEnabled: false,
	tlsEnabled: false,
	keepAwake: false,
	projects: [],
	...overrides,
});

const makeInstance = (
	id: string,
	config: InstanceConfig,
): OpenCodeInstance => ({
	id,
	name: config.name,
	port: config.port,
	managed: config.managed,
	...(config.env !== undefined ? { env: config.env } : {}),
	...(config.url !== undefined ? { url: config.url } : {}),
	status: "stopped",
	restartCount: 0,
	createdAt: Date.now(),
});

const sendJsonLine = (
	socketPath: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
	new Promise((resolve, reject) => {
		const client = createConnection(socketPath);
		let buffer = "";

		client.on("connect", () => {
			client.write(`${JSON.stringify(payload)}\n`);
		});
		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			if (!buffer.includes("\n")) return;

			const line = buffer.slice(0, buffer.indexOf("\n"));
			client.end();
			try {
				resolve(JSON.parse(line) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
		client.on("error", reject);
	});

describe("daemon IPC lifecycle RPC transition", () => {
	it("routes _tag IPC through daemon RPC handlers instead of parseCommand", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const projects: StoredProject[] = [];
		const instances = new Map<string, OpenCodeInstance>();

		const ipcContext: DaemonIPCContext = {
			addProject: async (directory) => {
				const project = {
					slug: "rpc-project",
					directory,
					title: "RPC Project",
				};
				projects.push(project);
				return project;
			},
			removeProject: async (slug) => {
				const index = projects.findIndex((project) => project.slug === slug);
				if (index >= 0) projects.splice(index, 1);
			},
			getProjects: () => projects,
			setProjectTitle: (slug, title) => {
				const project = projects.find((entry) => entry.slug === slug);
				if (project) {
					projects.splice(projects.indexOf(project), 1, {
						...project,
						title,
					});
				}
			},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: true, active: false }),
			setKeepAwakeCommand: () => {},
			persistConfig: () => {},
			scheduleShutdown: () => {},
			getInstances: () => Array.from(instances.values()),
			getInstance: (id) => instances.get(id),
			addInstance: (id, config) => {
				const instance = makeInstance(id, config);
				instances.set(id, instance);
				return instance;
			},
			removeInstance: (id) => {
				instances.delete(id);
			},
			startInstance: async () => {},
			stopInstance: () => {},
			updateInstance: (id, updates) => {
				const current =
					instances.get(id) ??
					makeInstance(id, { name: id, port: 0, managed: true });
				const updated = { ...current, ...updates };
				instances.set(id, updated);
				return updated;
			},
		};

		try {
			await startIPCServer(ctx, ipcContext, makeStatus);

			expect(
				parseCommand('{"_tag":"AddProject","directory":"/tmp/rpc"}'),
			).toBeNull();

			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "AddProject",
				directory: "/tmp/rpc",
			});

			expect(response).toEqual({
				ok: true,
				slug: "rpc-project",
				directory: "/tmp/rpc",
			});
			expect(projects).toHaveLength(1);
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("keeps legacy cmd fallback with deprecation warning", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		warnSpy.mockClear();

		const ipcContext: DaemonIPCContext = {
			addProject: async (directory) => ({
				slug: "legacy-project",
				directory,
				title: "Legacy Project",
			}),
			removeProject: async () => {},
			getProjects: () => [],
			setProjectTitle: () => {},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: true, active: false }),
			setKeepAwakeCommand: () => {},
			persistConfig: () => {},
			scheduleShutdown: () => {},
			getInstances: () => [],
			getInstance: () => undefined,
			addInstance: (id, config) => makeInstance(id, config),
			removeInstance: () => {},
			startInstance: async () => {},
			stopInstance: () => {},
			updateInstance: (id, updates) =>
				makeInstance(id, {
					name: updates.name ?? id,
					port: updates.port ?? 0,
					managed: true,
					...(updates.env !== undefined ? { env: updates.env } : {}),
				}),
		};

		try {
			await startIPCServer(ctx, ipcContext, makeStatus);
			const response = await sendJsonLine(ctx.socketPath, {
				cmd: "add_project",
				directory: "/tmp/legacy",
			});

			expect(response).toEqual({
				ok: true,
				slug: "legacy-project",
				directory: "/tmp/legacy",
			});
			expect(warnSpy).toHaveBeenCalledWith(
				"DEPRECATED: cmd-format IPC will be removed in the next release. Update your CLI.",
			);
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("passes RestartWithConfig overrides through daemon RPC dispatch", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const applyConfig = vi.fn();
		const persistConfig = vi.fn();
		const scheduleShutdown = vi.fn();

		const ipcContext: DaemonIPCContext = {
			addProject: async (directory) => ({
				slug: "project",
				directory,
				title: "Project",
			}),
			removeProject: async () => {},
			getProjects: () => [],
			setProjectTitle: () => {},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: true, active: false }),
			setKeepAwakeCommand: () => {},
			persistConfig,
			scheduleShutdown,
			applyConfig,
			getInstances: () => [],
			getInstance: () => undefined,
			addInstance: (id, config) => makeInstance(id, config),
			removeInstance: () => {},
			startInstance: async () => {},
			stopInstance: () => {},
			updateInstance: (id, updates) =>
				makeInstance(id, {
					name: updates.name ?? id,
					port: updates.port ?? 0,
					managed: true,
					...(updates.env !== undefined ? { env: updates.env } : {}),
				}),
		};

		try {
			await startIPCServer(ctx, ipcContext, makeStatus);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "RestartWithConfig",
				config: { tls: true, port: 2634 },
			});

			expect(response).toEqual({ ok: true });
			expect(applyConfig).toHaveBeenCalledWith({ tls: true, port: 2634 });
			expect(persistConfig).toHaveBeenCalled();
			expect(scheduleShutdown).toHaveBeenCalled();
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("returns full GetStatus data through daemon RPC dispatch", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));

		const ipcContext: DaemonIPCContext = {
			addProject: async (directory) => ({
				slug: "project",
				directory,
				title: "Project",
			}),
			removeProject: async () => {},
			getProjects: () => [],
			setProjectTitle: () => {},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: true, active: false }),
			setKeepAwakeCommand: () => {},
			persistConfig: () => {},
			scheduleShutdown: () => {},
			getInstances: () => [],
			getInstance: () => undefined,
			addInstance: (id, config) => makeInstance(id, config),
			removeInstance: () => {},
			startInstance: async () => {},
			stopInstance: () => {},
			updateInstance: (id, updates) =>
				makeInstance(id, {
					name: updates.name ?? id,
					port: updates.port ?? 0,
					managed: true,
					...(updates.env !== undefined ? { env: updates.env } : {}),
				}),
		};

		try {
			await startIPCServer(ctx, ipcContext, () =>
				makeStatus({
					tlsEnabled: true,
					pinEnabled: true,
					keepAwake: true,
					sessionCount: 4,
					projects: [
						{
							slug: "project",
							directory: "/tmp/project",
							title: "Project",
							status: "ready",
							lastUsed: 123,
						},
					],
				}),
			);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "GetStatus",
			});

			expect(response["tlsEnabled"]).toBe(true);
			expect(response["pinEnabled"]).toBe(true);
			expect(response["keepAwake"]).toBe(true);
			expect(response["sessionCount"]).toBe(4);
			expect(response["projects"]).toEqual([
				{
					slug: "project",
					directory: "/tmp/project",
					title: "Project",
					status: "ready",
					lastUsed: 123,
				},
			]);
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects invalid _tag InstanceAdd before handler dispatch", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const addInstance = vi.fn((id: string, config: InstanceConfig) =>
			makeInstance(id, config),
		);

		const ipcContext: DaemonIPCContext = {
			addProject: async (directory) => ({
				slug: "project",
				directory,
				title: "Project",
			}),
			removeProject: async () => {},
			getProjects: () => [],
			setProjectTitle: () => {},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: true, active: false }),
			setKeepAwakeCommand: () => {},
			persistConfig: () => {},
			scheduleShutdown: () => {},
			getInstances: () => [],
			getInstance: () => undefined,
			addInstance,
			removeInstance: () => {},
			startInstance: async () => {},
			stopInstance: () => {},
			updateInstance: (id, updates) =>
				makeInstance(id, {
					name: updates.name ?? id,
					port: updates.port ?? 0,
					managed: true,
					...(updates.env !== undefined ? { env: updates.env } : {}),
				}),
		};

		try {
			await startIPCServer(ctx, ipcContext, makeStatus);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "InstanceAdd",
				name: "Managed Missing Port",
				managed: true,
			});

			expect(response["ok"]).toBe(false);
			expect(String(response["error"])).toContain("InstanceAdd requires");
			expect(addInstance).not.toHaveBeenCalled();
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});
});
