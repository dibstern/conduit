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
	Data,
	Duration,
	Effect,
	FiberMap,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
} from "effect";
import type { InstanceConfig, OpenCodeInstance } from "../shared-types.js";
import {
	publishInstanceError,
	publishInstanceStatusChanged,
} from "./daemon-pubsub.js";

// ─── Error types ──────────────────────────────────────────────────────────

export class InstanceLimitExceeded extends Data.TaggedError(
	"InstanceLimitExceeded",
)<{
	max: number;
}> {}

export class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
	id: string;
}> {}

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

const DEFAULT_CONFIG: InstanceManagerConfig = {
	maxInstances: 5,
	healthPollIntervalMs: 5000,
	maxRestartsPerWindow: 5,
	restartWindowMs: 60_000,
};

// ─── State ────────────────────────────────────────────────────────────────

export interface InstanceManagerState {
	instances: HashMap.HashMap<string, OpenCodeInstance>;
	restartTimestamps: HashMap.HashMap<string, ReadonlyArray<number>>;
	config: InstanceManagerConfig;
}

export const emptyInstanceManagerState = (
	config?: Partial<InstanceManagerConfig>,
): InstanceManagerState => ({
	instances: HashMap.empty(),
	restartTimestamps: HashMap.empty(),
	config: { ...DEFAULT_CONFIG, ...config },
});

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
export const makeInstanceManagerStateLive = (
	config?: Partial<InstanceManagerConfig>,
): Layer.Layer<InstanceManagerStateTag | PollerFibersTag> =>
	Layer.scoped(
		InstanceManagerStateTag,
		Ref.make(emptyInstanceManagerState(config)),
	).pipe(Layer.merge(Layer.scoped(PollerFibersTag, FiberMap.make<string>())));

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
		const capacityError = yield* Ref.modify(ref, (state) => {
			const currentSize = HashMap.size(state.instances);
			if (currentSize >= state.config.maxInstances) {
				// Over capacity — return error marker, leave state unchanged
				return [state.config.maxInstances, state] as const;
			}
			// Under capacity — reserve the slot atomically
			const newInstances = HashMap.set(state.instances, input.id, instance);
			return [undefined, { ...state, instances: newInstances }] as const;
		});

		if (capacityError !== undefined) {
			return yield* new InstanceLimitExceeded({ max: capacityError });
		}

		// Start health poll fiber — FiberMap auto-interrupts if one already exists for this key
		yield* FiberMap.run(
			fiberMap,
			pollerKey(input.id),
			Effect.never.pipe(Effect.interruptible),
		);
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
			restartTimestamps: HashMap.remove(state.restartTimestamps, instanceId),
		}));

		yield* FiberMap.remove(fiberMap, pollerKey(instanceId));
		yield* FiberMap.remove(fiberMap, restartKey(instanceId));
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
			return yield* new InstanceNotFound({ id: instanceId });
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
