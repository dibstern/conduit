// InstanceManager Service (Effect)
// Per-instance fibers + acquireRelease for health polling.
// State lives in InstanceManagerStateTag (Ref<InstanceManagerState>);
// health poll fibers are tracked in PollerFibersTag (FiberMap<string>).
//
// Exported free functions can be used directly in Effect pipelines.
// addInstance uses atomic Ref.modify for capacity enforcement — two
// concurrent addInstance calls cannot both pass the capacity check.

import {
	Clock,
	Context,
	Duration,
	Effect,
	FiberMap,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Scope,
} from "effect";
import { DEFAULT_OPENCODE_URL } from "../../../constants.js";
import {
	defaultInstanceIdForDriver,
	isKnownDriverKind,
	PROVIDER_SESSION_CAPABILITIES,
} from "../../../contracts/provider-instance.js";
import {
	instanceAlreadyExists,
	instanceLimitExceeded,
	instanceNotFound,
	invalidInstanceUrl,
} from "../../../instance/instance-errors.js";
import {
	availableOpenCodePort,
	canReuseManagedOpenCode,
	commitManagedOpenCodeSpawn,
	inspectManagedOpenCodeProcess,
	isProcessAlive,
	ManagedOpenCodeProcessError,
	type ManagedOpenCodeRecord,
	managedOpenCodeEnv,
	probeOpenCodeHealth,
	publicManagedOpenCodeEnv,
	spawnManagedOpenCode,
	stopManagedOpenCode,
	waitForOpenCodeHealth,
} from "../../../instance/managed-opencode-process.js";
import type {
	InstanceConfig,
	OpenCodeInstance,
} from "../../../shared-types.js";

export {
	InstanceAlreadyExists,
	InstanceLimitExceeded,
	InstanceNotFound,
	InvalidInstanceUrl,
} from "../../../instance/instance-errors.js";

import {
	ConfigPersistenceTag,
	requestConfigSave,
} from "./config-persistence-service.js";
import {
	type DaemonEventBusTag,
	publishInstanceError,
	publishInstanceStatusChanged,
} from "./daemon-pubsub.js";
import { type DaemonInstanceConfig, DaemonStateTag } from "./daemon-state.js";
import { InstanceHealthCheckTag } from "./instance-health-service.js";
import {
	defaultInstanceForUrl,
	resolveSmartDefaultInstance,
	type SmartDefaultInstanceOptions,
} from "./opencode-smart-default.js";

export interface AddInstanceInput extends InstanceConfig {
	id: string;
}

export interface InstanceManagerConfig {
	maxInstances: number;
	healthPollIntervalMs: number;
	maxRestartsPerWindow: number;
	restartWindowMs: number;
}

type InstanceReservationFailure =
	| { readonly _tag: "duplicate"; readonly id: string }
	| { readonly _tag: "limit"; readonly max: number };

const DEFAULT_CONFIG: InstanceManagerConfig = {
	maxInstances: 5,
	healthPollIntervalMs: 5000,
	maxRestartsPerWindow: 5,
	restartWindowMs: 60_000,
};

export class ManagedOpenCodeLifecycleTag extends Context.Tag(
	"ManagedOpenCodeLifecycle",
)<
	ManagedOpenCodeLifecycleTag,
	{
		readonly start: (instance: OpenCodeInstance) => Effect.Effect<void>;
		readonly withLock: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>;
	}
>() {}

const withManagedOpenCodeLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const lifecycle = yield* Effect.serviceOption(ManagedOpenCodeLifecycleTag);
		return yield* Option.isSome(lifecycle)
			? lifecycle.value.withLock(effect)
			: effect;
	});

export interface InstanceManagerState {
	instances: HashMap.HashMap<string, OpenCodeInstance>;
	externalUrls: HashMap.HashMap<string, string>;
	restartTimestamps: HashMap.HashMap<string, ReadonlyArray<number>>;
	config: InstanceManagerConfig;
	stopManagedProcesses?: boolean;
	/** Recovery identities and credentials never enter the browser read model. */
	managedProcesses?: HashMap.HashMap<string, ManagedOpenCodeRecord>;
	/** Set until the default instance's first start resolves the smart default there. */
	smartDefaultUrl?: string;
}

export interface InstanceManagerStateOptions
	extends SmartDefaultInstanceOptions {}

export const emptyInstanceManagerState = (
	config?: Partial<InstanceManagerConfig>,
): InstanceManagerState => ({
	instances: HashMap.empty(),
	externalUrls: HashMap.empty(),
	restartTimestamps: HashMap.empty(),
	config: { ...DEFAULT_CONFIG, ...config },
	stopManagedProcesses: false,
	managedProcesses: HashMap.empty(),
});

const buildInstanceManagerState = (
	config?: Partial<InstanceManagerConfig>,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> = [],
): InstanceManagerState => {
	const now = Date.now();
	return {
		instances: HashMap.fromIterable(
			initialInstances.map((instance) => {
				const driver = instance.driver ?? "opencode";
				const opencodeInstance: OpenCodeInstance = {
					id: instance.id,
					name: instance.name,
					port: driver === "claude" ? 0 : instance.port,
					managed: driver === "claude" ? false : instance.managed,
					driver,
					// Nothing runs at startup; re-adoption marks survivors healthy.
					status: driver === "claude" ? "healthy" : "stopped",
					restartCount: 0,
					createdAt: now,
					...(instance.env !== undefined
						? {
								env:
									driver === "opencode" && instance.managed
										? publicManagedOpenCodeEnv(instance.env)
										: instance.env,
							}
						: {}),
					...(driver === "opencode" &&
					instance.managed &&
					instance.pid !== undefined
						? { pid: instance.pid, version: instance.version }
						: {}),
					...(instance.configDir !== undefined
						? { configDir: instance.configDir }
						: {}),
					...(driver === "opencode" && instance.url !== undefined
						? { url: instance.url }
						: {}),
				};
				return [instance.id, opencodeInstance] as const;
			}),
		),
		externalUrls: HashMap.fromIterable(
			initialInstances.flatMap((instance) =>
				instance.url === undefined ||
				(instance.driver ?? "opencode") !== "opencode"
					? []
					: ([[instance.id, instance.url]] as const),
			),
		),
		restartTimestamps: HashMap.empty(),
		config: { ...DEFAULT_CONFIG, ...config },
		stopManagedProcesses: false,
		managedProcesses: HashMap.fromIterable(
			initialInstances
				.filter((instance) => instance.managed && instance.driver !== "claude")
				.map(
					(instance) =>
						[
							instance.id,
							{
								port: instance.port,
								...(instance.env !== undefined ? { env: instance.env } : {}),
								...(instance.pid !== undefined ? { pid: instance.pid } : {}),
								...(instance.processIdentity !== undefined
									? { processIdentity: instance.processIdentity }
									: {}),
								...(instance.version !== undefined
									? { version: instance.version }
									: {}),
							},
						] as const,
				),
		),
	};
};

/** Seeds the default instance without probing; smart default resolves on first start. */
const buildInitialInstanceManagerState = (
	config: Partial<InstanceManagerConfig> | undefined,
	initialInstances: ReadonlyArray<DaemonInstanceConfig>,
	options: InstanceManagerStateOptions | undefined,
): InstanceManagerState => {
	const smartDefaultUrl = options?.smartDefault
		? (options.smartDefaultUrl ?? DEFAULT_OPENCODE_URL)
		: undefined;
	const defaultUrl = options?.defaultOpencodeUrl ?? smartDefaultUrl;
	const existingDefault = initialInstances.find(
		(instance) => instance.id === defaultInstanceIdForDriver("opencode"),
	);
	const state = buildInstanceManagerState(
		config,
		existingDefault || defaultUrl === undefined
			? initialInstances
			: [defaultInstanceForUrl(defaultUrl), ...initialInstances],
	);
	return smartDefaultUrl !== undefined &&
		(existingDefault?.driver ?? "opencode") === "opencode" &&
		HashMap.has(state.instances, defaultInstanceIdForDriver("opencode"))
		? { ...state, smartDefaultUrl }
		: state;
};

/** Tag for the mutable InstanceManagerState Ref in the Effect Context. */
export class InstanceManagerStateTag extends Context.Tag(
	"InstanceManagerState",
)<InstanceManagerStateTag, Ref.Ref<InstanceManagerState>>() {}

/** Tag for the FiberMap tracking per-instance health poll fibers. */
export class PollerFibersTag extends Context.Tag("PollerFibers")<
	PollerFibersTag,
	FiberMap.FiberMap<string>
>() {}

/**
 * Create a Layer providing both InstanceManagerStateTag and PollerFibersTag.
 *
 * FiberMap.make requires a Scope (fibers are interrupted on scope close),
 * so this Layer is scoped — callers must use it.scoped or Effect.scoped.
 *
 * @param config - Optional config overrides (e.g. maxInstances).
 */
export function makeInstanceManagerStateLive(
	config?: Partial<InstanceManagerConfig>,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> = [],
	options?: InstanceManagerStateOptions,
): Layer.Layer<InstanceManagerStateTag | PollerFibersTag> {
	return Layer.effect(
		InstanceManagerStateTag,
		Ref.make(
			buildInitialInstanceManagerState(config, initialInstances, options),
		),
	).pipe(Layer.merge(Layer.scoped(PollerFibersTag, FiberMap.make<string>())));
}

export function makeInstanceManagerStateFromDaemonStateLive(
	config?: Partial<InstanceManagerConfig>,
	options?: InstanceManagerStateOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	never,
	DaemonStateTag
> {
	return Layer.effect(
		InstanceManagerStateTag,
		Effect.gen(function* () {
			const state = yield* Ref.get(yield* DaemonStateTag);
			return yield* Ref.make(
				buildInitialInstanceManagerState(config, state.instances, options),
			);
		}),
	).pipe(Layer.merge(Layer.scoped(PollerFibersTag, FiberMap.make<string>())));
}

const pollerKey = (id: string) => `poller:${id}`;
const restartKey = (id: string) => `restart:${id}`;

/**
 * Add an instance. Uses atomic Ref.modify to check capacity AND reserve
 * the slot in one step — two concurrent addInstance calls cannot both
 * pass the capacity check. Then starts a health poll fiber via FiberMap.run.
 */
export const addInstance = (input: AddInstanceInput) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const fiberMap = yield* PollerFibersTag;
		const driver = input.driver ?? "opencode";

		const inputExternalUrl = input.url;
		if (driver === "opencode" && inputExternalUrl !== undefined) {
			yield* Effect.try({
				try: () => new URL(inputExternalUrl),
				catch: (cause) => invalidInstanceUrl(input.id, inputExternalUrl, cause),
			});
		}

		const now = yield* Clock.currentTimeMillis;
		const instance: OpenCodeInstance = {
			id: input.id,
			name: input.name,
			port: driver === "claude" ? 0 : input.port,
			managed: driver === "claude" ? false : input.managed,
			driver,
			status: driver === "claude" ? "healthy" : "starting",
			restartCount: 0,
			createdAt: now,
			// Only include optional env when defined (exactOptionalPropertyTypes)
			...(input.env !== undefined
				? {
						env:
							driver === "opencode" && input.managed
								? publicManagedOpenCodeEnv(input.env)
								: input.env,
					}
				: {}),
			...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
			...(driver === "opencode" && inputExternalUrl !== undefined
				? { url: inputExternalUrl }
				: {}),
		};

		// Atomic capacity check + slot reservation via Ref.modify.
		// Returns Either-style: the modify function returns a tuple [returnValue, newState].
		// We return the error (or undefined) as the "return value" and either the
		// updated state or the original state as the "new state".
		const reservationFailure = yield* Ref.modify(
			ref,
			(
				state,
			): readonly [
				InstanceReservationFailure | undefined,
				InstanceManagerState,
			] => {
				if (HashMap.has(state.instances, input.id)) {
					return [{ _tag: "duplicate", id: input.id }, state];
				}
				const currentSize = HashMap.size(state.instances);
				if (currentSize >= state.config.maxInstances) {
					// Over capacity — return error marker, leave state unchanged
					return [{ _tag: "limit", max: state.config.maxInstances }, state];
				}
				// Under capacity — reserve the slot atomically
				const newInstances = HashMap.set(state.instances, input.id, instance);
				const newExternalUrls =
					driver === "opencode" && inputExternalUrl !== undefined
						? HashMap.set(state.externalUrls, input.id, inputExternalUrl)
						: state.externalUrls;
				return [
					undefined,
					{
						...state,
						instances: newInstances,
						externalUrls: newExternalUrls,
						...(driver === "opencode" && input.managed
							? {
									managedProcesses: HashMap.set(
										state.managedProcesses ?? HashMap.empty(),
										input.id,
										{
											port: input.port,
											...(input.env !== undefined ? { env: input.env } : {}),
										},
									),
								}
							: {}),
					},
				];
			},
		);

		if (reservationFailure !== undefined) {
			if (reservationFailure._tag === "duplicate") {
				return yield* instanceAlreadyExists(reservationFailure.id);
			}
			return yield* instanceLimitExceeded(reservationFailure.max);
		}

		// Start health poll fiber — FiberMap auto-interrupts if one already exists for this key
		if (driver === "opencode") {
			yield* FiberMap.run(
				fiberMap,
				pollerKey(input.id),
				Effect.never.pipe(Effect.interruptible),
			);
		}

		yield* requestConfigSave;

		return instance;
	}).pipe(
		Effect.annotateLogs("instanceId", input.id),
		Effect.withSpan("instance.add", { attributes: { instanceId: input.id } }),
	);

/**
 * Remove an instance. Clears from state and interrupts its health poll fiber.
 */
export const removeInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const fiberMap = yield* PollerFibersTag;
		const processRecord = HashMap.get(
			(yield* Ref.get(ref)).managedProcesses ?? HashMap.empty(),
			instanceId,
		);
		if (Option.isSome(processRecord))
			yield* stopRecordedManagedOpenCode(processRecord.value);

		yield* Ref.update(ref, (state) => ({
			...state,
			instances: HashMap.remove(state.instances, instanceId),
			externalUrls: HashMap.remove(state.externalUrls, instanceId),
			restartTimestamps: HashMap.remove(state.restartTimestamps, instanceId),
			managedProcesses: HashMap.remove(
				state.managedProcesses ?? HashMap.empty(),
				instanceId,
			),
		}));

		yield* FiberMap.remove(fiberMap, pollerKey(instanceId));
		yield* FiberMap.remove(fiberMap, restartKey(instanceId));
		yield* requestConfigSave;
	}).pipe(
		withManagedOpenCodeLock,
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.remove", {
			attributes: { instanceId },
		}),
	);

// Capabilities describe the adapter, not persisted instance configuration.
function instanceInfo(instance: OpenCodeInstance): OpenCodeInstance {
	const driver = instance.driver ?? "opencode";
	return {
		...instance,
		capabilities: isKnownDriverKind(driver)
			? PROVIDER_SESSION_CAPABILITIES[driver]
			: { supportsMultiFolder: false, supportsWorktree: false },
	};
}

/** Get a single instance by ID, or fail with InstanceNotFound. */
export const getInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const state = yield* Ref.get(ref);
		const instance = HashMap.get(state.instances, instanceId);

		if (instance._tag === "None") {
			return yield* instanceNotFound(instanceId);
		}
		return instanceInfo(instance.value);
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.get", { attributes: { instanceId } }),
	);

/**
 * Get all instances as a readonly array.
 */
export const getInstances = Effect.gen(function* () {
	const ref = yield* InstanceManagerStateTag;
	const state = yield* Ref.get(ref);
	return Array.from(HashMap.values(state.instances), instanceInfo);
}).pipe(Effect.withSpan("instance.getAll"));

export const getManagedOpenCodeProcessEnv = (instanceId: string) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const record = HashMap.get(
			(yield* Ref.get(ref)).managedProcesses ?? HashMap.empty(),
			instanceId,
		);
		return Option.isSome(record) ? record.value.env : undefined;
	});

/**
 * Get all instance records in daemon.json shape, including unmanaged external
 * URLs tracked separately for lifecycle lookup.
 */
export const getPersistedInstanceConfigs = Effect.gen(function* () {
	const ref = yield* InstanceManagerStateTag;
	const state = yield* Ref.get(ref);
	const configs: DaemonInstanceConfig[] = [];
	for (const inst of HashMap.values(state.instances)) {
		const externalUrl = HashMap.get(state.externalUrls, inst.id);
		const privateRecord = HashMap.get(
			state.managedProcesses ?? HashMap.empty(),
			inst.id,
		);
		const record =
			inst.managed && inst.driver !== "claude" && Option.isSome(privateRecord)
				? privateRecord.value
				: undefined;
		const pid = record?.pid ?? inst.pid;
		configs.push({
			id: inst.id,
			name: inst.name,
			port: inst.port,
			managed: inst.managed,
			...(inst.managed && inst.driver !== "claude" && pid !== undefined
				? {
						pid,
						...(record?.processIdentity !== undefined
							? { processIdentity: record.processIdentity }
							: {}),
						...(inst.version !== undefined ? { version: inst.version } : {}),
					}
				: {}),
			driver: inst.driver ?? "opencode",
			...((record?.env ?? inst.env) !== undefined
				? { env: record?.env ?? inst.env }
				: {}),
			...(inst.pid === undefined && record?.processIdentity !== undefined
				? { processIdentity: record.processIdentity }
				: {}),
			...(Option.isSome(externalUrl) ? { url: externalUrl.value } : {}),
			...(inst.configDir !== undefined ? { configDir: inst.configDir } : {}),
		});
	}
	return configs;
}).pipe(Effect.withSpan("instance.getPersistedConfigs"));

/**
 * Start periodic health polling for an instance.
 * Uses raw HTTP fetch to the instance port. Publishes status changes
 * via DaemonEventBusTag. Stops polling if instance is removed or if
 * a managed instance enters stopped/unhealthy state.
 */
export const startHealthPoller = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		const fibers = yield* PollerFibersTag;
		const healthCheck = yield* InstanceHealthCheckTag;
		const initialState = yield* Ref.get(stateRef);
		const { config } = initialState;
		const initialInstance = HashMap.get(initialState.instances, instanceId);
		if (
			Option.isNone(initialInstance) ||
			initialInstance.value.driver === "claude"
		) {
			return;
		}

		const pollOnce = Effect.gen(function* () {
			const state = yield* Ref.get(stateRef);
			const instanceOpt = HashMap.get(state.instances, instanceId);
			if (Option.isNone(instanceOpt)) return;

			const instance = instanceOpt.value;
			if (instance.driver === "claude") return;

			// Guard: stop polling managed instances in stopped/unhealthy state
			if (
				instance.managed &&
				(instance.status === "stopped" || instance.status === "unhealthy")
			) {
				return;
			}

			const externalUrl = HashMap.get(state.externalUrls, instanceId);
			const instanceUrl = Option.isSome(externalUrl)
				? externalUrl.value
				: `http://localhost:${instance.port}`;
			const isHealthy = yield* healthCheck.check({
				instance: {
					...instance,
					env:
						(instance.managed
							? yield* getManagedOpenCodeProcessEnv(instance.id)
							: instance.env) ?? {},
				},
				url: instanceUrl,
			});

			const newStatus = isHealthy
				? ("healthy" as const)
				: ("unhealthy" as const);

			// Only update + publish on transition
			if (newStatus !== instance.status) {
				const now = yield* Clock.currentTimeMillis;
				yield* Ref.update(stateRef, (s) => ({
					...s,
					instances: HashMap.modify(s.instances, instanceId, (inst) => ({
						...inst,
						status: newStatus,
						lastHealthCheck: now,
					})),
				}));
				yield* publishInstanceStatusChanged(instanceId);
			}
		}).pipe(
			Effect.catchAll(() =>
				Effect.logWarning("Health check error").pipe(
					Effect.annotateLogs("instanceId", instanceId),
				),
			),
		);

		yield* FiberMap.run(
			fibers,
			pollerKey(instanceId),
			Effect.repeat(
				pollOnce,
				Schedule.spaced(Duration.millis(config.healthPollIntervalMs)),
			),
		);
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.startHealthPoller", {
			attributes: { instanceId },
		}),
	);

/**
 * Stop health polling for an instance.
 */
export const stopHealthPoller = (instanceId: string) =>
	Effect.gen(function* () {
		const fibers = yield* PollerFibersTag;
		yield* FiberMap.remove(fibers, pollerKey(instanceId));
	});

const stopRecordedManagedOpenCode = (record: ManagedOpenCodeRecord) =>
	Effect.tryPromise({
		try: async () => {
			if (await stopManagedOpenCode(record)) return;
			// A recycled worker PID cannot keep a dead supervisor's record alive.
			if (
				record.processIdentity &&
				isProcessAlive(record.processIdentity.supervisorPid)
			)
				throw new ManagedOpenCodeProcessError({
					message:
						"Cannot verify OpenCode ownership; retaining its recovery record",
				});
		},
		catch: (cause) => cause,
	});

const markManagedInstanceHealthy = (
	instance: OpenCodeInstance,
	processState: ManagedOpenCodeRecord & { pid: number },
) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const now = yield* Clock.currentTimeMillis;
		const { env, processIdentity: _identity, ...visible } = processState;
		yield* Ref.update(ref, (state) => ({
			...state,
			instances: HashMap.modify(state.instances, instance.id, (current) => ({
				...current,
				...visible,
				...(env !== undefined ? { env: publicManagedOpenCodeEnv(env) } : {}),
				status: "healthy" as const,
				lastHealthCheck: now,
			})),
			externalUrls: HashMap.remove(state.externalUrls, instance.id),
			managedProcesses: HashMap.set(
				state.managedProcesses ?? HashMap.empty(),
				instance.id,
				processState,
			),
		}));
		yield* publishInstanceStatusChanged(instance.id);
	});

const markManagedInstanceUnhealthy = (
	instance: OpenCodeInstance,
	cause: unknown,
) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		yield* Ref.update(ref, (state) => ({
			...state,
			instances: HashMap.modify(state.instances, instance.id, (current) => {
				const { pid: _pid, version: _version, ...rest } = current;
				return { ...rest, status: "unhealthy" as const };
			}),
		}));
		const message = cause instanceof Error ? cause.message : String(cause);
		yield* publishInstanceStatusChanged(instance.id);
		yield* publishInstanceError(instance.id, message);
		yield* Effect.logWarning(
			`Failed to start managed OpenCode for instance ${instance.id}: ${message}`,
		);
	});

const startManagedOpenCodeServer = (
	instance: OpenCodeInstance,
	configDir: string,
	adoptOnly: boolean,
) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const ref = yield* InstanceManagerStateTag;
			const persistence = yield* ConfigPersistenceTag;
			const save = persistence.requestSave.pipe(
				Effect.zipRight(persistence.flush),
			);
			let owned: ManagedOpenCodeRecord | undefined;
			let previous: ManagedOpenCodeRecord | undefined;
			return yield* Effect.gen(function* () {
				const record: ManagedOpenCodeRecord = Option.getOrElse(
					HashMap.get(
						(yield* Ref.get(ref)).managedProcesses ?? HashMap.empty(),
						instance.id,
					),
					() => instance,
				);
				previous = record;
				const reusable = yield* Effect.tryPromise({
					try: () => canReuseManagedOpenCode(record),
					catch: (cause) => cause,
				});
				if (reusable && record.pid !== undefined) {
					const identity = yield* Effect.tryPromise({
						try: () => inspectManagedOpenCodeProcess(record.processIdentity),
						catch: (cause) => cause,
					});
					if (!identity?.running || !identity.listening)
						return yield* new ManagedOpenCodeProcessError({
							message: "OpenCode ownership changed during recovery",
						});
					const health = yield* Effect.tryPromise({
						try: () => probeOpenCodeHealth(record.port, record.env),
						catch: (cause) => cause,
					});
					if (!health)
						return yield* new ManagedOpenCodeProcessError({
							message: "OpenCode became unhealthy during recovery",
						});
					owned = { ...record, pid: identity.pid, ...health };
					yield* markManagedInstanceHealthy(instance, {
						...record,
						pid: identity.pid,
						...health,
					});
					yield* save;
					return owned;
				}
				// Startup only re-adopts; anything else waits for first use.
				if (adoptOnly) return null;
				// An authenticated supervisor can safely terminate its original
				// group even if the recorded worker PID is stale or corrupted.
				const original = yield* Effect.tryPromise({
					try: () => inspectManagedOpenCodeProcess(record.processIdentity),
					catch: (cause) => cause,
				});
				if (original) {
					yield* stopRecordedManagedOpenCode({ ...record, pid: original.pid });
				} else if (record.processIdentity) {
					yield* stopRecordedManagedOpenCode(record);
				}
				// A stale PID may belong to another program. Do not signal it, and
				// use a fresh port when replacing an invalid recorded process.
				const port = yield* Effect.tryPromise({
					try: () =>
						availableOpenCodePort(record.pid !== undefined ? 0 : instance.port),
					catch: (cause) => cause,
				});
				const env = managedOpenCodeEnv(record.env ?? instance.env);
				yield* Ref.update(ref, (state) => ({
					...state,
					instances: HashMap.modify(state.instances, instance.id, (current) => {
						const { pid: _pid, version: _version, ...rest } = current;
						return { ...rest, port, env: publicManagedOpenCodeEnv(env) };
					}),
					managedProcesses: HashMap.set(
						state.managedProcesses ?? HashMap.empty(),
						instance.id,
						{ port, env },
					),
				}));
				yield* save;
				const spawned = yield* Effect.tryPromise({
					try: () => spawnManagedOpenCode(instance.id, port, env, configDir),
					catch: (cause) => cause,
				});
				owned = {
					port,
					env,
					pid: spawned.pid,
					processIdentity: spawned.processIdentity,
				};
				yield* Ref.update(ref, (state) => ({
					...state,
					instances: HashMap.modify(
						state.instances,
						instance.id,
						(current) => ({ ...current, pid: spawned.pid }),
					),
					managedProcesses: HashMap.set(
						state.managedProcesses ?? HashMap.empty(),
						instance.id,
						{
							port,
							env,
							pid: spawned.pid,
							processIdentity: spawned.processIdentity,
						},
					),
				}));
				// Record identity before readiness, so a crash during startup can
				// still rediscover the detached child.
				yield* save;
				yield* Effect.tryPromise({
					try: () => commitManagedOpenCodeSpawn(spawned.process),
					catch: (cause) => cause,
				});
				const health = yield* Effect.tryPromise({
					try: (signal) =>
						waitForOpenCodeHealth(
							{ port, env, processIdentity: spawned.processIdentity },
							spawned.process,
							signal,
						),
					catch: (cause) => cause,
				});
				yield* markManagedInstanceHealthy(instance, {
					port,
					env,
					processIdentity: spawned.processIdentity,
					...health,
				});
				yield* save;
				return {
					port,
					env,
					processIdentity: spawned.processIdentity,
					...health,
				};
			}).pipe(
				Effect.catchAll((cause) =>
					Effect.gen(function* () {
						let released = true;
						if (owned) {
							const record = owned;
							released = yield* stopRecordedManagedOpenCode(record).pipe(
								Effect.as(true),
								Effect.catchAll((error) =>
									Effect.logWarning(
										"Retaining failed-start OpenCode ownership",
										error,
									).pipe(Effect.as(false)),
								),
							);
						}
						yield* markManagedInstanceUnhealthy(instance, cause);
						if (owned && released) {
							const env = owned.env;
							yield* Ref.update(ref, (state) => ({
								...state,
								managedProcesses: HashMap.set(
									state.managedProcesses ?? HashMap.empty(),
									instance.id,
									{
										port: instance.port,
										...(env !== undefined ? { env } : {}),
									},
								),
							}));
						}
						yield* save.pipe(
							Effect.catchAll((error) =>
								Effect.logError(
									"Failed to persist OpenCode startup recovery state",
									error,
								),
							),
						);
						return !released
							? (owned ?? null)
							: !owned && previous?.processIdentity
								? previous
								: null;
					}),
				),
			);
		}).pipe(
			Effect.catchAll((cause) =>
				Effect.logError(
					`Managed OpenCode startup failed for ${instance.id}`,
					cause,
				).pipe(Effect.as(null)),
			),
		),
		(record) =>
			Effect.gen(function* () {
				if (record === null) return;
				const ref = yield* InstanceManagerStateTag;
				const state = yield* Ref.get(ref);
				const registered = HashMap.get(state.instances, instance.id);
				const current = HashMap.get(
					state.managedProcesses ?? HashMap.empty(),
					instance.id,
				);
				const sameGeneration =
					Option.isSome(current) &&
					current.value.processIdentity?.token ===
						record.processIdentity?.token;
				if (
					!state.stopManagedProcesses &&
					Option.isSome(registered) &&
					registered.value.managed &&
					registered.value.driver !== "claude" &&
					sameGeneration
				)
					return;
				// Successful spawn or authenticated adoption establishes group
				// ownership. Explicit stop must work even if its API later hangs.
				yield* stopRecordedManagedOpenCode(record);
				yield* Ref.update(ref, (state) => {
					const processes = state.managedProcesses ?? HashMap.empty();
					const current = HashMap.get(processes, instance.id);
					if (
						Option.isNone(current) ||
						current.value.processIdentity?.token !==
							record.processIdentity?.token
					)
						return state;
					return {
						...state,
						instances: HashMap.modify(
							state.instances,
							instance.id,
							(current) => {
								const { pid: _pid, version: _version, ...rest } = current;
								return { ...rest, status: "stopped" as const };
							},
						),
						managedProcesses: HashMap.set(processes, instance.id, {
							port: record.port,
							...(record.env !== undefined ? { env: record.env } : {}),
						}),
					};
				});
				const persistence = yield* ConfigPersistenceTag;
				yield* persistence.requestSave;
				yield* persistence.flush;
			}).pipe(
				Effect.catchAll((cause) =>
					Effect.logError(
						`Managed OpenCode cleanup failed for ${instance.id}`,
						cause,
					),
				),
			),
	);

export const requestManagedOpenCodeShutdown = Effect.gen(function* () {
	const ref = yield* InstanceManagerStateTag;
	yield* Ref.update(ref, (state) => ({ ...state, stopManagedProcesses: true }));
});

export const ManagedOpenCodeLifecycleLive = (configDir: string) =>
	Layer.scoped(
		ManagedOpenCodeLifecycleTag,
		Effect.gen(function* () {
			const scope = yield* Effect.scope;
			const context = yield* Effect.context<
				InstanceManagerStateTag | ConfigPersistenceTag | DaemonEventBusTag
			>();
			const semaphore = yield* Effect.makeSemaphore(1);
			const start = (instance: OpenCodeInstance, adoptOnly: boolean) =>
				startManagedOpenCodeServer(instance, configDir, adoptOnly).pipe(
					// RPC scopes end after each request; ownership lasts with the daemon.
					Scope.extend(scope),
					Effect.provide(context),
					Effect.asVoid,
				);
			// Re-adopt managed OpenCode that outlived the previous daemon. Nothing
			// spawns here: instances start on first use.
			const state = yield* Ref.get(yield* InstanceManagerStateTag);
			yield* Effect.forEach(
				HashMap.values(state.instances),
				(instance) =>
					instance.managed && instance.driver !== "claude"
						? semaphore.withPermits(1)(start(instance, true))
						: Effect.void,
				{ concurrency: 1, discard: true },
			);
			return {
				start: (instance: OpenCodeInstance) => start(instance, false),
				withLock: semaphore.withPermits(1),
			};
		}).pipe(Effect.withSpan("instance.adoptManagedOpenCodeServers")),
	);

/**
 * Schedule a restart for an unhealthy instance with exponential backoff.
 * Rate-limited by maxRestartsPerWindow. On exceed, marks instance
 * "stopped" and publishes InstanceError via DaemonEventBusTag, and returns
 * undefined; otherwise returns the fiber that waits out the backoff and
 * starts the instance again.
 */
export const scheduleRestart = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		const fibers = yield* PollerFibersTag;
		const { config } = yield* Ref.get(stateRef);

		const now = yield* Clock.currentTimeMillis;

		// Check restart rate limit
		const state = yield* Ref.get(stateRef);
		const instance = HashMap.get(state.instances, instanceId);
		if (Option.isNone(instance) || instance.value.driver === "claude") {
			return undefined;
		}
		const timestamps = Option.getOrElse(
			HashMap.get(state.restartTimestamps, instanceId),
			() => [] as ReadonlyArray<number>,
		);
		const recentRestarts = timestamps.filter(
			(t) => now - t < config.restartWindowMs,
		);

		if (recentRestarts.length >= config.maxRestartsPerWindow) {
			// Give up — mark stopped, publish error
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, instanceId, (inst) => ({
					...inst,
					status: "stopped" as const,
				})),
			}));
			yield* publishInstanceError(
				instanceId,
				`Crashed ${recentRestarts.length} times in ${config.restartWindowMs / 1000}s — giving up`,
			);
			yield* Effect.logWarning("Restart limit exceeded, marking stopped").pipe(
				Effect.annotateLogs("instanceId", instanceId),
			);
			return undefined;
		}

		// Record timestamp
		yield* Ref.update(stateRef, (s) => ({
			...s,
			restartTimestamps: HashMap.set(s.restartTimestamps, instanceId, [
				...recentRestarts,
				now,
			]),
		}));

		// Exponential backoff: 1s * 2^attempts, capped at 30s
		const backoffMs = Math.min(1000 * 2 ** recentRestarts.length, 30_000);

		// Fork restart fiber
		return yield* FiberMap.run(
			fibers,
			restartKey(instanceId),
			Effect.gen(function* () {
				yield* Effect.sleep(Duration.millis(backoffMs));
				// Re-check instance still exists and is still unhealthy
				const current = yield* Ref.get(stateRef);
				const instOpt = HashMap.get(current.instances, instanceId);
				if (Option.isNone(instOpt)) return;
				if (instOpt.value.status !== "unhealthy") return;
				yield* restartInstance(instanceId);
				yield* startInstance(instanceId);
			}),
		);
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.scheduleRestart", {
			attributes: { instanceId },
		}),
	);

/**
 * Restart an instance by resetting its status to "starting" and publishing
 * a status change event. The actual process spawn is handled by the caller
 * (daemon-main or tests provide the spawn mechanism).
 */
export const restartInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		const state = yield* Ref.get(stateRef);
		const instOpt = HashMap.get(state.instances, instanceId);
		if (Option.isNone(instOpt)) return;
		if (instOpt.value.driver === "claude") return;

		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => ({
				...inst,
				status: "starting" as const,
				restartCount: inst.restartCount + 1,
			})),
		}));
		yield* publishInstanceStatusChanged(instanceId);
		yield* Effect.logInfo("Restarting instance").pipe(
			Effect.annotateLogs("instanceId", instanceId),
		);
	});

/**
 * Cancel both poller and restart fibers for an instance.
 */
export const cancelInstanceFibers = (instanceId: string) =>
	Effect.gen(function* () {
		const fibers = yield* PollerFibersTag;
		yield* FiberMap.remove(fibers, pollerKey(instanceId));
		yield* FiberMap.remove(fibers, restartKey(instanceId));
	});

/**
 * Start an instance in the daemon's scope and begin health polling.
 */
export const startInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		let state = yield* Ref.get(stateRef);
		let instance = HashMap.get(state.instances, instanceId);
		if (Option.isSome(instance) && instance.value.driver === "claude") return;
		const lifecycle = yield* Effect.serviceOption(ManagedOpenCodeLifecycleTag);
		if (
			Option.isSome(instance) &&
			instance.value.managed &&
			instance.value.status === "healthy" &&
			Option.isSome(lifecycle)
		)
			return;
		const { smartDefaultUrl } = state;
		if (
			smartDefaultUrl !== undefined &&
			instanceId === defaultInstanceIdForDriver("opencode") &&
			Option.isSome(instance)
		) {
			const current = instance.value;
			const record = HashMap.get(
				state.managedProcesses ?? HashMap.empty(),
				instanceId,
			);
			const url = HashMap.get(state.externalUrls, instanceId);
			const resolved = yield* resolveSmartDefaultInstance(
				{
					...Option.getOrUndefined(record),
					id: current.id,
					name: current.name,
					port: current.port,
					managed: current.managed,
					...(Option.isSome(url) ? { url: url.value } : {}),
					...(current.managed
						? {}
						: current.env !== undefined
							? { env: current.env }
							: {}),
				},
				smartDefaultUrl,
			);
			const seeded = buildInstanceManagerState(undefined, [resolved]);
			const take = <V>(
				from: HashMap.HashMap<string, V>,
				into: HashMap.HashMap<string, V>,
			) =>
				Option.match(HashMap.get(from, instanceId), {
					onNone: () => HashMap.remove(into, instanceId),
					onSome: (value) => HashMap.set(into, instanceId, value),
				});
			state = yield* Ref.updateAndGet(
				stateRef,
				({ smartDefaultUrl: _resolved, ...s }) => ({
					...s,
					instances: take(seeded.instances, s.instances),
					externalUrls: take(seeded.externalUrls, s.externalUrls),
					managedProcesses: take(
						seeded.managedProcesses ?? HashMap.empty(),
						s.managedProcesses ?? HashMap.empty(),
					),
				}),
			);
			instance = HashMap.get(state.instances, instanceId);
			yield* requestConfigSave;
		}
		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => ({
				...inst,
				status: "starting" as const,
			})),
		}));
		yield* publishInstanceStatusChanged(instanceId);
		if (
			Option.isSome(instance) &&
			instance.value.managed &&
			Option.isSome(lifecycle)
		) {
			yield* lifecycle.value.start(instance.value);
		}
		yield* startHealthPoller(instanceId);
	}).pipe(
		withManagedOpenCodeLock,
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.start"),
	);

/**
 * Stop an instance — interrupt its fibers and mark it "stopped".
 */
export const stopInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		const state = yield* Ref.get(stateRef);
		const instance = HashMap.get(state.instances, instanceId);
		if (Option.isSome(instance) && instance.value.driver === "claude") return;
		yield* cancelInstanceFibers(instanceId);
		const record = HashMap.get(
			state.managedProcesses ?? HashMap.empty(),
			instanceId,
		);
		if (Option.isSome(record)) yield* stopRecordedManagedOpenCode(record.value);
		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => {
				const { pid: _pid, version: _version, ...rest } = inst;
				return { ...rest, status: "stopped" as const };
			}),
			managedProcesses: Option.isSome(record)
				? HashMap.set(s.managedProcesses ?? HashMap.empty(), instanceId, {
						port: record.value.port,
						...(record.value.env !== undefined
							? { env: record.value.env }
							: {}),
					})
				: (s.managedProcesses ?? HashMap.empty()),
		}));
		yield* publishInstanceStatusChanged(instanceId);
		yield* requestConfigSave;
	}).pipe(
		withManagedOpenCodeLock,
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.stop"),
	);

/**
 * Update an instance with partial field merge.
 */
export const updateInstance = (
	instanceId: string,
	updates: Partial<
		Pick<
			OpenCodeInstance,
			"name" | "port" | "env" | "managed" | "status" | "driver" | "configDir"
		>
	>,
) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		if (updates.driver === "claude") {
			const record = HashMap.get(
				(yield* Ref.get(stateRef)).managedProcesses ?? HashMap.empty(),
				instanceId,
			);
			if (Option.isSome(record))
				yield* stopRecordedManagedOpenCode(record.value);
			yield* cancelInstanceFibers(instanceId);
		}
		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => {
				const updated = {
					...inst,
					...updates,
					...(inst.managed &&
					inst.driver !== "claude" &&
					updates.env !== undefined
						? { env: publicManagedOpenCodeEnv(updates.env) }
						: {}),
				};
				if (updates.driver !== "claude") return updated;
				const {
					url: _url,
					pid: _pid,
					version: _version,
					env,
					...claudeInstance
				} = updated;
				const {
					OPENCODE_SERVER_PASSWORD: _password,
					OPENCODE_SERVER_USERNAME: _username,
					...claudeEnv
				} = env ?? {};
				return {
					...claudeInstance,
					...(env !== undefined ? { env: claudeEnv } : {}),
					managed: false,
					port: 0,
					status: "healthy" as const,
				};
			}),
			externalUrls:
				updates.driver === "claude"
					? HashMap.remove(s.externalUrls, instanceId)
					: s.externalUrls,
			restartTimestamps:
				updates.driver === "claude"
					? HashMap.remove(s.restartTimestamps, instanceId)
					: s.restartTimestamps,
			managedProcesses:
				updates.driver === "claude"
					? HashMap.remove(s.managedProcesses ?? HashMap.empty(), instanceId)
					: updates.env !== undefined
						? HashMap.modify(
								s.managedProcesses ?? HashMap.empty(),
								instanceId,
								(record) => ({
									...record,
									env: {
										...updates.env,
										...(record.env?.["OPENCODE_SERVER_PASSWORD"] !==
											undefined &&
										updates.env?.["OPENCODE_SERVER_PASSWORD"] === undefined
											? {
													OPENCODE_SERVER_PASSWORD:
														record.env["OPENCODE_SERVER_PASSWORD"],
													OPENCODE_SERVER_USERNAME:
														record.env["OPENCODE_SERVER_USERNAME"] ??
														"opencode",
												}
											: {}),
									},
								}),
							)
						: (s.managedProcesses ?? HashMap.empty()),
		}));
		yield* publishInstanceStatusChanged(instanceId);
		yield* requestConfigSave;
	}).pipe(
		withManagedOpenCodeLock,
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.update"),
	);

/** Persist instance mutations before their RPC acknowledgement. */
export const persistConfig = Effect.gen(function* () {
	const persistence = yield* ConfigPersistenceTag;
	yield* persistence.requestSave;
	yield* persistence.flush;
}).pipe(Effect.withSpan("instance.persistConfig"));

/**
 * Get the external URL for an instance (using the daemon's public host).
 * Returns null if the instance is not found.
 */
export const getExternalUrl = (instanceId: string, daemonHost: string) =>
	getInstance(instanceId).pipe(
		Effect.map((inst) =>
			inst.driver === "claude" ? null : `http://${daemonHost}:${inst.port}`,
		),
		Effect.catchTag("InstanceNotFound", () => Effect.succeed(null)),
	);

/**
 * Get the localhost URL for an instance.
 * Returns null if the instance is not found.
 */
export const getInstanceUrl = (instanceId: string) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const state = yield* Ref.get(ref);
		const inst = HashMap.get(state.instances, instanceId);
		if (Option.isNone(inst)) {
			return yield* instanceNotFound(instanceId);
		}
		if (inst.value.driver === "claude") return null;
		const externalUrl = HashMap.get(state.externalUrls, instanceId);
		if (Option.isSome(externalUrl)) {
			return externalUrl.value;
		}
		return `http://localhost:${inst.value.port}`;
	}).pipe(
		Effect.catchTag("InstanceNotFound", () => Effect.succeed(null)),
		Effect.withSpan("instance.getInstanceUrl"),
	);
