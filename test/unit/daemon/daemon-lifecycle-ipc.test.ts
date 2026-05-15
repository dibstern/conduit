import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime, Option, Ref } from "effect";
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

import type { IpcTaggedRequest } from "../../../src/lib/contracts/ipc-requests.js";
import {
	closeIPCServer,
	type DaemonLifecycleContext,
	dispatchTaggedRequestEffect,
	type IpcPostResponseActions,
	startIPCServer,
	type TaggedIpcDispatcher,
} from "../../../src/lib/daemon/daemon-lifecycle.js";
import type { DaemonStatus } from "../../../src/lib/daemon/daemon-types.js";
import { parseCommand } from "../../../src/lib/daemon/ipc-protocol.js";
import { ShutdownSignalTag } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { KeepAwakeTag } from "../../../src/lib/domain/daemon/Layers/keep-awake-layer.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonHandleTag } from "../../../src/lib/domain/daemon/Services/daemon-handle.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { IpcHandlersLayer } from "../../../src/lib/domain/daemon/Services/ipc-rpc-group.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import type { IPCResponse } from "../../../src/lib/types.js";

const makeContext = (socketPath: string): DaemonLifecycleContext => ({
	httpServer: null,
	onboardingServer: null,
	upgradeServer: null,
	ipcServer: null,
	ipcClients: new Set(),
	clientCount: 0,
	socketPath,
	router: null,
});

const startTestIPCServer = (
	ctx: DaemonLifecycleContext,
	dispatchTaggedRequest: TaggedIpcDispatcher,
	postResponseActions?: IpcPostResponseActions,
) => startIPCServer(ctx, dispatchTaggedRequest, postResponseActions);

const makeNativeIpcDispatcher = () => {
	const initialConfig: import("../../../src/lib/domain/daemon/Services/daemon-config-ref.js").DaemonRuntimeConfig =
		{
			port: 2633,
			host: "127.0.0.1",
			pinHash: null,
			tlsEnabled: false,
			keepAwake: false,
			keepAwakeCommand: undefined,
			keepAwakeArgs: undefined,
			shuttingDown: false,
			dismissedPaths: new Set<string>(),
			startTime: Date.now(),
			hostExplicit: false,
			persistedSessionCounts: new Map<string, number>(),
		};
	const nativeDeps = Layer.mergeAll(
		makeDaemonStateLive(),
		Layer.effect(DaemonConfigRefTag, Ref.make(initialConfig)),
		Layer.succeed(DaemonHandleTag, {
			port: Effect.succeed(2633),
			onboardingPort: Effect.succeed(null),
			addProject: (directory: string) =>
				Effect.succeed({
					slug: "project",
					directory,
					title: "Project",
				}),
			discoverProjects: () => Effect.succeed(0),
			removeProject: () => Effect.void,
			getStatus: () => Effect.succeed(makeStatus()),
			getProjects: () => Effect.succeed([]),
			getInstances: () => Effect.succeed([]),
		}),
		DaemonEventBusLive,
		makeProjectRegistryLive(),
		makeInstanceManagerStateLive(),
		Layer.succeed(RelayCacheTag, {
			get: () => Effect.fail(new Error("Relay cache not expected in test")),
			peek: () => Effect.succeed(Option.none()),
			invalidate: () => Effect.void,
		}),
		Layer.effect(
			KeepAwakeTag,
			Effect.gen(function* () {
				const active = yield* Ref.make(false);
				return {
					activate: () => Ref.set(active, true),
					deactivate: () => Ref.set(active, false),
					isActive: () => Ref.get(active),
					isSupported: () => Effect.succeed(true),
				};
			}),
		),
		Layer.succeed(ConfigPersistenceTag, {
			requestSave: Effect.void,
			flush: Effect.void,
		}),
		Layer.effect(ShutdownSignalTag, Deferred.make<void>()),
	);
	const runtime = ManagedRuntime.make(
		Layer.provideMerge(IpcHandlersLayer, nativeDeps),
	);
	return {
		dispatch: ((request) =>
			runtime.runPromise(
				dispatchTaggedRequestEffect(request),
			)) satisfies TaggedIpcDispatcher,
		readConfig: () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const ref = yield* DaemonConfigRefTag;
					return yield* Ref.get(ref);
				}),
			),
		dispose: () => runtime.dispose(),
	};
};

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
		const dispatchTaggedRequest = vi.fn(
			async (request: IpcTaggedRequest): Promise<IPCResponse> => {
				expect(request._tag).toBe("AddProject");
				return {
					ok: true,
					slug: "rpc-project",
					directory:
						request._tag === "AddProject" ? request.directory : "unexpected",
				};
			},
		);

		try {
			await startTestIPCServer(ctx, dispatchTaggedRequest);

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
			expect(dispatchTaggedRequest).toHaveBeenCalledTimes(1);
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("routes tagged SetModel through the project override port", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const setProjectModelCalls: Array<
			[string, { readonly providerID: string; readonly modelID: string }]
		> = [];
		const dispatchTaggedRequest = async (
			request: IpcTaggedRequest,
		): Promise<IPCResponse> => {
			if (request._tag !== "SetModel") {
				return { ok: false, error: `Unexpected request: ${request._tag}` };
			}
			setProjectModelCalls.push([
				request.slug,
				{
					providerID: request.provider,
					modelID: request.model,
				},
			]);
			return { ok: true };
		};

		try {
			await startTestIPCServer(ctx, dispatchTaggedRequest);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "SetModel",
				slug: "project-a",
				provider: "anthropic",
				model: "claude-opus-4-1",
			});

			expect(response).toEqual({ ok: true });
			expect(setProjectModelCalls).toEqual([
				[
					"project-a",
					{
						providerID: "anthropic",
						modelID: "claude-opus-4-1",
					},
				],
			]);
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("routes tagged SetKeepAwake through the native Effect handler", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const native = makeNativeIpcDispatcher();

		try {
			await startTestIPCServer(ctx, native.dispatch);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "SetKeepAwake",
				enabled: true,
			});

			expect(response).toEqual({
				ok: true,
				supported: true,
				active: true,
			});
		} finally {
			await closeIPCServer(ctx);
			await native.dispose();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("routes tagged SetPin through the native Effect handler", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const native = makeNativeIpcDispatcher();

		try {
			await startTestIPCServer(ctx, native.dispatch);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "SetPin",
				pin: "1234",
			});

			expect(response).toEqual({ ok: true });
			const config = await native.readConfig();
			expect(config.pinHash).toEqual(expect.any(String));
			expect(config.pinHash).not.toBe("1234");
		} finally {
			await closeIPCServer(ctx);
			await native.dispose();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("routes tagged Shutdown through the native Effect handler", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const native = makeNativeIpcDispatcher();
		const scheduleShutdown = vi.fn();

		try {
			await startTestIPCServer(ctx, native.dispatch, { scheduleShutdown });
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "Shutdown",
			});

			expect(response).toEqual({ ok: true });
			const config = await native.readConfig();
			expect(config.shuttingDown).toBe(true);
			expect(scheduleShutdown).toHaveBeenCalled();
		} finally {
			await closeIPCServer(ctx);
			await native.dispose();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("routes legacy set_agent through the project override port", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const setProjectAgentCalls: Array<[string, string]> = [];
		warnSpy.mockClear();
		const dispatchTaggedRequest = async (
			request: IpcTaggedRequest,
		): Promise<IPCResponse> => {
			if (request._tag !== "SetAgent") {
				return { ok: false, error: `Unexpected request: ${request._tag}` };
			}
			setProjectAgentCalls.push([request.slug, request.agent]);
			return { ok: true };
		};

		try {
			await startTestIPCServer(ctx, dispatchTaggedRequest);
			const response = await sendJsonLine(ctx.socketPath, {
				cmd: "set_agent",
				slug: "project-a",
				agent: "plan",
			});

			expect(response).toEqual({ ok: true });
			expect(setProjectAgentCalls).toEqual([["project-a", "plan"]]);
			expect(warnSpy).toHaveBeenCalledWith(
				"DEPRECATED: cmd-format IPC will be removed in the next release. Update your CLI.",
			);
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("keeps legacy cmd fallback with deprecation warning", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		warnSpy.mockClear();
		const dispatchTaggedRequest = async (
			request: IpcTaggedRequest,
		): Promise<IPCResponse> => {
			if (request._tag !== "AddProject") {
				return { ok: false, error: `Unexpected request: ${request._tag}` };
			}
			return {
				ok: true,
				slug: "legacy-project",
				directory: request.directory,
			};
		};

		try {
			await startTestIPCServer(ctx, dispatchTaggedRequest);
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
		const native = makeNativeIpcDispatcher();
		const scheduleShutdown = vi.fn();

		try {
			await startTestIPCServer(ctx, native.dispatch, { scheduleShutdown });
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "RestartWithConfig",
				config: { tls: true, port: 2634 },
			});

			expect(response).toEqual({ ok: true });
			const config = await native.readConfig();
			expect(config.tlsEnabled).toBe(true);
			expect(config.port).toBe(2634);
			expect(config.shuttingDown).toBe(true);
			expect(scheduleShutdown).toHaveBeenCalled();
		} finally {
			await closeIPCServer(ctx);
			await native.dispose();
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("returns full GetStatus data through daemon RPC dispatch", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "conduit-daemon-ipc-"));
		const ctx = makeContext(join(tmp, "daemon.sock"));
		const dispatchTaggedRequest = async (
			request: IpcTaggedRequest,
		): Promise<IPCResponse> => {
			if (request._tag !== "GetStatus") {
				return { ok: false, error: `Unexpected request: ${request._tag}` };
			}
			const status = makeStatus({
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
			});
			return {
				ok: status.ok,
				uptime: status.uptime,
				port: status.port,
				host: status.host,
				projectCount: status.projectCount,
				sessionCount: status.sessionCount,
				clientCount: status.clientCount,
				pinEnabled: status.pinEnabled,
				tlsEnabled: status.tlsEnabled,
				keepAwake: status.keepAwake,
				projects: status.projects,
			};
		};

		try {
			await startTestIPCServer(ctx, dispatchTaggedRequest);
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
		const dispatchTaggedRequest = vi.fn(
			async (): Promise<IPCResponse> => ({ ok: true }),
		);

		try {
			await startTestIPCServer(ctx, dispatchTaggedRequest);
			const response = await sendJsonLine(ctx.socketPath, {
				_tag: "InstanceAdd",
				name: "Managed Missing Port",
				managed: true,
			});

			expect(response["ok"]).toBe(false);
			expect(String(response["error"])).toContain("InstanceAdd requires");
			expect(dispatchTaggedRequest).not.toHaveBeenCalled();
		} finally {
			await closeIPCServer(ctx);
			await rm(tmp, { recursive: true, force: true });
		}
	});
});
