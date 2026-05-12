import { Context, Data, Effect, Layer } from "effect";
import type { InstanceConfig, OpenCodeInstance } from "../shared-types.js";
import { InstanceMgmtTag } from "./services.js";

type InstanceOperation =
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

export interface AddInstanceInput {
	readonly name: string;
	readonly url?: string | undefined;
	readonly port?: number | undefined;
	readonly managed?: boolean | undefined;
	readonly env?: Record<string, string> | undefined;
}

export interface UpdateInstanceInput {
	readonly name?: string | undefined;
	readonly env?: Record<string, string> | undefined;
	readonly port?: number | undefined;
}

export interface InstanceManagementService {
	list(): Effect.Effect<ReadonlyArray<Readonly<OpenCodeInstance>>>;
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

const makeInstanceId = (
	name: string,
	instances: ReadonlyArray<{ readonly id: string }>,
) => {
	const baseId =
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "instance";
	let id = baseId;
	let counter = 2;
	while (instances.some((instance) => instance.id === id)) {
		id = `${baseId}-${counter}`;
		counter++;
	}
	return id;
};

const toError =
	(operation: InstanceOperation) =>
	(cause: unknown): InstanceManagementServiceError =>
		new InstanceManagementServiceError({ operation, cause });

export const InstanceManagementServiceLive: Layer.Layer<
	InstanceManagementServiceTag,
	never,
	InstanceMgmtTag
> = Layer.effect(
	InstanceManagementServiceTag,
	Effect.gen(function* () {
		const instanceMgmt = yield* InstanceMgmtTag;

		const list = () => instanceMgmt.getInstances();

		const persist = (operation: InstanceOperation) =>
			Effect.try({
				try: () => instanceMgmt.persistConfig(),
				catch: toError(operation),
			});

		const withPersistedList = (operation: InstanceOperation) =>
			Effect.gen(function* () {
				yield* persist(operation);
				return list();
			});

		return {
			list: () => Effect.sync(list),
			add: (input) =>
				Effect.gen(function* () {
					yield* Effect.try({
						try: () => {
							const hasUrl =
								typeof input.url === "string" && input.url.length > 0;
							const managed =
								typeof input.managed === "boolean" ? input.managed : !hasUrl;
							const id = makeInstanceId(input.name, list());
							const config: InstanceConfig = {
								name: input.name,
								port: typeof input.port === "number" ? input.port : 0,
								managed,
								...(input.env != null && { env: input.env }),
								...(hasUrl && input.url != null && { url: input.url }),
							};
							instanceMgmt.addInstance(id, config);
						},
						catch: toError("add"),
					});
					return yield* withPersistedList("add");
				}),
			remove: (instanceId) =>
				Effect.gen(function* () {
					yield* Effect.try({
						try: () => instanceMgmt.removeInstance(instanceId),
						catch: toError("remove"),
					});
					return yield* withPersistedList("remove");
				}),
			start: (instanceId) =>
				Effect.gen(function* () {
					yield* Effect.tryPromise({
						try: () => instanceMgmt.startInstance(instanceId),
						catch: toError("start"),
					});
					return list();
				}),
			stop: (instanceId) =>
				Effect.gen(function* () {
					yield* Effect.try({
						try: () => instanceMgmt.stopInstance(instanceId),
						catch: toError("stop"),
					});
					return list();
				}),
			update: (instanceId, input) =>
				Effect.gen(function* () {
					const updates: {
						name?: string;
						env?: Record<string, string>;
						port?: number;
					} = {};
					if (typeof input.name === "string") updates.name = input.name;
					if (typeof input.port === "number") updates.port = input.port;
					if (input.env !== undefined) updates.env = input.env;

					yield* Effect.try({
						try: () => instanceMgmt.updateInstance(instanceId, updates),
						catch: toError("update"),
					});
					return yield* withPersistedList("update");
				}),
			rename: (instanceId, name) =>
				Effect.gen(function* () {
					yield* Effect.try({
						try: () =>
							instanceMgmt.updateInstance(instanceId, {
								name: name.trim(),
							}),
						catch: toError("rename"),
					});
					return yield* withPersistedList("rename");
				}),
		};
	}),
);
