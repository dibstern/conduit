// ─── Effect-based Projection Runner ─────────────────────────────────────────
// The only projection runner. Uses SqlClient.withTransaction for writes.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type { StoredEvent } from "../events.js";
import { ProjectorCursorEffectTag } from "./projector-cursor-effect.js";
import {
	type EffectProjector,
	type ProjectionContext,
	UNPROJECTED_CANONICAL_EVENT_TYPES,
} from "./projectors-effect.js";
import { SessionStateProjectionNotifierTag } from "./session-state-projection-notifier.js";
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
	readonly projectEvent: (
		event: StoredEvent,
	) => Effect.Effect<
		void,
		ProjectionRunnerError | SqlError,
		SqlClient.SqlClient
	>;

	readonly projectBatch: (
		events: readonly StoredEvent[],
	) => Effect.Effect<
		void,
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

		// An event type no projector claims writes nothing, raises nothing, and
		// still advances the cursor below — silent by construction, which is how
		// session.compaction went three months unprojected. Say so once per type
		// rather than once per event, so the gap shows up in the log instead of as
		// absent rows much later.
		const unclaimedWarned = new Set<string>();
		const warnIfUnclaimed = (eventType: string) =>
			Effect.suspend(() => {
				if (
					projectorsByEventType.has(eventType) ||
					UNPROJECTED_CANONICAL_EVENT_TYPES.includes(eventType) ||
					unclaimedWarned.has(eventType)
				) {
					return Effect.void;
				}
				unclaimedWarned.add(eventType);
				return Effect.logWarning(
					`No projector handles "${eventType}"; its events are stored but never projected`,
				);
			});

		// Mutable state
		const failures: ProjectionFailure[] = [];
		let recovered = false;
		let replaying = false;

		const notifySessionStateProjected = (event: StoredEvent) =>
			Effect.gen(function* () {
				if (replaying) return;
				const notifierOption = yield* Effect.serviceOption(
					SessionStateProjectionNotifierTag,
				);
				if (notifierOption._tag === "Some") {
					yield* notifierOption.value.sessionStateProjected(
						event.sessionId,
						event.type,
					);
				}
			});

		const recordFailure = (
			projector: EffectProjector,
			event: StoredEvent,
			err: unknown,
		): void => {
			failures.push({
				projectorName: projector.name,
				eventSequence: event.sequence,
				eventType: event.type,
				sessionId: event.sessionId,
				error: err instanceof Error ? err.message : String(err),
				failedAt: Date.now(),
			});
			if (failures.length > 100) failures.shift();
		};

		const projectEvent = (
			event: StoredEvent,
		): Effect.Effect<
			void,
			ProjectionRunnerError | SqlError,
			SqlClient.SqlClient
		> =>
			Effect.gen(function* () {
				if (!recovered) {
					return yield* new ProjectionRunnerError({
						operation: "projectEvent",
						cause: "recover() must be called before projectEvent()",
					});
				}

				yield* warnIfUnclaimed(event.type);
				const matching = projectorsByEventType.get(event.type) ?? [];
				const ctx: ProjectionContext = { replaying };

				// Failures propagate. A caller here is applying one known event and can
				// act on the result — a user deleting a session must not be told it
				// worked when the row is still there. Replay is the one path that
				// swallows projector failures, and it does so in recover().
				//
				// Each projector still gets its own transaction, so a failure leaves
				// earlier projectors committed and stops the rest; getFailures() is not
				// involved, because the error reaches the caller instead.
				for (const projector of matching) {
					yield* sql.withTransaction(
						Effect.gen(function* () {
							yield* projector.project(event, ctx);
							yield* cursorRepo.upsert(projector.name, event.sequence);
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
				}

				yield* notifySessionStateProjected(event);
			});

		const projectBatch = (
			events: readonly StoredEvent[],
		): Effect.Effect<
			void,
			ProjectionRunnerError | SqlError,
			SqlClient.SqlClient
		> => {
			if (events.length === 0) return Effect.void;

			return Effect.gen(function* () {
				if (!recovered) {
					return yield* new ProjectionRunnerError({
						operation: "projectBatch",
						cause: "recover() must be called before projectBatch()",
					});
				}

				const ctx: ProjectionContext = { replaying };

				// One transaction for the whole batch (S9): a translation that produced
				// several events lands all-or-nothing, so the read model never shows a
				// half-applied translation. Failures propagate for the same reason they
				// do in projectEvent — see the policy note there.
				yield* sql.withTransaction(
					Effect.gen(function* () {
						for (const event of events) {
							yield* warnIfUnclaimed(event.type);
							const matching = projectorsByEventType.get(event.type) ?? [];
							for (const projector of matching) {
								yield* projector.project(event, ctx);
							}
						}

						// Advance all cursors to last event
						const lastEvent = events[events.length - 1];
						if (lastEvent) {
							for (const projector of projectors) {
								yield* cursorRepo.upsert(projector.name, lastEvent.sequence);
							}
						}
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

				for (const event of events) {
					yield* notifySessionStateProjected(event);
				}
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

				replaying = true;
				let totalReplayed = 0;

				yield* Effect.gen(function* () {
					for (const projector of projectors) {
						const cursor =
							(yield* cursorRepo.get(projector.name))?.lastAppliedSeq ?? 0;
						if (cursor >= latestSeq) continue;

						// Build type filter for this projector
						const handledTypes = projector.handles;
						// We need to use the raw sql approach for IN clauses
						// with dynamic lists, falling back to multiple OR conditions
						let batchCursor = cursor;
						const batchSize = 500;

						while (true) {
							// Use unsafe for the IN clause with dynamic types
							const typePlaceholders = handledTypes.map(() => "?").join(", ");
							const queryParams: unknown[] = [
								batchCursor,
								...handledTypes,
								batchSize,
							];
							const events = yield* sql.unsafe<StoredEventRow>(
								`SELECT sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at
								 FROM events
								 WHERE sequence > ? AND type IN (${typePlaceholders})
								 ORDER BY sequence ASC
								 LIMIT ?`,
								queryParams,
							);

							if (events.length === 0) break;

							for (const eventRow of events) {
								const storedEvent = yield* decodeProjectionEventRow(eventRow);
								yield* sql
									.withTransaction(
										Effect.gen(function* () {
											yield* projector.project(storedEvent, {
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
											Effect.sync(() =>
												recordFailure(projector, storedEvent, err),
											),
										),
									);
								totalReplayed++;
							}

							const lastInBatch = events[events.length - 1];
							if (lastInBatch) batchCursor = lastInBatch.sequence;
							if (events.length < batchSize) break;
						}

						// Advance cursor to global max for non-matching events
						yield* cursorRepo.upsert(projector.name, latestSeq);
					}
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							replaying = false;
							recovered = true;
						}),
					),
				);

				return {
					startCursor: 0,
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
