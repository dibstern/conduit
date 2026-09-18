// ─── Effect-based Projection Runner ─────────────────────────────────────────
// Migrates projection-runner.ts from raw SqliteClient to @effect/sql SqlClient.
// Uses SqlClient.withTransaction for write operations.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type { ReadModelAdvance } from "../../contracts/read-model-advance.js";
import type { StoredEvent } from "../events.js";
import { ProjectorCursorEffectTag } from "./projector-cursor-effect.js";
import {
	type EffectProjector,
	mergeTouches,
	type ProjectionContext,
	type ProjectionTouch,
} from "./projectors-effect.js";
import {
	decodeStoredEventRow,
	type StoredEventRow,
} from "./stored-event-row.js";

// ─── Error type ─────────────────────────────────────────────────────────────

export class ProjectionRunnerError extends Data.TaggedError(
	"ProjectionRunnerError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Failure record ─────────────────────────────────────────────────────────

export interface ProjectionFailure {
	readonly projectorName: string;
	readonly eventSequence: number;
	readonly eventType: string;
	readonly sessionId: string;
	readonly error: string;
	readonly failedAt: number;
}

// ─── Recovery result types ──────────────────────────────────────────────────

export interface RecoveryResult {
	readonly startCursor: number;
	readonly endCursor: number;
	readonly totalReplayed: number;
	readonly durationMs: number;
}

// ─── Service interface ──────────────────────────────────────────────────────

export interface ProjectionRunnerEffect {
	/**
	 * Apply events and report how far the read model moved, which sessions moved
	 * with it, and which sessions left. The caller that owns the transaction publishes
	 * this once the commit lands; nothing below the projection announces, so a
	 * new write path gets a change signal by projecting and nothing else.
	 * `version` is the read-model counter this application stamped its rows with,
	 * and 0 when there was nothing to apply. It is not an event sequence: it comes
	 * from a counter that only ever goes up, so a replayed write still lands above
	 * whatever version a subscriber is holding.
	 */
	readonly projectEvent: (
		event: StoredEvent,
	) => Effect.Effect<
		ReadModelAdvance,
		ProjectionRunnerError | SqlError,
		SqlClient.SqlClient
	>;

	readonly projectBatch: (
		events: readonly StoredEvent[],
	) => Effect.Effect<
		ReadModelAdvance,
		ProjectionRunnerError | SqlError,
		SqlClient.SqlClient
	>;

	readonly recover: () => Effect.Effect<
		RecoveryResult,
		ProjectionRunnerError,
		SqlClient.SqlClient
	>;

	readonly getFailures: () => Effect.Effect<readonly ProjectionFailure[]>;

	readonly isRecovered: () => Effect.Effect<boolean>;

	readonly markRecovered: () => Effect.Effect<void>;
}

// ─── Service Tag ────────────────────────────────────────────────────────────

export class ProjectionRunnerEffectTag extends Context.Tag(
	"ProjectionRunnerEffect",
)<ProjectionRunnerEffectTag, ProjectionRunnerEffect>() {}

// ─── Service implementation ─────────────────────────────────────────────────

export const makeProjectionRunnerEffect = (
	projectors: readonly EffectProjector[],
) =>
	Effect.gen(function* () {
		const cursorRepo = yield* ProjectorCursorEffectTag;
		const sql = yield* SqlClient.SqlClient;

		// Pre-computed dispatch map
		const projectorsByEventType = new Map<string, EffectProjector[]>();
		for (const projector of projectors) {
			for (const eventType of projector.handles) {
				let list = projectorsByEventType.get(eventType);
				if (!list) {
					list = [];
					projectorsByEventType.set(eventType, list);
				}
				list.push(projector);
			}
		}

		// Mutable state
		const failures: ProjectionFailure[] = [];
		let recovered = false;
		let replaying = false;

		// The read model's own clock. It is not the event sequence: replay re-applies
		// an event whose sequence is below the row's current version, and a row that
		// moves backwards is a row a subscriber never hears about again. This only
		// ever goes up, so every write — first pass or replay — lands above whatever
		// a subscriber last saw.
		//
		// The bump is an UPDATE, so it takes SQLite's write lock at that statement
		// and holds it to COMMIT. Two batches on separate connections therefore
		// serialize: the second blocks, then reads the first's committed value and
		// cannot reissue it.
		const nextVersion = Effect.gen(function* () {
			const rows = yield* sql<{
				value: number;
			}>`UPDATE read_model_counter SET value = value + 1 WHERE id = 1 RETURNING value`;
			return rows[0]?.value ?? 0;
		});

		const recordFailure = (
			projector: EffectProjector,
			event: StoredEvent,
			err: unknown,
		): ProjectionFailure => {
			const failure: ProjectionFailure = {
				projectorName: projector.name,
				eventSequence: event.sequence,
				eventType: event.type,
				sessionId: event.sessionId,
				error:
					err instanceof Error && err.message.length > 0
						? err.message
						: String(err),
				failedAt: Date.now(),
			};
			failures.push(failure);
			if (failures.length > 100) failures.shift();
			return failure;
		};

		const projectEvent = (
			event: StoredEvent,
		): Effect.Effect<
			ReadModelAdvance,
			ProjectionRunnerError | SqlError,
			SqlClient.SqlClient
		> =>
			sql.withTransaction(
				Effect.gen(function* () {
					const matching = projectorsByEventType.get(event.type) ?? [];
					// Inside the transaction on purpose: the bump's write lock is only
					// held to COMMIT, so a bump that auto-commits on its own would let a
					// second connection stamp and announce a higher version while this
					// one's rows are still uncommitted — and a subscriber that moved to
					// the higher version would never query low enough to see them.
					const version = yield* nextVersion;
					const ctx: ProjectionContext = { version, replaying };
					// Kept in order, not unioned: a session this event removes and
					// re-creates ends the projection alive, and the last touch is the
					// only one that describes the row a subscriber will find.
					const touches: ProjectionTouch[] = [];

					// Failures propagate. A caller here is applying one known event and can
					// act on the result — a user deleting a session must not be told it
					// worked when the row is still there. Replay is the one path that
					// swallows projector failures, and it does so in recover().
					//
					// Live producers wrap append and projection in one transaction. These
					// nested transactions are savepoints; failures roll back the whole write.
					// Relay startup recovers historical events before enabling live producers.
					// getFailures() is not involved because the error reaches the caller.
					for (const projector of matching) {
						const changed = yield* sql.withTransaction(
							Effect.gen(function* () {
								const touched = yield* projector.project(event, ctx);
								yield* cursorRepo.upsert(projector.name, event.sequence);
								return touched;
							}).pipe(
								Effect.mapError(
									(cause) =>
										new ProjectionRunnerError({
											operation: "projectEvent",
											cause,
										}),
								),
							),
						);
						touches.push(changed);
					}

					const touched = mergeTouches(touches);
					return {
						version,
						sessionIds: touched.stamped,
						removedSessionIds: touched.removed,
					};
				}),
			);

		const projectBatch = (
			events: readonly StoredEvent[],
		): Effect.Effect<
			ReadModelAdvance,
			ProjectionRunnerError | SqlError,
			SqlClient.SqlClient
		> => {
			if (events.length === 0)
				return Effect.succeed({
					version: 0,
					sessionIds: [],
					removedSessionIds: [],
				});

			return Effect.gen(function* () {
				// Event order decides the outcome, so the touches are folded, not
				// unioned — see projectEvent.
				const touches: ProjectionTouch[] = [];

				// One transaction for the whole batch (S9): a translation that produced
				// several events lands all-or-nothing, so the read model never shows a
				// half-applied translation. Failures propagate for the same reason they
				// do in projectEvent — see the policy note there.
				//
				// One counter bump for the batch, taken inside that transaction: every
				// row the batch writes carries the same version, and the bump's write
				// lock is held until the rows it stamps are committed.
				const version = yield* sql.withTransaction(
					Effect.gen(function* () {
						const version = yield* nextVersion;
						const ctx: ProjectionContext = { version, replaying };
						for (const event of events) {
							const matching = projectorsByEventType.get(event.type) ?? [];
							for (const projector of matching) {
								touches.push(yield* projector.project(event, ctx));
							}
						}

						// Advance all cursors to last event
						const lastEvent = events[events.length - 1];
						if (lastEvent) {
							for (const projector of projectors) {
								yield* cursorRepo.upsert(projector.name, lastEvent.sequence);
							}
						}
						return version;
					}).pipe(
						Effect.mapError(
							(e) =>
								new ProjectionRunnerError({
									operation: "projectBatch",
									cause: e,
								}),
						),
					),
				);

				const touched = mergeTouches(touches);
				return {
					version,
					sessionIds: touched.stamped,
					removedSessionIds: touched.removed,
				};
			});
		};

		const recover = (): Effect.Effect<
			RecoveryResult,
			ProjectionRunnerError,
			SqlClient.SqlClient
		> =>
			Effect.gen(function* () {
				const startTime = Date.now();

				// Get the latest sequence
				const maxRows = yield* sql<{
					max_seq: number | null;
				}>`SELECT MAX(sequence) AS max_seq FROM events`;
				const latestSeq = maxRows[0]?.max_seq ?? 0;

				// Check if all caught up
				const allCursors = yield* cursorRepo.listAll();
				const allCaughtUp =
					allCursors.length === projectors.length &&
					allCursors.every((c) => c.lastAppliedSeq >= latestSeq);

				if (allCaughtUp) {
					recovered = true;
					return {
						startCursor: latestSeq,
						endCursor: latestSeq,
						totalReplayed: 0,
						durationMs: 0,
					};
				}

				const projectorCursors = new Map<string, number>();
				for (const projector of projectors) {
					const cursor = allCursors.find(
						(candidate) => candidate.projectorName === projector.name,
					);
					projectorCursors.set(projector.name, cursor?.lastAppliedSeq ?? 0);
				}
				const startingCursors = [...projectorCursors.values()];
				const startCursor =
					startingCursors.length === 0
						? latestSeq
						: Math.min(...startingCursors);

				recovered = false;
				replaying = true;
				let totalReplayed = 0;

				yield* Effect.gen(function* () {
					let scanCursor = startCursor;
					const batchSize = 500;

					while (true) {
						const eventRows = yield* sql<StoredEventRow>`
							SELECT sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at
							FROM events
							WHERE sequence > ${scanCursor} AND sequence <= ${latestSeq}
							ORDER BY sequence ASC
							LIMIT ${batchSize}`;
						if (eventRows.length === 0) break;

						for (const eventRow of eventRows) {
							const storedEvent = yield* decodeProjectionEventRow(eventRow);
							const matching =
								projectorsByEventType.get(storedEvent.type) ?? [];
							for (const projector of matching) {
								const cursor = projectorCursors.get(projector.name) ?? 0;
								if (eventRow.sequence <= cursor) continue;

								yield* sql
									.withTransaction(
										Effect.gen(function* () {
											yield* projector.project(storedEvent, {
												version: yield* nextVersion,
												replaying: true,
											});
											yield* cursorRepo.upsert(
												projector.name,
												eventRow.sequence,
											);
										}),
									)
									.pipe(
										Effect.catchAll((err) =>
											Effect.gen(function* () {
												const failure = recordFailure(
													projector,
													storedEvent,
													err,
												);
												yield* Effect.logError(
													"projection replay failed; event skipped",
												).pipe(
													Effect.annotateLogs({
														projectorName: failure.projectorName,
														eventSequence: failure.eventSequence,
														eventType: failure.eventType,
														sessionId: failure.sessionId,
														error: failure.error,
													}),
												);
												yield* sql.withTransaction(
													Effect.gen(function* () {
														yield* sql`
															INSERT INTO projection_failures
																(projector_name, event_sequence, event_type, session_id, error, failed_at)
															VALUES
																(${failure.projectorName}, ${failure.eventSequence}, ${failure.eventType}, ${failure.sessionId}, ${failure.error}, ${failure.failedAt})`;
														yield* cursorRepo.upsert(
															failure.projectorName,
															failure.eventSequence,
														);
													}),
												);
											}),
										),
									);

								projectorCursors.set(projector.name, eventRow.sequence);
								totalReplayed++;
							}
						}

						const lastInBatch = eventRows[eventRows.length - 1];
						if (lastInBatch) scanCursor = lastInBatch.sequence;
						if (eventRows.length < batchSize) break;
					}

					for (const projector of projectors) {
						yield* cursorRepo.upsert(projector.name, latestSeq);
					}
					recovered = true;
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							replaying = false;
						}),
					),
				);

				return {
					startCursor,
					endCursor: latestSeq,
					totalReplayed,
					durationMs: Date.now() - startTime,
				};
			}).pipe(
				Effect.mapError((e) =>
					e instanceof ProjectionRunnerError
						? e
						: new ProjectionRunnerError({
								operation: "recover",
								cause: e,
							}),
				),
			);

		const getFailures = (): Effect.Effect<readonly ProjectionFailure[]> =>
			Effect.succeed(failures);

		const isRecovered = (): Effect.Effect<boolean> => Effect.succeed(recovered);

		const markRecovered = (): Effect.Effect<void> =>
			Effect.sync(() => {
				recovered = true;
			});

		return {
			projectEvent,
			projectBatch,
			recover,
			getFailures,
			isRecovered,
			markRecovered,
		} satisfies ProjectionRunnerEffect;
	});

const decodeProjectionEventRow = (
	row: StoredEventRow,
): Effect.Effect<StoredEvent, ProjectionRunnerError> =>
	decodeStoredEventRow(
		row,
		(cause) =>
			new ProjectionRunnerError({ operation: "decodeStoredEventRow", cause }),
	);
