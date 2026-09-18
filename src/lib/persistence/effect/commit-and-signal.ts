import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect, Option } from "effect";
import type { ReadModelAdvance } from "../../contracts/read-model-advance.js";
import { SessionEventBusTag } from "../../domain/relay/Services/session-event-bus.js";
import type { CanonicalEvent, StoredEvent } from "../events.js";
import type { EventStoreError } from "./event-store-effect.js";
import { EventStoreEffectTag } from "./event-store-effect.js";
import type { ProjectionRunnerError } from "./projection-runner-effect.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";

export type CommitAndSignalFailure =
	| EventStoreError
	| ProjectionRunnerError
	| SqlError;

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
	readonly publish?: boolean;
	readonly afterCommit?: Effect.Effect<void>;
}

/**
 * Apply stored events to the read model. This is the only projection a `write`
 * body can reach, which is the point: a site cannot move the read model without
 * the advance being announced, because it has no other way to project.
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
 * version without also being asked which rows it stamped. `last_viewed_at` is
 * the first read-model column not derived from the log, and a direct write that
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

export const makeCommitAndSignal = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const eventStore = yield* EventStoreEffectTag;
	const projectionRunner = yield* ProjectionRunnerEffectTag;
	const sessionEventBus = yield* Effect.serviceOption(SessionEventBusTag);

	const write = <A, E, R>(
		body: (
			project: CommitAndSignalProject,
			stamp: CommitAndSignalStamp,
		) => Effect.Effect<A, E, R>,
		options: CommitAndSignalOptions = {},
	): Effect.Effect<A, E | CommitAndSignalFailure, R> =>
		Effect.uninterruptible(
			Effect.gen(function* () {
				// Refuse before any write: the seam publishes on the strength of
				// owning the COMMIT, and inside someone else's transaction it does
				// not own one.
				const ambient = yield* Effect.serviceOption(
					SqlClient.TransactionConnection,
				);
				if (Option.isSome(ambient))
					return yield* Effect.die(
						new NestedCommitAndSignal({ depth: ambient.value[1] }),
					);

				// Survive the transaction on purpose: they are what gets published
				// once it has committed. Which is exactly why `project` has to refuse
				// to feed them from anywhere the COMMIT does not cover.
				const stored: StoredEvent[] = [];
				const advances: ReadModelAdvance[] = [];

				const result = yield* sql.withTransaction(
					Effect.gen(function* () {
						const seam = Option.getOrUndefined(
							yield* Effect.serviceOption(SqlClient.TransactionConnection),
						);

						// The test is not "is a transaction open" but "is it the
						// seam's own". Effect SQL reuses the connection for a nested
						// `withTransaction` and only raises the depth, so the depth
						// is what tells the seam's transaction apart from a savepoint
						// the body opened inside it — and a savepoint rolls back on
						// its own, after these arrays have been fed.
						const requireSeamTransaction = Effect.gen(function* () {
							const here = Option.getOrUndefined(
								yield* Effect.serviceOption(SqlClient.TransactionConnection),
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
								const advance = yield* projectionRunner
									.projectBatch(events)
									.pipe(Effect.provideService(SqlClient.SqlClient, sql));
								stored.push(...events);
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
								// No rows, no announcement. An advance naming a row that was
								// not touched sends every subscriber to re-query it for
								// nothing; worse, it claims a version for rows that did not
								// move.
								if (sessionIds.length > 0)
									advances.push({ version, sessionIds: [...sessionIds] });
								return sessionIds;
							});

						return yield* body(project, stamp);
					}),
				);
				yield* options.afterCommit ?? Effect.void;

				if (Option.isSome(sessionEventBus) && options.publish !== false) {
					// Post-commit, so a subscriber that re-queries on the advance
					// cannot read behind the rows it was told about.
					if (stored.length > 0) yield* sessionEventBus.value.publish(stored);
					const sessionIds = [
						...new Set(advances.flatMap((advance) => advance.sessionIds)),
					];
					if (sessionIds.length > 0)
						yield* sessionEventBus.value.publishAdvance({
							version: Math.max(...advances.map((advance) => advance.version)),
							sessionIds,
						});
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
						const appended = yield* eventStore.appendBatch(events);
						yield* project(appended);
					}),
				options,
			),
		{ write },
	);

	return commitAndSignal;
});
