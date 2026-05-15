import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";
import {
	makeMockConfig,
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("WsRpcServerLayer instance management", () => {
	it.effect("starts an instance and broadcasts the updated list", () => {
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
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "instance_list",
				instances: [instance],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ instanceMgmt, wsHandler })),
				),
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
			expect(wsHandler.broadcast).toHaveBeenCalledTimes(2);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ instanceMgmt, wsHandler })),
				),
			),
		);
	});

	it.effect("renames an instance after trimming the display name", () => {
		const wsHandler = makeMockWebSocketHandler();
		const updateInstance = vi.fn(() => instance);
		const persistConfig = vi.fn();
		const instanceMgmt = makeInstanceMgmt({ updateInstance, persistConfig });

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.RenameInstance({
				projectSlug: "proj-1",
				instanceId: "inst-1",
				name: "  Primary  ",
			});

			expect(updateInstance).toHaveBeenCalledWith("inst-1", {
				name: "Primary",
			});
			expect(persistConfig).toHaveBeenCalled();
			expect(response.instances).toEqual([instance]);
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "instance_list",
				instances: [instance],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ instanceMgmt, wsHandler })),
				),
			),
		);
	});

	it.effect("returns scan results through RPC", () => {
		const triggerScan = vi.fn(async () => ({
			discovered: [4097],
			lost: [4095],
			active: [4096, 4097],
		}));
		const config = makeMockConfig({ triggerScan });

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
					Layer.provideMerge(makeTestHandlerLayer({ config })),
				),
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
			),
		);
	});
});
