// ─── Session Overrides State (Effect) ──────────────────────────────────────
// Effect-native replacement for the imperative SessionOverrides class.
// Uses Ref<OverridesState> for atomic state and Fiber for timeout management.
//
// Pattern (mirrors SessionRegistryState / SessionManagerState):
//   OverridesStateTag → Ref.Ref<OverridesState>
//   makeOverridesStateLive() → Layer providing the Tag
//   Pure functions: setModel, getModel, setAgent, getAgent, etc.
//
// Uses native Map (not HashMap) because SessionState contains
// Fiber.RuntimeFiber references. Documented exception per conventions.

import { Context, type Duration, Effect, Fiber, Layer, Ref } from "effect";

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
	processingTimeoutFiber?: Fiber.RuntimeFiber<void>;
	processingTimeoutCallback?: () => Effect.Effect<void>;
}

export interface OverridesState {
	sessions: Map<string, SessionState>;
	defaultModel: ModelOverride | undefined;
	defaultAgent: string | undefined;
	defaultVariant: string;
	defaultContextWindow: string;
}

// ─── Context Tag ────────────────────────────────────────────────────────────

export class OverridesStateTag extends Context.Tag("OverridesState")<
	OverridesStateTag,
	Ref.Ref<OverridesState>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

export const makeOverridesStateLive = (): Layer.Layer<OverridesStateTag> =>
	Layer.effect(
		OverridesStateTag,
		Ref.make<OverridesState>({
			sessions: new Map(),
			defaultModel: undefined,
			defaultAgent: undefined,
			defaultVariant: "",
			defaultContextWindow: "",
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
		// Read fiber reference first, then update state, then interrupt.
		// Fiber.interrupt is an Effect so it cannot live inside Ref.update.
		const fiber = yield* Ref.modify(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			const fib = entry?.processingTimeoutFiber;
			const next = new Map(state.sessions);
			next.delete(sessionId);
			return [fib, { ...state, sessions: next }] as const;
		});
		if (fiber) {
			yield* Fiber.interrupt(fiber);
		}
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

		// Cancel existing fiber (if any)
		const oldFiber = yield* Ref.modify(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			return [entry?.processingTimeoutFiber, state] as const;
		});
		if (oldFiber) {
			yield* Fiber.interrupt(oldFiber);
		}

		// Fork a new timeout fiber (scoped — interrupted when scope closes)
		const fiber = yield* Effect.sleep(duration).pipe(
			Effect.andThen(onTimeout()),
			Effect.forkScoped,
		);

		// Store the fiber and callback in session state
		yield* Ref.update(ref, (state) => {
			const [sessions, entry] = getOrCreate(state.sessions, sessionId);
			const next = new Map(sessions);
			next.set(sessionId, {
				...entry,
				processingTimeoutFiber: fiber,
				processingTimeoutCallback: onTimeout,
			});
			return { ...state, sessions: next };
		});
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
		const state = yield* Ref.get(ref);
		const entry = state.sessions.get(sessionId);
		const cb = entry?.processingTimeoutCallback;
		const fib = entry?.processingTimeoutFiber;

		if (!fib || !cb) return; // no-op

		// Interrupt old fiber
		yield* Fiber.interrupt(fib);

		// Fork new timeout fiber
		const newFiber = yield* Effect.sleep(duration).pipe(
			Effect.andThen(cb()),
			Effect.forkScoped,
		);

		// Update state with new fiber (keep same callback)
		yield* Ref.update(ref, (s) => {
			const existing = s.sessions.get(sessionId);
			if (!existing) return s;
			const next = new Map(s.sessions);
			next.set(sessionId, {
				...existing,
				processingTimeoutFiber: newFiber,
			});
			return { ...s, sessions: next };
		});
	});

/** Cancel the processing timeout for a specific session. */
export const clearProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const fiber = yield* Ref.modify(ref, (state) => {
			const entry = state.sessions.get(sessionId);
			if (!entry) return [undefined, state] as const;
			const fib = entry.processingTimeoutFiber;
			const next = new Map(state.sessions);
			const {
				processingTimeoutFiber: _,
				processingTimeoutCallback: __,
				...rest
			} = entry;
			next.set(sessionId, rest);
			return [fib, { ...state, sessions: next }] as const;
		});
		if (fiber) {
			yield* Fiber.interrupt(fiber);
		}
	});

/** Check if a session has an active processing timeout. */
export const hasActiveProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.processingTimeoutFiber !== undefined;
	});

// ─── Debug / Test ───────────────────────────────────────────────────────────

/** Get raw session state (for tests). */
export const getOverrides = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId);
	});
