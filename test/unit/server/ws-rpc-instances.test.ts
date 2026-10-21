import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addInstance,
	getInstances,
	makeInstanceManagerStateLive,
	persistConfig,
	updateInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	InstanceManagementServiceError,
	InstanceManagementServiceTag,
} from "../../../src/lib/domain/relay/Services/instance-management-service.js";
import { ScanServiceTag } from "../../../src/lib/domain/relay/Services/scan-service.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";
import {
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

const instance: OpenCodeInstance = {
	id: "inst-1",
	name: "Default",
	port: 4096,
	managed: true,
	status: "healthy",
	restartCount: 0,
	createdAt: 1,
};

const makeInstanceMgmt = (
	overrides: Partial<InstanceManagementDeps> = {},
): InstanceManagementDeps => ({
	getInstances: vi.fn(() => [instance]),
	addInstance: vi.fn(() => instance),
	removeInstance: vi.fn(),
	startInstance: vi.fn(async () => undefined),
	stopInstance: vi.fn(),
	updateInstance: vi.fn(() => instance),
	persistConfig: vi.fn(),
	...overrides,
});

const metadataLayer = () => {
	const flushConfig = vi.fn();
	const state = Layer.mergeAll(
		makeInstanceManagerStateLive(
			undefined,
			[{ ...instance, driver: "claude", configDir: "/profiles/original" }],
			{
				launchLogin: sdkDefaultClaudeConfigDir("/isolated-test-home/.claude"),
			},
		),
		DaemonEventBusLive,
		Layer.succeed(ConfigPersistenceTag)({
			requestSave: Effect.void,
			flush: Effect.sync(flushConfig),
		}),
	);
	const service = Layer.effect(
		InstanceManagementServiceTag,
		Effect.gen(function* () {
			const context = yield* Effect.context<Layer.Success<typeof state>>();
			const list = getInstances.pipe(Effect.provide(context));
			const update = (
				id: string,
				input: Parameters<typeof updateInstance>[1],
			) =>
				updateInstance(id, input).pipe(
					Effect.andThen(persistConfig),
					Effect.andThen(getInstances),
					Effect.provide(context),
					Effect.mapError(
						(cause) =>
							new InstanceManagementServiceError({
								operation: "update",
								cause,
							}),
					),
				);
			return {
				list: () => list,
				add: (input) =>
					addInstance(input).pipe(
						Effect.andThen(persistConfig),
						Effect.andThen(getInstances),
						Effect.provide(context),
						Effect.mapError(
							(cause) =>
								new InstanceManagementServiceError({ operation: "add", cause }),
						),
					),
				update,
				rename: (id, name) => update(id, { name }),
				start: () => Effect.die("Unexpected process start"),
				stop: () => Effect.die("Unexpected process stop"),
				remove: () => Effect.die("Unexpected removal"),
			};
		}),
	).pipe(Layer.provideMerge(state));
	return {
		flushConfig,
		layer: WsRpcServerLayer.pipe(
			Layer.provideMerge(Layer.merge(makeTestHandlerLayer(), service)),
		),
	};
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("WsRpcServerLayer instance management", () => {
	it.effect("starts an instance and returns the updated list", () => {
		const wsHandler = makeMockWebSocketHandler();
		const startInstance = vi.fn(async () => undefined);
		const instanceMgmt = makeInstanceMgmt({ startInstance });

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.StartInstance({
				projectSlug: "proj-1",
				instanceId: "inst-1",
			});

			expect(startInstance).toHaveBeenCalledWith("inst-1");
			expect(response).toEqual({
				projectSlug: "proj-1",
				instances: [instance],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ instanceMgmt, wsHandler })),
				),
				{ local: true },
			),
		);
	});

	it.effect("stops and removes instances through the instance service", () => {
		const wsHandler = makeMockWebSocketHandler();
		const stopInstance = vi.fn();
		const removeInstance = vi.fn();
		const instanceMgmt = makeInstanceMgmt({ stopInstance, removeInstance });

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			expect(
				yield* client.StopInstance({
					projectSlug: "proj-1",
					instanceId: "inst-1",
				}),
			).toEqual({ projectSlug: "proj-1", instances: [instance] });
			expect(stopInstance).toHaveBeenCalledWith("inst-1");

			expect(
				yield* client.RemoveInstance({
					projectSlug: "proj-1",
					instanceId: "inst-1",
				}),
			).toEqual({ projectSlug: "proj-1", instances: [instance] });
			expect(removeInstance).toHaveBeenCalledWith("inst-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ instanceMgmt, wsHandler })),
				),
				{ local: true },
			),
		);
	});

	it.effect("delegates the rename to the account directory", () => {
		const { layer, flushConfig } = metadataLayer();
		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const directory = yield* AccountDirectory;
			const response = yield* client.RenameInstance({
				projectSlug: "proj-1",
				instanceId: "inst-1",
				name: "  Primary  ",
			});
			expect(response.instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "inst-1", name: "Primary" }),
				]),
			);
			expect(
				(yield* directory.list).find((account) => account.id === "inst-1")
					?.name,
			).toBe("Primary");
			expect(flushConfig).toHaveBeenCalled();
		}).pipe(Effect.scoped, Effect.provide(layer, { local: true }));
	});

	it.effect("adds an unmanaged OpenCode instance with driver + url", () => {
		const { layer, flushConfig } = metadataLayer();
		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const directory = yield* AccountDirectory;
			const response = yield* client.AddInstance({
				projectSlug: "proj-1",
				name: "Staging OC",
				driver: "opencode",
				managed: false,
				url: "http://127.0.0.1:4099",
			});
			expect(response.instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "Staging OC",
						driver: "opencode",
						managed: false,
						url: "http://127.0.0.1:4099",
					}),
				]),
			);
			expect(
				(yield* directory.list).find(
					(account) => account.name === "Staging OC",
				),
			).toMatchObject({
				driver: "opencode",
				managed: false,
				url: "http://127.0.0.1:4099",
			});
			expect(flushConfig).toHaveBeenCalled();
		}).pipe(Effect.scoped, Effect.provide(layer, { local: true }));
	});

	it.effect("adds a Claude instance as a config-only record", () => {
		const { layer, flushConfig } = metadataLayer();
		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const directory = yield* AccountDirectory;
			const response = yield* client.AddInstance({
				projectSlug: "proj-1",
				name: "Work Claude",
				driver: "claude",
				managed: false,
				configDir: "/profiles/work",
			});
			const added = response.instances.find(
				(item) => item.name === "Work Claude",
			);
			expect(added).toMatchObject({
				driver: "claude",
				configDir: "/profiles/work",
				managed: false,
			});
			expect(added?.url).toBeUndefined();
			expect(
				(yield* directory.list).find(
					(account) => account.name === "Work Claude",
				),
			).toMatchObject({ driver: "claude", configuredFolder: "/profiles/work" });
			expect(flushConfig).toHaveBeenCalled();
		}).pipe(Effect.scoped, Effect.provide(layer, { local: true }));
	});

	it.effect("updates an instance name + configDir", () => {
		const { layer, flushConfig } = metadataLayer();
		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const directory = yield* AccountDirectory;
			const response = yield* client.UpdateInstance({
				projectSlug: "proj-1",
				instanceId: "inst-1",
				name: "Renamed",
				configDir: "/profiles/personal",
			});
			expect(response.instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "inst-1",
						name: "Renamed",
						configDir: "/profiles/personal",
					}),
				]),
			);
			expect(
				(yield* directory.list).find((account) => account.id === "inst-1"),
			).toMatchObject({
				name: "Renamed",
				configuredFolder: "/profiles/personal",
			});
			expect(flushConfig).toHaveBeenCalled();
		}).pipe(Effect.scoped, Effect.provide(layer, { local: true }));
	});

	it.effect("returns scan results through RPC", () => {
		const triggerScan = vi.fn(() =>
			Effect.succeed({
				discovered: [4097],
				lost: [4095],
				active: [4096, 4097],
			}),
		);

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.ScanNow({ projectSlug: "proj-1" });

			expect(triggerScan).toHaveBeenCalled();
			expect(response).toEqual({
				projectSlug: "proj-1",
				discovered: [4097],
				lost: [4095],
				active: [4096, 4097],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.merge(
							makeTestHandlerLayer(),
							Layer.succeed(ScanServiceTag)({ scanNow: triggerScan }),
						),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("detects a local proxy without using the legacy WS command", () => {
		const fetch = vi.fn(async () => ({ ok: true }));
		vi.stubGlobal("fetch", fetch);

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.DetectProxy({ projectSlug: "proj-1" });

			expect(fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:8317/health",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(response).toEqual({
				projectSlug: "proj-1",
				found: true,
				port: 8317,
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer())),
				{ local: true },
			),
		);
	});
});
