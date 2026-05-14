// ─── Session Overrides State (Effect) ──────────────────────────────────────
// Effect-native replacement for the imperative SessionOverrides class.
// Uses Ref<OverridesState> for atomic state and FiberMap for timeout management.
//
// Pattern (mirrors SessionRegistryState / SessionManagerState):
//   OverridesStateTag → Ref.Ref<OverridesState>
//   makeOverridesStateLive() → Layer providing the Tag
//   Pure functions: setModel, getModel, setAgent, getAgent, etc.
//
// Uses native Map (not HashMap) because this state is an in-memory owner for
// runtime resources and callback closures. Documented exception per conventions.

import {
	Context,
	type Duration,
	Effect,
	Fiber,
	FiberMap,
	Layer,
	Ref,
} from "effect";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelOverride {
	providerID: string;
	modelID: string;
}

export interface SessionState {
	model?: ModelOverride;
	agent?: string;
	variant?: string;
	contextWindow?: string;
	modelUserSelected: boolean;
	processingTimeoutCallback?: () => Effect.Effect<void>;
	processingTimeoutToken?: symbol;
}

export interface OverridesState {
	sessions: Map<string, SessionState>;
	processingTimeoutFibers: FiberMap.FiberMap<string, void>;
	defaultModel: ModelOverride | undefined;
	defaultAgent: string | undefined;
	defaultVariant: string;
	defaultContextWindow: string;
}

export const PROCESSING_TIMEOUT_DURATION =
	"2 minutes" satisfies Duration.DurationInput;

// ─── Context Tag ────────────────────────────────────────────────────────────

export class OverridesStateTag extends Context.Tag("OverridesState")<
	OverridesStateTag,
	Ref.Ref<OverridesState>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

export const makeOverridesStateLive = (): Layer.Layer<OverridesStateTag> =>
	Layer.scoped(
		OverridesStateTag,
		Effect.gen(function* () {
			const processingTimeoutFibers = yield* FiberMap.make<string, void>();
			return yield* Ref.make<OverridesState>({
				sessions: new Map(),
				processingTimeoutFibers,
				defaultModel: undefined,
				defaultAgent: undefined,
				defaultVariant: "",
				defaultContextWindow: "",
			});
		}),
	);

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get or create a session entry. Pure — returns a new Map when creating. */
const getOrCreate = (
	sessions: Map<string, SessionState>,
	sessionId: string,
): [Map<string, SessionState>, SessionState] => {
	const existing = sessions.get(sessionId);
	if (existing) return [sessions, existing];
	const fresh: SessionState = { modelUserSelected: false };
	const next = new Map(sessions);
	next.set(sessionId, fresh);
	return [next, fresh];
};

const withoutProcessingTimeout = (entry: SessionState): SessionState => {
	const {
		processingTimeoutCallback: _,
		processingTimeoutToken: __,
		...rest
	} = entry;
	return rest;
};

const isCurrentProcessingTimeout = (
	ref: Ref.Ref<OverridesState>,
	sessionId: string,
	token: symbol,
) =>
	Ref.get(ref).pipe(
		Effect.map(
			(state) =>
				state.sessions.get(sessionId)?.processingTimeoutToken === token,
		),
	);

const completeProcessingTimeout = (
	ref: Ref.Ref<OverridesState>,
	sessionId: string,
	token: symbol,
	onTimeout: () => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const shouldRun = yield* Ref.modify(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			if (!entry || entry.processingTimeoutToken !== token) {
				return [false, state] as const;
			}
			const next = new Map(state.sessions);
			next.set(sessionId, withoutProcessingTimeout(entry));
			return [true, { ...state, sessions: next }] as const;
		});
		if (shouldRun) {
			yield* onTimeout();
		}
	});

const makeProcessingTimeoutEffect = (
	ref: Ref.Ref<OverridesState>,
	sessionId: string,
	duration: Duration.DurationInput,
	token: symbol,
	onTimeout: () => Effect.Effect<void>,
) =>
	Effect.sleep(duration).pipe(
		Effect.andThen(completeProcessingTimeout(ref, sessionId, token, onTimeout)),
	);

// ─── Default Model / Variant ────────────────────────────────────────────────

/** Set the global default model. */
export const setDefaultModel = (model: ModelOverride) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (s) => ({ ...s, defaultModel: model }));
	});

/** Get the global default model. */
export const getDefaultModel = () =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.defaultModel;
	});

/** Set the global default agent. */
export const setDefaultAgent = (agent: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (s) => ({ ...s, defaultAgent: agent }));
	});

/** Get the global default agent. */
export const getDefaultAgent = () =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.defaultAgent;
	});

/** Set the global default variant. */
export const setDefaultVariant = (variant: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (s) => ({ ...s, defaultVariant: variant }));
	});

/** Get the global default variant. */
export const getDefaultVariant = () =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.defaultVariant;
	});

/** Set the global default context window. */
export const setDefaultContextWindow = (contextWindow: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			defaultContextWindow: contextWindow,
		}));
	});

/** Get the global default context window. */
export const getDefaultContextWindow = () =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.defaultContextWindow;
	});

// ─── Per-Session Model ──────────────────────────────────────────────────────

/** Set model for a session AND mark as user-selected. */
export const setModel = (sessionId: string, model: ModelOverride) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, { ...entry, model, modelUserSelected: true });
			return { ...state, sessions: next };
		});
	});

/** Set model for display WITHOUT marking as user-selected (auto-detected). */
export const setModelDefault = (sessionId: string, model: ModelOverride) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, { ...entry, model });
			return { ...state, sessions: next };
		});
	});

/** Get the effective model for a session (per-session ?? defaultModel). */
export const getModel = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.model ?? state.defaultModel;
	});

/** Whether the user explicitly selected a model for this session. */
export const isModelUserSelected = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.modelUserSelected ?? false;
	});

// ─── Per-Session Agent ──────────────────────────────────────────────────────

/** Set the agent override for a session. */
export const setAgent = (sessionId: string, agent: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, { ...entry, agent });
			return { ...state, sessions: next };
		});
	});

/** Get the agent override for a session. */
export const getAgent = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.agent ?? state.defaultAgent;
	});

/** Clear the agent override for a session without touching other overrides. */
export const clearAgent = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			if (!entry?.agent) return state;
			const next = new Map(state.sessions);
			const { agent: _, ...rest } = entry;
			next.set(sessionId, rest);
			return { ...state, sessions: next };
		});
	});

// ─── Per-Session Variant ────────────────────────────────────────────────────

/** Set the variant (thinking level) for a session. Empty string clears. */
export const setVariant = (sessionId: string, variant: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, { ...entry, variant });
			return { ...state, sessions: next };
		});
	});

/** Get the variant for a session (per-session ?? defaultVariant). */
export const getVariant = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.variant ?? state.defaultVariant;
	});

// ─── Per-Session Context Window ─────────────────────────────────────────────

/** Set the context window for a session. Empty string clears. */
export const setContextWindow = (sessionId: string, contextWindow: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, { ...entry, contextWindow });
			return { ...state, sessions: next };
		});
	});

/** Get the context window for a session (per-session ?? defaultContextWindow). */
export const getContextWindow = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return (
			state.sessions.get(sessionId)?.contextWindow ?? state.defaultContextWindow
		);
	});

// ─── Clear Session ──────────────────────────────────────────────────────────

/**
 * Clear all overrides for a specific session (model, agent, variant,
 * context window, timer).
 * Interrupts any active processing timeout fiber.
 */
export const clearSession = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const timeoutFibers = yield* Ref.modify(ref, (state) => {
			const next = new Map(state.sessions);
			next.delete(sessionId);
			return [
				state.processingTimeoutFibers,
				{ ...state, sessions: next },
			] as const;
		});
		yield* FiberMap.remove(timeoutFibers, sessionId);
	});

// ─── Processing Timeout ─────────────────────────────────────────────────────

/**
 * Start a processing timeout for a session.
 * Cancels any existing timeout fiber, then forks a new fiber that
 * sleeps for `duration` and executes `onTimeout`.
 */
export const startProcessingTimeout = (
	sessionId: string,
	duration: Duration.DurationInput,
	onTimeout: () => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const token = Symbol(sessionId);
		const timeoutFibers = yield* Ref.modify(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, {
				...entry,
				processingTimeoutCallback: onTimeout,
				processingTimeoutToken: token,
			});
			return [
				state.processingTimeoutFibers,
				{ ...state, sessions: next },
			] as const;
		});

		const fiber = yield* FiberMap.run(
			timeoutFibers,
			sessionId,
			makeProcessingTimeoutEffect(ref, sessionId, duration, token, onTimeout),
		);

		if (!(yield* isCurrentProcessingTimeout(ref, sessionId, token))) {
			yield* Fiber.interrupt(fiber);
		}
	});

/**
 * Reset the processing timeout back to the given duration with the same callback.
 * No-op if no timeout is currently active for the session.
 */
export const resetProcessingTimeout = (
	sessionId: string,
	duration: Duration.DurationInput,
) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const resetState = yield* Ref.modify(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			const cb = entry?.processingTimeoutCallback;
			if (!entry?.processingTimeoutToken || !cb) {
				return [undefined, state] as const;
			}
			const token = Symbol(sessionId);
			const next = new Map(state.sessions);
			next.set(sessionId, {
				...entry,
				processingTimeoutCallback: cb,
				processingTimeoutToken: token,
			});
			return [
				{ callback: cb, timeoutFibers: state.processingTimeoutFibers, token },
				{ ...state, sessions: next },
			] as const;
		});
		if (!resetState) return;

		const fiber = yield* FiberMap.run(
			resetState.timeoutFibers,
			sessionId,
			makeProcessingTimeoutEffect(
				ref,
				sessionId,
				duration,
				resetState.token,
				resetState.callback,
			),
		);

		if (
			!(yield* isCurrentProcessingTimeout(ref, sessionId, resetState.token))
		) {
			yield* Fiber.interrupt(fiber);
		}
	});

/** Cancel the processing timeout for a specific session. */
export const clearProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const timeoutFibers = yield* Ref.modify(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			if (!entry) return [state.processingTimeoutFibers, state] as const;
			const next = new Map(state.sessions);
			next.set(sessionId, withoutProcessingTimeout(entry));
			return [
				state.processingTimeoutFibers,
				{ ...state, sessions: next },
			] as const;
		});
		yield* FiberMap.remove(timeoutFibers, sessionId);
	});

/** Check if a session has an active processing timeout. */
export const hasActiveProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.processingTimeoutToken !== undefined;
	});

// ─── Debug / Test ───────────────────────────────────────────────────────────

/** Get raw session state (for tests). */
export const getOverrides = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId);
	});
