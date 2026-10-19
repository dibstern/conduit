import {
	type Deferred,
	Effect,
	Equal,
	HashMap,
	HashSet,
	Option,
	Ref,
} from "effect";
import type { ClaudeProviderRuntimeState } from "./claude-provider-runtime.js";
import type { ClaudeSessionContext } from "./types.js";

export const getOrUndefined = <A>(option: Option.Option<A>): A | undefined =>
	Option.isSome(option) ? option.value : undefined;

export function getState(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
): Effect.Effect<ClaudeProviderRuntimeState> {
	return Ref.get(stateRef);
}

export function getSession(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<ClaudeSessionContext | undefined> {
	return Effect.map(getState(stateRef), (state) =>
		getOrUndefined(HashMap.get(state.sessions, sessionId)),
	);
}

export function isCurrentSession(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
): Effect.Effect<boolean> {
	return Effect.map(
		getSession(stateRef, ctx.sessionId),
		(current) => current === ctx,
	);
}

export function setSession(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	ctx: ClaudeSessionContext,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => ({
		...state,
		// Live contexts own mutable SDK resources and use identity for ownership.
		sessions: HashMap.set(
			state.sessions,
			sessionId,
			Equal.byReferenceUnsafe(ctx),
		),
	}));
}

export function removeSession(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => ({
		...state,
		sessions: HashMap.remove(state.sessions, sessionId),
		endedStreams: HashSet.remove(state.endedStreams, sessionId),
		shutdownAfterTurn: HashSet.remove(state.shutdownAfterTurn, sessionId),
	}));
}

export function getSetupLock(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<Deferred.Deferred<void, Error> | undefined> {
	return Effect.map(getState(stateRef), (state) =>
		getOrUndefined(HashMap.get(state.setupLocks, sessionId)),
	);
}

export function claimSetupLock(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	deferred: Deferred.Deferred<void, Error>,
): Effect.Effect<Deferred.Deferred<void, Error> | undefined> {
	return Ref.modify(stateRef, (state) => {
		const existing = getOrUndefined(HashMap.get(state.setupLocks, sessionId));
		return existing
			? [existing, state]
			: [
					undefined,
					{
						...state,
						setupLocks: HashMap.set(state.setupLocks, sessionId, deferred),
					},
				];
	});
}

export function removeSetupLock(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => ({
		...state,
		setupLocks: HashMap.remove(state.setupLocks, sessionId),
	}));
}

export function isStreamEnded(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<boolean> {
	return Effect.map(getState(stateRef), (state) =>
		HashSet.has(state.endedStreams, sessionId),
	);
}

export function markStreamLive(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => ({
		...state,
		endedStreams: HashSet.remove(state.endedStreams, sessionId),
	}));
}

export function markStreamEnded(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => ({
		...state,
		endedStreams: HashSet.add(state.endedStreams, sessionId),
	}));
}
