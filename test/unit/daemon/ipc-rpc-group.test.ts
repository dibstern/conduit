import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { type Rpc, RpcClient, type RpcGroup, RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Either, Exit, Layer, Ref, Schema } from "effect";
import type { Scope } from "effect/Scope";
import { expect } from "vitest";
import {
	AddProject,
	commandToTaggedRequestPayload,
	decodeTaggedIpcCommand,
	IpcError,
	IpcTaggedRequestSchema,
} from "../../../src/lib/contracts/ipc-requests.js";
import { ShutdownSignalTag } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { KeepAwakeTag } from "../../../src/lib/domain/daemon/Layers/keep-awake-layer.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { PersistencePathTag } from "../../../src/lib/domain/daemon/Services/daemon-config-persistence.js";
import type { DaemonRuntimeConfig } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import type { IpcHandlerDeps } from "../../../src/lib/domain/daemon/Services/ipc-dispatch.js";
import {
	IpcHandlersLayer,
	IpcRpcGroup,
} from "../../../src/lib/domain/daemon/Services/ipc-rpc-group.js";
import {
	InstanceMgmtTag,
	ProjectMgmtTag,
} from "../../../src/lib/domain/daemon/Services/management-service.js";

import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";

const makeTestFileSystem = () => {
	const files = new Map<string, string>();

	const fs = FileSystem.makeNoop({
		readFileString: (path: string) =>
			Effect.gen(function* () {
				const content = files.get(path);
				if (content === undefined) {
					return yield* Effect.fail(
						new SystemError({
							reason: "NotFound",
							module: "FileSystem",
							method: "readFileString",
							description: `File not found: ${path}`,
							pathOrDescriptor: path,
						}),
					);
				}
				return content;
			}),
		writeFileString: (path: string, data: string) =>
			Effect.sync(() => {
				files.set(path, data);
			}),
		rename: (oldPath: string, newPath: string) =>
			Effect.sync(() => {
				const content = files.get(oldPath);
				if (content !== undefined) {
					files.set(newPath, content);
					files.delete(oldPath);
				}
			}),
		makeDirectory: () => Effect.void,
	});

	return Layer.succeed(FileSystem.FileSystem, fs);
};

const makeMockInstanceMgmt = (overrides?: Partial<InstanceManagementDeps>) =>
	Layer.succeed(InstanceMgmtTag, {
		getInstances: () => [
			{
				id: "inst-1",
				name: "Dev",
				port: 4096,
				managed: true,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: Date.now(),
			},
		],
		addInstance: (id, config) => ({
			id,
			...config,
			status: "stopped" as const,
			restartCount: 0,
			createdAt: Date.now(),
		}),
		removeInstance: () => {},
		startInstance: () => Promise.resolve(),
		stopInstance: () => {},
		updateInstance: (id, updates) => ({
			id,
			name: updates.name ?? "Updated",
			port: updates.port ?? 4096,
			managed: true,
			status: "healthy" as const,
			restartCount: 0,
			createdAt: Date.now(),
		}),
		persistConfig: () => {},
		...overrides,
	});

const makeMockKeepAwake = () =>
	Layer.effect(
		KeepAwakeTag,
		Effect.gen(function* () {
			const activeRef = yield* Ref.make(false);
			return {
				activate: () => Ref.set(activeRef, true),
				deactivate: () => Ref.set(activeRef, false),
				isActive: () => Ref.get(activeRef),
				isSupported: () => Effect.succeed(true),
			};
		}),
	);

const makeMockConfigRef = () => {
	const initial: DaemonRuntimeConfig = {
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
	return Layer.effect(DaemonConfigRefTag, Ref.make(initial));
};

const makeMockShutdownSignal = () =>
	Layer.effect(ShutdownSignalTag, Deferred.make<void>());

const makeTestLayer = () =>
	Layer.mergeAll(
		makeTestFileSystem(),
		Layer.succeed(PersistencePathTag, "/test-config/daemon.json"),
		makeDaemonStateLive({ projects: [] }),
		Layer.succeed(ProjectMgmtTag, {
			getProjects: () => [],
			setProjectInstance: () => {},
		}),
		makeMockInstanceMgmt(),
		makeOverridesStateLive(),
		makeMockKeepAwake(),
		makeMockConfigRef(),
		makeMockShutdownSignal(),
		Layer.succeed(ConfigPersistenceTag, {
			requestSave: Effect.void,
			flush: Effect.void,
		}),
	);

type RpcTestEnv =
	| Scope
	| IpcHandlerDeps
	| Rpc.ToHandler<RpcGroup.Rpcs<typeof IpcRpcGroup>>;

const provideRpc = <A, E>(effect: Effect.Effect<A, E, RpcTestEnv>) =>
	Effect.scoped(effect).pipe(
		Effect.provide(Layer.provideMerge(IpcHandlersLayer, makeTestLayer())),
	);

describe("IPC RPC request group", () => {
	it("uses installed @effect/rpc group/client APIs", () => {
		expect(IpcRpcGroup.requests.has("AddProject")).toBe(true);
		expect(typeof IpcRpcGroup.toLayer).toBe("function");
		expect(typeof RpcClient.make).toBe("function");
	});

	it.effect("handles AddProject through real RpcTest client and handlers", () =>
		provideRpc(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const result = yield* client.AddProject({
					directory: "/tmp/project",
				});

				expect(result).toEqual({
					ok: true,
					slug: "project",
					directory: "/tmp/project",
				});

				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.projects).toHaveLength(1);
				expect(state.projects[0]?.path).toBe("/tmp/project");
			}),
		),
	);

	it.effect("fails duplicate AddProject through request failure schema", () =>
		provideRpc(
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (state) => ({
					...state,
					projects: [
						{
							path: "/tmp/project",
							slug: "project",
							addedAt: Date.now(),
						},
					],
				}));

				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const exit = yield* Effect.exit(
					client.AddProject({ directory: "/tmp/project" }),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const cause = exit.cause.toJSON() as { failures?: unknown[] };
					expect(JSON.stringify(cause)).toContain("IpcError");
					expect(JSON.stringify(cause)).toContain("Project already exists");
				}
			}),
		),
	);

	it.effect(
		"handles InstanceList through real RpcTest client and handlers",
		() =>
			provideRpc(
				Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(IpcRpcGroup);
					const result = yield* client.InstanceList({});

					expect(result.ok).toBe(true);
					expect(result.instances).toHaveLength(1);
				}),
			),
	);

	it.effect("returns full GetStatus data through the RPC client", () =>
		provideRpc(
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				yield* Ref.update(ref, (state) => ({
					...state,
					host: "0.0.0.0",
					tls: true,
					pinHash: "hashed",
					keepAwake: true,
					projects: [
						{
							path: "/tmp/project",
							slug: "project",
							title: "Project",
							addedAt: Date.now(),
							sessionCount: 3,
						},
					],
				}));

				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const result = yield* client.GetStatus({});

				expect(result.tlsEnabled).toBe(true);
				expect(result.pinEnabled).toBe(true);
				expect(result.keepAwake).toBe(true);
				expect(result.sessionCount).toBe(3);
				expect(result.host).toBe("0.0.0.0");
				expect(result.projects).toEqual([
					{
						slug: "project",
						directory: "/tmp/project",
						title: "Project",
					},
				]);
			}),
		),
	);

	it.effect("returns supported/active from SetKeepAwake RPC", () =>
		provideRpc(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const result = yield* client.SetKeepAwake({ enabled: true });

				expect(result).toEqual({ ok: true, supported: true, active: true });
			}),
		),
	);

	it.effect("preserves RestartWithConfig overrides through RPC handlers", () =>
		provideRpc(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const result = yield* client.RestartWithConfig({
					config: { tls: true, port: 2634 },
				});

				expect(result).toEqual({ ok: true });

				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.shuttingDown).toBe(true);
				expect(state.tls).toBe(true);
				expect(state.port).toBe(2634);

				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.shuttingDown).toBe(true);
				expect(config.tlsEnabled).toBe(true);
				expect(config.port).toBe(2634);
			}),
		),
	);

	it.effect("decodes _tag AddProject requests to legacy command shape", () =>
		Effect.gen(function* () {
			const command = yield* decodeTaggedIpcCommand({
				_tag: "AddProject",
				directory: "/tmp/project",
			});

			expect(command).toEqual({
				cmd: "add_project",
				directory: "/tmp/project",
			});
		}),
	);

	it("rejects invalid _tag InstanceAdd payloads at the RPC request boundary", () => {
		const invalidRequests = [
			{ _tag: "InstanceAdd", name: "Managed Missing Port", managed: true },
			{
				_tag: "InstanceAdd",
				name: "Managed With Url",
				managed: true,
				port: 4096,
				url: "http://localhost:4096",
			},
			{ _tag: "InstanceAdd", name: "Unmanaged Missing Target", managed: false },
			{
				_tag: "InstanceAdd",
				name: "Bad Url",
				managed: false,
				url: "not-a-url",
			},
		];

		for (const request of invalidRequests) {
			const result = Schema.decodeUnknownEither(IpcTaggedRequestSchema)(
				request,
			);
			expect(Either.isLeft(result)).toBe(true);
		}
	});

	it("encodes legacy add_project commands to _tag request payloads", () => {
		const payload = commandToTaggedRequestPayload({
			cmd: "add_project",
			directory: "/tmp/project",
		});

		expect(payload).toEqual({
			_tag: "AddProject",
			directory: "/tmp/project",
		});
	});

	it.effect("preserves restart config in both IPC conversion directions", () =>
		Effect.gen(function* () {
			const payload = commandToTaggedRequestPayload({
				cmd: "restart_with_config",
				config: { tls: true, port: 2634 },
			});

			expect(payload).toEqual({
				_tag: "RestartWithConfig",
				config: { tls: true, port: 2634 },
			});

			const command = yield* decodeTaggedIpcCommand({
				_tag: "RestartWithConfig",
				config: { tls: true, port: 2634 },
			});

			expect(command).toEqual({
				cmd: "restart_with_config",
				config: { tls: true, port: 2634 },
			});
		}),
	);

	it("constructs concrete TaggedRequest instances", () => {
		expect(new AddProject({ directory: "/tmp/project" })._tag).toBe(
			"AddProject",
		);
		expect(new IpcError({ message: "boom" })._tag).toBe("IpcError");
	});
});
