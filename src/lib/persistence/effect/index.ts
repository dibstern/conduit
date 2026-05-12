// ──��� Effect Persistence Barrel ──────────────────────────────────────────────
// Re-exports all Effect-based persistence services.

export {
	EventStoreEffect,
	EventStoreEffectTag,
	EventStoreError,
	makeEventStoreEffect,
} from "./event-store-effect.js";
export {
	makeProjectionRunnerEffect,
	type ProjectionFailure,
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
	type RecoveryResult,
} from "./projection-runner-effect.js";
export {
	CursorError,
	makeProjectorCursorEffect,
	type ProjectorCursor,
	ProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "./projector-cursor-effect.js";
export {
	createAllEffectProjectors,
	type EffectProjector,
	makeActivityProjector,
	makeApprovalProjector,
	makeMessageProjector,
	makeProviderProjector,
	makeSessionProjector,
	makeTurnProjector,
	type ProjectionContext,
	ProjectionError,
} from "./projectors-effect.js";
export {
	makeProviderStateEffect,
	type ProviderStateEffect,
	ProviderStateEffectError,
	ProviderStateEffectTag,
	type ProviderStateEffectUpdate,
} from "./provider-state-effect.js";
export {
	makeReadQueryEffect,
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "./read-query-effect.js";
