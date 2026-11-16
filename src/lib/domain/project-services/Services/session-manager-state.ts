// Replaces the mutable Map fields on the imperative SessionManager class
// with a single atomic Ref<SessionManagerState>. All session subsystems
// read/write through this Ref, giving fiber-safe atomic snapshots.
//
// Pattern (mirrors DaemonState):
//   SessionManagerStateTag → Ref.Ref<SessionManagerState>
//   makeSessionManagerStateLive(initial?) → Layer providing the Tag

import {
	Context,
	type Deferred,
	Effect,
	HashMap,
	Layer,
	Ref,
	Semaphore,
} from "effect";
import type { SessionManagerError } from "./session-manager-error.js";

/**
 * Immutable state snapshot for session management.
 *
 * Each field corresponds to a private Map on the old SessionManager class:
 * - cachedParentMap: child→parent session mapping from last list fetch
 * - lastMessageAt: per-session timestamp of last message activity
 * - lastKnownSessionCount: most recent unfiltered list/initialize count
 */
export interface SessionManagerState {
	cachedParentMap: HashMap.HashMap<string, string>;
	cachedSideThreadIds: ReadonlySet<string>;
	lastMessageAt: HashMap.HashMap<string, number>;
	lastKnownSessionCount: number;
}

/** Create an empty SessionManagerState with all empty HashMaps. */
export const emptySessionManagerState = (): SessionManagerState => ({
	cachedParentMap: HashMap.empty(),
	cachedSideThreadIds: new Set(),
	lastMessageAt: HashMap.empty(),
	lastKnownSessionCount: 0,
});

/** Tag for the mutable SessionManagerState Ref in the Effect Context. */
export class SessionManagerStateTag extends Context.Service<
	SessionManagerStateTag,
	Ref.Ref<SessionManagerState>
>()("SessionManagerState") {}

/**
 * Create a Layer providing SessionManagerStateTag backed by a Ref.
 *
 * @param initial - Partial overrides merged on top of `emptySessionManagerState()`.
 *   Pass nothing for empty defaults; pass fields to seed from existing state.
 */
export const makeSessionManagerStateLive = (
	initial?: Partial<SessionManagerState>,
): Layer.Layer<SessionManagerStateTag> =>
	Layer.effect(
		SessionManagerStateTag,
		Ref.make({ ...emptySessionManagerState(), ...initial }),
	);

/** Locks a project's session manager shares with every generation that serves it. */
export interface SessionManagerCoordination {
	/** Serializes this project's triage writes (archive, settle, delete sweeps). */
	readonly triageLock: Semaphore.Semaphore;
	/** One delete per session id at a time, whichever generation asked for it. */
	readonly inFlightDeletes: Map<
		string,
		Deferred.Deferred<void, SessionManagerError>
	>;
	/**
	 * Hold the session's manager state in its owner scope before writing it.
	 * False once the session's scope closed (it was deleted): skip the write.
	 * Fails when the scope cannot open for any reason but a missing row.
	 */
	readonly hold: (
		sessionId: string,
	) => Effect.Effect<boolean, SessionManagerError>;
}

export class SessionManagerCoordinationTag extends Context.Service<
	SessionManagerCoordinationTag,
	SessionManagerCoordination
>()("SessionManagerCoordination") {}

/** Without a daemon owner every write lands, as in a standalone test harness. */
export const makeSessionManagerCoordination = (
	hold: SessionManagerCoordination["hold"] = () => Effect.succeed(true),
) =>
	Effect.map(
		Semaphore.make(1),
		(triageLock): SessionManagerCoordination => ({
			triageLock,
			inFlightDeletes: new Map(),
			hold,
		}),
	);

/** Forget one session's activity, side-thread mark and parent edges. */
export const forgetSession =
	(sessionId: string) =>
	(state: SessionManagerState): SessionManagerState => ({
		...state,
		cachedParentMap: HashMap.filter(
			state.cachedParentMap,
			(parent, child) => parent !== sessionId && child !== sessionId,
		),
		cachedSideThreadIds: new Set(
			[...state.cachedSideThreadIds].filter((id) => id !== sessionId),
		),
		lastMessageAt: HashMap.remove(state.lastMessageAt, sessionId),
	});
