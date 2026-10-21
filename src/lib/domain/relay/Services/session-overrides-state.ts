// Session Overrides State (Effect)
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
import {
	parseDefaultModel,
	type RelaySettings,
} from "../../../relay/relay-settings.js";
import type { SessionPermissionMode } from "../../../shared-types.js";
import { ConfigTag } from "./services.js";

export interface ModelOverride {
	providerID: string;
	modelID: string;
}

export interface SessionState {
	model?: ModelOverride;
	agent?: string;
	variant?: string;
	contextWindow?: string;
	permissionMode?: SessionPermissionMode;
}

export interface OverridesState {
	sessions: Map<string, SessionState & { readonly projectId?: string }>;
	processingTimeouts: Map<
		string,
		{
			readonly projectId?: string;
			readonly callback: () => Effect.Effect<void>;
			readonly token: symbol;
			readonly fired?: boolean;
		}
	>;
	processingTimeoutFibers: FiberMap.FiberMap<string, void>;
	defaultModel: ModelOverride | undefined;
	nativeDefaultModels: Map<string, ModelOverride>;
	defaultAgent: string | undefined;
	defaultVariant: string;
	defaultPermissionMode: SessionPermissionMode;
	defaultContextWindow: string;
}

export const PROCESSING_TIMEOUT_DURATION = "2 minutes" satisfies Duration.Input;

export class OverridesStateTag extends Context.Service<
	OverridesStateTag,
	Ref.Ref<OverridesState>
>()("OverridesState") {}

export const makeOverridesStateLive = (
	settings: RelaySettings = {},
): Layer.Layer<OverridesStateTag> =>
	Layer.effect(
		OverridesStateTag,
		Effect.gen(function* () {
			const processingTimeoutFibers = yield* FiberMap.make<string, void>();
			const defaultModel = parseDefaultModel(settings.defaultModel);
			return yield* Ref.make<OverridesState>({
				sessions: new Map(),
				processingTimeouts: new Map(),
				processingTimeoutFibers,
				defaultModel,
				nativeDefaultModels: new Map(),
				defaultAgent: undefined,
				defaultVariant:
					defaultModel && settings.defaultModel
						? (settings.defaultVariants?.[settings.defaultModel] ?? "")
						: "",
				defaultPermissionMode: settings.defaultPermissionMode ?? "ask",
				defaultContextWindow: "",
			});
		}),
	);

/** Session entries keep their owner even when updated outside a relay context. */
const updateSession = (
	sessionId: string,
	update: (entry: SessionState) => SessionState,
) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const config = yield* Effect.serviceOption(ConfigTag);
		yield* Ref.update(ref, (state) => {
			const entry = state.sessions.get(sessionId) ?? {};
			const sessions = new Map(state.sessions);
			sessions.set(sessionId, {
				...update(entry),
				...(entry.projectId === undefined && config._tag === "Some"
					? { projectId: config.value.slug }
					: {}),
			});
			return { ...state, sessions };
		});
	});

const isCurrentProcessingTimeout = (
	ref: Ref.Ref<OverridesState>,
	sessionId: string,
	token: symbol,
) =>
	Ref.get(ref).pipe(
		Effect.map(
			(state) => state.processingTimeouts.get(sessionId)?.token === token,
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
			const entry = state.processingTimeouts.get(sessionId);
			if (!entry || entry.token !== token || entry.fired) {
				return [false, state] as const;
			}
			const next = new Map(state.processingTimeouts);
			next.set(sessionId, { ...entry, fired: true });
			return [true, { ...state, processingTimeouts: next }] as const;
		});
		if (shouldRun) {
			yield* onTimeout();
		}
	});

const makeProcessingTimeoutEffect = (
	ref: Ref.Ref<OverridesState>,
	sessionId: string,
	duration: Duration.Input,
	token: symbol,
	onTimeout: () => Effect.Effect<void>,
) =>
	Effect.sleep(duration).pipe(
		Effect.andThen(completeProcessingTimeout(ref, sessionId, token, onTimeout)),
	);

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
		const config = yield* Effect.serviceOption(ConfigTag);
		return (
			state.defaultModel ??
			(config._tag === "Some"
				? state.nativeDefaultModels.get(config.value.slug)
				: undefined)
		);
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

/** Set the global default permission mode. */
export const setDefaultPermissionMode = (mode: SessionPermissionMode) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		yield* Ref.update(ref, (s) => ({ ...s, defaultPermissionMode: mode }));
	});

/** Get the global default permission mode. */
export const getDefaultPermissionMode = () =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.defaultPermissionMode;
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

/** Set the model stored for a session. */
export const setModel = (sessionId: string, model: ModelOverride) =>
	updateSession(sessionId, (entry) => ({ ...entry, model }));

/** Get the session model; missing picks never inherit a default. */
export const getModel = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.model;
	});

/** Set the agent override for a session. */
export const setAgent = (sessionId: string, agent: string) =>
	updateSession(sessionId, (entry) => ({ ...entry, agent }));

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

/** Set the variant (thinking level) for a session. Empty string clears. */
export const setVariant = (sessionId: string, variant: string) =>
	updateSession(sessionId, (entry) => ({ ...entry, variant }));

/** Get the session effort. */
export const getVariant = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.variant ?? "";
	});

/** Set the approval mode for a session. */
export const setPermissionMode = (
	sessionId: string,
	mode: SessionPermissionMode,
) => updateSession(sessionId, (entry) => ({ ...entry, permissionMode: mode }));

/**
 * Get the approval mode for a session. A session that has never chosen a mode
 * uses the configured default, which is "ask" until it is set.
 */
export const getPermissionMode = (
	sessionId: string,
): Effect.Effect<SessionPermissionMode, never, OverridesStateTag> =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return (
			state.sessions.get(sessionId)?.permissionMode ??
			state.defaultPermissionMode
		);
	});

/** Set the context window for a session. Empty string clears. */
export const setContextWindow = (sessionId: string, contextWindow: string) =>
	updateSession(sessionId, (entry) => ({ ...entry, contextWindow }));

/** Get the session context window. */
export const getContextWindow = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		return state.sessions.get(sessionId)?.contextWindow ?? "";
	});

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
			const timeouts = new Map(state.processingTimeouts);
			timeouts.delete(sessionId);
			return [
				state.processingTimeoutFibers,
				{ ...state, sessions: next, processingTimeouts: timeouts },
			] as const;
		});
		yield* FiberMap.remove(timeoutFibers, sessionId);
	});

/** Permanent removal clears project state; relay replacement never calls this. */
export const clearProject = (projectId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const { timeoutFibers, sessionIds } = yield* Ref.modify(ref, (state) => {
			const sessions = new Map(state.sessions);
			for (const [id, entry] of sessions)
				if (entry.projectId === projectId) sessions.delete(id);
			const processingTimeouts = new Map(state.processingTimeouts);
			const sessionIds: string[] = [];
			for (const [id, entry] of processingTimeouts) {
				if (entry.projectId !== projectId) continue;
				processingTimeouts.delete(id);
				sessionIds.push(id);
			}
			const nativeDefaultModels = new Map(state.nativeDefaultModels);
			nativeDefaultModels.delete(projectId);
			return [
				{ timeoutFibers: state.processingTimeoutFibers, sessionIds },
				{ ...state, sessions, processingTimeouts, nativeDefaultModels },
			] as const;
		});
		yield* Effect.forEach(
			sessionIds,
			(id) => FiberMap.remove(timeoutFibers, id),
			{
				discard: true,
			},
		);
	});

/**
 * Start a processing timeout for a session.
 * Cancels any existing timeout fiber, then forks a new fiber that
 * sleeps for `duration` and executes `onTimeout`.
 */
export const startProcessingTimeout = (
	sessionId: string,
	duration: Duration.Input,
	onTimeout: () => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const config = yield* Effect.serviceOption(ConfigTag);
		const token = Symbol(sessionId);
		const timeoutFibers = yield* Ref.modify(ref, (state) => {
			const next = new Map(state.processingTimeouts);
			const projectId =
				config._tag === "Some"
					? config.value.slug
					: state.sessions.get(sessionId)?.projectId;
			next.set(sessionId, {
				...(projectId === undefined ? {} : { projectId }),
				callback: onTimeout,
				token,
			});
			return [
				state.processingTimeoutFibers,
				{ ...state, processingTimeouts: next },
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
 * No-op if the session has no silence callback (for example, after its run ends).
 */
export const resetProcessingTimeout = (
	sessionId: string,
	duration: Duration.Input,
) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const resetState = yield* Ref.modify(ref, (state) => {
			const entry = state.processingTimeouts.get(sessionId);
			if (!entry) {
				return [undefined, state] as const;
			}
			const token = Symbol(sessionId);
			const next = new Map(state.processingTimeouts);
			next.set(sessionId, { ...entry, token, fired: false });
			return [
				{
					callback: entry.callback,
					timeoutFibers: state.processingTimeoutFibers,
					token,
				},
				{ ...state, processingTimeouts: next },
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

/** Sink hooks that keep a turn's processing timeout in step with its output. */
export const makeProcessingTimeoutHooks = (
	runtime: Context.Context<OverridesStateTag>,
	sessionId: string,
) => {
	const run = Effect.runForkWith(runtime);
	return {
		clearTimeout: () => {
			run(clearProcessingTimeout(sessionId));
		},
		resetTimeout: () => {
			run(resetProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION));
		},
	};
};

/** Cancel the processing timeout for a specific session. */
export const clearProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const timeoutFibers = yield* Ref.modify(ref, (state) => {
			if (!state.processingTimeouts.has(sessionId))
				return [state.processingTimeoutFibers, state] as const;
			const next = new Map(state.processingTimeouts);
			next.delete(sessionId);
			return [
				state.processingTimeoutFibers,
				{ ...state, processingTimeouts: next },
			] as const;
		});
		yield* FiberMap.remove(timeoutFibers, sessionId);
	});

/** Check if a session has an active processing timeout. */
export const hasActiveProcessingTimeout = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		const entry = state.processingTimeouts.get(sessionId);
		return entry !== undefined && !entry.fired;
	});

/** Get raw session state (for tests). */
export const getOverrides = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* OverridesStateTag;
		const state = yield* Ref.get(ref);
		const entry = state.sessions.get(sessionId);
		if (!entry) return undefined;
		const { projectId: _, ...overrides } = entry;
		return overrides;
	});
