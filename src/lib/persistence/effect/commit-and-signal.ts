import {
	Clock,
	Context,
	Data,
	Effect,
	Option,
	Ref,
	Schedule,
	Scheduler,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ReadModelAdvance } from "../../contracts/read-model-advance.js";
import { observeTurnTimelineCommit } from "../../domain/daemon/Services/turn-timeline.js";
import { EventRetentionSchedulerTag } from "../../domain/persistence/Services/event-retention-scheduler.js";
import { SessionEventBusTag } from "../../domain/relay/Services/session-event-bus.js";
import {
	type StoreFault,
	settleSend,
} from "../../provider/runner/send-settlement.js";
import {
	runSendCommandIdQuery,
	stopCovers,
} from "../../provider/session-run-settlement.js";
import { contentionMetrics } from "../contention-metrics.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type EventPayloadMap,
	type StoredEvent,
} from "../events.js";
import { SESSION_SUBTREE_SQL } from "../projectors/session-handlers.js";
import { boundProjectMismatch } from "./bind-event-store-effect.js";
import {
	EventStoreEffectTag,
	EventStoreError,
	type UnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "./event-store-effect.js";
import { requeueFailedSteers } from "./input-requeue-effect.js";
import type { ProjectionRunnerError } from "./projection-runner-effect.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";
import { mergeTouches } from "./projectors-effect.js";
import { SessionRollupProjects } from "./session-rollup-projects.js";
import { SessionStateProjectionNotifierTag } from "./session-state-projection-notifier.js";
import { readSessionWorktreeOwnershipSnapshot } from "./session-worktree-ownership.js";
import { refreshSidebar } from "./sidebar-projection.js";

export type CommitAndSignalFailure =
	| EventStoreError
	| ProjectionRunnerError
	| SqlError;

export type Hold =
	| {
			readonly _tag: "Held";
			readonly runner: string;
			readonly transmission: number;
	  }
	| { readonly _tag: "Unserved" }
	| { readonly _tag: "Covered" }
	| { readonly _tag: "Exhausted" };

export class HoldCommandIdMismatch extends Data.TaggedError(
	"HoldCommandIdMismatch",
)<{
	readonly sessionId: string;
	readonly runId: string;
	readonly ownerRunId: string;
	readonly commandId: string;
	readonly expectedCommandId: string;
}> {
	readonly operation = "holdRun";
	readonly code = "hold_command_id_mismatch";
	readonly retryable = false;
	get message(): string {
		return `Command ${this.commandId} does not match owner send ${this.expectedCommandId}`;
	}
}

export type HoldFailed =
	| CommitAndSignalFailure
	| HoldCommandIdMismatch
	| StoreFault;

/** Generic final authorization supplied by the owner of a bounded write. */
export const currentWriteAuthorization = Context.Reference<
	| {
			readonly runnerId: string;
			readonly check: Effect.Effect<void>;
			readonly guarded: <A, E = never, R = never>(
				op: Effect.Effect<A, E, R> | (() => A),
			) => Effect.Effect<Option.Option<A>, E, R>;
	  }
	| undefined
>("conduit/currentWriteAuthorization", { defaultValue: () => undefined });

/** Kept separate from authority so a context-losing fork cannot become a daemon write. */
export const currentRunnerWriteOrigin = Context.Reference<string | undefined>(
	"conduit/currentRunnerWriteOrigin",
	{ defaultValue: () => undefined },
);

export class MissingWriteAuthorization extends Data.TaggedError(
	"MissingWriteAuthorization",
)<{ readonly runnerId: string }> {}

/** Continue a runner's memory or durable work under its bound authority. */
export const guardCurrentWrite = <A, E = never, R = never>(
	op: Effect.Effect<A, E, R> | (() => A),
): Effect.Effect<Option.Option<A>, E, R> =>
	Effect.gen(function* () {
		const authorization = yield* currentWriteAuthorization;
		if (authorization) return yield* authorization.guarded(op);
		const runnerId = yield* currentRunnerWriteOrigin;
		if (runnerId)
			return yield* Effect.die(new MissingWriteAuthorization({ runnerId }));
		const action: Effect.Effect<A, E, R> =
			typeof op === "function" ? Effect.sync(op) : op;
		return yield* Effect.map(action, Option.some);
	});

/**
 * The seam was entered inside a transaction it does not own.
 *
 * Effect SQL degrades a nested `withTransaction` to a savepoint, so returning
 * from it is a release, not a COMMIT. Publishing there announces a version the
 * enclosing failure can still roll back — after a subscriber has moved past it,
 * and before the counter hands that same number to a later batch, which the
 * subscriber then ignores as already seen.
 *
 * Raised as a defect rather than a failure: nothing can recover from it at
 * runtime, the only fix is to restructure the call, and a typed error would sit
 * in a channel that existing catch-alls already swallow — which is precisely
 * how the guarantee would go missing again.
 */
export class NestedCommitAndSignal extends Data.TaggedError(
	"NestedCommitAndSignal",
)<{
	readonly depth: number;
}> {}

/**
 * A `write` body projected from inside a transaction of its own.
 *
 * The seam's `stored` and `advances` outlive any savepoint the body opens, so a
 * body that projects into its own transaction, fails, and catches the failure
 * leaves the seam holding an advance for rows SQLite has already taken back —
 * and the version it publishes is then reissued to the next batch.
 *
 * A defect for the same reason as `NestedCommitAndSignal`: the contract is that
 * the seam owns the transaction its publication speaks for, and a body that
 * breaks it has to be rewritten, not retried.
 */
export class ProjectOutsideSeamTransaction extends Data.TaggedError(
	"ProjectOutsideSeamTransaction",
)<{
	readonly seamDepth: number | undefined;
	readonly bodyDepth: number | undefined;
}> {}

export interface CommitAndSignalOptions {
	/** Runner-derived callers declare their origin even if fiber context was lost. */
	readonly runnerId?: string | undefined;
	/** Required when appending before the session has an owner row. */
	readonly projectId?: string;
	readonly publish?: boolean;
	/** The caller publishes failed inputs separately and owns their retry. */
	readonly requeueFailedInputs?: false;
	readonly endedRunEvents?: Set<string>;
	/** Runs after projection, inside the append transaction, before COMMIT. */
	readonly beforeCommit?: Effect.Effect<void, SqlError>;
	readonly afterCommit?: Effect.Effect<void>;
}

/**
 * Apply stored events to the read model. This is the only projection a `write`
 * body can reach, which is the point: a site cannot move the read model without
 * the advance being announced, because it has no other way to project. Deletes
 * append descendant markers here before the cascade removes their lineage.
 */
export type CommitAndSignalProject = (
	events: readonly StoredEvent[],
) => Effect.Effect<void, ProjectionRunnerError | SqlError>;

/**
 * Move read-model rows that no event produced, and announce the move.
 *
 * `apply` is handed the read-model version it must stamp onto every row it
 * touches, and returns the ids of the session rows it actually stamped. Those
 * ids are announced by the same post-COMMIT `publishAdvance` a projection would
 * use — there is no second publish, and no way to reach this without one.
 *
 * The shape is deliberately awkward in one direction: a caller cannot take a
 * version without also being asked which rows it stamped. A direct write that
 * moved a row without moving its `version` would reach no subscriber and report
 * success — the version column is what a subscription watches. Nothing about
 * that failure is visible at runtime, so the type is where it gets caught.
 */
export type CommitAndSignalStamp = <E, R>(
	apply: (version: number) => Effect.Effect<readonly string[], E, R>,
) => Effect.Effect<readonly string[], E | SqlError, R>;

export interface CommitAndSignal {
	(
		events: readonly CanonicalEvent[],
		options?: CommitAndSignalOptions,
	): Effect.Effect<void, CommitAndSignalFailure>;

	/** Assign the runner before dispatch, atomically excluding a committed Stop. */
	readonly holdRun: (input: {
		readonly sessionId: string;
		readonly runId: string;
		readonly commandId: string;
		readonly observedAt?: number;
	}) => Effect.Effect<Hold, HoldFailed>;

	/** Release evidence and any resulting serving-runner Stop share this write. */
	readonly releaseRun: <A, E, R>(
		input: EventPayloadMap["run.released"] & { readonly sessionId: string },
		stop: Effect.Effect<A, E, R>,
	) => Effect.Effect<
		{ readonly released: boolean; readonly stop: A | undefined },
		CommitAndSignalFailure | E,
		R
	>;

	/**
	 * For the append sites a plain `appendBatch` does not describe: an idempotent
	 * `INSERT OR IGNORE INTO events`, or a write that has to seed and then verify
	 * rows in the same transaction. Those sites need their other writes to land
	 * atomically with the append, which is why the body runs inside the seam's
	 * transaction and projects only through the handle it is given.
	 *
	 * This widens the helper beyond the void-returning form, so the seam must
	 * own the outermost transaction for the post-COMMIT promise to mean
	 * anything; entering it inside another is a defect, not a nesting.
	 */
	readonly write: <A, E, R>(
		body: (
			project: CommitAndSignalProject,
			stamp: CommitAndSignalStamp,
		) => Effect.Effect<A, E, R>,
		options?: CommitAndSignalOptions,
	) => Effect.Effect<A, E | CommitAndSignalFailure, R>;
}

// Factories are also created per command, so the permit belongs to the SQL
// client, not an individual writer. Weak keys retain no closed persistence stack.
const commitPermits = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();

export interface PendingWrite {
	readonly apply: Effect.Effect<void, SqlError>;
	readonly committed?: (() => void) | undefined;
}

const pendingWrites = new WeakMap<
	SqlClient.SqlClient,
	Map<unknown, PendingWrite>
>();

const commitPermit = (sql: SqlClient.SqlClient) => {
	let permit = commitPermits.get(sql);
	if (permit === undefined) {
		permit = Semaphore.makeUnsafe(1);
		commitPermits.set(sql, permit);
	}
	return permit;
};

/** Synchronous enqueue: owners need not wait for a connection or its permit. */
export const queuePendingWrite = (
	sql: SqlClient.SqlClient,
	key: unknown,
	write: PendingWrite,
) => {
	let pending = pendingWrites.get(sql);
	if (pending === undefined) {
		pending = new Map();
		pendingWrites.set(sql, pending);
	}
	pending.set(key, write);
};

const applyPendingWrites = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		const applied = new Map<unknown, PendingWrite>();
		while (true) {
			const pending = [...(pendingWrites.get(sql)?.entries() ?? [])].filter(
				([key, write]) => applied.get(key) !== write,
			);
			if (pending.length === 0) return applied;
			for (const [key, write] of pending) {
				if (pendingWrites.get(sql)?.get(key) !== write) continue;
				yield* write.apply;
				applied.set(key, write);
			}
		}
	});

const clearCommittedWrites = (
	sql: SqlClient.SqlClient,
	applied: ReadonlyMap<unknown, PendingWrite>,
) => {
	const pending = pendingWrites.get(sql);
	for (const [key, write] of applied) {
		if (pending?.get(key) === write) pending.delete(key);
		write.committed?.();
	}
};

/** Standalone flushes and optional owner maintenance share the seam's permit. */
export const flushPendingWrites = <E = never, R = never>(
	sql: SqlClient.SqlClient,
	operation: Effect.Effect<void, E, R> = Effect.void,
	options: Pick<CommitAndSignalOptions, "runnerId"> = {},
) =>
	Effect.gen(function* () {
		const authority = yield* currentWriteAuthorization;
		const runnerId = options.runnerId ?? (yield* currentRunnerWriteOrigin);
		if (runnerId !== undefined && authority?.runnerId !== runnerId)
			return yield* Effect.die(new MissingWriteAuthorization({ runnerId }));
		const ambient = yield* Effect.serviceOption(sql.transactionService);
		if (Option.isSome(ambient))
			return yield* Effect.die(
				new NestedCommitAndSignal({ depth: ambient.value[1] }),
			);
		yield* commitPermit(sql).withPermits(1)(
			sql
				.withTransaction(
					Effect.gen(function* () {
						yield* operation;
						const applied = yield* applyPendingWrites(sql);
						yield* authority?.check ?? Effect.void;
						return applied;
					}),
				)
				.pipe(
					Effect.provideService(Scheduler.PreventSchedulerYield, true),
					Effect.tap((applied) =>
						Effect.sync(() => clearCommittedWrites(sql, applied)),
					),
					Effect.asVoid,
				),
		);
	}).pipe(Effect.uninterruptible);

const scheduledFlushes = new WeakSet<SqlClient.SqlClient>();

/** Coalesce standalone maintenance, independent of the caller's transaction and grant. */
export const schedulePendingWriteFlush = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		if (scheduledFlushes.has(sql)) return;
		scheduledFlushes.add(sql);
		yield* flushPendingWrites(sql).pipe(
			Effect.tapError((error) =>
				Effect.logWarning("Pending write flush failed; retrying", error),
			),
			Effect.retry({ schedule: Schedule.spaced("1 second") }),
			Effect.provideService(currentWriteAuthorization, undefined),
			Effect.provideService(currentRunnerWriteOrigin, undefined),
			Effect.updateContext((context: Context.Context<never>) =>
				Context.omit(sql.transactionService)(context),
			),
			Effect.ensuring(Effect.sync(() => scheduledFlushes.delete(sql))),
			Effect.provideService(Scheduler.PreventSchedulerYield, true),
			Effect.forkDetach,
		);
	}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));

const makeCommitAndSignalWithStore = Effect.fn(function* (
	eventStore: UnboundEventStoreEffect & { readonly projectId?: string },
) {
	const sql = yield* SqlClient.SqlClient;
	const withPermit = commitPermit(sql).withPermits(1);
	const withCommitPermit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		contentionMetrics
			? contentionMetrics.withCommitPermit(withPermit, effect)
			: withPermit(effect);
	const projectionRunner = yield* ProjectionRunnerEffectTag;
	const projects = yield* SessionRollupProjects;
	const sessionEventBus = yield* Effect.serviceOption(SessionEventBusTag);
	const retention = yield* Effect.serviceOption(EventRetentionSchedulerTag);

	const write = <A, E, R>(
		body: (
			project: CommitAndSignalProject,
			stamp: CommitAndSignalStamp,
		) => Effect.Effect<A, E, R>,
		options: CommitAndSignalOptions = {},
	): Effect.Effect<A, E | CommitAndSignalFailure, R> =>
		Effect.uninterruptible(
			Effect.gen(function* () {
				const mismatch = boundProjectMismatch(
					eventStore.projectId,
					options.projectId,
				);
				if (mismatch) return yield* mismatch;
				// Refuse before any write: the seam publishes on the strength of
				// owning the COMMIT, and inside someone else's transaction it does
				// not own one.
				const authority = yield* currentWriteAuthorization;
				const runnerId = options.runnerId ?? (yield* currentRunnerWriteOrigin);
				if (runnerId !== undefined && authority?.runnerId !== runnerId)
					return yield* Effect.die(new MissingWriteAuthorization({ runnerId }));
				const ambient = yield* Effect.serviceOption(sql.transactionService);
				if (Option.isSome(ambient))
					return yield* Effect.die(
						new NestedCommitAndSignal({ depth: ambient.value[1] }),
					);

				// Survive the transaction on purpose: they are what gets published
				// once it has committed. Which is exactly why `project` has to refuse
				// to feed them from anywhere the COMMIT does not cover.
				const stored: StoredEvent[] = [];
				const endedRunEvents = new Set<string>();
				const advances: ReadModelAdvance[] = [];
				// Sessions direct stamps wrote, whose families are refreshed once,
				// before COMMIT, however many stamps the body makes.
				const stampedSessions: string[] = [];

				const result = yield* withCommitPermit(
					Effect.gen(function* () {
						if (!(yield* projectionRunner.isRecovered())) {
							yield* projectionRunner
								.recover()
								.pipe(Effect.provideService(SqlClient.SqlClient, sql));
						}
						let flushedWrites: ReadonlyMap<unknown, PendingWrite> = new Map();
						const transaction = sql.withTransaction(
							Effect.gen(function* () {
								const seam = Option.getOrUndefined(
									yield* Effect.serviceOption(sql.transactionService),
								);

								// The test is not "is a transaction open" but "is it the
								// seam's own". Effect SQL reuses the connection for a nested
								// `withTransaction` and only raises the depth, so the depth
								// is what tells the seam's transaction apart from a savepoint
								// the body opened inside it — and a savepoint rolls back on
								// its own, after these arrays have been fed.
								const requireSeamTransaction = Effect.gen(function* () {
									const here = Option.getOrUndefined(
										yield* Effect.serviceOption(sql.transactionService),
									);
									if (here?.[0] !== seam?.[0] || here?.[1] !== seam?.[1])
										return yield* Effect.die(
											new ProjectOutsideSeamTransaction({
												seamDepth: seam?.[1],
												bodyDepth: here?.[1],
											}),
										);
								});

								const project: CommitAndSignalProject = (events) =>
									Effect.gen(function* () {
										yield* requireSeamTransaction;
										if (events.length === 0) return;
										const marked = new Set(
											events.flatMap((event) =>
												event.type === "session.deleted"
													? [event.data.sessionId]
													: [],
											),
										);
										const markers: StoredEvent[] = [];
										const advance = yield* projectionRunner
											.projectBatch(events, endedRunEvents, (event) =>
												Effect.gen(function* () {
													// The daemon store is shared: the marker's own row names its project.
													const [owner] = yield* sql<{
														project_id: string;
													}>`SELECT project_id FROM events WHERE sequence = ${event.sequence}`;
													const projectId =
														owner?.project_id ?? eventStore.projectId ?? "";
													// Direct provider/born-dead writers can bypass session commands.
													// Capture their own marker inside this same deletion transaction.
													if (
														event.sessionId === event.data.sessionId &&
														event.data.worktreeOwnership === undefined
													) {
														const worktreeOwnership =
															yield* readSessionWorktreeOwnershipSnapshot(
																projectId,
																event.sessionId,
															).pipe(
																Effect.provideService(SqlClient.SqlClient, sql),
															);
														if (worktreeOwnership)
															yield* sql`UPDATE events SET data = json_set(data, '$.worktreeOwnership', json(${JSON.stringify(worktreeOwnership)}))
																WHERE sequence = ${event.sequence} AND project_id = ${projectId}
																AND session_id = ${event.data.sessionId}`;
													}
													// Earlier events in this batch have projected. Capture the
													// current subtree before the root's cascade erases it.
													const subtree = yield* sql.unsafe<{ id: string }>(
														SESSION_SUBTREE_SQL,
														[event.data.sessionId],
													);
													const descendants = subtree.filter(
														({ id }) => !marked.has(id),
													);
													for (const { id } of descendants) marked.add(id);
													const descendantMarkers = yield* Effect.forEach(
														descendants,
														({ id }) =>
															Effect.gen(function* () {
																const worktreeOwnership =
																	yield* readSessionWorktreeOwnershipSnapshot(
																		projectId,
																		id,
																	).pipe(
																		Effect.provideService(
																			SqlClient.SqlClient,
																			sql,
																		),
																	);
																return canonicalEvent(
																	"session.deleted",
																	id,
																	{
																		sessionId: id,
																		...(worktreeOwnership
																			? { worktreeOwnership }
																			: {}),
																	},
																	{
																		provider: event.provider,
																		createdAt: event.createdAt,
																		metadata: event.metadata,
																	},
																);
															}),
													);
													const appended =
														yield* eventStore.appendBatch(descendantMarkers);
													markers.push(...appended);
													return appended;
												}),
											)
											.pipe(Effect.provideService(SqlClient.SqlClient, sql));
										stored.push(...events, ...markers);
										advances.push(advance);
									});

								const stamp: CommitAndSignalStamp = (apply) =>
									Effect.gen(function* () {
										yield* requireSeamTransaction;
										// Same counter as projection, taken in the same transaction:
										// the version a direct write stamps has to be comparable with
										// the ones the log produces, or "have I already seen this?"
										// stops meaning anything.
										const version = yield* projectionRunner.nextVersion.pipe(
											Effect.provideService(SqlClient.SqlClient, sql),
										);
										const sessionIds = yield* apply(version);
										stampedSessions.push(...sessionIds);
										// No rows, no announcement. An advance naming a row that was
										// not touched sends every subscriber to re-query it for
										// nothing; worse, it claims a version for rows that did not
										// move.
										if (sessionIds.length > 0) {
											const owners = yield* sql<{
												project_id: string;
											}>`SELECT DISTINCT project_id FROM sessions WHERE id IN ${sql.in(sessionIds)}`;
											advances.push({
												version,
												projectIds: owners.map((row) => row.project_id),
												sessionIds: [...sessionIds],
												removedSessionIds: [],
												collections: ["sessions", "sidebar"],
											});
										}
										return sessionIds;
									});

								const result = yield* body(project, stamp);
								// A direct write to a session row can change what its
								// family shows in the sidebar, as a projected one can. At
								// the highest version this commit took, so the row never
								// lands below one the advance announces.
								yield* refreshSidebar(
									stampedSessions,
									Math.max(0, ...advances.map((advance) => advance.version)),
									projects ? yield* Ref.get(projects) : undefined,
								).pipe(Effect.provideService(SqlClient.SqlClient, sql));
								yield* options.beforeCommit ?? Effect.void;
								// Returning an unplaced failed steer belongs to its durable
								// terminal fact unless its caller owns independent publication.
								if (options.requeueFailedInputs !== false)
									yield* requeueFailedSteers(
										sql,
										{
											persistEvents: (events) =>
												eventStore
													.appendBatch(events, options.projectId)
													.pipe(Effect.flatMap(project)),
										},
										undefined,
										undefined,
										eventStore.projectId ?? options.projectId,
									);
								flushedWrites = yield* applyPendingWrites(sql);
								// Pending writes can suspend: authorize only after the last one.
								yield* authority?.check ?? Effect.void;
								return result;
							}),
						);
						const result = yield* transaction.pipe(
							// SQL's COMMIT runs in withTransaction's finalizer, after the
							// body context is restored. Cover the whole wrapper so no
							// automatic yield can admit a revocation after the final flush.
							// Explicit async body waits still suspend normally.
							Effect.provideService(Scheduler.PreventSchedulerYield, true),
						);
						clearCommittedWrites(sql, flushedWrites);
						observeTurnTimelineCommit(stored);
						const { stamped, removed, collections } = mergeTouches(
							advances.map((advance) => ({
								stamped: advance.sessionIds,
								removed: advance.removedSessionIds,
								collections: advance.collections,
							})),
						);
						if (Option.isSome(sessionEventBus) && options.publish !== false) {
							// Post-commit, so a subscriber that re-queries on the advance
							// cannot read behind the rows it was told about. Keep the permit
							// through publication so another writer cannot overtake this commit.
							// Removals ride the same advance and stay out of `sessionIds`: one
							// says re-query, the other says drop. Which list a session lands in
							// is decided by the last projection that touched it, so a body that
							// deletes and re-creates inside one commit announces the row it
							// left behind, not the one it destroyed on the way.
							if (
								stamped.length > 0 ||
								removed.length > 0 ||
								collections.length > 0
							)
								yield* sessionEventBus.value.publishAdvance({
									version: Math.max(
										...advances.map((advance) => advance.version),
									),
									sessionIds: stamped,
									projectIds: [
										...new Set(
											advances.flatMap((advance) => advance.projectIds),
										),
									],
									removedSessionIds: removed,
									collections,
								});
						}
						return result;
					}),
				);
				for (const eventId of endedRunEvents)
					options.endedRunEvents?.add(eventId);
				// Every committed deletion kicks retention, even when no row was
				// removed or live publication was suppressed. Never wait for drain.
				if (stored.some((event) => event.type === "session.deleted")) {
					if (Option.isSome(retention)) yield* retention.value.kick;
				}
				// Callbacks can stall or commit again; neither may hold up advances.
				yield* options.afterCommit ?? Effect.void;
				if (
					Option.isSome(sessionEventBus) &&
					options.publish !== false &&
					stored.length > 0
				)
					yield* sessionEventBus.value.publish(stored, endedRunEvents);
				const sessionStateNotifier = yield* Effect.serviceOption(
					SessionStateProjectionNotifierTag,
				);
				if (Option.isSome(sessionStateNotifier) && options.publish !== false) {
					for (const event of stored) {
						yield* sessionStateNotifier.value.sessionStateProjected(
							event.sessionId,
							event.type,
						);
					}
				}
				return result;
			}),
		);

	const commitAndSignal: CommitAndSignal = Object.assign(
		(
			events: readonly CanonicalEvent[],
			options: CommitAndSignalOptions = {},
		): Effect.Effect<void, CommitAndSignalFailure> =>
			write(
				(project) =>
					Effect.gen(function* () {
						const appended = yield* eventStore.appendBatch(
							events,
							options.projectId,
						);
						yield* project(appended);
					}),
				options,
			),
		{
			write,
			releaseRun: <A, E, R>(
				input: Parameters<CommitAndSignal["releaseRun"]>[0],
				stop: Effect.Effect<A, E, R>,
			) =>
				write((project) =>
					Effect.gen(function* () {
						const [held] = yield* sql<{
							runner_id: string | null;
							held_transmission: number | null;
						}>`SELECT runner_id, held_transmission FROM provider_runs
					WHERE id = ${input.runId} AND session_id = ${input.sessionId}`;
						const released =
							held?.runner_id === input.runnerId &&
							held.held_transmission === input.transmission;
						const [session] = yield* sql<{
							provider: string;
						}>`SELECT provider FROM sessions WHERE id = ${input.sessionId}`;
						yield* project(
							yield* eventStore.appendBatch([
								canonicalEvent(
									"run.released",
									input.sessionId,
									{
										runId: input.runId,
										runnerId: input.runnerId,
										commandId: input.commandId,
										transmission: input.transmission,
										reason: input.reason,
									},
									{
										provider: session?.provider ?? "conduit",
										metadata: { runId: input.runId },
									},
								),
							]),
						);
						if (!released) return { released, stop: undefined };
						const [serving] = yield* sql`SELECT 1 FROM claude_runner_cursors
					WHERE runner_id = ${input.runnerId} AND session_id = ${input.sessionId} AND role = 'serving' AND retired_at IS NULL`;
						return { released, stop: serving ? yield* stop : undefined };
					}),
				),
			holdRun: (input: Parameters<CommitAndSignal["holdRun"]>[0]) => {
				return write<Hold, HoldFailed, never>((project, stamp) =>
					Effect.gen(function* () {
						const observedAt =
							input.observedAt ?? (yield* Clock.currentTimeMillis);
						const [owner] = yield* sql<{
							id: string;
							provider: string;
							status: string;
							runner_id: string | null;
						}>`SELECT owner.id, session.provider, owner.status, owner.runner_id
							FROM provider_runs requested JOIN provider_runs owner
								ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
							JOIN sessions session ON session.id = requested.session_id
							WHERE requested.id = ${input.runId} AND requested.session_id = ${input.sessionId}`;
						if (!owner)
							return yield* new EventStoreError({
								operation: "holdRun",
								sessionId: input.sessionId,
								cause: "Run is not dispatchable",
							});
						const expectedCommandId = yield* runSendCommandIdQuery(
							sql,
							input.sessionId,
							owner.id,
						);
						if (
							expectedCommandId !== undefined &&
							expectedCommandId !== input.commandId
						)
							return yield* new HoldCommandIdMismatch({
								sessionId: input.sessionId,
								runId: input.runId,
								ownerRunId: owner.id,
								commandId: input.commandId,
								expectedCommandId,
							});
						const commandId = input.commandId;
						const dispatchable =
							owner.status === "pending" || owner.status === "running";
						const [command] = yield* sql<{
							request_sequence: number;
							attempt_count: number;
						}>`SELECT request_sequence, attempt_count FROM provider_command_outbox
							WHERE session_id = ${input.sessionId} AND command_id = ${commandId}
								AND run_id = ${owner.id} AND effect_type = 'send_turn'
							ORDER BY request_sequence DESC LIMIT 1`;
						const send = command
							? {
									sessionId: input.sessionId,
									runId: owner.id,
									commandId,
									requestSequence: command.request_sequence,
									attempt: command.attempt_count,
								}
							: undefined;
						if (yield* stopCovers(sql, input.sessionId, owner.id)) {
							if (send && owner.runner_id === null && dispatchable)
								yield* settleSend(
									{ sql, project, stamp },
									{
										_tag: "covered",
										send,
										observedAt,
									},
								);
							return { _tag: "Covered" };
						}
						if (!dispatchable || owner.runner_id !== null)
							return yield* new EventStoreError({
								operation: "holdRun",
								sessionId: input.sessionId,
								cause: "Run is not dispatchable",
							});
						const [count] = yield* sql<{
							n: number;
						}>`SELECT COUNT(*) AS n FROM events
							WHERE session_id = ${input.sessionId} AND type = 'run.dispatched'
								AND json_valid(data) AND json_extract(data, '$.commandId') = ${commandId}`;
						const transmission = (count?.n ?? 0) + 1;
						if (transmission > 5) {
							if (send)
								yield* settleSend(
									{ sql, project, stamp },
									{
										_tag: "failed",
										send,
										observedAt,
										failure: {
											operation: "holdRun",
											message: "Provider send attempts exhausted",
											code: "provider_send_attempts_exhausted",
										},
									},
								);
							return { _tag: "Exhausted" };
						}
						const [serving] = yield* sql<{
							runner_id: string;
						}>`SELECT runner_id FROM claude_runner_cursors
							WHERE session_id = ${input.sessionId} AND retired_at IS NULL AND role = 'serving'`;
						if (!serving) return { _tag: "Unserved" };
						yield* project(
							yield* eventStore.appendBatch([
								canonicalEvent(
									"run.dispatched",
									input.sessionId,
									{
										runId: owner.id,
										runnerId: serving.runner_id,
										commandId,
										transmission,
									},
									{ provider: owner.provider, metadata: { runId: owner.id } },
								),
							]),
						);
						return { _tag: "Held", runner: serving.runner_id, transmission };
					}),
				);
			},
		},
	);

	return commitAndSignal;
});

export const makeUnboundCommitAndSignal = Effect.flatMap(
	UnboundEventStoreEffectTag,
	makeCommitAndSignalWithStore,
);

export const makeCommitAndSignal = Effect.flatMap(
	EventStoreEffectTag,
	makeCommitAndSignalWithStore,
);
