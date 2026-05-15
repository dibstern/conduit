// ─── InstanceManager Service (Effect) ───────────────────────────────────────
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
} from "effect";
import {
	instanceAlreadyExists,
	instanceLimitExceeded,
	instanceNotFound,
	invalidInstanceUrl,
} from "../../../instance/instance-errors.js";
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

import { requestConfigSave } from "./config-persistence-service.js";
import {
	publishInstanceError,
	publishInstanceStatusChanged,
} from "./daemon-pubsub.js";
import { type DaemonInstanceConfig, DaemonStateTag } from "./daemon-state.js";
import {
	defaultInstanceForUrl,
	type OpenCodeUnavailableError,
	resolveSmartDefaultInstances,
	type SmartDefaultInstanceOptions,
} from "./opencode-smart-default.js";

// ─── Input type ───────────────────────────────────────────────────────────

export interface AddInstanceInput extends InstanceConfig {
	id: string;
}

// ─── Config ───────────────────────────────────────────────────────────────

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

// ─── State ────────────────────────────────────────────────────────────────

export interface InstanceManagerState {
	instances: HashMap.HashMap<string, OpenCodeInstance>;
	externalUrls: HashMap.HashMap<string, string>;
	restartTimestamps: HashMap.HashMap<string, ReadonlyArray<number>>;
	config: InstanceManagerConfig;
}

export interface InstanceManagerStateOptions
	extends SmartDefaultInstanceOptions {}

type SmartDefaultEnabledOptions = InstanceManagerStateOptions & {
	readonly smartDefault: true;
};

type SmartDefaultDisabledOptions = InstanceManagerStateOptions & {
	readonly smartDefault?: false | undefined;
};

export const emptyInstanceManagerState = (
	config?: Partial<InstanceManagerConfig>,
): InstanceManagerState => ({
	instances: HashMap.empty(),
	externalUrls: HashMap.empty(),
	restartTimestamps: HashMap.empty(),
	config: { ...DEFAULT_CONFIG, ...config },
});

const buildInstanceManagerState = (
	config?: Partial<InstanceManagerConfig>,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> = [],
): InstanceManagerState => {
	const now = Date.now();
	return {
		instances: HashMap.fromIterable(
			initialInstances.map((instance) => {
				const opencodeInstance: OpenCodeInstance = {
					id: instance.id,
					name: instance.name,
					port: instance.port,
					managed: instance.managed,
					status: "starting",
					restartCount: 0,
					createdAt: now,
					...(instance.env !== undefined ? { env: instance.env } : {}),
				};
				return [instance.id, opencodeInstance] as const;
			}),
		),
		externalUrls: HashMap.fromIterable(
			initialInstances.flatMap((instance) =>
				instance.url === undefined
					? []
					: ([[instance.id, instance.url]] as const),
			),
		),
		restartTimestamps: HashMap.empty(),
		config: { ...DEFAULT_CONFIG, ...config },
	};
};

const withConfiguredDefaultInstance = (
	initialInstances: ReadonlyArray<DaemonInstanceConfig>,
	options?: InstanceManagerStateOptions,
): ReadonlyArray<DaemonInstanceConfig> => {
	if (options?.defaultOpencodeUrl == null) return initialInstances;
	if (initialInstances.some((instance) => instance.id === "default")) {
		return initialInstances;
	}
	return [
		defaultInstanceForUrl(options.defaultOpencodeUrl),
		...initialInstances,
	];
};

const resolveInitialInstanceConfigs = (
	initialInstances: ReadonlyArray<DaemonInstanceConfig>,
	options?: InstanceManagerStateOptions,
) =>
	options?.smartDefault === true
		? resolveSmartDefaultInstances(initialInstances, options)
		: Effect.succeed(withConfiguredDefaultInstance(initialInstances, options));

// ─── Context Tags ─────────────────────────────────────────────────────────

/** Tag for the mutable InstanceManagerState Ref in the Effect Context. */
export class InstanceManagerStateTag extends Context.Tag(
	"InstanceManagerState",
)<InstanceManagerStateTag, Ref.Ref<InstanceManagerState>>() {}

/** Tag for the FiberMap tracking per-instance health poll fibers. */
export class PollerFibersTag extends Context.Tag("PollerFibers")<
	PollerFibersTag,
	FiberMap.FiberMap<string>
>() {}

// ─── Layer factory ────────────────────────────────────────────────────────

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
	initialInstances?: ReadonlyArray<DaemonInstanceConfig>,
	options?: SmartDefaultDisabledOptions,
): Layer.Layer<InstanceManagerStateTag | PollerFibersTag>;
export function makeInstanceManagerStateLive(
	config: Partial<InstanceManagerConfig> | undefined,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> | undefined,
	options: SmartDefaultEnabledOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	OpenCodeUnavailableError
>;
export function makeInstanceManagerStateLive(
	config: Partial<InstanceManagerConfig> | undefined,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> | undefined,
	options: InstanceManagerStateOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	OpenCodeUnavailableError
>;
export function makeInstanceManagerStateLive(
	config?: Partial<InstanceManagerConfig>,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> = [],
	options?: InstanceManagerStateOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	OpenCodeUnavailableError
> {
	return Layer.scoped(
		InstanceManagerStateTag,
		resolveInitialInstanceConfigs(initialInstances, options).pipe(
			Effect.map((instances) => buildInstanceManagerState(config, instances)),
			Effect.flatMap(Ref.make),
		),
	).pipe(Layer.merge(Layer.scoped(PollerFibersTag, FiberMap.make<string>())));
}

export function makeInstanceManagerStateFromDaemonStateLive(
	config?: Partial<InstanceManagerConfig>,
	options?: SmartDefaultDisabledOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	never,
	DaemonStateTag
>;
export function makeInstanceManagerStateFromDaemonStateLive(
	config: Partial<InstanceManagerConfig> | undefined,
	options: SmartDefaultEnabledOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	OpenCodeUnavailableError,
	DaemonStateTag
>;
export function makeInstanceManagerStateFromDaemonStateLive(
	config: Partial<InstanceManagerConfig> | undefined,
	options: InstanceManagerStateOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	OpenCodeUnavailableError,
	DaemonStateTag
>;
export function makeInstanceManagerStateFromDaemonStateLive(
	config?: Partial<InstanceManagerConfig>,
	options?: InstanceManagerStateOptions,
): Layer.Layer<
	InstanceManagerStateTag | PollerFibersTag,
	OpenCodeUnavailableError,
	DaemonStateTag
> {
	return Layer.scoped(
		InstanceManagerStateTag,
		Effect.gen(function* () {
			const stateRef = yield* DaemonStateTag;
			const state = yield* Ref.get(stateRef);
			const instances = yield* resolveInitialInstanceConfigs(
				state.instances,
				options,
			);
			return yield* Ref.make(buildInstanceManagerState(config, instances));
		}),
	).pipe(Layer.merge(Layer.scoped(PollerFibersTag, FiberMap.make<string>())));
}

// ─── Key prefix scheme for shared FiberMap ───────────────────────────────

const pollerKey = (id: string) => `poller:${id}`;
const restartKey = (id: string) => `restart:${id}`;

// ─── Free functions ───────────────────────────────────────────────────────

/**
 * Add an instance. Uses atomic Ref.modify to check capacity AND reserve
 * the slot in one step — two concurrent addInstance calls cannot both
 * pass the capacity check. Then starts a health poll fiber via FiberMap.run.
 */
export const addInstance = (input: AddInstanceInput) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const fiberMap = yield* PollerFibersTag;

		const inputExternalUrl = input.url;
		if (inputExternalUrl !== undefined) {
			yield* Effect.try({
				try: () => new URL(inputExternalUrl),
				catch: (cause) => invalidInstanceUrl(input.id, inputExternalUrl, cause),
			});
		}

		const now = yield* Clock.currentTimeMillis;
		const instance: OpenCodeInstance = {
			id: input.id,
			name: input.name,
			port: input.port,
			managed: input.managed,
			status: "starting",
			restartCount: 0,
			createdAt: now,
			// Only include optional env when defined (exactOptionalPropertyTypes)
			...(input.env !== undefined ? { env: input.env } : {}),
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
					inputExternalUrl !== undefined
						? HashMap.set(state.externalUrls, input.id, inputExternalUrl)
						: state.externalUrls;
				return [
					undefined,
					{ ...state, instances: newInstances, externalUrls: newExternalUrls },
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
		yield* FiberMap.run(
			fiberMap,
			pollerKey(input.id),
			Effect.never.pipe(Effect.interruptible),
		);

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

		yield* Ref.update(ref, (state) => ({
			...state,
			instances: HashMap.remove(state.instances, instanceId),
			externalUrls: HashMap.remove(state.externalUrls, instanceId),
			restartTimestamps: HashMap.remove(state.restartTimestamps, instanceId),
		}));

		yield* FiberMap.remove(fiberMap, pollerKey(instanceId));
		yield* FiberMap.remove(fiberMap, restartKey(instanceId));
		yield* requestConfigSave;
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.remove", {
			attributes: { instanceId },
		}),
	);

/**
 * Get a single instance by ID, or fail with InstanceNotFound.
 */
export const getInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const ref = yield* InstanceManagerStateTag;
		const state = yield* Ref.get(ref);
		const instance = HashMap.get(state.instances, instanceId);

		if (instance._tag === "None") {
			return yield* instanceNotFound(instanceId);
		}
		return instance.value;
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
	return HashMap.values(state.instances);
}).pipe(Effect.withSpan("instance.getAll"));

/**
 * Get all instance records in daemon.json shape, including unmanaged external
 * URLs stored outside OpenCodeInstance to keep the transport type clean.
 */
export const getPersistedInstanceConfigs = Effect.gen(function* () {
	const ref = yield* InstanceManagerStateTag;
	const state = yield* Ref.get(ref);
	const configs: DaemonInstanceConfig[] = [];
	for (const inst of HashMap.values(state.instances)) {
		const externalUrl = HashMap.get(state.externalUrls, inst.id);
		configs.push({
			id: inst.id,
			name: inst.name,
			port: inst.port,
			managed: inst.managed,
			...(inst.env !== undefined ? { env: inst.env } : {}),
			...(Option.isSome(externalUrl) ? { url: externalUrl.value } : {}),
		});
	}
	return configs;
}).pipe(Effect.withSpan("instance.getPersistedConfigs"));

export const startInitialUnmanagedInstanceHealthPollers = Effect.gen(
	function* () {
		const ref = yield* InstanceManagerStateTag;
		const state = yield* Ref.get(ref);

		yield* Effect.forEach(
			HashMap.values(state.instances),
			(instance) =>
				instance.managed ? Effect.void : startHealthPoller(instance.id),
			{ concurrency: 1, discard: true },
		);
	},
).pipe(Effect.withSpan("instance.startInitialUnmanagedHealthPollers"));

// ─── Health Polling ──────────────────────────────────────────────────────

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
		const { config } = yield* Ref.get(stateRef);

		const pollOnce = Effect.gen(function* () {
			const state = yield* Ref.get(stateRef);
			const instanceOpt = HashMap.get(state.instances, instanceId);
			if (Option.isNone(instanceOpt)) return;

			const instance = instanceOpt.value;

			// Guard: stop polling managed instances in stopped/unhealthy state
			if (
				instance.managed &&
				(instance.status === "stopped" || instance.status === "unhealthy")
			) {
				return;
			}

			// Raw HTTP health check
			const isHealthy = yield* Effect.tryPromise(() =>
				fetch(`http://localhost:${instance.port}/health`).then((r) => r.ok),
			).pipe(Effect.catchAll(() => Effect.succeed(false)));

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

// ─── Restart Scheduling ──────────────────────────────────────────────────

/**
 * Schedule a restart for an unhealthy instance with exponential backoff.
 * Rate-limited by maxRestartsPerWindow. On exceed, marks instance
 * "stopped" and publishes InstanceError via DaemonEventBusTag.
 */
export const scheduleRestart = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		const fibers = yield* PollerFibersTag;
		const { config } = yield* Ref.get(stateRef);

		const now = yield* Clock.currentTimeMillis;

		// Check restart rate limit
		const state = yield* Ref.get(stateRef);
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
			return;
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
		yield* FiberMap.run(
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
				yield* startHealthPoller(instanceId);
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

// ─── Missing methods for InstanceManagementDeps ─────────────────────────

/**
 * Start an instance — update status to "starting" and begin health polling.
 * The actual process spawn is handled externally; this manages Effect-side state.
 */
export const startInstance = (instanceId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => ({
				...inst,
				status: "starting" as const,
			})),
		}));
		yield* publishInstanceStatusChanged(instanceId);
		yield* startHealthPoller(instanceId);
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.start"),
	);

/**
 * Stop an instance — interrupt its fibers and mark it "stopped".
 */
export const stopInstance = (instanceId: string) =>
	Effect.gen(function* () {
		yield* cancelInstanceFibers(instanceId);
		const stateRef = yield* InstanceManagerStateTag;
		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => ({
				...inst,
				status: "stopped" as const,
			})),
		}));
		yield* publishInstanceStatusChanged(instanceId);
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.stop"),
	);

/**
 * Update an instance with partial field merge.
 */
export const updateInstance = (
	instanceId: string,
	updates: Partial<
		Pick<OpenCodeInstance, "name" | "port" | "env" | "managed" | "status">
	>,
) =>
	Effect.gen(function* () {
		const stateRef = yield* InstanceManagerStateTag;
		yield* Ref.update(stateRef, (s) => ({
			...s,
			instances: HashMap.modify(s.instances, instanceId, (inst) => ({
				...inst,
				...updates,
			})),
		}));
		yield* publishInstanceStatusChanged(instanceId);
		yield* requestConfigSave;
	}).pipe(
		Effect.annotateLogs("instanceId", instanceId),
		Effect.withSpan("instance.update"),
	);

/** Request config persistence. */
export const persistConfig = Effect.gen(function* () {
	yield* requestConfigSave;
}).pipe(Effect.withSpan("instance.persistConfig"));

// ─── URL helpers ────────────────────────────────────────────────────────

/**
 * Get the external URL for an instance (using the daemon's public host).
 * Returns null if the instance is not found.
 */
export const getExternalUrl = (instanceId: string, daemonHost: string) =>
	getInstance(instanceId).pipe(
		Effect.map((inst) => `http://${daemonHost}:${inst.port}`),
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
		const externalUrl = HashMap.get(state.externalUrls, instanceId);
		if (Option.isSome(externalUrl)) {
			return externalUrl.value;
		}
		return `http://localhost:${inst.value.port}`;
	}).pipe(
		Effect.catchTag("InstanceNotFound", () => Effect.succeed(null)),
		Effect.withSpan("instance.getInstanceUrl"),
	);
