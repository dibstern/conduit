import { Effect, HashMap, Option, Ref } from "effect";
import {
	type ForkEntry,
	saveForkMetadata,
} from "../../../daemon/fork-metadata.js";
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

/** Increment pending question count for a session. */
export const incrementPendingQuestionCount = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => {
			const current = Option.getOrElse(
				HashMap.get(s.pendingQuestionCounts, sessionId),
				() => 0,
			);
			return {
				...s,
				pendingQuestionCounts: HashMap.set(
					s.pendingQuestionCounts,
					sessionId,
					current + 1,
				),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.incrementPendingQuestionCount"),
	);

/** Decrement pending question count for a session and clear zero counts. */
export const decrementPendingQuestionCount = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => {
			const current = Option.getOrElse(
				HashMap.get(s.pendingQuestionCounts, sessionId),
				() => 0,
			);
			return {
				...s,
				pendingQuestionCounts:
					current <= 1
						? HashMap.remove(s.pendingQuestionCounts, sessionId)
						: HashMap.set(s.pendingQuestionCounts, sessionId, current - 1),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.decrementPendingQuestionCount"),
	);

/** Replace pending question counts from a reconnect/list-pending snapshot. */
export const setPendingQuestionCounts = (counts: ReadonlyMap<string, number>) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			pendingQuestionCounts: HashMap.fromIterable(counts),
		}));
	}).pipe(Effect.withSpan("session.setPendingQuestionCounts"));

/**
 * Record fork-point metadata for a forked session: lineage into the event
 * store, the whole entry into relay state and the on-disk sidecar.
 *
 * The canonical event records fork origin separately from subagent lineage.
 * The sidecar retains the fork-point timestamp, which has no column.
 */
export const setForkEntry = (
	sessionId: string,
	entry: ForkEntry,
	configDir?: string,
) =>
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
		const forkMeta = yield* Ref.modify(ref, (s) => {
			const nextForkMeta = HashMap.set(s.forkMeta, sessionId, entry);
			return [
				nextForkMeta,
				{
					...s,
					forkMeta: nextForkMeta,
					cachedParentMap: HashMap.remove(s.cachedParentMap, sessionId),
				},
			] as const;
		});

		yield* Effect.try({
			try: () =>
				saveForkMetadata(new Map(HashMap.toEntries(forkMeta)), configDir),
			catch: (cause) =>
				new SessionManagerError({ operation: "setForkEntry", cause }),
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.setForkEntry"),
	);
