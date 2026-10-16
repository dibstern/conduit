import { Context, Data, Effect, Layer } from "effect";
import type { AddAccountInput } from "../../../contracts/account.js";
import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
import { WsRpcError } from "../../../contracts/ws-rpc.js";
import type { OpenCodeInstance } from "../../../shared-types.js";

type InstanceOperation =
	| "list"
	| "add"
	| "remove"
	| "start"
	| "stop"
	| "update"
	| "rename";

export class InstanceManagementServiceError extends Data.TaggedError(
	"InstanceManagementServiceError",
)<{
	readonly operation: InstanceOperation;
	readonly cause: unknown;
}> {}

export type AddInstanceInput = AddAccountInput;

export interface UpdateInstanceInput {
	readonly name?: string | undefined;
	readonly env?: Record<string, string> | undefined;
	readonly port?: number | undefined;
	readonly driver?: ProviderDriverKind | undefined;
	readonly configDir?: string | undefined;
}

export interface InstanceManagementService {
	list(): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
	add(
		input: AddInstanceInput,
	): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
	remove(
		instanceId: string,
	): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
	start(
		instanceId: string,
	): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
	stop(
		instanceId: string,
	): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
	update(
		instanceId: string,
		input: UpdateInstanceInput,
	): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
	rename(
		instanceId: string,
		name: string,
	): Effect.Effect<
		ReadonlyArray<Readonly<OpenCodeInstance>>,
		InstanceManagementServiceError
	>;
}

export class InstanceManagementServiceTag extends Context.Tag(
	"InstanceManagementService",
)<InstanceManagementServiceTag, InstanceManagementService>() {}

export const InstanceManagementServiceLive: Layer.Layer<InstanceManagementServiceTag> =
	Layer.succeed(InstanceManagementServiceTag, {
		list: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "list",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
		add: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "add",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
		remove: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "remove",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
		start: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "start",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
		stop: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "stop",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
		update: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "update",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
		rename: () =>
			Effect.fail(
				new InstanceManagementServiceError({
					operation: "rename",
					cause: new WsRpcError({
						message: "Instance management not available",
					}),
				}),
			),
	});
