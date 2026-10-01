import { Effect, HashMap, Ref } from "effect";
export interface ForkEntry {
	readonly parentID: string;
	readonly forkMessageId: string;
	readonly forkPointTimestamp?: number;
}

import { applySessionCommand } from "./session-command.js";
import { SessionManagerError } from "./session-manager-error.js";
import { SessionManagerStateTag } from "./session-manager-state.js";

/**
 * Record message activity for a session (updates lastMessageAt timestamp).
 */
export const recordMessageActivity = (sessionId: string, timestamp?: number) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const ts = timestamp ?? Date.now();
		yield* Ref.update(ref, (s) => {
			const existing = HashMap.get(s.lastMessageAt, sessionId);
			if (existing._tag === "Some" && existing.value >= ts) return s;
			return {
				...s,
				lastMessageAt: HashMap.set(s.lastMessageAt, sessionId, ts),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.recordMessageActivity"),
	);

/** Record an eager child-to-parent session mapping. */
export const addToParentMap = (childId: string, parentId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			cachedParentMap: HashMap.set(s.cachedParentMap, childId, parentId),
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", childId),
		Effect.withSpan("session.addToParentMap"),
	);

/** Snapshot the current child-to-parent session map. */
export const getSessionParentMap = () =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const state = yield* Ref.get(ref);
		return new Map(HashMap.toEntries(state.cachedParentMap));
	}).pipe(Effect.withSpan("session.getSessionParentMap"));

/** Snapshot the most recently observed unfiltered session count. */
export const getLastKnownSessionCount = () =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const state = yield* Ref.get(ref);
		return state.lastKnownSessionCount;
	}).pipe(Effect.withSpan("session.getLastKnownSessionCount"));

/**
 * Record fork lineage through the event store and announce the projected row.
 */
export const setForkEntry = (sessionId: string, entry: ForkEntry) =>
	Effect.gen(function* () {
		if (entry.parentID) {
			yield* applySessionCommand({
				type: "session.forked",
				data: {
					sessionId,
					parentId: entry.parentID,
					...(entry.forkMessageId
						? { forkPointEvent: entry.forkMessageId }
						: {}),
					...(entry.forkPointTimestamp != null
						? { forkPointTimestamp: entry.forkPointTimestamp }
						: {}),
				},
			}).pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({ operation: "setForkEntry", cause }),
				),
			);
		}

		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			cachedParentMap: entry.parentID
				? HashMap.set(s.cachedParentMap, sessionId, entry.parentID)
				: s.cachedParentMap,
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.setForkEntry"),
	);
