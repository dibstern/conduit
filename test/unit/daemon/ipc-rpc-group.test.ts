import type { Socket } from "node:net";
import { RpcClient, RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Either,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
} from "effect";
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
import type { DaemonRuntimeConfig } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonHandleLive } from "../../../src/lib/domain/daemon/Services/daemon-handle.js";
import { DaemonLifecycleContextTag } from "../../../src/lib/domain/daemon/Services/daemon-lifecycle-context.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	IpcHandlersLayer,
	IpcRpcGroup,
} from "../../../src/lib/domain/daemon/Services/ipc-rpc-group.js";
import {
	makeProjectRegistryLive,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";

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

const makeBaseTestLayer = () =>
	Layer.mergeAll(
		makeDaemonStateLive({ projects: [] }),
		makeProjectRegistryLive(),
		DaemonEventBusLive,
		makeInstanceManagerStateLive(undefined, [
			{
				id: "inst-1",
				name: "Dev",
				port: 4096,
				managed: true,
			},
		]),
		Layer.succeed(RelayCacheTag, {
			get: () => Effect.fail(new Error("Relay cache not expected in test")),
			peek: () => Effect.succeed(Option.none()),
			invalidate: () => Effect.void,
		}),
		Layer.succeed(DaemonLifecycleContextTag, {
			httpServer: null,
			onboardingServer: null,
			upgradeServer: null,
			ipcServer: null,
			ipcClients: new Set<Socket>(),
			clientCount: 0,
			socketPath: "/tmp/conduit-test.sock",
			router: null,
		}),
		makeMockKeepAwake(),
		makeMockConfigRef(),
		makeMockShutdownSignal(),
		Layer.succeed(ConfigPersistenceTag, {
			requestSave: Effect.void,
			flush: Effect.void,
		}),
	);

const makeTestLayer = () => {
	const base = makeBaseTestLayer();
	return Layer.merge(base, DaemonHandleLive.pipe(Layer.provide(base)));
};

const makeRpcTestLayer = () => {
	const deps = makeTestLayer();
	return Layer.merge(deps, IpcHandlersLayer.pipe(Layer.provide(deps)));
};

const provideRpc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.scoped(effect).pipe(Effect.provide(makeRpcTestLayer()));

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

				const registryRef = yield* ProjectRegistryTag;
				const registry = yield* Ref.get(registryRef);
				expect(HashMap.size(registry)).toBe(1);
				const entry = HashMap.get(registry, "project");
				expect(Option.getOrUndefined(entry)?.project.directory).toBe(
					"/tmp/project",
				);
			}),
		),
	);

	it.effect("returns the existing project for duplicate AddProject", () =>
		provideRpc(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const first = yield* client.AddProject({ directory: "/tmp/project" });
				const second = yield* client.AddProject({ directory: "/tmp/project" });

				expect(second).toEqual(first);

				const registryRef = yield* ProjectRegistryTag;
				const registry = yield* Ref.get(registryRef);
				expect(HashMap.size(registry)).toBe(1);
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
				const configRef = yield* DaemonConfigRefTag;
				yield* Ref.update(configRef, (config) => ({
					...config,
					host: "0.0.0.0",
					tlsEnabled: true,
					pinHash: "hashed",
					keepAwake: true,
					persistedSessionCounts: new Map([["project", 3]]),
				}));
				const registryRef = yield* ProjectRegistryTag;
				const addedAt = Date.now();
				yield* Ref.update(registryRef, (registry) =>
					HashMap.set(registry, "project", {
						_tag: "Ready" as const,
						project: {
							slug: "project",
							directory: "/tmp/project",
							title: "Project",
							lastUsed: addedAt,
						},
					}),
				);

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
						status: "ready",
						lastUsed: addedAt,
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

	it.effect("updates native shutdown state through Shutdown RPC", () =>
		provideRpc(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(IpcRpcGroup);
				const result = yield* client.Shutdown({});

				expect(result).toEqual({ ok: true });

				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.shuttingDown).toBe(true);

				const configRef = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(configRef);
				expect(config.shuttingDown).toBe(true);
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
