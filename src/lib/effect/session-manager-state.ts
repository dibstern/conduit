// ─── SessionManagerState Ref & Tag ──────────────────────────────────────────
// Replaces the mutable Map fields on the imperative SessionManager class
// with a single atomic Ref<SessionManagerState>. All session subsystems
// read/write through this Ref, giving fiber-safe atomic snapshots.
//
// Pattern (mirrors DaemonState):
//   SessionManagerStateTag → Ref.Ref<SessionManagerState>
//   makeSessionManagerStateLive(initial?) → Layer providing the Tag

import { Context, HashMap, Layer, Ref } from "effect";
import type { ForkEntry } from "../daemon/fork-metadata.js";
export type { ForkEntry };

// ─── SessionManagerState ────────────────────────────────────────────────────

/**
 * Immutable state snapshot for session management.
 *
 * Each field corresponds to a private Map on the old SessionManager class:
 * - cachedParentMap: child→parent session mapping from last list fetch
 * - lastMessageAt: per-session timestamp of last message activity
 * - forkMeta: per-session fork-point metadata
 * - pendingQuestionCounts: per-session count of pending questions
 * - paginationCursors: per-session cursor for paginated history loading
 * - lastKnownSessionCount: most recent unfiltered list/initialize count
 */
export interface SessionManagerState {
	cachedParentMap: HashMap.HashMap<string, string>;
	lastMessageAt: HashMap.HashMap<string, number>;
	forkMeta: HashMap.HashMap<string, ForkEntry>;
	pendingQuestionCounts: HashMap.HashMap<string, number>;
	paginationCursors: HashMap.HashMap<string, string>;
	lastKnownSessionCount: number;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Create an empty SessionManagerState with all empty HashMaps. */
export const emptySessionManagerState = (): SessionManagerState => ({
	cachedParentMap: HashMap.empty(),
	lastMessageAt: HashMap.empty(),
	forkMeta: HashMap.empty(),
	pendingQuestionCounts: HashMap.empty(),
	paginationCursors: HashMap.empty(),
	lastKnownSessionCount: 0,
});

// ─── Context Tag ────────────────────────────────────────────────────────────

/** Tag for the mutable SessionManagerState Ref in the Effect Context. */
export class SessionManagerStateTag extends Context.Tag("SessionManagerState")<
	SessionManagerStateTag,
	Ref.Ref<SessionManagerState>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

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
