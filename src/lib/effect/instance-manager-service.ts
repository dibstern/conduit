// ─── InstanceManager Service (Effect) ───────────────────────────────────────
// Per-instance fibers + acquireRelease for health polling.
// State lives in InstanceManagerStateTag (Ref<InstanceManagerState>);
// health poll fibers are tracked in PollerFibersTag (FiberMap<string>).
//
// Exported free functions can be used directly in Effect pipelines.
// addInstance uses atomic Ref.modify for capacity enforcement — two
// concurrent addInstance calls cannot both pass the capacity check.

import { Context, Data, Effect, FiberMap, HashMap, Layer, Ref } from "effect";
import type { InstanceConfig, OpenCodeInstance } from "../shared-types.js";

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
}

const DEFAULT_CONFIG: InstanceManagerConfig = { maxInstances: 5 };

// ─── State ────────────────────────────────────────────────────────────────

export interface InstanceManagerState {
	instances: HashMap.HashMap<string, OpenCodeInstance>;
	config: InstanceManagerConfig;
}

export const emptyInstanceManagerState = (
	config?: Partial<InstanceManagerConfig>,
): InstanceManagerState => ({
	instances: HashMap.empty(),
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

// ─── Internal: health poll fiber ──────────────────────────────────────────

/**
 * A no-op health poll fiber that stays alive until interrupted.
 * In production this would do periodic health checks; in tests it just
 * needs to exist so FiberMap tracks it.
 */
const healthPollFiber = (_instanceId: string) =>
	Effect.never.pipe(Effect.interruptible);

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

		const now = Date.now();
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
		yield* FiberMap.run(fiberMap, input.id, healthPollFiber(input.id));
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
		}));

		yield* FiberMap.remove(fiberMap, instanceId);
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
