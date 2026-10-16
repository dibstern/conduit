import { Effect } from "effect";
import { AccountChangeRejected } from "../../contracts/account.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import {
	InstanceManagementServiceError,
	InstanceManagementServiceTag,
} from "../../domain/relay/Services/instance-management-service.js";
import { ScanServiceTag } from "../../domain/relay/Services/scan-service.js";
import { formatErrorDetail } from "../../errors.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

const CCS_DEFAULT_PORT = 8317;

const instanceServiceOrFail = (operation: string) =>
	Effect.gen(function* () {
		// Some test and compatibility contexts omit instance management entirely.
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

const accountMutationFailure =
	(id: string, operation: string) => (error: unknown) => {
		const cause =
			error instanceof InstanceManagementServiceError ? error.cause : error;
		return Effect.fail(
			cause instanceof AccountChangeRejected
				? cause
				: new AccountChangeRejected({
						id,
						reason:
							error instanceof InstanceManagementServiceError &&
							cause instanceof WsRpcError
								? `${operation} failed: ${cause.message}`
								: formatErrorDetail(cause),
					}),
		);
	};

// The service wraps daemon RPC errors; surface their message, not the wrapper.
const instanceFailure = (operation: string) => (error: unknown) =>
	mapRpcFailure(operation)(
		error instanceof InstanceManagementServiceError &&
			error.cause instanceof WsRpcError
			? new WsRpcError({
					message: `${operation} failed: ${error.cause.message}`,
				})
			: error,
	);

export const instancesHandlers = {
	StartInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("StartInstance");
			const instances = yield* instanceService.start(request.instanceId);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(instanceFailure("StartInstance"))),
	StopInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("StopInstance");
			const instances = yield* instanceService.stop(request.instanceId);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(instanceFailure("StopInstance"))),
	RemoveInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("RemoveInstance");
			const instances = yield* instanceService.remove(request.instanceId);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(
			Effect.catchAll(
				accountMutationFailure(request.instanceId, "RemoveInstance"),
			),
		),
	RenameInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("RenameInstance");
			const instances = yield* instanceService.rename(
				request.instanceId,
				request.name,
			);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(
			Effect.catchAll(
				accountMutationFailure(request.instanceId, "RenameInstance"),
			),
		),
	AddInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("AddInstance");
			const instances = yield* instanceService.add({
				name: request.name,
				...(request.driver !== undefined && { driver: request.driver }),
				...(request.managed !== undefined && { managed: request.managed }),
				...(request.port !== undefined && { port: request.port }),
				...(request.url !== undefined && { url: request.url }),
				...(request.env !== undefined && { env: { ...request.env } }),
				...(request.configDir !== undefined && {
					configDir: request.configDir,
				}),
			});
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(
			Effect.catchAll(accountMutationFailure(request.name, "AddInstance")),
		),
	UpdateInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("UpdateInstance");
			const instances = yield* instanceService.update(request.instanceId, {
				...(request.driver !== undefined && { driver: request.driver }),
				...(request.name !== undefined && { name: request.name }),
				...(request.port !== undefined && { port: request.port }),
				...(request.env !== undefined && { env: { ...request.env } }),
				...(request.configDir !== undefined && {
					configDir: request.configDir,
				}),
			});
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(
			Effect.catchAll(
				accountMutationFailure(request.instanceId, "UpdateInstance"),
			),
		),
	SetDefault: (request) =>
		Effect.fail(
			new AccountChangeRejected({
				id: request.instanceId,
				reason: "SetDefault requires daemon mode",
			}),
		),
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
	| "SetDefault"
	| "ScanNow"
	| "DetectProxy"
>;
