import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { InstanceManagementServiceTag } from "../../domain/relay/Services/instance-management-service.js";
import { ScanServiceTag } from "../../domain/relay/Services/scan-service.js";
import { WebSocketHandlerTag } from "../../domain/relay/Services/services.js";
import type { OpenCodeInstance } from "../../shared-types.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

const CCS_DEFAULT_PORT = 8317;

const instanceServiceOrFail = (operation: string) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			return yield* Effect.fail(
				new WsRpcError({
					message: `${operation} failed: Instance management not available`,
				}),
			);
		}
		return serviceOption.value;
	});

const broadcastInstanceList = (instances: ReadonlyArray<OpenCodeInstance>) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.broadcast({ type: "instance_list", instances });
	});

export const instancesHandlers = {
	StartInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("StartInstance");
			const instances = yield* instanceService.start(request.instanceId);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("StartInstance"))),
	StopInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("StopInstance");
			const instances = yield* instanceService.stop(request.instanceId);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("StopInstance"))),
	RemoveInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("RemoveInstance");
			const instances = yield* instanceService.remove(request.instanceId);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("RemoveInstance"))),
	RenameInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("RenameInstance");
			const name = request.name.trim();
			if (!name) {
				return yield* Effect.fail(
					new WsRpcError({
						message: "RenameInstance failed: name is required",
					}),
				);
			}
			const instances = yield* instanceService.rename(request.instanceId, name);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("RenameInstance"))),
	AddInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("AddInstance");
			const name = request.name.trim();
			if (!name) {
				return yield* Effect.fail(
					new WsRpcError({ message: "AddInstance failed: name is required" }),
				);
			}
			const instances = yield* instanceService.add({
				name,
				...(request.driver !== undefined && { driver: request.driver }),
				...(request.managed !== undefined && { managed: request.managed }),
				...(request.port !== undefined && { port: request.port }),
				...(request.url !== undefined && { url: request.url }),
				...(request.env !== undefined && { env: { ...request.env } }),
				...(request.configDir !== undefined && {
					configDir: request.configDir,
				}),
			});
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("AddInstance"))),
	UpdateInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("UpdateInstance");
			const instances = yield* instanceService.update(request.instanceId, {
				...(request.name !== undefined && { name: request.name }),
				...(request.port !== undefined && { port: request.port }),
				...(request.env !== undefined && { env: { ...request.env } }),
				...(request.configDir !== undefined && {
					configDir: request.configDir,
				}),
			});
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("UpdateInstance"))),
	ScanNow: (request) =>
		Effect.gen(function* () {
			const scanService = yield* ScanServiceTag;
			const result = yield* scanService.scanNow();
			return {
				projectSlug: request.projectSlug,
				discovered: result.discovered,
				lost: result.lost,
				active: result.active,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("ScanNow"))),
	DetectProxy: (request) =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${CCS_DEFAULT_PORT}/health`, {
						signal: AbortSignal.timeout(3_000),
					}),
				),
			);
			return {
				projectSlug: request.projectSlug,
				found: result._tag === "Right" && result.right.ok,
				port: CCS_DEFAULT_PORT,
			};
		}),
} satisfies Pick<
	WsRpcHandlerMap,
	| "StartInstance"
	| "StopInstance"
	| "RemoveInstance"
	| "RenameInstance"
	| "AddInstance"
	| "UpdateInstance"
	| "ScanNow"
	| "DetectProxy"
>;
